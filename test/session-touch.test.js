// The session store should be touched at most once per interval per session.
const { test } = require('node:test');
const assert = require('node:assert');
const { throttleSessionTouch } = require('../sessionTouch');

function fakeStore() {
    const calls = { touch: [], destroy: [] };
    return {
        calls,
        touch(sid, session, cb) { calls.touch.push(sid); if (cb) cb(); },
        destroy(sid, cb) { calls.destroy.push(sid); if (cb) cb(); },
    };
}

test('touches the store once per interval and still calls back every time', () => {
    const store = throttleSessionTouch(fakeStore(), 60 * 60 * 1000);
    let callbacks = 0;
    for (let i = 0; i < 5; i++) store.touch('sid-a', {}, () => callbacks++);
    store.touch('sid-b', {}, () => callbacks++);
    assert.deepStrictEqual(store.calls.touch, ['sid-a', 'sid-b']);
    assert.strictEqual(callbacks, 6);
});

test('touches again after the interval has passed', async () => {
    const store = throttleSessionTouch(fakeStore(), 20);
    store.touch('sid-a', {}, () => {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.touch('sid-a', {}, () => {});
    assert.deepStrictEqual(store.calls.touch, ['sid-a', 'sid-a']);
});

test('destroying a session clears its throttle entry', () => {
    const store = throttleSessionTouch(fakeStore(), 60 * 60 * 1000);
    store.touch('sid-a', {}, () => {});
    store.destroy('sid-a', () => {});
    store.touch('sid-a', {}, () => {});
    assert.deepStrictEqual(store.calls.touch, ['sid-a', 'sid-a']);
    assert.deepStrictEqual(store.calls.destroy, ['sid-a']);
});

test('works when express-session passes no callback', () => {
    const store = throttleSessionTouch(fakeStore(), 60 * 60 * 1000);
    store.touch('sid-a', {});
    assert.doesNotThrow(() => store.touch('sid-a', {}));
});
