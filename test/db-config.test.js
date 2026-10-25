// Connection tuning: WAL + synchronous=NORMAL, with a safe fallback.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { configureConnection, resolveJournalMode, ORPHAN_CLEANUP_SQL } = require('../dbConfig');

const open = (file) => new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(conn)));
});
const get = (conn, sql) => new Promise((resolve, reject) => conn.get(sql, (err, row) => (err ? reject(err) : resolve(row))));
const close = (conn) => new Promise((resolve) => conn.close(resolve));
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viniplay-db-')), 'test.db');

test('configureConnection enables WAL and synchronous=NORMAL by default', async () => {
    delete process.env.SQLITE_JOURNAL_MODE;
    const conn = await open(tmpDb());
    const mode = await configureConnection(conn, { label: 'test' });
    assert.strictEqual(mode, 'wal');
    assert.strictEqual((await get(conn, 'PRAGMA journal_mode')).journal_mode, 'wal');
    assert.strictEqual((await get(conn, 'PRAGMA synchronous')).synchronous, 1); // 1 = NORMAL
    assert.strictEqual((await get(conn, 'PRAGMA temp_store')).temp_store, 2); // 2 = MEMORY
    await close(conn);
});

test('SQLITE_JOURNAL_MODE=DELETE keeps the rollback journal and full synchronous', async () => {
    process.env.SQLITE_JOURNAL_MODE = 'delete';
    try {
        const conn = await open(tmpDb());
        const mode = await configureConnection(conn, { label: 'test' });
        assert.strictEqual(mode, 'delete');
        // NORMAL is only safe with WAL, so the default (FULL = 2) must stay in place.
        assert.strictEqual((await get(conn, 'PRAGMA synchronous')).synchronous, 2);
        await close(conn);
    } finally {
        delete process.env.SQLITE_JOURNAL_MODE;
    }
});

test('unsupported journal modes fall back to WAL', () => {
    assert.strictEqual(resolveJournalMode('off'), 'WAL');
    assert.strictEqual(resolveJournalMode('memory'), 'WAL');
    assert.strictEqual(resolveJournalMode(' truncate '), 'TRUNCATE');
    assert.strictEqual(resolveJournalMode(undefined), 'WAL');
});

test('a second connection only reports the journal mode and applies synchronous=NORMAL for WAL', async () => {
    const file = tmpDb();
    const main = await open(file);
    await configureConnection(main, { label: 'main' });
    const second = await open(file);
    const mode = await configureConnection(second, { label: 'second', setJournalMode: false, tuneCache: false });
    assert.strictEqual(mode, 'wal');
    assert.strictEqual((await get(second, 'PRAGMA synchronous')).synchronous, 1);
    await close(second);
    await close(main);
});

test('foreign keys are enforced by default and SQLITE_FOREIGN_KEYS=off disables them', async () => {
    delete process.env.SQLITE_FOREIGN_KEYS;
    const on = await open(tmpDb());
    await configureConnection(on, { label: 'test' });
    assert.strictEqual((await get(on, 'PRAGMA foreign_keys')).foreign_keys, 1);
    await close(on);

    process.env.SQLITE_FOREIGN_KEYS = 'off';
    try {
        const off = await open(tmpDb());
        await configureConnection(off, { label: 'test' });
        assert.strictEqual((await get(off, 'PRAGMA foreign_keys')).foreign_keys, 0);
        await close(off);
    } finally {
        delete process.env.SQLITE_FOREIGN_KEYS;
    }
});

test('orphan cleanup removes rows whose parent is gone, keeps the rest, and the cascades then work', async () => {
    const conn = await open(tmpDb());
    const exec = (sql) => new Promise((resolve, reject) => conn.exec(sql, (err) => (err ? reject(err) : resolve())));
    const all = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
    const userChild = (table) => `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);`;
    await exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        ${['user_settings', 'multiview_layouts', 'notifications', 'push_subscriptions', 'dvr_jobs', 'watch_progress'].map(userChild).join('\n')}
        CREATE TABLE dvr_recordings (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            job_id INTEGER REFERENCES dvr_jobs(id) ON DELETE SET NULL);
        CREATE TABLE notification_deliveries (id INTEGER PRIMARY KEY, notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
            subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE);
        CREATE TABLE movies (id INTEGER PRIMARY KEY);
        CREATE TABLE series (id INTEGER PRIMARY KEY);
        CREATE TABLE episodes (id INTEGER PRIMARY KEY, series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE);
        CREATE TABLE provider_movie_relations (movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE);
        CREATE TABLE provider_series_relations (series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE);
        CREATE TABLE provider_episode_relations (episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE);
        INSERT INTO users VALUES (1);
        INSERT INTO notifications VALUES (1, 1), (2, 99);          -- 2 belongs to a deleted user
        INSERT INTO push_subscriptions VALUES (1, 1), (2, 99);
        INSERT INTO notification_deliveries VALUES (1, 1, 1), (2, 2, 1), (3, 1, 2), (4, 1, 1);
        INSERT INTO user_settings VALUES (1, 1), (2, 99);
        INSERT INTO dvr_jobs VALUES (1, 1);
        INSERT INTO dvr_recordings VALUES (1, 1, 1), (2, 1, 55), (3, 99, 1);  -- 2 points at a missing job, 3 at a deleted user
        INSERT INTO movies VALUES (1); INSERT INTO series VALUES (1); INSERT INTO episodes VALUES (1, 1), (2, 77);
        INSERT INTO provider_movie_relations VALUES (1), (9);
        INSERT INTO provider_series_relations VALUES (1), (9);
        INSERT INTO provider_episode_relations VALUES (1), (2), (9);
    `);

    for (let pass = 0; pass < 2; pass++) { // idempotent
        for (const sql of ORPHAN_CLEANUP_SQL) await exec(sql);
    }
    const ids = async (table, column = 'id') => (await all(`SELECT ${column} AS v FROM ${table} ORDER BY ${column}`)).map((r) => r.v);
    assert.deepStrictEqual(await ids('notifications'), [1]);
    assert.deepStrictEqual(await ids('push_subscriptions'), [1]);
    assert.deepStrictEqual(await ids('notification_deliveries'), [1, 4]);
    assert.deepStrictEqual(await ids('user_settings'), [1]);
    assert.deepStrictEqual(await ids('dvr_recordings'), [1, 2]);
    assert.deepStrictEqual((await all('SELECT job_id FROM dvr_recordings ORDER BY id')).map((r) => r.job_id), [1, null]);
    assert.deepStrictEqual(await ids('provider_movie_relations', 'movie_id'), [1]);
    assert.deepStrictEqual(await ids('provider_series_relations', 'series_id'), [1]);
    assert.deepStrictEqual(await ids('episodes'), [1]);
    assert.deepStrictEqual(await ids('provider_episode_relations', 'episode_id'), [1]);

    // With enforcement on, deleting a user takes its rows along.
    await configureConnection(conn, { label: 'test' });
    await exec('DELETE FROM users WHERE id = 1');
    for (const table of ['notifications', 'push_subscriptions', 'notification_deliveries', 'user_settings', 'dvr_jobs', 'dvr_recordings']) {
        assert.deepStrictEqual(await ids(table), [], table);
    }
    await close(conn);
});
