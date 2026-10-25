/**
 * utils.js
 * * Contains generic helper and utility functions, like parsers.
 */

import { guideState } from './state.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes a value for safe insertion into HTML text or a quoted attribute.
 * Use for every provider-supplied string (channel names, logos, programme titles,
 * descriptions, URLs) that ends up in an innerHTML template.
 * @param {*} value - Any value; null/undefined become an empty string.
 * @returns {string}
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * Parses M3U playlist data into a structured array of channel objects.
 * @param {string} data - The raw M3U content as a string.
 * @returns {Array<object>} - An array of channel objects.
 */
const PLAYLIST_URL = /^(?:https?|rtmps?|rtsps?|rtp|udp|srt|mms|mmsh):\/\//i;

const displayNameFromExtinf = (line) => {
    const lastQuote = line.lastIndexOf('"');
    const delimiter = lastQuote >= 0 ? line.indexOf(',', lastQuote + 1) : line.indexOf(',');
    return delimiter >= 0 ? line.slice(delimiter + 1).trim() : 'Unknown';
};

export function parseM3U(data) {
    if (!data) return [];
    const lines = data.split('\n');
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXTINF:')) continue;
        const nextLine = lines[i + 1]?.trim();
        if (!nextLine || !PLAYLIST_URL.test(nextLine)) continue;

        const idMatch = line.match(/tvg-id="([^"]*)"/);
        const logoMatch = line.match(/tvg-logo="([^"]*)"/);
        const nameMatch = line.match(/tvg-name="([^"]*)"/);
        const groupMatch = line.match(/group-title="([^"]*)"/);
        const chnoMatch = line.match(/tvg-chno="([^"]*)"/);
        const sourceMatch = line.match(/vini-source="([^"]*)"/);
        const displayName = displayNameFromExtinf(line);

        channels.push({
            id: idMatch ? idMatch[1] : `unknown-${Math.random()}`,
            logo: logoMatch ? logoMatch[1] : '',
            name: nameMatch ? nameMatch[1] : displayName,
            group: groupMatch ? groupMatch[1] : 'Uncategorized',
            chno: chnoMatch ? chnoMatch[1] : null,
            source: sourceMatch ? sourceMatch[1] : 'Default',
            displayName,
            url: nextLine,
        });
        i++; // Skip the URL line in the next iteration
    }
    return channels;
}

/**
 * NEW: Formats a date object to a time string with a specified UTC offset.
 * @param {Date} date - The date object to format.
 * @param {number} offsetHours - The timezone offset in hours (e.g., -5 for EST).
 * @returns {string} The formatted time string (e.g., "14:30").
 */
export function formatTimeWithOffset(date, offsetHours = 0) {
    if (!(date instanceof Date)) {
        date = new Date(date);
    }

    // Apply the user's desired offset directly to the input timestamp
    // This assumes the input date is already in the correct base time (typically UTC)
    const adjustedTime = new Date(date.getTime() + (offsetHours * 3600000));

    // Use UTC methods for consistent, device-independent formatting
    // This ensures identical results regardless of viewport size, browser, or device locale
    const hours = adjustedTime.getUTCHours().toString().padStart(2, '0');
    const minutes = adjustedTime.getUTCMinutes().toString().padStart(2, '0');

    return `${hours}:${minutes}`;
}


/** The programme on now and the one after it for a channel. */
export const nowNext = (channelId, nowMs = Date.now()) => {
    const list = guideState.programs[channelId] || [];
    const i = list.findIndex(p => new Date(p.stop) > nowMs);
    if (i < 0) return {};
    return new Date(list[i].start) <= nowMs ? { now: list[i], next: list[i + 1] } : { next: list[i] };
};
