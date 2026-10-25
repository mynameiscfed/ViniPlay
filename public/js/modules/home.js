/**
 * home.js
 * The Home page: recently watched channels, favorites, and what is coming up
 * (reminders and scheduled recordings; admins see every user's recordings with the owner's name).
 */

import { appState, dvrState, guideState, UIElements } from './state.js';
import { apiFetch } from './api.js';
import { cardHTML, toggleFavorite } from './guide.js';
import { playChannel } from './player.js';
import { navigate } from './ui.js';
import { escapeHtml } from './utils.js';

const SHELF_SIZE = 6;
const UPCOMING_SIZE = 8;

const greeting = () => {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

const when = (value) => new Date(value).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const shelf = (title, body, goTo) =>
    `<section class="shelf"><h3>${title}${goTo ? `<button type="button" class="btn btn-ghost btn-sm" data-go="${goTo}">See all</button>` : ''}</h3>${body}</section>`;

const channelShelf = (title, channels) =>
    channels.length ? shelf(title, `<div class="shelf-grid">${channels.map(cardHTML).join('')}</div>`) : '';

/** Reminders and scheduled recordings, soonest first. */
const upcoming = () => {
    const now = Date.now();
    const reminders = guideState.userNotifications
        .filter(n => n.status === 'pending' && new Date(n.programStart) > now)
        .map(n => ({ at: n.programStart, title: n.programTitle, channel: n.channelName, kind: 'Reminder', pill: 'pill-am' }));
    const recordings = (dvrState.scheduledJobs || [])
        .filter(j => j.status === 'scheduled' && new Date(j.startTime) > now)
        .map(j => ({ at: j.startTime, title: j.programTitle, channel: j.channelName, kind: 'Record', pill: 'pill-rd', owner: appState.currentUser?.isAdmin ? j.username : '' }));
    return [...reminders, ...recordings].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, UPCOMING_SIZE);
};

const upcomingShelf = () => {
    const rows = upcoming();
    if (!rows.length) return '';
    return shelf('Coming up', `<div class="lrows">${rows.map(r =>
        `<div class="lrow"><time>${when(r.at)}</time><div class="t"><b>${escapeHtml(r.title)}</b><small>${escapeHtml(r.channel)}${r.owner ? ` · ${escapeHtml(r.owner)}` : ''}</small></div><span class="pill ${r.pill}">${r.kind}</span></div>`).join('')}</div>`);
};

const draw = () => {
    const byId = (id) => guideState.channels.find(c => c.id === id);
    const recent = (guideState.settings.recentChannels || []).map(byId).filter(Boolean).slice(0, SHELF_SIZE);
    const favorites = guideState.channels.filter(c => c.isFavorite).slice(0, SHELF_SIZE);
    const body = channelShelf('Recently watched', recent) + channelShelf('Favorites', favorites) + upcomingShelf();
    UIElements.homeContent.innerHTML = `<div class="home"><div class="home-hello"><div><h2>${greeting()}, ${escapeHtml(appState.currentUser?.username || '')}</h2><p>${guideState.channels.length} channels ready to watch.</p></div><button type="button" class="btn btn-primary" data-go="/tvguide">Open the TV guide</button></div>${body || '<div class="card hm-empty"><p>Nothing here yet. Open the TV guide, tap the star on a channel to add it to Favorites, and the channels you watch will show up here.</p></div>'}</div>`;
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

const activate = (e) => {
    const go = e.target.closest('[data-go]');
    const star = e.target.closest('.favorite-star');
    const card = e.target.closest('.channel-info');
    if (go) navigate(go.dataset.go);
    else if (star) { toggleFavorite(star.dataset.channelId); draw(); }
    else if (card) playChannel(card.dataset.url, card.dataset.name, card.dataset.id);
};

['click', 'longpress'].forEach(type => document.getElementById('home-content').addEventListener(type, activate));
