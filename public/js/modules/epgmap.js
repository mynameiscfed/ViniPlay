/**
 * epgmap.js
 * Admin tool in Settings: see which channels have no guide data, assign one by hand,
 * and review the matches the server suggests from channel names and (optionally) a model.
 * Suggestions live on the server (epg_suggestions.json), so a refresh or restart loses nothing.
 */

import { appState, guideState } from './state.js';
import { apiFetch, fetchConfig } from './api.js';
import { openModal, closeModal, showNotification, showConfirm } from './ui.js';
import { escapeHtml } from './utils.js';
import { ICONS } from './icons.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 200; // rows drawn at once; thousands of rows would freeze the page

let filter = 'none'; // 'none' (no guide data) | 'manual' | 'all'
let shown = PAGE_SIZE;
let suggestions = new Map(); // channel id -> {epgId, names, sample, confidence, confident, via, aiDisagreed?}
let assigning = null; // the channel open in the assign modal
let searchSeq = 0; // drops the answer of a search that was overtaken by a newer one
let pollTimer = null;

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

// A Dice similarity is not a probability, so say what it is in plain words instead of "90%".
// tier is set by the server; older stored suggestions lack it, so derive it the same way.
const tierOf = (s) => s.tier || (s.via === 'ai' ? 'ai' : s.confident ? 'exact' : s.confidence >= 0.5 ? 'likely' : 'guess');
const TIER_LABEL = { exact: 'Exact', likely: 'Likely', ai: 'AI pick', guess: 'Guess' };
const BULK = new Set(['exact', 'likely', 'ai']); // guess (ties and wrong shifts) still needs a human eye

const suggestionCell = (s) => {
    if (!s) return '';
    const disagree = s.aiDisagreed ? '<span class="text-yellow-400">AI disagreed · </span>' : '';
    const hint = !s.aiDisagreed && s.tie ? '<span class="text-yellow-400">Tie · </span>' : '';
    return `<div>${escapeHtml(s.names[0] || s.epgId)} <span class="text-xs text-gray-500">${hint}${disagree}${TIER_LABEL[tierOf(s)]}</span></div>` +
        `<div class="text-xs text-gray-500">${escapeHtml(s.epgId)}${s.sample ? ` · e.g. ${escapeHtml(s.sample)}` : ''}</div>`;
};

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
    // Most-actionable rows first: strongest suggestion at the top, channels with nothing last.
    const rows = matching().sort((a, b) => (suggestions.get(b.id)?.confidence ?? -1) - (suggestions.get(a.id)?.confidence ?? -1));
    const without = guideState.channels.filter((ch) => status(ch) === 'none').length;
    $('epg-map-tbody').innerHTML = rows.slice(0, shown).map(rowHTML).join('')
        || '<tr><td colspan="4" class="text-center text-gray-500 py-4">No channels to show.</td></tr>';
    $('epg-map-more-btn').classList.toggle('hidden', rows.length <= shown);
    $('epg-map-summary').textContent = `${without} of ${guideState.channels.length} channels have no guide data · ${suggestions.size} suggestions`;
    document.querySelectorAll('[data-epg-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.epgFilter === filter)));
    const bulk = [...suggestions.values()].filter((s) => BULK.has(tierOf(s))).length;
    $('epg-map-accept-btn').classList.toggle('hidden', !bulk);
    $('epg-map-accept-btn').textContent = `Accept all (${bulk})`;
}

/** Loads the persisted suggestions from the server (survive refresh and restart). */
async function hydrateSuggestions() {
    const res = await fetch('/api/epg/suggest');
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    if (!body) return false;
    suggestions = new Map(body.suggestions.map((s) => [s.channelId, s]));
    return true;
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

/** Starts the server-side match job (background) and polls until it finishes, re-rendering as results stream in. */
async function startMatchJob() {
    const useAi = $('epg-map-ai').checked;
    const run = async () => {
        let sent = false;
        await whileBusy(async () => {
            const res = await apiFetch('/api/epg/match', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useAi }),
            });
            if (!res) return;
            sent = true;
            const st = await res.json();
            if (!st.started && st.status === 'running') showNotification('Matching is already running.');
        });
        // Always poll: a refresh mid-run loses the poller, so re-sync with whatever the server is doing.
        if (sent) pollMatch();
    };
    if (!useAi) return run();
    showConfirm('Ask AI?', 'Channel names and the closest guide names are sent to OpenRouter. Progress is saved as it goes and results stream into the table below.', run);
}

async function pollMatch() {
    const summary = $('epg-map-summary');
    const res = await fetch('/api/epg/match');
    if (!res.ok) return;
    const st = await res.json().catch(() => null);
    await hydrateSuggestions();
    if (st && st.status === 'running') {
        summary.textContent = `Matching... batch ${st.done}/${st.totalChunks} · ${st.suggested} suggestions, ${st.failed} failed`;
        renderEpgMap();
        clearTimeout(pollTimer);
        pollTimer = setTimeout(pollMatch, 1000);
    } else if (st && st.status === 'done') {
        if (st.error) { summary.textContent = `Matching failed: ${st.error}`; showNotification('Matching failed. See server logs.', true, 4000); }
        else if (st.suggested) showNotification(`${st.suggested} suggestion${st.suggested === 1 ? '' : 's'} saved.`, false, 4000);
        renderEpgMap();
    } else {
        renderEpgMap(); // idle: just show what is already stored
    }
}

function suggest() {
    const ids = guideState.channels.filter((ch) => status(ch) === 'none').map((ch) => ch.id);
    if (!ids.length) return showNotification('Every channel already has guide data.');
    startMatchJob();
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
    $('epg-map-accept-btn').addEventListener('click', () => {
        const set = {};
        suggestions.forEach((s, id) => { if (BULK.has(tierOf(s))) set[id] = s.epgId; });
        const n = Object.keys(set).length;
        if (!n) return;
        const by = { exact: 0, likely: 0, ai: 0 };
        Object.keys(set).forEach((id) => { by[tierOf(suggestions.get(id))]++; });
        const parts = [`${by.exact} exact`, `${by.likely} likely`]; if (by.ai) parts.push(`${by.ai} AI`);
        showConfirm('Accept all suggestions?', `Permanently assign guide data to ${n} channels (${parts.join(', ')}). Check the list first: there is no undo.`, () => whileBusy(() => apply(set)));
    });

    $('epg-map-tbody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        const ch = btn && byId(btn.closest('tr').dataset.id);
        if (!ch) return;
        const s = suggestions.get(ch.id);
        if (btn.dataset.act === 'assign') openAssign(ch);
        else if (btn.dataset.act === 'reject') {
            suggestions.delete(ch.id);
            fetch('/api/epg/suggest', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelIds: [ch.id] }) });
            renderEpgMap();
        }
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

    // Restore persisted suggestions from before the refresh, then draw.
    hydrateSuggestions().then(() => renderEpgMap());
}