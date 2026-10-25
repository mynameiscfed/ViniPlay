const { test } = require('node:test');
const assert = require('node:assert');
const { overlaps, findConflictingJobs } = require('../dvrConflict');

const job = (id, status, startTime, endTime) => ({ id, status, startTime, endTime });
const jobs = [
    job(1, 'scheduled', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'),
    job(2, 'recording', '2026-01-01T10:30:00Z', '2026-01-01T11:30:00Z'),
    job(3, 'reconnecting', '2026-01-01T12:00:00Z', '2026-01-01T13:00:00Z'),
    job(4, 'completed', '2026-01-01T10:00:00Z', '2026-01-01T13:00:00Z'),
    job(5, 'cancelled', '2026-01-01T10:00:00Z', '2026-01-01T13:00:00Z'),
];

test('only overlapping scheduled, recording and reconnecting jobs count', () => {
    const start = Date.parse('2026-01-01T10:15:00Z');
    const end = Date.parse('2026-01-01T10:45:00Z');
    assert.strictEqual(overlaps(start, end, jobs[0]), true);
    assert.strictEqual(overlaps(start, end, jobs[3]), true); // helper is status-agnostic
    assert.deepStrictEqual(findConflictingJobs(jobs, start, end).map((j) => j.id), [1, 2]);
});

test('a job being edited does not conflict with itself', () => {
    const start = Date.parse('2026-01-01T10:40:00Z');
    const end = Date.parse('2026-01-01T10:50:00Z');
    assert.deepStrictEqual(findConflictingJobs(jobs, start, end, 1).map((j) => j.id), [2]);
});

test('touching windows and invalid dates do not conflict', () => {
    const atThirteen = Date.parse('2026-01-01T13:00:00Z');
    assert.deepStrictEqual(findConflictingJobs(jobs, atThirteen, Date.parse('2026-01-01T13:10:00Z')), []);
    assert.deepStrictEqual(findConflictingJobs([job(9, 'scheduled', 'bad', 'bad')], atThirteen, atThirteen + 1000), []);
});
