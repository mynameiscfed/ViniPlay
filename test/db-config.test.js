// Connection tuning: WAL + synchronous=NORMAL, with a safe fallback.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { configureConnection, resolveJournalMode } = require('../dbConfig');

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
