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

async function loadModels() {
    const res = await fetch(`/api/epg/ai/models?q=${encodeURIComponent($('epg-ai-model').value.trim())}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) return status(body?.error || "Couldn't load OpenRouter's model list. You can still type a model name.", true);
    $('epg-ai-models').innerHTML = body.map((m) => {
        const price = m.promptPerM === null ? '' : m.promptPerM === 0 ? ' - free' : ` - $${m.promptPerM}/M input`;
        return `<option value="${escapeHtml(m.id)}" label="${escapeHtml(m.name + price)}"></option>`;
    }).join('');
}

export function setupEpgAi() {
    if (!$('epg-ai-key')) return;
    let timer;
    $('epg-ai-model').addEventListener('focus', loadModels);
    $('epg-ai-model').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadModels, 250); });
    $('epg-ai-save-btn').addEventListener('click', async () => { if (await save()) { status(''); showNotification('AI settings saved.'); } });
    $('epg-ai-test-btn').addEventListener('click', test);
    $('epg-ai-clear-btn').addEventListener('click', () => showConfirm('Remove key?',
        'The saved OpenRouter key is deleted from the server. "Also ask AI" stops working until a new key is saved.',
        async () => { if (await save({ clearKey: true })) { status(''); showNotification('OpenRouter key removed.'); } }));
}
