// The channel list and EPG are parsed once per file change, and settings.json must never be half-written.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cachedFile, writeFileAtomic } = require('../fileStore');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'file-store-'));

test('cachedFile parses once, again after the file changes, and is undefined while missing', () => {
    const file = path.join(tempDir(), 'epg.json');
    let parses = 0;
    const read = cachedFile(file, (text) => { parses++; return JSON.parse(text); });

    assert.strictEqual(read(), undefined);
    fs.writeFileSync(file, '{"a":1}');
    assert.deepStrictEqual(read(), { a: 1 });
    assert.strictEqual(read(), read()); // same object, no re-parse
    assert.strictEqual(parses, 1);

    fs.writeFileSync(file, '{"a":1,"b":2}'); // size differs, so this is noticed even within one mtime tick
    assert.deepStrictEqual(read(), { a: 1, b: 2 });
    assert.strictEqual(parses, 2);

    fs.unlinkSync(file);
    assert.strictEqual(read(), undefined);
});

test('cachedFile lets a parse error through and retries on the next call', () => {
    const file = path.join(tempDir(), 'epg.json');
    fs.writeFileSync(file, '{broken');
    const read = cachedFile(file, JSON.parse);
    assert.throws(read, SyntaxError);
    fs.writeFileSync(file, '{"ok":true}');
    assert.deepStrictEqual(read(), { ok: true });
});

test('writeFileAtomic replaces the file and leaves no temp file behind', () => {
    const dir = tempDir();
    const file = path.join(dir, 'settings.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'two');
    assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json']);
});
