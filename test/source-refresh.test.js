const { test } = require('node:test');
const assert = require('node:assert');
const { planSourceRefreshes } = require('../sourceRefresh');

const src = (id, type, refreshHours, extra = {}) => ({ id, name: id, type, isActive: true, refreshHours, ...extra });

test('a URL source refreshes only itself', () => {
    const plan = planSourceRefreshes({ m3uSources: [src('a', 'url', 6)], epgSources: [] });
    assert.deepStrictEqual(plan, [{ id: 'a', name: 'a', hours: 6, onlyIds: ['a'] }]);
});

test('an XC source refreshes itself and its managed guide; the guide is not scheduled twice', () => {
    const plan = planSourceRefreshes({
        m3uSources: [src('xc', 'xc', 12)],
        epgSources: [src('epg_for_xc', 'url', 12), src('custom-epg', 'url', 24)],
    });
    assert.deepStrictEqual(plan, [
        { id: 'xc', name: 'xc', hours: 12, onlyIds: ['xc', 'epg_for_xc'] },
        { id: 'custom-epg', name: 'custom-epg', hours: 24, onlyIds: ['custom-epg'] },
    ]);
});

test('inactive sources, file sources and disabled intervals are not scheduled', () => {
    const plan = planSourceRefreshes({
        m3uSources: [
            src('off', 'url', 6, { isActive: false }),
            src('file', 'file', 6),
            src('zero', 'url', 0),
            src('bad', 'url', null),
        ],
        epgSources: [src('epg-off', 'url', 6, { isActive: false })],
    });
    assert.deepStrictEqual(plan, []);
});
