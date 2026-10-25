// vodStore.js
// Database access for the VOD catalog (movies, series, episodes and the per-provider relation
// tables). Writes are chunked multi-row upserts instead of one awaited statement per row, so a
// 50k-title refresh costs a few hundred statements, and rows that did not change are not rewritten.
// No explicit transactions: each statement is atomic, and a refresh that stops halfway is
// repaired by the next one (last_seen decides what is stale).

// SQLite allows 32766 bound parameters per statement by default; stay well under it.
const MAX_PARAMS = 30000;
const MAX_ROWS = 500;

const rowPlaceholders = (rows, columns) => new Array(rows).fill(`(${new Array(columns).fill('?').join(',')})`).join(',');

// Runs one multi-row statement per chunk of rows. buildSql(rowCount) gives the SQL, paramsOf(rows) the flat parameters.
async function runChunked(runSql, rows, columns, buildSql, paramsOf) {
    const size = Math.min(MAX_ROWS, Math.floor(MAX_PARAMS / columns));
    for (let i = 0; i < rows.length; i += size) {
        const chunk = rows.slice(i, i + size);
        await runSql(buildSql(chunk.length), paramsOf(chunk));
    }
}

// The provider can list a title twice; the last listing wins, as it did when rows were applied one by one.
const lastBy = (rows, keyOf) => Array.from(new Map(rows.map((row) => [keyOf(row), row])).values());

/** @param {{db, dbRun, dbAll, dbGet}} deps The shared connection and server.js's promisified helpers. */
function createVodStore({ db, dbRun, dbAll, dbGet }) {
    const run = (sql, params) => dbRun(db, sql, params);
    let readyPromise = null;

    const hasUniqueKey = async (table) => {
        for (const index of await dbAll(db, `PRAGMA index_list(${table})`)) {
            const columns = await dbAll(db, `PRAGMA index_info("${index.name}")`);
            if (index.unique && columns.some((c) => c.name === 'provider_unique_id')) return true;
        }
        return false;
    };

    // The upserts below need UNIQUE keys. New databases get them from CREATE TABLE; this brings older ones up to date.
    async function ensureSchema() {
        for (const table of ['movies', 'series']) {
            await run(`ALTER TABLE ${table} ADD COLUMN provider_unique_id TEXT`).catch((e) => {
                if (!e.message.includes('duplicate column name')) throw e;
            });
            if (!(await hasUniqueKey(table))) {
                await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_provider_unique_id ON ${table}(provider_unique_id)`);
            }
        }

        // Set once a series' episodes came from the provider, so a series without durations is not fetched on every open.
        await run('ALTER TABLE series ADD COLUMN episodes_fetched_at TEXT').catch((e) => {
            if (!e.message.includes('duplicate column name')) throw e;
        });

        if (!(await dbGet(db, "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ux_episodes_key'"))) {
            // Nothing made (series_id, season_num, episode_num) unique, so two requests for the same
            // uncached series could each insert every episode. Keep the lowest id per episode, point
            // relations at it, drop the rest.
            const keep = 'SELECT MIN(id) FROM episodes GROUP BY series_id, season_num, episode_num';
            await run(`UPDATE OR IGNORE provider_episode_relations SET episode_id = (
                    SELECT MIN(keeper.id) FROM episodes keeper JOIN episodes dup
                        ON dup.series_id = keeper.series_id AND dup.season_num = keeper.season_num AND dup.episode_num = keeper.episode_num
                    WHERE dup.id = provider_episode_relations.episode_id)
                WHERE episode_id NOT IN (${keep})`);
            await run('DELETE FROM provider_episode_relations WHERE episode_id NOT IN (SELECT id FROM episodes)');
            await run(`DELETE FROM episodes WHERE id NOT IN (${keep})`);
            await run('CREATE UNIQUE INDEX ux_episodes_key ON episodes(series_id, season_num, episode_num)');
            await run('DROP INDEX IF EXISTS ix_episodes_series'); // the unique index serves the same lookups
        }
    }

    // Runs once per process; a failure is retried on the next call.
    function ready() {
        if (!readyPromise) {
            readyPromise = ensureSchema().catch((err) => {
                readyPromise = null;
                console.error(`[VOD Store] Schema check failed: ${err.message}`);
                throw err;
            });
        }
        return readyPromise;
    }

    async function upsertCategories(categories) {
        await ready();
        await runChunked(run, lastBy(categories, (c) => c.categoryId), 2,
            (n) => `INSERT OR IGNORE INTO vod_categories (category_id, category_name) VALUES ${rowPlaceholders(n, 2)}`,
            (chunk) => chunk.flatMap((c) => [String(c.categoryId), c.categoryName]));
    }

    const titleUpsert = (table, n) => `INSERT INTO ${table} (name, year, description, logo, category_name, provider_unique_id)
        VALUES ${rowPlaceholders(n, 6)}
        ON CONFLICT(provider_unique_id) DO UPDATE SET
            name = excluded.name, year = excluded.year, description = excluded.description,
            logo = excluded.logo, category_name = excluded.category_name
        WHERE ${table}.name IS NOT excluded.name OR ${table}.year IS NOT excluded.year
            OR ${table}.description IS NOT excluded.description OR ${table}.logo IS NOT excluded.logo
            OR ${table}.category_name IS NOT excluded.category_name`;
    const titleParams = (chunk) => chunk.flatMap((t) => [t.name || 'Untitled', t.year, t.description, t.logo, t.categoryName, t.providerUniqueId]);

    /** rows: { providerUniqueId, name, year, description, logo, categoryName, streamId, containerExtension } */
    async function upsertMovies(providerId, rows, scanTime) {
        await ready();
        const movies = lastBy(rows, (m) => m.providerUniqueId);
        await runChunked(run, movies, 6, (n) => titleUpsert('movies', n), titleParams);
        // Relations always get the new last_seen: it is how removeStale knows what is still offered.
        await runChunked(run, movies, 3,
            (n) => `WITH v(puid, stream_id, ext) AS (VALUES ${rowPlaceholders(n, 3)})
                INSERT INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen)
                SELECT ?, m.id, v.stream_id, v.ext, ? FROM v JOIN movies m ON m.provider_unique_id = v.puid WHERE true
                ON CONFLICT(provider_id, stream_id) DO UPDATE SET
                    movie_id = excluded.movie_id, container_extension = excluded.container_extension, last_seen = excluded.last_seen`,
            (chunk) => [...chunk.flatMap((m) => [m.providerUniqueId, String(m.streamId), m.containerExtension || 'mp4']), String(providerId), scanTime]);
    }

    /**
     * rows: { providerUniqueId, name, year, description, logo, categoryName, externalSeriesId }
     * director, cast and the TMDB/IMDB ids are filled in later by the series detail endpoint and are left alone here.
     */
    async function upsertSeries(providerId, rows, scanTime) {
        await ready();
        const series = lastBy(rows, (s) => s.providerUniqueId);
        await runChunked(run, series, 6, (n) => titleUpsert('series', n), titleParams);
        await runChunked(run, series, 2,
            (n) => `WITH v(puid, external_series_id) AS (VALUES ${rowPlaceholders(n, 2)})
                INSERT INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen)
                SELECT ?, s.id, v.external_series_id, ? FROM v JOIN series s ON s.provider_unique_id = v.puid WHERE true
                ON CONFLICT(provider_id, external_series_id) DO UPDATE SET
                    series_id = excluded.series_id, last_seen = excluded.last_seen`,
            (chunk) => [...chunk.flatMap((s) => [s.providerUniqueId, String(s.externalSeriesId)]), String(providerId), scanTime]);
    }

    // Titles that no relation points at any more (NOT EXISTS uses the indexes on the relation tables' child columns).
    async function deleteOrphans() {
        await run('DELETE FROM movies WHERE NOT EXISTS (SELECT 1 FROM provider_movie_relations r WHERE r.movie_id = movies.id)');
        await run('DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM provider_series_relations r WHERE r.series_id = series.id)');
        await run('DELETE FROM episodes WHERE NOT EXISTS (SELECT 1 FROM provider_episode_relations r WHERE r.episode_id = episodes.id)');
    }

    /**
     * Removes what a completed scan no longer saw (last_seen older than the scan), then any titles nobody offers.
     * Pass only the kinds whose scan finished: a failed fetch must not look like "the provider removed everything".
     */
    async function removeStale(providerId, scanTime, { movies = false, series = false, episodes = false }) {
        await ready();
        const removed = {};
        for (const [kind, wanted, table] of [['movies', movies, 'provider_movie_relations'], ['series', series, 'provider_series_relations'], ['episodes', episodes, 'provider_episode_relations']]) {
            removed[kind] = wanted ? (await run(`DELETE FROM ${table} WHERE provider_id = ? AND last_seen < ?`, [String(providerId), scanTime])).changes : 0;
        }
        await deleteOrphans();
        return removed;
    }

    // Used when a provider is deleted.
    async function removeProvider(providerId) {
        await ready();
        for (const table of ['provider_movie_relations', 'provider_series_relations', 'provider_episode_relations']) {
            await run(`DELETE FROM ${table} WHERE provider_id = ?`, [String(providerId)]);
        }
        await deleteOrphans();
    }

    /**
     * Stores the episodes of one series as reported by the provider.
     * episodes: { season, episode, name, description, airDate, duration, durationSecs, streamId, containerExtension }
     * An episode that already has a duration keeps it; one without gets what the provider now reports.
     * The provider's stream id and extension are always refreshed.
     */
    async function saveEpisodes(seriesId, providerId, episodes, seenAt = new Date().toISOString()) {
        await ready();
        // The provider can list a season/episode number twice; the first listing wins.
        const seen = new Set();
        const rows = episodes.filter((e) => !seen.has(`${e.season}:${e.episode}`) && seen.add(`${e.season}:${e.episode}`));
        if (rows.length === 0) return;
        await runChunked(run, rows, 8,
            (n) => `INSERT INTO episodes (series_id, season_num, episode_num, name, description, air_date, duration, duration_secs)
                VALUES ${rowPlaceholders(n, 8)}
                ON CONFLICT(series_id, season_num, episode_num) DO UPDATE SET
                    duration = COALESCE(excluded.duration, episodes.duration),
                    duration_secs = COALESCE(excluded.duration_secs, episodes.duration_secs),
                    air_date = COALESCE(episodes.air_date, excluded.air_date)
                WHERE COALESCE(episodes.duration, '') = '' AND COALESCE(episodes.duration_secs, 0) = 0
                    AND (excluded.duration IS NOT NULL OR excluded.duration_secs IS NOT NULL OR excluded.air_date IS NOT NULL)`,
            (chunk) => chunk.flatMap((e) => [seriesId, e.season, e.episode, e.name, e.description, e.airDate, e.duration, e.durationSecs]));
        const ids = new Map((await dbAll(db, 'SELECT id, season_num, episode_num FROM episodes WHERE series_id = ?', [seriesId]))
            .map((row) => [`${row.season_num}:${row.episode_num}`, row.id]));
        await runChunked(run, rows, 5,
            (n) => `INSERT INTO provider_episode_relations (provider_id, episode_id, provider_stream_id, container_extension, last_seen)
                VALUES ${rowPlaceholders(n, 5)}
                ON CONFLICT(provider_id, episode_id) DO UPDATE SET
                    provider_stream_id = excluded.provider_stream_id, container_extension = excluded.container_extension, last_seen = excluded.last_seen`,
            (chunk) => chunk.flatMap((e) => [String(providerId), ids.get(`${e.season}:${e.episode}`), String(e.streamId), e.containerExtension || 'mp4', seenAt]));
        await run('UPDATE series SET episodes_fetched_at = ? WHERE id = ?', [seenAt, seriesId]);
    }

    // True once a provider has titles stored: a restart then has no reason to download the catalog again.
    async function hasTitles(providerId) {
        return !!(await dbGet(db, `SELECT 1 FROM provider_movie_relations WHERE provider_id = ?1 UNION ALL
            SELECT 1 FROM provider_series_relations WHERE provider_id = ?1 LIMIT 1`, [String(providerId)]));
    }

    const KINDS = {
        movie: { table: 'movies', rel: 'provider_movie_relations', key: 'movie_id', extra: 'r.stream_id, r.container_extension' },
        series: { table: 'series', rel: 'provider_series_relations', key: 'series_id', extra: 'NULL AS stream_id, NULL AS container_extension' },
    };
    const kindsOf = (type) => (type === 'movies' ? ['movie'] : type === 'series' ? ['series'] : ['movie', 'series']);

    // providers: [{ id, groups }]; groups is null for "every category", else the only categories this user may see.
    function titleFilter(providers, group, q) {
        const params = [];
        const parts = providers.map(({ id, groups }) => {
            params.push(String(id));
            if (!groups) return 'r.provider_id = ?';
            params.push(...groups);
            return `(r.provider_id = ? AND t.category_name IN (${groups.map(() => '?').join(',')}))`;
        });
        let where = `(${parts.join(' OR ')})`;
        if (group) { where += ' AND t.category_name = ?'; params.push(group); }
        // shortcut: LIKE folds case for ASCII only, so "élève" will not match "Élève"; move to a normalized column or FTS5 if that matters.
        if (q) { where += " AND t.name LIKE ? ESCAPE '\\'"; params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); }
        return { where, params };
    }

    /**
     * One page of the catalog, movies and series merged and sorted by name, filtered in SQL so the
     * browser never has to hold (or sort) 200k titles. Resolves to { rows, total }.
     * The page is picked from ids and names only (CROSS JOIN makes SQLite walk the name index and stop
     * early); the wide columns are read for the 50 rows that made it, not for every row skipped.
     */
    async function listTitles({ providers, type = 'all', group, q, page = 1, limit = 50 }) {
        if (providers.length === 0) return { rows: [], total: 0 };
        limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
        const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
        const { where, params } = titleFilter(providers, group, q);
        const kinds = kindsOf(type);
        const all = kinds.flatMap(() => params);
        const from = (k, join) => `FROM ${KINDS[k].table} t ${join} ${KINDS[k].rel} r ON r.${KINDS[k].key} = t.id WHERE ${where}`;
        const ids = (k) => `SELECT * FROM (SELECT '${k}' AS type, t.id, t.name ${from(k, 'CROSS JOIN')} ORDER BY t.name COLLATE NOCASE, t.id LIMIT ${offset + limit})`;
        const picked = await dbAll(db, `SELECT type, id FROM (${kinds.map(ids).join(' UNION ALL ')}) ORDER BY name COLLATE NOCASE, type, id LIMIT ${limit} OFFSET ${offset}`, all);
        const details = await Promise.all(kinds.map((k) => {
            const keys = picked.filter((row) => row.type === k).map((row) => row.id);
            return keys.length === 0 ? [] : dbAll(db, `SELECT '${k}' AS type, t.id, t.provider_unique_id, t.name, t.year, t.description, t.logo, t.category_name, r.provider_id, ${KINDS[k].extra}
                FROM ${KINDS[k].table} t JOIN ${KINDS[k].rel} r ON r.${KINDS[k].key} = t.id WHERE t.id IN (${keys.map(() => '?').join(',')})`, keys);
        }));
        const byKey = new Map(details.flat().map((row) => [`${row.type}:${row.id}`, row]));
        const { total } = await dbGet(db, `SELECT ${kinds.map((k) => `(SELECT COUNT(*) ${from(k, 'JOIN')})`).join(' + ')} AS total`, all);
        return { rows: picked.map((row) => byKey.get(`${row.type}:${row.id}`)).filter(Boolean), total };
    }

    /** The categories that have titles, per kind: { movie: [...], series: [...] }. */
    async function listGroups(providers) {
        const groups = { movie: [], series: [] };
        if (providers.length === 0) return groups;
        const { where, params } = titleFilter(providers);
        for (const [kind, k] of Object.entries(KINDS)) {
            groups[kind] = (await dbAll(db, `SELECT DISTINCT t.category_name AS name FROM ${k.table} t JOIN ${k.rel} r ON r.${k.key} = t.id
                WHERE ${where} AND t.category_name IS NOT NULL ORDER BY name COLLATE NOCASE`, params)).map((row) => row.name);
        }
        return groups;
    }

    return { ready, upsertCategories, upsertMovies, upsertSeries, removeStale, removeProvider, saveEpisodes, hasTitles, listTitles, listGroups };
}

module.exports = { createVodStore };
