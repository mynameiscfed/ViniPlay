// sessionTouch.js
// express-session calls store.touch() on every request that carries an unmodified
// session, and connect-sqlite3 implements touch as an UPDATE, so every API call (including
// heartbeats and progress saves) used to cost a disk write just to push the expiry out.
// The cookie lives for 30 days, so extending it at most once per interval is plenty.

const DEFAULT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function throttleSessionTouch(store, intervalMs = DEFAULT_TOUCH_INTERVAL_MS) {
    const lastTouch = new Map(); // sid -> timestamp of the last touch that reached the store
    const originalTouch = store.touch.bind(store);
    const originalDestroy = store.destroy.bind(store);

    store.touch = (sid, session, callback) => {
        const now = Date.now();
        const last = lastTouch.get(sid);
        if (last !== undefined && now - last < intervalMs) {
            if (callback) callback();
            return undefined;
        }
        lastTouch.set(sid, now);
        return originalTouch(sid, session, callback);
    };

    store.destroy = (sid, callback) => {
        lastTouch.delete(sid);
        return originalDestroy(sid, callback);
    };

    // Forget sessions that have not been seen for a while so the map cannot grow forever.
    const sweeper = setInterval(() => {
        const cutoff = Date.now() - intervalMs;
        for (const [sid, timestamp] of lastTouch) {
            if (timestamp < cutoff) lastTouch.delete(sid);
        }
    }, intervalMs);
    if (sweeper.unref) sweeper.unref();

    return store;
}

module.exports = { throttleSessionTouch, DEFAULT_TOUCH_INTERVAL_MS };
