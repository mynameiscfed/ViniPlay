// The guide merge: channels matched by id, programmes sorted by start, files written, a bad guide reported not thrown.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEpgMerge, mergeEpgInWorker } = require('../epgMerge');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-merge-'));
const guide = path.join(dir, 'guide.xml');
fs.writeFileSync(guide, `<tv>
<channel id="one"><display-name>One</display-name></channel>
<programme start="20250101120000 +0000" stop="20250101130000 +0000" channel="one"><title>Late</title></programme>
<programme start="20250101100000 +0000" stop="20250101110000 +0000" channel="one"><title>Early</title></programme>
</tv>`);
const job = (sources) => ({
    sources,
    liveChannels: new Map([['src_one', { originalId: 'one', name: 'One' }]]),
    overrides: {}, timeZone: null, offsetHours: 0,
    epgPath: path.join(dir, 'epg.json'), channelsPath: path.join(dir, 'epg_channels.json'),
});
const out = { status() { }, log() { } };

test('merges, sorts by start and writes both files, in the worker too', async () => {
    for (const run of [runEpgMerge, mergeEpgInWorker]) {
        const { sources } = await run(job([{ id: 's', name: 'S', file: guide }]), out);
        assert.deepStrictEqual(sources.s, { programCount: 2, epgAddedCount: 2 });
        const epg = JSON.parse(fs.readFileSync(path.join(dir, 'epg.json'), 'utf-8'));
        assert.deepStrictEqual(epg.src_one.map((p) => p.title), ['Early', 'Late']);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'epg_channels.json'), 'utf-8'))[0].id, 'one');
    }
});

test('an unreadable guide is reported per source', async () => {
    const { sources } = await runEpgMerge(job([{ id: 'x', name: 'X', file: path.join(dir, 'missing.xml') }]), out);
    assert.match(sources.x.error, /ENOENT/);
});
