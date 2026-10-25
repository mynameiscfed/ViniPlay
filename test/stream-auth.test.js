const { test } = require('node:test');
const assert = require('node:assert');
const { isLocalAddress, resolveStreamIdentity } = require('../streamAuth');

test('private LAN and loopback addresses are local; public and IPv6 global are not', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.5', '10.2.3.4', '172.16.0.1', '172.31.255.255']) {
        assert.strictEqual(isLocalAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '::ffff:8.8.8.8', '2001:db8::1', '']) {
        assert.strictEqual(isLocalAddress(ip), false, ip);
    }
});

test('a local request gets a stream identity but does not get written into the session', () => {
    const session = {};
    const req = { session, ip: '192.168.1.9', headers: {}, query: {}, socket: {} };
    const identity = resolveStreamIdentity(req, { castTokens: new Map(), trustProxy: false });

    assert.deepStrictEqual(identity, { ok: true, userId: null, username: 'Local Network', localAccess: true });
    assert.deepStrictEqual(session, {});
});

test('an authenticated session keeps its user identity', () => {
    const identity = resolveStreamIdentity({ session: { userId: 7, username: 'alice' }, ip: '8.8.8.8', headers: {}, query: {}, socket: {} }, {
        castTokens: new Map(),
        trustProxy: false,
    });
    assert.strictEqual(identity.ok, true);
    assert.strictEqual(identity.userId, 7);
    assert.strictEqual(identity.username, 'alice');
    assert.strictEqual(identity.localAccess, false);
});

test('a cast token is one-time and carries the casting user', () => {
    const castTokens = new Map([['token-1', { userId: 3, expiresAt: Date.now() + 60000 }]]);
    const req = { session: {}, ip: '8.8.8.8', headers: {}, query: { castToken: 'token-1' }, socket: {} };

    const first = resolveStreamIdentity(req, { castTokens, trustProxy: false });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.userId, 3);
    assert.strictEqual(castTokens.has('token-1'), false);

    const second = resolveStreamIdentity(req, { castTokens, trustProxy: false });
    assert.strictEqual(second.ok, false);
    assert.match(second.message, /Invalid cast token/);
});

test('forwarded headers without a trusted proxy and public clients are rejected', () => {
    const forwarded = resolveStreamIdentity({ session: {}, ip: '192.168.1.9', headers: { 'x-forwarded-for': '8.8.8.8' }, query: {}, socket: {} }, {
        castTokens: new Map(),
        trustProxy: false,
    });
    assert.strictEqual(forwarded.ok, false);
    assert.strictEqual(forwarded.status, 401);

    const remote = resolveStreamIdentity({ session: {}, ip: '8.8.8.8', headers: {}, query: {}, socket: {} }, {
        castTokens: new Map(),
        trustProxy: true,
    });
    assert.strictEqual(remote.ok, false);
    assert.strictEqual(remote.status, 401);
});
