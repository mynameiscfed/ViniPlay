// A recording window conflicts when it overlaps another job that will still use a tuner:
// scheduled, currently recording, or reconnecting. Keep this pure so the cap and the
// edit path can be tested without a database.

const ACTIVE_STATUSES = new Set(['scheduled', 'recording', 'reconnecting']);

function overlaps(newStart, newEnd, job) {
    const start = Date.parse(job.startTime);
    const end = Date.parse(job.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return newStart < end && newEnd > start;
}

/** Jobs that overlap the new window, excluding the job currently being edited. */
function findConflictingJobs(jobs, newStart, newEnd, excludeJobId = null) {
    return (jobs || []).filter((job) => {
        if (!ACTIVE_STATUSES.has(job.status)) return false;
        if (excludeJobId !== null && String(job.id) === String(excludeJobId)) return false;
        return overlaps(newStart, newEnd, job);
    });
}

module.exports = { ACTIVE_STATUSES, overlaps, findConflictingJobs };
