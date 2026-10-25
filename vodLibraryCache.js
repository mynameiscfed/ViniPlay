// vodLibraryCache.js
// The VOD category lists need a DISTINCT scan over every movie and series, but the catalog only changes
// when a source refresh finishes. Keep the serialized response per permission signature and drop
// everything when the catalog changes.

function createLibraryCache(maxEntries = 8) {
    const entries = new Map(); // key -> Promise<Buffer>; the promise is stored at once, so concurrent misses share one build

    return {
        get(key, build) {
            if (!entries.has(key)) {
                if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
                const body = Promise.resolve().then(build).then((payload) => Buffer.from(JSON.stringify(payload)));
                body.catch(() => { if (entries.get(key) === body) entries.delete(key); });
                entries.set(key, body);
            }
            return entries.get(key);
        },
        // A build already in flight keeps running for its caller but is no longer in the map, so it is not reused.
        invalidate() { entries.clear(); },
    };
}

module.exports = { createLibraryCache };
