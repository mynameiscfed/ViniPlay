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
const PAGE_SIZES = [10, 25, 50];

let filter = 'none'; // 'none' (no guide data) | 'suggested' | 'manual' | 'all'
let rows = []; // the filtered, sorted list; only the current page is in the DOM
let page = 0;
let pageSize = 25;
try { const n = Number(localStorage.getItem('viniplay.epgPageSize')); if (PAGE_SIZES.includes(n)) pageSize = n; } catch { /* storage blocked */ }
let selected = new Set(); // channel ids picked for a bulk action
let optionsKey = '';
let suggestions = new Map(); // channel id -> {epgId, names, sample, confidence, confident, via, aiDisagreed?}
let assigning = null; // the channel open in the assign modal
let searchSeq = 0; // drops the answer of a search that was overtaken by a newer one
let pollTimer = null;

const overrides = () => guideState.settings.epgOverrides || {};
const status = (ch) => (overrides()[ch.id] ? 'manual' : (guideState.programs[ch.id]?.length ? 'ok' : 'none'));
const byId = (id) => guideState.channels.find((c) => c.id === id);

const inFilter = (ch, f) => f === 'all' || (f === 'suggested' ? suggestions.has(ch.id) : status(ch) === f);

const matching = () => {
    const words = ($('epg-map-search').value || '').toLowerCase().split(/\s+/).filter(Boolean);
    const source = $('epg-map-source').value;
    const group = $('epg-map-group').value;
    return guideState.channels.filter((ch) => {
        if (!inFilter(ch, filter)) return false;
        if (source && ch.source !== source) return false;
        if (group && ch.group !== group) return false;
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
        <td><input type="checkbox" data-act="select" aria-label="Select ${escapeHtml(ch.displayName)}"${selected.has(ch.id) ? ' checked' : ''}></td>
        <td title="${escapeHtml(ch.displayName)}">${escapeHtml(ch.displayName)}<div class="text-xs text-gray-500">${escapeHtml(ch.group)} · ${escapeHtml(ch.source)}</div></td>
        <td>${guideCell(ch)}</td>
        <td title="${s ? escapeHtml(s.names[0] || s.epgId) : ''}">${suggestionCell(s)}</td>
        <td class="text-right"><div class="flex items-center justify-end gap-3">
            ${s ? `<button class="action-btn" data-act="accept" title="Accept suggestion" aria-label="Accept suggestion">${ICONS.check}</button>
                   <button class="action-btn" data-act="reject" title="Dismiss suggestion" aria-label="Dismiss suggestion">${ICONS.close}</button>` : ''}
            <button class="action-btn" data-act="assign" title="Choose guide data" aria-label="Choose guide data">${ICONS.edit}</button>
            ${overrides()[ch.id] ? `<button class="action-btn" data-act="clear" title="Remove assignment" aria-label="Remove assignment">${ICONS.trash}</button>` : ''}
        </div></td>
    </tr>`;
};

// Source and group menus with counts; the group menu follows the chosen source.
function fillFilterMenus() {
    const srcSel = $('epg-map-source'), grpSel = $('epg-map-group');
    const key = `${guideState.channels.length}|${srcSel.value}`;
    if (key === optionsKey) return;
    optionsKey = key;
    const count = (list, field) => list.reduce((m, ch) => m.set(ch[field], (m.get(ch[field]) || 0) + 1), new Map());
    const opts = (m, all, keep) => `<option value="">${all}</option>` + [...m].sort((x, y) => String(x[0]).localeCompare(String(y[0])))
        .map(([v, n]) => `<option value="${escapeHtml(v)}"${v === keep ? ' selected' : ''}>${escapeHtml(v)} (${n})</option>`).join('');
    const src = srcSel.value, grp = grpSel.value;
    srcSel.innerHTML = opts(count(guideState.channels, 'source'), 'All sources', src);
    const groups = count(guideState.channels.filter((ch) => !src || ch.source === src), 'group');
    grpSel.innerHTML = opts(groups, `All groups (${groups.size})`, groups.has(grp) ? grp : '');
}

const pageRows = () => rows.slice(page * pageSize, (page + 1) * pageSize);

// Draws one page of rows and the pager under the table.
function drawPage() {
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(page, pages - 1); // accepting the last rows of the last page shrinks the list
    $('epg-map-tbody').innerHTML = pageRows().map(rowHTML).join('')
        || '<tr><td colspan="5" class="text-center text-gray-500 py-4">No channels to show.</td></tr>';
    const first = page * pageSize;
    $('epg-map-range').textContent = rows.length
        ? `${first + 1}–${Math.min(first + pageSize, rows.length)} of ${rows.length} · page ${page + 1} of ${pages}` : '';
    $('epg-map-prev').disabled = page === 0;
    $('epg-map-next').disabled = page >= pages - 1;
    $('epg-map-size').value = String(pageSize);
}

function renderBulkBar() {
    const ids = [...selected];
    const withSug = ids.filter((id) => suggestions.has(id)).length;
    const withOverride = ids.filter((id) => overrides()[id]).length;
    $('epg-map-bulk').classList.toggle('hidden', !ids.length);
    $('epg-map-bulk-count').textContent = `${ids.length} selected`;
    const set = (act, label, n) => { const b = document.querySelector(`[data-bulk="${act}"]`); b.textContent = `${label} (${n})`; b.classList.toggle('hidden', !n); };
    set('accept', 'Accept suggestions', withSug);
    set('reject', 'Dismiss suggestions', withSug);
    set('clear', 'Remove assignments', withOverride);
    const all = $('epg-map-all');
    const shown = pageRows();
    all.checked = shown.length > 0 && shown.every((ch) => selected.has(ch.id));
    all.indeterminate = !all.checked && shown.some((ch) => selected.has(ch.id));
}

export function renderEpgMap() {
    if (!$('epg-map-tbody') || !appState.currentUser?.isAdmin) return;
    fillFilterMenus();
    // Most-actionable rows first: strongest suggestion at the top, channels with nothing last.
    rows = matching().sort((a, b) => (suggestions.get(b.id)?.confidence ?? -1) - (suggestions.get(a.id)?.confidence ?? -1));
    const without = guideState.channels.filter((ch) => status(ch) === 'none').length;
    drawPage();
    $('epg-map-summary').textContent = `${without} of ${guideState.channels.length} channels have no guide data · ${suggestions.size} suggestions · showing ${rows.length}`;
    document.querySelectorAll('[data-epg-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.epgFilter === filter)));
    document.querySelectorAll('[data-epg-count]').forEach((n) => {
        n.textContent = guideState.channels.filter((ch) => inFilter(ch, n.dataset.epgCount)).length;
    });
    const bulk = [...suggestions.values()].filter((s) => BULK.has(tierOf(s))).length;
    $('epg-map-accept-btn').classList.toggle('hidden', !bulk);
    $('epg-map-accept-btn').textContent = `Accept all (${bulk})`;
    renderBulkBar();
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
    selected.clear();
    showNotification('Guide data updated.');
    renderEpgMap();
    return true;
}

// Re-merging a big guide takes a while: keep the controls from piling up requests meanwhile.
async function whileBusy(work) {
    const controls = [...document.querySelectorAll('#epg-map-tbody button, #epg-map-auto-btn, #epg-map-accept-btn, [data-bulk]')];
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

    // A new filter starts a new list: drop the old selection so a bulk action never hits rows you cannot see.
    const refilter = () => { selected.clear(); page = 0; renderEpgMap(); };
    // Likewise a new page is a new batch.
    const turn = (to) => { selected.clear(); page = to; renderEpgMap(); };
    $('epg-map-prev').addEventListener('click', () => turn(page - 1));
    $('epg-map-next').addEventListener('click', () => turn(page + 1));
    $('epg-map-size').addEventListener('change', (e) => {
        pageSize = Number(e.target.value);
        try { localStorage.setItem('viniplay.epgPageSize', String(pageSize)); } catch { /* storage blocked */ }
        turn(0);
    });
    document.querySelectorAll('[data-epg-filter]').forEach((b) => b.addEventListener('click', () => {
        filter = b.dataset.epgFilter;
        refilter();
    }));
    $('epg-map-search').addEventListener('input', debounced(refilter));
    $('epg-map-source').addEventListener('change', () => { $('epg-map-group').value = ''; refilter(); });
    $('epg-map-group').addEventListener('change', refilter);

    $('epg-map-all').addEventListener('change', (e) => {
        if (e.target.checked) pageRows().forEach((ch) => selected.add(ch.id)); else selected.clear();
        drawPage();
        renderBulkBar();
    });
    $('epg-map-bulk').addEventListener('click', (e) => {
        const act = e.target.closest('[data-bulk]')?.dataset.bulk;
        if (!act) return;
        const ids = [...selected];
        if (act === 'none') { selected.clear(); drawPage(); return renderBulkBar(); }
        if (act === 'accept') {
            const set = {};
            ids.forEach((id) => { const s = suggestions.get(id); if (s) set[id] = s.epgId; });
            const n = Object.keys(set).length;
            showConfirm('Accept selected suggestions?', `Assign the suggested guide data to ${n} channel${n === 1 ? '' : 's'}.`, () => whileBusy(() => apply(set)));
        } else if (act === 'reject') {
            const channelIds = ids.filter((id) => suggestions.has(id));
            channelIds.forEach((id) => suggestions.delete(id));
            fetch('/api/epg/suggest', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelIds }) });
            selected.clear();
            renderEpgMap();
        } else if (act === 'clear') {
            const clear = ids.filter((id) => overrides()[id]);
            showConfirm('Remove assignments?', `Remove the hand-picked guide data from ${clear.length} channel${clear.length === 1 ? '' : 's'}.`, () => whileBusy(() => apply({}, clear)));
        }
    });
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
        if (btn.dataset.act === 'select') {
            if (btn.checked) selected.add(ch.id); else selected.delete(ch.id);
            renderBulkBar();
        }
        else if (btn.dataset.act === 'assign') openAssign(ch);
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