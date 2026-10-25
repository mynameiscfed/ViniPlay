// Which XMLTV channel feeds which playlist channel; see epgMatch.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { nameKey, normalizeName, shiftOf, buildTargets, createSuggester, bestMatch } = require('../epgMatch');

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
    assert.strictEqual(nameKey('UK | BBC One [Backup]'), 'bbc1');
    assert.strictEqual(nameKey('FR - Café (RAW) 4K'), 'cafe');
    assert.strictEqual(nameKey('ESPN 2'), nameKey('ESPN2'));
    assert.strictEqual(nameKey('BBC-One'), 'bbc1'); // a hyphen inside a name is not a prefix, "one" becomes a digit
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

// --- Real feeds: an Xtream panel's guides (sat.tv and an Arabic sports lineup) ---

const slugKey = (id) => nameKey(id.replace(/\.[a-z]{2,3}$/i, ''));

test('regional id-slugs and polluted display-names normalize to the same key', () => {
    assert.strictEqual(slugKey('MBC.Masr.HD.ae'), nameKey('MBC Masr HD'));
    assert.strictEqual(slugKey('Rotana.Cinema.KSA.ae'), nameKey('Rotana Cinema KSA'));
    assert.strictEqual(slugKey('arryadia.ma'), nameKey('AR-SP| MA ARRYADIA TNT'));
    assert.strictEqual(slugKey('alkassfive.qa'), nameKey('AR-SP| ART ALKASS 5 HD'));
    assert.strictEqual(slugKey('alkassone.qa'), nameKey('ALKASS 1'));
    assert.strictEqual(normalizeName('AR-SP| EGY ONTIME SPORTS PLUS'), 'ontime sports plus');
});

test('a wrong 2-3 letter name before " - " is not treated as a country prefix', () => {
    assert.strictEqual(nameKey('BBC - One'), 'bbc1');
});

test('exact matching uses the id-slug, so a clean id beats a polluted display-name', () => {
    const channels = new Map([['s_a', { originalId: '', name: 'ALKASS 5' }]]);
    const guide = [ { id: 'alkassfive.qa', names: ['AR-SP| ART ALKASS 5 HD'] } ];
    const t = buildTargets({ channels, epgChannels: guide });
    assert.deepStrictEqual(t.get('alkassfive.qa'), ['s_a']);
});

test('a name collision is resolved by the group region', () => {
    const channels = new Map([['s_a', { originalId: '', name: 'Rotana Cinema', group: 'KSA' }]]);
    const guide = [
        { id: 'Rotana.Cinema.KSA.ae', names: ['Rotana Cinema KSA'] },
        { id: 'Rotana.Cinema.Egypt.ae', names: ['Rotana Cinema Egypt'] },
    ];
    const t = buildTargets({ channels, epgChannels: guide });
    assert.deepStrictEqual(t.get('Rotana.Cinema.KSA.ae'), ['s_a']);
    assert.strictEqual(t.has('Rotana.Cinema.Egypt.ae'), false);
});

test('a name collision with an unhelpful group is left to the user', () => {
    const channels = new Map([['s_a', { originalId: '', name: 'Rotana Cinema', group: 'General' }]]);
    const guide = [
        { id: 'Rotana.Cinema.KSA.ae', names: ['Rotana Cinema KSA'] },
        { id: 'Rotana.Cinema.Egypt.ae', names: ['Rotana Cinema Egypt'] },
    ];
    const t = buildTargets({ channels, epgChannels: guide });
    assert.strictEqual(t.has('Rotana.Cinema.KSA.ae'), false);
    assert.strictEqual(t.has('Rotana.Cinema.Egypt.ae'), false);
});

test('a time-shifted channel never auto-matches its base channel', () => {
    assert.strictEqual(shiftOf('ESPN +1'), 1);
    assert.strictEqual(shiftOf('ESPN plus 2'), 2);
    const suggest = createSuggester([{ id: 'ESPN.us', names: ['ESPN'] }]);
    const base = bestMatch(suggest, 'ESPN');
    assert.ok(base && base.id === 'ESPN.us');
    const shifted = bestMatch(suggest, 'ESPN +1');
    assert.ok(!shifted || shifted.confidence < 0.9, 'a wrong shift is never confident');
});
