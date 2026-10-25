// loginRateLimit.js
// In-memory login throttling. Counters live in this process, so a restart clears them and
// multiple instances would each keep their own. Good enough to stop online guessing on a
// self-hosted single-container install; move the counters to the database if that changes.
function createLoginLimiter({
    windowMs = 15 * 60 * 1000,
    maxPerIp = 50,
    maxPerUser = 10,
    maxEntries = 10000,
    now = Date.now,
} = {}) {
    const buckets = new Map(); // key -> timestamps[] inside the window

    const recent = (key) => {
        const cutoff = now() - windowMs;
        const list = (buckets.get(key) || []).filter((t) => t > cutoff);
        if (list.length) buckets.set(key, list);
        else buckets.delete(key);
        return list;
    };

    const add = (key) => {
        const list = recent(key);
        list.push(now());
        buckets.set(key, list);
        if (buckets.size > maxEntries) {
            // Drop only expired buckets; if there are still too many, the oldest goes.
            for (const k of [...buckets.keys()]) {
                if (recent(k).length === 0) buckets.delete(k);
            }
            while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
        }
    };

    const keys = (ip, username) => [
        `ip:${ip}`,
        `user:${ip}|${String(username || '').toLowerCase()}`,
    ];

    return {
        /** @returns {number} seconds to wait, or 0 when the attempt may proceed. */
        check(ip, username) {
            const [ipKey, userKey] = keys(ip, username);
            const ipHits = recent(ipKey);
            const userHits = recent(userKey);
            const retryFor = (hits, limit) => {
                if (hits.length < limit) return 0;
                return Math.ceil((hits[0] + windowMs - now()) / 1000);
            };
            return Math.max(0, retryFor(ipHits, maxPerIp), retryFor(userHits, maxPerUser));
        },
        fail(ip, username) {
            keys(ip, username).forEach(add);
        },
        success(ip, username) {
            buckets.delete(keys(ip, username)[1]);
        },
    };
}

module.exports = { createLoginLimiter };
