// Large JSON responses are gzipped for clients that accept it and left alone otherwise.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const { sendJson } = require('../sendJson');

async function withServer(body, run) {
    const app = express();
    app.get('/', (req, res) => sendJson(req, res, body));
    const server = app.listen(0);
    try {
        await run(server.address().port);
    } finally {
        server.close();
    }
}

const get = (port, headers) => new Promise((resolve, reject) => {
    http.get({ port, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    }).on('error', reject);
});

const big = Buffer.from(JSON.stringify({ items: new Array(500).fill('channel name') }));

test('gzips a large body for a client that accepts gzip', async () => {
    await withServer(big, async (port) => {
        const { res, body } = await get(port, { 'accept-encoding': 'gzip' });
        assert.strictEqual(res.headers['content-encoding'], 'gzip');
        assert.match(res.headers['content-type'], /json/);
        assert.strictEqual(res.headers.vary, 'Accept-Encoding');
        assert.ok(body.length < big.length / 4);
        assert.deepStrictEqual(zlib.gunzipSync(body), big);
    });
});

test('sends plain JSON when the client does not accept gzip', async () => {
    await withServer(big, async (port) => {
        const { res, body } = await get(port, { 'accept-encoding': 'identity' });
        assert.strictEqual(res.headers['content-encoding'], undefined);
        assert.deepStrictEqual(body, big);
    });
});

test('does not compress a tiny body', async () => {
    await withServer(Buffer.from('{"ok":true}'), async (port) => {
        const { res, body } = await get(port, { 'accept-encoding': 'gzip' });
        assert.strictEqual(res.headers['content-encoding'], undefined);
        assert.strictEqual(body.toString(), '{"ok":true}');
    });
});
