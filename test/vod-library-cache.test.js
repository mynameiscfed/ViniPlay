// The serialized /api/vod/library response cache.
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { createLibraryCache } = require('../vodLibraryCache');

const payload = (n) => ({ movies: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `Movie ${i}` })), series: [], categories: [] });

test('builds once per key and serves the serialized body afterwards', async () => {
    const cache = createLibraryCache();
    let builds = 0;
    const build = async () => { builds++; return payload(3); };
    const first = await cache.get('a', build);
    const second = await cache.get('a', build);
    assert.strictEqual(builds, 1);
    assert.strictEqual(first, second);
    assert.deepStrictEqual(JSON.parse(first.body.toString('utf8')), payload(3));
    await cache.get('b', build);
    assert.strictEqual(builds, 2);
});

test('concurrent misses share one build', async () => {
    const cache = createLibraryCache();
    let builds = 0;
    const build = async () => { builds++; await new Promise((resolve) => setTimeout(resolve, 10)); return payload(2); };
    const [a, b, c] = await Promise.all([cache.get('k', build), cache.get('k', build), cache.get('k', build)]);
    assert.strictEqual(builds, 1);
    assert.ok(a === b && b === c);
});

test('invalidate drops entries, and a build that raced with it is not stored', async () => {
    const cache = createLibraryCache();
    let version = 1;
    const build = async () => { const snapshot = version; await new Promise((resolve) => setTimeout(resolve, 10)); return { snapshot }; };

    const slow = cache.get('k', build); // reads version 1 ...
    await new Promise((resolve) => setTimeout(resolve, 2));
    version = 2;
    cache.invalidate(); // ... the catalog changes while it is still building
    assert.strictEqual(JSON.parse((await slow).body).snapshot, 1, 'the caller that was already waiting gets what it asked for');
    assert.strictEqual(cache.size(), 0, 'but the stale result is not kept');

    assert.strictEqual(JSON.parse((await cache.get('k', build)).body).snapshot, 2);
    assert.strictEqual(cache.size(), 1);
    cache.invalidate();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.bytes(), 0);
});

test('a failed build is not cached and the next call retries', async () => {
    const cache = createLibraryCache();
    let calls = 0;
    const build = async () => { if (++calls === 1) throw new Error('db busy'); return payload(1); };
    await assert.rejects(cache.get('k', build), /db busy/);
    await cache.get('k', build);
    assert.strictEqual(calls, 2);
});

test('keeps at most maxEntries and evicts the least recently used', async () => {
    const cache = createLibraryCache({ maxEntries: 2 });
    const build = (n) => async () => payload(n);
    await cache.get('a', build(1));
    await cache.get('b', build(1));
    await cache.get('a', build(1)); // a is now the most recent
    await cache.get('c', build(1)); // evicts b
    let rebuilt = false;
    await cache.get('b', async () => { rebuilt = true; return payload(1); });
    assert.ok(rebuilt, 'b was evicted');
    let aRebuilt = false;
    await cache.get('a', async () => { aRebuilt = true; return payload(1); });
    assert.ok(!aRebuilt || cache.size() <= 2);
    assert.ok(cache.size() <= 2);
});

test('respects the byte budget and still serves an entry that is too big to keep', async () => {
    const cache = createLibraryCache({ maxBytes: 5000 });
    const big = await cache.get('big', async () => payload(500));
    assert.ok(big.body.length > 2500);
    assert.strictEqual(cache.size(), 0);
    await cache.get('small', async () => payload(5));
    assert.strictEqual(cache.size(), 1);
    assert.ok(cache.bytes() <= 5000);
});

test('the gzip copy is made once, matches the body and has its own ETag', async () => {
    const cache = createLibraryCache();
    const entry = await cache.get('k', async () => payload(200));
    const [first, second] = await Promise.all([entry.gzip(), entry.gzip()]);
    assert.strictEqual(first, second);
    assert.deepStrictEqual(zlib.gunzipSync(first), entry.body);
    assert.ok(first.length < entry.body.length / 2);
    assert.notStrictEqual(entry.etag, entry.gzipEtag);
    assert.match(entry.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
});
