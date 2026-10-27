// /api/config serves the EPG as cached JSON text per permission set.
const { test } = require('node:test');
const assert = require('node:assert');
const { createEpgPayload } = require('../epgPayload');

const epg = { a_one: [{ title: 'x' }], a_two: [], b_one: [{ title: 'y' }], noprefix: [] };

test('serves the file text to unrestricted users and the allowed sources to restricted ones', () => {
    const payload = createEpgPayload(() => JSON.stringify(epg));
    assert.deepStrictEqual(JSON.parse(payload(null)), epg);
    assert.deepStrictEqual(JSON.parse(payload({ a: { allowed: true } })), { a_one: epg.a_one, a_two: epg.a_two });
    assert.deepStrictEqual(JSON.parse(payload({ a: { allowed: false }, b: {} })), {});
});

test('builds each result once per file change', () => {
    let text = JSON.stringify(epg);
    const payload = createEpgPayload(() => text);
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args) => { parses++; return parse(...args); };
    try {
        const allowed = { b: { allowed: true } };
        payload(allowed); payload(allowed); payload(null); payload(null);
        assert.strictEqual(parses, 1); // only the restricted copy is parsed
        text = JSON.stringify({ b_new: [] });
        assert.deepStrictEqual(JSON.parse(payload(allowed)), { b_new: [] });
    } finally {
        JSON.parse = parse;
    }
});

test('a damaged file gives an empty guide and a missing file gives undefined', () => {
    assert.strictEqual(createEpgPayload(() => '{broken')(null), '{}');
    assert.strictEqual(createEpgPayload(() => '{"a":[')(null), '{}');
    assert.strictEqual(createEpgPayload(() => undefined)(null), undefined);
});
