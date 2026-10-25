// Pending EPG suggestions and the background match job; see epgSuggest.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { createSuggestStore, suggestChunk, runMatchJob } = require('../epgSuggest');

test('the store persists merges and removals through its injected file', () => {
    let file = '{"a":{"channelId":"a","epgId":"X"}}';
    const writes = [];
    const store = createSuggestStore(() => file, (data) => { writes.push(data); file = data; });
    assert.deepStrictEqual(store.all(), [{ channelId: 'a', epgId: 'X' }]);
    store.merge([{ channelId: 'b', epgId: 'Y' }]);
    assert.strictEqual(file, JSON.stringify({ a: { channelId: 'a', epgId: 'X' }, b: { channelId: 'b', epgId: 'Y' } }));
    assert.strictEqual(store.all().length, 2);
    store.remove(['a']);
    assert.deepStrictEqual(store.all(), [{ channelId: 'b', epgId: 'Y' }]);
});

test('a corrupt store file starts over instead of crashing', () => {
    const store = createSuggestStore(() => 'not json', () => {});
    assert.deepStrictEqual(store.all(), []);
});

const C = { CONFIDENT: 0.9, AI_CONFIDENCE: 0.8 };
const items = (ids) => ids.map((id) => ({ id, name: `n${id}`, group: 'g' }));

test('a non-confident name match that the AI also picks is recorded as an AI match', async () => {
    const suggestName = () => [{ id: 'ESPN.us', names: ['ESPN'], confidence: 0.7 }];
    const bestOf = () => ({ id: 'ESPN.us', names: ['ESPN'], confidence: 0.7 }); // below CONFIDENT
    const pickWithLlm = async () => ['ESPN.us'];
    const { suggestions, failed } = await suggestChunk(items(['a']), { suggestName, bestOf, pickWithLlm, withAi: true, apiKey: 'k', model: 'm', ...C });
    assert.strictEqual(suggestions.a.via, 'ai');
    assert.strictEqual(suggestions.a.confident, false);
    assert.strictEqual(failed, 0);
});

test('an AI "null" demotes the name suggestion instead of deleting it', async () => {
    const suggestName = () => [{ id: 'ESPN.us', names: ['ESPN'], confidence: 0.7 }];
    const bestOf = () => ({ id: 'ESPN.us', names: ['ESPN'], confidence: 0.7 });
    const pickWithLlm = async () => [null]; // "none is the same channel"
    const { suggestions } = await suggestChunk(items(['a']), { suggestName, bestOf, pickWithLlm, withAi: true, apiKey: 'k', model: 'm', ...C });
    assert.strictEqual(suggestions.a.epgId, 'ESPN.us');
    assert.strictEqual(suggestions.a.confident, false);
    assert.strictEqual(suggestions.a.aiDisagreed, true);
});

test('an AI failure fails only that chunk and keeps its name suggestions', async () => {
    const suggestName = () => [{ id: 'ESPN.us', names: ['ESPN'], confidence: 0.7 }];
    const bestOf = () => ({ id: 'ESPN.us', names: ['ESPN'], confidence: 0.7 });
    const pickWithLlm = async () => { throw new Error('Insufficient credits'); };
    const { suggestions, failed, error } = await suggestChunk(items(['a', 'b', 'c']), { suggestName, bestOf, pickWithLlm, withAi: true, apiKey: 'k', model: 'm', ...C });
    assert.strictEqual(error, 'Insufficient credits');
    assert.strictEqual(failed, 3);
    assert.strictEqual(suggestions.a.epgId, 'ESPN.us'); // name suggestions survive
});

test('the job persists each chunk, bounds AI concurrency, and survives a throwing chunk', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const persisted = [];
    const chunks = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];
    const processChunk = async (chunk) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (chunk[0] === 5) throw new Error('boom');
        return { suggestions: chunk.map((id) => ({ channelId: `c${id}`, epgId: 'e' })), failed: 0 };
    };
    let last;
    const { done, total, suggested, failed } = await runMatchJob({
        chunks, processChunk, concurrency: 3,
        persist: (list) => { persisted.push(list); },
        onProgress: (p) => { last = p; },
    });
    assert.ok(maxInFlight <= 3, 'never more than the concurrency limit');
    assert.strictEqual(done, 5);
    assert.strictEqual(total, 5);
    assert.strictEqual(suggested, 8); // 4 chunks of 2, the throwing one yielded none
    assert.strictEqual(failed, 2);
    assert.strictEqual(persisted.length, 4);
    assert.strictEqual(last.suggested, 8);
});