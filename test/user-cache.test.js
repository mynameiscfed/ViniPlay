// requireAuth relies on this cache, so staleness and race handling matter.
const { test } = require('node:test');
const assert = require('node:assert');
const { createUserCache } = require('../userCache');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('caches a found user and loads it once', async () => {
    let loads = 0;
    const cache = createUserCache({ load: async (id) => { loads++; return { id, isAdmin: 1 }; } });
    assert.strictEqual((await cache.get(1)).isAdmin, 1);
    await cache.get(1);
    await cache.get('1'); // same user regardless of id type
    assert.strictEqual(loads, 1);
});

test('does not cache a missing user', async () => {
    let loads = 0;
    const cache = createUserCache({ load: async () => { loads++; return undefined; } });
    assert.strictEqual(await cache.get(7), undefined);
    await cache.get(7);
    assert.strictEqual(loads, 2);
});

test('concurrent gets share one load', async () => {
    let loads = 0;
    const cache = createUserCache({ load: async (id) => { loads++; await sleep(10); return { id }; } });
    await Promise.all([cache.get(1), cache.get(1), cache.get(1)]);
    assert.strictEqual(loads, 1);
});

test('entries expire after the ttl', async () => {
    let loads = 0;
    const cache = createUserCache({ ttlMs: 20, load: async (id) => { loads++; return { id }; } });
    await cache.get(1);
    await sleep(40);
    await cache.get(1);
    assert.strictEqual(loads, 2);
});

test('invalidate forces a reload', async () => {
    let name = 'before';
    const cache = createUserCache({ load: async (id) => ({ id, name }) });
    assert.strictEqual((await cache.get(1)).name, 'before');
    name = 'after';
    assert.strictEqual((await cache.get(1)).name, 'before'); // still cached
    cache.invalidate(1);
    assert.strictEqual((await cache.get(1)).name, 'after');
});

test('a load that races with invalidate is not cached', async () => {
    let name = 'old';
    const cache = createUserCache({ load: async (id) => { const snapshot = name; await sleep(20); return { id, name: snapshot }; } });
    const inflight = cache.get(1); // reads "old"
    await sleep(5); // let the SELECT start
    name = 'new';
    cache.invalidate(1); // e.g. the user was edited while the SELECT was running
    assert.strictEqual((await inflight).name, 'old');
    assert.strictEqual((await cache.get(1)).name, 'new'); // the stale row was not kept
});

test('a throwing loader does not wedge the cache', async () => {
    let fail = true;
    const cache = createUserCache({ load: (id) => { if (fail) throw new Error('boom'); return { id }; } });
    await assert.rejects(() => cache.get(1), /boom/);
    fail = false;
    assert.strictEqual((await cache.get(1)).id, 1);
});

test('cached rows are frozen and the cache is bounded', async () => {
    const cache = createUserCache({ maxEntries: 2, load: async (id) => ({ id }) });
    const user = await cache.get(1);
    assert.throws(() => { 'use strict'; user.id = 9; }, TypeError);
    await cache.get(2);
    await cache.get(3);
    assert.strictEqual(cache.size(), 2);
});
