/**
 * osd.js
 * What surrounds the video: the header, now/next card and control bar fade out when nothing moves,
 * a channels panel lets you zap, CH+/CH- (or Page Down/Up) change channel, and one key map
 * (keyboard, remote and media keys) drives the control bar in every mode.
 * player.js announces live channels with a "playchannel" event and stops with "playerstop".
 */

import { guideState } from './state.js';
import { playChannel, refreshPlaybackPanel, stepEpisode, cancelUpNext } from './player.js';
import { escapeHtml, nowNext } from './utils.js';
import { formatTimeInZone } from './time.js';
import { focusEl } from './focus.js';
import { setupBar, skip, togglePlay, nudgeVolume, toggleMute, goLive, barCanSeek, SKIP, SKIP_LONG } from './bar.js';

const IDLE_MS = 3500;
const PANEL_BEFORE = 12;
const PANEL_AFTER = 28;
const VOLUME_STEP = 0.05;
// Media keys by standard name; Samsung (Tizen) remotes send these codes.
const MEDIA = {
    MediaPlayPause: 'toggle', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop', MediaRewind: 'back', MediaFastForward: 'fwd',
    MediaTrackNext: 'chnext', MediaTrackPrevious: 'chprev',
    10252: 'toggle', 415: 'play', 19: 'pause', 413: 'stop', 412: 'back', 417: 'fwd', 427: 'chnext', 428: 'chprev',
};

const $ = (id) => document.getElementById(id);

let current = null; // id of the live channel on screen; null for recordings and movies
let episode = false; // an episode is on screen, so previous / next step through its series
let idleTimer = 0;
let clock = 0;

export const isPlayerOpen = () => !$('video-modal').classList.contains('hidden');

const channelList = () => guideState.visibleChannels.length ? guideState.visibleChannels : guideState.channels;
const play = (channel) => playChannel(channel.url, channel.displayName || channel.name, channel.id);

/** Shows the header, card and control bar, then hides them after a quiet spell (not while a panel is open or the video is paused). */
const wake = () => {
    const modal = $('video-modal');
    modal.classList.remove('osd-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (openLayer() || $('videoElement').paused) wake();
        else modal.classList.add('osd-idle');
    }, IDLE_MS);
};

const renderOsd = () => {
    const channel = guideState.channels.find(c => c.id === current);
    if (!channel) return;
    const { now, next } = nowNext(channel.id);
    const logo = $('osd-logo');
    logo.style.visibility = channel.logo ? '' : 'hidden';
    logo.onerror = () => { logo.style.visibility = 'hidden'; };
    if (channel.logo) logo.src = channel.logo;
    $('osd-chno').textContent = channel.chno || '';
    $('osd-channel').textContent = channel.displayName || channel.name;
    $('osd-now').textContent = now ? now.title : 'No guide data';
    $('osd-next').textContent = next ? `Next · ${next.title} ${formatTimeInZone(new Date(next.start), guideState.settings.timeZone, guideState.settings.timezoneOffset || 0)}` : '';
    const bar = $('osd-bar-fill').closest('.osd-bar');
    bar.style.visibility = now ? '' : 'hidden';
    if (now) {
        const start = new Date(now.start), stop = new Date(now.stop);
        $('osd-bar-fill').style.width = `${Math.min(100, Math.max(0, ((Date.now() - start) / (stop - start)) * 100))}%`;
        $('osd-left').textContent = `${Math.max(1, Math.round((stop - Date.now()) / 60000))} min left`;
    }
    $('player-osd').classList.remove('hidden');
};

const renderPanel = () => {
    const list = $('player-channels-list');
    const hadFocus = list.contains(document.activeElement);
    const channels = channelList();
    const at = Math.max(0, channels.findIndex(c => c.id === current));
    list.innerHTML = channels.slice(Math.max(0, at - PANEL_BEFORE), at + PANEL_AFTER).map(c => {
        const { now } = nowNext(c.id);
        return `<button type="button" class="pc-row${c.id === current ? ' cur' : ''}" data-id="${escapeHtml(c.id)}"><img src="${escapeHtml(c.logo)}" alt="" onerror="this.style.visibility='hidden'"><span class="t"><span>${escapeHtml(c.displayName || c.name)}</span><small>${escapeHtml(now ? now.title : '')}</small></span><span class="no">${escapeHtml(c.chno || '')}</span></button>`;
    }).join('');
    const row = list.querySelector('.cur');
    if (row) list.scrollTop = row.offsetTop - list.clientHeight / 2;
    if (hadFocus && row) row.focus({ preventScroll: true });
};

// The two panels share the right edge: the Channels panel and the Playback panel. Each has the button that opens it.
const LAYERS = [['player-channels', 'player-channels-btn'], ['player-panel', 'pb-panel-btn']];
const openLayer = () => LAYERS.find(([panel]) => !$(panel).classList.contains('hidden'));

/** Closes whichever panel is open and puts focus back on the button that opened it. */
const closeLayers = () => {
    const open = openLayer();
    LAYERS.forEach(([panel]) => $(panel).classList.add('hidden'));
    if (open) $(open[1]).focus({ preventScroll: true });
};

const openPanel = () => {
    closeLayers();
    renderPanel();
    $('player-channels').classList.remove('hidden');
    focusEl($('player-channels-list').querySelector('.cur'));
};

const openPlayback = () => {
    closeLayers();
    refreshPlaybackPanel();
    $('player-panel').classList.remove('hidden');
    const rows = Array.from($('player-panel').querySelectorAll('.pc-list button, .pc-list select')).filter(el => el.offsetParent && !el.disabled);
    focusEl(rows.find(el => el.classList.contains('on')) || rows[0]);
};

const zap = (dir) => {
    const channels = channelList();
    const at = channels.findIndex(c => c.id === current);
    const target = channels[(at + dir + channels.length) % channels.length];
    if (target) play(target);
};
// Previous / next means channel for live TV and episode for a series.
const step = (dir) => (current ? zap(dir) : stepEpisode(dir));
const showSteps = (on, what) => {
    ['pb-prev', 'pb-next'].forEach(id => $(id).classList.toggle('hidden', !on));
    $('pb-prev').title = `Previous ${what} (Page Up)`;
    $('pb-next').title = `Next ${what} (Page Down)`;
};

export function setupOsd() {
    const modal = $('video-modal');
    setupBar();
    ['mousemove', 'touchstart', 'touchmove', 'click', 'focusin'].forEach(type => modal.addEventListener(type, wake, { passive: true }));

    let wasOpen = false;
    new MutationObserver(() => {
        const open = isPlayerOpen();
        if (open === wasOpen) return;
        wasOpen = open;
        if (open) wake();
        else { clearTimeout(idleTimer); modal.classList.remove('osd-idle'); }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });

    document.addEventListener('playchannel', (e) => {
        current = e.detail;
        renderOsd();
        $('player-channels-btn').classList.remove('hidden');
        showSteps(true, 'channel');
        if (openLayer()?.[0] === 'player-channels') renderPanel();
        clearInterval(clock);
        clock = setInterval(renderOsd, 30000);
    });
    document.addEventListener('playepisode', () => { episode = true; showSteps(true, 'episode'); });
    document.addEventListener('playerstop', () => {
        current = null;
        episode = false;
        clearInterval(clock);
        $('player-osd').classList.add('hidden');
        LAYERS.forEach(([panel]) => $(panel).classList.add('hidden'));
        $('player-channels-btn').classList.add('hidden');
        showSteps(false, 'channel');
    });

    $('player-channels-btn').addEventListener('click', () => (openLayer()?.[0] === 'player-channels' ? closeLayers() : openPanel()));
    $('pb-panel-btn').addEventListener('click', () => (openLayer()?.[0] === 'player-panel' ? closeLayers() : openPlayback()));
    $('player-channels-close').addEventListener('click', closeLayers);
    $('player-panel-close').addEventListener('click', closeLayers);
    $('pb-prev').addEventListener('click', () => step(-1));
    $('pb-next').addEventListener('click', () => step(1));
    $('player-channels-list').addEventListener('click', (e) => {
        const channel = guideState.channels.find(c => c.id === e.target.closest('.pc-row')?.dataset.id);
        if (channel) play(channel);
    });

    // Runs before the page-wide key handling (focus.js) so the player owns its keys while it is open.
    document.addEventListener('keydown', (e) => {
        if (!isPlayerOpen()) return;
        wake();
        const isBack = e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack' || e.keyCode === 10009;
        // Back closes an open panel first, so one press never closes both the panel and the player.
        if (isBack && openLayer()) {
            closeLayers();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (isBack && !$('player-upnext').classList.contains('hidden')) {
            cancelUpNext();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('#confirm-modal:not(.hidden), #shortcuts-modal:not(.hidden)')) return;
        const t = e.target;
        if (t.matches('input,select,textarea') && t.id !== 'pb-seek') return;
        const tv = document.documentElement.classList.contains('tv');
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const nothing = t === document.body || t.tagName === 'VIDEO'; // no control has focus, so the key is ours
        const lr = k === 'ArrowLeft' || k === 'ArrowRight';
        const ud = k === 'ArrowUp' || k === 'ArrowDown';
        const media = MEDIA[e.key] || MEDIA[e.keyCode];
        let act = '';
        if (media) act = media;
        else if (e.key === 'PageDown') act = 'chnext';
        else if (e.key === 'PageUp') act = 'chprev';
        else if (k === 'k' || (nothing || t.id === 'pb-seek') && (k === ' ' || k === 'Enter')) act = 'toggle';
        else if (k === 'm') act = 'mute';
        else if (k === 'f') act = 'fs';
        else if (k === 'c') act = 'cc';
        else if (k === 'l') act = 'live';
        else if (lr && (nothing || t.id === 'pb-seek') && (barCanSeek() || tv)) act = e.key === 'ArrowLeft' ? 'back' : 'fwd';
        else if (ud && (nothing || t.id === 'pb-seek' && !tv)) act = tv ? 'bar' : e.key === 'ArrowUp' ? 'volup' : 'voldown';
        if ((act === 'chnext' || act === 'chprev') && !current && !episode) act = '';
        if (!act) return;

        const long = e.shiftKey ? SKIP_LONG : SKIP;
        const bar = $('player-bar');
        const run = {
            toggle: () => togglePlay(), play: () => togglePlay(true), pause: () => togglePlay(false),
            stop: () => $('close-modal').click(),
            // On a TV a stream that cannot seek uses the arrow to bring up the bar instead.
            back: () => (barCanSeek() ? skip(-long) : focusEl($('pb-play'))),
            fwd: () => (barCanSeek() ? skip(long) : focusEl($('pb-play'))),
            volup: () => nudgeVolume(VOLUME_STEP), voldown: () => nudgeVolume(-VOLUME_STEP),
            mute: toggleMute,
            fs: () => $('player-fullscreen-btn').click(),
            cc: () => $('pb-cc').classList.contains('hidden') || $('pb-cc').click(),
            live: () => bar.classList.contains('is-live') && goLive(),
            bar: () => focusEl($('pb-play')),
            chnext: () => step(1), chprev: () => step(-1),
        };
        run[act]();
        e.preventDefault();
        e.stopPropagation();
    }, true);
}
