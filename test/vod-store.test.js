// VOD catalog writes: chunked upserts, unchanged-row guard, stale cleanup, episode keys.
const { test } = require('node:test');
const assert = require('node:assert');
const { openVodDb, VOD_SCHEMA } = require('./helpers/vod-db');
const { createVodStore } = require('../vodStore');

const movie = (i, overrides = {}) => ({
    providerUniqueId: `movie_p1_${i}`, name: `Movie ${i}`, year: 2000 + (i % 20), description: `Plot ${i}`,
    logo: `http://img/${i}.jpg`, categoryName: 'Action', streamId: i, containerExtension: 'mkv', ...overrides,
});
const series = (i, overrides = {}) => ({
    providerUniqueId: `series_p1_${i}`, name: `Show ${i}`, year: 2010, description: `Plot ${i}`,
    logo: `http://img/s${i}.jpg`, categoryName: 'Drama', externalSeriesId: i, ...overrides,
});

async function setup() {
    const t = await openVodDb();
    const store = createVodStore(t);
    const totalChanges = () => t.get('SELECT total_changes() AS n').then((r) => r.n);
    return { t, store, totalChanges };
}

test('first import inserts titles and relations, across statement and transaction boundaries', async () => {
    const { t, store } = await setup();
    const count = 4500; // more than one 2000-row transaction and many 500-row statements
    await store.upsertMovies('p1', Array.from({ length: count }, (_, i) => movie(i + 1)), '2024-01-01T00:00:00.000Z');

    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, count);
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM provider_movie_relations')).n, count);
    const sample = await t.get(`SELECT m.name, m.year, m.description, m.logo, m.category_name, r.stream_id, r.container_extension, r.last_seen
        FROM movies m JOIN provider_movie_relations r ON r.movie_id = m.id WHERE m.provider_unique_id = 'movie_p1_42'`);
    assert.deepStrictEqual({ ...sample }, {
        name: 'Movie 42', year: 2002, description: 'Plot 42', logo: 'http://img/42.jpg', category_name: 'Action',
        stream_id: '42', container_extension: 'mkv', last_seen: '2024-01-01T00:00:00.000Z',
    });
    await t.close();
});

test('a refresh with nothing changed rewrites relations (last_seen) but not the titles', async () => {
    const { t, store, totalChanges } = await setup();
    const rows = Array.from({ length: 300 }, (_, i) => movie(i + 1));
    await store.upsertMovies('p1', rows, '2024-01-01T00:00:00.000Z');

    const before = await totalChanges();
    await store.upsertMovies('p1', rows, '2024-01-02T00:00:00.000Z');
    const unchanged = (await totalChanges()) - before;
    assert.strictEqual(unchanged, 300, 'only the 300 relation rows should be written');

    const seen = await t.all('SELECT DISTINCT last_seen FROM provider_movie_relations');
    assert.deepStrictEqual(seen.map((r) => r.last_seen), ['2024-01-02T00:00:00.000Z']);

    // Changing one title writes that title (plus the relations) and keeps its id.
    const idBefore = (await t.get("SELECT id FROM movies WHERE provider_unique_id = 'movie_p1_7'")).id;
    const edited = rows.map((m) => (m.streamId === 7 ? { ...m, name: 'Renamed', categoryName: 'Comedy' } : m));
    const mark = await totalChanges();
    await store.upsertMovies('p1', edited, '2024-01-03T00:00:00.000Z');
    assert.strictEqual((await totalChanges()) - mark, 301);
    const after = await t.get("SELECT id, name, category_name FROM movies WHERE provider_unique_id = 'movie_p1_7'");
    assert.deepStrictEqual({ ...after }, { id: idBefore, name: 'Renamed', category_name: 'Comedy' });
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 300);
    await t.close();
});

test('a title listed twice by the provider uses the last listing', async () => {
    const { t, store } = await setup();
    await store.upsertMovies('p1', [movie(1, { name: 'First' }), movie(1, { name: 'Second', containerExtension: 'avi' })], 'scan1');
    const row = await t.get(`SELECT m.name, r.container_extension FROM movies m JOIN provider_movie_relations r ON r.movie_id = m.id`);
    assert.deepStrictEqual({ ...row }, { name: 'Second', container_extension: 'avi' });
    await t.close();
});

test('missing values are stored as NULL instead of failing the batch', async () => {
    const { t, store } = await setup();
    await store.upsertMovies('p1', [movie(1, { name: undefined, year: null, description: undefined, logo: null, containerExtension: undefined })], 'scan1');
    const row = await t.get(`SELECT m.name, m.year, m.description, m.logo, r.container_extension FROM movies m JOIN provider_movie_relations r ON r.movie_id = m.id`);
    assert.deepStrictEqual({ ...row }, { name: 'Untitled', year: null, description: null, logo: null, container_extension: 'mp4' });
    await t.close();
});

test('series upserts keep the director, cast and ids filled in later', async () => {
    const { t, store } = await setup();
    await store.upsertSeries('p1', [series(1), series(2)], 'scan1');
    await t.run(`UPDATE series SET director = 'D', "cast" = 'C', tmdb_id = '99' WHERE provider_unique_id = 'series_p1_1'`);
    await store.upsertSeries('p1', [series(1, { name: 'Show 1 (2020)' }), series(2)], 'scan2');
    const row = await t.get(`SELECT name, director, "cast" AS cast_list, tmdb_id FROM series WHERE provider_unique_id = 'series_p1_1'`);
    assert.deepStrictEqual({ ...row }, { name: 'Show 1 (2020)', director: 'D', cast_list: 'C', tmdb_id: '99' });
    const relations = await t.all('SELECT external_series_id, last_seen FROM provider_series_relations ORDER BY external_series_id');
    assert.deepStrictEqual(relations.map((r) => [r.external_series_id, r.last_seen]), [['1', 'scan2'], ['2', 'scan2']]);
    await t.close();
});

test('titles of different providers do not collide', async () => {
    const { t, store } = await setup();
    await store.upsertMovies('p1', [movie(1)], 'scan1');
    await store.upsertMovies('p2', [movie(1, { providerUniqueId: 'movie_p2_1', name: 'Other' })], 'scan1');
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 2);
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM provider_movie_relations')).n, 2);
    await t.close();
});

test('removeStale drops what the scan did not see, only for the kinds that were scanned', async () => {
    const { t, store } = await setup();
    await store.upsertMovies('p1', [movie(1), movie(2), movie(3)], 'scan1');
    await store.upsertSeries('p1', [series(1), series(2)], 'scan1');

    // second scan sees movies 1 and 2 and series 1
    await store.upsertMovies('p1', [movie(1), movie(2)], 'scan2');
    await store.upsertSeries('p1', [series(1)], 'scan2');

    // series scan "failed": only movies may be cleaned up
    let removed = await store.removeStale('p1', 'scan2', { movies: true });
    assert.deepStrictEqual(removed, { movies: 1, series: 0, episodes: 0 });
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 2);
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM series')).n, 2, 'series untouched when their scan did not complete');

    removed = await store.removeStale('p1', 'scan2', { movies: true, series: true });
    assert.strictEqual(removed.series, 1);
    assert.deepStrictEqual((await t.all('SELECT name FROM series')).map((r) => r.name), ['Show 1']);

    // nothing scanned: nothing is touched
    assert.deepStrictEqual(await store.removeStale('p1', 'scan9', {}), { movies: 0, series: 0, episodes: 0 });
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 2);
    await t.close();
});

test('a title another provider still offers survives the first provider dropping it', async () => {
    const { t, store } = await setup();
    // same title row reached through two providers (shared provider_unique_id is not expected, so link manually)
    await store.upsertMovies('p1', [movie(1)], 'scan1');
    const id = (await t.get('SELECT id FROM movies')).id;
    await t.run("INSERT INTO provider_movie_relations VALUES ('p2', ?, '77', 'mp4', 'scan1')", [id]);
    await store.removeStale('p1', 'scan2', { movies: true });
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 1);
    await store.removeProvider('p2');
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 0);
    await t.close();
});

test('removeProvider clears relations, titles and cached episodes of that provider', async () => {
    const { t, store } = await setup();
    await store.upsertSeries('p1', [series(1)], 'scan1');
    const seriesId = (await t.get('SELECT id FROM series')).id;
    await store.saveEpisodes(seriesId, 'p1', [{ season: 1, episode: 1, name: 'E1', streamId: 100 }]);
    await store.removeProvider('p1');
    for (const table of ['series', 'episodes', 'provider_series_relations', 'provider_episode_relations']) {
        assert.strictEqual((await t.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0, table);
    }
    await t.close();
});

test('categories are inserted once and existing names are kept', async () => {
    const { t, store } = await setup();
    await store.upsertCategories([{ categoryId: 1, categoryName: 'Action' }, { categoryId: '2', categoryName: 'Drama' }]);
    await store.upsertCategories([{ categoryId: '1', categoryName: 'Renamed' }, { categoryId: 3, categoryName: 'Comedy' }]);
    const rows = await t.all('SELECT category_id, category_name FROM vod_categories ORDER BY category_id');
    assert.deepStrictEqual(rows.map((r) => [r.category_id, r.category_name]), [['1', 'Action'], ['2', 'Drama'], ['3', 'Comedy']]);
    await t.close();
});

test('saveEpisodes: new episodes are stored, repeated saves do not duplicate, durations fill in once', async () => {
    const { t, store } = await setup();
    await store.upsertSeries('p1', [series(1)], 'scan1');
    const seriesId = (await t.get('SELECT id FROM series')).id;

    const episodes = [
        { season: 1, episode: 1, name: 'Pilot', description: 'p', airDate: '2020-01-01', duration: null, durationSecs: null, streamId: 501, containerExtension: 'mkv' },
        { season: 1, episode: 2, name: 'Two', streamId: 502 },
        { season: 1, episode: 2, name: 'Two again', streamId: 999 }, // duplicate listing: the first one wins
    ];
    await store.saveEpisodes(seriesId, 'p1', episodes, 'seen1');
    await store.saveEpisodes(seriesId, 'p1', episodes, 'seen2');
    const stored = await t.all(`SELECT e.season_num, e.episode_num, e.name, e.duration, e.duration_secs, r.provider_stream_id, r.container_extension, r.last_seen
        FROM episodes e JOIN provider_episode_relations r ON r.episode_id = e.id ORDER BY e.episode_num`);
    assert.strictEqual(stored.length, 2);
    assert.deepStrictEqual({ ...stored[0] }, { season_num: 1, episode_num: 1, name: 'Pilot', duration: null, duration_secs: null, provider_stream_id: '501', container_extension: 'mkv', last_seen: 'seen2' });
    assert.strictEqual(stored[1].name, 'Two');
    assert.strictEqual(stored[1].provider_stream_id, '502');
    assert.strictEqual(stored[1].container_extension, 'mp4');

    // The provider now reports a duration: it fills in because the episode had none ...
    await store.saveEpisodes(seriesId, 'p1', [{ ...episodes[0], duration: '45 min', durationSecs: 2700, streamId: 777 }], 'seen3');
    let pilot = await t.get('SELECT e.duration, e.duration_secs, e.air_date, r.provider_stream_id FROM episodes e JOIN provider_episode_relations r ON r.episode_id = e.id WHERE e.episode_num = 1');
    assert.deepStrictEqual({ ...pilot }, { duration: '45 min', duration_secs: 2700, air_date: '2020-01-01', provider_stream_id: '777' });

    // ... and a later, different value does not overwrite it.
    await store.saveEpisodes(seriesId, 'p1', [{ ...episodes[0], duration: '50 min', durationSecs: 3000 }], 'seen4');
    pilot = await t.get('SELECT duration, duration_secs FROM episodes WHERE episode_num = 1');
    assert.deepStrictEqual({ ...pilot }, { duration: '45 min', duration_secs: 2700 });
    await t.close();
});

test('concurrent saves of the same series do not create duplicate episodes', async () => {
    const { t, store } = await setup();
    await store.upsertSeries('p1', [series(1)], 'scan1');
    const seriesId = (await t.get('SELECT id FROM series')).id;
    const episodes = Array.from({ length: 30 }, (_, i) => ({ season: 1, episode: i + 1, name: `E${i + 1}`, streamId: 1000 + i }));
    await Promise.all([1, 2, 3].map(() => store.saveEpisodes(seriesId, 'p1', episodes)));
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM episodes')).n, 30);
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM provider_episode_relations')).n, 30);
    await t.close();
});

test('ready() removes duplicate episodes, repoints relations and adds the unique key once', async () => {
    const { t, store } = await setup();
    // Rows are created directly: the store would add the unique key on its first write.
    await t.run("INSERT INTO series (name, provider_unique_id) VALUES ('Show', 'series_p1_1')");
    const seriesId = (await t.get('SELECT id FROM series')).id;
    // The old schema had no unique key; two requests could each insert the same episode.
    for (const stream of ['a', 'b', 'c']) {
        await t.run('INSERT INTO episodes (series_id, season_num, episode_num, name) VALUES (?, 1, 1, ?)', [seriesId, `dup ${stream}`]);
    }
    await t.run('INSERT INTO episodes (series_id, season_num, episode_num, name) VALUES (?, 1, 2, ?)', [seriesId, 'only']);
    const ids = (await t.all('SELECT id FROM episodes ORDER BY id')).map((r) => r.id);
    await t.run("INSERT INTO provider_episode_relations VALUES ('p1', ?, 's1', 'mp4', 'x')", [ids[1]]); // on a duplicate
    await t.run("INSERT INTO provider_episode_relations VALUES ('p1', ?, 's3', 'mp4', 'x')", [ids[3]]); // on the unique one
    await t.run('CREATE INDEX ix_episodes_series ON episodes(series_id, season_num, episode_num)');

    await store.ready();

    const episodes = await t.all('SELECT id, episode_num FROM episodes ORDER BY id');
    assert.deepStrictEqual(episodes.map((e) => [e.id, e.episode_num]), [[ids[0], 1], [ids[3], 2]]);
    const relations = await t.all('SELECT episode_id, provider_stream_id FROM provider_episode_relations ORDER BY provider_stream_id');
    assert.deepStrictEqual(relations.map((r) => [r.episode_id, r.provider_stream_id]), [[ids[0], 's1'], [ids[3], 's3']]);

    const indexes = (await t.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'episodes'")).map((r) => r.name);
    assert.ok(indexes.includes('ux_episodes_key'));
    assert.ok(!indexes.includes('ix_episodes_series'), 'the plain index is redundant once the unique one exists');
    await assert.rejects(t.run('INSERT INTO episodes (series_id, season_num, episode_num) VALUES (?, 1, 1)', [seriesId]), /UNIQUE/);

    // Running it again (next boot) changes nothing.
    const again = createVodStore(t);
    await again.ready();
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM episodes')).n, 2);
    await t.close();
});

test('ready() adds provider_unique_id and its unique key to tables from an older schema', async () => {
    const legacy = VOD_SCHEMA
        .replace('category_name TEXT, provider_unique_id TEXT UNIQUE,\n    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);\nCREATE TABLE series', 'category_name TEXT,\n    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);\nCREATE TABLE series')
        .replace('category_name TEXT, provider_unique_id TEXT UNIQUE, director TEXT', 'category_name TEXT, provider_unique_id TEXT, director TEXT');
    const t = await openVodDb({ schema: legacy });
    const store = createVodStore(t);
    assert.ok(!(await t.all('PRAGMA table_info(movies)')).some((c) => c.name === 'provider_unique_id'));

    await store.upsertMovies('p1', [movie(1), movie(2)], 'scan1');
    await store.upsertSeries('p1', [series(1)], 'scan1');
    await store.upsertMovies('p1', [movie(1, { name: 'Again' })], 'scan2');

    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 2);
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM series')).n, 1);
    assert.strictEqual((await t.get("SELECT name FROM movies WHERE provider_unique_id = 'movie_p1_1'")).name, 'Again');
    await t.close();
});

test('a failed schema step is reported and retried on the next call', async () => {
    const t = await openVodDb({ schema: 'CREATE TABLE unrelated (x INTEGER);' }); // VOD tables missing
    const store = createVodStore(t);
    const originalError = console.error;
    console.error = () => { };
    try {
        await assert.rejects(store.ready());
        await t.db.exec(VOD_SCHEMA);
        await store.ready();
        await store.upsertMovies('p1', [movie(1)], 'scan1');
        assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 1);
    } finally {
        console.error = originalError;
    }
    await t.close();
});

// --- Paged library ---

async function libraryFixture() {
    const { t, store } = await setup();
    await store.upsertMovies('p1', [
        movie(1, { name: 'apple', categoryName: 'Action' }), movie(2, { name: 'Cherry', categoryName: 'Drama' }),
        movie(3, { name: 'Banana 100%', categoryName: 'Action' }), movie(4, { name: 'Date_x', categoryName: 'Drama' }),
    ], 'scan1');
    await store.upsertSeries('p1', [series(1, { name: 'Blueberry', categoryName: 'Drama' }), series(2, { name: 'zebra', categoryName: 'Kids' })], 'scan1');
    await store.upsertMovies('p2', [movie(5, { providerUniqueId: 'movie_p2_5', name: 'Elderberry', categoryName: 'Action' })], 'scan1');
    return { t, store };
}
const names = (page) => page.rows.map((r) => r.name);

test('listTitles merges movies and series by name, ignoring case, and pages through them', async () => {
    const { t, store } = await libraryFixture();
    const providers = [{ id: 'p1', groups: null }];

    const first = await store.listTitles({ providers, page: 1, limit: 3 });
    assert.deepStrictEqual(names(first), ['apple', 'Banana 100%', 'Blueberry']);
    assert.strictEqual(first.total, 6);
    assert.deepStrictEqual(names(await store.listTitles({ providers, page: 2, limit: 3 })), ['Cherry', 'Date_x', 'zebra']);
    assert.deepStrictEqual(names(await store.listTitles({ providers, page: 3, limit: 3 })), []);

    const row = first.rows[0];
    assert.deepStrictEqual({ type: row.type, id: row.provider_unique_id, stream_id: row.stream_id, ext: row.container_extension, provider: row.provider_id, group: row.category_name },
        { type: 'movie', id: 'movie_p1_1', stream_id: '1', ext: 'mkv', provider: 'p1', group: 'Action' });
    assert.strictEqual(first.rows[2].type, 'series');
    assert.strictEqual(first.rows[2].stream_id, null);
    await t.close();
});

test('listTitles filters by type, category and search text, and treats % and _ in the search literally', async () => {
    const { t, store } = await libraryFixture();
    const providers = [{ id: 'p1', groups: null }];

    assert.deepStrictEqual(names(await store.listTitles({ providers, type: 'series' })), ['Blueberry', 'zebra']);
    assert.strictEqual((await store.listTitles({ providers, type: 'movies' })).total, 4);
    assert.deepStrictEqual(names(await store.listTitles({ providers, group: 'Drama' })), ['Blueberry', 'Cherry', 'Date_x']);
    assert.deepStrictEqual(names(await store.listTitles({ providers, q: 'BERRY' })), ['Blueberry']);
    assert.deepStrictEqual(names(await store.listTitles({ providers, q: '100%' })), ['Banana 100%']);
    assert.deepStrictEqual(names(await store.listTitles({ providers, q: '%' })), ['Banana 100%']);
    assert.deepStrictEqual(names(await store.listTitles({ providers, q: '_' })), ['Date_x']);
    assert.deepStrictEqual(names(await store.listTitles({ providers, q: 'a', group: 'Kids', type: 'series' })), ['zebra']);
    const none = await store.listTitles({ providers, q: 'nothing like this' });
    assert.deepStrictEqual([none.rows.length, none.total], [0, 0]);
    await t.close();
});

test('listTitles only shows the providers and categories it is given', async () => {
    const { t, store } = await libraryFixture();

    assert.strictEqual((await store.listTitles({ providers: [] })).total, 0);
    const both = await store.listTitles({ providers: [{ id: 'p1', groups: ['Kids'] }, { id: 'p2', groups: null }] });
    assert.deepStrictEqual(names(both), ['Elderberry', 'zebra']);
    assert.strictEqual(both.total, 2);
    assert.deepStrictEqual(names(await store.listTitles({ providers: [{ id: 'p2', groups: ['Drama'] }] })), []);
    await t.close();
});

test('listTitles caps the page size', async () => {
    const { t, store } = await setup();
    await store.upsertMovies('p1', Array.from({ length: 150 }, (_, i) => movie(i + 1)), 'scan1');
    const page = await store.listTitles({ providers: [{ id: 'p1', groups: null }], limit: 5000 });
    assert.strictEqual(page.rows.length, 100);
    assert.strictEqual(page.total, 150);
    await t.close();
});

test('listGroups lists the categories that have titles, per kind and per scope', async () => {
    const { t, store } = await libraryFixture();

    assert.deepStrictEqual(await store.listGroups([{ id: 'p1', groups: null }]), { movie: ['Action', 'Drama'], series: ['Drama', 'Kids'] });
    assert.deepStrictEqual(await store.listGroups([{ id: 'p1', groups: ['Drama'] }, { id: 'p2', groups: null }]), { movie: ['Action', 'Drama'], series: ['Drama'] });
    assert.deepStrictEqual(await store.listGroups([]), { movie: [], series: [] });
    await t.close();
});

test('hasTitles tells whether a provider has anything stored', async () => {
    const { t, store } = await libraryFixture();
    assert.strictEqual(await store.hasTitles('p1'), true);
    await store.upsertSeries('p3', [series(9, { providerUniqueId: 'series_p3_9' })], 'scan1');
    assert.strictEqual(await store.hasTitles('p3'), true, 'series alone count');
    assert.strictEqual(await store.hasTitles('p4'), false);
    await t.close();
});

test('saving episodes marks the series, so its episodes are only fetched once', async () => {
    const { t, store } = await setup();
    await store.upsertSeries('p1', [series(1)], 'scan1');
    const id = (await t.get("SELECT id FROM series WHERE provider_unique_id = 'series_p1_1'")).id;
    assert.strictEqual((await t.get('SELECT episodes_fetched_at AS at FROM series WHERE id = ?', [id])).at, null);

    await store.saveEpisodes(id, 'p1', [{ season: 1, episode: 1, name: 'Pilot', streamId: 11 }], '2024-05-01T00:00:00.000Z');
    assert.strictEqual((await t.get('SELECT episodes_fetched_at AS at FROM series WHERE id = ?', [id])).at, '2024-05-01T00:00:00.000Z');
    await t.close();
});
