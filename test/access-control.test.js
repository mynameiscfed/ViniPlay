const { test } = require('node:test');
const assert = require('node:assert');
const { parseAllowedSources, allowedSourcesFromUser, channelSourceId, isChannelAllowed } = require('../accessControl');

const channel = { id: 'src-1_news', group: 'News' };

test('admins get full access, missing users and empty whitelists get none', () => {
    assert.strictEqual(allowedSourcesFromUser({ isAdmin: 1 }), null);
    assert.deepStrictEqual(allowedSourcesFromUser(null), {});
    assert.deepStrictEqual(parseAllowedSources(null), null);
    assert.deepStrictEqual(parseAllowedSources(''), {});
    assert.deepStrictEqual(parseAllowedSources('{bad json'), {});
    assert.deepStrictEqual(parseAllowedSources('{}'), {});
    assert.deepStrictEqual(parseAllowedSources('[]'), {});
});

test('channel ids identify their source', () => {
    assert.strictEqual(channelSourceId('src-1_news'), 'src-1');
    assert.strictEqual(channelSourceId('no-underscore'), null);
    assert.strictEqual(channelSourceId(null), null);
});

test('a source must be allowed, and its group whitelist must include the channel', () => {
    const full = { 'src-1': { allowed: true, groups: [] } };
    const kids = { 'src-1': { allowed: true, groups: ['Kids'] } };
    const blocked = { 'src-1': { allowed: false, groups: [] } };

    assert.strictEqual(isChannelAllowed(channel, null), true);
    assert.strictEqual(isChannelAllowed(channel, full), true);
    assert.strictEqual(isChannelAllowed(channel, kids), false);
    assert.strictEqual(isChannelAllowed(channel, blocked), false);
    assert.strictEqual(isChannelAllowed(channel, {}), false);
    assert.strictEqual(isChannelAllowed({ id: 'src-1_kids', group: 'Kids' }, kids), true);
});

test('a user row with allowed_sources resolves to the same rules as the guide', () => {
    const user = { isAdmin: 0, allowed_sources: JSON.stringify({ 'src-1': { allowed: true, groups: ['News'] } }) };
    const allowed = allowedSourcesFromUser(user);
    assert.strictEqual(isChannelAllowed(channel, allowed), true);
    assert.strictEqual(isChannelAllowed({ id: 'src-1_sport', group: 'Sports' }, allowed), false);
    assert.strictEqual(isChannelAllowed({ id: 'src-2_news', group: 'News' }, allowed), false);
});
