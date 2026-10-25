const test = require('node:test');
const assert = require('node:assert');
const { createLoginLimiter } = require('../loginRateLimit');

test('blocks one user after the per-user limit and clears on success', () => {
    let now = 1000;
    const limiter = createLoginLimiter({ maxPerUser: 2, maxPerIp: 100, now: () => now });
    assert.equal(limiter.check('1.2.3.4', 'Bob'), 0);
    limiter.fail('1.2.3.4', 'Bob');
    limiter.fail('1.2.3.4', 'Bob');
    assert.ok(limiter.check('1.2.3.4', 'bob') > 0);
    limiter.success('1.2.3.4', 'Bob');
    assert.equal(limiter.check('1.2.3.4', 'Bob'), 0);
});

test('blocks an IP across different usernames', () => {
    let now = 1000;
    const limiter = createLoginLimiter({ maxPerUser: 100, maxPerIp: 2, now: () => now });
    limiter.fail('1.2.3.4', 'a');
    limiter.fail('1.2.3.4', 'b');
    assert.ok(limiter.check('1.2.3.4', 'c') > 0);
    assert.equal(limiter.check('5.6.7.8', 'c'), 0);
});

test('reports the remaining wait and expires it', () => {
    let now = 1000;
    const limiter = createLoginLimiter({ windowMs: 60_000, maxPerUser: 1, maxPerIp: 100, now: () => now });
    limiter.fail('1.2.3.4', 'a');
    assert.equal(limiter.check('1.2.3.4', 'a'), 60);
    now += 60_001;
    assert.equal(limiter.check('1.2.3.4', 'a'), 0);
});
