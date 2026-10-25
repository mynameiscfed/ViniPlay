const test = require('node:test');
const assert = require('node:assert');
const { assertSafeStreamUrl, alwaysBlockedReason } = require('../ssrfGuard');

test('blocks the server itself and cloud metadata addresses', () => {
    for (const url of [
        'http://127.0.0.1:8998/api/users',
        'http://localhost:8998/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/',
        'http://[fe80::1]/',
        'http://0.0.0.0/',
        'http://metadata.google.internal/',
    ]) {
        assert.throws(() => assertSafeStreamUrl(url), /Refusing|Invalid/, url);
    }
});

test('allows private LAN sources and public hosts', () => {
    for (const url of [
        'http://192.168.1.20:8080/playlist.m3u',
        'http://10.0.0.5/live',
        'https://example.com/stream.m3u8',
        'udp://239.0.0.1:5000',
    ]) {
        assert.doesNotThrow(() => assertSafeStreamUrl(url), url);
    }
});

test('blocks URLs without a host', () => {
    assert.throws(() => assertSafeStreamUrl('file:///etc/passwd'), /no host/);
});

test('alwaysBlockedReason maps IPv4-in-IPv6 loopback', () => {
    assert.match(alwaysBlockedReason('::ffff:127.0.0.1'), /loopback/);
    assert.equal(alwaysBlockedReason('192.168.1.10'), null);
});
