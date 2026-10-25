// vodStore.js
// Database access for the VOD catalog (movies, series, episodes and the per-provider
// relation tables). Writes are chunked multi-row upserts run through withTransaction, so a
// 50k-title refresh costs a few hundred statements instead of ~100k awaited round trips,
// and rows that did not change are not rewritten.

const { all, get, run } = require('./dbTransaction');

// SQLite allows 32766 bound parameters per statement by default; stay well under it.
const MAX_PARAMS_PER_STATEMENT = 30000;
const MAX_ROWS_PER_STATEMENT = 500;
// Rows per transaction. A refresh holds the write lock for one batch at a time, so
// everything else that writes (progress saves, the session store) waits tens of
// milliseconds instead of the whole import.
const ROWS_PER_TRANSACTION = 2000;
const MIN_PAUSE_BETWEEN_BATCHES_MS = 10;

const scalar = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return String(value);
};
const text = (value) => {
    const v = scalar(value);
    return v === null || v === '' ? null : v;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function groupsOf(array, size) {
    const groups = [];
    for (let i = 0; i < array.length; i += size) groups.push(array.slice(i, i + size));
    return groups;
}

const rowPlaceholders = (rows, columns) => {
    const one = `(${new Array(columns).fill('?').join(',')})`;
    return new Array(rows).fill(one).join(',');
};

// Runs one multi-row statement per group of rows. buildSql(rowCount) returns the SQL,
// paramsOf(rows) the flat parameter list.
async function runChunked(conn, rows, columns, buildSql, paramsOf) {
    const perStatement = Math.max(1, Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(MAX_PARAMS_PER_STATEMENT / columns)));
    for (const group of groupsOf(rows, perStatement)) {
        await run(conn, buildSql(group.length), paramsOf(group));
    }
}

// Last occurrence wins, as it did when rows were applied one after another.
function dedupeBy(rows, keyOf) {
    const byKey = new Map();
    for (const row of rows) byKey.set(keyOf(row), row);
    return Array.from(byKey.values());
}

async function hasUniqueIndexOn(conn, table, column) {
    const indexes = await all(conn, `PRAGMA index_list("${table}")`);
    for (const index of indexes) {
        if (!index.unique) continue;
        const columns = await all(conn, `PRAGMA index_info("${index.name}")`);
        if (columns.length === 1 && columns[0].name === column) return true;
    }
    return false;
}

/**
 * @param {object} deps
 * @param {sqlite3.Database} deps.db Shared connection, used for reads.
 * @param {function} deps.withTransaction From dbTransaction.createTransactionRunner.
 * @param {function} [deps.onChange] Called after writes that change what the library shows.
 */
function createVodStore({ db, withTransaction, onChange = () => { } }) {
    let readyPromise = null;

    // One transaction per batch of rows. A connection that is waiting for the write lock only
    // gets it if the lock happens to be free when SQLite's busy handler next polls (every 50-100 ms
    // after the first few tries), and back-to-back batches would almost never leave that gap: in
    // testing, watch-progress saves failed with SQLITE_BUSY during a 100k-title import. So pause for
    // a quarter of each batch's time (at least 10 ms) before the next one.
    async function inBatches(rows, writeBatch) {
        for (const batch of groupsOf(rows, ROWS_PER_TRANSACTION)) {
            const startedAt = Date.now();
            await withTransaction((conn) => writeBatch(conn, batch));
            await sleep(Math.max(MIN_PAUSE_BETWEEN_BATCHES_MS, Math.ceil((Date.now() - startedAt) / 4)));
        }
    }

    const changed = () => {
        try { onChange(); } catch (err) { console.error('[VOD Store] onChange handler failed:', err.message); }
    };

    // Upserts below rely on UNIQUE keys. Fresh databases get them from the CREATE TABLE
    // statements; this brings older ones up to date (idempotent, runs once per process).
    async function ensureSchema() {
        await withTransaction(async (conn) => {
            for (const table of ['movies', 'series']) {
                const columns = await all(conn, `PRAGMA table_info("${table}")`);
                if (!columns.some((c) => c.name === 'provider_unique_id')) {
                    await run(conn, `ALTER TABLE ${table} ADD COLUMN provider_unique_id TEXT`);
                }
                if (!(await hasUniqueIndexOn(conn, table, 'provider_unique_id'))) {
                    await run(conn, `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_provider_unique_id ON ${table}(provider_unique_id)`);
                }
            }

            const episodeKey = await get(conn, "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'ux_episodes_key'");
            if (!episodeKey) {
                // INSERT OR IGNORE INTO episodes never ignored anything (nothing was unique), so
                // two requests for the same uncached series could each insert every episode.
                // Keep the lowest id per episode, move relations over to it, drop the rest.
                const keep = 'SELECT MIN(id) FROM episodes GROUP BY series_id, season_num, episode_num';
                const duplicates = await run(conn, `
                    UPDATE OR IGNORE provider_episode_relations
                    SET episode_id = (
                        SELECT MIN(keeper.id) FROM episodes keeper
                        JOIN episodes dup ON dup.series_id = keeper.series_id
                            AND dup.season_num = keeper.season_num AND dup.episode_num = keeper.episode_num
                        WHERE dup.id = provider_episode_relations.episode_id)
                    WHERE episode_id NOT IN (${keep})`);
                await run(conn, `DELETE FROM provider_episode_relations WHERE episode_id NOT IN (SELECT id FROM episodes)`);
                const removed = await run(conn, `DELETE FROM episodes WHERE id NOT IN (${keep})`);
                if (removed.changes > 0) {
                    console.log(`[VOD Store] Removed ${removed.changes} duplicate episode rows (${duplicates.changes} relations repointed).`);
                }
                await run(conn, 'CREATE UNIQUE INDEX ux_episodes_key ON episodes(series_id, season_num, episode_num)');
                // The unique index serves the same lookups.
                await run(conn, 'DROP INDEX IF EXISTS ix_episodes_series');
            }
        });
    }

    function ready() {
        if (!readyPromise) {
            readyPromise = ensureSchema().catch((err) => {
                readyPromise = null; // try again on the next call
                console.error(`[VOD Store] Schema check failed: ${err.message}`);
                throw err;
            });
        }
        return readyPromise;
    }

    async function upsertCategories(categories) {
        const rows = dedupeBy(categories, (c) => String(c.categoryId));
        if (rows.length === 0) return;
        await ready();
        await withTransaction((conn) => runChunked(
            conn, rows, 2,
            (n) => `INSERT OR IGNORE INTO vod_categories (category_id, category_name) VALUES ${rowPlaceholders(n, 2)}`,
            (group) => group.flatMap((c) => [String(c.categoryId), String(c.categoryName)])
        ));
    }

    /**
     * rows: { providerUniqueId, name, year, description, logo, categoryName, streamId, containerExtension }
     */
    async function upsertMovies(providerId, rows, scanTime) {
        const movies = dedupeBy(rows, (m) => m.providerUniqueId);
        await ready();
        try {
            await inBatches(movies, async (conn, batch) => {
                await runChunked(
                    conn, batch, 6,
                    (n) => `INSERT INTO movies (name, year, description, logo, category_name, provider_unique_id)
                        VALUES ${rowPlaceholders(n, 6)}
                        ON CONFLICT(provider_unique_id) DO UPDATE SET
                            name = excluded.name, year = excluded.year, description = excluded.description,
                            logo = excluded.logo, category_name = excluded.category_name
                        WHERE movies.name IS NOT excluded.name OR movies.year IS NOT excluded.year
                            OR movies.description IS NOT excluded.description OR movies.logo IS NOT excluded.logo
                            OR movies.category_name IS NOT excluded.category_name`,
                    (group) => group.flatMap((m) => [m.name || 'Untitled', scalar(m.year), text(m.description), text(m.logo), scalar(m.categoryName), m.providerUniqueId])
                );
                // relations always get a new last_seen: it is how removeStale knows what is still offered
                await runChunked(
                    conn, batch, 3,
                    (n) => `WITH v(puid, stream_id, ext) AS (VALUES ${rowPlaceholders(n, 3)})
                        INSERT INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen)
                        SELECT ?, m.id, v.stream_id, v.ext, ? FROM v JOIN movies m ON m.provider_unique_id = v.puid WHERE true
                        ON CONFLICT(provider_id, stream_id) DO UPDATE SET
                            movie_id = excluded.movie_id, container_extension = excluded.container_extension, last_seen = excluded.last_seen`,
                    (group) => [...group.flatMap((m) => [m.providerUniqueId, String(m.streamId), m.containerExtension || 'mp4']), String(providerId), scanTime]
                );
            });
        } finally {
            changed();
        }
        return movies.length;
    }

    /**
     * rows: { providerUniqueId, name, year, description, logo, categoryName, externalSeriesId }
     * director, cast and the TMDB/IMDB ids are filled in later by the series detail endpoint
     * and are left alone here.
     */
    async function upsertSeries(providerId, rows, scanTime) {
        const seriesRows = dedupeBy(rows, (s) => s.providerUniqueId);
        await ready();
        try {
            await inBatches(seriesRows, async (conn, batch) => {
                await runChunked(
                    conn, batch, 6,
                    (n) => `INSERT INTO series (name, year, description, logo, category_name, provider_unique_id)
                        VALUES ${rowPlaceholders(n, 6)}
                        ON CONFLICT(provider_unique_id) DO UPDATE SET
                            name = excluded.name, year = excluded.year, description = excluded.description,
                            logo = excluded.logo, category_name = excluded.category_name
                        WHERE series.name IS NOT excluded.name OR series.year IS NOT excluded.year
                            OR series.description IS NOT excluded.description OR series.logo IS NOT excluded.logo
                            OR series.category_name IS NOT excluded.category_name`,
                    (group) => group.flatMap((s) => [s.name || 'Untitled', scalar(s.year), text(s.description), text(s.logo), scalar(s.categoryName), s.providerUniqueId])
                );
                await runChunked(
                    conn, batch, 2,
                    (n) => `WITH v(puid, external_series_id) AS (VALUES ${rowPlaceholders(n, 2)})
                        INSERT INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen)
                        SELECT ?, s.id, v.external_series_id, ? FROM v JOIN series s ON s.provider_unique_id = v.puid WHERE true
                        ON CONFLICT(provider_id, external_series_id) DO UPDATE SET
                            series_id = excluded.series_id, last_seen = excluded.last_seen`,
                    (group) => [...group.flatMap((s) => [s.providerUniqueId, String(s.externalSeriesId)]), String(providerId), scanTime]
                );
            });
        } finally {
            changed();
        }
        return seriesRows.length;
    }

    // Titles that no relation points at any more. NOT EXISTS uses the indexes on the relation
    // tables' child columns.
    async function deleteOrphans(conn) {
        await run(conn, 'DELETE FROM movies WHERE NOT EXISTS (SELECT 1 FROM provider_movie_relations r WHERE r.movie_id = movies.id)');
        await run(conn, 'DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM provider_series_relations r WHERE r.series_id = series.id)');
        await run(conn, 'DELETE FROM episodes WHERE NOT EXISTS (SELECT 1 FROM provider_episode_relations r WHERE r.episode_id = episodes.id)');
    }

    /**
     * Removes what a completed scan no longer saw (last_seen older than the scan), then any
     * titles nobody offers. Pass only the kinds whose scan finished: a failed fetch must not
     * look like "the provider removed everything".
     */
    async function removeStale(providerId, scanTime, { movies = false, series = false, episodes = false } = {}) {
        if (!movies && !series && !episodes) return { movies: 0, series: 0, episodes: 0 };
        await ready();
        try {
            return await withTransaction(async (conn) => {
                const removed = { movies: 0, series: 0, episodes: 0 };
                if (movies) removed.movies = (await run(conn, 'DELETE FROM provider_movie_relations WHERE provider_id = ? AND last_seen < ?', [String(providerId), scanTime])).changes;
                if (series) removed.series = (await run(conn, 'DELETE FROM provider_series_relations WHERE provider_id = ? AND last_seen < ?', [String(providerId), scanTime])).changes;
                if (episodes) removed.episodes = (await run(conn, 'DELETE FROM provider_episode_relations WHERE provider_id = ? AND last_seen < ?', [String(providerId), scanTime])).changes;
                await deleteOrphans(conn);
                return removed;
            });
        } finally {
            changed();
        }
    }

    // Used when a provider is deleted.
    async function removeProvider(providerId) {
        await ready();
        try {
            await withTransaction(async (conn) => {
                await run(conn, 'DELETE FROM provider_movie_relations WHERE provider_id = ?', [String(providerId)]);
                await run(conn, 'DELETE FROM provider_series_relations WHERE provider_id = ?', [String(providerId)]);
                await run(conn, 'DELETE FROM provider_episode_relations WHERE provider_id = ?', [String(providerId)]);
                await deleteOrphans(conn);
            });
        } finally {
            changed();
        }
    }

    /**
     * Stores the episodes of one series as reported by the provider.
     * episodes: { season, episode, name, description, airDate, duration, durationSecs, streamId, containerExtension }
     * An episode that already has a duration is left as it is; one without gets what the
     * provider now reports. The provider's stream id and extension are always refreshed.
     */
    async function saveEpisodes(seriesId, providerId, episodes, seenAt = new Date().toISOString()) {
        const rows = dedupeKeepFirst(episodes, (e) => `${e.season}:${e.episode}`);
        if (rows.length === 0) return 0;
        await ready();
        await withTransaction(async (conn) => {
            await runChunked(
                conn, rows, 8,
                (n) => `INSERT INTO episodes (series_id, season_num, episode_num, name, description, air_date, duration, duration_secs)
                    VALUES ${rowPlaceholders(n, 8)}
                    ON CONFLICT(series_id, season_num, episode_num) DO UPDATE SET
                        duration = COALESCE(excluded.duration, episodes.duration),
                        duration_secs = COALESCE(excluded.duration_secs, episodes.duration_secs),
                        air_date = COALESCE(episodes.air_date, excluded.air_date)
                    WHERE COALESCE(episodes.duration, '') = '' AND COALESCE(episodes.duration_secs, 0) = 0
                        AND (excluded.duration IS NOT NULL OR excluded.duration_secs IS NOT NULL OR excluded.air_date IS NOT NULL)`,
                (group) => group.flatMap((e) => [seriesId, e.season, e.episode, text(e.name), text(e.description), text(e.airDate), text(e.duration), scalar(e.durationSecs)])
            );
            const ids = new Map((await all(conn, 'SELECT id, season_num, episode_num FROM episodes WHERE series_id = ?', [seriesId]))
                .map((row) => [`${row.season_num}:${row.episode_num}`, row.id]));
            const linked = rows.filter((e) => ids.has(`${e.season}:${e.episode}`));
            await runChunked(
                conn, linked, 5,
                (n) => `INSERT INTO provider_episode_relations (provider_id, episode_id, provider_stream_id, container_extension, last_seen)
                    VALUES ${rowPlaceholders(n, 5)}
                    ON CONFLICT(provider_id, episode_id) DO UPDATE SET
                        provider_stream_id = excluded.provider_stream_id, container_extension = excluded.container_extension, last_seen = excluded.last_seen`,
                (group) => group.flatMap((e) => [String(providerId), ids.get(`${e.season}:${e.episode}`), String(e.streamId), e.containerExtension || 'mp4', seenAt])
            );
        });
        return rows.length;
    }

    return { ready, upsertCategories, upsertMovies, upsertSeries, removeStale, removeProvider, saveEpisodes };
}

// First occurrence wins: the provider can list one season/episode number twice, and the
// first listing is the one that was stored before.
function dedupeKeepFirst(rows, keyOf) {
    const seen = new Set();
    return rows.filter((row) => {
        const key = keyOf(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

module.exports = { createVodStore };
