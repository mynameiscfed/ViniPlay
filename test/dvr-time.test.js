const { test } = require('node:test');
const assert = require('node:assert');
const { validateJobWindow } = require('../dvrTime');

test('a valid window is accepted and normalized', () => {
    const result = validateJobWindow('2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.start.toISOString(), '2026-01-01T10:00:00.000Z');
    assert.strictEqual(result.end.toISOString(), '2026-01-01T11:00:00.000Z');
});

test('invalid, empty and missing dates are rejected instead of throwing', () => {
    for (const value of ['not-a-date', '', null, undefined, '   ']) {
        const result = validateJobWindow(value, '2026-01-01T11:00:00Z');
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /startTime must be a valid date/);
    }
    const result = validateJobWindow('2026-01-01T10:00:00Z', 'not-a-date');
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /endTime must be a valid date/);
});

test('an end at or before the start is rejected', () => {
    for (const end of ['2026-01-01T10:00:00Z', '2026-01-01T09:59:59Z']) {
        const result = validateJobWindow('2026-01-01T10:00:00Z', end);
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /endTime must be after startTime/);
    }
});

test('custom labels are used in endpoint errors', () => {
    const result = validateJobWindow('bad', '2026-01-01T11:00:00Z', { startLabel: 'programStart', endLabel: 'programStop' });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /programStart must be a valid date/);
});
