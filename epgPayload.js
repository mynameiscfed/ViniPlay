// epgPayload.js
// /api/config used to read and JSON.parse the whole EPG file, filter it for restricted users and
// serialize it again on every request, all synchronously. The response only needs the EPG as JSON text,
// so keep that text per permission set until the file changes. Only strings are kept, never the parsed
// object (a large guide takes several times its file size as objects).

const MAX_ENTRIES = 8; // restricted users with different permissions each cost one filtered copy

// EPG channel ids look like "<sourceId>_<channel>". Restricted users get the channels of their allowed sources.
// Groups cannot be applied here: the M3U they get is already filtered by group, which hides the other channels.
function filterEpg(epg, allowedSources) {
    const filtered = {};
    for (const channelId in epg) {
        const underscore = channelId.indexOf('_');
        if (underscore !== -1 && allowedSources[channelId.substring(0, underscore)]?.allowed) filtered[channelId] = epg[channelId];
    }
    return filtered;
}

/** @param {() => string|undefined} readText Returns the EPG file's text (the same string until the file changes), undefined if there is none. */
function createEpgPayload(readText) {
    let text;
    let byPermissions = new Map();

    /** @returns {string|undefined} EPG JSON for a user limited to `allowedSources` (null = everything). */
    return (allowedSources) => {
        const current = readText();
        if (current === undefined) return undefined;
        if (current !== text) {
            text = current;
            byPermissions = new Map();
        }
        const key = allowedSources ? JSON.stringify(allowedSources) : '';
        if (!byPermissions.has(key)) {
            let json;
            try {
                const epg = JSON.parse(text); // also checks the file: a damaged guide must not break the whole response
                json = allowedSources ? JSON.stringify(filterEpg(epg, allowedSources)) : text;
            } catch (e) {
                console.error(`[API] Error parsing merged EPG JSON: ${e.message}`);
                json = '{}';
            }
            if (byPermissions.size >= MAX_ENTRIES) byPermissions.delete(byPermissions.keys().next().value);
            byPermissions.set(key, json);
        }
        return byPermissions.get(key);
    };
}

module.exports = { createEpgPayload };
