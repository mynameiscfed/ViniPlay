const { test } = require('node:test');
const assert = require('node:assert');
const { parseEpgTime } = require('../epgTime');
const { zoneOffsetHours, wallTimeToUtc, isValidTimeZone } = require('../time');

test('explicit XMLTV offsets keep working', () => {
    assert.strictEqual(parseEpgTime('20260101120000 +0000').toISOString(), '2026-01-01T12:00:00.000Z');
    assert.strictEqual(parseEpgTime('20260101120000 -0500').toISOString(), '2026-01-01T17:00:00.000Z');
});

test('a half-hour zone is interpreted correctly when the XMLTV offset is missing', () => {
    const result = parseEpgTime('20260101120000', { timeZone: 'Asia/Kolkata' });
    assert.strictEqual(result.toISOString(), '2026-01-01T06:30:00.000Z');
});

test('DST changes the offset for a zone across the year', () => {
    const winter = parseEpgTime('20260101120000', { timeZone: 'America/New_York' });
    const summer = parseEpgTime('20260701120000', { timeZone: 'America/New_York' });
    assert.strictEqual(winter.toISOString(), '2026-01-01T17:00:00.000Z');
    assert.strictEqual(summer.toISOString(), '2026-07-01T16:00:00.000Z');
});

test('the fixed offset remains the fallback for an unknown zone', () => {
    assert.strictEqual(parseEpgTime('20260101120000', { timeZone: 'Not/AZone', offsetHours: -5 }).toISOString(), '2026-01-01T17:00:00.000Z');
    assert.strictEqual(isValidTimeZone('Not/AZone'), false);
    assert.strictEqual(zoneOffsetHours(new Date('2026-01-01T00:00:00Z'), 'UTC'), 0);
    assert.strictEqual(wallTimeToUtc(2026, 1, 1, 12, 0, 0, 'UTC').toISOString(), '2026-01-01T12:00:00.000Z');
});
