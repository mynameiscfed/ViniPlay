// Schemes FFmpeg can read. Playlist import and /stream must agree: a channel that the
// importer accepts but the player rejects (or the reverse) looks like a missing channel.
const ALLOWED_STREAM_PROTOCOLS = ['http:', 'https:', 'rtmp:', 'rtmps:', 'rtsp:', 'rtsps:', 'rtp:', 'udp:', 'srt:', 'mms:', 'mmsh:'];

const PLAYLIST_URL = /^(?:https?|rtmps?|rtsps?|rtp|udp|srt|mms|mmsh):\/\//i;

function isAllowedStreamUrl(value) {
    try {
        return ALLOWED_STREAM_PROTOCOLS.includes(new URL(value).protocol);
    } catch (e) {
        return false;
    }
}

function isPlaylistUrl(value) {
    return PLAYLIST_URL.test(String(value || '').trim());
}

module.exports = { ALLOWED_STREAM_PROTOCOLS, isAllowedStreamUrl, isPlaylistUrl };
