// userCache.js
// Short-lived in-memory cache of user rows. requireAuth used to run a SELECT on every
// request, and several endpoints re-read the same row for allowed_sources. The server is a
// single process and all user writes go through it, so entries are invalidated explicitly
// on update/delete; the TTL only bounds staleness if some path forgets to.

const DEFAULT_TTL_MS = 30 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

function createUserCache({ load, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (typeof load !== 'function') throw new Error('createUserCache requires a load(id) function.');

    const entries = new Map(); // id -> { user, expires }
    const inflight = new Map(); // id -> Promise<user|undefined>
    let epoch = 0; // bumped by invalidate/clear so a load that raced with one is not cached

    function get(id) {
        const key = String(id);
        const hit = entries.get(key);
        if (hit && hit.expires > Date.now()) return Promise.resolve(hit.user);
        if (hit) entries.delete(key);

        if (inflight.has(key)) return inflight.get(key);

        const startedAt = epoch;
        const pending = Promise.resolve()
            .then(() => load(id))
            .then((user) => {
                if (!user) return user;
                const frozen = Object.freeze({ ...user });
                if (startedAt === epoch) {
                    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
                    entries.set(key, { user: frozen, expires: Date.now() + ttlMs });
                }
                return frozen;
            })
            .finally(() => {
                if (inflight.get(key) === pending) inflight.delete(key);
            });
        inflight.set(key, pending);
        return pending;
    }

    function invalidate(id) {
        epoch++;
        entries.delete(String(id));
        inflight.delete(String(id));
    }

    function clear() {
        epoch++;
        entries.clear();
        inflight.clear();
    }

    return { get, invalidate, clear, size: () => entries.size };
}

module.exports = { createUserCache };
