// vodLibraryCache.js
// /api/vod/library used to run a JOIN + ORDER BY over every movie and series and serialize
// the result on every hit. The catalog only changes when a source refresh finishes, so the
// serialized response is kept per permission signature and dropped when the catalog changes.
// The gzip copy is made once, so compression middleware does not redo it for every request.

const crypto = require('crypto');
const zlib = require('zlib');

const DEFAULT_MAX_ENTRIES = 6;
const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;

function createLibraryEntry(payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const digest = crypto.createHash('sha1').update(body).digest('hex').slice(0, 20);
    const etag = `W/"${body.length.toString(16)}-${digest}"`;
    let gzipPromise = null;
    return {
        body,
        etag,
        gzipEtag: `W/"${body.length.toString(16)}-${digest}-gzip"`,
        // body plus room for its compressed copy
        bytes: body.length * 2,
        gzip() {
            if (!gzipPromise) {
                gzipPromise = new Promise((resolve, reject) => {
                    zlib.gzip(body, (err, compressed) => (err ? reject(err) : resolve(compressed)));
                });
                gzipPromise.catch(() => { gzipPromise = null; });
            }
            return gzipPromise;
        },
    };
}

function createLibraryCache({ maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const entries = new Map(); // key -> entry; insertion order doubles as recency
    const inflight = new Map(); // key -> Promise<entry>
    let epoch = 0; // bumped by invalidate() so a build that raced with it is not stored
    let totalBytes = 0;

    function store(key, entry) {
        if (entry.bytes > maxBytes) return; // too big to keep; still served to this caller
        entries.set(key, entry);
        totalBytes += entry.bytes;
        while (entries.size > maxEntries || totalBytes > maxBytes) {
            const [oldestKey, oldest] = entries.entries().next().value;
            entries.delete(oldestKey);
            totalBytes -= oldest.bytes;
        }
    }

    /**
     * @param {string} key Identifies everything the response depends on (providers, credentials, permitted groups).
     * @param {() => Promise<object>} build Produces the response payload on a miss.
     * @returns {Promise<{body: Buffer, etag: string, gzipEtag: string, gzip: () => Promise<Buffer>}>}
     */
    function get(key, build) {
        const hit = entries.get(key);
        if (hit) {
            entries.delete(key); // refresh recency
            entries.set(key, hit);
            return Promise.resolve(hit);
        }
        if (inflight.has(key)) return inflight.get(key);

        const startedAt = epoch;
        const pending = Promise.resolve()
            .then(build)
            .then((payload) => {
                const entry = createLibraryEntry(payload);
                if (startedAt === epoch) store(key, entry);
                return entry;
            })
            .finally(() => {
                if (inflight.get(key) === pending) inflight.delete(key);
            });
        inflight.set(key, pending);
        return pending;
    }

    function invalidate() {
        epoch++;
        entries.clear();
        inflight.clear();
        totalBytes = 0;
    }

    return { get, invalidate, size: () => entries.size, bytes: () => totalBytes };
}

module.exports = { createLibraryCache };
