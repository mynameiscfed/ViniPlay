// Guide time helpers. The configured IANA zone makes half-hour offsets and DST work;
// timezoneOffset stays as the fallback for old settings files.

const formatterCache = new Map();
const pad = (value) => String(value).padStart(2, '0');

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

export function isValidTimeZone(timeZone) {
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

export function zoneOffsetHours(date, timeZone) {
    const p = zoneParts(date, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (asUtc - date.getTime()) / 3600000;
}

function wallTimeToUtc(year, month, day, hour, minute, second, timeZone, offsetHours) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    if (!isValidTimeZone(timeZone)) return new Date(wall - offsetHours * 3600000);
    let guess = wall;
    for (let i = 0; i < 3; i++) {
        const offset = zoneOffsetHours(new Date(guess), timeZone) * 3600000;
        const next = wall - offset;
        if (next === guess) break;
        guess = next;
    }
    return new Date(guess);
}

function withOffset(date, offsetHours) {
    const adjusted = new Date(date.getTime() + offsetHours * 3600000);
    return `${pad(adjusted.getUTCHours())}:${pad(adjusted.getUTCMinutes())}`;
}

export function formatTimeInZone(date, timeZone, offsetHours = 0) {
    const value = date instanceof Date ? date : new Date(date);
    if (isValidTimeZone(timeZone)) {
        return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);
    }
    return withOffset(value, offsetHours);
}

export function formatDateInZone(date, timeZone) {
    const value = date instanceof Date ? date : new Date(date);
    if (isValidTimeZone(timeZone)) {
        const p = zoneParts(value, timeZone);
        return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    }
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** UTC instant of local midnight on the selected guide date (a calendar date). */
export function zoneDayStartUtc(selectedDate, timeZone, offsetHours = 0) {
    return wallTimeToUtc(
        selectedDate.getFullYear(), selectedDate.getMonth() + 1, selectedDate.getDate(),
        0, 0, 0, timeZone, offsetHours,
    );
}

/** Day identity in the guide zone, so "Tomorrow" does not shift at midnight UTC. */
export function dayKeyInZone(date, timeZone) {
    return formatDateInZone(date, timeZone);
}
