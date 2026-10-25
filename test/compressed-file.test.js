const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { isGzipFile, openMaybeGzip } = require('../compressedFile');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viniplay-gzip-'));

async function readAll(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

test('gzip is detected by bytes, not by the file name', async () => {
    const plain = path.join(tempDir, 'guide.xml');
    const gzWithXmlName = path.join(tempDir, 'uploaded.xml');
    fs.writeFileSync(plain, '<tv>plain</tv>');
    fs.writeFileSync(gzWithXmlName, zlib.gzipSync('<tv>gzipped</tv>'));

    assert.strictEqual(isGzipFile(plain), false);
    assert.strictEqual(isGzipFile(gzWithXmlName), true);
    assert.strictEqual(await readAll(openMaybeGzip(plain)), '<tv>plain</tv>');
    assert.strictEqual(await readAll(openMaybeGzip(gzWithXmlName)), '<tv>gzipped</tv>');
});
