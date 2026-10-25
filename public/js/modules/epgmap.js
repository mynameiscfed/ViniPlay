/**
 * epgmap.js
 * Admin tool in Settings: see which channels have no guide data, assign one by hand,
 * and review the matches the server suggests from channel names.
 */

import { appState, guideState } from './state.js';
import { apiFetch, fetchConfig } from './api.js';
import { openModal, closeModal, showNotification } from './ui.js';
import { escapeHtml } from './utils.js';
import { ICONS } from './icons.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 200; // rows drawn at once; thousands of rows would freeze the page
const BATCH = 300; // channels per suggest request, the server's limit
const CONFIDENT = 0.9; // suggestions at or above this can be accepted in one click

let filter = 'none'; // 'none' (no guide data) | 'manual' | 'all'
let shown = PAGE_SIZE;
let suggestions = new Map(); // channel id -> {epgId, names, sample, confidence, via}
let assigning = null; // the channel open in the assign modal
let searchSeq = 0; // drops the answer of a search that was overtaken by a newer one

const overrides = () => guideState.settings.epgOverrides || {};
const status = (ch) => (overrides()[ch.id] ? 'manual' : (guideState.programs[ch.id]?.length ? 'ok' : 'none'));
const byId = (id) => guideState.channels.find((c) => c.id === id);

const matching = () => {
    const words = ($('epg-map-search').value || '').toLowerCase().split(/\s+/).filter(Boolean);
    return guideState.channels.filter((ch) => {
        if (filter !== 'all' && status(ch) !== filter) return false;
        const text = `${ch.displayName} ${ch.name} ${ch.group} ${ch.source}`.toLowerCase();
        return words.every((w) => text.includes(w));
    });
};

const guideCell = (ch) => {
    const state = status(ch);
    if (state === 'manual') return `<span class="text-blue-400">Assigned</span><div class="text-xs text-gray-500">${escapeHtml(overrides()[ch.id])}</div>`;
    return state === 'ok' ? '<span class="text-green-400">Has guide data</span>' : '<span class="text-yellow-400">No guide data</span>';
};

const suggestionCell = (s) => s
    ? `<div>${escapeHtml(s.names[0] || s.epgId)} <span class="text-xs text-gray-500">${Math.round(s.confidence * 100)}%</span></div>` +
      `<div class="text-xs text-gray-500">${escapeHtml(s.epgId)}${s.sample ? ` · e.g. ${escapeHtml(s.sample)}` : ''}</div>`
    : '';

const rowHTML = (ch) => {
    const s = suggestions.get(ch.id);
    return `<tr data-id="${escapeHtml(ch.id)}">
        <td>${escapeHtml(ch.displayName)}<div class="text-xs text-gray-500">${escapeHtml(ch.group)} · ${escapeHtml(ch.source)}</div></td>
        <td>${guideCell(ch)}</td>
        <td>${suggestionCell(s)}</td>
        <td class="text-right"><div class="flex items-center justify-end gap-3">
            ${s ? `<button class="action-btn" data-act="accept" title="Accept suggestion" aria-label="Accept suggestion">${ICONS.check}</button>
                   <button class="action-btn" data-act="reject" title="Dismiss suggestion" aria-label="Dismiss suggestion">${ICONS.close}</button>` : ''}
            <button class="action-btn" data-act="assign" title="Choose guide data" aria-label="Choose guide data">${ICONS.edit}</button>
            ${overrides()[ch.id] ? `<button class="action-btn" data-act="clear" title="Remove assignment" aria-label="Remove assignment">${ICONS.trash}</button>` : ''}
        </div></td>
    </tr>`;
};

export function renderEpgMap() {
    if (!$('epg-map-tbody') || !appState.currentUser?.isAdmin) return;
    const rows = matching();
    const without = guideState.channels.filter((ch) => status(ch) === 'none').length;
    $('epg-map-tbody').innerHTML = rows.slice(0, shown).map(rowHTML).join('')
        || '<tr><td colspan="4" class="text-center text-gray-500 py-4">No channels to show.</td></tr>';
    $('epg-map-more-btn').classList.toggle('hidden', rows.length <= shown);
    $('epg-map-summary').textContent = `${without} of ${guideState.channels.length} channels have no guide data.`;
    document.querySelectorAll('[data-epg-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.epgFilter === filter)));
    const confident = [...suggestions.values()].filter((s) => s.confidence >= CONFIDENT).length;
    $('epg-map-accept-btn').classList.toggle('hidden', !confident);
    $('epg-map-accept-btn').textContent = `Accept ${confident} confident match${confident === 1 ? '' : 'es'}`;
}

/** Saves the change on the server, which re-merges the guides; then reloads the programmes so the guide shows them. */
async function apply(set, clear = []) {
    const res = await apiFetch('/api/epg/overrides', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set, clear }),
    });
    if (!res) return false;
    guideState.settings.epgOverrides = (await res.json()).epgOverrides;
    const config = await fetchConfig();
    if (config) guideState.programs = config.epgContent || {};
    Object.keys(set).forEach((id) => suggestions.delete(id));
    showNotification('Guide data updated.');
    renderEpgMap();
    return true;
}

// Re-merging a big guide takes a while: keep the controls from piling up requests meanwhile.
async function whileBusy(work) {
    const controls = [...document.querySelectorAll('#epg-map-tbody button, #epg-map-auto-btn, #epg-map-accept-btn')];
    controls.forEach((c) => { c.disabled = true; });
    try { await work(); } finally { controls.forEach((c) => { c.disabled = false; }); }
}

async function suggest() {
    const ids = guideState.channels.filter((ch) => status(ch) === 'none').map((ch) => ch.id);
    if (!ids.length) return showNotification('Every channel already has guide data.');
    const summary = $('epg-map-summary');
    await whileBusy(async () => {
        suggestions = new Map();
        for (let i = 0; i < ids.length; i += BATCH) {
            summary.textContent = `Matching channels... ${Math.min(i + BATCH, ids.length)} of ${ids.length}`;
            const res = await apiFetch('/api/epg/suggest', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelIds: ids.slice(i, i + BATCH) }),
            });
            if (!res) break;
            (await res.json()).suggestions.forEach((s) => suggestions.set(s.channelId, s));
        }
        shown = PAGE_SIZE;
        renderEpgMap();
        showNotification(`${suggestions.size} suggestion${suggestions.size === 1 ? '' : 's'} for ${ids.length} channels without guide data.`);
    });
}

// --- Assign modal ---
async function searchGuideChannels() {
    const seq = ++searchSeq;
    const q = $('epg-assign-search').value.trim();
    const res = await apiFetch(`/api/epg/channels?q=${encodeURIComponent(q)}&limit=30`);
    if (!res || seq !== searchSeq) return;
    const found = await res.json();
    $('epg-assign-list').innerHTML = found.map((c) => `
        <button type="button" class="w-full text-left bg-gray-700 hover:bg-gray-600 rounded-md p-3" data-epg-id="${escapeHtml(c.id)}">
            <div class="text-white font-medium">${escapeHtml(c.names[0] || c.id)}</div>
            <div class="text-xs text-gray-400">${escapeHtml(c.id)}${c.sample ? ` · e.g. ${escapeHtml(c.sample)}` : ''}</div>
        </button>`).join('')
        || '<p class="text-gray-400 text-sm">No guide channels found. If ViniPlay was just updated, run Process Sources once to build this list.</p>';
}

function openAssign(ch) {
    assigning = ch;
    $('epg-assign-title').textContent = `Guide data for ${ch.displayName}`;
    $('epg-assign-search').value = ch.displayName;
    openModal($('epg-assign-modal'));
    searchGuideChannels();
}

export function setupEpgMap() {
    if (!$('epg-map-tbody')) return;
    let timer;
    const debounced = (fn) => () => { clearTimeout(timer); timer = setTimeout(fn, 250); };

    document.querySelectorAll('[data-epg-filter]').forEach((b) => b.addEventListener('click', () => {
        filter = b.dataset.epgFilter;
        shown = PAGE_SIZE;
        renderEpgMap();
    }));
    $('epg-map-search').addEventListener('input', debounced(() => { shown = PAGE_SIZE; renderEpgMap(); }));
    $('epg-map-more-btn').addEventListener('click', () => { shown += PAGE_SIZE; renderEpgMap(); });
    $('epg-map-auto-btn').addEventListener('click', suggest);
    $('epg-map-accept-btn').addEventListener('click', () => whileBusy(async () => {
        const set = {};
        suggestions.forEach((s, id) => { if (s.confidence >= CONFIDENT) set[id] = s.epgId; });
        await apply(set);
    }));

    $('epg-map-tbody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        const ch = btn && byId(btn.closest('tr').dataset.id);
        if (!ch) return;
        const s = suggestions.get(ch.id);
        if (btn.dataset.act === 'assign') openAssign(ch);
        else if (btn.dataset.act === 'reject') { suggestions.delete(ch.id); renderEpgMap(); }
        else if (btn.dataset.act === 'accept') whileBusy(() => apply({ [ch.id]: s.epgId }));
        else if (btn.dataset.act === 'clear') whileBusy(() => apply({}, [ch.id]));
    });

    $('epg-assign-search').addEventListener('input', debounced(searchGuideChannels));
    $('epg-assign-close-btn').addEventListener('click', () => closeModal($('epg-assign-modal')));
    $('epg-assign-list').addEventListener('click', (e) => {
        const pick = e.target.closest('[data-epg-id]');
        if (!pick || !assigning) return;
        const channel = assigning;
        closeModal($('epg-assign-modal'));
        whileBusy(() => apply({ [channel.id]: pick.dataset.epgId }));
    });
}
