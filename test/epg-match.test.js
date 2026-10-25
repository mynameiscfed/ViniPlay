// Which XMLTV channel feeds which playlist channel; see epgMatch.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { nameKey, buildTargets, createSuggester, bestMatch } = require('../epgMatch');

const epg = [
    { id: 'ESPN.us', names: ['ESPN'] },
    { id: 'ESPN2.us', names: ['ESPN 2', 'ESPN2 HD'] },
    { id: 'BBCOne.uk', names: ['BBC One'] },
    { id: 'BBCOneHD.uk', names: ['BBC One HD'] },
    { id: 'CNN.us', names: ['CNN', 'CNN International'] },
    { id: 'Discovery.us', names: ['Discovery Channel'] },
];
const ch = (originalId, name) => ({ originalId, name });

test('names compare equal once providers decorations are stripped', () => {
    assert.strictEqual(nameKey('US: ESPN HD'), 'espn');
    assert.strictEqual(nameKey('UK | BBC One [Backup]'), 'bbcone');
    assert.strictEqual(nameKey('FR - Café (RAW) 4K'), 'cafe');
    assert.strictEqual(nameKey('ESPN 2'), nameKey('ESPN2'));
    assert.strictEqual(nameKey('BBC-One'), 'bbcone'); // a hyphen inside a name is not a prefix separator
    assert.strictEqual(nameKey('HD'), '');
});

test('override beats exact id beats name match', () => {
    const channels = new Map([
        ['s_a', ch('ESPN.us', 'whatever')], // exact id
        ['s_b', ch('', 'US: ESPN HD')], // name only
        ['s_c', ch('CNN.us', 'CNN')], // exact id, but overridden
    ]);
    const t = buildTargets({ channels, overrides: { s_c: 'ESPN2.us' }, epgChannels: epg });
    assert.deepStrictEqual(t.get('ESPN.us'), ['s_a', 's_b']);
    assert.deepStrictEqual(t.get('ESPN2.us'), ['s_c']);
    assert.strictEqual(t.has('CNN.us'), false, 'an overridden channel no longer takes its own id');
});

test('a channel whose id is in a guide is never name-matched', () => {
    const channels = new Map([['s_a', ch('CNN.us', 'ESPN')]]);
    const t = buildTargets({ channels, epgChannels: epg });
    assert.deepStrictEqual([...t.keys()], ['CNN.us']);
});

test('an ambiguous name is left alone, an id the guide does not declare still matches as before', () => {
    const channels = new Map([['s_a', ch('', 'BBC One')], ['s_b', ch('undeclared', 'x')]]);
    const t = buildTargets({ channels, epgChannels: epg.filter((c) => c.id !== 'BBCOne.uk').concat({ id: 'Other', names: ['BBC One'] }) });
    assert.strictEqual(t.has('Other'), false);
    assert.deepStrictEqual(t.get('undeclared'), ['s_b']);
    assert.deepStrictEqual(t.get(''), ['s_a']);
});

test('fuzzy suggestions rank the likeliest channel first', () => {
    const suggest = createSuggester(epg);
    assert.strictEqual(suggest('Discovry Chanel')[0].id, 'Discovery.us'); // typos
    assert.strictEqual(suggest('US: CNN Intl HD')[0].id, 'CNN.us'); // decorations and abbreviations
    assert.strictEqual(suggest('espn')[0].id, 'ESPN.us');
    assert.deepStrictEqual(suggest('zzzzzz'), []);
    assert.deepStrictEqual(suggest('HD'), []);
    assert.ok(suggest('CNN')[0].confidence > 0.9);
    assert.strictEqual(suggest('Discovery', 2).length, 1);
});

test('a near tie is demoted so bulk accept skips it', () => {
    const suggest = createSuggester(epg);
    const tie = bestMatch(suggest, 'BBC One');
    const clear = bestMatch(suggest, 'CNN');
    assert.ok(tie.confidence < 0.9);
    assert.ok(clear.confidence >= 0.9);
});
