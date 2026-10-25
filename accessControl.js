// Source/group access rules shared by the guide and DVR. Channel ids are built as
// "<sourceId>_<tvg-id>", so the prefix identifies the provider the channel came from.

function parseAllowedSources(value) {
    if (value === null || value === undefined) return null; // column never set: legacy full access
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) return parsed;
        return {}; // an empty or corrupt whitelist means no sources
    } catch (e) {
        return {};
    }
}

/** null = full access, {} = no sources, otherwise sourceId -> { allowed, groups }. */
function allowedSourcesFromUser(user) {
    if (!user) return {};
    if (user.isAdmin === 1 || user.isAdmin === true) return null;
    return parseAllowedSources(user.allowed_sources);
}

function channelSourceId(channelId) {
    const value = String(channelId ?? '');
    const underscore = value.indexOf('_');
    return underscore > 0 ? value.slice(0, underscore) : null;
}

function isChannelAllowed(channel, allowedSources) {
    if (!allowedSources) return true;
    const sourceId = channelSourceId(channel && channel.id);
    if (!sourceId) return false;
    const permission = allowedSources[sourceId];
    if (!permission || !permission.allowed) return false;
    const groups = permission.groups || [];
    return groups.length === 0 || groups.includes((channel && channel.group) || 'Uncategorized');
}

module.exports = { parseAllowedSources, allowedSourcesFromUser, channelSourceId, isChannelAllowed };
