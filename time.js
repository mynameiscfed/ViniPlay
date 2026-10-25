// IANA time-zone helpers. A fixed hour offset cannot represent +05:30, +05:45 or DST.
const formatterCache = new Map();

function dateTimeFormat(timeZone) {
    if (!formatterCache.has(timeZone)) {
        formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23',
        }));
    }
    return formatterCache.get(timeZone);
}

function isValidTimeZone(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
    try {
        dateTimeFormat(timeZone);
        return true;
    } catch (e) {
        return false;
    }
}

function zoneParts(date, timeZone) {
    const parts = {};
    for (const part of dateTimeFormat(timeZone).formatToParts(date)) {
        if (part.type !== 'literal') parts[part.type] = part.value;
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

/** Offset of `timeZone` at `date`, in hours (can be fractional, negative or positive). */
function zoneOffsetHours(date, timeZone) {
    const p = zoneParts(date, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (asUtc - date.getTime()) / 3600000;
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC Date. `offsetHours` is the fallback
 * when the zone is missing or unknown (old settings files).
 */
function wallTimeToUtc(year, month, day, hour, minute, second, timeZone, offsetHours = 0) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    if (!isValidTimeZone(timeZone)) return new Date(wall - offsetHours * 3600000);

    let guess = wall;
    // Two passes settle normal offsets and the DST boundary; the third confirms.
    for (let i = 0; i < 3; i++) {
        const offset = zoneOffsetHours(new Date(guess), timeZone) * 3600000;
        const next = wall - offset;
        if (next === guess) break;
        guess = next;
    }
    return new Date(guess);
}

module.exports = { isValidTimeZone, zoneOffsetHours, wallTimeToUtc };
