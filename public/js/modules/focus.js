/**
 * focus.js
 * Keyboard and remote-control navigation.
 *
 * - html.kb marks "the user is driving with keys", which turns the focus ring on.
 *   It is set by key presses and cleared by the mouse or touch (never cleared on TVs).
 * - Arrow keys move focus to the nearest control in that direction (spatial navigation).
 * - Back closes the topmost layer, then returns to the rail, then goes Home.
 * - "/" opens search, "?" shows the shortcuts, "G R" and "G S" jump to Reminders and Settings.
 *
 * Samsung (Tizen) remotes send Back as keyCode 10009; most other remotes send Escape or Backspace.
 */

import { UIElements, appState } from './state.js';
import { closeModal, navigate, openModal } from './ui.js';

const FOCUSABLE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex],[data-focusable]';
const TEXT_ENTRY = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]),textarea,select';
const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const BACK_KEYS = new Set(['Escape', 'BrowserBack', 'XF86Back', 'GoBack']);

const root = document.documentElement;
const isTv = () => root.classList.contains('tv');
const typing = (el) => !!el && el.matches?.(TEXT_ENTRY);

/** The part of the page that currently owns focus: an open dialog, the account menu, or everything. */
function scope() {
    const dialogs = [...document.querySelectorAll('body > div[id$="-modal"]:not(.hidden), #mobile-nav-menu:not(.hidden), #avatar-menu:not(.hidden), #search-palette:not(.hidden)')];
    return dialogs.length ? dialogs[dialogs.length - 1] : document;
}

function visible(el) {
    if (el.disabled || el.getAttribute('tabindex') === '-2') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
}

/** Nearest visible control from `cur` in direction `dir`, or null. */
export function pickNeighbour(cur, dir, within = scope()) {
    const a = cur.getBoundingClientRect();
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    let best = null, bestScore = Infinity;
    for (const el of within.querySelectorAll(FOCUSABLE)) {
        if (el === cur || el.contains(cur) || cur.contains(el) || !visible(el)) continue;
        const b = el.getBoundingClientRect();
        const bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
        const horizontal = dir === 'left' || dir === 'right';
        const ahead = dir === 'right' ? bx > ax + 1 : dir === 'left' ? bx < ax - 1 : dir === 'down' ? by > ay + 1 : by < ay - 1;
        if (!ahead) continue;
        const gap = dir === 'right' ? b.left - a.right : dir === 'left' ? a.left - b.right : dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
        const overlap = horizontal
            ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
            : Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const off = horizontal ? Math.abs(by - ay) : Math.abs(bx - ax);
        const score = Math.max(0, gap) + 3 * Math.max(0, -overlap) + .25 * off;
        if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
}

export function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Back: close the top layer, else return to the rail, else go Home. */
function goBack() {
    const top = scope();
    if (top !== document) {
        if (top.id === 'processing-status-modal') return true;
        if (top.id === 'avatar-menu') { top.classList.add('hidden'); UIElements.avatarBtn?.focus(); return true; }
        const closer = top.querySelector('#close-modal, [id$="close-btn"], [id$="cancel-btn"], #search-palette-close');
        if (closer) closer.click(); else if (top.id.endsWith('-modal')) closeModal(top);
        return true;
    }
    const rail = UIElements.appRail;
    const active = document.activeElement;
    if (rail && !rail.contains(active) && getComputedStyle(rail).display !== 'none') {
        focusEl(rail.querySelector('.ni.active') || rail.querySelector('.ni'));
        return true;
    }
    if (window.location.pathname !== '/' && !window.location.pathname.startsWith('/home')) {
        navigate('/home');
        return true;
    }
    return false;
}

let goPending = 0;

function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;

    // Back works from anywhere except while typing (Escape still leaves a text field).
    const isBack = BACK_KEYS.has(e.key) || e.keyCode === 10009 || (e.key === 'Backspace' && !typing(target) && !target.isContentEditable);
    if (isBack) {
        root.classList.add('kb');
        if (typing(target) && e.key === 'Escape') { target.blur(); e.preventDefault(); return; }
        if (e.key === 'Escape' && document.fullscreenElement) return; // let the browser leave fullscreen
        if (goBack()) e.preventDefault();
        return;
    }

    if (typing(target)) return;

    if (ARROWS[e.key]) {
        root.classList.add('kb');
        const cur = document.activeElement;
        const usable = cur && cur !== document.body && cur.matches?.(FOCUSABLE) && !cur.matches('video,input[type="range"]');
        if (!usable) {
            // Nothing focused yet: the first arrow press lands on the page, or the rail on a TV.
            const start = isTv() ? (UIElements.appRail?.querySelector('.ni.active') || UIElements.appRail?.querySelector('.ni')) : null;
            if (start && getComputedStyle(UIElements.appRail).display !== 'none') { focusEl(start); e.preventDefault(); }
            return;
        }
        const next = pickNeighbour(cur, ARROWS[e.key]);
        if (next) { focusEl(next); e.preventDefault(); }
        else if (!cur.closest('[data-scroll-owner]')) e.preventDefault();
        return;
    }

    if (e.key === 'Tab') { root.classList.add('kb'); return; }

    if (e.key === 'Enter' && target.matches?.('[tabindex]:not(button):not(a):not(input)')) {
        root.classList.add('kb');
        e.preventDefault();
        // Items that react to a long press wait for the key to come up so a short press still means OK.
        if (!target.hasAttribute('data-longpress')) target.click();
        return;
    }

    if (e.key === '/') { e.preventDefault(); UIElements.headerSearchBtn?.click(); return; }
    if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }

    const key = e.key.toLowerCase();
    if (goPending && Date.now() - goPending < 1200) {
        goPending = 0;
        if (key === 'r') { navigate('/notifications'); e.preventDefault(); }
        else if (key === 's' && appState.currentUser?.isAdmin) { navigate('/settings'); e.preventDefault(); }
        else if (key === 'h') { navigate('/home'); e.preventDefault(); }
        else if (key === 'l') { navigate('/tvguide'); e.preventDefault(); }
        return;
    }
    if (key === 'g') goPending = Date.now();
}

export function showShortcuts() {
    const modal = document.getElementById('shortcuts-modal');
    if (modal) openModal(modal);
}

/** Wires the global listeners once. */
export function initFocus() {
    document.addEventListener('keydown', onKeyDown);
    const mouseOrTouch = () => { if (!isTv()) root.classList.remove('kb'); };
    document.addEventListener('mousedown', mouseOrTouch);
    document.addEventListener('touchstart', mouseOrTouch, { passive: true });

    document.getElementById('shortcuts-btn')?.addEventListener('click', showShortcuts);
    document.getElementById('shortcuts-close-btn')?.addEventListener('click', () => closeModal(document.getElementById('shortcuts-modal')));

    // Holding OK on a remote fires "longpress" on the focused item (the guide opens details).
    let enterTimer = 0;
    let enterTarget = null;
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.repeat || !e.target.matches?.('[data-longpress]')) return;
        enterTarget = e.target;
        enterTimer = setTimeout(() => {
            enterTimer = 0;
            enterTarget.dispatchEvent(new CustomEvent('longpress', { bubbles: true }));
        }, 550);
    });
    document.addEventListener('keyup', (e) => {
        if (e.key !== 'Enter' || !enterTarget) return;
        if (enterTimer) { clearTimeout(enterTimer); enterTimer = 0; enterTarget.click(); }
        enterTarget = null;
    });
}
