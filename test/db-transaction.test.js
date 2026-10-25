// Transactions run on a connection of their own, one at a time.
const { test } = require('node:test');
const assert = require('node:assert');
const { openVodDb } = require('./helpers/vod-db');
const { createTransactionRunner, run, all } = require('../dbTransaction');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('commits what the callback wrote and returns its result', async () => {
    const t = await openVodDb({ schema: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);' });
    const result = await t.withTransaction(async (conn) => {
        await run(conn, "INSERT INTO kv VALUES ('a', '1')");
        return 'done';
    });
    assert.strictEqual(result, 'done');
    assert.deepStrictEqual(await t.all('SELECT * FROM kv'), [{ k: 'a', v: '1' }]);
    await t.close();
});

test('rolls back when the callback throws, and the next transaction still works', async () => {
    const t = await openVodDb({ schema: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);' });
    await assert.rejects(t.withTransaction(async (conn) => {
        await run(conn, "INSERT INTO kv VALUES ('a', '1')");
        throw new Error('boom');
    }), /boom/);
    assert.deepStrictEqual(await t.all('SELECT * FROM kv'), []);

    await t.withTransaction((conn) => run(conn, "INSERT INTO kv VALUES ('b', '2')"));
    assert.deepStrictEqual(await t.all('SELECT * FROM kv'), [{ k: 'b', v: '2' }]);
    await t.close();
});

test('concurrent callers are serialized instead of interleaving', async () => {
    const t = await openVodDb({ schema: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);' });
    const order = [];
    const first = t.withTransaction(async (conn) => {
        order.push('first:start');
        await run(conn, "INSERT INTO kv VALUES ('a', '1')");
        await sleep(50); // the window in which a shared connection would let another BEGIN in
        order.push('first:end');
    });
    const second = t.withTransaction(async (conn) => {
        order.push('second:start');
        await run(conn, "INSERT INTO kv VALUES ('b', '2')");
        throw new Error('second fails');
    });
    const third = t.withTransaction(async (conn) => {
        order.push('third:start');
        await run(conn, "INSERT INTO kv VALUES ('c', '3')");
    });
    await first;
    await assert.rejects(second, /second fails/);
    await third;
    assert.deepStrictEqual(order, ['first:start', 'first:end', 'second:start', 'third:start']);
    // second's rollback did not touch first's or third's work
    assert.deepStrictEqual((await t.all('SELECT k FROM kv ORDER BY k')).map((r) => r.k), ['a', 'c']);
    await t.close();
});

test('writes on the main connection still succeed while a transaction is open (WAL)', async () => {
    const t = await openVodDb({ schema: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const inTransaction = t.withTransaction(async (conn) => {
        await run(conn, "INSERT INTO kv VALUES ('tx', '1')");
        await gate;
    });
    await sleep(20);
    // A read is never blocked by the open write transaction and sees the last committed state.
    assert.deepStrictEqual(await t.all('SELECT * FROM kv'), []);
    // A write waits for the lock (busy timeout) and goes through after the commit.
    const mainWrite = t.run("INSERT INTO kv VALUES ('main', '1')");
    await sleep(20);
    release();
    await inTransaction;
    await mainWrite;
    assert.deepStrictEqual((await t.all('SELECT k FROM kv ORDER BY k')).map((r) => r.k), ['main', 'tx']);
    await t.close();
});

test('a failed open is retried on the next call', async () => {
    let attempts = 0;
    const real = await openVodDb({ schema: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);' });
    const runner = createTransactionRunner(async () => {
        attempts++;
        if (attempts === 1) throw new Error('cannot open');
        return real.db;
    });
    await assert.rejects(runner.withTransaction(async () => { }), /cannot open/);
    await runner.withTransaction((conn) => run(conn, "INSERT INTO kv VALUES ('a', '1')"));
    assert.strictEqual(attempts, 2);
    assert.strictEqual((await all(real.db, 'SELECT COUNT(*) AS n FROM kv'))[0].n, 1);
    await real.close();
});
