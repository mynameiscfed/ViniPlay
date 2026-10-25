// XMLTV times use YYYYMMDDHHMMSS +HHMM. When the suffix is missing, interpret the
// wall clock in the configured guide zone (IANA when available, fixed offset otherwise).
const { wallTimeToUtc } = require('./time');

function parseEpgTime(timeStr, { timeZone = null, offsetHours = 0 } = {}) {
    const match = String(timeStr || '').match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(([+-])(\d{2})(\d{2}))?/);
    if (!match) {
        console.warn(`[EPG_PARSE] Invalid time format encountered: ${timeStr}`);
        return new Date();
    }

    const [, year, month, day, hours, minutes, seconds, , sign, tzHours, tzMinutes] = match;
    if (sign && tzHours && tzMinutes) {
        const epgOffsetMinutes = (parseInt(tzHours, 10) * 60 + parseInt(tzMinutes, 10)) * (sign === '+' ? 1 : -1);
        const date = new Date(Date.UTC(year, parseInt(month, 10) - 1, day, hours, minutes, seconds));
        date.setUTCMinutes(date.getUTCMinutes() - epgOffsetMinutes);
        return date;
    }

    return wallTimeToUtc(
        parseInt(year, 10), parseInt(month, 10), parseInt(day, 10),
        parseInt(hours, 10), parseInt(minutes, 10), parseInt(seconds, 10),
        timeZone, offsetHours,
    );
}

module.exports = { parseEpgTime };
