/**
 * home.js
 * The Home page: recently watched channels, favorites, and what is coming up
 * (reminders and scheduled recordings; admins see every user's recordings with the owner's name).
 */

import { appState, dvrState, guideState, UIElements } from './state.js';
import { apiFetch, saveUserSetting } from './api.js';
import { channelCardHTML, toggleFavorite } from './guide.js';
import { playChannel } from './player.js';
import { navigate, showConfirm } from './ui.js';
import { escapeHtml } from './utils.js';
import { ICONS } from './icons.js';

const RECENT_SIZE = 12;
const FAVORITE_SIZE = 60;
const UPCOMING_SIZE = 8;

const greeting = () => {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

const dayLabel = (value) => {
    const d = new Date(value);
    return d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'short' });
};
const clock = (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const shelf = (title, body, extra = '') =>
    `<section class="shelf"><div class="shelf-head"><h3>${title}</h3>${extra}</div>${body}</section>`;

const channelShelf = (title, channels, extra) =>
    channels.length ? shelf(title, `<div class="shelf-grid">${channels.map(channelCardHTML).join('')}</div>`, extra) : '';

/** Reminders and scheduled recordings, soonest first. */
const upcoming = () => {
    const now = Date.now();
    const reminders = guideState.userNotifications
        .filter(n => n.status === 'pending' && new Date(n.programStart) > now)
        .map(n => ({ at: n.programStart, title: n.programTitle, channel: n.channelName, kind: 'Reminder set', icon: 'bell' }));
    const recordings = (dvrState.scheduledJobs || [])
        .filter(j => j.status === 'scheduled' && new Date(j.startTime) > now)
        .map(j => ({ at: j.startTime, title: j.programTitle, channel: j.channelName, kind: 'Recording', icon: 'rec', owner: appState.currentUser?.isAdmin ? j.username : '' }));
    return [...reminders, ...recordings].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, UPCOMING_SIZE);
};

const upcomingList = () => {
    const rows = upcoming();
    if (!rows.length) return '';
    return `<section class="shelf upnext" aria-labelledby="home-up-h"><div class="shelf-head"><h3 id="home-up-h">Coming up</h3></div><ol class="up-list">${rows.map(r =>
        `<li class="up"><time datetime="${new Date(r.at).toISOString()}"><span class="up-day">${dayLabel(r.at)}</span><span class="up-clock">${clock(r.at)}</span></time><div class="up-main"><b class="up-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</b><span class="up-ch">${escapeHtml(r.channel)}${r.owner ? ` · ${escapeHtml(r.owner)}` : ''}</span></div><span class="up-state up-${r.icon}">${ICONS[r.icon] || ''}${r.kind}</span></li>`).join('')}</ol></section>`;
};

const draw = () => {
    const byId = (id) => guideState.channels.find(c => c.id === id);
    const recent = (guideState.settings.recentChannels || []).map(byId).filter(Boolean).slice(0, RECENT_SIZE);
    const favorites = guideState.channels.filter(c => c.isFavorite).slice(0, FAVORITE_SIZE);
    const clearRecents = '<button type="button" class="btn btn-ghost btn-sm" data-clear-recents>Clear</button>';
    const main = channelShelf('Recently watched', recent, clearRecents) + channelShelf('Favorites', favorites);
    const side = upcomingList();
    const body = main || side
        ? `<div class="home-grid${side ? '' : ' no-side'}"><div class="home-main">${main || '<div class="hm-empty"><p>No favorites yet. Open the TV guide and tap the star on a channel to add it here.</p></div>'}</div>${side ? `<aside class="home-side">${side}</aside>` : ''}</div>`
        : '<div class="hm-empty"><p>Nothing here yet. Open the TV guide, tap the star on a channel to add it to Favorites, and the channels you watch will show up here.</p></div>';
    UIElements.homeContent.innerHTML = `<div class="home"><div class="home-hello"><div><h2>${greeting()}, ${escapeHtml(appState.currentUser?.username || '')}</h2><p>${guideState.channels.length} channels ready to watch.</p></div><button type="button" class="btn btn-primary" data-go="/tvguide">Open the TV guide</button></div>${body}</div>`;
};

export async function refreshHome() {
    draw();
    if (!appState.currentUser?.isAdmin && !appState.currentUser?.canUseDvr) return;
    const res = await apiFetch('/api/dvr/jobs');
    if (res && res.ok) {
        dvrState.scheduledJobs = await res.json();
        if (!UIElements.pageHome.classList.contains('hidden')) draw();
    }
}

/** Tells screen readers about a change that has no other visible cue. */
const announce = (msg) => {
    let el = document.getElementById('home-live');
    if (!el) {
        el = document.createElement('div');
        el.id = 'home-live';
        el.className = 'sr-only';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
    }
    el.textContent = msg;
};

const activate = (e) => {
    const go = e.target.closest('[data-go]');
    const star = e.target.closest('.favorite-star');
    const card = e.target.closest('.chc-main');
    if (go) navigate(go.dataset.go);
    else if (e.target.closest('[data-clear-recents]')) showConfirm('Clear recently watched?', 'This empties your Recently watched list and the Recents filter in the guide. Favorites are not affected.', () => {
        guideState.settings.recentChannels = [];
        saveUserSetting('recentChannels', []);
        draw();
    });
    else if (star) {
        const id = star.dataset.channelId;
        const nowFav = toggleFavorite(id);
        draw();
        document.querySelector(`#home-content .favorite-star[data-channel-id="${CSS.escape(id)}"]`)?.focus();
        announce(nowFav ? 'Added to favorites' : 'Removed from favorites');
    }
    else if (card) playChannel(card.dataset.url, card.dataset.name, card.dataset.id);
};

['click', 'longpress'].forEach(type => document.getElementById('home-content').addEventListener(type, activate));
