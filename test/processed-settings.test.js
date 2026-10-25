// A source refresh runs for minutes on a copy of the settings; saving must not undo edits made meanwhile.
const { test } = require('node:test');
const assert = require('node:assert');
const { applyProcessed } = require('../processedSettings');

const source = (id, extra = {}) => ({ id, path: `http://${id}`, isActive: true, name: id, ...extra });

test('applies processing results and keeps edits made while processing', () => {
    const processed = {
        m3uSources: [source('a', { status: 'Success', statusMessage: 'Processed 5', lastUpdated: 't1', cachedRawPath: '/raw/a' })],
        epgSources: [],
        sourcesLastUpdated: 't1',
    };
    const current = {
        m3uSources: [source('a', { name: 'renamed', status: 'Pending' }), source('b')], // renamed and a source added while processing
        epgSources: [source('e')],
        sourcesLastUpdated: 't0',
    };
    applyProcessed(current, processed);

    assert.deepStrictEqual(current.m3uSources[0], source('a', { name: 'renamed', status: 'Success', statusMessage: 'Processed 5', lastUpdated: 't1', cachedRawPath: '/raw/a' }));
    assert.deepStrictEqual(current.m3uSources[1], source('b'));
    assert.strictEqual(current.sourcesLastUpdated, 't1');
});

test('drops results for sources that were deleted, re-pointed or not processed', () => {
    const processed = {
        m3uSources: [source('gone', { status: 'Success' }), source('moved', { status: 'Success' }), source('off', { isActive: false, status: 'Success' })],
        epgSources: [],
        sourcesLastUpdated: 't1',
    };
    const current = {
        m3uSources: [source('moved', { path: 'http://new' }), source('off', { isActive: false })],
        epgSources: [],
    };
    applyProcessed(current, processed);

    assert.strictEqual(current.m3uSources[0].status, undefined);
    assert.strictEqual(current.m3uSources[1].status, undefined);
});

test('removes a cached raw path that processing removed', () => {
    const processed = { m3uSources: [source('a')], epgSources: [], sourcesLastUpdated: 't1' };
    const current = { m3uSources: [source('a', { cachedRawPath: '/raw/a' })], epgSources: [] };
    applyProcessed(current, processed);
    assert.strictEqual('cachedRawPath' in current.m3uSources[0], false);
});
