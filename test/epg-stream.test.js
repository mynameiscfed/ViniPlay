// Large XMLTV guides are parsed as a stream; see epgStream.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { forEachProgramme } = require('../epgStream');

const programme = (channel, title) =>
    `<programme start="20250101120000 +0000" stop="20250101130000 +0000" channel="${channel}">` +
    `<title lang="en"><![CDATA[${title}]]></title><desc>café &amp; more</desc></programme>`;

async function collect(stream) {
    const found = [];
    await forEachProgramme(stream, (p) => found.push(p));
    return found;
}

test('finds every programme however the stream is chunked', async () => {
    const xml = '<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel>' +
        `${programme('a', 'One')}\n${programme('b', 'Two')}<programme channel="c" start="x" stop="y"/>${programme('a', 'Three')}</tv>`;
    // 5-byte chunks split tags and the multi-byte "é" mid-sequence.
    const buf = Buffer.from(xml);
    const chunks = Array.from({ length: Math.ceil(buf.length / 5) }, (_, i) => buf.subarray(i * 5, i * 5 + 5));
    const found = await collect(Readable.from(chunks));
    assert.deepStrictEqual(found.map((p) => p._attributes.channel), ['a', 'b', 'c', 'a']);
    assert.strictEqual(found[0].title._cdata, 'One');
    assert.strictEqual(found[0].desc._text, 'café & more');
});

test('streams far more data than it buffers', async () => {
    const total = 20000;
    let sent = 0;
    const source = new Readable({
        read() { this.push(sent < total ? programme('a', `T${sent++}`) : null); },
    });
    let count = 0;
    await forEachProgramme(source, () => count++);
    assert.strictEqual(count, total);
});

test('a stream error rejects instead of hanging', async () => {
    const source = Readable.from((async function* () { yield programme('a', 'One'); throw new Error('boom'); })());
    await assert.rejects(collect(source), /boom/);
});
