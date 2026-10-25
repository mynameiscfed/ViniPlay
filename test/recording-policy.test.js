const { test } = require('node:test');
const assert = require('node:assert');
const {
    normalizeDvrSettings,
    normalizeDownloadsSettings,
    normalizeLiveRewindSettings,
    validateRecordingWindow,
    countOverlappingJobs,
    matchingSeriesPrograms,
    isRecordingFileUsable,
    sanitizeDownloadFilename,
    liveBufferSegmentCount,
} = require('../recordingPolicy');

test('DVR settings are clamped', () => {
    const dvr = normalizeDvrSettings({
        preBufferMinutes: -5,
        postBufferMinutes: 999,
        maxConcurrentRecordings: 0,
        minFreeDiskMb: 'nope',
    });
    assert.strictEqual(dvr.preBufferMinutes, 0);
    assert.strictEqual(dvr.postBufferMinutes, 120);
    assert.strictEqual(dvr.maxConcurrentRecordings, 1);
    assert.strictEqual(dvr.minFreeDiskMb, 5120);
});

test('download and rewind settings have safe defaults', () => {
    assert.deepStrictEqual(normalizeDownloadsSettings({}), { enabled: true, maxConcurrent: 2 });
    assert.deepStrictEqual(normalizeLiveRewindSettings({ enabled: 'yes', minutes: 12 }), {
        enabled: false,
        minutes: 15,
        diskCapMb: 4096,
    });
});

test('recording windows reject bad dates and overlong jobs', () => {
    assert.strictEqual(validateRecordingWindow('nope', '2026-01-01T01:00:00Z').ok, false);
    assert.strictEqual(validateRecordingWindow('2026-01-01T01:00:00Z', '2026-01-01T00:00:00Z').ok, false);
    assert.strictEqual(validateRecordingWindow('2026-01-01T00:00:00Z', '2026-01-01T03:00:00Z', 2).ok, false);
    assert.strictEqual(validateRecordingWindow('2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z', 2).ok, true);
});

test('conflict counting includes active jobs and other users', () => {
    const jobs = [
        { id: 1, startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T01:00:00Z' },
        { id: 2, startTime: '2026-01-01T00:30:00Z', endTime: '2026-01-01T02:00:00Z' },
        { id: 3, startTime: '2026-01-01T03:00:00Z', endTime: '2026-01-01T04:00:00Z' },
    ];
    assert.strictEqual(countOverlappingJobs(jobs, {
        startTime: '2026-01-01T00:45:00Z',
        endTime: '2026-01-01T01:15:00Z',
    }), 2);
    assert.strictEqual(countOverlappingJobs(jobs, {
        id: 2,
        startTime: '2026-01-01T00:30:00Z',
        endTime: '2026-01-01T02:00:00Z',
    }), 1);
});

test('series rules match the exact title in the future only', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const programs = [
        { title: 'Daily News', start: '2026-01-01T20:00:00Z', stop: '2026-01-01T21:00:00Z' },
        { title: 'Daily News', start: '2025-12-31T20:00:00Z', stop: '2025-12-31T21:00:00Z' },
        { title: 'Daily News Extra', start: '2026-01-02T20:00:00Z', stop: '2026-01-02T21:00:00Z' },
    ];
    const matches = matchingSeriesPrograms({ programTitle: 'Daily News' }, programs, now);
    assert.deepStrictEqual(matches.map(p => p.start), ['2026-01-01T20:00:00Z']);
});

test('short but valid recordings are kept', () => {
    assert.strictEqual(isRecordingFileUsable(8 * 1024, 30), false);
    assert.strictEqual(isRecordingFileUsable(20 * 1024, 12), true);
    assert.strictEqual(isRecordingFileUsable(20 * 1024, 0), false);
});

test('download filenames are safe', () => {
    assert.strictEqual(sanitizeDownloadFilename('AC/DC: Live?', 'mp4'), 'AC_DC_ Live_.mp4');
    assert.strictEqual(sanitizeDownloadFilename('..', ''), 'download');
    assert.strictEqual(sanitizeDownloadFilename('Episode 1', '.mkv'), 'Episode 1.mkv');
});

test('live buffer keeps enough segments for the requested window', () => {
    assert.strictEqual(liveBufferSegmentCount(15), 225);
    assert.strictEqual(liveBufferSegmentCount(0), 10);
});
