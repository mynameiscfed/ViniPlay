/**
 * bar.js
 * The one control bar under the video, used by every mode: live, live with rewind, movies,
 * episodes and recordings. player.js says what the stream can do (the "source"); this file draws it.
 *
 *   live       show the Live pill (grey when behind, pink at the live edge)
 *   seekable   show the scrubber and the skip buttons
 *   position() total() seek(t) skip(dt) goLive()   optional: replace how time works
 *              (a transcoded movie seeks by restarting the stream on the server)
 *
 * Without a bar the browser's own controls stay on, so a failure here never leaves a video unusable.
 */

import { ICONS } from './icons.js';
import { appState } from './state.js';

const $ = (id) => document.getElementById(id);
const SKIP = 15;
const SKIP_LONG = 60;

let src = null; // what the stream on screen can do; null while there is no bar
let timer = 0;
let dragging = false;
let shown = {}; // what the last tick drew, so the icons are only rewritten when they change

export function fmt(seconds) {
    const s = Math.max(0, Math.floor(seconds) || 0);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const video = () => $('videoElement');

const seekableEnd = () => {
    const v = video();
    try { return v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0; } catch (e) { return 0; }
};
const position = () => (src?.position ? src.position() : video().currentTime) || 0;
// A live stream (rewind buffer, recording in progress) grows, so its end is what can be seeked to; a file's end is its duration.
const total = () => {
    if (src?.total) return src.total() || 0;
    const d = video().duration;
    return (!src?.live && d > 0 && d < Infinity ? d : seekableEnd()) || 0;
};
const canSeek = () => !!src?.seekable && total() > 0;

export const barCanSeek = () => canSeek();

function seekTo(t) {
    if (src?.seek) src.seek(t);
    else video().currentTime = Math.max(0, t);
}

/** Moves by `by` seconds (negative goes back); does nothing on a stream that cannot seek. */
export function skip(by) {
    if (!canSeek()) return false;
    if (src.skip) src.skip(by);
    else seekTo(Math.min(total(), Math.max(0, position() + by)));
    return true;
}

export function togglePlay(force) {
    const v = video();
    const play = force ?? v.paused;
    if (play) v.play().catch(() => {}); else v.pause();
}

function setVolume(x) {
    const v = video();
    v.volume = Math.min(1, Math.max(0, x));
    v.muted = v.volume === 0;
    localStorage.setItem('iptvPlayerVolume', String(v.volume));
}

export const nudgeVolume = (by) => {
    const v = video();
    const from = v.muted ? 0 : v.volume;
    v.muted = false;
    setVolume(from + by);
};

export const toggleMute = () => { video().muted = !video().muted; };

export function goLive() {
    if (src?.goLive) src.goLive();
    else if (canSeek()) { seekTo(Math.max(0, total() - 0.5)); togglePlay(true); }
}

const setIcon = (id, key, icon) => {
    if (shown[key] === icon) return;
    shown[key] = icon;
    $(id).innerHTML = ICONS[icon];
};

function setFill(el) {
    el.style.setProperty('--p', `${el.max > 0 ? (el.value / el.max) * 100 : 0}%`);
}

function tick() {
    if (!src) return;
    const v = video();
    const end = total();
    const seekable = canSeek();
    const pos = Math.min(position(), end || position());
    const seek = $('pb-seek');

    setIcon('pb-play', 'play', v.paused ? 'play' : 'pause');
    setIcon('pb-mute', 'mute', v.muted || v.volume === 0 ? 'mute' : 'audio');

    $('pb-seek').disabled = !seekable;
    $('pb-back').disabled = $('pb-fwd').disabled = !seekable;
    if (!dragging) {
        seek.max = end || 1;
        seek.value = pos;
        $('pb-time').textContent = fmt(pos);
    }
    setFill(seek);
    $('pb-total').textContent = end ? fmt(end) : '--:--';

    const volume = $('pb-volume');
    volume.value = v.muted ? 0 : v.volume;
    setFill(volume);

    const atLive = src.seekable ? end - pos < 8 : true;
    $('pb-live').classList.toggle('pill-live', atLive);

    const sleep = $('pb-sleep');
    const left = appState.sleep ? Math.max(1, Math.ceil((appState.sleep.ends - Date.now()) / 60000)) : 0;
    sleep.classList.toggle('hidden', !left);
    sleep.textContent = `Sleep ${left}m`;

    const speed = $('pb-speed');
    speed.textContent = `${v.playbackRate || 1}×`;
    speed.classList.toggle('on', (v.playbackRate || 1) !== 1);
}

export function showBar(source = {}) {
    src = source;
    shown = {};
    video().controls = false;
    const bar = $('player-bar');
    bar.classList.toggle('is-live', !!src.live);
    bar.classList.toggle('is-seekable', !!src.seekable);
    bar.classList.remove('hidden');
    clearInterval(timer);
    timer = setInterval(tick, 250);
    tick();
}

export function hideBar() {
    src = null;
    dragging = false;
    clearInterval(timer);
    timer = 0;
    $('player-bar').classList.add('hidden');
    video().controls = true;
}

export function setupBar() {
    const seek = $('pb-seek');
    seek.addEventListener('input', () => {
        dragging = true;
        $('pb-time').textContent = fmt(+seek.value);
        setFill(seek);
    });
    seek.addEventListener('change', () => { dragging = false; seekTo(+seek.value); });
    seek.addEventListener('blur', () => { dragging = false; });

    $('pb-play').addEventListener('click', () => togglePlay());
    $('pb-back').addEventListener('click', () => skip(-SKIP));
    $('pb-fwd').addEventListener('click', () => skip(SKIP));
    $('pb-live').addEventListener('click', goLive);
    $('pb-mute').addEventListener('click', toggleMute);
    $('pb-sleep').addEventListener('click', () => $('pb-panel-btn').click());
    $('pb-volume').addEventListener('input', (e) => setVolume(+e.target.value));

    // A mouse click leaves focus on the button, which would make Space press it again.
    $('player-bar').addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') e.target.closest('button')?.blur(); });

    const v = video();
    v.addEventListener('click', (e) => { if (src && e.pointerType === 'mouse') togglePlay(); });
    v.addEventListener('dblclick', () => $('player-fullscreen-btn').click());
}

export { SKIP, SKIP_LONG };
