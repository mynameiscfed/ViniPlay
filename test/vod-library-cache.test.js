// The serialized /api/vod/library response cache.
const { test } = require('node:test');
const assert = require('node:assert');
const { createLibraryCache } = require('../vodLibraryCache');

const payload = (n) => ({ movies: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('builds once per key, concurrent misses share the build, and the body is serialized JSON', async () => {
    const cache = createLibraryCache();
    let builds = 0;
    const build = async () => { builds++; await sleep(5); return payload(3); };
    const [a, b] = await Promise.all([cache.get('k', build), cache.get('k', build)]);
    assert.strictEqual(builds, 1);
    assert.strictEqual(a, b);
    assert.deepStrictEqual(JSON.parse(a), payload(3));
    await cache.get('k', build);
    assert.strictEqual(builds, 1);
    await cache.get('other', build);
    assert.strictEqual(builds, 2);
});

test('invalidate drops entries, including a build still in flight', async () => {
    const cache = createLibraryCache();
    let version = 1;
    const build = async () => { const seen = version; await sleep(10); return { seen }; };

    const slow = cache.get('k', build);
    await sleep(2);
    version = 2;
    cache.invalidate(); // the catalog changed while that build was running
    assert.strictEqual(JSON.parse(await slow).seen, 1, 'the waiting caller still gets its answer');
    assert.strictEqual(JSON.parse(await cache.get('k', build)).seen, 2, 'but nobody else is served the stale one');
});

test('a failed build is not kept', async () => {
    const cache = createLibraryCache();
    let calls = 0;
    const build = async () => { if (++calls === 1) throw new Error('db busy'); return payload(1); };
    await assert.rejects(cache.get('k', build), /db busy/);
    await cache.get('k', build);
    assert.strictEqual(calls, 2);
});

test('keeps at most maxEntries', async () => {
    const cache = createLibraryCache(2);
    let builds = 0;
    const build = async () => { builds++; return payload(1); };
    for (const key of ['a', 'b', 'c']) await cache.get(key, build);
    await cache.get('a', build); // evicted by c
    assert.strictEqual(builds, 4);
});
