// sendJson.js
// The channel/EPG payload and the VOD library are megabytes of JSON that compress about tenfold, and
// the app sends no compression at all. zlib runs on the libuv thread pool, so the event loop is not blocked.
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gzipped = new WeakMap(); // keyed by body, so the cached VOD library is compressed once instead of on every hit

// body: Buffer holding serialized JSON.
async function sendJson(req, res, body) {
    res.type('json').vary('Accept-Encoding');
    if (body.length >= 1024 && req.acceptsEncodings('gzip')) {
        try {
            if (!gzipped.has(body)) gzipped.set(body, gzip(body, { level: zlib.constants.Z_BEST_SPEED }));
            const compressed = await gzipped.get(body);
            res.set('Content-Encoding', 'gzip');
            body = compressed;
        } catch (e) {
            gzipped.delete(body);
            console.error(`[API] gzip failed, sending uncompressed: ${e.message}`);
        }
    }
    res.send(body);
}

module.exports = { sendJson };
