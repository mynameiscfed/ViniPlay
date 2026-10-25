const { test } = require('node:test');
const assert = require('node:assert');
const { parseM3U, displayNameFromExtinf } = require('../m3uParser');
const { isPlaylistUrl } = require('../streamProtocols');

test('the display name starts after the attribute block, not after the last comma', () => {
    assert.strictEqual(displayNameFromExtinf('#EXTINF:-1 tvg-id="x" tvg-name="CNN, International",CNN, International'), 'CNN, International');
    assert.strictEqual(displayNameFromExtinf('#EXTINF:-1 tvg-id="x",Plain'), 'Plain');
    assert.strictEqual(displayNameFromExtinf('#EXTINF:-1'), 'Unknown');
});

test('import accepts every protocol the player accepts', () => {
    for (const url of ['http://a/x.ts', 'https://a/x', 'rtmp://a/x', 'rtsp://a/x', 'rtp://239.0.0.1:1234', 'udp://239.0.0.1:1234', 'srt://a:9000', 'mms://a/x']) {
        assert.strictEqual(isPlaylistUrl(url), true, url);
    }
    for (const url of ['file:///etc/passwd', 'concat:a|b', 'pipe:0', '', 'not a url']) {
        assert.strictEqual(isPlaylistUrl(url), false, url);
    }
});

test('parsing keeps names with commas and non-http channels', () => {
    const playlist = [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="one" tvg-name="CNN, International" group-title="News, World",CNN, International',
        'http://example.com/one.ts',
        '#EXTINF:-1 tvg-id="two" tvg-name="Camera" group-title="Cams",Camera',
        'rtsp://example.com/two',
    ].join('\n');
    const channels = parseM3U(playlist);
    assert.strictEqual(channels.length, 2);
    assert.strictEqual(channels[0].displayName, 'CNN, International');
    assert.strictEqual(channels[0].group, 'News, World');
    assert.strictEqual(channels[1].url, 'rtsp://example.com/two');
});
