/**
 * icons.js
 *
 * A centralized library of SVG icons for the ViniPlay application.
 * This makes it easy to manage, reuse, and style icons across the entire UI.
 * Each icon is a string that can be directly inserted into the DOM.
 */

// A helper function to create a standard SVG wrapper.
// This ensures all icons have consistent attributes and handles both fill and stroke icons.
const createIcon = (path, viewBox = '0 0 20 20', type = 'fill') => {
    const style = type === 'stroke'
        ? `fill="none" stroke="currentColor" stroke-width="1.5"`
        : `fill="currentColor"`;
    return `<svg class="w-5 h-5" ${style} viewBox="${viewBox}">${path}</svg>`;
};

// Line icons share one stroke style so the whole UI reads as a single set.
const line = (paths) => `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;


// --- Navigation & General UI ---
export const ICONS = {
    cancel: createIcon('<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />'),
    export: createIcon('<path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />', '0 0 24 24', 'stroke'),
    import: createIcon('<path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />', '0 0 24 24', 'stroke'),
    // NEW ICONS
    broadcast: createIcon('<path fill-rule="evenodd" d="M19.8206 5.1705C19.0181 3.7662 17.194 3.33558 15.8482 4.23275L14.9588 4.82567C12.8321 6.24349 10.3333 7.00008 7.77725 7.00008H6C3.79086 7.00008 2 8.79094 2 11.0001C2 13.1157 3.64244 14.8477 5.72178 14.9906L5.38148 16.3518C5.06822 17.6048 5.57649 18.9195 6.65117 19.636C8.10309 20.6039 10.0694 20.1617 10.9672 18.6654L12.6059 15.9342C13.4267 16.2641 14.2155 16.6789 14.9588 17.1745L15.8482 17.7674C17.194 18.6646 19.0181 18.2339 19.8206 16.8297C21.8847 13.2174 21.8847 8.7828 19.8206 5.1705ZM10.6415 15.3209C9.70759 15.109 8.74838 15.0004 7.78095 15.0001L7.32176 16.8368C7.2135 17.2699 7.38916 17.7242 7.76057 17.9719C8.26235 18.3064 8.9419 18.1536 9.25218 17.6364L10.6415 15.3209ZM16.9576 5.89685C17.3392 5.64244 17.8565 5.76455 18.0841 6.16278C19.7969 9.16021 19.7969 12.8399 18.0841 15.8374C17.8565 16.2356 17.3392 16.3577 16.9576 16.1033L16.0682 15.5104C13.613 13.8735 10.7281 13.0001 7.77725 13.0001H6C4.89543 13.0001 4 12.1046 4 11.0001C4 9.89551 4.89543 9.00008 6 9.00008H7.77725C10.7281 9.00008 13.613 8.12662 16.0682 6.48977L16.9576 5.89685Z" />', '0 0 24 24', 'stroke'),

    // --- Player Controls ---
    unmute: createIcon('<path fill-rule="evenodd" d="M1.5 4.83h2.79L8.15 1l.85.35v13l-.85.33-3.86-3.85H1.5l-.5-.5v-5l.5-.5zM4.85 10L8 13.14V2.56L4.85 5.68l-.35.15H2v4h2.5l.35.17zM15 7.83a6.97 6.97 0 0 1-1.578 4.428l-.712-.71A5.975 5.975 0 0 0 14 7.83c0-1.4-.48-2.689-1.284-3.71l.712-.71A6.971 6.971 0 0 1 15 7.83zm-2 0a4.978 4.978 0 0 1-1.002 3.004l-.716-.716A3.982 3.982 0 0 0 12 7.83a3.98 3.98 0 0 0-.713-2.28l.716-.716c.626.835.997 1.872.997 2.996zm-2 0c0 .574-.16 1.11-.44 1.566l-.739-.738a1.993 1.993 0 0 0 .005-1.647l.739-.739c.276.454.435.988.435 1.558z" clip-rule="evenodd" />'),

    // --- Tab Icons (for mobile or future use) ---

    // --- Multi-View Specific ---
    addPlayer: createIcon('<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z" clip-rule="evenodd" />'),
    removePlayer: createIcon('<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clip-rule="evenodd" />'),
    removeWidget: createIcon('<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />'), // Re-using close
    placeholderPlay: createIcon('<path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />', '0 0 24 24', 'stroke'),

    // --- DVR Specific ---
    goToGuide: createIcon('<path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" /><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />'),

    // --- General UI ---
    unlock: createIcon('<path fill-rule="evenodd" d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z" clip-rule="evenodd" />'),
    audioTrack: createIcon('<path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 0 1-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H7z" clip-rule="evenodd" />', '0 0 20 20'),
};


// --- Signal Ink line icons (24px grid, 1.8 stroke). These replace the older mixed-style set. ---
Object.assign(ICONS, {
    menu: line('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    close: line('<path d="M6 6l12 12M18 6 6 18"/>'),
    add: line('<path d="M12 5v14M5 12h14"/>'),
    edit: line('<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>'),
    trash: line('<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
    play: line('<path d="M7.5 4.8v14.4L19 12z" fill="currentColor"/>'),
    pause: line('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>'),
    stop: line('<rect x="4" y="4" width="16" height="16" rx="3"/>'),
    info: line('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.01"/>'),
    warning: line('<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.4v.01"/>'),
    calendar: line('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    star: line('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
    process: line('<path d="M20 11a8 8 0 0 0-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4.5L20 15M20 20v-5h-5"/>'),
    cast: line('<path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/><path d="M3 12a8 8 0 0 1 8 8M3 16a4 4 0 0 1 4 4"/><circle cx="3.6" cy="20" r=".9" fill="currentColor"/>'),
    pip: line('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="6.5" height="5" rx="1" fill="currentColor"/>'),
    fullscreen: line('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    audio: line('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
    mute: line('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="m16 9 5 6M21 9l-5 6"/>'),
    refresh: line('<path d="M20 11a8 8 0 0 0-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4.5L20 15M20 20v-5h-5"/>'),
    subtitles: line('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h3M13 11h4M7 15h5M15 15h2"/>'),
    guide: line('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    multiview: line('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>'),
    dvr: line('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/>'),
    notifications: line('<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>'),
    settings: line('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
    more: line('<circle cx="5.5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor"/>'),
    headphones: line('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>'),
    aspectRatio: line('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10v4M17 10v4"/>'),
    lock: line('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    check: line('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    channelList: line('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
    selectChannel: line('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
    users: line('<circle cx="12" cy="8" r="4"/><path d="M4 20.5a8 8 0 0 1 16 0"/>'),
    stopRec: line('<rect x="4" y="4" width="16" height="16" rx="3"/>'),
    home: line('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
    vod: line('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
    search: line('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
    pulse: line('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
    logout: line('<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>'),
    clock: line('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    back: line('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
    disk: line('<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M3 13l2.5-7h13L21 13M7 16.5h.01"/>'),
    server: line('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
    shield: line('<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/>'),
    tune: line('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'),
    chevronRight: line('<path d="m9 5 7 7-7 7"/>'),
    chevronDown: line('<path d="m5 9 7 7 7-7"/>'),
    chevronLeft: line('<path d="m15 5-7 7 7 7"/>'),
    keyboard: line('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
    folder: line('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    bolt: line('<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>'),
    eye: line('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
    next: line('<path d="M6 5v14l9-7z" fill="currentColor"/><path d="M18.5 5v14"/>'),
    prev: line('<path d="M18 5v14l-9-7z" fill="currentColor"/><path d="M5.5 5v14"/>'),
    back10: line('<path d="M5 12a7 7 0 1 1 2 5M5 6v6h6"/>'),
    fwd10: line('<path d="M19 12a7 7 0 1 0-2 5M19 6v6h-6"/>'),
    tv: line('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    grid: line('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>'),
    film: line('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
    rec: line('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/>'),
    bell: line('<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>'),
    gear: line('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
    user: line('<circle cx="12" cy="8" r="4"/><path d="M4 20.5a8 8 0 0 1 16 0"/>'),
    list: line('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
    cal: line('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
});
