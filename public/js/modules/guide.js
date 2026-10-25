/**
 * guide.js
 * * Manages all functionality related to the TV Guide,
 * including data loading, rendering, searching, and user interaction.
 *
 * REFACTORED to use UI Virtualization for high-performance rendering of large channel lists.
 */

import { appState, guideState, UIElements, dvrState } from './state.js';
import { saveUserSetting, getDeviceSetting, saveDeviceSetting } from './api.js';
import { parseM3U, escapeHtml, nowNext } from './utils.js';
import { formatTimeInZone, formatDateInZone, zoneDayStartUtc } from './time.js';
import { playChannel } from './player.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { addOrRemoveNotification, findNotificationForProgram } from './notification.js';
import { addOrRemoveDvrJob, findDvrJobForProgram, addSeriesRule, findSeriesRuleForProgram, loadSeriesRules } from './dvr.js';
import { ICONS } from './icons.js'; // MODIFIED: Import the new icon library
import { setDigitHandler, focusEl } from './focus.js';
import { isPlayerOpen } from './osd.js';

// --- Virtualization Constants ---
let rowHeight = 64; // Pixel height of one channel row. Measured from --row-h in guide.css on every render.
const OVERSCAN_COUNT = 5; // Number of extra rows to render above and below the visible area for smooth scrolling
const SEARCH_DEBOUNCE_MS = 250; // Delay between the last keystroke and re-filtering the guide

const formatGuideTime = (date) => formatTimeInZone(date, guideState.settings.timeZone, guideState.settings.timezoneOffset || 0);

// Program IDs that matched the current search, highlighted in the timeline.
let searchMatchedProgramIds = new Set();


/**
 * Returns the UTC instant that corresponds to local midnight of the selected guide date,
 * shifted by the configured timezone offset so it lines up with EPG times.
 */
const getGuideStartUtc = () => {
    const selectedDate = new Date(guideState.currentDate);
    return zoneDayStartUtc(selectedDate, guideState.settings.timeZone, guideState.settings.timezoneOffset || 0);
};

// Phones default to the now/next list, everything else to the timeline grid.
const isList = () => guideState.view === 'list' && window.innerWidth < 768;

const progId = (channelId, start, stop) => `${channelId}-${start.toISOString()}-${stop.toISOString()}`;

/** The data-* shape of a guide cell, built from a channel and one of its programmes. */
export const progData = (channel, prog) => {
    const start = new Date(prog.start), stop = new Date(prog.stop);
    return {
        channelId: channel.id, channelUrl: channel.url, channelName: channel.displayName || channel.name,
        progTitle: prog.title, progDesc: prog.desc, progStart: start.toISOString(), progStop: stop.toISOString(),
        progId: progId(channel.id, start, stop),
    };
};

/** Flips a channel's favourite flag everywhere it is shown. */
export const toggleFavorite = (channelId) => {
    const channel = guideState.channels.find(c => c.id === channelId);
    if (!channel) return false;
    channel.isFavorite = !channel.isFavorite;
    guideState.settings.favorites = guideState.channels.filter(c => c.isFavorite).map(c => c.id);
    saveUserSetting('favorites', guideState.settings.favorites);
    document.querySelectorAll(`.favorite-star[data-channel-id="${CSS.escape(channelId)}"]`)
        .forEach(star => star.classList.toggle('favorited', channel.isFavorite));
    if (UIElements.groupFilter.value === 'favorites') handleSearchAndFilter(false, true);
    return channel.isFavorite;
};

/**
 * NEW: Opens the program details modal. This is now a standalone, exportable function.
 * @param {HTMLElement} progItem - The program item element that was clicked.
 */
export function openProgramDetails(progItem) {
    console.log('[GUIDE_DEBUG] openProgramDetails function called for element:', progItem);
    if (!progItem || !progItem.dataset) {
        console.error('[GUIDE_DEBUG] openProgramDetails called with an invalid or null element.');
        return;
    }

    const programDetailsModal = document.getElementById('program-details-modal');
    if (!programDetailsModal) {
        console.error('[GUIDE_DEBUG] programDetailsModal element not found in DOM when opening details.');
        showNotification('Error: Program details modal is missing. Please refresh the page.', true);
        return;
    }

    const channelId = progItem.dataset.channelId;
    const programData = {
        title: progItem.dataset.progTitle,
        desc: progItem.dataset.progDesc,
        start: progItem.dataset.progStart,
        stop: progItem.dataset.progStop,
        channelId: channelId,
        programId: progItem.dataset.progId,
        url: progItem.dataset.channelUrl,
    };

    const channelData = guideState.channels.find(c => c.id === channelId);
    if (!channelData) {
        console.error(`[GUIDE_DEBUG] Could not find channel data for ID: ${channelId}`);
        showNotification("Error: Could not find channel data for this program.", true);
        return;
    }

    const channelName = channelData.displayName || channelData.name;
    const channelLogo = channelData.logo;
    const channelUrl = channelData.url;

    // Get fresh references to buttons inside the modal
    const detailsTitle = programDetailsModal.querySelector('#details-title');
    const detailsTime = programDetailsModal.querySelector('#details-time');
    const detailsDesc = programDetailsModal.querySelector('#details-desc');
    const detailsPlayBtn = programDetailsModal.querySelector('#details-play-btn');
    const programDetailsNotifyBtn = programDetailsModal.querySelector('#program-details-notify-btn');
    const programDetailsRecordBtn = programDetailsModal.querySelector('#details-record-btn');
    const programDetailsSeriesBtn = programDetailsModal.querySelector('#details-series-btn');
    const detailsCloseBtn = programDetailsModal.querySelector('#details-close-btn');
    const detailsFavoriteBtn = programDetailsModal.querySelector('#details-favorite-btn');

    if (detailsTitle) detailsTitle.textContent = programData.title;
    const progStart = new Date(programData.start);
    const progStop = new Date(programData.stop);
    const offset = guideState.settings.timezoneOffset || 0;
    if (detailsTime) detailsTime.textContent = `${formatGuideTime(progStart, offset)} - ${formatGuideTime(progStop, offset)}`;
    if (detailsDesc) detailsDesc.textContent = programData.desc || "No description available.";

    if (detailsPlayBtn) {
        detailsPlayBtn.onclick = () => {
            playChannel(channelUrl, channelName, channelId);
            closeModal(programDetailsModal);
        };
    }

    // Favorite button logic
    if (detailsFavoriteBtn) {
        // MODIFIED: Target the SVG icon inside the button for visual changes.
        const favoriteIcon = detailsFavoriteBtn.querySelector('.favorite-star');
        if (favoriteIcon) {
            favoriteIcon.classList.toggle('favorited', channelData.isFavorite);
        }

        detailsFavoriteBtn.onclick = (e) => {
            e.stopPropagation();
            const isFavorite = toggleFavorite(channelId);
            if (favoriteIcon) favoriteIcon.classList.toggle('favorited', isFavorite);
        };
    }

    const now = new Date();
    const programStopTime = new Date(programData.stop).getTime();
    const isProgramRelevant = programStopTime > now.getTime();

    // --- Notification Button Logic ---
    if (programDetailsNotifyBtn) {
        const notification = findNotificationForProgram(programData, channelId);
        if (isProgramRelevant) {
            programDetailsNotifyBtn.classList.remove('hidden');
            programDetailsNotifyBtn.textContent = notification ? 'Notification Set' : 'Notify Me';
            programDetailsNotifyBtn.disabled = !notification && typeof Notification !== 'undefined' && Notification.permission === 'denied';
            programDetailsNotifyBtn.classList.toggle('bg-yellow-600', !notification);
            programDetailsNotifyBtn.classList.toggle('hover:bg-yellow-700', !notification);
            programDetailsNotifyBtn.classList.toggle('bg-gray-600', !!notification);
            programDetailsNotifyBtn.classList.toggle('hover:bg-gray-500', !!notification);

            programDetailsNotifyBtn.onclick = async () => {
                await addOrRemoveNotification({
                    id: notification ? notification.id : null,
                    channelId: programData.channelId,
                    channelName: channelName,
                    channelLogo: channelLogo,
                    programTitle: programData.title,
                    programStart: programData.start,
                    programStop: programData.stop,
                    programDesc: programData.desc,
                    programId: programData.programId
                });
                const updatedNotification = findNotificationForProgram(programData, channelId);
                programDetailsNotifyBtn.textContent = updatedNotification ? 'Notification Set' : 'Notify Me';
                programDetailsNotifyBtn.classList.toggle('bg-yellow-600', !updatedNotification);
                programDetailsNotifyBtn.classList.toggle('hover:bg-yellow-700', !updatedNotification);
                programDetailsNotifyBtn.classList.toggle('bg-gray-600', !!updatedNotification);
                programDetailsNotifyBtn.classList.toggle('hover:bg-gray-500', !!updatedNotification);
                handleSearchAndFilter(false, true);
            };
        } else {
            programDetailsNotifyBtn.classList.add('hidden');
        }
    }

    // --- DVR Record Button Logic (with permission check) ---
    const hasDvrAccess = appState.currentUser?.isAdmin || appState.currentUser?.canUseDvr;
    if (programDetailsRecordBtn && hasDvrAccess) {
        const dvrJob = findDvrJobForProgram(programData);

        if (isProgramRelevant) {
            programDetailsRecordBtn.classList.remove('hidden');

            let buttonText = 'Record';
            let buttonClass = 'bg-red-600';
            let hoverClass = 'hover:bg-red-700';
            let isDisabled = false;

            if (dvrJob) {
                switch (dvrJob.status) {
                    case 'scheduled':
                        buttonText = 'Cancel Recording';
                        buttonClass = 'bg-gray-600';
                        hoverClass = 'hover:bg-gray-500';
                        break;
                    case 'recording':
                        buttonText = 'Recording...';
                        buttonClass = 'bg-red-800';
                        hoverClass = 'hover:bg-red-800';
                        isDisabled = true;
                        break;
                    case 'completed':
                    case 'error':
                        buttonText = dvrJob.status === 'completed' ? 'Recorded' : 'Error';
                        buttonClass = dvrJob.status === 'completed' ? 'bg-green-600' : 'bg-orange-600';
                        hoverClass = dvrJob.status === 'completed' ? 'hover:bg-green-600' : 'hover:bg-orange-600';
                        isDisabled = true;
                        break;
                }
            }

            programDetailsRecordBtn.textContent = buttonText;
            programDetailsRecordBtn.className = `font-bold py-2 px-4 rounded-md transition-colors ${buttonClass} ${hoverClass} text-white`;
            programDetailsRecordBtn.disabled = isDisabled;

            programDetailsRecordBtn.onclick = async () => {
                await addOrRemoveDvrJob(programData);
                closeModal(programDetailsModal);
                handleSearchAndFilter(false, true);
            };

        } else {
            programDetailsRecordBtn.classList.add('hidden');
        }
    } else if (programDetailsRecordBtn) {
        programDetailsRecordBtn.classList.add('hidden');
    }

    // --- Series Rule Button ---
    if (programDetailsSeriesBtn) {
        if (hasDvrAccess && isProgramRelevant) {
            programDetailsSeriesBtn.classList.remove('hidden');
            const updateSeriesButton = () => {
                const existing = findSeriesRuleForProgram(programData);
                programDetailsSeriesBtn.textContent = existing ? 'Series Set' : 'Record Series';
                programDetailsSeriesBtn.disabled = !!existing;
                programDetailsSeriesBtn.className = `font-bold py-2 px-4 rounded-md transition-colors ${existing ? 'bg-gray-600' : 'bg-purple-600 hover:bg-purple-700'} text-white`;
            };
            updateSeriesButton();
            programDetailsSeriesBtn.onclick = async () => {
                if (await addSeriesRule(programData)) updateSeriesButton();
            };
            loadSeriesRules().then(updateSeriesButton).catch(() => { });
        } else {
            programDetailsSeriesBtn.classList.add('hidden');
        }
    }

    if (detailsCloseBtn) {
        detailsCloseBtn.onclick = () => closeModal(programDetailsModal);
    }

    openModal(programDetailsModal);
}


// --- Data Loading and Processing ---

/**
 * Handles loading guide data from the server response.
 * @param {string} m3uContent - The M3U playlist content.
 * @param {object} epgContent - The parsed EPG JSON data.
 */
export async function handleGuideLoad(m3uContent, epgContent, shouldCenter = false) {
    console.log('[GUIDE_LOAD_DEBUG] handleGuideLoad called with shouldCenter:', shouldCenter);
    console.log('[GUIDE_LOAD_DEBUG] m3uContent length:', m3uContent?.length || 0);

    if (!m3uContent || m3uContent.trim() === '#EXTM3U') {
        guideState.channels = [];
        guideState.programs = {};
    } else {
        guideState.channels = parseM3U(m3uContent);
        guideState.programs = epgContent || {};
    }

    if (appState.db) {
        await appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.channels, 'channels');
        await appState.db.transaction(['guideData'], 'readwrite').objectStore('guideData').put(guideState.programs, 'programs');
    }

    console.log('[GUIDE_LOAD_DEBUG] About to call finalizeGuideLoad with shouldCenter:', shouldCenter);
    return finalizeGuideLoad(shouldCenter);
}

/**
 * A helper function to format a Date object into 'YYYY-MM-DD' string format for date inputs.
 * @param {Date} date - The date to format.
 * @returns {string} The formatted date string.
 */
const formatDateForInput = (date) => formatDateInZone(date, guideState.settings.timeZone);


/**
 * Scans all programs to determine the earliest start date and latest end date.
 * @returns {{minDate: Date, maxDate: Date}|null} An object with min and max dates, or null if no programs exist.
 */
const getEpgDateRange = () => {
    let minDate = null;
    let maxDate = null;

    if (!guideState.programs || Object.keys(guideState.programs).length === 0) {
        return null;
    }

    for (const channelId in guideState.programs) {
        for (const prog of guideState.programs[channelId]) {
            const startDate = new Date(prog.start);
            const stopDate = new Date(prog.stop);
            if (!minDate || startDate < minDate) {
                minDate = startDate;
            }
            if (!maxDate || stopDate > maxDate) {
                maxDate = stopDate;
            }
        }
    }

    return { minDate, maxDate };
};


/**
 * Finalizes the guide setup after data is loaded from any source (API or cache).
 * @param {boolean} shouldCenter - Indicates if the guide should auto-center to current time.
 */
export function finalizeGuideLoad(shouldCenter = false) {
    const favoriteIds = new Set(guideState.settings.favorites || []);
    guideState.channels.forEach(channel => {
        channel.isFavorite = favoriteIds.has(channel.id);
    });

    guideState.channelGroups.clear();
    guideState.channelSources.clear();
    guideState.channels.forEach(ch => {
        if (ch.group) guideState.channelGroups.add(ch.group);
        if (ch.source) guideState.channelSources.add(ch.source);
    });
    populateSourceFilter();
    populateGroupFilter();

    const epgRange = getEpgDateRange();
    if (epgRange && UIElements.guideDatePicker) {
        UIElements.guideDatePicker.min = formatDateForInput(epgRange.minDate);
        UIElements.guideDatePicker.max = formatDateForInput(epgRange.maxDate);
        UIElements.guideDatePicker.value = formatDateForInput(guideState.currentDate);
        UIElements.guideDatePicker.disabled = false;
    } else if (UIElements.guideDatePicker) {
        UIElements.guideDatePicker.disabled = true;
    }


    return handleSearchAndFilter(shouldCenter);
}

// --- Row templates ---

const starHTML = (channel) => ICONS.star.replace(
    'class="w-5 h-5"',
    `data-channel-id="${escapeHtml(channel.id)}" class="favorite-star ${channel.isFavorite ? 'favorited' : ''}"`
);

const channelAttrs = (channel) =>
    `tabindex="-1" role="button" data-longpress data-url="${escapeHtml(channel.url)}" data-name="${escapeHtml(channel.displayName || channel.name)}" data-id="${escapeHtml(channel.id)}"`;

const logoHTML = (channel) =>
    `<img class="ch-logo" src="${escapeHtml(channel.logo)}" alt="" loading="lazy" onerror="this.onerror=null;this.style.visibility='hidden'">`;

/** Channel column cell of the timeline grid. */
const channelHTML = (channel) => {
    const name = channel.displayName || channel.name;
    const source = guideState.channelSources.size > 1 && channel.source ? ` · ${channel.source}` : '';
    return `<div class="channel-info" ${channelAttrs(channel)} title="${escapeHtml(name + source)}">${logoHTML(channel)}<div class="ch-text"><div class="ch-no">${escapeHtml(channel.chno || '')}</div><div class="channel-name">${escapeHtml(name)}</div></div>${starHTML(channel)}</div>`;
};

/** Phone list row: the channel with what is on now and next. */
export const cardHTML = (channel) => {
    const { now, next } = nowNext(channel.id);
    const offset = guideState.settings.timezoneOffset || 0;
    let bar = '';
    if (now) {
        const start = new Date(now.start), stop = new Date(now.stop);
        const pct = Math.min(100, Math.max(0, ((Date.now() - start) / (stop - start)) * 100));
        bar = `<div class="gc-bar"><i><b style="width:${pct}%"></b></i><span>${Math.max(1, Math.round((stop - Date.now()) / 60000))} min left</span></div>`;
    }
    const nextHTML = next ? `<div class="gc-next">Next · ${escapeHtml(next.title)} ${formatGuideTime(new Date(next.start), offset)}</div>` : '';
    return `<div class="channel-info gcard" ${channelAttrs(channel)}>${logoHTML(channel)}<div class="gc-main"><div class="gc-top"><span class="ch-no">${escapeHtml(channel.chno || '')}</span><span>${escapeHtml(channel.displayName || channel.name)}</span></div><div class="gc-now">${escapeHtml(now ? now.title : 'No guide data')}</div>${bar}${nextHTML}</div>${starHTML(channel)}</div>`;
};

/** Programme cells of one channel row. */
const timelineHTML = (channel, guideStartUtc, timelineWidth) => {
    const now = new Date();
    const guideEnd = new Date(guideStartUtc.getTime() + guideState.guideDurationHours * 3600 * 1000);
    const offset = guideState.settings.timezoneOffset || 0;
    let cells = '';

    (guideState.programs[channel.id] || []).forEach((prog) => {
        const progStart = new Date(prog.start);
        const progStop = new Date(prog.stop);
        if (progStop < guideStartUtc || progStart > guideEnd) return;

        const durationMs = progStop - progStart;
        if (durationMs <= 0) return;

        // A programme that began before the guide is clipped to the left edge.
        let left = ((progStart.getTime() - guideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;
        let width = (durationMs / 3600000) * guideState.hourWidthPixels;
        if (left < 0) {
            width += left;
            left = 0;
        }

        const id = progId(channel.id, progStart, progStop);
        const isLive = now >= progStart && now < progStop;
        const notification = findNotificationForProgram({ ...prog, programId: id }, channel.id);
        const dvrJob = findDvrJobForProgram({ ...prog, channelId: channel.id });
        const flags = (dvrJob ? `<i class="dot st-${escapeHtml(dvrJob.status)}"></i>` : '') + (notification ? ICONS.bell : '');
        const state = [
            isLive && 'live',
            progStop < now && 'past',
            width < rowHeight * 1.9 && 'narrow',
            selection && selection.d.progId === id && 'sel',
            searchMatchedProgramIds.has(id) && 'search-match',
        ].filter(Boolean).join(' ');
        const pct = isLive ? `;--p:${(((now - progStart) / durationMs) * 100).toFixed(1)}%` : '';

        cells += `<div class="programme-item ${state}" tabindex="-1" role="button" data-longpress title="${escapeHtml(prog.title)}" style="left:${left}px;width:${Math.max(0, width - 2)}px${pct}" data-channel-url="${escapeHtml(channel.url)}" data-channel-id="${escapeHtml(channel.id)}" data-channel-name="${escapeHtml(channel.displayName || channel.name)}" data-prog-title="${escapeHtml(prog.title)}" data-prog-desc="${escapeHtml(prog.desc)}" data-prog-start="${progStart.toISOString()}" data-prog-stop="${progStop.toISOString()}" data-prog-id="${escapeHtml(id)}"><span class="fl">${flags}</span><span class="prog-title">${escapeHtml(prog.title)}</span><span class="prog-time">${formatGuideTime(progStart, offset)} - ${formatGuideTime(progStop, offset)}</span></div>`;
    });

    return `<div class="timeline-row" style="width: ${timelineWidth}px;">${cells}</div>`;
};

// --- Preview pane ---

// The cell (or channel) shown in the preview pane: { d } holds the same fields as a cell's dataset.
let selection = null;

const previewVisible = () => !!UIElements.guidePreview && UIElements.guidePreview.offsetParent !== null;

const minutesText = (min) => min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;

const renderPreview = () => {
    const d = selection && selection.d;
    const channel = d && guideState.channels.find(c => c.id === d.channelId);
    if (!channel) return;

    const offset = guideState.settings.timezoneOffset || 0;
    const start = new Date(d.progStart), stop = new Date(d.progStop), now = Date.now();
    const live = start <= now && now < stop;
    const mins = Math.max(1, Math.ceil(((live ? stop : start) - now) / 60000));

    UIElements.gpArt.innerHTML = (channel.logo ? `<img src="${escapeHtml(channel.logo)}" alt="" onerror="this.style.visibility='hidden'">` : '') + (live ? '<span class="pill pill-live">Live</span>' : '');
    UIElements.gpChno.textContent = channel.chno || '';
    UIElements.gpChannel.textContent = d.channelName;
    UIElements.gpTags.textContent = [channel.group, guideState.channelSources.size > 1 && channel.source].filter(Boolean).join(' · ');
    UIElements.gpTitle.textContent = d.progTitle;
    UIElements.gpTime.textContent = `${formatGuideTime(start, offset)} - ${formatGuideTime(stop, offset)}`;
    UIElements.gpBarFill.style.width = `${live ? ((now - start) / (stop - start)) * 100 : 0}%`;
    UIElements.gpBarFill.parentNode.style.visibility = live ? '' : 'hidden';
    UIElements.gpLeft.textContent = live ? `${minutesText(mins)} left` : now < start ? `Starts in ${minutesText(mins)}` : 'Ended';
    UIElements.gpDesc.textContent = d.progDesc || 'No description available.';
    UIElements.gpWatch.lastChild.textContent = live ? 'Watch live' : 'Watch channel';

    const star = UIElements.gpFav.querySelector('.favorite-star');
    star.dataset.channelId = channel.id;
    star.classList.toggle('favorited', !!channel.isFavorite);

    const programs = guideState.programs[channel.id] || [];
    const at = programs.findIndex(p => new Date(p.start).toISOString() === d.progStart);
    const upcoming = at < 0 ? [] : programs.slice(at + 1, at + 3);
    UIElements.gpNextList.innerHTML = upcoming.map(p =>
        `<div class="row"><span>${escapeHtml(p.title)}</span><time>${formatGuideTime(new Date(p.start), offset)}</time></div>`
    ).join('') || '<div class="row"><span>Nothing scheduled</span></div>';
};

/** Selects a cell or channel row: marks it and shows it in the preview pane. */
const selectCell = (el) => {
    let d;
    if (el.dataset.progId) {
        d = { ...el.dataset };
    } else {
        const channel = guideState.channels.find(c => c.id === el.dataset.id);
        const { now, next } = channel ? nowNext(channel.id) : {};
        if (!now && !next) return;
        d = progData(channel, now || next);
    }
    selection = { d };
    UIElements.guideGrid.querySelectorAll('.programme-item.sel').forEach(c => c.classList.remove('sel'));
    if (el.dataset.progId) el.classList.add('sel');
    renderPreview();
};

// Re-measured on each render; set by renderGuide so the minute timer can redraw the visible rows.
let refreshRows = () => { };
let nowTimer = 0;

// --- UI Rendering (virtualized: only the rows near the viewport exist) ---

/**
 * Renders the guide using UI virtualization.
 * @param {Array<object>} channelsToRender - The filtered list of channels to display.
 * @param {boolean} resetScroll - If true, scrolls the guide to the top-left.
 * @param {boolean} shouldCenter - If true, centers the guide on the current time.
 * @returns {Promise<boolean>} A promise that resolves when the initial render is complete.
 */
const renderGuide = (channelsToRender, resetScroll = false, shouldCenter = false) => {
    return new Promise((resolve) => {
        guideState.visibleChannels = channelsToRender;
        const totalRows = channelsToRender.length;
        const showNoData = totalRows === 0;

        // Distinguish "nothing loaded at all" from "filters/search matched nothing".
        const hasAnyChannels = guideState.channels.length > 0;
        UIElements.guidePlaceholder.classList.toggle('hidden', !showNoData);
        UIElements.noDataMessage.classList.toggle('hidden', !showNoData || hasAnyChannels);
        UIElements.noResultsMessage?.classList.toggle('hidden', !showNoData || !hasAnyChannels);
        UIElements.initialLoadingIndicator.classList.add('hidden');
        UIElements.guideGrid.classList.toggle('hidden', showNoData);
        if (showNoData) {
            UIElements.guideGrid.innerHTML = '';
            UIElements.guidePreview.classList.add('hidden');
            resolve(true);
            return;
        }
        UIElements.guidePreview.classList.remove('hidden');

        const guideContainer = UIElements.guideContainer;
        const guideGrid = UIElements.guideGrid;
        const list = isList();
        guideGrid.classList.toggle('view-list', list);

        // EPG times are stored as local time with a UTC suffix, so the guide start is shifted by the timezone offset.
        const guideStartUtc = getGuideStartUtc();
        const timelineWidth = guideState.guideDurationHours * guideState.hourWidthPixels;
        guideGrid.style.setProperty('--timeline-width', `${timelineWidth}px`);
        UIElements.guideDateDisplay.textContent = guideState.currentDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

        // A render with no data empties the grid, so its fixed parts are rebuilt here.
        if (!guideGrid.querySelector('.sticky-corner')) {
            guideGrid.insertAdjacentHTML('beforeend', `
                <div class="sticky-corner">
                    <button id="now-btn" type="button" class="chip on">Now</button>
                    <div id="channel-column-resize-handle" class="channel-resize-handle"></div>
                </div>
                <div class="time-bar-cell"></div>
                <div id="now-line" class="hidden"><b></b></div>`);
            UIElements.channelColumnResizeHandle = document.getElementById('channel-column-resize-handle');
            if (UIElements.channelColumnResizeHandle && window.innerWidth >= 768) {
                import('./ui.js').then(({ makeColumnResizable }) => {
                    makeColumnResizable(UIElements.channelColumnResizeHandle, guideGrid, 100, 'channelColumnWidth', '--channel-col-width');
                });
            }
        }
        if (!document.getElementById('guide-probe')) guideGrid.insertAdjacentHTML('beforeend', '<div id="guide-probe"></div>');
        rowHeight = document.getElementById('guide-probe').offsetHeight || rowHeight;

        const timeBar = guideGrid.querySelector('.time-bar-cell');
        const offset = guideState.settings.timezoneOffset || 0;
        timeBar.innerHTML = Array.from({ length: guideState.guideDurationHours }, (_, i) =>
            `<div class="tk" style="left:${i * guideState.hourWidthPixels}px;width:${guideState.hourWidthPixels}px">${formatGuideTime(new Date(guideStartUtc.getTime() + i * 3600 * 1000), offset)}</div>`
        ).join('');
        timeBar.style.width = `${timelineWidth}px`;

        guideGrid.querySelector('#virtual-content-wrapper')?.remove();
        const contentWrapper = document.createElement('div');
        contentWrapper.id = 'virtual-content-wrapper';
        contentWrapper.style.cssText = `grid-column:1 / -1;position:relative;height:${totalRows * rowHeight}px`;

        const rowContainer = document.createElement('div');
        rowContainer.id = 'virtual-row-container';
        rowContainer.style.cssText = `position:absolute;top:0;left:0;width:100%;display:grid;grid-template-columns:${list ? '1fr' : 'var(--channel-col-width, 240px) 1fr'}`;
        contentWrapper.appendChild(rowContainer);
        guideGrid.appendChild(contentWrapper);

        let lastRange = '';
        const updateVisibleRows = (force = false) => {
            const scrollTop = guideContainer.scrollTop;
            const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_COUNT);
            const endIndex = Math.min(totalRows, Math.ceil((scrollTop + guideContainer.clientHeight) / rowHeight) + OVERSCAN_COUNT);
            if (!force && `${startIndex}-${endIndex}` === lastRange) return;
            lastRange = `${startIndex}-${endIndex}`;

            // Rebuilding the rows would drop keyboard focus, so note what has it and give it back afterwards.
            const active = rowContainer.contains(document.activeElement) ? document.activeElement : null;
            const keep = active && (active.dataset.progId
                ? `[data-prog-id="${CSS.escape(active.dataset.progId)}"]`
                : `.channel-info[data-id="${CSS.escape(active.dataset.id)}"]`);

            let rowsHTML = '';
            for (let i = startIndex; i < endIndex; i++) {
                const channel = channelsToRender[i];
                rowsHTML += list ? cardHTML(channel) : channelHTML(channel) + timelineHTML(channel, guideStartUtc, timelineWidth);
            }
            rowContainer.innerHTML = rowsHTML;
            rowContainer.style.transform = `translateY(${startIndex * rowHeight}px)`;
            if (keep) rowContainer.querySelector(keep)?.focus({ preventScroll: true });
        };
        refreshRows = updateVisibleRows;

        if (guideState.scrollHandler) {
            guideContainer.removeEventListener('scroll', guideState.scrollHandler);
        }
        guideState.scrollHandler = () => updateVisibleRows();
        guideContainer.addEventListener('scroll', guideState.scrollHandler);

        // Preserve the vertical scroll position unless asked to reset.
        const currentScrollTop = guideContainer.scrollTop;
        if (resetScroll) {
            guideContainer.scrollTop = 0;
            guideContainer.scrollLeft = 0;
        } else {
            requestAnimationFrame(() => {
                guideContainer.scrollTop = currentScrollTop;
            });
        }

        // The preview pane always shows something: keep the selection if its channel is still listed, else the first channel.
        if (!selection || !channelsToRender.some(c => c.id === selection.d.channelId)) {
            const first = channelsToRender[0];
            const { now, next } = nowNext(first.id);
            selection = now || next ? { d: progData(first, now || next) } : null;
        }
        if (selection) renderPreview();

        updateVisibleRows(true);
        updateNowLine(guideStartUtc, shouldCenter);

        const nowBtn = guideGrid.querySelector('#now-btn');
        if (nowBtn) nowBtn.onclick = () => {
            const now = new Date();
            if (guideState.currentDate.toDateString() !== now.toDateString()) {
                guideState.currentDate = now;
                finalizeGuideLoad(true);
            } else {
                updateNowLine(getGuideStartUtc(), true);
            }
        };

        setTimeout(() => resolve(true), 100);
    });
};

/**
 * Updates the position of the "now" line and program states (live, past).
 * @param {Date} guideStartUtc - The start time of the current guide view in UTC.
 * @param {boolean} shouldScroll - If true, scrolls the timeline to the now line.
 */
const updateNowLine = (guideStartUtc, shouldScroll = false) => {
    const nowLineEl = document.getElementById('now-line');
    if (!nowLineEl) return;

    const now = new Date();
    const nowValue = now.getTime();
    const guideEnd = new Date(guideStartUtc.getTime() + guideState.guideDurationHours * 3600 * 1000);

    // The column can be sized in em (TV, phone), so measure it instead of trusting the saved pixel width.
    const channelInfoColWidth = UIElements.guideGrid.querySelector('.sticky-corner')?.offsetWidth || guideState.settings.channelColumnWidth;

    if (nowValue >= guideStartUtc.getTime() && nowValue <= guideEnd.getTime()) {
        const leftOffsetInScrollableArea = ((nowValue - guideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;
        nowLineEl.style.left = `${channelInfoColWidth + leftOffsetInScrollableArea}px`;
        nowLineEl.firstElementChild.textContent = formatGuideTime(now, guideState.settings.timezoneOffset || 0);
        nowLineEl.classList.remove('hidden');
        if (shouldScroll) {
            setTimeout(() => {
                const isMobile = window.innerWidth < 768;
                let scrollLeft;

                if (isMobile) {
                    scrollLeft = (channelInfoColWidth + leftOffsetInScrollableArea) - (UIElements.guideContainer.clientWidth / 2);
                } else {
                    scrollLeft = leftOffsetInScrollableArea - (UIElements.guideContainer.clientWidth / 4);
                }

                UIElements.guideContainer.scrollTo({
                    left: Math.max(0, scrollLeft),
                    behavior: 'smooth'
                });
            }, 500);
        }
    } else {
        nowLineEl.classList.add('hidden');
    }

    document.querySelectorAll('.programme-item').forEach(item => {
        const progStart = new Date(item.dataset.progStart);
        const progStop = new Date(item.dataset.progStop);
        const isLive = now >= progStart && now < progStop;
        item.classList.toggle('live', isLive);
        item.classList.toggle('past', now >= progStop);
        if (isLive) item.style.setProperty('--p', `${(((now - progStart) / (progStop - progStart)) * 100).toFixed(1)}%`);
        else item.style.removeProperty('--p');
    });
    if (isList()) refreshRows(true);
    // A programme that has just finished makes way for the next one in the preview pane.
    if (selection && now - new Date(selection.d.progStop) < 61000 && now >= new Date(selection.d.progStop)) {
        const channel = guideState.channels.find(c => c.id === selection.d.channelId);
        const upcoming = channel && nowNext(channel.id);
        if (upcoming && (upcoming.now || upcoming.next)) selection = { d: progData(channel, upcoming.now || upcoming.next) };
    }
    renderPreview();

    clearTimeout(nowTimer);
    nowTimer = setTimeout(() => updateNowLine(guideStartUtc, false), 60000);
};

/**
 * Exported helper to update NOW line position without scrolling.
 * Used when column is resized to recalculate the NOW line position.
 */
export const updateNowLinePosition = () => {
    updateNowLine(getGuideStartUtc(), false);
};

// --- Filtering and Searching ---

/**
 * Populates the playlist ("source") filter. This is the first step of the filter flow:
 * pick a playlist, then pick one of that playlist's groups.
 */
const populateSourceFilter = () => {
    const savedFilter = getDeviceSetting('activeSourceFilter', guideState.settings.activeSourceFilter);
    const counts = new Map();
    guideState.channels.forEach(ch => {
        if (ch.source) counts.set(ch.source, (counts.get(ch.source) || 0) + 1);
    });

    UIElements.sourceFilter.innerHTML = '';
    UIElements.sourceFilter.appendChild(new Option(`All Playlists (${guideState.channels.length})`, 'all'));
    [...guideState.channelSources].sort((a, b) => a.localeCompare(b)).forEach(source => {
        UIElements.sourceFilter.appendChild(new Option(`${source} (${counts.get(source) || 0})`, source));
    });

    const optionExists = Array.from(UIElements.sourceFilter.options).some(opt => opt.value === savedFilter);
    UIElements.sourceFilter.value = (savedFilter && optionExists) ? savedFilter : 'all';

    // Keep state in sync
    guideState.settings.activeSourceFilter = UIElements.sourceFilter.value;

    UIElements.sourceFilter.classList.remove('hidden');
    UIElements.sourceFilter.style.display = guideState.channelSources.size <= 1 ? 'none' : '';
};

/**
 * Populates the group filter with the groups of the currently selected playlist.
 * When several playlists exist and none is selected, only the cross-playlist views
 * (All, Favorites, Recents) are offered, so the group list never mixes playlists.
 */
const populateGroupFilter = () => {
    const selectedSource = UIElements.sourceFilter ? UIElements.sourceFilter.value : 'all';
    const savedFilter = getDeviceSetting('activeGroupFilter', guideState.settings.activeGroupFilter);
    const currentFilter = UIElements.groupFilter.value || savedFilter;
    const needsPlaylist = selectedSource === 'all' && guideState.channelSources.size > 1;

    const sourceChannels = selectedSource === 'all'
        ? guideState.channels
        : guideState.channels.filter(ch => ch.source === selectedSource);
    const groupCounts = new Map();
    if (!needsPlaylist) {
        sourceChannels.forEach(ch => {
            if (ch.group) groupCounts.set(ch.group, (groupCounts.get(ch.group) || 0) + 1);
        });
    }

    UIElements.groupFilter.innerHTML = '';
    UIElements.groupFilter.appendChild(new Option(`All Groups (${sourceChannels.length})`, 'all'));
    UIElements.groupFilter.appendChild(new Option('Favorites', 'favorites'));
    UIElements.groupFilter.appendChild(new Option('Recents', 'recents'));

    if (needsPlaylist) {
        const hint = new Option('Select a playlist to see its groups', '');
        hint.disabled = true;
        UIElements.groupFilter.appendChild(hint);
    } else if (groupCounts.size > 0) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = selectedSource === 'all' ? 'Groups' : `Groups in ${selectedSource}`;
        [...groupCounts.keys()].sort((a, b) => a.localeCompare(b)).forEach(group => {
            optgroup.appendChild(new Option(`${group} (${groupCounts.get(group)})`, group));
        });
        UIElements.groupFilter.appendChild(optgroup);
    }

    const optionExists = Array.from(UIElements.groupFilter.options).some(opt => opt.value === currentFilter && !opt.disabled);
    UIElements.groupFilter.value = (currentFilter && optionExists) ? currentFilter : 'all';

    // Keep guideState and settings in sync if group was reset
    if (guideState.settings.activeGroupFilter !== UIElements.groupFilter.value) {
        guideState.settings.activeGroupFilter = UIElements.groupFilter.value;
        saveDeviceSetting('activeGroupFilter', UIElements.groupFilter.value);
    }

    syncChips();
};

/** Marks the quick-filter chip (or the group menu, for a named group) that matches the current group. */
const syncChips = () => {
    const group = UIElements.groupFilter.value;
    UIElements.groupChips.querySelectorAll('[data-group]').forEach(chip => chip.classList.toggle('on', chip.dataset.group === group));
    UIElements.groupFilter.classList.toggle('on', !UIElements.groupChips.querySelector(`[data-group="${CSS.escape(group)}"]`));
};

/**
 * Applies the playlist filter, then optionally the group filter, to the full channel list.
 */
const getFilteredChannels = (selectedSource, selectedGroup) => {
    let channels = guideState.channels;
    if (selectedGroup === 'recents') {
        const recentIds = guideState.settings.recentChannels || [];
        channels = recentIds.map(id => guideState.channels.find(ch => ch.id === id)).filter(Boolean);
    } else if (selectedGroup === 'favorites') {
        channels = channels.filter(ch => ch.isFavorite);
    } else if (selectedGroup && selectedGroup !== 'all') {
        channels = channels.filter(ch => ch.group === selectedGroup);
    }
    if (selectedSource !== 'all') {
        channels = channels.filter(ch => ch.source === selectedSource);
    }
    return channels;
};

/**
 * Filters the guide down to channels whose name matches the search, or (depending on the
 * search scope setting) that air a matching programme on the selected day. Every word of
 * the search must appear, in any order. Matching programmes are recorded for highlighting.
 * @returns {{channels: Array<object>, programMatches: number}}
 */
const searchGuide = (pool, searchTerm, includePrograms) => {
    const tokens = searchTerm.split(/\s+/).filter(Boolean);
    const matchesAll = (text) => tokens.every(t => text.includes(t));

    const guideStartUtc = getGuideStartUtc();
    const guideEnd = new Date(guideStartUtc.getTime() + guideState.guideDurationHours * 3600 * 1000);

    const channels = [];
    let programMatches = 0;
    pool.forEach(ch => {
        const channelText = `${ch.displayName || ''} ${ch.name || ''} ${ch.chno || ''} ${ch.group || ''}`.toLowerCase();
        let isMatch = matchesAll(channelText);

        if (includePrograms) {
            (guideState.programs[ch.id] || []).forEach(prog => {
                if (!prog.title || !matchesAll(prog.title.toLowerCase())) return;
                const progStart = new Date(prog.start);
                const progStop = new Date(prog.stop);
                if (progStop < guideStartUtc || progStart > guideEnd) return;
                searchMatchedProgramIds.add(`${ch.id}-${progStart.toISOString()}-${progStop.toISOString()}`);
                programMatches++;
                isMatch = true;
            });
        }

        if (isMatch) channels.push(ch);
    });
    return { channels, programMatches };
};

/**
 * Shows or hides the bar under the guide header that summarises the active search.
 */
const updateSearchStatus = (searchTerm, channelCount, programMatches, searchedAllGroups) => {
    const statusEl = UIElements.guideSearchStatus;
    if (!statusEl) return;
    if (!searchTerm) {
        statusEl.classList.add('hidden');
        return;
    }
    const channelText = `${channelCount} channel${channelCount === 1 ? '' : 's'}`;
    const programText = programMatches > 0 ? ` · ${programMatches} matching show${programMatches === 1 ? '' : 's'} highlighted` : '';
    const scopeText = searchedAllGroups ? ' (all groups)' : '';
    UIElements.guideSearchStatusText.textContent = `${channelText} matching "${UIElements.searchInput.value.trim()}"${scopeText}${programText}`;
    statusEl.classList.remove('hidden');
};

/**
 * Filters channels based on the playlist/group dropdowns and the search box, then rerenders the guide.
 * @param {boolean} shouldCenter - Indicates if the guide should auto-center to current time.
 * @returns {Promise<boolean>} A promise that resolves when the re-render is complete.
 */
export function handleSearchAndFilter(shouldCenter = false, preserveScroll = false) {
    const searchTerm = UIElements.searchInput.value.trim().toLowerCase();
    const selectedGroup = UIElements.groupFilter.value;
    const selectedSource = UIElements.sourceFilter.value;
    const searchScope = guideState.settings.searchScope || 'channels_only_filtered';

    // 1. The base list is what the user sees when NOT searching: playlist first, then group.
    const baseFilteredChannels = getFilteredChannels(selectedSource, selectedGroup);

    // 2. A search narrows the guide itself (channels plus their programme rows).
    searchMatchedProgramIds = new Set();
    let channelsForGuide = baseFilteredChannels;
    if (searchTerm) {
        // "Unfiltered" scopes ignore the group filter but still stay within the selected playlist.
        const searchAllGroups = searchScope.endsWith('_unfiltered');
        const pool = searchAllGroups ? getFilteredChannels(selectedSource, 'all') : baseFilteredChannels;
        const { channels, programMatches } = searchGuide(pool, searchTerm, searchScope.includes('programs'));
        channelsForGuide = channels;
        updateSearchStatus(searchTerm, channels.length, programMatches, searchAllGroups && selectedGroup !== 'all');
    } else {
        updateSearchStatus('', 0, 0, false);
    }

    // 3. Finally, render the guide with the correct list of channels.
    // If preserveScroll is true, we NEVER reset.
    // If shouldCenter is true, we also don't reset (because we want to scroll to a specific place, not 0,0).
    // So we only reset if BOTH are false.
    const resetScroll = !shouldCenter && !preserveScroll;
    return renderGuide(channelsForGuide, resetScroll, shouldCenter);
};

/**
 * Re-filters the guide for the current search box value, jumping back to the first
 * matching channel and centering the timeline on the current time.
 */
export const applyGuideSearch = () => {
    if (UIElements.guideContainer) UIElements.guideContainer.scrollTop = 0;
    return handleSearchAndFilter(true);
};

/** Channels and upcoming programmes whose names contain every word of the search (used by the search palette). */
export const findMatches = (term) => {
    const tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
    const matchesAll = (text) => tokens.every(t => text.includes(t));
    const now = Date.now();
    const channels = [];
    const programs = [];
    guideState.channels.forEach(channel => {
        if (matchesAll(`${channel.displayName || ''} ${channel.name || ''} ${channel.chno || ''}`.toLowerCase())) channels.push(channel);
        (guideState.programs[channel.id] || []).forEach(prog => {
            if (prog.title && matchesAll(prog.title.toLowerCase()) && new Date(prog.stop) > now) programs.push({ channel, prog });
        });
    });
    programs.sort((a, b) => new Date(a.prog.start) - new Date(b.prog.start));
    return { channels, programs };
};

/**
 * Scrolls the guide vertically to bring a specific channel into view and confirms its visibility.
 * @param {string} channelId - The full or partial (stable) ID of the channel to scroll to.
 * @returns {Promise<boolean>} - Resolves to true once the channel element is rendered in the DOM, false otherwise.
 */
export const scrollToChannel = (channelId) => {
    return new Promise((resolve) => {
        const channelIndex = guideState.visibleChannels.findIndex(ch =>
            ch.id === channelId || ch.id.endsWith(channelId)
        );

        if (channelIndex === -1) {
            console.warn(`[GUIDE_SCROLL_FAIL] Channel with ID/suffix "${channelId}" not found in visibleChannels list.`);
            resolve(false);
            return;
        }

        const foundChannel = guideState.visibleChannels[channelIndex];
        const targetScrollTop = channelIndex * rowHeight;
        UIElements.guideContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

        // MODIFICATION: Use requestAnimationFrame for a more robust check.
        let startTime = null;
        const checkRender = (timestamp) => {
            if (!startTime) startTime = timestamp;
            const elapsedTime = timestamp - startTime;

            const channelElement = UIElements.guideGrid.querySelector(`.channel-info[data-id="${foundChannel.id}"]`);
            if (channelElement) {
                console.log(`[GUIDE_SCROLL_SUCCESS] Channel element "${foundChannel.id}" found and rendered.`);
                resolve(true);
            } else if (elapsedTime < 5000) { // 5-second timeout
                requestAnimationFrame(checkRender);
            } else {
                console.warn(`[GUIDE_SCROLL_FAIL] Timeout waiting for channel element "${foundChannel.id}" to be rendered.`);
                resolve(false);
            }
        };
        requestAnimationFrame(checkRender);
    });
};

// --- Event Listeners ---

/**
 * A channel number typed on the remote: zaps to it while watching, else moves focus to it in the guide.
 */
const goToChannel = async (digits) => {
    const watching = isPlayerOpen();
    if (!watching && !UIElements.pageGuide.classList.contains('flex')) return;
    const hasNumber = (c) => c.chno && Number(c.chno) === Number(digits);
    const channel = guideState.visibleChannels.find(hasNumber) || (watching && guideState.channels.find(hasNumber));
    if (!channel) {
        showNotification(`No channel ${Number(digits)} in this list.`, true);
    } else if (watching) {
        playChannel(channel.url, channel.displayName || channel.name, channel.id);
    } else if (await scrollToChannel(channel.id)) {
        focusEl(UIElements.guideGrid.querySelector(`.channel-info[data-id="${CSS.escape(channel.id)}"]`));
    }
};

/** CH+/CH- (or Page Down/Up): jump a cell about one hour along the focused row. */
const shiftHour = (dir) => {
    const cur = document.activeElement;
    if (!cur || !cur.classList.contains('programme-item')) {
        UIElements.guideContainer.scrollBy({ left: dir * guideState.hourWidthPixels });
        return;
    }
    const target = new Date(cur.dataset.progStart).getTime() + dir * 3600000;
    const cells = [...cur.parentNode.children];
    const hit = cells.find(c => new Date(c.dataset.progStart) <= target && target < new Date(c.dataset.progStop));
    focusEl(hit && hit !== cur ? hit : cells[cells.indexOf(cur) + dir]);
};

/**
 * Sets up all event listeners for the guide page.
 */
export function setupGuideEventListeners() {
    UIElements.groupFilter.addEventListener('change', () => {
        const selectedGroup = UIElements.groupFilter.value;
        // Save the setting for this device
        saveDeviceSetting('activeGroupFilter', selectedGroup);
        // Update local state immediately for responsiveness
        guideState.settings.activeGroupFilter = selectedGroup;
        syncChips();
        handleSearchAndFilter(true); // Auto-center when filter changes
    });
    UIElements.groupChips.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-group]');
        if (!chip) return;
        UIElements.groupFilter.value = chip.dataset.group;
        UIElements.groupFilter.dispatchEvent(new Event('change'));
    });
    UIElements.sourceFilter.addEventListener('change', () => {
        const selectedSource = UIElements.sourceFilter.value;
        // Save the setting for this device
        saveDeviceSetting('activeSourceFilter', selectedSource);
        guideState.settings.activeSourceFilter = selectedSource;
        // A new playlist means a new set of groups: start from "All Groups" of that playlist
        // unless the current selection (e.g. Favorites) still applies.
        if (!['favorites', 'recents'].includes(UIElements.groupFilter.value)) {
            UIElements.groupFilter.value = 'all';
        }
        populateGroupFilter();
        handleSearchAndFilter(true); // Auto-center when filter changes
    });

    // Searching happens in the search palette (palette.js); this bar shows and clears the active filter.
    UIElements.guideSearchClearBtn?.addEventListener('click', () => {
        UIElements.searchInput.value = '';
        applyGuideSearch();
    });

    UIElements.guideDatePicker.addEventListener('change', (e) => {
        const selectedDate = e.target.value;
        if (selectedDate) {
            const date = new Date(e.target.valueAsDate);
            const userTimezoneOffset = date.getTimezoneOffset() * 60000;
            guideState.currentDate = new Date(date.getTime() + userTimezoneOffset);

            finalizeGuideLoad(true);
        }
    });
    UIElements.guideDateBtn.addEventListener('click', () => {
        try {
            UIElements.guideDatePicker.showPicker();
        } catch (error) {
            console.error("Could not programmatically open date picker:", error);
        }
    });

    // List (now and next) or grid (timeline); phones start in the list.
    try { guideState.view = localStorage.getItem('viniplay.guideView'); } catch (e) { /* storage blocked */ }
    if (!guideState.view) guideState.view = window.innerWidth < 768 ? 'list' : 'grid';
    const syncView = () => {
        UIElements.guideViewList.classList.toggle('on', isList());
        UIElements.guideViewGrid.classList.toggle('on', !isList());
        UIElements.guideDateBtn.style.display = isList() ? 'none' : '';
    };
    const setView = (view) => {
        guideState.view = view;
        try { localStorage.setItem('viniplay.guideView', view); } catch (e) { /* storage blocked */ }
        syncView();
        handleSearchAndFilter(view === 'grid'); // the grid opens on the current time
    };
    UIElements.guideViewList.addEventListener('click', () => setView('list'));
    UIElements.guideViewGrid.addEventListener('click', () => setView('grid'));
    syncView();
    let wasList = isList();
    window.addEventListener('resize', () => {
        if (isList() === wasList) return;
        wasList = isList();
        syncView();
        handleSearchAndFilter(false, true);
    });

    // Preview pane buttons act on the selected cell.
    UIElements.gpWatch.addEventListener('click', () => {
        const d = selection && selection.d;
        if (d) playChannel(d.channelUrl, d.channelName, d.channelId);
    });
    UIElements.gpMore.addEventListener('click', () => selection && openProgramDetails({ dataset: selection.d }));
    UIElements.gpFav.addEventListener('click', () => {
        if (!selection) return;
        toggleFavorite(selection.d.channelId);
        renderPreview();
    });

    // Moving onto a cell with the keys (or clicking it) shows it in the preview pane.
    UIElements.guideGrid.addEventListener('focusin', (e) => {
        const el = e.target.closest('.programme-item, .channel-info');
        if (el && previewVisible()) selectCell(el);
    });

    UIElements.guideGrid.addEventListener('click', (e) => {
        const favoriteStar = e.target.closest('.favorite-star');
        if (favoriteStar) {
            e.stopPropagation();
            toggleFavorite(favoriteStar.dataset.channelId);
            return;
        }

        const channelInfo = e.target.closest('.channel-info');
        if (channelInfo) {
            playChannel(channelInfo.dataset.url, channelInfo.dataset.name, channelInfo.dataset.id);
            return;
        }

        const progItem = e.target.closest('.programme-item');
        if (!progItem) return;
        if (!previewVisible()) {
            openProgramDetails(progItem); // touch: no preview pane, so a tap opens the details sheet
        } else if (e.detail === 0) { // OK on a remote or Enter: watch what is on, open details for the rest
            if (progItem.classList.contains('live')) playChannel(progItem.dataset.channelUrl, progItem.dataset.channelName, progItem.dataset.channelId);
            else openProgramDetails(progItem);
        } // a mouse click only selects (done on focus); double-click opens the details
    });
    UIElements.guideGrid.addEventListener('dblclick', (e) => {
        const progItem = e.target.closest('.programme-item');
        if (progItem) openProgramDetails(progItem);
    });
    // Holding OK (see focus.js): details for a cell, favourite for a channel.
    UIElements.guideGrid.addEventListener('longpress', (e) => {
        const progItem = e.target.closest('.programme-item');
        if (progItem) { openProgramDetails(progItem); return; }
        const channelInfo = e.target.closest('.channel-info');
        if (channelInfo) toggleFavorite(channelInfo.dataset.id);
    });

    // Up and Down stay on the same moment in time: the next row's cell that covers where you were.
    // Left and Right step along the row; Right from a channel lands on what is on now (or the first visible cell) and Left leaves for the rail.
    let anchor = { el: null, t: 0 };
    const cellAt = (row, t) => {
        const cells = [...row.children];
        const start = (c) => new Date(c.dataset.progStart).getTime();
        return cells.find(c => start(c) <= t && t < new Date(c.dataset.progStop))
            || cells.reduce((best, c) => !best || Math.abs(start(c) - t) < Math.abs(start(best) - t) ? c : best, null);
    };
    UIElements.guideGrid.addEventListener('keydown', (e) => {
        const cur = e.target;
        const hour = 3600000;
        const viewLeft = getGuideStartUtc().getTime() + (UIElements.guideContainer.scrollLeft / guideState.hourWidthPixels) * hour;
        const go = (el) => {
            if (!el) return;
            e.preventDefault();
            e.stopPropagation();
            focusEl(el);
        };

        if (cur.classList.contains('channel-info') && !isList()) {
            if (e.key === 'ArrowLeft') {
                const rail = UIElements.appRail;
                if (rail && getComputedStyle(rail).display !== 'none') go(rail.querySelector('.ni.active') || rail.querySelector('.ni'));
            } else if (e.key === 'ArrowRight') {
                const viewRight = viewLeft + ((UIElements.guideContainer.clientWidth - cur.offsetWidth) / guideState.hourWidthPixels) * hour;
                go(cellAt(cur.nextElementSibling, Date.now() >= viewLeft && Date.now() <= viewRight ? Date.now() : viewLeft));
            }
            return;
        }

        if (!cur.classList.contains('programme-item')) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            go(e.key === 'ArrowLeft' ? cur.previousElementSibling || cur.parentNode.previousElementSibling : cur.nextElementSibling);
            return;
        }
        const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        let row = cur.parentNode;
        for (let i = 0; i < 2 && row; i++) row = dir > 0 ? row.nextElementSibling : row.previousElementSibling;
        if (!row) return; // first or last row: let the focus engine move on to the preview pane or stop
        if (anchor.el !== cur) {
            anchor = { el: cur, t: cur.classList.contains('live') ? Date.now() : Math.max(new Date(cur.dataset.progStart).getTime(), viewLeft) };
        }
        const hit = cellAt(row, anchor.t) || row.previousElementSibling; // a channel without guide data: land on its name
        anchor.el = hit;
        go(hit);
    });

    setDigitHandler(goToChannel);
    document.addEventListener('keydown', (e) => {
        if (!UIElements.pageGuide.classList.contains('flex') || e.target.matches('input,select,textarea') || document.querySelector('body > div[id$="-modal"]:not(.hidden)')) return;
        const dir = e.key === 'PageDown' || e.keyCode === 427 ? 1 : e.key === 'PageUp' || e.keyCode === 428 ? -1 : 0;
        if (dir) { e.preventDefault(); shiftHour(dir); }
    });
}
