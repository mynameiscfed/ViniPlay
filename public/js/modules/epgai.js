/**
 * epgai.js
 * Admin: the OpenRouter key and model behind "Also ask AI" in Settings > Channel EPG.
 * The key is write-only: the server never sends it back, only whether one is saved and how it ends.
 */

import { appState } from './state.js';
import { apiFetch } from './api.js';
import { showNotification, showConfirm } from './ui.js';
import { escapeHtml } from './utils.js';

const $ = (id) => document.getElementById(id);
let saved = { keySet: false, keyHint: '', model: '' };

const status = (text, isError = false) => {
    $('epg-ai-status').textContent = text;
    $('epg-ai-status').classList.toggle('text-red-400', isError);
};

function render() {
    const ready = saved.keySet && !!saved.model;
    $('epg-ai-key').value = '';
    $('epg-ai-key').placeholder = saved.keySet ? `Saved, ends ...${saved.keyHint}` : 'sk-or-...';
    $('epg-ai-model').value = saved.model;
    $('epg-ai-clear-btn').disabled = !saved.keySet;
    // "Also ask AI" in Channel EPG only works once there is something to ask.
    const box = $('epg-map-ai');
    box.disabled = !ready;
    if (!ready) box.checked = false;
}

export async function renderEpgAi() {
    if (!$('epg-ai-key') || !appState.currentUser?.isAdmin) return;
    const res = await apiFetch('/api/epg/ai');
    if (res) { saved = await res.json(); render(); }
}

async function save(extra = {}) {
    const res = await apiFetch('/api/epg/ai', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: $('epg-ai-key').value, model: $('epg-ai-model').value, ...extra }),
    });
    if (!res) return false;
    saved = await res.json();
    render();
    return true;
}

// Plain fetch for these two: apiFetch only toasts failures for three seconds, and OpenRouter's own message
// ("Insufficient credits", "No auth credentials found") needs to stay on screen.
async function test() {
    if (!(await save())) return;
    if (!saved.keySet || !saved.model) return status('Enter a key and a model first.', true);
    status('Testing with a real OpenRouter request...');
    const res = await fetch('/api/epg/ai/test', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) status(`Works: ${body.model} answered${body.reply ? ` "${body.reply}"` : ''}.`);
    else status(`Test failed: ${body.error || res.statusText}`, true);
}

// The whole list is fetched once and searched here, so typing filters instantly.
let models = null;
let shown = [];
let active = -1;
let typed = false; // opening shows every model; typing narrows the list

async function loadModels() {
    if (models) return true;
    const res = await fetch('/api/epg/ai/models?all=1');
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body)) {
        status(body?.error || "Couldn't load OpenRouter's model list. You can still type a model name.", true);
        return false;
    }
    models = body;
    return true;
}

const price = (m) => (m.promptPerM === null ? '' : m.promptPerM === 0 ? 'Free' : `$${m.promptPerM}/M input`);

function drawMenu() {
    const words = $('epg-ai-model').value.toLowerCase().split(/\s+/).filter(Boolean);
    const q = typed ? words : [];
    shown = (models || []).filter((m) => q.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)));
    active = Math.min(active, shown.length - 1);
    $('epg-ai-models').innerHTML = `<div class="count">${shown.length} of ${models?.length || 0} models</div>` + shown.map((m, i) => `
        <div class="mi" role="option" id="epg-ai-model-${i}" data-model="${escapeHtml(m.id)}" aria-selected="${i === active}">
            <span>${escapeHtml(m.name)}</span><small>${escapeHtml(m.id)}${price(m) ? ` · ${price(m)}` : ''}</small>
        </div>`).join('');
    $('epg-ai-model').setAttribute('aria-activedescendant', active >= 0 ? `epg-ai-model-${active}` : '');
}

function openMenu(open) {
    $('epg-ai-models').classList.toggle('hidden', !open);
    $('epg-ai-model').setAttribute('aria-expanded', String(open));
}

async function showMenu() {
    if (!(await loadModels())) return;
    if (!$('epg-ai-models').classList.contains('hidden')) return;
    typed = false;
    active = models.findIndex((m) => m.id === $('epg-ai-model').value.trim()); // start on the current model
    drawMenu();
    openMenu(true);
    document.getElementById(`epg-ai-model-${active}`)?.scrollIntoView({ block: 'nearest' });
}

function pick(id) {
    $('epg-ai-model').value = id;
    openMenu(false);
}

export function setupEpgAi() {
    if (!$('epg-ai-key')) return;
    const input = $('epg-ai-model'), menu = $('epg-ai-models');
    input.addEventListener('focus', showMenu);
    input.addEventListener('click', showMenu);
    input.addEventListener('input', () => { typed = true; active = -1; drawMenu(); openMenu(!!models); });
    input.addEventListener('keydown', (e) => {
        if (menu.classList.contains('hidden')) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
            drawMenu();
            document.getElementById(`epg-ai-model-${active}`)?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && shown[active]) {
            e.preventDefault();
            pick(shown[active].id);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            openMenu(false);
        }
    });
    // mousedown so the pick lands before the field loses focus
    menu.addEventListener('mousedown', (e) => {
        const opt = e.target.closest('[data-model]');
        e.preventDefault();
        if (opt) pick(opt.dataset.model);
    });
    input.addEventListener('blur', () => openMenu(false));
    $('epg-ai-save-btn').addEventListener('click', async () => { if (await save()) { status(''); showNotification('AI settings saved.'); } });
    $('epg-ai-test-btn').addEventListener('click', test);
    $('epg-ai-clear-btn').addEventListener('click', () => showConfirm('Remove key?',
        'The saved OpenRouter key is deleted from the server. "Also ask AI" stops working until a new key is saved.',
        async () => { if (await save({ clearKey: true })) { status(''); showNotification('OpenRouter key removed.'); } }));
}
