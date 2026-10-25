// refreshVodContent against a fake Xtream client and a real database.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openVodDb } = require('./helpers/vod-db');
const { createVodStore } = require('../vodStore');

// The processor builds its own XtreamClient; swap in one that answers from `provider`.
const xtreamPath = require.resolve('../xtreamClient');
let provider;
class FakeXtreamClient {
    getVodCategories() { return provider.vodCategories(); }
    getSeriesCategories() { return provider.seriesCategories(); }
    getVodStreams() { return provider.vodStreams(); }
    getSeries() { return provider.series(); }
}
require.cache[xtreamPath] = { id: xtreamPath, filename: xtreamPath, loaded: true, exports: FakeXtreamClient };
const { refreshVodContent } = require('../vodProcessor');

const source = { id: 'src-1', name: 'Test XC', type: 'xc', xc_data: JSON.stringify({ server: 'http://xc.example', username: 'u', password: 'p' }) };

const catalog = () => ({
    vodCategories: async () => [{ category_id: '1', category_name: 'Action' }, { category_id: '2', category_name: 'Comedy' }],
    seriesCategories: async () => [{ category_id: '10', category_name: 'Drama' }],
    vodStreams: async () => [
        { stream_id: 1, name: 'Heat (1995)', plot: 'Cops', stream_icon: 'a.jpg', container_extension: 'mkv', category_id: '1' },
        { stream_id: 2, name: 'Airplane!', releaseDate: '1980-07-02', category_id: '2' },
        { stream_id: 3, name: 'No Category' },
        { name: 'No stream id' },
    ],
    series: async () => [
        { series_id: 7, name: 'The Wire', plot: 'Baltimore', cover: 'w.jpg', category_id: '10' },
        { series_id: 8, name: 'Deadwood (2004)', category_id: '10' },
    ],
});

async function setup() {
    const t = await openVodDb();
    const store = createVodStore(t);
    const statuses = [];
    const run = () => refreshVodContent(store, source, (message, type) => statuses.push({ message, type }), 'test-agent');
    return { t, store, statuses, run };
}

beforeEach(() => { provider = catalog(); });

test('imports categories, movies and series, deriving years and category names', async () => {
    const { t, run, statuses } = await setup();
    await run();

    assert.deepStrictEqual((await t.all('SELECT category_id FROM vod_categories ORDER BY category_id')).map((r) => r.category_id), ['1', '10', '2']);
    const movies = await t.all(`SELECT m.name, m.year, m.description, m.logo, m.category_name, r.stream_id, r.container_extension
        FROM movies m JOIN provider_movie_relations r ON r.movie_id = m.id ORDER BY r.stream_id`);
    assert.deepStrictEqual(movies.map((m) => ({ ...m })), [
        { name: 'Heat (1995)', year: 1995, description: 'Cops', logo: 'a.jpg', category_name: 'Action', stream_id: '1', container_extension: 'mkv' },
        { name: 'Airplane!', year: 1980, description: null, logo: null, category_name: 'Comedy', stream_id: '2', container_extension: 'mp4' },
        { name: 'No Category', year: null, description: null, logo: null, category_name: 'VOD', stream_id: '3', container_extension: 'mp4' },
    ]);
    const shows = await t.all('SELECT name, year, category_name FROM series ORDER BY name');
    assert.deepStrictEqual(shows.map((s) => ({ ...s })), [
        { name: 'Deadwood (2004)', year: 2004, category_name: 'Drama' },
        { name: 'The Wire', year: null, category_name: 'Drama' },
    ]);
    assert.strictEqual(statuses[statuses.length - 1].type, 'success');
    await t.close();
});

test('titles the provider stopped offering are removed on the next full refresh', async () => {
    const { t, run } = await setup();
    await run();
    const base = catalog();
    provider = { ...base, vodStreams: async () => (await base.vodStreams()).filter((m) => m.stream_id !== 2), series: async () => [(await base.series())[0]] };
    await new Promise((resolve) => setTimeout(resolve, 5)); // a later scan timestamp
    await run();
    assert.deepStrictEqual((await t.all('SELECT name FROM movies ORDER BY name')).map((r) => r.name), ['Heat (1995)', 'No Category']);
    assert.deepStrictEqual((await t.all('SELECT name FROM series')).map((r) => r.name), ['The Wire']);
    await t.close();
});

test('a failed movie fetch keeps the existing movies and still refreshes series', async () => {
    const { t, run, statuses } = await setup();
    await run();
    const base = catalog();
    provider = {
        ...base,
        vodStreams: async () => { throw new Error('provider timed out'); },
        series: async () => [...(await base.series()), { series_id: 9, name: 'New Show', category_id: '10' }],
    };
    await new Promise((resolve) => setTimeout(resolve, 5));
    const originalError = console.error;
    console.error = () => { };
    try { await run(); } finally { console.error = originalError; }

    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 3, 'movies must survive a failed fetch');
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM series')).n, 3);
    assert.ok(statuses.some((s) => s.type === 'error' && /Movie processing FAILED/.test(s.message)));
    assert.strictEqual(statuses[statuses.length - 1].type, 'warning');
    await t.close();
});

test('an unreadable (non-array) response is not treated as "everything was removed"', async () => {
    const { t, run } = await setup();
    await run();
    provider = { ...catalog(), vodStreams: async () => null, series: async () => ({ error: 'nope' }) };
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run();
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 3);
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM series')).n, 2);
    await t.close();
});

test('an empty but valid response does remove the provider\'s titles', async () => {
    const { t, run } = await setup();
    await run();
    provider = { ...catalog(), vodStreams: async () => [], series: async () => [] };
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run();
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 0);
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM series')).n, 0);
    await t.close();
});

test('cached episodes of a refreshed series are dropped so they are fetched again', async () => {
    const { t, store, run } = await setup();
    await run();
    const seriesId = (await t.get("SELECT id FROM series WHERE name = 'The Wire'")).id;
    await store.saveEpisodes(seriesId, 'src-1', [{ season: 1, episode: 1, name: 'The Target', streamId: 500 }], '2000-01-01T00:00:00.000Z');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run();
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM episodes')).n, 0);
    await t.close();
});

test('bad credentials stop the refresh before anything is written', async () => {
    const { t, store, statuses } = await setup();
    const originalError = console.error;
    console.error = () => { };
    try {
        await refreshVodContent(store, { ...source, xc_data: JSON.stringify({ server: 'http://xc.example' }) }, (message, type) => statuses.push({ message, type }), 'ua');
    } finally { console.error = originalError; }
    assert.strictEqual(statuses[0].type, 'error');
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 0);
    await t.close();
});

test('a failing category fetch stops the refresh and leaves existing content alone', async () => {
    const { t, run, statuses } = await setup();
    await run();
    provider = { ...catalog(), vodCategories: async () => { throw new Error('categories down'); } };
    const originalError = console.error;
    console.error = () => { };
    try { await run(); } finally { console.error = originalError; }
    assert.strictEqual((await t.get('SELECT COUNT(*) AS n FROM movies')).n, 3);
    assert.ok(statuses.some((s) => /Category processing FAILED/.test(s.message)));
    await t.close();
});
