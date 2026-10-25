/**
 * palette.js
 * The search palette: opens from the top bar or with "/", lists matching channels and upcoming
 * shows as you type. Enter takes the first result, which filters the guide when channels match.
 */

import { guideState } from './state.js';
import { playChannel } from './player.js';
import { navigate } from './ui.js';
import { findMatches, applyGuideSearch, openProgramDetails, progData } from './guide.js';
import { escapeHtml } from './utils.js';
import { formatTimeInZone, dayKeyInZone, isValidTimeZone } from './time.js';

const MAX_CHANNELS = 6;
const MAX_PROGRAMS = 8;
const TYPE_DELAY_MS = 150;

const $ = (id) => document.getElementById(id);

let programRows = []; // the programmes listed in the palette, by row index

export const closePalette = () => {
    $('search-palette').classList.add('hidden');
    $('header-search-btn')?.focus({ preventScroll: true });
};

/** "Today" and "Tomorrow" are dropped or named; other days show the weekday. */
const dayLabel = (date) => {
    const zone = guideState.settings.timeZone;
    const days = Math.round((Date.parse(dayKeyInZone(date, zone)) - Date.parse(dayKeyInZone(new Date(), zone))) / 86400000);
    if (days <= 0) return '';
    if (days === 1) return 'Tomorrow ';
    const weekday = new Intl.DateTimeFormat([], isValidTimeZone(zone) ? { weekday: 'short', timeZone: zone } : { weekday: 'short' }).format(date);
    return `${weekday} `;
};

const renderResults = () => {
    const term = $('search-input').value.trim();
    const results = $('palette-results');
    if (!term) {
        results.innerHTML = '<div class="palette-empty">Type a channel name, a channel number or a show.</div>';
        return;
    }

    const { channels, programs } = findMatches(term);
    const offset = guideState.settings.timezoneOffset || 0;
    programRows = programs.slice(0, MAX_PROGRAMS);
    let html = '';

    if (channels.length) {
        html += `<div class="eyebrow">Channels · ${channels.length}</div>`;
        html += `<button type="button" class="pr" data-act="filter"><span class="t">Show ${channels.length === 1 ? 'this channel' : `all ${channels.length}`} in the guide</span><small>Enter</small></button>`;
        html += channels.slice(0, MAX_CHANNELS).map(ch =>
            `<button type="button" class="pr" data-channel="${escapeHtml(ch.id)}"><img src="${escapeHtml(ch.logo)}" alt="" onerror="this.style.visibility='hidden'"><span class="t">${escapeHtml(ch.displayName || ch.name)}</span><small>${escapeHtml(ch.chno || '')}</small></button>`
        ).join('');
    }
    if (programRows.length) {
        html += `<div class="eyebrow">Shows · ${programs.length}</div>`;
        html += programRows.map(({ channel, prog }, i) => {
            const start = new Date(prog.start);
            const live = start <= Date.now();
            return `<button type="button" class="pr" data-program="${i}"><span class="t">${escapeHtml(prog.title)}<br><small>${escapeHtml(channel.displayName || channel.name)}</small></span>${live ? '<span class="pill pill-live">Live</span>' : `<small>${dayLabel(start)}${formatTimeInZone(start, guideState.settings.timeZone, offset)}</small>`}</button>`;
        }).join('');
    }
    results.innerHTML = html || '<div class="palette-empty">Nothing matches that.</div>';
};

const showInGuide = () => {
    closePalette();
    // Arriving on the guide applies the search by itself (it reads the same input).
    if (window.location.pathname.startsWith('/tvguide')) applyGuideSearch();
    else navigate('/tvguide');
};

export function setupPalette() {
    const input = $('search-input');
    let timer = 0;

    $('header-search-btn').addEventListener('click', () => {
        $('search-palette').classList.remove('hidden');
        input.focus();
        input.select();
        renderResults();
    });
    $('search-palette-close').addEventListener('click', closePalette);
    $('search-palette-scrim').addEventListener('click', closePalette);

    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(renderResults, TYPE_DELAY_MS);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(timer);
            renderResults();
            $('palette-results').querySelector('.pr')?.click(); // the first result: filter the guide, or the first show
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            $('palette-results').querySelector('.pr')?.focus();
        }
    });

    $('palette-results').addEventListener('click', (e) => {
        const row = e.target.closest('.pr');
        if (!row) return;
        if (row.dataset.act) {
            showInGuide();
            return;
        }
        closePalette();
        if (row.dataset.channel) {
            const channel = guideState.channels.find(c => c.id === row.dataset.channel);
            playChannel(channel.url, channel.displayName || channel.name, channel.id);
        } else {
            const { channel, prog } = programRows[row.dataset.program];
            openProgramDetails({ dataset: progData(channel, prog) });
        }
    });
}
