// Validation for DVR start/end values coming from HTTP clients.
// Express 4 does not forward rejected async handlers, so a bad date used to reach
// Date.toISOString() and throw a RangeError that killed the process.

function parseDate(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : null;
}

function validateJobWindow(startValue, endValue, { startLabel = 'startTime', endLabel = 'endTime' } = {}) {
    const start = parseDate(startValue);
    if (!start) return { ok: false, error: `${startLabel} must be a valid date.` };
    const end = parseDate(endValue);
    if (!end) return { ok: false, error: `${endLabel} must be a valid date.` };
    if (end.getTime() <= start.getTime()) {
        return { ok: false, error: `${endLabel} must be after ${startLabel}.` };
    }
    return { ok: true, start, end };
}

module.exports = { validateJobWindow };
