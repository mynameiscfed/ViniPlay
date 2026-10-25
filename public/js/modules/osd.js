/**
 * osd.js
 * What surrounds the video: the header and the now/next card fade out when nothing moves,
 * a channels panel lets you zap, CH+/CH- (or Page Down/Up) change channel.
 * player.js announces live channels with a "playchannel" event and stops with "playerstop".
 */

import { guideState } from './state.js';
import { playChannel } from './player.js';
import { escapeHtml, formatTimeWithOffset, nowNext } from './utils.js';
import { focusEl } from './focus.js';

const IDLE_MS = 3500;
const PANEL_BEFORE = 12;
const PANEL_AFTER = 28;

const $ = (id) => document.getElementById(id);

let current = null; // id of the live channel on screen; null for recordings and movies
let idleTimer = 0;
let clock = 0;

export const isPlayerOpen = () => !$('video-modal').classList.contains('hidden');

const channelList = () => guideState.visibleChannels.length ? guideState.visibleChannels : guideState.channels;
const play = (channel) => playChannel(channel.url, channel.displayName || channel.name, channel.id);

/** Shows the header and card, then hides them again after a quiet spell (not while the menu is open). */
const wake = () => {
    const modal = $('video-modal');
    modal.classList.remove('osd-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (!$('player-more-options-menu').classList.contains('hidden')) wake();
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
    $('osd-next').textContent = next ? `Next · ${next.title} ${formatTimeWithOffset(new Date(next.start), guideState.settings.timezoneOffset || 0)}` : '';
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

const panelOpen = () => !$('player-channels').classList.contains('hidden');

const openPanel = () => {
    renderPanel();
    $('player-channels').classList.remove('hidden');
    focusEl($('player-channels-list').querySelector('.cur'));
};

const closePanel = () => {
    $('player-channels').classList.add('hidden');
    $('player-channels-btn').focus({ preventScroll: true });
};

const zap = (dir) => {
    const channels = channelList();
    const at = channels.findIndex(c => c.id === current);
    const target = channels[(at + dir + channels.length) % channels.length];
    if (target) play(target);
};

export function setupOsd() {
    const modal = $('video-modal');
    ['mousemove', 'touchstart', 'click', 'focusin'].forEach(type => modal.addEventListener(type, wake, { passive: true }));

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
        if (panelOpen()) renderPanel();
        clearInterval(clock);
        clock = setInterval(renderOsd, 30000);
    });
    document.addEventListener('playerstop', () => {
        current = null;
        clearInterval(clock);
        $('player-osd').classList.add('hidden');
        $('player-channels').classList.add('hidden');
        $('player-channels-btn').classList.add('hidden');
    });

    $('player-channels-btn').addEventListener('click', () => (panelOpen() ? closePanel() : openPanel()));
    $('player-channels-close').addEventListener('click', closePanel);
    $('player-channels-list').addEventListener('click', (e) => {
        const channel = guideState.channels.find(c => c.id === e.target.closest('.pc-row')?.dataset.id);
        if (channel) play(channel);
    });

    // Runs before the page-wide key handling (focus.js) so the player owns its keys while it is open.
    document.addEventListener('keydown', (e) => {
        if (!isPlayerOpen()) return;
        wake();
        if (!current || e.target.matches('input,select,textarea')) return;
        const isBack = e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack' || e.keyCode === 10009;
        const dir = e.key === 'PageDown' || e.keyCode === 427 ? 1 : e.key === 'PageUp' || e.keyCode === 428 ? -1 : 0;
        const tvArrow = document.documentElement.classList.contains('tv') && e.key.indexOf('Arrow') === 0 && (e.target === document.body || e.target.tagName === 'VIDEO');
        if (isBack && panelOpen()) closePanel();
        else if (dir) zap(dir);
        else if (tvArrow) focusEl($('player-channels-btn')); // arrows on a TV bring up the controls instead of nudging the video
        else return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
}
