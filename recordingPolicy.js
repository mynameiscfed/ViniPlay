// Pure policy helpers shared by the DVR, download and live-rewind code.
// Keeping these out of server.js makes the failure-prone parts testable.

const MIN_RECORDING_BYTES = 16 * 1024;

function clampInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = min } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function normalizeDvrSettings(dvr = {}) {
    return {
        ...dvr,
        preBufferMinutes: clampInt(dvr.preBufferMinutes, { min: 0, max: 120, fallback: 1 }),
        postBufferMinutes: clampInt(dvr.postBufferMinutes, { min: 0, max: 120, fallback: 2 }),
        maxConcurrentRecordings: clampInt(dvr.maxConcurrentRecordings, { min: 1, max: 16, fallback: 1 }),
        autoDeleteDays: clampInt(dvr.autoDeleteDays, { min: 0, max: 3650, fallback: 0 }),
        minFreeDiskMb: clampInt(dvr.minFreeDiskMb, { min: 0, max: 1024 * 1024, fallback: 5120 }),
        maxRecordingHours: clampInt(dvr.maxRecordingHours, { min: 0, max: 48, fallback: 0 }),
        retainNewestGb: clampInt(dvr.retainNewestGb, { min: 0, max: 100000, fallback: 0 }),
    };
}

function normalizeDownloadsSettings(downloads = {}) {
    return {
        ...downloads,
        enabled: downloads.enabled !== false,
        maxConcurrent: clampInt(downloads.maxConcurrent, { min: 1, max: 8, fallback: 2 }),
    };
}

function normalizeLiveRewindSettings(liveRewind = {}) {
    const minutes = clampInt(liveRewind.minutes, { min: 5, max: 60, fallback: 15 });
    return {
        ...liveRewind,
        enabled: liveRewind.enabled === true,
        minutes: [5, 15, 30, 60].includes(minutes) ? minutes : 15,
        diskCapMb: clampInt(liveRewind.diskCapMb, { min: 256, max: 1024 * 1024, fallback: 4096 }),
    };
}

function validateRecordingWindow(start, end, maxHours = 0) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return { ok: false, error: 'Start and end must be valid dates.' };
    }
    if (endMs <= startMs) {
        return { ok: false, error: 'End time must be after the start time.' };
    }
    if (maxHours > 0 && endMs - startMs > maxHours * 60 * 60 * 1000) {
        return { ok: false, error: `Recording is longer than the ${maxHours} hour limit.` };
    }
    return { ok: true, startMs, endMs };
}

function overlappingJobs(jobs, newJob) {
    const startMs = Date.parse(newJob.startTime);
    const endMs = Date.parse(newJob.endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    return (jobs || []).filter((job) => {
        if (newJob.id !== undefined && String(job.id) === String(newJob.id)) return false;
        const jobStart = Date.parse(job.startTime);
        const jobEnd = Date.parse(job.endTime);
        return Number.isFinite(jobStart) && Number.isFinite(jobEnd) && startMs < jobEnd && endMs > jobStart;
    });
}

function countOverlappingJobs(jobs, newJob) {
    return overlappingJobs(jobs, newJob).length;
}

function matchingSeriesPrograms(rule, programs, now = Date.now(), horizon = now + 7 * 24 * 60 * 60 * 1000) {
    const title = String(rule?.programTitle || '').trim();
    return (programs || []).filter((program) => {
        const startMs = Date.parse(program.start);
        const stopMs = Date.parse(program.stop);
        return String(program.title || '').trim() === title &&
            Number.isFinite(startMs) && Number.isFinite(stopMs) &&
            stopMs > now && startMs < horizon;
    });
}

function isRecordingFileUsable(sizeBytes, durationSeconds) {
    const size = Number(sizeBytes) || 0;
    if (size <= MIN_RECORDING_BYTES) return false;
    if (durationSeconds === null || durationSeconds === undefined) return true;
    return Number(durationSeconds) > 0;
}

function sanitizeDownloadFilename(name, extension = '') {
    const safeName = String(name || 'download')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, 180) || 'download';
    const ext = String(extension || '').replace(/[^a-z0-9.]/gi, '');
    return ext && !safeName.toLowerCase().endsWith(ext.toLowerCase()) ? `${safeName}${ext.startsWith('.') ? ext : `.${ext}`}` : safeName;
}

function liveBufferSegmentCount(minutes) {
    const value = Number(minutes);
    const safeMinutes = Number.isFinite(value) ? value : 15;
    return Math.max(10, Math.ceil(safeMinutes * 60 / 4));
}

module.exports = {
    MIN_RECORDING_BYTES,
    clampInt,
    normalizeDvrSettings,
    normalizeDownloadsSettings,
    normalizeLiveRewindSettings,
    validateRecordingWindow,
    overlappingJobs,
    countOverlappingJobs,
    matchingSeriesPrograms,
    isRecordingFileUsable,
    sanitizeDownloadFilename,
    liveBufferSegmentCount,
};
