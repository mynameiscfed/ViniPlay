// A Node.js server for the VINI PLAY IPTV Player. 
// Implements server-side EPG parsing, secure environment variables, and improved logging.

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { spawn, exec, execFile } = require('child_process');
const { safeGet, assertSafeUrl, assertSafeStreamUrl, blockedReason, isExemptHost, SsrfBlockedError } = require('./ssrfGuard');
const {
    normalizeDvrSettings,
    normalizeDownloadsSettings,
    normalizeLiveRewindSettings,
    validateRecordingWindow,
    overlappingJobs,
    matchingSeriesPrograms,
    isRecordingFileUsable,
    sanitizeDownloadFilename,
    liveBufferSegmentCount,
} = require('./recordingPolicy');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const SQLiteStore = require('connect-sqlite3')(session);
const { configureConnection, INDEX_DDL, ORPHAN_CLEANUP_SQL } = require('./dbConfig');
const { throttleSessionTouch } = require('./sessionTouch');
const { createLoginLimiter } = require('./loginRateLimit');
const { createUserCache } = require('./userCache');
const { createVodStore } = require('./vodStore');
const { createLibraryCache } = require('./vodLibraryCache');
const { cachedFile, writeFileAtomic } = require('./fileStore');
const { sendJson } = require('./sendJson');
const { createEpgPayload } = require('./epgPayload');
const { applyProcessed } = require('./processedSettings');
const { openMaybeGzip } = require('./compressedFile');
const { planSourceRefreshes } = require('./sourceRefresh');
const { ALLOWED_STREAM_PROTOCOLS, isAllowedStreamUrl, isPlaylistUrl } = require('./streamProtocols');
const { parseM3U, displayNameFromExtinf } = require('./m3uParser');
const { parseEpgTime } = require('./epgTime');
const { resolveStreamIdentity } = require('./streamAuth');
const { allowedSourcesFromUser, isChannelAllowed } = require('./accessControl');
const { pipeline: pipelineAsync } = require('stream/promises');
const { forEachProgramme, forEachChannel } = require('./epgStream');
const { buildTargets, createSuggester, bestMatch, CONFIDENT } = require('./epgMatch');
const { createSuggestStore, suggestChunk, runMatchJob } = require('./epgSuggest');
const { chat, pickWithLlm, listModels, searchModels, aiStatus, updateAiConfig } = require('./epgLlm');
const webpush = require('web-push');
const schedule = require('node-schedule');
const disk = require('diskusage');
const si = require('systeminformation'); // NEW: For system health monitoring
//vod processor
const { refreshVodContent } = require('./vodProcessor');
const XtreamClient = require('./xtreamClient');


// --- NEW: Live Activity Tracking for Redirects ---
const activeRedirectStreams = new Map(); // Tracks live redirect streams for the admin UI

const app = express();
const port = 8998;

// Headers that cost nothing and close a few browser-side holes. The CSP deliberately
// only covers framing/base/plugins: the app still ships inline handlers and CDN scripts,
// so a resource CSP would need a larger frontend change.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    next();
});

// Only trust X-Forwarded-For when the operator explicitly says a reverse proxy sits in front.
// TRUST_PROXY accepts anything Express's 'trust proxy' does (e.g. "1", "loopback", "10.0.0.5").
// Unset = forwarded headers are ignored and req.ip is the real socket address.
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) {
    app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? parseInt(TRUST_PROXY, 10) : TRUST_PROXY);
}
const saltRounds = 10;
const MIN_PASSWORD_LENGTH = 12;
const passwordProblem = (password) => (
    typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH
        ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
        : null
);
// Compared against when the username does not exist, so a missing user takes as long as a
// wrong password. Without it, response time tells an attacker which usernames are real.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), saltRounds);
const loginLimiter = createLoginLimiter();

// A URL can carry provider credentials in its path or query. Log only the origin.
const safeUrlForLog = (value) => {
    try {
        return new URL(value).origin;
    } catch (e) {
        return '[invalid url]';
    }
};

// Stable, non-reversible stream identity. Also used inside activeStreamProcesses keys, so
// the provider URL (and its credentials) never lands in a log line or the admin activity feed.
const streamUrlKey = (url) => crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
// Initialize global variables at the top-level scope
let notificationCheckInterval = null;
const sourceRefreshTimers = new Map();
let sourceProcessing = Promise.resolve();
let detectedHardware = { nvidia: null, intel_qsv: null, intel_vaapi: null, radeon_vaapi: null }; // MODIFIED: To store specific Intel GPU info

// Used to validate settings.
const validFFmpegLogLevels = ["debug", "verbose", "info", "warning", "error"];

/**
 * Resolves a hostname and refuses private/reserved addresses. The same environment
 * escape hatches as the image proxy apply, so LAN IPTV sources keep working.
 */
async function assertPublicHost(hostname) {
    const bare = String(hostname || '').replace(/^\[|\]$/g, '');
    if (!bare || isExemptHost(bare)) return;
    if (net.isIP(bare)) {
        const reason = blockedReason(bare);
        if (reason) throw new SsrfBlockedError(`Refusing to use ${bare}: ${reason}.`);
        return;
    }
    let addresses = [];
    try {
        addresses = await dns.promises.lookup(bare, { all: true });
    } catch (e) {
        throw new SsrfBlockedError(`Could not resolve ${bare}.`);
    }
    for (const { address } of addresses) {
        const reason = blockedReason(address);
        if (reason) throw new SsrfBlockedError(`Refusing to use ${bare} (${address}): ${reason}.`);
    }
}

/** Guards an FFmpeg/ffprobe URL before the process is spawned. */
async function assertSafeMediaUrl(rawUrl, protocols = ALLOWED_STREAM_PROTOCOLS) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (e) {
        throw new SsrfBlockedError('Invalid media URL.');
    }
    if (!protocols.includes(parsed.protocol)) {
        throw new SsrfBlockedError(`Unsupported media protocol "${parsed.protocol}".`);
    }
    await assertPublicHost(parsed.hostname);
}

async function assertSafeMediaStreamUrl(rawUrl) {
    if (!isAllowedStreamUrl(rawUrl)) throw new SsrfBlockedError('Unsupported stream URL protocol.');
    const protocol = new URL(rawUrl).protocol;
    // HTTP(S) is the path a browser/FFmpeg can use to reach internal web services.
    if (protocol === 'http:' || protocol === 'https:') {
        await assertSafeMediaUrl(rawUrl, ['http:', 'https:']);
    }
}

/** Returns free megabytes on /dvr, or null when the platform cannot report it. */
function getDvrFreeMb() {
    return new Promise((resolve) => {
        disk.check(DVR_DIR, (err, info) => {
            if (err) {
                console.warn('[DVR_STORAGE] Could not check free space:', err.message);
                return resolve(null);
            }
            resolve(info.free / (1024 * 1024));
        });
    });
}

async function assertDvrFreeSpace(settings) {
    const freeMb = await getDvrFreeMb();
    const reserveMb = settings?.dvr?.minFreeDiskMb || 0;
    if (freeMb !== null && freeMb < reserveMb) {
        return {
            ok: false,
            error: `DVR storage is low (${Math.round(freeMb)} MB free; ${reserveMb} MB required).`,
        };
    }
    return { ok: true };
}

/**
 * Builds an FFmpeg argv array from a profile command template.
 * The template is split into arguments BEFORE placeholders are substituted, so values
 * such as a stream URL or user agent always land inside a single argument and can never
 * inject extra FFmpeg options, however many spaces or quotes they contain.
 * @param {string} template - Profile command, e.g. '-i "{streamUrl}" -c copy -f mpegts pipe:1'.
 * @param {Object<string, string>} values - Placeholder name (without braces) to value.
 * @param {string} logLevel - FFmpeg log level; falls back to 'warning' if not recognised.
 * @returns {string[]}
 */
function buildFfmpegArgs(template, values, logLevel) {
    const level = validFFmpegLogLevels.includes(logLevel) ? logLevel : 'warning';
    const tokens = (String(template || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(arg => arg.replace(/^"|"$/g, ''));
    const substituted = tokens.map(arg => arg.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    ));
    return ['-v', `level+${level}`, ...substituted];
}

// --- ENHANCEMENT: For Server-Sent Events (SSE) ---
// This map will store active client connections for real-time updates.
const sseClients = new Map();

// --- CAST: Token-based authentication ---
// Stores short-lived tokens for Chromecast authentication
const activeCastTokens = new Map(); // token -> { userId, streamUrl, expiresAt }

// --- NEW: DVR State ---
const activeDvrJobs = new Map(); // Stores active node-schedule jobs
const runningFFmpegProcesses = new Map(); // Stores PIDs of running ffmpeg recordings
const activeDvrSupervisors = new Map(); // Stores active DvrSupervisor instances
const activeLiveBuffers = new Map(); // channelId -> rolling HLS rewind session

// Track discovery is cached briefly: probing every channel zap is expensive.
const streamTrackCache = new Map();
const STREAM_TRACK_CACHE_MS = 5 * 60 * 1000;

function probeStreamTracks(url, userAgent) {
    const key = `${url}\n${userAgent || ''}`;
    const hit = streamTrackCache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    return new Promise((resolve, reject) => {
        const args = ['-v', 'error'];
        if (userAgent) args.push('-user_agent', userAgent);
        args.push('-show_entries', 'stream=index,codec_type,codec_name:stream_tags=language,title', '-of', 'json', url);
        execFile('ffprobe', args, { timeout: 10000 }, (error, stdout) => {
            if (error) return reject(error);
            try {
                const parsed = JSON.parse(stdout);
                let audioOrdinal = 0;
                let subtitleOrdinal = 0;
                const audio = [];
                const subtitle = [];
                for (const stream of parsed.streams || []) {
                    if (stream.codec_type === 'audio') {
                        audio.push({
                            ordinal: audioOrdinal++,
                            index: stream.index,
                            codec: stream.codec_name || '',
                            language: stream.tags?.language || '',
                            title: stream.tags?.title || '',
                        });
                    } else if (stream.codec_type === 'subtitle') {
                        subtitle.push({
                            ordinal: subtitleOrdinal++,
                            index: stream.index,
                            codec: stream.codec_name || '',
                            language: stream.tags?.language || '',
                            title: stream.tags?.title || '',
                        });
                    }
                }
                const value = { audio, subtitle };
                streamTrackCache.set(key, { value, expires: Date.now() + STREAM_TRACK_CACHE_MS });
                if (streamTrackCache.size > 500) streamTrackCache.delete(streamTrackCache.keys().next().value);
                resolve(value);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// --- MODIFIED: Active Stream Management ---
// Now maps a unique stream key (URL + UserID) to its process info
const activeStreamProcesses = new Map();
const STREAM_INACTIVITY_TIMEOUT = 30000; // 30 seconds to kill an inactive stream process
const REDIRECT_HEARTBEAT_TIMEOUT = 75000; // 75 seconds without heartbeat to reap stale redirect stream

// --- Configuration ---
const DATA_DIR = '/data';
const DVR_DIR = '/dvr';
const LIVE_BUFFER_DIR = path.join(DVR_DIR, '.livebuffer');
const LOGS_DIR = path.join(DATA_DIR, 'logs'); // NEW: Log management directory
const VAPID_KEYS_PATH = path.join(DATA_DIR, 'vapid.json');
// The OpenRouter key and model ({apiKey, model}). A secret, so not in settings.json: /api/config sends every setting to every user.
const OPENROUTER_PATH = path.join(DATA_DIR, 'openrouter.json');
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const RAW_CACHE_DIR = path.join(SOURCES_DIR, 'raw_cache');
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image_cache'); // NEW: VOD poster image cache
const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024; // Largest poster/logo the image proxy will fetch
// SVG is deliberately absent: it can carry script and would run on our origin.
const IMAGE_PROXY_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
]);
// Posters are ~30-100 KB, so this holds tens of thousands. Oldest first out; the cache used to hold only 1000 images.
const IMAGE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const IMAGE_CACHE_CONTROL = 'public, max-age=2592000, immutable'; // 30 days; the /api middleware's no-cache must not apply to posters
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(DATA_DIR, 'viniplay.db');
const LIVE_CHANNELS_M3U_PATH = path.join(DATA_DIR, 'live_channels.m3u'); // Renamed
const LIVE_EPG_JSON_PATH = path.join(DATA_DIR, 'epg.json'); // Renamed
const VOD_MOVIES_JSON_PATH = path.join(DATA_DIR, 'vod_movies.json'); // New
const VOD_SERIES_JSON_PATH = path.join(DATA_DIR, 'vod_series.json'); // New
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const writeSettings = (settings) => writeFileAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2));
// Parsed once per change of the file instead of on every request; callers must not modify what they get.
const readChannels = cachedFile(LIVE_CHANNELS_M3U_PATH, parseM3U);
const epgPayload = createEpgPayload(cachedFile(LIVE_EPG_JSON_PATH, (text) => text));
// What the guides declare ([{id, names, sample}]), written by mergeEpg; the manual EPG picker and the suggestions search it.
const EPG_CHANNELS_JSON_PATH = path.join(DATA_DIR, 'epg_channels.json');
const readEpgChannels = cachedFile(EPG_CHANNELS_JSON_PATH, JSON.parse);
const NO_EPG_CHANNELS = [];
const readAiConfig = cachedFile(OPENROUTER_PATH, JSON.parse);
const AI_UNSET = 'AI matching is not set up: add your OpenRouter key and model in Settings > AI Matching.';
// Pending match suggestions survive refresh and restart; accept/reject mutate this same store.
const EPG_SUGGESTIONS_PATH = path.join(DATA_DIR, 'epg_suggestions.json');
const suggestStore = createSuggestStore(
    cachedFile(EPG_SUGGESTIONS_PATH, (text) => text),
    (data) => writeFileAtomic(EPG_SUGGESTIONS_PATH, data),
);
// Channel ids that already have guide data, for the match job's "unresolved" filter; parsed once per merge.
const readEpgKeys = cachedFile(LIVE_EPG_JSON_PATH, (text) => { try { return Object.keys(JSON.parse(text)); } catch (e) { return []; } });
const readEpgGuide = cachedFile(LIVE_EPG_JSON_PATH, (text) => { try { return JSON.parse(text); } catch (e) { return {}; } });
let epgSuggester; // [the list it was built from, its search]; rebuilt only when the file changes
const suggestEpg = (name, k) => {
    const list = readEpgChannels() || NO_EPG_CHANNELS;
    if (epgSuggester?.[0] !== list) epgSuggester = [list, createSuggester(list)];
    return epgSuggester[1](name, k);
};

console.log(`[INIT] Application starting. Data directory: ${DATA_DIR}, Public directory: ${PUBLIC_DIR}`);

// Ensure the data and dvr directories exist before anything writes to them (VAPID keys,
// the session secret, the database). Docker creates /data as a volume; a bare `npm start`
// does not.
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });
    if (!fs.existsSync(DVR_DIR)) fs.mkdirSync(DVR_DIR, { recursive: true });
    if (!fs.existsSync(LIVE_BUFFER_DIR)) fs.mkdirSync(LIVE_BUFFER_DIR, { recursive: true });
    if (!fs.existsSync(RAW_CACHE_DIR)) fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    if (!fs.existsSync(IMAGE_CACHE_DIR)) fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
    console.log(`[INIT] All required directories checked/created.`);
} catch (mkdirError) {
    console.error(`[INIT] FATAL: Failed to create necessary directories: ${mkdirError.message}`);
    process.exit(1);
}

// --- Automatic VAPID Key Generation ---
let vapidKeys = {};
try {
    if (fs.existsSync(VAPID_KEYS_PATH)) {
        console.log('[Push] Loading existing VAPID keys...');
        vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf-8'));
        try { fs.chmodSync(VAPID_KEYS_PATH, 0o600); } catch (e) { /* best effort */ }
    } else {
        console.log('[Push] VAPID keys not found. Generating new keys...');
        vapidKeys = webpush.generateVAPIDKeys();
        fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
        console.log('[Push] New VAPID keys generated and saved.');
    }
    const vapidContactEmail = process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@example.com';
    console.log(`[Push] Setting VAPID contact to: ${vapidContactEmail}`);
    webpush.setVapidDetails(vapidContactEmail, vapidKeys.publicKey, vapidKeys.privateKey);
} catch (error) {
    console.error('[Push] FATAL: Could not load or generate VAPID keys.', error);
}

// --- Database Setup ---
// Resolves to the journal mode in effect once the main connection is configured. The
// session store opens its own connection and waits on this before tuning itself.
let resolveDbConfigured;
const dbConfigured = new Promise((resolve) => { resolveDbConfigured = resolve; });
let resolveSchemaReady;
const schemaReady = new Promise((resolve) => { resolveSchemaReady = resolve; });

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("[DB] Error opening database:", err.message);
        process.exit(1);
    } else {
        console.log("[DB] Connected to the SQLite database.");
        db.serialize(() => {
            // WAL + synchronous=NORMAL, a 5 s busy timeout, and a larger page cache (see dbConfig.js).
            // Issued first so the journal mode is switched before the schema statements run.
            configureConnection(db, { label: 'main' }).then(resolveDbConfigured);
            db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, isAdmin INTEGER DEFAULT 0, canUseDvr INTEGER DEFAULT 0, allowed_sources TEXT)`, (err) => {
                if (err) {
                    console.error("[DB] Error creating 'users' table:", err.message);
                } else {
                    db.run("ALTER TABLE users ADD COLUMN canUseDvr INTEGER DEFAULT 0", () => { });
                    db.run("ALTER TABLE users ADD COLUMN allowed_sources TEXT", () => { });
                    // Admins bypass source filtering entirely, so their stored whitelist is
                    // irrelevant. Do NOT clear '{}': an empty whitelist now means "no sources",
                    // and turning it into NULL on boot would grant full access by accident.
                    db.run("UPDATE users SET allowed_sources = NULL WHERE isAdmin = 1", () => { });
                }
            });
            db.run(`CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (user_id, key))`);
            db.run(`CREATE TABLE IF NOT EXISTS multiview_layouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, layout_data TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, channelLogo TEXT, programTitle TEXT NOT NULL, programDesc TEXT, programStart TEXT NOT NULL, programStop TEXT NOT NULL, notificationTime TEXT NOT NULL, programId TEXT NOT NULL, status TEXT DEFAULT 'pending', triggeredAt TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notification_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL, subscription_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', updatedAt TEXT NOT NULL, FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE, FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, endTime TEXT NOT NULL, status TEXT NOT NULL, ffmpeg_pid INTEGER, filePath TEXT, profileId TEXT, userAgentId TEXT, preBufferMinutes INTEGER, postBufferMinutes INTEGER, errorMessage TEXT, isConflicting INTEGER DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run("ALTER TABLE dvr_jobs ADD COLUMN programStart TEXT", () => { });
            db.run("ALTER TABLE dvr_jobs ADD COLUMN actualStartTime TEXT", () => { });
            db.run("ALTER TABLE dvr_jobs ADD COLUMN series_rule_id INTEGER", () => { });
            db.run(`CREATE TABLE IF NOT EXISTS dvr_recordings (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, user_id INTEGER NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, durationSeconds INTEGER, fileSizeBytes INTEGER, filePath TEXT UNIQUE NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (job_id) REFERENCES dvr_jobs(id) ON DELETE SET NULL)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_series_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, enabled INTEGER DEFAULT 1, createdAt TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, channelId, programTitle), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);

            // --- NEW: VOD Tables ---
            db.run(`CREATE TABLE IF NOT EXISTS movies (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				year INTEGER,
				description TEXT,
				logo TEXT,
				tmdb_id TEXT,
				imdb_id TEXT,
				category_name TEXT,
				provider_unique_id TEXT UNIQUE,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			)`, (err) => { if (err) console.error("[DB] Error creating 'movies' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS series (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				year INTEGER,
				description TEXT,
				logo TEXT,
				tmdb_id TEXT,
				imdb_id TEXT,
				category_name TEXT,
				provider_unique_id TEXT UNIQUE,
				director TEXT,
				cast TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			)`, (err) => {
                if (err) console.error("[DB] Error creating 'series' table:", err.message);
                else {
                    db.run("ALTER TABLE series ADD COLUMN director TEXT", () => { });
                    db.run("ALTER TABLE series ADD COLUMN cast TEXT", () => { });
                }
            });

            db.run(`CREATE TABLE IF NOT EXISTS episodes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				series_id INTEGER NOT NULL,
				season_num INTEGER NOT NULL,
				episode_num INTEGER NOT NULL,
				name TEXT,
				description TEXT,
				air_date TEXT,
				duration TEXT,
				duration_secs INTEGER,
				tmdb_id TEXT,
				imdb_id TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
			)`, (err) => {
                if (err) console.error("[DB] Error creating 'episodes' table:", err.message);
                else {
                    db.run("ALTER TABLE episodes ADD COLUMN duration TEXT", () => { });
                    db.run("ALTER TABLE episodes ADD COLUMN duration_secs INTEGER", () => { });
                }
            });

            db.run(`CREATE TABLE IF NOT EXISTS vod_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id TEXT UNIQUE NOT NULL,
                category_name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`, (err) => { if (err) console.error("[DB] Error creating 'vod_categories' table:", err.message); });

            // --- NEW: VOD Relation Tables (Linking Providers to Content) ---
            // Note: Assuming 'provider_id' refers to the ID of the M3U source entry in settings
            // We'll store the source ID (e.g., 'src-12345678') as TEXT for flexibility
            db.run(`CREATE TABLE IF NOT EXISTS provider_movie_relations (
                provider_id TEXT NOT NULL,
                movie_id INTEGER NOT NULL,
                stream_id TEXT NOT NULL,
                container_extension TEXT,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, stream_id)
            )`, (err) => { if (err) console.error("[DB] Error creating 'provider_movie_relations' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS provider_series_relations (
                provider_id TEXT NOT NULL,
                series_id INTEGER NOT NULL,
                external_series_id TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, external_series_id)
            )`, (err) => { if (err) console.error("[DB] Error creating 'provider_series_relations' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS provider_episode_relations (
                provider_id TEXT NOT NULL,
                episode_id INTEGER NOT NULL,
                provider_stream_id TEXT NOT NULL, -- The stream ID for the episode from XC
                container_extension TEXT,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, episode_id)
             )`, (err) => {
                if (err) {
                    console.error("[DB] Error creating 'provider_episode_relations' table:", err.message);
                } else {
                    // Add new column non-destructively
                    db.run("ALTER TABLE provider_episode_relations ADD COLUMN container_extension TEXT", () => { });
                }
            });
            // --- END NEW VOD TABLES ---

            //-- ENHANCEMENT: Modify stream history table to include more data for the admin panel.
            db.run(`CREATE TABLE IF NOT EXISTS stream_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                channel_id TEXT,
                channel_name TEXT,
                start_time TEXT NOT NULL,
                end_time TEXT,
                duration_seconds INTEGER,
                status TEXT NOT NULL,
                client_ip TEXT,
                channel_logo TEXT,
                stream_profile_name TEXT
            )`, (err) => {
                if (!err) {
                    // Add new columns non-destructively if the table already exists
                    db.run("ALTER TABLE stream_history ADD COLUMN channel_logo TEXT", () => { });
                    db.run("ALTER TABLE stream_history ADD COLUMN stream_profile_name TEXT", () => { });
                }
            });

            // --- NEW: Watch Progress Table (Cross-device resume tracking per user) ---
            db.run(`CREATE TABLE IF NOT EXISTS watch_progress (
                user_id INTEGER NOT NULL,
                content_type TEXT NOT NULL,
                content_id TEXT NOT NULL,
                progress_seconds REAL NOT NULL DEFAULT 0,
                duration_seconds REAL NOT NULL DEFAULT 0,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, content_type, content_id)
            )`, (err) => {
                if (err) console.error("[DB] Error creating 'watch_progress' table:", err.message);
            });

            // --- Secondary indexes (idempotent; see dbConfig.js for what each one serves) ---
            INDEX_DDL.forEach((ddl) => {
                db.run(ddl, (indexErr) => {
                    if (indexErr) console.error(`[DB] Error creating index (${ddl}):`, indexErr.message);
                });
            });
            // Refresh planner statistics so the new indexes are picked correctly.
            db.run('PRAGMA optimize');
            // vodStore.ready() adds the unique keys the VOD upserts rely on (and removes duplicate episodes first).
            // The callback fires once every statement above has run, so all tables exist: a statement queued
            // here directly can be prepared before the CREATE TABLE ahead of it has executed (fresh databases).
            db.run('SELECT 1', () => {
                resolveSchemaReady();
                vodStore.ready().catch(() => { });
                ORPHAN_CLEANUP_SQL.forEach((sql) => {
                    db.run(sql, (cleanupErr) => {
                        if (cleanupErr) console.error(`[DB] Orphan cleanup failed (${sql}):`, cleanupErr.message);
                    });
                });
                // Nothing is streaming right after a start, so 'playing' rows are left over from a crash or restart.
                // The real end is unknown, so they are closed with zero length.
                db.run("UPDATE stream_history SET status = 'stopped', end_time = start_time, duration_seconds = 0 WHERE status = 'playing'", (reconcileErr) => {
                    if (reconcileErr) console.error('[DB] Could not close stale stream_history rows:', reconcileErr.message);
                });
            });

            // --- DVR Job Loading, Scheduling and Restart Recovery ---
            console.log('[DVR] Checking and recovering pending/active DVR jobs from database...');
            db.all("SELECT * FROM dvr_jobs WHERE status IN ('recording', 'reconnecting')", [], (err, activeJobs) => {
                if (err) {
                    console.error('[DVR] Error fetching interrupted DVR jobs on startup:', err.message);
                } else if (activeJobs && activeJobs.length > 0) {
                    console.log(`[DVR] Found ${activeJobs.length} in-progress recording job(s) from before restart.`);
                    activeJobs.forEach(async (job) => {
                        const now = Date.now();
                        const endTime = new Date(job.endTime).getTime();
                        if (now < endTime) {
                            console.log(`[DVR] Resuming in-progress recording for job ${job.id} ("${job.programTitle}").`);
                            scheduleDvrJob(job);
                        } else {
                            console.log(`[DVR] Job ${job.id} ("${job.programTitle}") ended while server was down. Checking file on disk...`);
                            let stats = null;
                            if (job.filePath && fs.existsSync(job.filePath)) {
                                try { stats = fs.statSync(job.filePath); } catch (e) { }
                            }
                            let durationSeconds = stats ? await getMediaDurationSeconds(job.filePath) : null;
                            if (stats && isRecordingFileUsable(stats.size, durationSeconds)) {
                                let finalFilePath = job.filePath;
                                let finalSizeBytes = stats.size;
                                const wallClockDuration = Math.max(1, Math.round((endTime - new Date(job.startTime).getTime()) / 1000));

                                if (job.filePath.endsWith('.ts')) {
                                    const remuxRes = await remuxTsToMp4(job.filePath);
                                    if (remuxRes.success) {
                                        finalFilePath = remuxRes.mp4Path;
                                        finalSizeBytes = remuxRes.fileSizeBytes;
                                        if (remuxRes.durationSeconds) durationSeconds = remuxRes.durationSeconds;
                                    }
                                }
                                if (!durationSeconds) durationSeconds = wallClockDuration;

                                db.run(`INSERT INTO dvr_recordings (job_id, user_id, channelName, programTitle, startTime, durationSeconds, fileSizeBytes, filePath) 
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [job.id, job.user_id, job.channelName, job.programTitle, job.startTime, durationSeconds, finalSizeBytes, finalFilePath],
                                    (insertErr) => {
                                        if (insertErr) {
                                            console.error(`[DVR] Error preserving interrupted recording for job ${job.id}:`, insertErr.message);
                                        } else {
                                            console.log(`[DVR] Preserved interrupted recording for job ${job.id} (${(finalSizeBytes / (1024 * 1024)).toFixed(1)} MB).`);
                                        }
                                    }
                                );
                                const actualEndTime = new Date(new Date(job.startTime).getTime() + (durationSeconds * 1000)).toISOString();
                                db.run("UPDATE dvr_jobs SET status = 'completed', endTime = ?, ffmpeg_pid = NULL, filePath = ?, errorMessage = 'Recording interrupted by server restart; partial file preserved.' WHERE id = ?", [actualEndTime, finalFilePath, job.id]);
                            } else {
                                db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = 'Server restarted and recording file was empty or missing.' WHERE id = ?", [job.id]);
                            }
                        }
                    });
                }
            });

            db.all("SELECT * FROM dvr_jobs WHERE status = 'scheduled'", [], (err, jobs) => {
                if (err) {
                    console.error('[DVR] Error fetching pending DVR jobs:', err);
                    return;
                }
                jobs.forEach(job => {
                    scheduleDvrJob(job);
                });
                console.log(`[DVR] Loaded and scheduled ${jobs.length} pending DVR jobs.`);
            });

            // Background migration: remux legacy .ts files in dvr_recordings to .mp4 for instant seeking
            db.all("SELECT id, filePath FROM dvr_recordings WHERE filePath LIKE '%.ts'", [], (err, rows) => {
                if (!err && rows && rows.length > 0) {
                    console.log(`[DVR_MIGRATION] Found ${rows.length} legacy .ts recording(s) to optimize for seekable MP4 playback.`);
                    (async () => {
                        for (const row of rows) {
                            if (fs.existsSync(row.filePath)) {
                                console.log(`[DVR_MIGRATION] Auto-remuxing recording #${row.id}: ${row.filePath}...`);
                                const res = await remuxTsToMp4(row.filePath);
                                if (res.success) {
                                    db.run("UPDATE dvr_recordings SET filePath = ?, fileSizeBytes = ?, durationSeconds = COALESCE(?, durationSeconds) WHERE id = ?",
                                        [res.mp4Path, res.fileSizeBytes, res.durationSeconds, row.id]);
                                    db.run("UPDATE dvr_jobs SET filePath = ? WHERE filePath = ?", [res.mp4Path, row.filePath]);
                                    console.log(`[DVR_MIGRATION] Recording #${row.id} successfully updated to MP4.`);
                                }
                            }
                        }
                    })();
                }
            });

            // Self-heal: Align startTime and endTime for completed recordings to actual file modification time
            db.all("SELECT r.id, r.job_id, r.filePath, r.durationSeconds, r.startTime FROM dvr_recordings r", [], (err, rows) => {
                if (!err && rows && rows.length > 0) {
                    rows.forEach(row => {
                        if (row.filePath && fs.existsSync(row.filePath)) {
                            try {
                                const stats = fs.statSync(row.filePath);
                                const fileEndTime = stats.mtime; // Real timestamp when the file was written/finalized
                                const duration = row.durationSeconds || 0;
                                const fileStartTime = new Date(fileEndTime.getTime() - (duration * 1000));

                                const currentStartMs = new Date(row.startTime).getTime();
                                // If current startTime differs by more than 2 minutes from the file's real creation time,
                                // it was an on-air recording that used the EPG start time. Fix it!
                                if (Math.abs(fileStartTime.getTime() - currentStartMs) > 2 * 60 * 1000) {
                                    console.log(`[DVR_HEAL] Correcting recording #${row.id} start/end time to match real file creation: ${fileStartTime.toISOString()} - ${fileEndTime.toISOString()}`);
                                    db.run("UPDATE dvr_recordings SET startTime = ? WHERE id = ?", [fileStartTime.toISOString(), row.id]);
                                    if (row.job_id) {
                                        db.run("UPDATE dvr_jobs SET startTime = ?, endTime = ? WHERE id = ?", [fileStartTime.toISOString(), fileEndTime.toISOString(), row.job_id]);
                                    }
                                }
                            } catch (e) {
                                console.warn('[DVR_HEAL] Error reading file stats:', e);
                            }
                        }
                    });
                }
            });
            // --- End DVR Job Loading and Scheduling ---
        });
    }
});

// --- Middleware ---
// 1. Smart Caching for API: Allow cache presence but FORCE revalidation every time.
// 'no-cache' = "Check with server before using cached copy".
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-cache, must-revalidate');
    next();
});

// 2. Smart Caching for Static Files:
// Ensure browsers and CDNs (e.g. Cloudflare) always revalidate HTML/JS/CSS without applying long TTLs
app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, path) => {
        if (path.endsWith('index.html') || path.endsWith('.js') || path.endsWith('.css')) {
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
        }
    }
}));

// CSRF: SameSite=Lax (below) is the main defence. This also rejects a state-changing
// request whose Origin names another site. Requests without an Origin (curl, native
// clients) are left alone, as they do not carry a browser session automatically.
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    let originHost;
    try {
        originHost = new URL(origin).host;
    } catch (e) {
        return res.status(403).json({ error: 'Invalid Origin header.' });
    }
    const forwardedHost = TRUST_PROXY ? String(req.get('x-forwarded-host') || '').split(',')[0].trim() : '';
    const expectedHost = forwardedHost || req.get('host');
    if (originHost !== expectedHost) {
        return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
    next();
});

app.use(bodyParser.json({ limit: '2mb' })); // the default 100kb is too small for accepting thousands of EPG matches at once
app.use(bodyParser.urlencoded({ extended: true }));

const updateAndScheduleSourceRefreshes = () => {
    console.log('[SCHEDULER] Updating and scheduling all source refreshes...');
    const plan = planSourceRefreshes(getSettings());
    const activeSourceIds = new Set();

    plan.forEach((source) => {
        activeSourceIds.add(source.id);
        if (sourceRefreshTimers.has(source.id)) {
            clearTimeout(sourceRefreshTimers.get(source.id));
        }

        console.log(`[SCHEDULER] Scheduling refresh for "${source.name}" (ID: ${source.id}) every ${source.hours} hours.`);

        const scheduleNext = () => {
            const timeoutId = setTimeout(async () => {
                if (sourceRefreshTimers.get(source.id) !== timeoutId) return;
                console.log(`[SCHEDULER_RUN] Auto-refresh triggered for "${source.name}".`);
                try {
                    const result = await runSourceProcessing(null, source.onlyIds);
                    saveProcessedSettings(result.updatedSettings);
                    if (result.success) {
                        console.log(`[SCHEDULER_RUN] Successfully refreshed and processed "${source.name}".`);
                    } else {
                        console.warn(`[SCHEDULER_RUN] ${result.message}`);
                    }
                } catch (error) {
                    console.error(`[SCHEDULER_RUN] Auto-refresh for "${source.name}" failed:`, error.message);
                }
                if (sourceRefreshTimers.get(source.id) === timeoutId) scheduleNext();
            }, source.hours * 3600 * 1000);

            sourceRefreshTimers.set(source.id, timeoutId);
        };

        scheduleNext();
    });

    for (const [sourceId, timeoutId] of sourceRefreshTimers.entries()) {
        if (!activeSourceIds.has(sourceId)) {
            console.log(`[SCHEDULER] Clearing obsolete refresh timer for source ID: ${sourceId}`);
            clearTimeout(timeoutId);
            sourceRefreshTimers.delete(sourceId);
        }
    }
    console.log(`[SCHEDULER] Finished scheduling. Active timers: ${sourceRefreshTimers.size}`);
};

const saveProcessedSettings = (processed) => writeSettings(applyProcessed(getSettings(), processed));

function saveSettings(settings) {
    try {
        settings.dvr = normalizeDvrSettings(settings.dvr || {});
        settings.downloads = normalizeDownloadsSettings(settings.downloads || {});
        settings.liveRewind = normalizeLiveRewindSettings(settings.liveRewind || {});
        const profileIds = new Set((settings.streamProfiles || []).map(profile => profile.id));
        if (settings.playerFallbackProfileId && !profileIds.has(settings.playerFallbackProfileId)) {
            settings.playerFallbackProfileId = null;
        }
        settings.allowUserQualitySwitch = settings.allowUserQualitySwitch === true;
        writeSettings(settings);
        console.log('[SETTINGS] Settings saved successfully.');
        updateAndScheduleSourceRefreshes();
    } catch (e) {
        console.error("[SETTINGS] Error saving settings:", e);
    }
}

// --- Session Management ---
// The secret never lives in settings.json: that file is sent to every user by /api/config
// and included in settings backups. A weak or missing SESSION_SECRET is replaced with a
// random secret persisted under /data, so a default install does not run on a public value.
const SESSION_SECRET_PATH = path.join(DATA_DIR, 'session-secret');
const isWeakSecret = (value) => (
    typeof value !== 'string'
    || value.trim().length < 32
    || /replace_this|your_super_secret|changeme/i.test(value)
);

function resolveSessionSecret() {
    const fromEnv = process.env.SESSION_SECRET;
    let legacy = '';
    try {
        const settings = getSettings();
        if (settings.generatedSessionSecret) {
            legacy = settings.generatedSessionSecret;
            delete settings.generatedSessionSecret;
            writeSettings(settings);
            console.log('[SECURITY] Removed the legacy session secret from settings.json.');
        }
    } catch (e) {
        console.error('[SECURITY] Could not migrate the legacy session secret:', e.message);
    }
    if (fromEnv && !isWeakSecret(fromEnv)) {
        console.log('[SECURITY] Loaded SESSION_SECRET from environment variable.');
        return fromEnv;
    }
    if (fromEnv) {
        console.warn('[SECURITY] Ignoring weak or default SESSION_SECRET from the environment.');
    }
    try {
        let secret = legacy;
        if (isWeakSecret(secret) && fs.existsSync(SESSION_SECRET_PATH)) {
            secret = fs.readFileSync(SESSION_SECRET_PATH, 'utf-8').trim();
        }
        if (!isWeakSecret(secret)) {
            try { fs.chmodSync(SESSION_SECRET_PATH, 0o600); } catch (e) { /* best effort */ }
            return secret;
        }
        secret = crypto.randomBytes(64).toString('hex');
        writeFileAtomic(SESSION_SECRET_PATH, secret, 0o600);
        console.log(`[SECURITY] Generated a session secret and saved it to ${SESSION_SECRET_PATH}.`);
        return secret;
    } catch (e) {
        console.error('[SECURITY] Could not read or write the session secret file, using an in-memory secret:', e.message);
        return crypto.randomBytes(64).toString('hex');
    }
}

const sessionSecret = resolveSessionSecret();

// connect-sqlite3 opens its own connection to viniplay.db. Give it the same busy timeout
// (and synchronous=NORMAL once WAL is confirmed) so session writes do not fail with
// SQLITE_BUSY while the main connection is busy, and stop it from writing on every request.
const sessionStore = new SQLiteStore({ db: 'viniplay.db', dir: DATA_DIR, table: 'sessions' });
dbConfigured.then(() => configureConnection(sessionStore.db, { label: 'session-store', setJournalMode: false, tuneCache: false }));
throttleSessionTouch(sessionStore);

app.use(
    session({
        store: sessionStore,
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax',
            secure: 'auto',
        },
    })
);

app.use((req, res, next) => {
    // Add client IP to the request object for logging
    req.clientIp = req.ip || req.socket.remoteAddress;

    if (req.path === '/api/events') {
        return next();
    }
    const user_info = req.session.userId ? `User ID: ${req.session.userId}, Admin: ${req.session.isAdmin}, DVR: ${req.session.canUseDvr}` : 'No session';
    // Path only: query strings on /stream carry provider usernames and passwords.
    console.log(`[HTTP_TRACE] ${req.method} ${req.path} - IP: ${req.clientIp} - Session: [${user_info}]`);
    next();
});

// User rows are cached for a few seconds (and invalidated on update/delete) so requireAuth
// and the endpoints that need allowed_sources do not each hit the database.
const userCache = createUserCache({
    load: (id) => dbGet(db, "SELECT id, username, isAdmin, canUseDvr, allowed_sources FROM users WHERE id = ?", [id]),
});

// requireAuth checks that the user still exists, and keeps the role flags in the session in
// sync with the database so a promotion or demotion takes effect without logging in again.
const requireAuth = async (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Authentication required.' });
    }

    let user;
    try {
        user = await userCache.get(req.session.userId);
    } catch (err) {
        console.error('[AUTH_MIDDLEWARE] DB error checking user existence:', err);
        return res.status(500).json({ error: 'Server error during authentication.' });
    }
    if (!user) {
        console.warn(`[AUTH_MIDDLEWARE] User ID ${req.session.userId} from session not found in DB. Destroying session.`);
        req.session.destroy();
        res.clearCookie('connect.sid');
        return res.status(401).json({ error: 'User account no longer exists. Please log in again.' });
    }

    req.user = user;
    const isAdmin = user.isAdmin === 1;
    const canUseDvr = user.canUseDvr === 1;
    if (req.session.isAdmin !== isAdmin) req.session.isAdmin = isAdmin;
    if (req.session.canUseDvr !== canUseDvr) req.session.canUseDvr = canUseDvr;
    if (req.session.username !== user.username) req.session.username = user.username;
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    return res.status(403).json({ error: 'Administrator privileges required.' });
};
const requireDvrAccess = (req, res, next) => {
    if (req.session && (req.session.canUseDvr || req.session.isAdmin)) return next();
    return res.status(403).json({ error: 'DVR access required.' });
};

// Recordings are private: only the owner (or an admin) may fetch the file. The lookup also
// replaces express.static here so a filename cannot point outside the recordings directory.
app.get('/dvr/:file', requireAuth, (req, res) => {
    if (req.params.file !== path.basename(req.params.file)) {
        return res.status(400).send('Invalid file name.');
    }
    const filePath = path.join(DVR_DIR, req.params.file);
    const query = req.session.isAdmin
        ? "SELECT filePath FROM dvr_recordings WHERE filePath = ?"
        : "SELECT filePath FROM dvr_recordings WHERE filePath = ? AND user_id = ?";
    const params = req.session.isAdmin ? [filePath] : [filePath, req.session.userId];
    db.get(query, params, (err, recording) => {
        if (err) return res.status(500).send('Could not look up the recording.');
        if (!recording) return res.status(404).send('Recording not found.');
        res.sendFile(recording.filePath);
    });
});

// --- Helper Functions ---
/**
 * NEW: Sends a real-time status update to the client during source processing.
 * @param {object} req - The Express request object, used to identify the user.
 * @param {string} message - The status message to send.
 * @param {string} type - The type of message (e.g., 'info', 'success', 'error').
 */
function sendProcessingStatus(req, message, type = 'info') {
    if (req && req.session && req.session.userId) {
        sendSseEvent(req.session.userId, 'processing-status', { message, type });
    }
}

// --- Database Helper Functions ---
/**
 * Promisified version of db.run
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object>} - { lastID, changes }
 */
const dbRun = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

/**
 * Promisified version of db.get
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object|null>} - The first row found.
 */
const dbGet = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

/**
 * Promisified version of db.all
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<Array>} - An array of rows.
 */
const dbAll = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};
// --- End Database Helper Functions ---

// Serialized /api/vod/library responses, dropped whenever the VOD catalog changes.
const vodLibraryCache = createLibraryCache();
const vodStore = createVodStore({ db, dbRun, dbAll, dbGet });


/**
 * NEW: Extracts GPU details from vainfo output.
 */
function extractVainfoGPUDetails(vainfo_stdout) {
    const start_tag = "Driver version: ";
    const end_tag = "vainfo: Supported profile";

    let vainfo_gpu_details = vainfo_stdout.substring(
        vainfo_stdout.indexOf(start_tag) + start_tag.length,
        vainfo_stdout.lastIndexOf(end_tag) - 1
    );
    // If we can't find the relevant GPU info section, return all to debug.
    // Likely means the output format of vainfo has been changed.
    if (vainfo_gpu_details === "") {
        vainfo_gpu_details = vainfo_stdout;
    } else {
        console.log(`[HW] Detected: ${vainfo_gpu_details}`)
    }
    return vainfo_gpu_details;
}

/**
 * NEW: Detects available hardware for transcoding.
 */
async function detectHardwareAcceleration() {

    // When a new unhandled GPU is found, add the driver name to the appropriate
    // array of gpu drivers for detection.
    const vaapi_radeon_gpu_drivers = ["r600_drv_video.so", "radeonsi_drv_video.so"];
    const intel_qsv_gpu_drivers = ["iHD_drv_video.so"];
    const intel_vaapi_gpu_drivers = ["i965_drv_video.so"];

    console.log('[HW] Detecting hardware acceleration capabilities...');
    // Detect NVIDIA GPU
    exec('nvidia-smi --query-gpu=gpu_name --format=csv,noheader', (err, stdout, stderr) => {
        if (err || stderr) {
            console.log('[HW] NVIDIA GPU not detected or nvidia-smi failed.');
        } else {
            const gpuName = stdout.trim();
            detectedHardware.nvidia = gpuName;
            console.log(`[HW] NVIDIA GPU detected: ${gpuName}`);
        }
    });

    // MODIFIED: Use 'vainfo' for more robust detection of AMD, Intel VA-API
    // and QSV GPUs. vainfo gives driver detection info on stderr and full
    // detected GPU detail on stdout.
    exec('vainfo', (err, stdout, stderr) => {
        if (stderr) {
            let found = false;
            const trimmed_stdout = stdout.trim()

            // Intel qsv driver is for modern Intel GPUs (Gen9+) and is preferred for QSV
            if (intel_qsv_gpu_drivers.some(substring => stderr.includes(substring))) {
                detectedHardware.intel_qsv = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }
            // AMD Radeon detection
            if (vaapi_radeon_gpu_drivers.some(substring => stderr.includes(substring))) {
                detectedHardware.radeon_vaapi = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }
            // Intel vaapi driver is for older Intel GPUs (pre-Gen9)
            if (intel_vaapi_gpu_drivers.some(substring => stderr.includes(substring))) {
                detectedHardware.intel_vaapi = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }

            if (!found) {
                // Show full vainfo output for info/debug purposes.
                console.log("[HW] vainfo did not detect any recognized GPU");
                if (stderr) {
                    console.log(`[HW] vainfo init (stderr): ${stderr.trim()}`);
                }
                if (stdout) {
                    console.log(`[HW] vainfo GPU info (stdout): ${stdout.trim()}`);
                }
            }
        }
    });
}

// MODIFIED: This function is now mostly for multi-view scenarios.
// Single-user streams are handled more directly.
function cleanupInactiveStreams() {
    const now = Date.now();
    console.log(`[JANITOR] Running cleanup for inactive streams. Active transcoded: ${activeStreamProcesses.size}, Active redirects: ${activeRedirectStreams.size}`);

    let shouldBroadcast = false;

    activeStreamProcesses.forEach((streamInfo, streamKey) => {
        if (streamInfo.references <= 0 && (now - streamInfo.lastAccess > STREAM_INACTIVITY_TIMEOUT)) {
            console.log(`[JANITOR] Found stale stream process for key: ${streamKey}. Terminating PID: ${streamInfo.process.pid}.`);
            try {
                // Also update the history entry if it exists
                if (streamInfo.historyId) {
                    const endTime = new Date().toISOString();
                    const duration = Math.round((new Date(endTime).getTime() - new Date(streamInfo.startTime).getTime()) / 1000);
                    db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                        [endTime, duration, streamInfo.historyId]);
                }
                streamInfo.process.kill('SIGKILL');
                activeStreamProcesses.delete(streamKey);
                shouldBroadcast = true;
            } catch (e) {
                console.warn(`[JANITOR] Error killing stale process for ${streamKey}: ${e.message}`);
                activeStreamProcesses.delete(streamKey);
                shouldBroadcast = true;
            }
        }
    });

    // NEW: Clean up stale redirect streams that stopped sending heartbeats
    activeRedirectStreams.forEach((info, streamKey) => {
        const lastHeartbeat = info.lastHeartbeat || new Date(info.startTime).getTime();
        if (now - lastHeartbeat > REDIRECT_HEARTBEAT_TIMEOUT) {
            const staleDurationSec = Math.round((now - lastHeartbeat) / 1000);
            console.log(`[JANITOR] Found stale redirect stream for key: ${streamKey} (no heartbeat for ${staleDurationSec}s). Closing session.`);
            try {
                if (info.historyId) {
                    const endTime = new Date(lastHeartbeat).toISOString();
                    const duration = Math.round((new Date(endTime).getTime() - new Date(info.startTime).getTime()) / 1000);
                    db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                        [endTime, Math.max(0, duration), info.historyId],
                        (err) => {
                            if (err) console.error(`[JANITOR] Error updating stream_history for stale redirect stream ${info.historyId}:`, err.message);
                        }
                    );
                }
                activeRedirectStreams.delete(streamKey);
                shouldBroadcast = true;
            } catch (e) {
                console.warn(`[JANITOR] Error cleaning up stale redirect stream for ${streamKey}: ${e.message}`);
                activeRedirectStreams.delete(streamKey);
                shouldBroadcast = true;
            }
        }
    });

    if (shouldBroadcast) {
        broadcastAdminUpdate();
    }
}

function sendSseEvent(userId, eventName, data) {
    const clients = sseClients.get(userId);
    if (clients && clients.length > 0) {
        console.log(`[SSE] Sending event '${eventName}' to ${clients.length} client(s) for user ID ${userId}.`);
        const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        clients.forEach(client => client.res.write(message));
    }
}

//-- ENHANCEMENT: New function to broadcast activity updates to all connected admins.
function broadcastAdminUpdate() {
    // Combine transcoded and redirect streams into one list for the live view
    const transcodedLive = Array.from(activeStreamProcesses.values()).map(info => ({
        streamKey: info.streamKey,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: true,
    }));

    const redirectLive = Array.from(activeRedirectStreams.values()).map(info => ({
        // Use historyId for redirect streamKey to ensure it's unique per session
        streamKey: `${info.userId}::${info.historyId}`,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: false,
    }));

    const combinedLiveActivity = [...transcodedLive, ...redirectLive];

    for (const clients of sseClients.values()) {
        clients.forEach(client => {
            if (client.isAdmin) {
                const message = `event: activity-update\ndata: ${JSON.stringify({ live: combinedLiveActivity })}\n\n`;
                client.res.write(message);
            }
        });
    }
    console.log(`[SSE_ADMIN] Broadcasted combined activity update (${combinedLiveActivity.length} live streams) to all connected admins.`);
}

// NEW: Broadcasts an event to ALL connected clients, regardless of user.
function broadcastSseToAll(eventName, data) {
    const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    let clientCount = 0;
    for (const clients of sseClients.values()) {
        clients.forEach(client => {
            client.res.write(message);
            clientCount++;
        });
    }
    console.log(`[SSE_BROADCAST] Broadcasted event '${eventName}' to ${clientCount} total clients.`);
}

function getSettings() {
    const defaultSettings = {
        m3uSources: [],
        epgSources: [],
        userAgents: [{ id: `default-ua-1724778434000`, name: 'ViniPlay Default', value: 'VLC/3.0.20 (Linux; x86_64)', isDefault: true }],
        streamProfiles: [
            { id: 'redirect', name: 'Redirect (No Transcoding)', command: 'redirect', isDefault: true },
            { id: 'ffmpeg-default', name: 'ffmpeg (Built in)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-fmp4', name: 'ffmpeg fMP4 (CPU)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v libx264 -preset ultrafast -c:a aac -b:a 192k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'ffmpeg-fmp4-nvidia', name: 'ffmpeg fMP4 (NVIDIA)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 192k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia', name: 'ffmpeg (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -re -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia-reconnect', name: 'ffmpeg (NVIDIA reconnect)', command: '-user_agent "{userAgent}" -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-intel', name: 'ffmpeg (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-vaapi', name: 'ffmpeg (VA-API) Intel', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-vaapi-amd', name: 'ffmpeg (VA-API) Radeon/AMD', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false }
        ],
        dvr: {
            preBufferMinutes: 1,
            postBufferMinutes: 2,
            maxConcurrentRecordings: 1,
            autoDeleteDays: 0,
            minFreeDiskMb: 5120,
            maxRecordingHours: 0,
            retainNewestGb: 0,
            activeRecordingProfileId: 'dvr-ts-default', // **MODIFIED: Point to the new default profile**
            recordingProfiles: [
                // The primary default for timeshifting, uses almost no CPU.
                { id: 'dvr-ts-default', name: 'Default TS (Stream Copy, Timeshiftable)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -c copy -f mpegts -mpegts_flags +resend_headers "{filePath}"', isDefault: true },

                // The new GPU-accelerated option for timeshifting.
                { id: 'dvr-ts-nvidia', name: 'NVIDIA NVENC TS (Timeshiftable)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts -mpegts_flags +resend_headers "{filePath}"', isDefault: false },
                { id: 'dvr-ts-nvidia-reconnect', name: 'NVIDIA NVENC TS reconnect', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts -mpegts_flags +resend_headers "{filePath}"', isDefault: false },

                // Legacy MP4 profiles, no longer default.
                { id: 'dvr-mp4-default', name: 'Legacy MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-nvidia', name: 'NVIDIA NVENC MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-intel', name: 'Intel QSV MP4 (H.264/AAC)', command: '-hwaccel qsv -hwaccel_output_format qsv -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -c:v h264_qsv -preset medium -vf scale_qsv=format=nv12 -c:a aac -ac 2 -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                // NEW: Add this line for VA-API recording
                { id: 'dvr-mp4-vaapi', name: 'VA-API MP4 (H.264/AAC)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-radeon-vaapi', name: 'Radeon/AMD VA-API MP4 (H.264/AAC)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 10 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -rw_timeout 15000000 -analyzeduration 10000000 -probesize 10000000 -fflags +genpts+discardcorrupt -i "{streamUrl}" -c:v h264_vaapi -preset medium -vf scale_vaapi=format=nv12 -c:a aac -ac 2 -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false }
            ]
        },
        castProfiles: [
            { id: 'cast-default', name: 'Cast Default (CPU)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: true },
            { id: 'cast-nvidia', name: 'Cast (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-intel', name: 'Cast (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-vaapi', name: 'Cast (VA-API Intel)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-vaapi-amd', name: 'Cast (VA-API Radeon/AMD)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false }
        ],
        activeCastProfileId: 'cast-default',
        activeUserAgentId: `default-ua-1724778434000`,
        activeStreamProfileId: 'redirect',
        playerFallbackProfileId: null,
        allowUserQualitySwitch: false,
        downloads: {
            enabled: true,
            maxConcurrent: 2
        },
        liveRewind: {
            enabled: false,
            minutes: 15,
            diskCapMb: 4096
        },
        playerLogLevel: 'warning',
        dvrLogLevel: 'warning',
        searchScope: 'all_channels_unfiltered',
        timeZone: null,
        timezoneOffset: 0,
        notificationLeadTime: 10,
        sourcesLastUpdated: null,
        epgOverrides: {}, // channel id -> XMLTV channel id, set by an admin; wins over every automatic match
        clientTelemetryEnabled: false,
        logs: {
            maxFiles: 5,
            maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
            autoDeleteDays: 7
        }
    };

    if (!fs.existsSync(SETTINGS_PATH)) {
        console.log('[SETTINGS] settings.json not found, creating default settings.');
        writeSettings(defaultSettings);
        return defaultSettings;
    }
    try {
        let settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

        // --- SETTINGS MIGRATION LOGIC ---
        // This is the correct place to handle/validate newly added settings during startup.
        // Otherwise users will potentially have errors when migrating to new viniplay
        // versions that expect new settings.
        let needsSave = false;

        defaultSettings.streamProfiles.forEach(defaultProfile => {
            const existingProfile = settings.streamProfiles.find(p => p.id === defaultProfile.id);
            if (!existingProfile) {
                console.log(`[SETTINGS_MIGRATE] Adding missing stream profile: ${defaultProfile.name}`);
                settings.streamProfiles.push(defaultProfile);
                needsSave = true;
            } else if (existingProfile.isDefault) {
                // FINAL FIX: Forcibly update the command of default profiles to ensure users get the latest fixes.
                if (existingProfile.command !== defaultProfile.command) {
                    console.log(`[SETTINGS_MIGRATE] Updating outdated default stream profile command for: ${defaultProfile.name}`);
                    existingProfile.command = defaultProfile.command;
                    needsSave = true;
                }
            }
        });

        if (!settings.dvr) {
            console.log(`[SETTINGS_MIGRATE] Initializing DVR settings block.`);
            settings.dvr = defaultSettings.dvr;
            needsSave = true;
        } else {
            defaultSettings.dvr.recordingProfiles.forEach(defaultProfile => {
                const existingProfile = settings.dvr.recordingProfiles.find(p => p.id === defaultProfile.id);
                if (!existingProfile) {
                    console.log(`[SETTINGS_MIGRATE] Adding missing DVR recording profile: ${defaultProfile.name}`);
                    settings.dvr.recordingProfiles.push(defaultProfile);
                    needsSave = true;
                } else if (existingProfile.isDefault || !existingProfile.command.includes('-reconnect_on_network_error 1')) {
                    // Update built-in default DVR profiles with the new resilient command
                    if (existingProfile.command !== defaultProfile.command) {
                        console.log(`[SETTINGS_MIGRATE] Updating outdated DVR profile command with resilient flags for: ${defaultProfile.name}`);
                        existingProfile.command = defaultProfile.command;
                        needsSave = true;
                    }
                }
            });
        }

        // Cast profiles migration
        if (!settings.castProfiles) {
            console.log(`[SETTINGS_MIGRATE] Initializing Cast profiles block.`);
            settings.castProfiles = defaultSettings.castProfiles;
            needsSave = true;
        } else {
            defaultSettings.castProfiles.forEach(defaultProfile => {
                const existingProfile = settings.castProfiles.find(p => p.id === defaultProfile.id);
                if (!existingProfile) {
                    console.log(`[SETTINGS_MIGRATE] Adding missing Cast profile: ${defaultProfile.name}`);
                    settings.castProfiles.push(defaultProfile);
                    needsSave = true;
                } else if (existingProfile.isDefault) {
                    // Update default cast profile commands
                    if (existingProfile.command !== defaultProfile.command) {
                        console.log(`[SETTINGS_MIGRATE] Updating outdated default Cast profile command for: ${defaultProfile.name}`);
                        existingProfile.command = defaultProfile.command;
                        needsSave = true;
                    }
                }
            });
        }

        if (!settings.activeCastProfileId) {
            console.log(`[SETTINGS_MIGRATE] Initializing missing activeCastProfileId to ${defaultSettings.activeCastProfileId}.`);
            settings.activeCastProfileId = defaultSettings.activeCastProfileId;
            needsSave = true;
        }

        if (!settings.playerLogLevel) {
            // There is no playerLogLevel setting.  Add it with default setting.
            console.log(`[SETTINGS_MIGRATE] Initializing missing player Log Level setting to ${defaultSettings.playerLogLevel}.`);
            settings.playerLogLevel = defaultSettings.playerLogLevel;
            needsSave = true;
        } else if (!validFFmpegLogLevels.includes(settings.playerLogLevel)) {
            // There is a playerLogLevel setting but the value is not recognized.  Set to default.
            console.log(`[SETTINGS_MIGRATE_ERROR] player Log Level setting: ${settings.playerLogLevel} is invalid, set to default: ${defaultSettings.playerLogLevel}.`);
            settings.playerLogLevel = defaultSettings.playerLogLevel;
            needsSave = true;
        }

        if (!settings.dvrLogLevel) {
            // There is no dvrLogLevel setting.  Add it with default setting.
            console.log(`[SETTINGS_MIGRATE] Initializing missing dvr Log Level setting to ${defaultSettings.dvrLogLevel}.`);
            settings.dvrLogLevel = defaultSettings.dvrLogLevel;
            needsSave = true;
        } else if (!validFFmpegLogLevels.includes(settings.dvrLogLevel)) {
            // There is a dvrLogLevel setting but the value is not recognized.  Set to default.
            console.log(`[SETTINGS_MIGRATE_ERROR] dvr Log Level setting: ${settings.dvrLogLevel} is invalid, set to default: ${defaultSettings.dvrLogLevel}.`);
            settings.dvrLogLevel = defaultSettings.dvrLogLevel;
            needsSave = true;
        }

        // NEW: Logs settings migration
        if (!settings.logs) {
            console.log(`[SETTINGS_MIGRATE] Initializing missing logs settings block.`);
            settings.logs = defaultSettings.logs;
            needsSave = true;
        } else {
            // Ensure all log sub-settings exist
            if (settings.logs.maxFiles === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.maxFiles setting.`);
                settings.logs.maxFiles = defaultSettings.logs.maxFiles;
                needsSave = true;
            }
            if (settings.logs.maxFileSizeBytes === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.maxFileSizeBytes setting.`);
                settings.logs.maxFileSizeBytes = defaultSettings.logs.maxFileSizeBytes;
                needsSave = true;
            }
            if (settings.logs.autoDeleteDays === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.autoDeleteDays setting.`);
                settings.logs.autoDeleteDays = defaultSettings.logs.autoDeleteDays;
                needsSave = true;
            }
        }

        if (settings.clientTelemetryEnabled === undefined) {
            console.log(`[SETTINGS_MIGRATE] Adding missing clientTelemetryEnabled setting.`);
            settings.clientTelemetryEnabled = defaultSettings.clientTelemetryEnabled;
            needsSave = true;
        }

        if (settings.timeZone === undefined) {
            console.log('[SETTINGS_MIGRATE] Adding missing timeZone setting.');
            settings.timeZone = defaultSettings.timeZone;
            needsSave = true;
        }
        if (settings.timezoneOffset === undefined) {
            settings.timezoneOffset = defaultSettings.timezoneOffset;
            needsSave = true;
        }

        // Normalize the newer playback/DVR settings once, so old settings files get safe defaults.
        const normalizedDvr = normalizeDvrSettings(settings.dvr || {});
        const normalizedDownloads = normalizeDownloadsSettings(settings.downloads || {});
        const normalizedRewind = normalizeLiveRewindSettings(settings.liveRewind || {});
        if (JSON.stringify(normalizedDvr) !== JSON.stringify(settings.dvr)) {
            settings.dvr = normalizedDvr;
            needsSave = true;
        }
        if (JSON.stringify(normalizedDownloads) !== JSON.stringify(settings.downloads)) {
            settings.downloads = normalizedDownloads;
            needsSave = true;
        }
        if (JSON.stringify(normalizedRewind) !== JSON.stringify(settings.liveRewind)) {
            settings.liveRewind = normalizedRewind;
            needsSave = true;
        }
        if (settings.playerFallbackProfileId === undefined) {
            settings.playerFallbackProfileId = null;
            needsSave = true;
        }
        if (settings.allowUserQualitySwitch === undefined) {
            settings.allowUserQualitySwitch = false;
            needsSave = true;
        }

        // Check that all expected settings are present and set and if not,
        // generate log to highlight missing setting(s) migration code. 
        if (!settings || typeof settings !== 'object') {
            console.log('[SETTINGS_MIGRATE_ERROR] Settings are not valid.');
        } else {
            let allSettingsValid = true;
            for (const key of Object.keys(defaultSettings)) {
                if (!(key in settings) || settings[key] === undefined) {
                    console.log(`[SETTINGS_MIGRATE_ERROR] Expected setting ${key} is missing. server.js:getSettings() needs updating.`);
                    allSettingsValid = false;
                }
            }
            if (allSettingsValid) {
                console.log('[SETTINGS_MIGRATE] Settings are all valid.');
                if (needsSave) {
                    console.log('[SETTINGS_MIGRATE] Saving updated settings file after migration.');
                    writeSettings(settings);
                }
            } else {
                console.log('[SETTINGS_MIGRATE_ERROR] Settings are not all valid.');
            }
        }

        return settings;

    } catch (e) {
        console.error("[SETTINGS] Could not parse settings.json, returning default. Error:", e.message);
        return defaultSettings;
    }
}

// --- LOG ROTATION SYSTEM ---
let currentLogStream = null;
let currentLogFilePath = null;
let currentLogSize = 0;
let cachedLogSettings = {
    maxFiles: 5,
    maxFileSizeBytes: 5 * 1024 * 1024,
    autoDeleteDays: 7
};

/**
 * Updates the cached log settings. Call this after settings are changed.
 */
function refreshLogSettings() {
    try {
        const settings = getSettings();
        if (settings.logs) {
            cachedLogSettings = settings.logs;
        }
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Gets the current active log file path.
 * @returns {string} Path to the current log file.
 */
function getCurrentLogFilePath() {
    if (!currentLogFilePath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentLogFilePath = path.join(LOGS_DIR, `viniplay-${timestamp}.log`);
    }
    return currentLogFilePath;
}

/**
 * Rotates the log file when size limit is reached.
 */
function rotateLogFile() {
    try {
        if (currentLogStream) {
            currentLogStream.end();
            currentLogStream = null;
        }

        // Create new log file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentLogFilePath = path.join(LOGS_DIR, `viniplay-${timestamp}.log`);
        currentLogSize = 0;

        // Use original console.log to avoid recursion
        const originalLog = console.log.__original || console.log;
        originalLog.call(console, `[LOG_ROTATE] Created new log file: ${path.basename(currentLogFilePath)}`);

        // Clean up old log files based on maxFiles setting
        cleanupOldLogsByCount();
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Cleans up old log files based on the maxFiles setting.
 */
function cleanupOldLogsByCount() {
    try {
        const maxFiles = cachedLogSettings.maxFiles || 5;

        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'))
            .map(file => ({
                name: file,
                path: path.join(LOGS_DIR, file),
                mtime: fs.statSync(path.join(LOGS_DIR, file)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime); // Sort by newest first

        // Delete files beyond maxFiles limit
        if (logFiles.length > maxFiles) {
            const filesToDelete = logFiles.slice(maxFiles);
            filesToDelete.forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                    const originalLog = console.log.__original || console.log;
                    originalLog.call(console, `[LOG_CLEANUP] Deleted old log file: ${file.name}`);
                } catch (err) {
                    // Silently fail
                }
            });
        }
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Cleans up log files older than the configured autoDeleteDays.
 */
function cleanupOldLogsByAge() {
    try {
        const autoDeleteDays = cachedLogSettings.autoDeleteDays || 0;

        if (autoDeleteDays === 0) {
            return; // Auto-delete disabled
        }

        const cutoffTime = Date.now() - (autoDeleteDays * 24 * 60 * 60 * 1000);

        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'));

        logFiles.forEach(file => {
            const filePath = path.join(LOGS_DIR, file);
            const stats = fs.statSync(filePath);

            if (stats.mtime.getTime() < cutoffTime) {
                try {
                    fs.unlinkSync(filePath);
                    const originalLog = console.log.__original || console.log;
                    originalLog.call(console, `[LOG_CLEANUP] Deleted old log file (age): ${file}`);
                } catch (err) {
                    // Silently fail
                }
            }
        });
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Writes a log message to the current log file.
 * @param {string} message - The log message to write.
 */
function writeToLogFile(message) {
    try {
        const maxSize = cachedLogSettings.maxFileSizeBytes || (5 * 1024 * 1024);

        // Check if we need to rotate
        if (currentLogSize >= maxSize) {
            rotateLogFile();
        }

        // Create stream if it doesn't exist
        if (!currentLogStream) {
            const logPath = getCurrentLogFilePath();
            currentLogStream = fs.createWriteStream(logPath, { flags: 'a' });

            // Get current file size if file exists
            if (fs.existsSync(logPath)) {
                currentLogSize = fs.statSync(logPath).size;
            }
        }

        const logLine = `${message}\n`;
        currentLogStream.write(logLine);
        currentLogSize += Buffer.byteLength(logLine);

    } catch (error) {
        // Silently fail to avoid infinite loop
    }
}

/**
 * Initializes the log system by overriding console methods.
 */
function initializeLogSystem() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    // Store original functions for internal use
    console.log.__original = originalLog;
    console.error.__original = originalError;
    console.warn.__original = originalWarn;

    console.log = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalLog.apply(console, args);
        writeToLogFile(`[LOG] ${new Date().toISOString()} ${message}`);
    };

    console.error = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalError.apply(console, args);
        writeToLogFile(`[ERROR] ${new Date().toISOString()} ${message}`);
    };

    console.warn = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalWarn.apply(console, args);
        writeToLogFile(`[WARN] ${new Date().toISOString()} ${message}`);
    };

    // Refresh settings cache initially
    refreshLogSettings();

    // Run age-based cleanup on startup and then every 24 hours
    cleanupOldLogsByAge();
    setInterval(cleanupOldLogsByAge, 24 * 60 * 60 * 1000);

    console.log('[LOG_SYSTEM] Log rotation system initialized.');
}

// Initialize the log system
initializeLogSystem();

/**
 * Initiates the VOD refresh process for a given XC provider.
 * @param {object} provider - The M3U source object (must be type 'xc').
 * @param {function} sendStatus - Function to send status updates.
 */
async function triggerVodRefreshForProvider(provider, sendStatus = () => { }) {
    if (!provider || provider.type !== 'xc' || !provider.xc_data) {
        console.error(`[VOD Trigger] Invalid provider object passed for VOD refresh. ID: ${provider?.id}`);
        return;
    }

    console.log(`[VOD Trigger] Starting VOD refresh for provider: ${provider.name} (ID: ${provider.id})`);
    sendStatus(`Triggering VOD refresh for ${provider.name}...`, 'info');

    try {
        const settings = getSettings();
        const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
        // Call the main processing function from vodProcessor.js
        await refreshVodContent(vodStore, provider, sendStatus, activeUserAgent);

        console.log(`[VOD Trigger] Successfully finished VOD refresh for provider: ${provider.name}`);

    } catch (error) {
        console.error(`[VOD Trigger] Error during VOD refresh for ${provider.name}: ${error.message}`);
        sendStatus(`VOD refresh FAILED for ${provider.name}: ${error.message}`, 'error');
    } finally {
        vodLibraryCache.invalidate();
    }
}


// ... existing helper functions (fetchUrlContent, parseEpgTime, processAndMergeSources) remain the same ...

function fetchUrlContent(url, options = {}, asStream = false) { // asStream resolves with the response stream, unread
    try {
        assertSafeStreamUrl(url);
    } catch (err) {
        return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const TIMEOUT_DURATION = 60000;
        console.log(`[FETCH] Attempting to fetch URL content from ${safeUrlForLog(url)} (Timeout: ${TIMEOUT_DURATION / 1000}s)`);

        const request = protocol.get(url, { timeout: TIMEOUT_DURATION, ...options }, (res) => { // <-- MODIFIED
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let nextUrl;
                try {
                    nextUrl = new URL(res.headers.location, url).href;
                } catch (e) {
                    return reject(new Error('Invalid redirect location.'));
                }
                console.log(`[FETCH] Redirecting to: ${safeUrlForLog(nextUrl)}`);
                request.abort();
                return fetchUrlContent(nextUrl, options, asStream).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                console.error(`[FETCH] Failed to fetch ${safeUrlForLog(url)}: Status Code ${res.statusCode}`);
                return reject(new Error(`Failed to fetch: Status Code ${res.statusCode}`));
            }

            if (asStream) return resolve(res);

            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`[FETCH] Successfully fetched content from: ${safeUrlForLog(url)}`);
                resolve(data);
            });
        });

        request.on('timeout', () => {
            request.destroy();
            const timeoutError = new Error(`Request to ${safeUrlForLog(url)} timed out after ${TIMEOUT_DURATION / 1000} seconds.`);
            console.error(`[FETCH] ${timeoutError.message}`);
            reject(timeoutError);
        });

        request.on('error', (err) => {
            console.error(`[FETCH] Network error fetching ${safeUrlForLog(url)}: ${err.message}`);
            reject(err);
        });
    });
}


// --- EPG Parsing and Caching Logic ---
// The EPG half of processAndMergeSources, on its own so a manual EPG assignment can re-merge the guides
// without fetching the playlists again. `liveChannels`: prefixed channel id -> {originalId, name}.
// Updates the status of the active EPG sources in `settings` and adds the ones that failed to `failedSources`.
async function mergeEpg(req, settings, liveChannels, onlyIds, failedSources) {
    const activeEpgSources = settings.epgSources.filter(s => s.isActive);
    const mergedProgramData = {};
    const timeZone = settings.timeZone || null;
    const timezoneOffset = settings.timezoneOffset || 0;

    if (activeEpgSources.length === 0) {
        console.log('[PROCESS] No active EPG sources found.');
        sendProcessingStatus(req, 'No active EPG sources found.', 'info');
    }

    // A guide is resolved to a file once (a URL is downloaded and kept on disk, so refreshing another source can
    // re-merge it without downloading it again); the channel pass and the programme pass both read that file.
    const epgFiles = new Map();
    const openEpg = (source) => {
        // The guide is parsed as a stream: big ones don't fit in a single string.
        return openMaybeGzip(epgFiles.get(source.id));
    };
    const failEpg = (source, error) => {
        const errorMsg = `Failed to process source "${source.name}" from ${source.path}: ${error.message}`;
        console.error(`[EPG] ${errorMsg}`);
        sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
        failedSources.push(source.name);
        if (!source.isXcEpg) {
            source.status = 'Error';
            source.statusMessage = `Processing failed: ${error.message.substring(0, 100)}...`;
        }
    };

    // Pass 1: make every guide readable and list the channels it declares, so channels can be matched by name.
    const epgChannels = new Map(); // XMLTV channel id -> {id, names}, across all guides
    const syntheticChannelIds = new Set(); // guide channels whose <channel id=""> had to be synthesized from the name
    const fallbackEpgSources = new Set(); // guides that failed to refresh and are re-merged from their cache
    for (const source of activeEpgSources) {
        console.log(`[EPG] Processing source: "${source.name}" (ID: ${source.id}, Type: ${source.type}, Path: ${source.path})`);
        const cached = onlyIds && !onlyIds.includes(source.id);
        sendProcessingStatus(req, `Processing EPG source: "${source.name}"...`, 'info');
        try {
            if (source.type === 'file') {
                if (!fs.existsSync(source.path)) {
                    const errorMsg = `File not found for source "${source.name}". Skipping.`;
                    sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
                    source.status = 'Error';
                    source.statusMessage = 'File not found.';
                    failedSources.push(source.name);
                    continue;
                }
                epgFiles.set(source.id, source.path);
            } else if (source.type === 'url') {
                // Kept on disk so refreshing another source can re-merge this guide without downloading it again.
                const cachePath = path.join(RAW_CACHE_DIR, `raw_${source.id}.epg_cache`);
                if (!(cached && fs.existsSync(cachePath))) {
                    sendProcessingStatus(req, ` -> Fetching content from URL...`, 'info');
                    try {
                        await pipelineAsync(await fetchUrlContent(source.path, source.fetchOptions || {}, true), fs.createWriteStream(`${cachePath}.tmp`));
                        fs.renameSync(`${cachePath}.tmp`, cachePath);
                    } catch (fetchError) {
                        if (!fs.existsSync(cachePath)) throw fetchError;
                        fallbackEpgSources.add(source.id);
                        failedSources.push(source.name);
                        console.warn(`[EPG] Refresh failed for "${source.name}", using the last cached guide: ${fetchError.message}`);
                        sendProcessingStatus(req, ` -> Refresh failed (${fetchError.message}); using the last cached guide.`, 'warning');
                    }
                }
                source.cachedRawPath = cachePath;
                epgFiles.set(source.id, cachePath);
            }
            if (epgFiles.has(source.id)) {
                await forEachChannel(openEpg(source), ({ id, names, synthetic }) => {
                    if (synthetic) syntheticChannelIds.add(id);
                    const known = epgChannels.get(id);
                    epgChannels.set(id, { id, names: known ? [...new Set([...known.names, ...names])] : names });
                });
            }
        } catch (error) {
            epgFiles.delete(source.id);
            failEpg(source, error);
        }
        if (!source.isXcEpg && !cached && !fallbackEpgSources.has(source.id)) {
            source.lastUpdated = new Date().toISOString();
        }
    }

    // Which playlist channels each XMLTV channel feeds: manual overrides, then exact ids, then unambiguous names.
    const targets = buildTargets({ channels: liveChannels, overrides: settings.epgOverrides, epgChannels: [...epgChannels.values()] });
    if (syntheticChannelIds.size) {
        sendProcessingStatus(req, `Warning: ${syntheticChannelIds.size} guide channels had an empty channel id and were matched by name only.`, 'info');
    }
    const sample = new Map(); // XMLTV channel id -> one programme title, so the picker can show what a channel airs
    const titleOf = (prog) => (prog.title && prog.title._cdata ? prog.title._cdata : (prog.title?._text || 'No Title')).trim();

    // Pass 2: programmes, for the channels that have a target.
    for (const source of activeEpgSources) {
        if (!epgFiles.has(source.id)) continue;
        try {
            let programCount = 0;
            let epgAddedCount = 0; // programmes added to the live guide (one per target channel)

            await forEachProgramme(openEpg(source), (prog) => {
                const channelId = prog._attributes?.channel;
                if (!channelId) return;
                programCount++;
                if (!sample.has(channelId)) sample.set(channelId, titleOf(prog));
                const ids = targets.get(channelId);
                if (!ids) return;

                const descNode = prog.desc && prog.desc._cdata ? prog.desc._cdata : (prog.desc?._text || '');
                const entry = {
                    start: parseEpgTime(prog._attributes.start, { timeZone, offsetHours: timezoneOffset }).toISOString(),
                    stop: parseEpgTime(prog._attributes.stop, { timeZone, offsetHours: timezoneOffset }).toISOString(),
                    title: titleOf(prog),
                    desc: descNode.trim()
                };
                for (const id of ids) {
                    (mergedProgramData[id] ||= []).push(entry);
                    epgAddedCount++;
                }
            });

            if (programCount === 0) {
                sendProcessingStatus(req, `Warning: No programs found in "${source.name}".`, 'info');
            }
            if (!source.isXcEpg) {
                if (fallbackEpgSources.has(source.id)) {
                    source.status = 'Error';
                    source.statusMessage = 'Refresh failed; kept the last cached guide.';
                } else {
                    source.status = 'Success';
                    source.statusMessage = `Processed ${programCount} programs, added ${epgAddedCount} to live guide.`;
                }
                console.log(`[EPG] Source "${source.name}" processed successfully from ${source.path}.`);
            }
            sendProcessingStatus(req, ` -> Processed ${programCount} programs, added ${epgAddedCount} to live guide from "${source.name}".`, 'info');
        } catch (error) {
            failEpg(source, error);
        }
    }
    for (const channelId in mergedProgramData) {
        mergedProgramData[channelId].sort((a, b) => new Date(a.start) - new Date(b.start));
    }
    try { // Try block for saving EPG JSON
        writeFileAtomic(LIVE_EPG_JSON_PATH, JSON.stringify(mergedProgramData));
        console.log(`[EPG] Merged EPG JSON content saved to ${LIVE_EPG_JSON_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all EPG data for live channels.`, 'success');
    } catch (writeErr) { // Catch block for saving EPG JSON
        console.error(`[EPG] Error writing merged EPG JSON file: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing merged EPG JSON file: ${writeErr.message}`, 'error');
    }
    try { // What the guides offer, for the manual EPG picker
        writeFileAtomic(EPG_CHANNELS_JSON_PATH, JSON.stringify([...epgChannels.values()].map(c => ({ ...c, sample: sample.get(c.id) }))));
    } catch (writeErr) {
        console.error(`[EPG] Error writing EPG channel index: ${writeErr.message}`);
    }
}

// Processing writes the merged files, so runs must not overlap (a timer, a manual
// refresh and the startup pass could otherwise interleave their writes).
function runSourceProcessing(req, onlyIds, keepStoredVod) {
    const run = sourceProcessing.then(() => processAndMergeSources(req, onlyIds, keepStoredVod));
    sourceProcessing = run.catch(() => { });
    return run;
}

// onlyIds: refresh just those sources; the others are merged from their cached raw copy (fetched only if it is missing).
async function processAndMergeSources(req, onlyIds, keepStoredVod = false) {
    console.log('[PROCESS] Starting to process and merge all active sources.');
    sendProcessingStatus(req, 'Starting to process sources...', 'info');
    const settings = getSettings();

    // --- NEW: Data holders for separated content ---
    let mergedLiveM3uContent = '#EXTM3U\n';
    //let mergedVodMovies = [];
    //let mergedVodSeries = [];
    const liveChannels = new Map(); // prefixed channel id -> {originalId, name}: what EPG matching needs
    const groupTitleRegex = /group-title="([^"]*)"/;
    // ---

    const activeM3uSources = settings.m3uSources.filter(s => s.isActive);
    const failedSources = []; // names, for the final summary

    if (activeM3uSources.length === 0) {
        console.log('[PROCESS] No active M3U sources found.');
        sendProcessingStatus(req, 'No active M3U sources found.', 'info');
    }

    for (const source of activeM3uSources) {
        console.log(`[M3U] Processing source: "${source.name}" (ID: ${source.id}, Type: ${source.type}, Path: ${source.path})`);
        const cached = onlyIds && !onlyIds.includes(source.id);
        sendProcessingStatus(req, `Processing M3U source: "${source.name}"...`, 'info');

        // --- NEW: Group Filter Logic ---
        const selectedGroups = source.selectedGroups || [];
        const isGroupFilteringActive = selectedGroups.length > 0;
        if (isGroupFilteringActive) {
            sendProcessingStatus(req, ` -> Applying group filter. ${selectedGroups.length} groups selected.`, 'info');
        }
        // ---

        let usedCachedFallback = false;
        try {
            let content = '';
            let sourcePathForLog = source.path;
            let m3uFetchOptions = {}; // NEW: For XC User-Agent

            if (source.type === 'file') {
                const sourceFilePath = path.join(SOURCES_DIR, path.basename(source.path));
                if (fs.existsSync(sourceFilePath)) {
                    content = fs.readFileSync(sourceFilePath, 'utf-8');
                    sourcePathForLog = sourceFilePath;
                } else {
                    const errorMsg = `File not found for source "${source.name}". Skipping.`;
                    sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
                    source.status = 'Error';
                    source.statusMessage = 'File not found.';
                    failedSources.push(source.name);
                    continue;
                }
            } else if (cached && source.cachedRawPath && fs.existsSync(source.cachedRawPath)) {
                content = fs.readFileSync(source.cachedRawPath, 'utf-8');
                sendProcessingStatus(req, ` -> Using cached content.`, 'info');
            } else if (source.type === 'url') {
                sendProcessingStatus(req, ` -> Fetching content from URL...`, 'info');
                try {
                    content = await fetchUrlContent(source.path);
                } catch (fetchError) {
                    if (!source.cachedRawPath || !fs.existsSync(source.cachedRawPath)) throw fetchError;
                    content = fs.readFileSync(source.cachedRawPath, 'utf-8');
                    usedCachedFallback = true;
                    console.warn(`[M3U] Refresh failed for "${source.name}", using the last cached playlist: ${fetchError.message}`);
                    sendProcessingStatus(req, ` -> Refresh failed (${fetchError.message}); using the last cached playlist.`, 'warning');
                }
                if (!usedCachedFallback) {
                    try {
                        const cacheFileName = `raw_${source.id}.m3u_cache`; // Use a distinct extension
                        const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);

                        fs.writeFileSync(cacheFilePath, content);
                        console.log(`[PROCESS_CACHE] Saved raw content for source "${source.name}" to ${cacheFilePath}`);

                        // Store the path in the source object (this will be saved later when settings are saved)
                        source.cachedRawPath = cacheFilePath;

                    } catch (cacheWriteError) {
                        console.error(`[PROCESS_CACHE] Failed to write raw cache for source "${source.name}" (URL):`, cacheWriteError.message);
                        // Clear any potentially stale cache path if writing failed
                        delete source.cachedRawPath;
                    }
                    sendProcessingStatus(req, ` -> Successfully fetched M3U content.`, 'info');
                }
            } else if (source.type === 'xc') {
                if (!source.xc_data) {
                    throw new Error("XC source is missing credential data (xc_data).");
                }
                const xcInfo = JSON.parse(source.xc_data);
                const { server, username, password } = xcInfo;

                if (!server || !username || !password) {
                    throw new Error("XC source is missing server, username, or password.");
                }

                const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
                m3uFetchOptions = { headers: { 'User-Agent': activeUserAgent } };

                // Fetch live streams from XC API
                const liveStreamsUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_streams`;
                let xcLiveError = null;
                try {
                    sendProcessingStatus(req, ` -> Fetching live categories from XC server...`, 'info');
                    const liveCategoriesUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_categories`;
                    console.log(`[M3U] Fetching live categories from XC source "${source.name}".`);
                    const liveCategoriesResponse = await fetchUrlContent(liveCategoriesUrl, m3uFetchOptions);
                    const liveCategories = JSON.parse(liveCategoriesResponse);

                    sendProcessingStatus(req, ` -> Fetching live streams from XC server...`, 'info');
                    console.log(`[M3U] Fetching live streams from XC source "${source.name}".`);
                    const liveStreamsResponse = await fetchUrlContent(liveStreamsUrl, m3uFetchOptions);
                    const liveStreams = JSON.parse(liveStreamsResponse);

                    // Filter and convert live streams to M3U format
                    let liveM3uContent = '';
                    let liveStreamCount = 0;

                    if (Array.isArray(liveStreams)) {
                        for (const stream of liveStreams) {
                            if (stream.stream_type === 'live') {
                                liveStreamCount++;
                                const streamUrl = `${server}/live/${username}/${password}/${stream.stream_id}.ts`;

                                // Find category name from categories array
                                const categoryName = Array.isArray(liveCategories)
                                    ? liveCategories.find(cat => cat.category_id == stream.category_id)?.category_name || 'Live'
                                    : 'Live';

                                // Use epg_channel_id if available, otherwise use stream_id
                                const tvgId = stream.epg_channel_id || stream.stream_id;

                                liveM3uContent += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${stream.name}" tvg-logo="${stream.stream_icon || ''}" group-title="${categoryName}",${stream.name}\n`;
                                liveM3uContent += `${streamUrl}\n`;
                            }
                        }
                    }

                    if (liveStreamCount > 0) {
                        content += '\n' + liveM3uContent;
                        sendProcessingStatus(req, ` -> Added ${liveStreamCount} live streams to content.`, 'info');
                    } else {
                        sendProcessingStatus(req, ` -> No live streams found with stream_type = 'live'.`, 'info');
                    }
                } catch (liveError) {
                    xcLiveError = liveError;
                    console.error(`[XC Live] Error fetching live streams for "${source.name}": ${liveError.message}`);
                    sendProcessingStatus(req, ` -> Warning: Could not fetch live streams: ${liveError.message}`, 'warning');
                }

                if (xcLiveError && !content.trim()) {
                    if (!source.cachedRawPath || !fs.existsSync(source.cachedRawPath)) throw xcLiveError;
                    content = fs.readFileSync(source.cachedRawPath, 'utf-8');
                    usedCachedFallback = true;
                    console.warn(`[XC] Refresh failed for "${source.name}", using the last cached live playlist: ${xcLiveError.message}`);
                    sendProcessingStatus(req, ` -> Refresh failed; using the last cached live playlist.`, 'warning');
                }

                // Save raw content to cache (XC); an empty or fallback result must not replace the last good copy.
                if (content.trim() && !usedCachedFallback) {
                    try {
                        const cacheFileName = `raw_${source.id}.m3u_cache`; // Use a distinct extension
                        const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);

                        fs.writeFileSync(cacheFilePath, content);
                        console.log(`[PROCESS_CACHE] Saved raw content for source "${source.name}" to ${cacheFilePath}`);

                        // Store the path in the source object (this will be saved later when settings are saved)
                        source.cachedRawPath = cacheFilePath;

                    } catch (cacheWriteError) {
                        console.error(`[PROCESS_CACHE] Failed to write raw cache for source "${source.name}" (XC):`, cacheWriteError.message);
                        // Clear any potentially stale cache path if writing failed
                        delete source.cachedRawPath;
                    }
                }

                sourcePathForLog = liveStreamsUrl;
                sendProcessingStatus(req, ` -> Successfully fetched M3U content from XC server.`, 'info');
            }

            const lines = content.split('\n');
            let currentExtInf = '';
            let liveStreamCount = 0;
            let movieCount = 0;
            let seriesCount = 0;

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line.startsWith('#EXTINF:')) {
                    currentExtInf = line;
                    continue;
                }

                if (isPlaylistUrl(line) && currentExtInf) {
                    const streamUrl = line;



                    // --- GROUP FILTER LOGIC ---
                    const groupMatch = currentExtInf.match(groupTitleRegex);
                    const groupTitle = (groupMatch && groupMatch[1]) ? groupMatch[1] : 'Uncategorized';
                    if (isGroupFilteringActive && !selectedGroups.includes(groupTitle)) {
                        currentExtInf = ''; // Reset for next entry
                        continue; // Skip this entry - not in selected groups
                    }
                    // --- END GROUP FILTER ---

                    // --- LIVE CHANNEL PROCESSING (Only Live Channels here now) ---
                    liveStreamCount++;
                    let processedExtInf = currentExtInf;
                    const idMatch = currentExtInf.match(/tvg-id="([^"]*)"/); // Still needed for unique ID
                    const tvgNameMatch = currentExtInf.match(/tvg-name="([^"]*)"/);
                    const tvgName = (tvgNameMatch && tvgNameMatch[1]) || '';
                    const name = displayNameFromExtinf(currentExtInf);

                    // Consistent Unique Channel ID Generation
                    // Treat an empty tvg-id="" the same as a missing attribute: otherwise
                    // every channel with an empty tvg-id collapses to the same generated ID
                    // (src-<sourceId>_), which breaks favorites and recents (they key on this
                    // ID). idMatch is truthy for tvg-id="", so guard on the captured value.
                    const originalTvgId = (idMatch && idMatch[1]) ? idMatch[1] : `no-tvg-id-${name.replace(/[^a-zA-Z0-9]/g, '')}`;
                    const finalUniqueChannelId = `${source.id}_${originalTvgId}`;

                    // Inject the *corrected* unique ID into the #EXTINF line
                    if (idMatch) {
                        processedExtInf = processedExtInf.replace(/tvg-id="[^"]*"/, `tvg-id="${finalUniqueChannelId}"`);
                    } else {
                        const extinfEnd = processedExtInf.indexOf(':') + 1;
                        processedExtInf = processedExtInf.slice(0, extinfEnd) + ` tvg-id="${finalUniqueChannelId}"` + processedExtInf.slice(extinfEnd);
                    }

                    // Inject source name
                    const tvgIdAttrEnd = processedExtInf.indexOf(`tvg-id="${finalUniqueChannelId}"`) + `tvg-id="${finalUniqueChannelId}"`.length;
                    processedExtInf = processedExtInf.slice(0, tvgIdAttrEnd) + ` vini-source="${source.name}"` + processedExtInf.slice(tvgIdAttrEnd);

                    mergedLiveM3uContent += processedExtInf + '\n' + streamUrl + '\n';
                    liveChannels.set(finalUniqueChannelId, { originalId: originalTvgId, name, tvgName, group: groupTitle });
                    // --- END LIVE CHANNEL PROCESSING ---

                    currentExtInf = ''; // Reset for next entry
                }
            }

            if (usedCachedFallback) {
                source.status = 'Error';
                source.statusMessage = 'Refresh failed; kept the last cached copy.';
                failedSources.push(source.name);
            } else {
                source.status = 'Success';
                source.statusMessage = `Processed ${liveStreamCount} Live channels.`;
            }
            console.log(`[M3U] Source "${source.name}" processed successfully from ${sourcePathForLog}.`);
            sendProcessingStatus(req, ` -> Processed ${liveStreamCount} Live channels from "${source.name}".`, 'info');

            // --- NEW: Trigger VOD Refresh for XC Sources ---
            // A restart or timezone change has no reason to download the whole VOD catalog again; a refresh does.
            if (source.type === 'xc' && !cached && !(keepStoredVod && await vodStore.hasTitles(source.id))) {
                console.log(`[PROCESS] Source "${source.name}" is XC. Triggering VOD refresh.`);
                sendProcessingStatus(req, ` -> Triggering VOD content refresh for XC source "${source.name}"...`, 'info');
                // Use setImmediate to run the VOD refresh *after* the current M3U processing finishes
                await triggerVodRefreshForProvider(source, (msg, type) => sendProcessingStatus(req, msg, type));
            }
            // --- END VOD Trigger ---

        } catch (error) {
            const errorMsg = `Failed to process source "${source.name}" from ${source.path}: ${error.message}`;
            console.error(`[M3U] ${errorMsg}`);
            sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
            failedSources.push(source.name);
            source.status = 'Error';
            source.statusMessage = `Processing failed: ${error.message.substring(0, 100)}...`;
        }
        if (!cached && !usedCachedFallback) source.lastUpdated = new Date().toISOString();
    }

    // --- Save the new separated files ---
    try { // Try block for saving LIVE M3U
        writeFileAtomic(LIVE_CHANNELS_M3U_PATH, mergedLiveM3uContent);
        console.log(`[M3U] Merged LIVE CHANNELS content saved to ${LIVE_CHANNELS_M3U_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all live channels.`, 'success');
    } catch (writeErr) { // Catch block for saving LIVE M3U
        console.error(`[PROCESS] Error writing LIVE M3U file: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing live channels file: ${writeErr.message}`, 'error');
    }

    await mergeEpg(req, settings, liveChannels, onlyIds, failedSources);

    settings.sourcesLastUpdated = new Date().toISOString();
    console.log(`[PROCESS] Finished processing. New 'sourcesLastUpdated' timestamp: ${settings.sourcesLastUpdated}`);
    if (failedSources.length) {
        sendProcessingStatus(req, `Finished with ${failedSources.length} failed source(s): ${failedSources.join(', ')}.`, 'error');
    } else {
        sendProcessingStatus(req, 'All sources processed successfully!', 'final_success');
    }

    return {
        success: failedSources.length === 0,
        failedSources,
        message: failedSources.length
            ? `Sources merged with ${failedSources.length} failed source(s): ${failedSources.join(', ')}.`
            : 'Sources merged successfully.',
        updatedSettings: settings,
    };
}

// ... existing helper functions ...

// --- Authentication API Endpoints ---
// Regenerates the session ID on login, so an ID an attacker knew before login cannot
// become the authenticated session (session fixation).
function startUserSession(req, user, callback) {
    req.session.regenerate((err) => {
        if (err) return callback(err);
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.isAdmin = user.isAdmin === 1 || user.isAdmin === true;
        req.session.canUseDvr = user.canUseDvr === 1 || user.canUseDvr === true;
        callback(null);
    });
}

// Drops every stored session for a user after a password change or account deletion.
// connect-sqlite3 keeps the data as JSON, so filter in JS rather than guessing its schema.
function destroyUserSessions(userId, exceptSid) {
    sessionStore.db.all("SELECT sid, sess FROM sessions", (err, rows) => {
        if (err || !rows) return;
        rows.forEach((row) => {
            if (exceptSid && row.sid === exceptSid) return;
            try {
                if (String(JSON.parse(row.sess).userId) === String(userId)) {
                    sessionStore.destroy(row.sid, () => { });
                }
            } catch (e) { /* ignore a malformed session row */ }
        });
    });
}

app.get('/api/auth/needs-setup', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/needs-setup');
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => {
        if (err) {
            console.error('[AUTH_API] Error checking user count:', err.message);
            return res.status(500).json({ error: 'Could not check the setup state.' });
        }
        const needsSetup = row.count === 0;
        console.log(`[AUTH_API] User count: ${row.count}. Needs setup: ${needsSetup}`);
        res.json({ needsSetup });
    });
});

app.post('/api/auth/setup-admin', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/setup-admin');
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) {
        return res.status(400).json({ error: 'A username is required.' });
    }
    const problem = passwordProblem(password);
    if (problem) {
        console.warn('[AUTH_API] Admin setup failed:', problem);
        return res.status(400).json({ error: problem });
    }

    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            console.error('[AUTH_API] Error hashing password during admin setup:', err);
            return res.status(500).json({ error: 'Error hashing password.' });
        }
        // One statement: concurrent first-run requests cannot both see an empty table.
        db.run(
            `INSERT INTO users (username, password, isAdmin, canUseDvr)
             SELECT ?, ?, 1, 1 WHERE NOT EXISTS (SELECT 1 FROM users)`,
            [username.trim(), hash],
            function (err) {
                if (err) {
                    console.error('[AUTH_API] Error inserting admin user:', err.message);
                    return res.status(500).json({ error: 'Could not create the admin account.' });
                }
                if (this.changes === 0) {
                    console.warn('[AUTH_API] Setup attempted but users already exist. Denying setup.');
                    return res.status(403).json({ error: 'Setup has already been completed.' });
                }
                const userId = this.lastID;
                console.log(`[AUTH_API] Admin user "${username}" created successfully (ID: ${userId}).`);
                startUserSession(req, { id: userId, username: username.trim(), isAdmin: 1, canUseDvr: 1 }, (sessionErr) => {
                    if (sessionErr) {
                        console.error('[AUTH_API] Error starting the admin session:', sessionErr);
                        return res.status(500).json({ error: 'Admin created, but the session could not be started. Please log in.' });
                    }
                    res.json({ success: true, user: { id: userId, username: username.trim(), isAdmin: true, canUseDvr: true } });
                });
            }
        );
    });
});

app.post('/api/auth/login', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/login');
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password are required.' });
    }
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const retryAfter = loginLimiter.check(clientIp, username);
    if (retryAfter > 0) {
        res.setHeader('Retry-After', String(retryAfter));
        console.warn(`[AUTH_API] Login rate limit hit for ${clientIp}.`);
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err) {
            console.error('[AUTH_API] Error querying user during login:', err.message);
            return res.status(500).json({ error: 'Authentication error.' });
        }
        if (!user) {
            loginLimiter.fail(clientIp, username);
            console.warn('[AUTH_API] Login failed: user not found.');
            // Same bcrypt cost as a real check, so timing does not reveal valid usernames.
            return bcrypt.compare(password, DUMMY_PASSWORD_HASH, () => res.status(401).json({ error: "Invalid username or password." }));
        }

        bcrypt.compare(password, user.password, (err, result) => {
            if (err) {
                console.error('[AUTH_API] Error comparing password hash:', err);
                return res.status(500).json({ error: 'Authentication error.' });
            }
            if (!result) {
                loginLimiter.fail(clientIp, username);
                console.warn('[AUTH_API] Login failed: incorrect password.');
                return res.status(401).json({ error: "Invalid username or password." });
            }
            loginLimiter.success(clientIp, username);
            startUserSession(req, user, (sessionErr) => {
                if (sessionErr) {
                    console.error('[AUTH_API] Error starting the user session:', sessionErr);
                    return res.status(500).json({ error: 'Authentication error.' });
                }
                console.log(`[AUTH_API] User "${user.username}" (ID: ${user.id}) logged in successfully.`);
                res.json({
                    success: true,
                    user: { id: user.id, username: user.username, isAdmin: user.isAdmin === 1, canUseDvr: user.canUseDvr === 1 }
                });
            });
        });
    });
});

app.post('/api/auth/logout', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/logout');
    const username = req.session.username || 'unknown';
    req.session.destroy(err => {
        if (err) {
            console.error(`[AUTH_API] Error destroying session for user ${username}:`, err);
            return res.status(500).json({ error: 'Could not log out.' });
        }
        res.clearCookie('connect.sid');
        console.log(`[AUTH_API] User ${username} logged out. Session destroyed.`);
        res.json({ success: true });
    });
});

// --- NEW/OPTIMIZED ENDPOINT FOR GROUP FILTERING (with Caching & Refresh) ---
app.post('/api/sources/fetch-groups', requireAuth, requireAdmin, async (req, res) => {
    // --- ADDITION: Get refresh flag from query or body ---
    const forceRefresh = req.query.refresh === 'true' || req.body.refresh === true;
    const { type, url, xc, sourceId } = req.body; // Added sourceId
    // --- END ADDITION ---

    let fetchUrl;
    let fetchOptions = {};
    let content = '';
    let usedCache = false; // Flag to track if cache was used

    console.log(`[API_GROUPS] Fetching groups for type: ${type}, SourceID: ${sourceId}, Refresh: ${forceRefresh}`);

    try {
        let sourceToUse = null;
        if (sourceId) {
            const settings = getSettings();
            // Try finding in M3U sources first, then EPG (though unlikely for M3U groups)
            sourceToUse = settings.m3uSources.find(s => s.id === sourceId) || settings.epgSources.find(s => s.id === sourceId);
        }

        // XC categories are not the cached M3U live list. Handle them before the cache.
        if (type === 'xc' && xc) {
            const xcInfo = JSON.parse(xc);
            if (!xcInfo.server || !xcInfo.username || !xcInfo.password) {
                return res.status(400).json({ error: 'XC source requires server, username, and password.' });
            }
            console.log('[API_GROUPS] Source is XC type. Using XtreamClient to fetch all categories.');
            const settings = getSettings();
            const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
            const client = new XtreamClient(xcInfo.server, xcInfo.username, xcInfo.password, activeUserAgent);
            const allCategories = await client.getAllCategories();
            return res.json({ success: true, groups: allCategories, usedCache: false });
        }

        // After the URL was edited in the form, the cache describes the old provider.
        const urlChanged = type === 'url' && sourceToUse && sourceToUse.type === 'url' && url && url !== sourceToUse.path;

        // --- START CACHE CHECK ---
        if (!forceRefresh && !urlChanged && sourceToUse && sourceToUse.cachedRawPath && fs.existsSync(sourceToUse.cachedRawPath)) {
            try {
                console.log(`[API_GROUPS] Using cached raw file: ${sourceToUse.cachedRawPath}`);
                content = fs.readFileSync(sourceToUse.cachedRawPath, 'utf-8');
                usedCache = true;
            } catch (cacheReadError) {
                console.warn(`[API_GROUPS] Failed to read cache file ${sourceToUse.cachedRawPath}. Will fetch fresh. Error:`, cacheReadError.message);
                usedCache = false; // Ensure we fetch fresh if cache read fails
            }
        }
        // --- END CACHE CHECK ---

        // --- Fetch if cache wasn't used or refresh was forced ---
        if (!usedCache) {
            console.log(`[API_GROUPS] ${forceRefresh ? 'Refresh forced' : 'Cache not used/found'}. Fetching from original source.`);
            if (type === 'url' && url) {
                fetchUrl = url;
                content = await fetchUrlContent(fetchUrl, fetchOptions);
            } else if (type === 'file' && url) { // Assuming url holds file path for type file
                const filePath = sourceToUse?.path || path.join(SOURCES_DIR, path.basename(url)); // Prefer path from settings if available
                if (fs.existsSync(filePath)) {
                    content = fs.readFileSync(filePath, 'utf-8');
                } else {
                    return res.status(400).json({ error: 'File source path not found or invalid.' });
                }
            } else {
                return res.status(400).json({ error: 'Valid source details (URL, XC, or File path) are required.' });
            }
        }
        // --- End Fetch Logic ---


        // --- Efficiently Extract Groups (Handles JSON for XC and Regex for M3U) ---
        const groups = new Set();
        try {
            // First, try to parse as JSON (for XC sources which return a JSON array of categories)
            const groupJsonArray = JSON.parse(content);
            console.log(`[API_GROUPS] Successfully parsed content as JSON. Scanning for group titles.`);
            if (Array.isArray(groupJsonArray)) {
                for (const category of groupJsonArray) {
                    if (category && typeof category.category_name === 'string') {
                        const groupName = category.category_name.trim();
                        if (groupName) groups.add(groupName);
                    }
                }
            }
        } catch (jsonError) {
            // If JSON parsing fails, assume it's a plain M3U file and use regex
            console.log(`[API_GROUPS] Content is not valid JSON, attempting to parse as plain M3U.`);
            const groupTitleRegex = /group-title=\"([^\"]+)\"/g;
            let match;
            while ((match = groupTitleRegex.exec(content)) !== null) {
                const groupName = match[1].trim();
                if (groupName) {
                    groups.add(groupName);
                }
            }
        }

        const sortedGroups = Array.from(groups).sort((a, b) => a.localeCompare(b));
        console.log(`[API_GROUPS] Found ${sortedGroups.length} unique groups.`);
        res.json({ success: true, groups: sortedGroups, usedCache: usedCache }); // Optionally tell frontend if cache was used

    } catch (error) {
        console.error(`[API_GROUPS] Failed to fetch or parse M3U for groups: ${error.message}`);
        res.status(500).json({ error: `Failed to fetch or process groups: ${error.message}` });
    }
});

app.get('/api/auth/status', (req, res) => {
    console.log('[AUTH_API] GET /api/auth/status');
    if (req.session && req.session.userId) {
        console.log(`[AUTH_API_STATUS] Valid session found for user "${req.session.username}" (ID: ${req.session.userId}). Responding with isLoggedIn: true.`);
        res.json({ isLoggedIn: true, user: { id: req.session.userId, username: req.session.username, isAdmin: req.session.isAdmin, canUseDvr: req.session.canUseDvr } });
    } else {
        console.log('[AUTH_API_STATUS] No valid session found. Responding with isLoggedIn: false.');
        res.json({ isLoggedIn: false });
    }
});
// ... existing User Management API Endpoints ...
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    console.log('[USER_API] Fetching all users.');
    db.all("SELECT id, username, isAdmin, canUseDvr, allowed_sources FROM users ORDER BY username", [], (err, rows) => {
        if (err) {
            console.error('[USER_API] Error fetching users:', err.message);
            return res.status(500).json({ error: 'Could not load users.' });
        }
        console.log(`[USER_API] Found ${rows.length} users.`);
        res.json(rows);
    });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    console.log('[USER_API] Adding new user.');
    const { username, password, isAdmin, canUseDvr, allowed_sources } = req.body;
    if (!username) {
        console.warn('[USER_API] Add user failed: Username missing.');
        return res.status(400).json({ error: "Username is required." });
    }
    const problem = passwordProblem(password);
    if (problem) {
        return res.status(400).json({ error: problem });
    }

    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            console.error('[USER_API] Error hashing password for new user:', err);
            return res.status(500).json({ error: 'Error hashing password' });
        }
        const allowedSourcesStr = allowed_sources ? JSON.stringify(allowed_sources) : null;
        db.run("INSERT INTO users (username, password, isAdmin, canUseDvr, allowed_sources) VALUES (?, ?, ?, ?, ?)", [username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, allowedSourcesStr], function (err) {
            if (err) {
                console.error('[USER_API] Error inserting new user:', err.message);
                return res.status(400).json({ error: "Username already exists." });
            }
            console.log(`[USER_API] User "${username}" added successfully (ID: ${this.lastID}).`);
            res.json({ success: true, id: this.lastID });
        });
    });
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { username, password, isAdmin, canUseDvr, allowed_sources } = req.body;
    console.log(`[USER_API] Updating user ID: ${id}. Username: ${username}, IsAdmin: ${isAdmin}, CanUseDvr: ${canUseDvr}`);

    if (password) {
        const problem = passwordProblem(password);
        if (problem) return res.status(400).json({ error: problem });
    }

    const allowedSourcesStr = allowed_sources ? JSON.stringify(allowed_sources) : null;

    const updateUser = () => {
        if (password) {
            bcrypt.hash(password, saltRounds, (err, hash) => {
                if (err) {
                    console.error('[USER_API] Error hashing password during user update:', err);
                    return res.status(500).json({ error: 'Error hashing password' });
                }
                db.run("UPDATE users SET username = ?, password = ?, isAdmin = ?, canUseDvr = ?, allowed_sources = ? WHERE id = ?", [username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, allowedSourcesStr, id], (err) => {
                    if (err) {
                        console.error(`[USER_API] Error updating user ${id} with new password:`, err.message);
                        return res.status(500).json({ error: 'Could not update user.' });
                    }
                    if (req.session.userId == id) {
                        req.session.username = username;
                        req.session.isAdmin = isAdmin;
                        req.session.canUseDvr = canUseDvr;
                        console.log(`[USER_API] Current user's session (ID: ${id}) updated.`);
                    }
                    userCache.invalidate(id);
                    if (password) destroyUserSessions(id, req.sessionID);
                    console.log(`[USER_API] User ${id} updated successfully (with password change).`);
                    res.json({ success: true });
                });
            });
        } else {
            db.run("UPDATE users SET username = ?, isAdmin = ?, canUseDvr = ?, allowed_sources = ? WHERE id = ?", [username, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, allowedSourcesStr, id], (err) => {
                if (err) {
                    console.error(`[USER_API] Error updating user ${id} without password change:`, err.message);
                    return res.status(500).json({ error: 'Could not update user.' });
                }
                if (req.session.userId == id) {
                    req.session.username = username;
                    req.session.isAdmin = isAdmin;
                    req.session.canUseDvr = canUseDvr;
                    console.log(`[USER_API] Current user's session (ID: ${id}) updated.`);
                }
                userCache.invalidate(id);
                console.log(`[USER_API] User ${id} updated successfully (without password change).`);
                res.json({ success: true });
            });
        }
    };

    if (req.session.userId == id && !isAdmin) {
        console.log(`[USER_API] Attempting to demote current admin user ${id}. Checking if last admin.`);
        db.get("SELECT COUNT(*) as count FROM users WHERE isAdmin = 1", [], (err, row) => {
            if (err) {
                console.error('[USER_API] Error checking admin count for demotion:', err.message);
                return res.status(500).json({ error: 'Could not update user.' });
            }
            if (row.count <= 1) {
                console.warn(`[USER_API] Cannot demote user ${id}: They are the last administrator.`);
                return res.status(403).json({ error: "Cannot remove the last administrator." });
            }
            updateUser();
        });
    } else {
        updateUser();
    }
});

// MODIFIED: User deletion now terminates active streams and forces logout.
app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    const idToDelete = parseInt(req.params.id, 10);
    console.log(`[USER_API] Deleting user ID: ${idToDelete}`);
    if (req.session.userId == idToDelete) {
        console.warn(`[USER_API] Attempted to delete own account for user ${idToDelete}.`);
        return res.status(403).json({ error: "You cannot delete your own account." });
    }

    // --- NEW: Terminate active streams for the deleted user ---
    let streamsKilled = 0;
    for (const [streamKey, streamInfo] of activeStreamProcesses.entries()) {
        if (streamInfo.userId === idToDelete) {
            console.log(`[USER_DELETION] Found active stream for deleted user ${idToDelete}. Terminating PID: ${streamInfo.process.pid}.`);
            try {
                streamInfo.process.kill('SIGKILL');
                activeStreamProcesses.delete(streamKey);
                streamsKilled++;
            } catch (e) {
                console.warn(`[USER_DELETION] Error killing stream process for user ${idToDelete}: ${e.message}`);
            }
        }
    }
    if (streamsKilled > 0) {
        console.log(`[USER_DELETION] Terminated ${streamsKilled} active stream(s) for deleted user ${idToDelete}.`);
    }

    // --- NEW: Force logout via SSE ---
    sendSseEvent(idToDelete, 'force-logout', { reason: 'Your account has been deleted by an administrator.' });

    db.run("DELETE FROM users WHERE id = ?", idToDelete, function (err) {
        if (err) {
            console.error(`[USER_API] Error deleting user ${idToDelete}:`, err.message);
            return res.status(500).json({ error: 'Could not delete user.' });
        }
        if (this.changes === 0) {
            console.warn(`[USER_API] User ${idToDelete} not found for deletion.`);
            return res.status(404).json({ error: 'User not found.' });
        }
        userCache.invalidate(idToDelete);
        destroyUserSessions(idToDelete);
        console.log(`[USER_API] User ${idToDelete} deleted successfully from database.`);
        res.json({ success: true });
    });
});
// --- Protected IPTV API Endpoints ---
// The EPG arrives as ready-made JSON text, so it is spliced into the response instead of being serialized again.
const sendConfig = (req, res, config, epgJson = 'null') => {
    const settings = { ...config.settings };
    // Never send the session secret, even to an admin. It is also no longer stored here.
    delete settings.generatedSessionSecret;
    if (!req.session.isAdmin) {
        // Provider credentials and source URLs are needed only by the admin settings page.
        const stripSourceSecrets = (list) => (list || []).map(({ xc_data, url, path, ...source }) => source);
        settings.m3uSources = stripSourceSecrets(settings.m3uSources);
        settings.epgSources = stripSourceSecrets(settings.epgSources);
    }
    const body = { ...config, settings };
    sendJson(req, res, Buffer.from(`${JSON.stringify(body).slice(0, -1)},"epgContent":${epgJson}}`));
};

app.get('/api/config', requireAuth, async (req, res) => {
    try {
        // ADDED vodMovies and vodSeries
        let config = { m3uContent: null, settings: {}, vodMovies: [], vodSeries: [] }; // epgContent is added by sendConfig
        let epgJson;
        let globalSettings = getSettings();
        config.settings = globalSettings;

        // Permissions are already loaded by requireAuth. Fail closed on a malformed row.
        let allowedSources;
        try {
            allowedSources = allowedSourcesFromUser(req.user);
            console.log(`[DEBUG_API_CONFIG] Config for UserID ${req.session.userId}: ${allowedSources ? 'restricted sources' : 'full source access'}.`);
        } catch (permErr) {
            console.error('[API] Error reading user permissions:', permErr);
            allowedSources = {};
        }

        // LOAD M3U
        if (fs.existsSync(LIVE_CHANNELS_M3U_PATH)) {
            let m3uRaw = fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8');

            // FILTER M3U
            if (allowedSources) {
                const lines = m3uRaw.split('\n');
                let filteredLines = [];
                if (lines.length > 0 && lines[0].startsWith('#EXTM3U')) {
                    filteredLines.push(lines[0]);
                }

                let currentExtInf = null;
                const groupTitleRegex = /group-title="([^"]*)"/;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('#EXTINF:')) {
                        currentExtInf = line;

                        // Extract Source ID we injected earlier: tvg-id="sourceId_..."
                        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
                        let isAllowed = false;

                        if (tvgIdMatch) {
                            const fullId = tvgIdMatch[1];
                            const underscoreIndex = fullId.indexOf('_');
                            if (underscoreIndex !== -1) {
                                const sourceId = fullId.substring(0, underscoreIndex);
                                // Check if this source is in allowedSources
                                if (allowedSources[sourceId]) {
                                    // Check if specifically allowed (if we use { allowed: true }) or just presence
                                    // Assuming format: { "sourceId": { allowed: true, groups: [] } }
                                    if (allowedSources[sourceId].allowed) {
                                        isAllowed = true;
                                        // Check Group Restrictions
                                        const groups = allowedSources[sourceId].groups;
                                        if (groups && groups.length > 0) {
                                            const groupMatch = line.match(groupTitleRegex);
                                            const group = groupMatch ? groupMatch[1] : 'Uncategorized';
                                            if (!groups.includes(group)) {
                                                isAllowed = false;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if (!isAllowed) {
                            currentExtInf = null;
                        }

                    } else if (isPlaylistUrl(line) || (line.startsWith('/') && !line.startsWith('//'))) { // URL or local path
                        if (currentExtInf) {
                            filteredLines.push(currentExtInf);
                            filteredLines.push(line);
                        }
                        currentExtInf = null;
                    }
                }
                config.m3uContent = filteredLines.join('\n');
                console.log(`[API] Loaded and FILTERED M3U content for user ${req.session.username}.`);
            } else {
                config.m3uContent = m3uRaw;
                console.log(`[API] Loaded M3U content from ${LIVE_CHANNELS_M3U_PATH}.`);
            }
        } else {
            console.log(`[API] No merged M3U file found at ${LIVE_CHANNELS_M3U_PATH}.`);
        }

        // LOAD EPG
        epgJson = epgPayload(allowedSources);
        console.log(epgJson === undefined
            ? `[API] No merged EPG JSON file found at ${LIVE_EPG_JSON_PATH}.`
            : `[API] Loaded${allowedSources ? ' and FILTERED' : ''} EPG content from ${LIVE_EPG_JSON_PATH}.`);

        // --- Legacy VOD files ---
        // The new /api/vod/library endpoint filters by provider. These files carry no
        // permission data, so restricted users do not get them at all.
        if (!allowedSources) {
            if (fs.existsSync(VOD_MOVIES_JSON_PATH)) {
                try {
                    config.vodMovies = JSON.parse(fs.readFileSync(VOD_MOVIES_JSON_PATH, 'utf-8'));
                } catch (e) { }
            }
            if (fs.existsSync(VOD_SERIES_JSON_PATH)) {
                try {
                    config.vodSeries = JSON.parse(fs.readFileSync(VOD_SERIES_JSON_PATH, 'utf-8'));
                } catch (e) { }
            }
        }
        // --- END Legacy VOD ---

        db.all(`SELECT key, value FROM user_settings WHERE user_id = ?`, [req.session.userId], (err, rows) => {
            if (err) {
                console.error("[API] Error fetching user settings:", err);
                return sendConfig(req, res, config, epgJson);
            }
            if (rows) {
                const userSettings = {};
                rows.forEach(row => {
                    try {
                        userSettings[row.key] = JSON.parse(row.value);
                    } catch (e) {
                        userSettings[row.key] = row.value;
                        console.warn(`[API] User setting key "${row.key}" could not be parsed as JSON. Storing as raw string.`);
                    }
                });

                config.settings = { ...config.settings, ...userSettings };
                console.log(`[API] Merged user settings for user ID: ${req.session.userId}`);
            }

            // --- CACHE INVALIDATION LOGIC ---
            // Calculate a signature for the user's permissions to force cache updates
            let userPermissionsSignature = 'default';
            if (allowedSources) {
                const str = JSON.stringify(allowedSources);
                let hash = 0;
                for (let i = 0; i < str.length; i++) {
                    const char = str.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash; // Convert to 32bit integer
                }
                userPermissionsSignature = 'v1_' + hash;
            }
            config.settings.userPermissionsSignature = userPermissionsSignature;
            console.log(`[API] Serving config with permissions signature: ${userPermissionsSignature}`);
            // --------------------------------

            sendConfig(req, res, config, epgJson);
        });

    } catch (error) {
        console.error("[API] Error reading config or related files:", error);
        res.status(500).json({ error: "Could not load configuration from server." });
    }
});

// The XC providers this request may see (with the credentials that go into stream URLs) and the category
// whitelist per provider. Throws if the permission data cannot be read.
async function vodAccess(req) {
    let allowedSources = null;
    try {
        const user = await userCache.get(req.session.userId);
        if (user && user.isAdmin !== 1 && user.allowed_sources) {
            allowedSources = JSON.parse(user.allowed_sources);
        } else if (!user) {
            allowedSources = {};
        }
    } catch (dbErr) {
        console.error("[API_VOD] Error fetching user permissions:", dbErr);
        // Fail closed: broken permission data must not grant the whole library.
        allowedSources = {};
    }

    const providerMap = new Map();
    getSettings().m3uSources
        .filter(s => s.isActive && s.type === 'xc' && (!allowedSources || allowedSources[s.id]?.allowed))
        .forEach(p => {
            try {
                const xcInfo = JSON.parse(p.xc_data);
                const url = new URL(xcInfo.server);
                providerMap.set(p.id, {
                    baseUrl: `${url.protocol}//${url.host}`,
                    username: xcInfo.username,
                    password: xcInfo.password,
                    // An empty whitelist means every category.
                    groups: allowedSources?.[p.id]?.groups?.length ? allowedSources[p.id].groups : null,
                });
            } catch (e) {
                console.error(`[API_VOD] Skipping provider ${p.name}, invalid XC data: ${e.message}`);
            }
        });
    return { providerMap, scope: Array.from(providerMap, ([id, p]) => ({ id, groups: p.groups })) };
}

// --- VOD library: one page at a time. Search, type, category and sort run in SQL, so loading the page
// costs the same whether the catalog holds 2k or 200k titles. ---
app.get('/api/vod/library', requireAuth, async (req, res) => {
    try {
        const { providerMap, scope } = await vodAccess(req);
        const { type, group, q, page, limit } = req.query;
        const { rows, total } = await vodStore.listTitles({
            providers: scope, type, group: group && String(group), q: q && String(q).trim(), page, limit,
        });
        const items = rows.map(r => {
            const item = { id: r.provider_unique_id, type: r.type, name: r.name, year: r.year, description: r.description, logo: r.logo, group: r.category_name };
            if (r.type === 'movie') {
                const p = providerMap.get(r.provider_id);
                item.url = `${p.baseUrl}/movie/${p.username}/${p.password}/${r.stream_id}.${r.container_extension || 'mp4'}`;
            }
            return item;
        });
        await sendJson(req, res, Buffer.from(JSON.stringify({ items, total })));
    } catch (error) {
        console.error(`[API_VOD] Error fetching VOD library from DB: ${error.message}`, error);
        res.status(500).json({ error: "Could not retrieve VOD library from database." });
    }
});

// The category lists for the filter dropdown, { movies: [...], series: [...] }. They only change when the catalog
// does, so the serialized answer is kept per permission scope until a refresh invalidates it.
app.get('/api/vod/groups', requireAuth, async (req, res) => {
    try {
        const { scope } = await vodAccess(req);
        const body = await vodLibraryCache.get(JSON.stringify(scope), async () => {
            const groups = await vodStore.listGroups(scope);
            return { movies: groups.movie, series: groups.series };
        });
        await sendJson(req, res, body);
    } catch (error) {
        console.error(`[API_VOD] Error fetching VOD categories from DB: ${error.message}`, error);
        res.status(500).json({ error: "Could not retrieve VOD categories from database." });
    }
});

// --- VOD Duration Probing with In-Memory Cache ---
const vodDurationCache = new Map();

async function getStreamDurationSeconds(streamUrl, userAgentHeader) {
    if (!streamUrl) return null;
    if (vodDurationCache.has(streamUrl)) {
        return vodDurationCache.get(streamUrl);
    }
    return new Promise((resolve) => {
        if (!isAllowedStreamUrl(streamUrl)) {
            return resolve(null);
        }
        // Pass arguments as an argv array (no shell) so the URL cannot run shell commands.
        const args = userAgentHeader ? ['-user_agent', userAgentHeader] : [];
        args.push('-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', streamUrl);
        execFile('ffprobe', args, { timeout: 8000 }, (error, stdout) => {
            if (error || !stdout) {
                return resolve(null);
            }
            const duration = parseFloat(stdout.trim());
            if (!isNaN(duration) && duration > 0) {
                const rounded = Math.round(duration);
                vodDurationCache.set(streamUrl, rounded);
                if (vodDurationCache.size > 1000) {
                    const firstKey = vodDurationCache.keys().next().value;
                    vodDurationCache.delete(firstKey);
                }
                resolve(rounded);
            } else {
                resolve(null);
            }
        });
    });
}

app.get('/api/vod/duration', requireAuth, async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: "Missing required 'url' parameter" });
    }
    try {
        await assertSafeMediaStreamUrl(url);
    } catch (err) {
        return res.status(400).json({ error: 'URL is not allowed.' });
    }
    try {
        const settings = getSettings();
        const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
        const duration = await getStreamDurationSeconds(url, activeUserAgent);
        res.json({ duration });
    } catch (err) {
        console.error('[API_VOD] Error probing stream duration:', err.message);
        res.json({ duration: null });
    }
});

// --- NEW: Lazy Loading Endpoint for Series Details ---
app.get('/api/vod/series/:seriesId', requireAuth, async (req, res) => {
    const seriesIdParam = req.params.seriesId;

    console.log(`[API_VOD_SERIES] Request received for Series ID: ${seriesIdParam}`);

    try {
        // 1. Fetch basic series info using the provider_unique_id
        const seriesInfo = await dbGet(db, "SELECT * FROM series WHERE provider_unique_id = ?", [seriesIdParam]);
        if (!seriesInfo) {
            return res.status(404).json({ error: 'Series not found.' });
        }
        const numericSeriesId = seriesInfo.id; // Get the internal numeric ID for relations

        // 2. Check if episodes exist in DB
        const existingEpisodes = await dbAll(db, `
            SELECT e.*, r.provider_id, r.provider_stream_id, r.container_extension
            FROM episodes e
            JOIN provider_episode_relations r ON e.id = r.episode_id
            WHERE e.series_id = ?
            ORDER BY e.season_num, e.episode_num
        `, [numericSeriesId]);

        let episodesToReturn = existingEpisodes;
        // Episodes come from the provider once. A provider that never reports durations would otherwise be asked on every open.
        const needsEpisodeFetch = existingEpisodes.length === 0 || (!seriesInfo.episodes_fetched_at && existingEpisodes.some(ep => !ep.duration && !ep.duration_secs));

        // Permission is checked before anything is returned, cached episodes or not.
        // An empty whitelist means no providers; a missing column keeps legacy full access.
        const relation = await dbGet(db, "SELECT provider_id, external_series_id FROM provider_series_relations WHERE series_id = ? LIMIT 1", [numericSeriesId]);
        let allowedSources = null;
        try {
            const user = await userCache.get(req.session.userId);
            if (user && user.isAdmin !== 1 && user.allowed_sources) allowedSources = JSON.parse(user.allowed_sources);
            else if (!user) allowedSources = {};
        } catch (dbErr) {
            console.error("[API_VOD] Error checking user permissions:", dbErr);
            return res.status(500).json({ error: "Could not check access to this series." });
        }
        if (allowedSources && !(relation && allowedSources[relation.provider_id]?.allowed)) {
            console.warn(`[API_VOD_SERIES] Access denied for user ${req.session.username} to provider ${relation ? relation.provider_id : '(none)'}`);
            return res.status(403).json({ error: "Access denied to this series." });
        }

        // 3. If no episodes in DB or missing metadata, fetch from XC API and save/update
        if (needsEpisodeFetch) {
            console.log(`[API_VOD_SERIES] Fetching details and episode metadata from provider for Series ID ${numericSeriesId}...`);

            if (relation) {
                const settings = getSettings();
                const providerConfig = settings.m3uSources.find(s => s.id === relation.provider_id);
                if (providerConfig && providerConfig.type === 'xc' && providerConfig.xc_data) {
                    let xcInfo;
                    try {
                        xcInfo = JSON.parse(providerConfig.xc_data);
                    } catch (e) { }

                    if (xcInfo && xcInfo.server && xcInfo.username && xcInfo.password) {
                        const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
                        const client = new XtreamClient(xcInfo.server, xcInfo.username, xcInfo.password, activeUserAgent);
                        let seriesDetails = null;
                        try {
                            seriesDetails = await client.getSeriesInfo(relation.external_series_id);
                        } catch (xcError) {
                            console.error(`[API_VOD_SERIES] XC Client error for series ${numericSeriesId}: ${xcError.message}`);
                        }

                        if (seriesDetails && seriesDetails.info) {
                            const director = seriesDetails.info.director || seriesInfo.director || null;
                            const cast = seriesDetails.info.cast || seriesInfo.cast || null;
                            if ((director && director !== seriesInfo.director) || (cast && cast !== seriesInfo.cast)) {
                                // "cast" is quoted because CAST is an SQL keyword: unquoted, this statement was a syntax error whose failure the empty callback hid.
                                db.run('UPDATE series SET director = COALESCE(?, director), "cast" = COALESCE(?, "cast") WHERE id = ?', [director, cast, numericSeriesId], (updateErr) => {
                                    if (updateErr) console.error(`[API_VOD_SERIES] Could not save director/cast for Series ID ${numericSeriesId}: ${updateErr.message}`);
                                });
                                seriesInfo.director = director || seriesInfo.director;
                                seriesInfo.cast = cast || seriesInfo.cast;
                            }
                        }

                        if (seriesDetails && seriesDetails.episodes && typeof seriesDetails.episodes === 'object') {
                            console.log(`[API_VOD_SERIES] Processing episodes and metadata from provider for Series ID ${numericSeriesId}...`);
                            const toInt = (value) => Number.parseInt(value, 10);
                            const episodeRows = [];
                            for (const seasonNum in seriesDetails.episodes) {
                                const epList = seriesDetails.episodes[seasonNum];
                                if (!Array.isArray(epList)) continue;
                                for (const epData of epList) {
                                    const actualSeason = toInt(epData.season !== undefined ? epData.season : seasonNum);
                                    const actualEpisode = toInt(epData.episode_num !== undefined ? epData.episode_num : 1);
                                    if (!Number.isFinite(actualSeason) || !Number.isFinite(actualEpisode) || epData.id === undefined || epData.id === null) continue;
                                    const durationSecs = parseInt(epData.info?.duration_secs || epData.duration_secs || 0, 10) || null;
                                    episodeRows.push({
                                        season: actualSeason,
                                        episode: actualEpisode,
                                        name: epData.title || epData.name || `Episode ${actualEpisode}`,
                                        description: epData.info?.plot || epData.plot || null,
                                        airDate: epData.info?.releasedate || epData.info?.air_date || epData.releasedate || epData.air_date || null,
                                        duration: epData.info?.duration || epData.duration || (durationSecs ? `${Math.floor(durationSecs / 60)} min` : null),
                                        durationSecs,
                                        streamId: epData.id,
                                        containerExtension: epData.container_extension
                                    });
                                }
                            }

                            try {
                                await vodStore.saveEpisodes(numericSeriesId, relation.provider_id, episodeRows);
                                console.log(`[API_VOD_SERIES] Successfully updated episodes and metadata for Series ID ${numericSeriesId}.`);
                            } catch (dbError) {
                                console.error(`[API_VOD_SERIES] DB Error saving episodes for Series ID ${numericSeriesId}: ${dbError.message}`);
                            }

                            episodesToReturn = await dbAll(db, `
                                SELECT e.*, r.provider_id, r.provider_stream_id, r.container_extension
                                FROM episodes e
                                JOIN provider_episode_relations r ON e.id = r.episode_id
                                WHERE e.series_id = ?
                                ORDER BY e.season_num, e.episode_num
                            `, [numericSeriesId]);
                        }
                    }
                }
            }
        } else {
            console.log(`[API_VOD_SERIES] Found ${existingEpisodes.length} episodes with metadata in DB for Series ID ${numericSeriesId}.`);
        }

        // 4. Build the response structure
        const seasons = new Map();
        const settings = getSettings();
        const activeXcProviders = settings.m3uSources.filter(s => s.isActive && s.type === 'xc' && (!allowedSources || allowedSources[s.id]?.allowed));
        const providerMap = new Map();
        activeXcProviders.forEach(p => {
            try {
                const xcInfo = JSON.parse(p.xc_data);
                const url = new URL(xcInfo.server);
                providerMap.set(p.id, {
                    baseUrl: `${url.protocol}//${url.host}`,
                    username: xcInfo.username,
                    password: xcInfo.password
                });
            } catch (e) { /* ignore */ }
        });

        episodesToReturn.forEach(ep => {
            const provider = providerMap.get(ep.provider_id);
            if (!provider) return;

            const ext = ep.container_extension || 'mp4';
            const epUrl = `${provider.baseUrl}/series/${provider.username}/${provider.password}/${ep.provider_stream_id}.${ext}`;
            const seasonNum = ep.season_num;

            if (!seasons.has(seasonNum)) {
                seasons.set(seasonNum, []);
            }
            seasons.get(seasonNum).push({
                id: String(ep.id),
                name: ep.name,
                description: ep.description,
                air_date: ep.air_date,
                duration: ep.duration,
                duration_secs: ep.duration_secs,
                tmdb_id: ep.tmdb_id,
                season: ep.season_num,
                episode: ep.episode_num,
                url: epUrl
            });
        });

        const finalSeriesData = {
            ...seriesInfo,
            director: seriesInfo.director || null,
            cast: seriesInfo.cast || null,
            id: seriesInfo.provider_unique_id, // Use the stable provider_unique_id
            type: 'series',
            group: seriesInfo.category_name,
            seasons: Object.fromEntries(seasons)
        };

        res.json(finalSeriesData);

    } catch (error) {
        console.error(`[API_VOD_SERIES] Error fetching details for Series ID ${seriesIdParam}: ${error.message}`, error);
        res.status(500).json({ error: "Could not retrieve series details." });
    }
});
// --- END NEW ENDPOINT ---

// --- VOD downloads: resolve the provider URL server-side, never trust a client URL ---
let activeVodDownloads = 0;

function vodProviderMap(settings) {
    const map = new Map();
    (settings.m3uSources || []).filter(s => s.isActive && s.type === 'xc').forEach((source) => {
        try {
            const xc = JSON.parse(source.xc_data);
            const url = new URL(xc.server);
            map.set(source.id, {
                baseUrl: `${url.protocol}//${url.host}`,
                username: xc.username,
                password: xc.password,
            });
        } catch (e) { }
    });
    return map;
}

function readAllowedSources(user) {
    if (!user?.allowed_sources) return null;
    try {
        const parsed = JSON.parse(user.allowed_sources);
        return parsed && Object.keys(parsed).length ? parsed : null;
    } catch (e) {
        return null;
    }
}

function isVodProviderAllowed(allowedSources, providerId, category) {
    if (!allowedSources) return true;
    const perms = allowedSources[providerId];
    if (!perms?.allowed) return false;
    const groups = perms.groups || [];
    return groups.length === 0 || groups.includes(category);
}

async function resolveVodDownload(mediaType, id, userId) {
    const settings = getSettings();
    const providers = vodProviderMap(settings);
    const user = await userCache.get(userId);
    const allowedSources = readAllowedSources(user);
    let rows = [];
    if (mediaType === 'movie') {
        rows = await dbAll(db, `
            SELECT m.name, m.category_name, r.provider_id, r.stream_id, r.container_extension
            FROM movies m JOIN provider_movie_relations r ON m.id = r.movie_id
            WHERE m.provider_unique_id = ?`, [id]);
    } else {
        rows = await dbAll(db, `
            SELECT e.name, e.season_num, e.episode_num, s.name AS series_name, s.category_name,
                   r.provider_id, r.provider_stream_id AS stream_id, r.container_extension
            FROM episodes e
            JOIN series s ON s.id = e.series_id
            JOIN provider_episode_relations r ON r.episode_id = e.id
            WHERE e.id = ?`, [id]);
    }
    const row = rows.find(candidate => providers.has(candidate.provider_id) &&
        isVodProviderAllowed(allowedSources, candidate.provider_id, candidate.category_name));
    if (!row) return null;
    const provider = providers.get(row.provider_id);
    const ext = row.container_extension || 'mp4';
    const base = mediaType === 'movie'
        ? `${provider.baseUrl}/movie/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${encodeURIComponent(row.stream_id)}.${ext}`
        : `${provider.baseUrl}/series/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${encodeURIComponent(row.stream_id)}.${ext}`;
    const displayName = mediaType === 'movie'
        ? row.name
        : `${row.series_name} S${String(row.season_num).padStart(2, '0')}E${String(row.episode_num).padStart(2, '0')} - ${row.name}`;
    return { url: base, filename: sanitizeDownloadFilename(displayName, ext), userAgent: (settings.userAgents || []).find(ua => ua.id === settings.activeUserAgentId)?.value };
}

async function handleVodDownload(req, res, mediaType) {
    const settings = getSettings();
    if (!settings.downloads?.enabled) return res.status(403).json({ error: 'Downloads are disabled.' });
    const max = settings.downloads.maxConcurrent || 2;
    if (activeVodDownloads >= max) return res.status(429).json({ error: 'Too many active downloads. Try again shortly.' });

    let counted = false;
    let releaseDownload = null;
    try {
        const item = await resolveVodDownload(mediaType, req.params.id, req.session.userId);
        if (!item) return res.status(404).json({ error: 'VOD item not found or not authorized.' });
        await assertSafeMediaUrl(item.url, ['http:', 'https:']);
        activeVodDownloads++;
        counted = true;
        let finished = false;
        let upstreamResponse = null;
        const finish = () => { if (!finished) { finished = true; activeVodDownloads = Math.max(0, activeVodDownloads - 1); } };
        releaseDownload = finish;
        req.on('close', () => {
            finish();
            if (upstreamResponse) upstreamResponse.destroy();
        });
        const { response } = await safeGet(item.url, { headers: item.userAgent ? { 'User-Agent': item.userAgent } : {}, timeout: 30000 });
        upstreamResponse = response;
        response.setTimeout(60000, () => response.destroy(new Error('Provider download stalled.')));
        if (res.destroyed) {
            finish();
            response.destroy();
            return;
        }
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        const asciiName = item.filename.replace(/[^\x20-\x7e]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(item.filename)}`);
        res.on('close', () => { finish(); response.destroy(); });
        response.on('error', () => { finish(); if (!res.headersSent) res.status(502).end(); else res.destroy(); });
        response.pipe(res);
        response.on('end', finish);
    } catch (error) {
        if (releaseDownload) releaseDownload();
        else if (counted) activeVodDownloads = Math.max(0, activeVodDownloads - 1);
        console.error(`[VOD_DOWNLOAD] ${mediaType} ${req.params.id} failed:`, error.message);
        if (!res.headersSent) res.status(502).json({ error: 'Could not fetch this VOD from the provider.' });
        else res.destroy();
    }
}

app.get('/api/vod/download/movie/:id', requireAuth, (req, res) => handleVodDownload(req, res, 'movie'));
app.get('/api/vod/download/episode/:id', requireAuth, (req, res) => handleVodDownload(req, res, 'episode'));

// --- NEW: VOD Categories Endpoint ---
app.get('/api/vod/categories', requireAuth, async (req, res) => {
    console.log('[API_VOD] Request received for /api/vod/categories');
    try {
        const categories = await dbAll(db, "SELECT category_name FROM vod_categories ORDER BY category_name");
        const categoryNames = categories.map(cat => cat.category_name);
        res.json({ success: true, categories: categoryNames });
    } catch (error) {
        console.error(`[API_VOD] Error fetching VOD categories: ${error.message}`, error);
        res.status(500).json({ error: "Could not retrieve VOD categories." });
    }
});

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            if (!fs.existsSync(SOURCES_DIR)) {
                fs.mkdirSync(SOURCES_DIR, { recursive: true });
            }
            cb(null, SOURCES_DIR);
        },
        filename: (req, file, cb) => {
            cb(null, `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});


app.post('/api/sources', requireAuth, requireAdmin, upload.single('sourceFile'), async (req, res) => {
    // ADD selectedGroups to the destructured body
    const { sourceType, name, url, isActive, id, refreshHours, xc, selectedGroups } = req.body;

    console.log(`[SOURCES_API] ${id ? 'Updating' : 'Adding'} source. Type: ${sourceType}, Name: ${name}`);

    if (!sourceType || !name) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.warn('[SOURCES_API] Source type or name missing for source operation.');
        return res.status(400).json({ error: 'Source type and name are required.' });
    }

    const settings = getSettings();
    const sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;

    if (id) { // Update existing source
        const sourceIndex = sourceList.findIndex(s => s.id === id);
        if (sourceIndex === -1) {
            if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            console.warn(`[SOURCES_API] Source ID ${id} not found for update.`);
            return res.status(404).json({ error: 'Source to update not found.' });
        }

        const sourceToUpdate = sourceList[sourceIndex];
        console.log(`[SOURCES_API] Found existing source for update: ${sourceToUpdate.name}`);
        sourceToUpdate.name = name;
        sourceToUpdate.isActive = isActive === 'true';
        sourceToUpdate.refreshHours = parseInt(refreshHours, 10) || 0;
        sourceToUpdate.lastUpdated = new Date().toISOString();

        // ADDED: Save selectedGroups
        try {
            sourceToUpdate.selectedGroups = JSON.parse(selectedGroups || '[]');
        } catch (e) {
            console.warn(`[SOURCES_API] Could not parse selectedGroups for source ${id}, saving as empty array.`);
            sourceToUpdate.selectedGroups = [];
        }


        if (req.file) {
            console.log(`[SOURCES_API] New file uploaded for source ${id}. Deleting old file if exists.`);
            if (sourceToUpdate.type === 'file' && fs.existsSync(sourceToUpdate.path)) {
                try {
                    fs.unlinkSync(sourceToUpdate.path);
                    console.log(`[SOURCES_API] Deleted old file: ${sourceToUpdate.path}`);
                } catch (e) { console.error("[SOURCES_API] Could not delete old source file:", e); }
            }
            const extension = sourceType === 'm3u' ? '.m3u' : '.xml';
            const newPath = path.join(SOURCES_DIR, `${sourceType}_${id}${extension}`);
            try {
                fs.renameSync(req.file.path, newPath);
                sourceToUpdate.path = newPath;
                sourceToUpdate.type = 'file';
                delete sourceToUpdate.xc_data;
                console.log(`[SOURCES_API] Renamed uploaded file to: ${newPath}`);
            } catch (e) {
                console.error('[SOURCES_API] Error renaming updated source file:', e);
                return res.status(500).json({ error: 'Could not save updated file.' });
            }
        } else if (url !== undefined && url !== null) {
            console.log(`[SOURCES_API] URL provided for source ${id}.`);
            if (sourceToUpdate.type === 'file' && fs.existsSync(sourceToUpdate.path)) {
                try {
                    fs.unlinkSync(sourceToUpdate.path);
                    console.log(`[SOURCES_API] Deleted old file (switching to URL): ${sourceToUpdate.path}`);
                } catch (e) { console.error("[SOURCES_API] Could not delete old source file (on type change):", e); }
            }
            sourceToUpdate.path = url;
            sourceToUpdate.type = 'url';
            delete sourceToUpdate.xc_data;
        } else if (xc) {
            console.log(`[SOURCES_API] XC credentials provided for source ${id}.`);
            if (sourceToUpdate.type === 'file' && fs.existsSync(sourceToUpdate.path)) {
                try {
                    fs.unlinkSync(sourceToUpdate.path);
                } catch (e) { console.error("[SOURCES_API] Could not delete old source file (on type change):", e); }
            }
            sourceToUpdate.xc_data = xc;
            sourceToUpdate.type = 'xc';
            try {
                const xcData = JSON.parse(xc);
                sourceToUpdate.path = xcData.server || 'Xtream Codes Source';
            } catch (e) {
                sourceToUpdate.path = 'Xtream Codes Source';
            }
        } else if (sourceToUpdate.type === 'file' && !req.file && (!sourceToUpdate.path || !fs.existsSync(sourceToUpdate.path))) {
            console.warn(`[SOURCES_API] Existing file source ${id} has no file and no new file/URL provided.`);
            return res.status(400).json({ error: 'Existing file source requires a new file if original is missing.' });
        }

        // --- NEW: XC EPG Sync Logic on Update ---
        const wasXc = sourceToUpdate.type === 'xc';
        const isNowXc = (xc !== undefined && xc !== null);

        // Case 1: Type changed FROM XC to something else (URL or File)
        if (wasXc && !isNowXc) {
            const epgIdToDelete = `epg_for_${id}`;
            fs.rmSync(path.join(RAW_CACHE_DIR, `raw_${epgIdToDelete}.epg_cache`), { force: true });
            const initialEpgCount = settings.epgSources.length;
            settings.epgSources = settings.epgSources.filter(epg => epg.id !== epgIdToDelete);
            if (settings.epgSources.length < initialEpgCount) {
                console.log(`[SOURCES_API] Deleted managed EPG source ${epgIdToDelete} because parent source type changed from XC.`);
            }
        }

        // Case 2: Type changed TO XC from something else, or it IS XC and is being updated
        if (isNowXc) {
            const epgId = `epg_for_${id}`;
            let epgSource = settings.epgSources.find(epg => epg.id === epgId);

            try {
                const xcData = JSON.parse(xc);
                const newEpgUrl = `${xcData.server}/xmltv.php?username=${xcData.username}&password=${xcData.password}`;

                if (epgSource) { // EPG already exists, update it
                    console.log(`[SOURCES_API] Found and updating managed EPG source ${epgId}.`);
                    epgSource.name = `${name} (EPG)`;
                    epgSource.path = newEpgUrl;
                    epgSource.refreshHours = parseInt(refreshHours, 10) || 0;
                } else { // EPG does not exist, create it
                    console.log(`[SOURCES_API] Creating new managed EPG source ${epgId} because parent source type changed to XC.`);
                    epgSource = {
                        id: epgId,
                        name: `${name} (EPG)`,
                        type: 'url',
                        path: newEpgUrl,
                        isActive: true,
                        isXcEpg: true,
                        refreshHours: parseInt(refreshHours, 10) || 0,
                        lastUpdated: new Date().toISOString(),
                        status: 'Pending',
                        statusMessage: 'Managed by XC source. Process to load data.'
                    };
                    settings.epgSources.push(epgSource);
                }
            } catch (e) {
                console.error(`[SOURCES_API] Error processing XC data for EPG sync on update:`, e.message);
            }
        }
        // --- END NEW ---

        // Cache cleanup on source type/path/details change during update ---
        let shouldDeleteCache = false;
        const existingCachePath = sourceToUpdate.cachedRawPath; // Store existing path before potential changes

        // Determine the NEW source type based on the logic that just ran above this block
        let newSourceType = 'unknown';
        if (req.file) {
            newSourceType = 'file';
        } else if (url !== undefined && url !== null) {
            newSourceType = 'url';
        } else if (xc) {
            newSourceType = 'xc';
        } else {
            newSourceType = sourceToUpdate.type; // Keep original if no new info provided
        }


        // Condition 1: If it HAD a cache file, but the NEW type is 'file'
        if (existingCachePath && newSourceType === 'file') {
            console.log(`[SOURCES_API_CACHE_CLEANUP] Source ${id} changed to 'file' type. Flagging cache for deletion.`);
            shouldDeleteCache = true;
        }
        // Condition 2: If it HAD a cache file, the NEW type is 'url', AND the URL changed
        else if (existingCachePath && newSourceType === 'url' && sourceToUpdate.path !== url) {
            console.log(`[SOURCES_API_CACHE_CLEANUP] Source ${id} URL changed. Flagging cache for deletion.`);
            shouldDeleteCache = true;
        }
        // Condition 3: If it HAD a cache file, the NEW type is 'xc', AND the XC details changed
        else if (existingCachePath && newSourceType === 'xc' && sourceToUpdate.xc_data !== xc) {
            console.log(`[SOURCES_API_CACHE_CLEANUP] Source ${id} XC details changed. Flagging cache for deletion.`);
            shouldDeleteCache = true;
        }

        // Perform deletion if flagged
        if (shouldDeleteCache && fs.existsSync(existingCachePath)) {
            try {
                fs.unlinkSync(existingCachePath);
                console.log(`[SOURCES_API_CACHE_CLEANUP] Deleted stale cached raw file during update: ${existingCachePath}`);
            } catch (e) { console.error("[SOURCES_API_CACHE_CLEANUP] Could not delete stale cached raw file during update:", e); }
            // Remove the path property from the source object being saved
            delete sourceToUpdate.cachedRawPath;
        }

        saveSettings(settings);
        console.log(`[SOURCES_API] Source ${id} updated successfully.`);
        res.json({ success: true, message: 'Source updated successfully.', settings: getSettings() });

    } else { // Add new source
        let newSource;

        // Parse selectedGroups for new sources
        let parsedSelectedGroups = [];
        try {
            parsedSelectedGroups = JSON.parse(selectedGroups || '[]');
        } catch (e) {
            console.warn(`[SOURCES_API] Could not parse selectedGroups for new source, saving as empty array.`);
        }

        if (xc) { // It's an XC source
            let xcData = {};
            try {
                xcData = JSON.parse(xc);
            } catch (e) {
                console.error("Failed to parse XC JSON data:", e);
                return res.status(400).json({ error: 'Invalid XC data format.' });
            }
            newSource = {
                id: `src-${Date.now()}`,
                name,
                type: 'xc',
                path: xcData.server || 'Xtream Codes Source',
                xc_data: xc,
                isActive: isActive === 'true',
                refreshHours: parseInt(refreshHours, 10) || 0,
                lastUpdated: new Date().toISOString(),
                status: 'Pending',
                statusMessage: 'Source added. Process to load data.',
                selectedGroups: parsedSelectedGroups // ADDED
            };
        } else { // It's a URL or File source
            newSource = {
                id: `src-${Date.now()}`,
                name,
                type: req.file ? 'file' : 'url',
                path: req.file ? req.file.path : url,
                isActive: isActive === 'true',
                refreshHours: parseInt(refreshHours, 10) || 0,
                lastUpdated: new Date().toISOString(),
                status: 'Pending',
                statusMessage: 'Source added. Process to load data.',
                selectedGroups: parsedSelectedGroups // ADDED
            };
        }

        if (newSource.type === 'url' && !newSource.path) {
            console.warn('[SOURCES_API] New URL source failed: URL is required.');
            return res.status(400).json({ error: 'URL is required for URL-type source.' });
        }
        if (newSource.type === 'file' && !req.file) {
            console.warn('[SOURCES_API] New file source failed: A file must be selected.');
            return res.status(400).json({ error: 'A file must be selected for new file-based sources.' });
        }

        if (req.file) {
            const extension = sourceType === 'm3u' ? '.m3u' : '.xml';
            const newPath = path.join(SOURCES_DIR, `${sourceType}_${newSource.id}${extension}`);
            try {
                fs.renameSync(req.file.path, newPath);
                newSource.path = newPath;
                console.log(`[SOURCES_API] Renamed uploaded file for new source to: ${newPath}`);
            } catch (e) {
                console.error('[SOURCES_API] Error renaming new source file:', e);
                return res.status(500).json({ error: 'Could not save uploaded file.' });
            }
        }

        sourceList.push(newSource);

        // --- NEW: Automatically add an EPG source for new XC sources ---
        if (newSource.type === 'xc') {
            try {
                const xcData = JSON.parse(newSource.xc_data);
                const epgUrl = `${xcData.server}/xmltv.php?username=${xcData.username}&password=${xcData.password}`;
                const newEpgSource = {
                    id: `epg_for_${newSource.id}`,
                    name: `${newSource.name} (EPG)`,
                    type: 'url',
                    path: epgUrl,
                    isActive: true, // Default to active
                    isXcEpg: true, // Mark as a managed XC EPG
                    refreshHours: newSource.refreshHours, // Sync refresh interval
                    lastUpdated: new Date().toISOString(),
                    status: 'Pending',
                    statusMessage: 'Managed by XC source. Process to load data.'
                };
                settings.epgSources.push(newEpgSource);
                console.log(`[SOURCES_API] Automatically added managed EPG source for XC source "${newSource.name}".`);
            } catch (e) {
                console.error(`[SOURCES_API] Failed to create automatic EPG for new XC source ${newSource.id}:`, e.message);
            }
        }
        // --- END NEW ---

        saveSettings(settings);
        console.log(`[SOURCES_API] New source "${name}" added successfully (ID: ${newSource.id}).`);
        res.json({ success: true, message: 'Source added successfully.', id: newSource.id, settings: getSettings() });
    }
});


app.put('/api/sources/:sourceType/:id', requireAuth, requireAdmin, (req, res) => {
    const { sourceType, id } = req.params;
    const { name, path: newPath, isActive } = req.body;
    console.log(`[SOURCES_API] Partial update source ID: ${id}, Type: ${sourceType}, isActive: ${isActive}`);

    const settings = getSettings();
    const sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;
    const sourceIndex = sourceList.findIndex(s => s.id === id);

    if (sourceIndex === -1) {
        console.warn(`[SOURCES_API] Source ID ${id} not found for partial update.`);
        return res.status(404).json({ error: 'Source not found.' });
    }

    const source = sourceList[sourceIndex];
    source.name = name ?? source.name;
    source.isActive = isActive ?? source.isActive;
    if (source.type === 'url' && newPath !== undefined) {
        source.path = newPath;
    }
    source.lastUpdated = new Date().toISOString();

    saveSettings(settings);
    console.log(`[SOURCES_API] Source ${id} partially updated.`);
    res.json({ success: true, message: 'Source updated.', settings: getSettings() });
});

app.delete('/api/sources/:sourceType/:id', requireAuth, requireAdmin, async (req, res) => {
    const { sourceType, id } = req.params;
    console.log(`[SOURCES_API] Deleting source ID: ${id}, Type: ${sourceType}`);

    const settings = getSettings();
    let sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;
    const source = sourceList.find(s => s.id === id);

    if (source && source.type === 'file' && fs.existsSync(source.path)) {
        try {
            fs.unlinkSync(source.path);
            console.log(`[SOURCES_API] Deleted associated file: ${source.path}`);
        } catch (e) {
            console.error(`[SOURCES_API] Could not delete source file: ${source.path}`, e);
        }
    }

    if (source && source.cachedRawPath && fs.existsSync(source.cachedRawPath)) {
        try {
            fs.unlinkSync(source.cachedRawPath);
            console.log(`[SOURCES_API] Deleted cached raw file: ${source.cachedRawPath}`);
        } catch (e) {
            console.error(`[SOURCES_API] Could not delete cached raw file: ${source.cachedRawPath}`, e);
        }
    }

    const initialLength = sourceList.length;
    const newList = sourceList.filter(s => s.id !== id);
    if (sourceType === 'm3u') settings.m3uSources = newList;
    else settings.epgSources = newList;

    if (newList.length === initialLength) {
        console.warn(`[SOURCES_API] Source ID ${id} not found for deletion.`);
        return res.status(404).json({ error: 'Source not found.' });
    }

    // --- NEW: Automatically delete the managed EPG when an XC source is deleted ---
    if (sourceType === 'm3u' && source && source.type === 'xc') {
        const epgIdToDelete = `epg_for_${id}`;
        fs.rmSync(path.join(RAW_CACHE_DIR, `raw_${epgIdToDelete}.epg_cache`), { force: true });
        const initialEpgCount = settings.epgSources.length;
        settings.epgSources = settings.epgSources.filter(epg => epg.id !== epgIdToDelete);
        if (settings.epgSources.length < initialEpgCount) {
            console.log(`[SOURCES_API] Automatically deleted managed EPG source ${epgIdToDelete} as its parent XC source was deleted.`);
        }
    }
    // --- END NEW ---

    saveSettings(settings);
    console.log(`[SOURCES_API] Source ${id} deleted successfully from settings.`);

    // --- NEW: VOD Database Cleanup ---
    if (sourceType === 'm3u' && source.type === 'xc') {
        try {
            console.log(`[SOURCES_API] Deleting VOD relations for provider: ${id}`);
            await vodStore.removeProvider(id);
            console.log(`[SOURCES_API] Successfully cleaned up VOD data for provider: ${id}`);
        } catch (dbErr) {
            console.error(`[SOURCES_API] Error cleaning up VOD data for provider ${id}:`, dbErr.message);
        }
    }
    // --- END NEW ---

    res.json({ success: true, message: 'Source deleted.', settings: getSettings() });
});

app.post('/api/process-sources', requireAuth, requireAdmin, async (req, res) => {
    console.log('[API] Received request to /api/process-sources (manual trigger).');
    const { sourceId } = req.body || {}; // optional: refresh only this source
    const settings = getSettings();
    if (sourceId && ![...settings.m3uSources, ...settings.epgSources].some(s => s.id === sourceId && s.isActive)) {
        return res.status(404).json({ error: 'Active source not found.' });
    }
    try {
        // An XC source is refreshed together with its managed EPG.
        const result = await runSourceProcessing(req, sourceId && [sourceId, `epg_for_${sourceId}`]);

        // Save the successful sources even when another one failed.
        saveProcessedSettings(result.updatedSettings);
        console.log('[API] Source processing completed and settings saved (manual trigger).');
        res.json({ success: result.success, message: result.message, failedSources: result.failedSources });
    }
    catch (error) {
        console.error("[API] Error during manual source processing:", error);
        sendProcessingStatus(req, `A critical error occurred: ${error.message}`, 'error'); // <-- MODIFIED
        res.status(500).json({ error: 'Failed to process sources. Check server logs.' });
    }
});


// --- Manual EPG assignment (admin) ---
// Search what the guides declare; empty q lists the first few.
app.get('/api/epg/channels', requireAuth, requireAdmin, (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json(q ? suggestEpg(q, limit) : (readEpgChannels() || NO_EPG_CHANNELS).slice(0, limit));
});

// Best guess per channel, saved to the suggestion store so refresh/restart and re-runs lose nothing.
// Capped per call (a search is a few ms): the client sends big lists in batches so the server stays responsive.
// With `llm`, channels the name search is not sure about are put to a small model on OpenRouter, choosing among
// the search's own top candidates. Only those channel and guide names leave the server.
const MAX_SUGGEST_BATCH = 300;
const AI_CONFIDENCE = 0.8; // a model's pick has no score: shown, but never part of "accept all confident"

// Per-chunk suggest, shared by the single-shot endpoint and the background job.
const suggestFor = (items, withAi) => {
    const { apiKey, model } = readAiConfig() || {};
    return suggestChunk(items, { suggestName: suggestEpg, bestOf: bestMatch, pickWithLlm, withAi, apiKey, model, CONFIDENT, AI_CONFIDENCE });
};

app.post('/api/epg/suggest', requireAuth, requireAdmin, async (req, res) => {
    const { channelIds, llm } = req.body || {};
    if (!Array.isArray(channelIds) || channelIds.length > MAX_SUGGEST_BATCH) {
        return res.status(400).json({ error: `channelIds must be a list of at most ${MAX_SUGGEST_BATCH}.` });
    }
    if (llm && !(readAiConfig()?.apiKey && readAiConfig()?.model)) return res.status(400).json({ error: AI_UNSET });
    const wanted = new Set(channelIds);
    const items = (readChannels() || []).filter((c) => wanted.has(c.id)).map((c) => ({ id: c.id, name: c.displayName, group: c.group }));
    const { suggestions, error } = await suggestFor(items, !!llm);
    if (error) return res.status(502).json({ error: `AI matching failed: ${error}` });
    const list = Object.values(suggestions);
    if (list.length) suggestStore.merge(list);
    res.json({ suggestions: list });
});

app.get('/api/epg/suggest', requireAuth, requireAdmin, (req, res) => res.json({ suggestions: suggestStore.all() }));

app.delete('/api/epg/suggest', requireAuth, requireAdmin, (req, res) => {
    // {all: true} starts matching over: a re-run skips channels that still have a suggestion.
    if (req.body?.all === true) {
        if (epgMatchState.status === 'running') return res.status(409).json({ error: 'Matching is running. Wait for it to finish.' });
        suggestStore.remove(suggestStore.all().map((s) => s.channelId));
        return res.json({ success: true });
    }
    const { channelIds } = req.body || {};
    if (!Array.isArray(channelIds) || !channelIds.every((v) => typeof v === 'string') || channelIds.length > 10000) {
        return res.status(400).json({ error: 'channelIds must be a list of channel ids.' });
    }
    suggestStore.remove(channelIds);
    res.json({ success: true });
});

// --- Background matching over every unresolved channel (admin) ---
// State lives in memory; the suggestion store is the resume point, so a restart re-POSTs and skips stored ones.
let epgMatchState = { status: 'idle', totalChunks: 0, chunkSize: 0, done: 0, suggested: 0, failed: 0, error: null };
let epgMatchRunning = null; // Promise of the in-flight run, to serialize starts

function startMatch(useAi) {
    if (epgMatchState.status === 'running') return epgMatchRunning;
    const stored = new Set(suggestStore.all().map((s) => s.channelId));
    const overrides = getSettings().epgOverrides || {};
    const withGuide = new Set(readEpgKeys() || []);
    const items = (readChannels() || [])
        .filter((c) => !overrides[c.id] && !withGuide.has(c.id) && !stored.has(c.id))
        .map((c) => ({ id: c.id, name: c.displayName, group: c.group }));
    const chunkSize = useAi ? 100 : 300; // one AI request per chunk (epgLlm BATCH)
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));

    epgMatchState = { status: 'running', useAi, totalChunks: chunks.length, totalChannels: items.length, chunkSize, done: 0, suggested: 0, failed: 0, error: null };
    epgMatchRunning = (async () => {
        try {
            await runMatchJob({
                chunks,
                processChunk: (chunk) => suggestFor(chunk, useAi),
                persist: (list) => suggestStore.merge(list),
                concurrency: useAi ? 4 : 1,
                onProgress: ({ done, total, suggested, failed }) => { Object.assign(epgMatchState, { done, totalChunks: total, suggested, failed }); },
            });
            epgMatchState.status = 'done';
        } catch (e) {
            epgMatchState = { ...epgMatchState, status: 'done', error: e.message };
        }
    })();
    return epgMatchRunning;
}

app.post('/api/epg/match', requireAuth, requireAdmin, (req, res) => {
    const useAi = !!req.body?.useAi;
    if (useAi && !(readAiConfig()?.apiKey && readAiConfig()?.model)) return res.status(400).json({ error: AI_UNSET });
    if (epgMatchState.status === 'running') return res.json({ started: false, ...epgMatchState });
    startMatch(useAi);
    res.json({ started: true, ...epgMatchState });
});

app.get('/api/epg/match', requireAuth, requireAdmin, (req, res) => {
    res.json({ ...epgMatchState, stored: suggestStore.all().length });
});

// --- AI matching settings (admin) ---
// The key is never sent back: the browser only learns whether one is set and how it ends.
app.get('/api/epg/ai', requireAuth, requireAdmin, (req, res) => res.json(aiStatus(readAiConfig())));

app.put('/api/epg/ai', requireAuth, requireAdmin, (req, res) => {
    let next;
    try {
        next = updateAiConfig(readAiConfig() || {}, req.body);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
    writeFileAtomic(OPENROUTER_PATH, JSON.stringify(next), 0o600);
    res.json(aiStatus(next));
});

// OpenRouter's own model list, with prices, for the model picker.
app.get('/api/epg/ai/models', requireAuth, requireAdmin, async (req, res) => {
    try {
        res.json(searchModels(await listModels(), req.query.q, req.query.all ? Infinity : 50));
    } catch (error) {
        res.status(502).json({ error: `Could not load OpenRouter's model list: ${error.message}` });
    }
});

// One real, tiny completion with the saved key and model: proves the key, the model and the credit all at once.
app.post('/api/epg/ai/test', requireAuth, requireAdmin, async (req, res) => {
    const { apiKey, model } = readAiConfig() || {};
    if (!(apiKey && model)) return res.status(400).json({ error: AI_UNSET });
    try {
        const reply = await chat({ apiKey, model, maxTokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
        res.json({ ok: true, model, reply: reply.trim() });
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

// {set: {channelId: xmltvId}, clear: [channelId]}. Re-merges the guides (not the playlists) so it shows at once.
let epgRemerge = Promise.resolve(); // one at a time: merges share their temp files
let epgRemergeQueued = false;

// Queues one guide re-merge; saves made while one waits ride along, since it reads the settings when it starts.
function scheduleEpgRemerge(req, channels) {
    if (epgRemergeQueued) return;
    epgRemergeQueued = true;
    epgRemerge = epgRemerge.then(async () => {
        epgRemergeQueued = false;
        const settings = getSettings();
        // Same shape as processAndMergeSources builds from the playlists; the prefix before the first "_" is the source id.
        const liveChannels = new Map(channels.map(c => [c.id, { originalId: c.id.slice(c.id.indexOf('_') + 1), name: c.displayName, tvgName: c.name, group: c.group }]));
        await mergeEpg(req, settings, liveChannels, [], []);
        settings.sourcesLastUpdated = new Date().toISOString(); // tells every client its cached guide is stale
        saveProcessedSettings(settings);
    }).catch((error) => console.error('[API] Error re-merging the guide after EPG overrides:', error));
}

app.put('/api/epg/overrides', requireAuth, requireAdmin, async (req, res) => {
    const { set = {}, clear = [] } = req.body || {};
    const isIdMap = set && typeof set === 'object' && !Array.isArray(set) && Object.values(set).every(v => typeof v === 'string');
    if (!isIdMap || !Array.isArray(clear) || !clear.every(v => typeof v === 'string')) {
        return res.status(400).json({ error: 'Expected {set: {channelId: epgChannelId}, clear: [channelId]}.' });
    }
    const channels = readChannels() || [];
    const channelIds = new Set(channels.map(c => c.id));
    const epgIds = new Set((readEpgChannels() || NO_EPG_CHANNELS).map(c => c.id));
    const unknown = Object.entries(set).find(([id, epgId]) => !channelIds.has(id) || !epgIds.has(epgId));
    if (unknown) return res.status(400).json({ error: `Unknown channel or EPG channel: ${unknown[0]} -> ${unknown[1]}` });

    // Saved before answering, not after the re-merge: on a big guide that takes minutes, and a refresh
    // meanwhile would show the accepted suggestions again.
    const settings = getSettings();
    settings.epgOverrides = { ...settings.epgOverrides, ...set };
    for (const id of clear) delete settings.epgOverrides[id];
    writeSettings(settings);
    // Accepted suggestions are no longer pending: drop them from the store so they do not resurface.
    if (Object.keys(set).length) suggestStore.remove(Object.keys(set));
    res.json({ success: true, epgOverrides: settings.epgOverrides });
    scheduleEpgRemerge(req, channels);
});

app.post('/api/save/settings', requireAuth, requireAdmin, async (req, res) => {
    console.log('[API] Received request to /api/save/settings.');
    try {
        let currentSettings = getSettings();

        const oldTimezone = currentSettings.timezoneOffset;
        const oldTimeZone = currentSettings.timeZone;

        const updatedSettings = { ...currentSettings };
        for (const key in req.body) {
            if (!['favorites', 'playerDimensions', 'programDetailsDimensions', 'recordingPlayerDimensions', 'recentChannels', 'multiviewLayouts', 'channelColumnWidth', 'deviceSettings'].includes(key)) {
                updatedSettings[key] = req.body[key];
            } else {
                console.warn(`[SETTINGS_SAVE] Attempted to save user-specific key "${key}" to global settings. This is ignored.`);
            }
        }
        // A partial client update must not wipe the existing profile list or nested defaults.
        updatedSettings.dvr = { ...currentSettings.dvr, ...(updatedSettings.dvr || {}) };
        updatedSettings.downloads = { ...currentSettings.downloads, ...(updatedSettings.downloads || {}) };
        updatedSettings.liveRewind = { ...currentSettings.liveRewind, ...(updatedSettings.liveRewind || {}) };

        saveSettings(updatedSettings);

        if (updatedSettings.timezoneOffset !== oldTimezone || updatedSettings.timeZone !== oldTimeZone) {
            console.log("[API] Timezone setting changed, re-processing sources.");
            const result = await runSourceProcessing(null, undefined, true);
            saveProcessedSettings(result.updatedSettings);
            if (!result.success) console.warn(`[API] ${result.message}`);
        }

        res.json({ success: true, message: 'Settings saved.', settings: getSettings() });
    } catch (error) {
        console.error("[API] Error saving global settings:", error);
        res.status(500).json({ error: "Could not save settings. Check server logs." });
    }
});
// ... existing endpoint ...
app.post('/api/user/settings', requireAuth, (req, res) => {
    const { key, value } = req.body;
    const userId = req.session.userId;
    console.log(`[API] Saving user setting for user ${userId}: ${key}`);

    if (!key) {
        return res.status(400).json({ error: 'A setting key is required.' });
    }

    const valueJson = JSON.stringify(value);

    const saveAndRespond = () => {
        let globalSettings = getSettings();
        db.all(`SELECT key, value FROM user_settings WHERE user_id = ?`, [userId], (err, rows) => {
            if (err) {
                console.error("[API] Error re-fetching user settings after save:", err);
                return res.status(500).json({ error: 'Could not retrieve updated settings.' });
            }
            const userSettings = {};
            rows.forEach(row => {
                try { userSettings[row.key] = JSON.parse(row.value); }
                catch (e) { userSettings[row.key] = row.value; }
            });

            const finalSettings = { ...globalSettings, ...userSettings };
            res.json({ success: true, settings: finalSettings });
        });
    };

    db.run(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
        [userId, key, valueJson],
        function (err) {
            if (err) {
                console.error(`[API] Error saving user setting for user ${userId}, key ${key}:`, err);
                return res.status(500).json({ error: 'Could not save user setting.' });
            }
            console.log(`[API] User setting for user ${userId}, key ${key} saved successfully.`);
            saveAndRespond();
        }
    );
});

// --- NEW: Watch Progress Endpoints (Cross-Device Resume) ---
app.get('/api/progress/:contentType/:contentId', requireAuth, (req, res) => {
    const { contentType, contentId } = req.params;
    const userId = req.session.userId;

    db.get(
        `SELECT progress_seconds, duration_seconds, updated_at FROM watch_progress WHERE user_id = ? AND content_type = ? AND content_id = ?`,
        [userId, contentType, String(contentId)],
        (err, row) => {
            if (err) {
                console.error('[WATCH_PROGRESS] Error querying progress:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            if (row) {
                return res.json(row);
            }
            // Fallback for DVR completed recordings: check if user watched it previously as an in-progress live timeshift job
            if (contentType === 'dvr_recording') {
                db.get("SELECT job_id FROM dvr_recordings WHERE id = ? OR filePath LIKE ?", [contentId, `%${contentId}%`], (jErr, rec) => {
                    if (!jErr && rec && rec.job_id) {
                        db.get(
                            `SELECT progress_seconds, duration_seconds, updated_at FROM watch_progress WHERE user_id = ? AND content_type = 'dvr_job' AND content_id = ?`,
                            [userId, String(rec.job_id)],
                            (tjErr, jobRow) => {
                                if (!tjErr && jobRow) {
                                    return res.json(jobRow);
                                }
                                return res.json(null);
                            }
                        );
                    } else {
                        return res.json(null);
                    }
                });
            } else {
                res.json(null);
            }
        }
    );
});

app.post('/api/progress', requireAuth, bodyParser.text({ type: ['text/*', 'application/json'] }), (req, res) => {
    const userId = req.session.userId;
    let data = req.body;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON payload' });
        }
    }
    if (!data) return res.status(400).json({ error: 'Payload missing' });

    const { contentType, contentId, progressSeconds, durationSeconds } = data;
    if (!contentType || !contentId) {
        return res.status(400).json({ error: 'contentType and contentId are required' });
    }

    const progSec = Math.max(0, parseFloat(progressSeconds) || 0);
    const durSec = Math.max(0, parseFloat(durationSeconds) || 0);

    // If progress is 0 or completed (>95% of total duration), remove record so it starts fresh next time
    if (progSec <= 0 || (durSec > 0 && (progSec / durSec) >= 0.95)) {
        db.run(
            `DELETE FROM watch_progress WHERE user_id = ? AND content_type = ? AND content_id = ?`,
            [userId, contentType, String(contentId)],
            (err) => {
                if (err) console.error('[WATCH_PROGRESS] Error clearing progress:', err);
                res.json({ success: true, cleared: true });
            }
        );
    } else {
        db.run(
            `INSERT INTO watch_progress (user_id, content_type, content_id, progress_seconds, duration_seconds, updated_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id, content_type, content_id) DO UPDATE SET
                progress_seconds = excluded.progress_seconds,
                duration_seconds = excluded.duration_seconds,
                updated_at = CURRENT_TIMESTAMP`,
            [userId, contentType, String(contentId), progSec, durSec],
            (err) => {
                if (err) {
                    console.error('[WATCH_PROGRESS] Error saving progress:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({ success: true, progressSeconds: progSec, durationSeconds: durSec });
            }
        );
    }
});

app.delete('/api/progress/:contentType/:contentId', requireAuth, (req, res) => {
    const { contentType, contentId } = req.params;
    const userId = req.session.userId;
    db.run(
        `DELETE FROM watch_progress WHERE user_id = ? AND content_type = ? AND content_id = ?`,
        [userId, contentType, String(contentId)],
        (err) => {
            if (err) {
                console.error('[WATCH_PROGRESS] Error deleting progress:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ success: true });
        }
    );
});

// --- Notification Endpoints ---
// ... existing endpoints ...
app.get('/api/notifications/vapid-public-key', requireAuth, (req, res) => {
    console.log('[PUSH_API] Request for VAPID public key.');
    if (!vapidKeys.publicKey) {
        console.error('[PUSH_API] VAPID public key not available on the server.');
        return res.status(500).json({ error: 'VAPID public key not available on the server.' });
    }
    res.send(vapidKeys.publicKey);
});

app.post('/api/notifications/subscribe', requireAuth, (req, res) => {
    console.log(`[PUSH_API] Subscribe request for user ${req.session.userId}.`);
    const subscription = req.body;
    const userId = req.session.userId;

    if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
        console.warn('[PUSH_API] Invalid subscription object received.');
        return res.status(400).json({ error: 'Invalid subscription object.' });
    }

    const { endpoint, keys: { p256dh, auth } } = subscription;

    db.run(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`,
        [userId, endpoint, p256dh, auth],
        function (err) {
            if (err) {
                console.error(`[PUSH_API] Error saving push subscription for user ${userId}:`, err);
                return res.status(500).json({ error: 'Could not save subscription.' });
            }
            console.log(`[PUSH] User ${userId} subscribed with endpoint: ${endpoint}. (ID: ${this.lastID || 'existing'})`);
            res.status(201).json({ success: true });
        }
    );
});

app.post('/api/notifications/unsubscribe', requireAuth, (req, res) => {
    console.log(`[PUSH_API] Unsubscribe request for user ${req.session.userId}.`);
    const { endpoint } = req.body;
    if (!endpoint) {
        console.warn('[PUSH_API] Unsubscribe failed: Endpoint is required.');
        return res.status(400).json({ error: 'Endpoint is required to unsubscribe.' });
    }

    db.run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", [endpoint, req.session.userId], function (err) {
        if (err) {
            console.error(`[PUSH_API] Error deleting push subscription for user ${req.session.userId}, endpoint ${endpoint}:`, err);
            return res.status(500).json({ error: 'Could not unsubscribe.' });
        }
        if (this.changes === 0) {
            console.warn(`[PUSH_API] No subscription found for user ${req.session.userId} with endpoint ${endpoint} for deletion.`);
            return res.status(404).json({ error: 'Subscription not found or unauthorized.' });
        }
        console.log(`[PUSH] User ${req.session.userId} unsubscribed from endpoint: ${endpoint}`);
        res.json({ success: true });
    });
});

app.post('/api/notifications', requireAuth, (req, res) => {
    const { channelId, channelName, channelLogo, programTitle, programDesc, programStart, programStop, scheduledTime, programId } = req.body;
    const userId = req.session.userId;

    if (!channelId || !programTitle || !programStart || !scheduledTime || !programId || !channelName) {
        console.error(`[PUSH_API_ERROR] Add notification failed for user ${userId} due to missing data.`, { body: req.body });
        return res.status(400).json({ error: 'Invalid notification data. All required fields must be provided.' });
    }

    console.log(`[PUSH_API] Adding notification for user ${userId}. Program: "${programTitle}", Channel: "${channelName}", Scheduled Time: ${scheduledTime}`);

    db.run(`INSERT INTO notifications (user_id, channelId, channelName, channelLogo, programTitle, programDesc, programStart, programStop, notificationTime, programId, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [userId, channelId, channelName, channelLogo || '', programTitle, programDesc || '', programStart, programStop, scheduledTime, programId],
        function (err) {
            if (err) {
                console.error(`[PUSH_API_ERROR] Database error adding notification for user ${userId}:`, err);
                return res.status(500).json({ error: 'Could not add notification to the database.' });
            }
            const notificationId = this.lastID;
            console.log(`[PUSH_API] Notification added successfully for program "${programTitle}" (DB ID: ${notificationId}) for user ${userId}.`);

            db.all("SELECT id FROM push_subscriptions WHERE user_id = ?", [userId], (subErr, subs) => {
                if (subErr) {
                    console.error(`[PUSH_API_ERROR] Could not fetch subscriptions for user ${userId} to create deliveries.`, subErr);
                    return;
                }
                const now = new Date().toISOString();
                const deliveryStmt = db.prepare("INSERT INTO notification_deliveries (notification_id, subscription_id, status, updatedAt) VALUES (?, ?, 'pending', ?)");
                subs.forEach(sub => {
                    deliveryStmt.run(notificationId, sub.id, now);
                });
                deliveryStmt.finalize(finalizeErr => {
                    if (finalizeErr) console.error(`[PUSH_API_ERROR] Error finalizing delivery creation for notification ${notificationId}.`, finalizeErr);
                    else console.log(`[PUSH_API] Created ${subs.length} delivery records for notification ${notificationId}.`);
                });
            });

            res.status(201).json({ success: true, id: notificationId });
        }
    );
});
app.get('/api/notifications', requireAuth, (req, res) => {
    console.log(`[PUSH_API] Fetching notifications for user ${req.session.userId}.`);
    const query = `
        SELECT
            n.id,
            n.user_id,
            n.channelId,
            n.channelName,
            n.channelLogo,
            n.programTitle,
            n.programDesc,
            n.programStart,
            n.programStop,
            n.notificationTime as scheduledTime,
            n.programId,
            -- Determine the overall status based on its deliveries
            CASE
                WHEN (SELECT COUNT(*) FROM notification_deliveries WHERE notification_id = n.id AND status = 'sent') > 0 THEN 'sent'
                WHEN (SELECT COUNT(*) FROM notification_deliveries WHERE notification_id = n.id AND status = 'expired') > 0 THEN 'expired'
                ELSE n.status
            END as status,
            -- Use the latest delivery update time as the triggeredAt time for consistency
            (SELECT MAX(updatedAt) FROM notification_deliveries WHERE notification_id = n.id AND status = 'sent') as triggeredAt
        FROM notifications n
        WHERE n.user_id = ?
        ORDER BY n.notificationTime DESC
    `;
    db.all(query, [req.session.userId], (err, rows) => {
        if (err) {
            console.error('[PUSH_API] Error fetching consolidated notifications from database:', err);
            return res.status(500).json({ error: 'Could not retrieve notifications.' });
        }
        console.log(`[PUSH_API] Found ${rows.length} consolidated notifications for user ${req.session.userId}.`);
        res.json(rows);
    });
});

// MODIFIED: Reordered this route to be BEFORE the /:id route to fix the 404 error.
app.delete('/api/notifications/past', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const now = new Date().toISOString();
    console.log(`[PUSH_API] Clearing all past notifications for user ${userId}.`);

    // This query deletes notifications whose scheduled trigger time is in the past.
    db.run(`DELETE FROM notifications WHERE user_id = ? AND notificationTime <= ?`,
        [userId, now],
        function (err) {
            if (err) {
                console.error(`[PUSH_API] Error deleting past notifications for user ${userId}:`, err.message);
                return res.status(500).json({ error: 'Could not clear past notifications.' });
            }
            console.log(`[PUSH_API] Cleared ${this.changes} past notifications for user ${userId}.`);
            res.json({ success: true, deletedCount: this.changes });
        }
    );
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    console.log(`[PUSH_API] Deleting notification ID: ${id} for user ${req.session.userId}.`);
    db.run(`DELETE FROM notifications WHERE id = ? AND user_id = ?`,
        [id, req.session.userId],
        function (err) {
            if (err) {
                console.error(`[PUSH_API] Error deleting notification ${id} from database:`, err);
                return res.status(500).json({ error: 'Could not delete notification.' });
            }
            if (this.changes === 0) {
                console.warn(`[PUSH_API] Notification ${id} not found or unauthorized for user ${req.session.userId}.`);
                return res.status(404).json({ error: 'Notification not found or unauthorized.' });
            }
            console.log(`[PUSH_API] Notification ${id} deleted successfully for user ${req.session.userId}.`);
            res.json({ success: true });
        });
});

app.delete('/api/data', requireAuth, requireAdmin, (req, res) => {
    console.log(`[API_RESET] ADMIN ACTION: Received request to /api/data (HARD RESET) from admin ${req.session.username}.`);
    try {
        console.log('[API_RESET] Stopping all scheduled tasks...');
        if (notificationCheckInterval) clearInterval(notificationCheckInterval);
        for (const timer of sourceRefreshTimers.values()) clearTimeout(timer);
        sourceRefreshTimers.clear();
        for (const job of activeDvrJobs.values()) job.cancel();
        activeDvrJobs.clear();
        for (const supervisor of activeDvrSupervisors.values()) supervisor.stop();
        activeDvrSupervisors.clear();
        for (const { process: ffmpegProcess } of activeStreamProcesses.values()) {
            try { ffmpegProcess.kill('SIGKILL'); } catch (e) { }
        }
        activeStreamProcesses.clear();
        for (const pid of runningFFmpegProcesses.values()) {
            try { process.kill(pid, 'SIGKILL'); } catch (e) { }
        }
        runningFFmpegProcesses.clear();
        for (const channelId of activeLiveBuffers.keys()) stopLiveBuffer(channelId);
        activeLiveBuffers.clear();

        console.log('[API_RESET] Wiping all data files...');
        const filesToDelete = [LIVE_CHANNELS_M3U_PATH, LIVE_EPG_JSON_PATH, EPG_CHANNELS_JSON_PATH, VOD_MOVIES_JSON_PATH, VOD_SERIES_JSON_PATH, SETTINGS_PATH, VAPID_KEYS_PATH, OPENROUTER_PATH];
        filesToDelete.forEach(file => {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        });

        [SOURCES_DIR, DVR_DIR].forEach(dir => {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        console.log('[API_RESET] Wiping all database tables...');
        const tables = ['stream_history', 'dvr_recordings', 'dvr_jobs', 'dvr_series_rules', 'notification_deliveries', 'notifications', 'push_subscriptions', 'multiview_layouts', 'user_settings', 'watch_progress', 'provider_episode_relations', 'provider_series_relations', 'provider_movie_relations', 'episodes', 'series', 'movies', 'vod_categories', 'users', 'sessions'];
        db.serialize(() => {
            tables.forEach(table => {
                db.run(`DELETE FROM ${table}`, (err) => {
                    if (err) console.error(`[API_RESET] Error clearing table ${table}:`, err.message);
                });
            });
        });

        userCache.clear();
        console.log('[API_RESET] Hard reset complete. The application is now in a fresh-install state.');
        res.json({ success: true, message: 'All application data has been cleared.' });

    } catch (error) {
        console.error("[API_RESET] Critical error during hard reset:", error);
        res.status(500).json({ error: "Failed to reset application data." });
    }
});

// Middleware to allow local network access OR authenticated access OR cast token
// This enables Chromecast devices to access streams using temporary tokens
function allowLocalOrAuth(req, res, next) {
    const identity = resolveStreamIdentity(req, { castTokens: activeCastTokens, trustProxy: TRUST_PROXY });
    if (!identity.ok) {
        console.warn(`[STREAM_AUTH] ✗ ${identity.message} from ${req.ip || req.socket.remoteAddress || 'unknown'}.`);
        return res.status(identity.status).send(identity.message);
    }
    // These fields describe this stream only. The real session is never modified.
    req.streamUserId = identity.userId;
    req.streamUsername = identity.username;
    req.localAccess = identity.localAccess;
    console.log(identity.localAccess
        ? `[STREAM_AUTH] ✓ Allowing unauthenticated access from local network: ${req.ip || req.socket.remoteAddress}`
        : `[STREAM_AUTH] ✓ Stream authorized for user ${identity.userId ?? 'cast'}`);
    next();
}

// MODIFIED: Stream endpoint now allows local network access for Chromecast and supports fast input seeking
app.get('/api/stream/tracks', requireAuth, async (req, res) => {
    const { url, userAgentId } = req.query;
    if (!url) return res.status(400).json({ error: 'A stream URL is required.' });
    try {
        await assertSafeMediaUrl(url, ['http:', 'https:']);
        const settings = getSettings();
        const userAgent = (settings.userAgents || []).find(ua => ua.id === userAgentId)?.value
            || (settings.userAgents || []).find(ua => ua.id === settings.activeUserAgentId)?.value
            || '';
        const tracks = await probeStreamTracks(url, userAgent);
        res.json(tracks);
    } catch (error) {
        console.warn('[STREAM_TRACKS] Could not probe tracks:', error.message);
        res.status(502).json({ error: 'Could not read this stream’s tracks.' });
    }
});

app.get('/stream', allowLocalOrAuth, async (req, res) => {
    const { url: streamUrl, profileId, userAgentId, vodName, vodLogo, startTime: seekParam, audioTrack: audioTrackParam } = req.query;
    const audioTrack = Number.parseInt(audioTrackParam, 10);
    const hasAudioTrack = Number.isInteger(audioTrack) && audioTrack >= 0 && audioTrack < 64;
    const userId = req.streamUserId ?? null;
    const username = req.streamUsername || 'Local Network';
    const clientIp = req.clientIp;

    const seekSec = parseFloat(seekParam);
    const isSeek = seekParam !== undefined && !isNaN(seekSec);

    if (!streamUrl) return res.status(400).send('Error: `url` query parameter is required.');
    if (!isAllowedStreamUrl(streamUrl)) {
        console.warn(`[STREAM] Rejected stream URL with unsupported protocol: ${safeUrlForLog(streamUrl)}`);
        return res.status(400).send('Error: unsupported stream URL protocol.');
    }
    try {
        assertSafeStreamUrl(streamUrl);
        await assertSafeMediaStreamUrl(streamUrl);
    } catch (err) {
        console.warn(`[STREAM] Rejected stream URL: ${err.message}`);
        return res.status(400).send('Error: stream URL is not allowed.');
    }

    // Include profileId, audio track and seek offset in the stream key so they don't collide.
    const baseStreamKey = `${userId}::${streamUrlKey(streamUrl)}::${profileId}${hasAudioTrack ? `::a${audioTrack}` : ''}`;
    const streamKey = isSeek ? `${baseStreamKey}::${Math.floor(seekSec)}` : baseStreamKey;

    // If seeking, terminate any existing stream for this user/URL to cleanly switch position
    if (isSeek) {
        for (const [key, info] of activeStreamProcesses.entries()) {
            if (key.startsWith(baseStreamKey) && key !== streamKey) {
                console.log(`[STREAM] User seeking to ${seekSec}s. Terminating previous stream: ${key}`);
                try {
                    info.process.kill('SIGKILL');
                } catch (kErr) {
                    console.error(`[STREAM] Error killing previous stream on seek:`, kErr.message);
                }
                activeStreamProcesses.delete(key);
            }
        }
    }

    const activeStreamInfo = activeStreamProcesses.get(streamKey);

    if (activeStreamInfo) {
        activeStreamInfo.references++;
        activeStreamInfo.lastAccess = Date.now();
        console.log(`[STREAM] Existing stream requested. Key: ${streamKey}. New ref count: ${activeStreamInfo.references}.`);
        activeStreamInfo.process.stdout.pipe(res);

        req.on('close', () => {
            console.log(`[STREAM] Client closed connection for existing stream ${streamKey}. Decrementing ref count.`);
            activeStreamInfo.references--;
            activeStreamInfo.lastAccess = Date.now();
            if (activeStreamInfo.references <= 0) {
                console.log(`[STREAM] Last client disconnected. Ref count is 0. Process for PID: ${activeStreamInfo.process.pid} will be cleaned up by the janitor.`);
            }
        });
        return;
    }

    console.log(`[STREAM] New request: ProfileID=${profileId}, UserAgentID=${userAgentId}`);

    let settings = getSettings();
    // Check both streamProfiles and castProfiles arrays
    let profile = (settings.streamProfiles || []).find(p => p.id === profileId);
    if (!profile) {
        profile = (settings.castProfiles || []).find(p => p.id === profileId);
    }

    if (!profile) {
        console.error(`[STREAM] Stream profile with ID "${profileId}" not found in settings.`);
        return res.status(404).send(`Error: Stream profile with ID "${profileId}" not found.`);
    }

    // NEW: Determine if this is a transcoding or direct stream
    const isTranscoded = profile.command !== 'redirect';

    if (!isTranscoded) {
        console.log(`[STREAM] Redirecting to stream URL: ${safeUrlForLog(streamUrl)}`);
        return res.redirect(302, streamUrl);
    }

    const userAgent = (settings.userAgents || []).find(ua => ua.id === userAgentId);
    if (!userAgent) {
        console.error(`[STREAM] User agent with ID "${userAgentId}" not found in settings.`);
        return res.status(404).send(`Error: User agent with ID "${userAgentId}" not found.`);
    }

    // --- NEW: VOD-aware Activity Logging ---
    let channelName, channelId, channelLogo;
    if (vodName) {
        // It's a VOD stream
        channelName = vodName;
        channelLogo = vodLogo || null;
        channelId = null; // VODs don't have a channel ID in the same way live channels do
        console.log(`[STREAM] VOD stream detected for logging: Name='${channelName}'`);
    } else {
        // It's a live channel stream, use existing M3U parsing logic
        const allChannels = readChannels() || [];
        const channel = allChannels.find(c => c.url === streamUrl);
        channelName = channel ? channel.displayName || channel.name : 'Direct Stream';
        channelId = channel ? channel.id : null;
        channelLogo = channel ? channel.logo : null;
    }
    const streamProfileName = profile ? profile.name : 'Unknown Profile';
    // --- END NEW ---

    console.log(`[STREAM] Using Profile='${profile.name}' (ID=${profile.id}), UserAgent='${userAgent.name}'`);

    // Prefix ffmpeg command with "-v level+{playerLoglevel}" here to control log spamming.
    // Using warning loglevel limits messages to actual warnings and errors.
    // playerLogLevel is configured via settings page pulldown.
    let profileCommand = profile.command;
    if (isSeek && seekSec > 0) {
        // Prepend -ss before input for fast keyframe seeking over HTTP
        const floorSec = Math.floor(seekSec);
        if (profileCommand.includes('-i "{streamUrl}"')) {
            profileCommand = profileCommand.replace('-i "{streamUrl}"', `-ss ${floorSec} -i "{streamUrl}"`);
        } else if (profileCommand.includes('{streamUrl}')) {
            profileCommand = profileCommand.replace('{streamUrl}', `-ss ${floorSec} {streamUrl}`);
        }
    }

    const args = buildFfmpegArgs(profileCommand, {
        streamUrl,
        userAgent: userAgent.value,
        clientUserAgent: userAgent.value
    }, settings.playerLogLevel);
    if (hasAudioTrack) {
        const inputIndex = args.lastIndexOf(streamUrl);
        if (inputIndex !== -1) {
            // Place explicit maps immediately after the input so the chosen audio stream wins.
            args.splice(inputIndex + 1, 0, '-map', '0:v:0?', '-map', `0:a:${audioTrack}`);
            console.log(`[STREAM] Selected audio track ${audioTrack} for ${streamKey}`);
        }
    }

    console.log(`[STREAM] Starting ffmpeg with profile "${profile.name}"`);
    const ffmpeg = spawn('ffmpeg', args);

    //-- ENHANCEMENT: Log richer stream start data to history.
    const startTime = new Date().toISOString();
    const newStreamInfo = {
        process: ffmpeg,
        references: 1,
        lastAccess: Date.now(),
        userId,
        username,
        channelId,
        channelName,
        channelLogo,
        streamProfileName,
        startTime,
        historyId: null,
        clientIp,
        streamKey,
        isTranscoded,
    };
    const trackStream = (historyId) => {
        newStreamInfo.historyId = historyId;
        activeStreamProcesses.set(streamKey, newStreamInfo);
        console.log(`[STREAM] Started FFMPEG process with PID: ${ffmpeg.pid} for user ${userId ?? 'local'} for stream key: ${streamKey}.`);
        broadcastAdminUpdate();
    };
    if (userId === null) {
        // stream_history.user_id is NOT NULL; local playback has no user row.
        trackStream(null);
    } else {
        db.run(
            `INSERT INTO stream_history (user_id, username, channel_id, channel_name, start_time, status, client_ip, channel_logo, stream_profile_name) VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?)`,
            [userId, username, channelId, channelName, startTime, clientIp, channelLogo, streamProfileName],
            function (err) {
                if (err) console.error('[STREAM_HISTORY] Error logging stream start:', err.message);
                trackStream(err ? null : this.lastID);
            }
        );
    }

    // Set appropriate Content-Type based on output format
    if (profile.command.includes('-f mp4')) {
        res.setHeader('Content-Type', 'video/mp4');
        console.log(`[STREAM] Setting Content-Type: video/mp4`);
    } else {
        res.setHeader('Content-Type', 'video/mp2t');
    }
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => console.error(`[FFMPEG_ERROR] Stream: ${streamKey} - ${data.toString().trim()}`));

    const cleanupOnExit = () => {
        const info = activeStreamProcesses.get(streamKey);
        if (info && info.historyId) {
            const endTime = new Date().toISOString();
            const duration = Math.round((new Date(endTime).getTime() - new Date(info.startTime).getTime()) / 1000);
            db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                [endTime, duration, info.historyId]);
        }
        activeStreamProcesses.delete(streamKey);
        //-- ENHANCEMENT: Notify admins that a stream has ended.
        broadcastAdminUpdate();
    };

    ffmpeg.on('close', (code) => {
        console.log(`[STREAM] ffmpeg process for ${streamKey} exited with code ${code}`);
        cleanupOnExit();
        if (!res.headersSent) res.status(500).send('FFmpeg stream ended unexpectedly or failed to start.');
        else res.end();
    });
    ffmpeg.on('error', (err) => {
        console.error(`[STREAM] Failed to start ffmpeg process for ${streamKey}: ${err.message}`);
        cleanupOnExit();
        if (!res.headersSent) res.status(500).send('Failed to start streaming service. Check server logs.');
    });

    req.on('close', () => {
        const info = activeStreamProcesses.get(streamKey);
        if (info) {
            console.log(`[STREAM] Client closed connection for new stream ${streamKey}. Decrementing ref count.`);
            info.references--;
            info.lastAccess = Date.now();
            if (info.references <= 0) {
                console.log(`[STREAM] Last client disconnected. Ref count is 0. Process for PID: ${info.process.pid} will be cleaned up by the janitor.`);
            }
        } else {
            console.log(`[STREAM] Client closed connection for ${streamKey}, but no process was found in the map.`);
        }
    });
});

// HEAD request handler for Shaka Player compatibility
// Shaka Player sends HEAD requests to probe streams before loading
app.head('/stream', allowLocalOrAuth, async (req, res) => {
    const { profileId } = req.query;

    // Determine content type based on profile
    let settings = getSettings();
    let profile = (settings.streamProfiles || []).find(p => p.id === profileId);
    if (!profile) {
        profile = (settings.castProfiles || []).find(p => p.id === profileId);
    }

    if (!profile) {
        return res.status(404).end();
    }

    // Set appropriate Content-Type header for HEAD request
    if (profile.command.includes('-f mp4')) {
        res.setHeader('Content-Type', 'video/mp4');
    } else {
        res.setHeader('Content-Type', 'video/mp2t');
    }

    // Set CORS headers for Shaka Player
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');

    res.status(200).end();
});

// ============================================================
// CAST: Generate authentication token for Chromecast
// ============================================================
app.post('/api/cast/generate-token', requireAuth, (req, res) => {
    try {
        const { streamUrl } = req.body;
        const userId = req.session.userId;

        if (!streamUrl) {
            return res.status(400).json({ error: 'streamUrl is required' });
        }

        // Generate secure random token
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes

        // Store token
        activeCastTokens.set(token, {
            userId,
            streamUrl,
            expiresAt,
            createdAt: Date.now()
        });

        // Auto-cleanup after expiry
        setTimeout(() => {
            activeCastTokens.delete(token);
            console.log('[CAST_TOKEN] Token expired and removed.');
        }, 5 * 60 * 1000);

        console.log(`[CAST_TOKEN] Generated token for user ${userId}, expires in 5 minutes`);

        res.json({ token });
    } catch (error) {
        console.error('[CAST_TOKEN] Error generating token:', error);
        res.status(500).json({ error: 'Failed to generate cast token' });
    }
});

// ============================================================
// STREAM STOP: Manually stop a stream
// ============================================================
app.post('/api/stream/stop', requireAuth, (req, res) => {
    const { url: streamUrl, profileId } = req.body;
    if (!streamUrl) {
        return res.status(400).json({ error: "Stream URL is required to stop the stream." });
    }

    // Match every variant for this user/profile: seek suffix, audio track, and old key formats.
    const prefix = profileId
        ? `${req.session.userId}::${streamUrlKey(streamUrl)}::${profileId}`
        : `${req.session.userId}::${streamUrlKey(streamUrl)}`;
    const matchingKeys = [...activeStreamProcesses.keys()].filter(key =>
        key === prefix || key.startsWith(prefix + '::')
    );

    let terminated = 0;
    for (const streamKey of matchingKeys) {
        const activeStreamInfo = activeStreamProcesses.get(streamKey);
        if (!activeStreamInfo) continue;
        if (activeStreamInfo.references > 1) {
            console.log(`[STREAM_STOP_API] Stream ${streamKey} has ${activeStreamInfo.references} active references. NOT terminating.`);
            continue;
        }
        try {
            if (activeStreamInfo.historyId) {
                const endTime = new Date().toISOString();
                const duration = Math.round((new Date(endTime).getTime() - new Date(activeStreamInfo.startTime).getTime()) / 1000);
                db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                    [endTime, duration, activeStreamInfo.historyId]);
            }
            activeStreamInfo.process.kill('SIGKILL');
            activeStreamProcesses.delete(streamKey);
            terminated++;
            console.log(`[STREAM_STOP_API] Terminated process for key: ${streamKey}`);
        } catch (e) {
            console.warn(`[STREAM_STOP_API] Could not kill process for key: ${streamKey}. Error: ${e.message}`);
        }
    }
    if (terminated) broadcastAdminUpdate();
    res.json({
        success: true,
        message: terminated ? `Terminated ${terminated} stream process(es).` : 'No active stream to stop.',
    });
});

app.post('/api/activity/start-redirect', requireAuth, (req, res) => {
    const { streamUrl, channelId, channelName, channelLogo } = req.body;
    const userId = req.session.userId;
    const username = req.session.username;
    const clientIp = req.clientIp;
    const startTime = new Date().toISOString();

    db.run(
        `INSERT INTO stream_history (user_id, username, channel_id, channel_name, start_time, status, client_ip, channel_logo, stream_profile_name) VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?)`,
        [userId, username, channelId, channelName, startTime, clientIp, channelLogo, 'Redirect'],
        function (err) {
            if (err) {
                console.error('[REDIRECT_LOG] Error logging redirect stream start:', err.message);
                return res.status(500).json({ error: 'Could not log stream start.' });
            }
            const historyId = this.lastID;
            console.log(`[REDIRECT_LOG] Logged redirect stream start for user ${username} with history ID: ${historyId}`);

            // --- NEW: Add to live tracking ---
            const streamKey = `${userId}::${historyId}`;
            activeRedirectStreams.set(streamKey, {
                streamKey,
                userId,
                username,
                channelId,
                channelName,
                channelLogo,
                streamProfileName: 'Redirect',
                startTime,
                lastHeartbeat: Date.now(),
                clientIp,
                isTranscoded: false,
                historyId,
            });
            broadcastAdminUpdate(); // Notify admins
            // --- END NEW ---

            res.status(201).json({ success: true, historyId });
        }
    );
});

// NEW: Heartbeat endpoint for active redirect streams
app.post('/api/activity/heartbeat', requireAuth, (req, res) => {
    const { historyId } = req.body;
    if (!historyId) {
        return res.status(400).json({ error: 'History ID is required for heartbeat.' });
    }

    const streamKey = `${req.session.userId}::${historyId}`;
    const streamInfo = activeRedirectStreams.get(streamKey);
    if (streamInfo) {
        streamInfo.lastHeartbeat = Date.now();
        return res.json({ success: true, active: true });
    } else {
        return res.json({ success: true, active: false });
    }
});

app.post('/api/activity/stop-redirect', requireAuth, (req, res) => {
    const { historyId } = req.body;
    if (!historyId) {
        return res.status(400).json({ error: 'History ID is required.' });
    }

    // --- NEW: Remove from live tracking ---
    const streamKey = `${req.session.userId}::${historyId}`;
    if (activeRedirectStreams.has(streamKey)) {
        activeRedirectStreams.delete(streamKey);
        broadcastAdminUpdate(); // Notify admins
    }
    // --- END NEW ---

    const endTime = new Date().toISOString();
    db.get("SELECT start_time FROM stream_history WHERE id = ? AND user_id = ?", [historyId, req.session.userId], (err, row) => {
        if (err || !row) {
            // Even if history isn't found, we should respond successfully as the client's goal is to stop.
            return res.status(200).json({ success: true, message: 'Stream stopped, history record not found.' });
        }
        const duration = Math.round((new Date(endTime).getTime() - new Date(row.start_time).getTime()) / 1000);
        db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND end_time IS NULL",
            [endTime, duration, historyId],
            (updateErr) => {
                if (updateErr) {
                    console.error(`[REDIRECT_LOG] Error updating redirect stream end for history ID ${historyId}:`, updateErr.message);
                    return res.status(500).json({ error: 'Could not log stream end.' });
                }
                console.log(`[REDIRECT_LOG] Logged redirect stream end for history ID: ${historyId}`);
                res.json({ success: true });
            }
        );
    });
});

// --- NEW: App Version Endpoint ---
app.get('/api/version', requireAuth, (req, res) => {
    try {
        const packageJsonPath = path.join(__dirname, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            res.json({ version: packageJson.version || 'Unknown' });
        } else {
            res.json({ version: 'Unknown' });
        }
    } catch (error) {
        console.error('[API] Error reading package.json:', error);
        res.status(500).json({ error: 'Could not determine app version.' });
    }
});

// --- NEW/MODIFIED: Admin Monitoring Endpoints ---
app.get('/api/admin/activity', requireAuth, requireAdmin, async (req, res) => {
    // 1. Get Live Activity (already up-to-date in memory)
    const transcodedLive = Array.from(activeStreamProcesses.values()).map(info => ({
        streamKey: info.streamKey,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: true,
    }));

    const redirectLive = Array.from(activeRedirectStreams.values()).map(info => ({
        streamKey: `${info.userId}::${info.historyId}`,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: false,
    }));

    const liveActivity = [...transcodedLive, ...redirectLive];

    // 2. Get Paginated and Filtered History
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const pageSize = parseInt(req.query.pageSize, 10) || 25;
        const search = req.query.search || '';
        const dateFilter = req.query.dateFilter || 'all';
        const customStart = req.query.startDate;
        const customEnd = req.query.endDate;

        const offset = (page - 1) * pageSize;

        let whereClauses = [];
        let queryParams = [];

        if (search) {
            whereClauses.push(`(username LIKE ? OR channel_name LIKE ? OR client_ip LIKE ? OR stream_profile_name LIKE ?)`);
            const searchTerm = `%${search}%`;
            queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        const now = new Date();
        if (dateFilter === '24h') {
            whereClauses.push(`start_time >= ?`);
            queryParams.push(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
        } else if (dateFilter === '7d') {
            whereClauses.push(`start_time >= ?`);
            queryParams.push(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
        } else if (dateFilter === 'custom' && customStart && customEnd) {
            whereClauses.push(`start_time BETWEEN ? AND ?`);
            queryParams.push(new Date(customStart).toISOString(), new Date(customEnd).toISOString());
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Count total items with filters
        const countResult = await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as total FROM stream_history ${whereString}`, queryParams, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        const totalItems = countResult.total;

        // Get paginated items with filters
        const historyItems = await new Promise((resolve, reject) => {
            const query = `SELECT * FROM stream_history ${whereString} ORDER BY start_time DESC LIMIT ? OFFSET ?`;
            db.all(query, [...queryParams, pageSize, offset], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        const history = {
            items: historyItems,
            totalItems: totalItems,
            totalPages: Math.ceil(totalItems / pageSize),
            currentPage: page,
            pageSize: pageSize,
        };

        res.json({ live: liveActivity, history });

    } catch (err) {
        console.error('[ADMIN_API] Error fetching paginated stream history:', err.message);
        return res.status(500).json({ error: "Could not retrieve stream history." });
    }
});


app.post('/api/admin/stop-stream', requireAuth, requireAdmin, (req, res) => {
    const { streamKey } = req.body;
    if (!streamKey) {
        return res.status(400).json({ error: "A streamKey is required to stop the stream." });
    }

    const streamInfo = activeStreamProcesses.get(streamKey);
    if (streamInfo) {
        console.log(`[ADMIN_API] Admin ${req.session.username} is terminating transcoded stream ${streamKey} for user ${streamInfo.username}.`);
        try {
            if (streamInfo.historyId) {
                const endTime = new Date().toISOString();
                const duration = Math.round((new Date(endTime).getTime() - new Date(streamInfo.startTime).getTime()) / 1000);
                db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                    [endTime, duration, streamInfo.historyId]);
            }
            streamInfo.process.kill('SIGKILL');
            activeStreamProcesses.delete(streamKey);
            sendSseEvent(streamInfo.userId, 'stop-stream', { streamKey, message: 'An administrator has stopped your stream.' });
            broadcastAdminUpdate();
            return res.json({ success: true, message: `Stream terminated for user ${streamInfo.username}.` });
        } catch (e) {
            console.error(`[ADMIN_API] Error terminating stream ${streamKey}: ${e.message}`);
            return res.status(500).json({ error: "Failed to terminate stream process." });
        }
    }

    // NEW: Support terminating redirect streams
    const redirectInfo = activeRedirectStreams.get(streamKey);
    if (redirectInfo) {
        console.log(`[ADMIN_API] Admin ${req.session.username} is terminating redirect stream ${streamKey} for user ${redirectInfo.username}.`);
        try {
            if (redirectInfo.historyId) {
                const endTime = new Date().toISOString();
                const duration = Math.round((new Date(endTime).getTime() - new Date(redirectInfo.startTime).getTime()) / 1000);
                db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                    [endTime, duration, redirectInfo.historyId]);
            }
            activeRedirectStreams.delete(streamKey);
            sendSseEvent(redirectInfo.userId, 'stop-stream', { streamKey, historyId: redirectInfo.historyId, message: 'An administrator has stopped your stream.' });
            broadcastAdminUpdate();
            return res.json({ success: true, message: `Redirect stream terminated for user ${redirectInfo.username}.` });
        } catch (e) {
            console.error(`[ADMIN_API] Error terminating redirect stream ${streamKey}: ${e.message}`);
            return res.status(500).json({ error: "Failed to terminate redirect stream." });
        }
    }

    res.status(404).json({ error: "Active stream not found." });
});

//-- ENHANCEMENT: New endpoint for admins to change a user's live stream.
app.post('/api/admin/change-stream', requireAuth, requireAdmin, (req, res) => {
    // FIX: Parse userId from the request body as an integer to prevent type mismatch.
    const { userId: userIdString, streamKey, channel } = req.body;
    const userId = parseInt(userIdString, 10);

    if (!userId || !streamKey || !channel) {
        return res.status(400).json({ error: "User ID, stream key, and channel data are required." });
    }

    const streamInfo = activeStreamProcesses.get(streamKey) || activeRedirectStreams.get(streamKey);
    // The comparison below will now work correctly because userId is a number.
    if (!streamInfo || streamInfo.userId !== userId) {
        return res.status(404).json({ error: "The specified stream is not active for this user." });
    }

    console.log(`[ADMIN_API] Admin ${req.session.username} is changing channel for user ${streamInfo.username} to "${channel.name}".`);

    // Send the change-channel event to the target user's client(s)
    // Use the parsed numeric userId to find the correct SSE client
    sendSseEvent(userId, 'change-channel', { channel });

    res.json({ success: true, message: `Change channel command sent to user ${streamInfo.username}.` });
});

// NEW: Endpoint for system health metrics
app.get('/api/admin/system-health', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [cpu, mem, fs] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize()
        ]);

        const dataDisk = fs.find(d => d.mount === DATA_DIR) || {};
        const dvrDisk = fs.find(d => d.mount === DVR_DIR) || {};

        res.json({
            cpu: {
                load: cpu.currentLoad.toFixed(2)
            },
            memory: {
                total: mem.total,
                used: mem.active,
                percent: ((mem.active / mem.total) * 100).toFixed(2)
            },
            disks: {
                data: {
                    total: dataDisk.size || 0,
                    used: dataDisk.used || 0,
                    percent: dataDisk.use || 0
                },
                dvr: {
                    total: dvrDisk.size || 0,
                    used: dvrDisk.used || 0,
                    percent: dvrDisk.use || 0
                }
            }
        });
    } catch (e) {
        console.error('[ADMIN_API] Error fetching system health:', e);
        res.status(500).json({ error: 'Could not retrieve system health information.' });
    }
});

// NEW: Endpoint for analytics widgets
app.get('/api/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
    try {
        const topChannelsQuery = `
            SELECT channel_name, SUM(duration_seconds) as total_duration
            FROM stream_history
            WHERE channel_name IS NOT NULL AND duration_seconds IS NOT NULL
            GROUP BY channel_name
            ORDER BY total_duration DESC
            LIMIT 5`;

        const topUsersQuery = `
            SELECT username, SUM(duration_seconds) as total_duration
            FROM stream_history
            WHERE duration_seconds IS NOT NULL
            GROUP BY username
            ORDER BY total_duration DESC
            LIMIT 5`;

        const topChannels = await new Promise((resolve, reject) => {
            db.all(topChannelsQuery, [], (err, rows) => err ? reject(err) : resolve(rows));
        });

        const topUsers = await new Promise((resolve, reject) => {
            db.all(topUsersQuery, [], (err, rows) => err ? reject(err) : resolve(rows));
        });

        res.json({ topChannels, topUsers });

    } catch (e) {
        console.error('[ADMIN_API] Error fetching analytics data:', e);
        res.status(500).json({ error: 'Could not retrieve analytics data.' });
    }
});

// NEW: Endpoint for broadcasting messages
app.post('/api/admin/broadcast', requireAuth, requireAdmin, (req, res) => {
    const { message } = req.body;
    if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    broadcastSseToAll('broadcast-message', {
        message: message.trim(),
        sender: req.session.username,
    });

    res.json({ success: true, message: 'Broadcast sent successfully.' });
});

// ... existing Multi-View Layout API Endpoints ...
app.get('/api/multiview/layouts', requireAuth, (req, res) => {
    console.log(`[LAYOUT_API] Fetching layouts for user ${req.session.userId}.`);
    db.all("SELECT id, name, layout_data FROM multiview_layouts WHERE user_id = ?", [req.session.userId], (err, rows) => {
        if (err) {
            console.error('[LAYOUT_API] Error fetching layouts:', err.message);
            return res.status(500).json({ error: 'Could not retrieve layouts.' });
        }
        const layouts = rows.map(row => ({
            ...row,
            layout_data: JSON.parse(row.layout_data)
        }));
        console.log(`[LAYOUT_API] Found ${layouts.length} layouts for user ${req.session.userId}.`);
        res.json(layouts);
    });
});

app.post('/api/multiview/layouts', requireAuth, (req, res) => {
    const { name, layout_data } = req.body;
    console.log(`[LAYOUT_API] Saving layout "${name}" for user ${req.session.userId}.`);
    if (!name || !layout_data) {
        console.warn('[LAYOUT_API] Save failed: Name or layout_data is missing.');
        return res.status(400).json({ error: 'Layout name and data are required.' });
    }

    const layoutJson = JSON.stringify(layout_data);

    db.run("INSERT INTO multiview_layouts (user_id, name, layout_data) VALUES (?, ?, ?)",
        [req.session.userId, name, layoutJson],
        function (err) {
            if (err) {
                console.error('[LAYOUT_API] Error saving layout:', err.message);
                return res.status(500).json({ error: 'Could not save layout.' });
            }
            console.log(`[LAYOUT_API] Layout "${name}" saved with ID ${this.lastID} for user ${req.session.userId}.`);
            res.status(201).json({ success: true, id: this.lastID, name, layout_data });
        }
    );
});

app.delete('/api/multiview/layouts/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    console.log(`[LAYOUT_API] Deleting layout ID: ${id} for user ${req.session.userId}.`);
    db.run("DELETE FROM multiview_layouts WHERE id = ? AND user_id = ?", [id, req.session.userId], function (err) {
        if (err) {
            console.error(`[LAYOUT_API] Error deleting layout ${id}:`, err.message);
            return res.status(500).json({ error: 'Could not delete layout.' });
        }
        if (this.changes === 0) {
            console.warn(`[LAYOUT_API] Layout ${id} not found or user ${req.session.userId} not authorized.`);
            return res.status(404).json({ error: 'Layout not found or you do not have permission to delete it.' });
        }
        console.log(`[LAYOUT_API] Layout ${id} deleted successfully.`);
        res.json({ success: true });
    });
});
// --- Notification Scheduler ---
// ... existing checkAndSendNotifications ...
async function checkAndSendNotifications() {
    console.log('[PUSH_CHECKER] Running scheduled notification check for all devices.');
    const now = new Date();
    const nowIso = now.toISOString();

    const timeoutCutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();

    try {
        db.run(`
            UPDATE notification_deliveries
            SET status = 'expired', updatedAt = ?
            WHERE status = 'pending' AND notification_id IN (
                SELECT id FROM notifications WHERE notificationTime < ?
            )
        `, [nowIso, timeoutCutoff], function (err) {
            if (err) {
                console.error('[PUSH_CHECKER_CLEANUP] Error expiring old notifications:', err.message);
            } else if (this.changes > 0) {
                console.log(`[PUSH_CHECKER_CLEANUP] Expired ${this.changes} old notification deliveries.`);
            }
        });

        const dueDeliveries = await new Promise((resolve, reject) => {
            const query = `
                SELECT
                    d.id as delivery_id,
                    d.status,
                    n.*,
                    s.id as subscription_id,
                    s.endpoint,
                    s.p256dh,
                    s.auth
                FROM notification_deliveries d
                JOIN notifications n ON d.notification_id = n.id
                JOIN push_subscriptions s ON d.subscription_id = s.id
                WHERE d.status = 'pending' AND n.notificationTime <= ?
            `;
            db.all(query, [nowIso], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (dueDeliveries.length > 0) {
            console.log(`[PUSH_CHECKER] Found ${dueDeliveries.length} due notification deliveries to process.`);
        } else {
            return;
        }

        for (const delivery of dueDeliveries) {
            console.log(`[PUSH_CHECKER] Processing delivery ID ${delivery.delivery_id} for program "${delivery.programTitle}" to subscription ${delivery.subscription_id}.`);

            const payload = JSON.stringify({
                type: 'program_reminder',
                data: {
                    programTitle: delivery.programTitle,
                    programStart: delivery.programStart,
                    channelName: delivery.channelName,
                    channelLogo: delivery.channelLogo || 'https://i.imgur.com/rwa8SjI.png',
                    url: `/tvguide?channelId=${delivery.channelId}&programId=${delivery.programId}&programStart=${delivery.programStart}`
                }
            });

            const pushSubscription = {
                endpoint: delivery.endpoint,
                keys: { p256dh: delivery.p256dh, auth: delivery.auth }
            };

            const pushOptions = {
                TTL: 86400 // 24 hours in seconds
            };

            webpush.sendNotification(pushSubscription, payload, pushOptions)
                .then(() => {
                    console.log(`[PUSH_CHECKER] Successfully sent notification for delivery ID ${delivery.delivery_id}.`);
                    db.run("UPDATE notification_deliveries SET status = 'sent', updatedAt = ? WHERE id = ?", [nowIso, delivery.delivery_id]);
                })
                .catch(error => {
                    console.error(`[PUSH_CHECKER] Error sending notification for delivery ID ${delivery.delivery_id}:`, error.statusCode, error.body || error.message);

                    if (error.statusCode === 410 || error.statusCode === 404) {
                        console.log(`[PUSH_CHECKER] Subscription ${delivery.subscription_id} is invalid (410/404). Deleting subscription and failing deliveries.`);

                        sendSseEvent(delivery.user_id, 'subscription-invalidated', {
                            endpoint: delivery.endpoint,
                            reason: `Push service returned status ${error.statusCode}.`
                        });

                        db.run("DELETE FROM push_subscriptions WHERE id = ?", [delivery.subscription_id]);
                        db.run("UPDATE notification_deliveries SET status = 'failed', updatedAt = ? WHERE subscription_id = ? AND status = 'pending'", [nowIso, delivery.subscription_id]);
                    } else {
                        db.run("UPDATE notification_deliveries SET status = 'failed', updatedAt = ? WHERE id = ?", [nowIso, delivery.delivery_id]);
                    }
                });
        }
    } catch (error) {
        console.error('[PUSH_CHECKER] Unhandled error in checkAndSendNotifications:', error);
    }
}
// --- DVR Engine & Resilient Supervisor ---

async function getMediaDurationSeconds(filePath) {
    return new Promise((resolve) => {
        if (!filePath || !fs.existsSync(filePath)) return resolve(null);
        execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { timeout: 10000 }, (error, stdout) => {
            if (error || !stdout) {
                return resolve(null);
            }
            const duration = parseFloat(stdout.trim());
            if (!isNaN(duration) && duration > 0) {
                resolve(Math.round(duration));
            } else {
                resolve(null);
            }
        });
    });
}

async function remuxTsToMp4(tsFilePath) {
    return new Promise((resolve) => {
        if (!tsFilePath || !fs.existsSync(tsFilePath)) {
            return resolve({ success: false, error: 'File does not exist' });
        }
        if (!tsFilePath.endsWith('.ts')) {
            return resolve({ success: false, error: 'File is not a TS file' });
        }

        const mp4Path = tsFilePath.replace(/\.ts$/i, '.mp4');
        console.log(`[DVR_REMUX] Starting fast remux: ${tsFilePath} -> ${mp4Path}`);
        const startTime = Date.now();

        // -c:v copy (zero video transcoding, 100% speed, 0% CPU)
        // -c:a aac (universal browser audio playback compatibility for MP2/AC3 audio)
        // -movflags +faststart (places moov index at start for instant HTTP Range scrubbing)
        const args = [
            '-y',
            '-i', tsFilePath,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            mp4Path
        ];

        const ffmpegProcess = spawn('ffmpeg', args);
        let stderrOutput = '';

        ffmpegProcess.stderr.on('data', (data) => {
            stderrOutput += data.toString();
        });

        ffmpegProcess.on('error', (err) => {
            console.error(`[DVR_REMUX] FFmpeg process error:`, err.message);
            resolve({ success: false, error: err.message });
        });

        ffmpegProcess.on('close', async (code) => {
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
            if (code === 0 && fs.existsSync(mp4Path)) {
                try {
                    const stats = fs.statSync(mp4Path);
                    if (stats.size > 1024 * 1024) { // > 1MB
                        fs.chmodSync(mp4Path, 0o666);
                        // Delete the original TS file to guarantee zero duplicate storage
                        try {
                            fs.unlinkSync(tsFilePath);
                            console.log(`[DVR_REMUX] Successfully remuxed in ${elapsedSec}s and unlinked original TS file: ${tsFilePath}`);
                        } catch (unlinkErr) {
                            console.warn(`[DVR_REMUX] Failed to delete original TS file:`, unlinkErr.message);
                        }
                        const probedDuration = await getMediaDurationSeconds(mp4Path);
                        return resolve({
                            success: true,
                            mp4Path,
                            fileSizeBytes: stats.size,
                            durationSeconds: probedDuration
                        });
                    }
                } catch (statErr) {
                    console.error(`[DVR_REMUX] Stat error on remuxed MP4:`, statErr.message);
                }
            }

            console.error(`[DVR_REMUX] Remux failed with code ${code}. Stderr: ${stderrOutput.slice(-300)}`);
            // Cleanup partial mp4 if it exists
            if (fs.existsSync(mp4Path)) {
                try { fs.unlinkSync(mp4Path); } catch (e) { }
            }
            resolve({ success: false, error: `FFmpeg exited with code ${code}` });
        });
    });
}

function broadcastDvrUpdate(userId, data) {
    try {
        if (userId) {
            sendSseEvent(userId, 'dvr-update', data);
        }
        for (const clientUserId of sseClients.keys()) {
            if (clientUserId !== userId) {
                sendSseEvent(clientUserId, 'dvr-update', data);
            }
        }
    } catch (e) {
        console.warn('[DVR] Error broadcasting dvr-update:', e.message);
    }
}

class DvrSupervisor {
    constructor(job, channel, recProfile, userAgent, fullFilePath, settings) {
        this.job = job;
        this.channel = channel;
        this.recProfile = recProfile;
        this.userAgent = userAgent;
        this.fullFilePath = fullFilePath;
        this.settings = settings;
        this.isTs = !recProfile.command.includes('-f mp4');

        this.ffmpegProcess = null;
        this.fileWriteStream = null;
        this.isStoppedIntentionally = false;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.retryTimer = null;
        this.watchdogInterval = null;
        this.lastDataReceivedAt = Date.now();
        this.totalBytesWritten = 0;
        this.actualStartTime = new Date();
        this.lastErrorOutput = '';
        this.isReconnecting = false;
    }

    async start() {
        if (!fs.existsSync(DVR_DIR)) {
            fs.mkdirSync(DVR_DIR, { recursive: true });
        }

        // Clean up any stale timeshift directory for this job ID so no old segments persist
        const staleTimeshiftDir = path.join(DVR_DIR, '.timeshift', String(this.job.id));
        try {
            if (fs.existsSync(staleTimeshiftDir)) {
                fs.rmSync(staleTimeshiftDir, { recursive: true, force: true });
                console.log(`[DVR_SUPERVISOR][${this.job.id}] Purged stale timeshift directory: ${staleTimeshiftDir}`);
            }
        } catch (e) { }

        // If this is a fresh start (not a smart restart recovery on server reboot), ensure the target file is clean
        const isRestartRecovery = this.job.status === 'recording' || this.job.status === 'reconnecting';
        if (!isRestartRecovery && fs.existsSync(this.fullFilePath)) {
            try {
                fs.unlinkSync(this.fullFilePath);
                console.log(`[DVR_SUPERVISOR][${this.job.id}] Removed stale target file prior to fresh start: ${this.fullFilePath}`);
            } catch (e) { }
        }

        if (this.isTs) {
            try {
                this.fileWriteStream = fs.createWriteStream(this.fullFilePath, { flags: 'a', mode: 0o666 });
                this.fileWriteStream.on('error', (err) => {
                    console.error(`[DVR_SUPERVISOR][${this.job.id}] WriteStream error:`, err.message);
                });
            } catch (err) {
                console.error(`[DVR_SUPERVISOR][${this.job.id}] Could not create write stream:`, err.message);
            }
        }

        this.startWatchdog();
        await this.spawnProcess();
    }

    resolveStreamUrl() {
        try {
            const channels = readChannels();
            if (channels) {
                const freshChannel = channels.find(c => c.id === this.job.channelId);
                if (freshChannel && freshChannel.url) {
                    return freshChannel.url;
                }
            }
        } catch (e) {
            console.warn(`[DVR_SUPERVISOR][${this.job.id}] Could not re-read channels M3U:`, e.message);
        }
        return this.channel.url;
    }

    async spawnProcess() {
        if (this.isStoppedIntentionally) return;

        const currentUrl = this.resolveStreamUrl();

        // Check if there are any active stream processes or redirect sessions for this streamUrl
        // that could cause tuner contention / cross-talk with IPTV proxies like Dispatcharr
        let hadConflictingStream = false;
        for (const [streamKey, streamInfo] of activeStreamProcesses.entries()) {
            if (streamKey.includes(streamUrlKey(currentUrl))) {
                console.log(`[DVR_SUPERVISOR][${this.job.id}] Found active conflicting stream for ${safeUrlForLog(currentUrl)}. Terminating to free upstream tuner.`);
                try {
                    streamInfo.process.kill('SIGKILL');
                    activeStreamProcesses.delete(streamKey);
                    hadConflictingStream = true;
                } catch (e) { }
            }
        }
        for (const [streamKey, redirectInfo] of activeRedirectStreams.entries()) {
            if (streamKey.includes(currentUrl)) {
                console.log(`[DVR_SUPERVISOR][${this.job.id}] Found active conflicting redirect stream for ${safeUrlForLog(currentUrl)}. Closing.`);
                activeRedirectStreams.delete(streamKey);
                hadConflictingStream = true;
            }
        }
        for (const [channelId, buffer] of activeLiveBuffers.entries()) {
            if (buffer.sourceUrl === currentUrl) {
                console.log(`[DVR_SUPERVISOR][${this.job.id}] Stopping conflicting live rewind buffer for channel ${channelId}.`);
                stopLiveBuffer(channelId);
                hadConflictingStream = true;
            }
        }

        if (hadConflictingStream) {
            // Brief yield to allow upstream IPTV proxy / socket to close cleanly
            await new Promise(r => setTimeout(r, 400));
        }

        const args = buildFfmpegArgs(this.recProfile.command, {
            streamUrl: currentUrl,
            userAgent: this.userAgent.value,
            filePath: this.isTs ? 'pipe:1' : this.fullFilePath
        }, this.settings.dvrLogLevel);

        console.log(`[DVR_SUPERVISOR][${this.job.id}] Spawning FFmpeg (attempt ${this.retryCount + 1}/${this.maxRetries + 1}) with profile "${this.recProfile.name}".`);

        try {
            this.ffmpegProcess = spawn('ffmpeg', args);
        } catch (err) {
            console.error(`[DVR_SUPERVISOR][${this.job.id}] Failed to spawn FFmpeg:`, err.message);
            this.handleProcessExit(1);
            return;
        }

        runningFFmpegProcesses.set(this.job.id, this.ffmpegProcess.pid);
        this.lastDataReceivedAt = Date.now();

        if (!this.actualStartTime) {
            this.actualStartTime = new Date();
        }
        const actualStartIso = this.actualStartTime.toISOString();
        db.run("UPDATE dvr_jobs SET status = 'recording', startTime = ?, actualStartTime = ?, ffmpeg_pid = ?, filePath = ? WHERE id = ?",
            [actualStartIso, actualStartIso, this.ffmpegProcess.pid, this.fullFilePath, this.job.id]);
        broadcastDvrUpdate(this.job.user_id, { jobId: this.job.id, status: 'recording', startTime: actualStartIso, actualStartTime: actualStartIso });

        if (this.isTs && this.ffmpegProcess.stdout && this.fileWriteStream) {
            this.ffmpegProcess.stdout.on('data', (chunk) => {
                this.lastDataReceivedAt = Date.now();
                this.totalBytesWritten += chunk.length;
                if (this.isReconnecting) {
                    this.isReconnecting = false;
                    db.run("UPDATE dvr_jobs SET status = 'recording' WHERE id = ?", [this.job.id]);
                    broadcastDvrUpdate(this.job.user_id, { jobId: this.job.id, status: 'recording' });
                }
            });
            this.ffmpegProcess.stdout.pipe(this.fileWriteStream, { end: false });
        }

        this.lastErrorOutput = '';
        this.ffmpegProcess.stderr.on('data', (data) => {
            const line = data.toString().trim();
            if (this.settings.dvrLogLevel === 'debug' || line.includes('Error') || line.includes('failed')) {
                console.log(`[FFMPEG_DVR][${this.job.id}] ${line}`);
            }
            this.lastErrorOutput += line + '\n';
        });

        this.ffmpegProcess.on('error', (err) => {
            console.error(`[DVR_SUPERVISOR][${this.job.id}] Process error:`, err.message);
            this.lastErrorOutput += `Process error: ${err.message}\n`;
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[DVR_SUPERVISOR][${this.job.id}] FFmpeg exited with code ${code}.`);
            runningFFmpegProcesses.delete(this.job.id);
            this.ffmpegProcess = null;
            this.handleProcessExit(code);
        });
    }

    startWatchdog() {
        this.stopWatchdog();
        this.watchdogInterval = setInterval(() => {
            if (this.isStoppedIntentionally || !this.ffmpegProcess) return;

            if (!this.isTs) {
                try {
                    if (fs.existsSync(this.fullFilePath)) {
                        const currentSize = fs.statSync(this.fullFilePath).size;
                        if (currentSize > this.totalBytesWritten) {
                            this.totalBytesWritten = currentSize;
                            this.lastDataReceivedAt = Date.now();
                        }
                    }
                } catch (e) { }
            }

            const timeSinceLastData = Date.now() - this.lastDataReceivedAt;
            if (timeSinceLastData > 25000) {
                console.warn(`[DVR_WATCHDOG][${this.job.id}] Silent stream stall detected! No data received for ${Math.round(timeSinceLastData / 1000)}s. Terminating stalled process to trigger reconnect...`);
                try {
                    this.ffmpegProcess.kill('SIGKILL');
                } catch (e) {
                    console.error(`[DVR_WATCHDOG][${this.job.id}] Error killing stalled process:`, e.message);
                }
            }
        }, 10000);
    }

    stopWatchdog() {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
    }

    handleProcessExit(code) {
        if (this.isStoppedIntentionally) {
            this.finalizeRecording('completed');
            return;
        }

        const now = Date.now();
        const endTimeMs = new Date(this.job.endTime).getTime();

        if (now >= endTimeMs) {
            console.log(`[DVR_SUPERVISOR][${this.job.id}] Scheduled end time reached.`);
            this.finalizeRecording('completed');
            return;
        }

        const wasNormalExit = code === 0 || code === 255 || this.lastErrorOutput.includes('Exiting normally');
        if (wasNormalExit && now >= endTimeMs - 15000) {
            this.finalizeRecording('completed');
            return;
        }

        if (this.isTs && this.retryCount < this.maxRetries) {
            this.retryCount++;
            this.isReconnecting = true;
            const delayMs = Math.min(3000 * Math.pow(1.5, this.retryCount - 1), 15000);

            console.log(`[DVR_SUPERVISOR][${this.job.id}] Stream dropped unexpectedly. Reconnect attempt ${this.retryCount}/${this.maxRetries} in ${Math.round(delayMs / 1000)}s...`);

            db.run("UPDATE dvr_jobs SET status = 'reconnecting', ffmpeg_pid = NULL WHERE id = ?", [this.job.id]);
            broadcastDvrUpdate(this.job.user_id, { jobId: this.job.id, status: 'reconnecting' });

            this.retryTimer = setTimeout(() => {
                if (!this.isStoppedIntentionally) {
                    this.spawnProcess();
                }
            }, delayMs);
            return;
        }

        console.warn(`[DVR_SUPERVISOR][${this.job.id}] Stream dropped and maximum reconnect attempts (${this.maxRetries}) reached.`);
        this.finalizeRecording('interrupted');
    }

    async finalizeRecording(reason) {
        this.stopWatchdog();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        activeDvrSupervisors.delete(this.job.id);
        cleanupTimeshiftSession(this.job.id, true);

        if (this.fileWriteStream) {
            try {
                this.fileWriteStream.end();
            } catch (e) { }
            this.fileWriteStream = null;
        }

        try {
            if (fs.existsSync(this.fullFilePath)) {
                fs.chmodSync(this.fullFilePath, 0o666);
            }
        } catch (e) {
            console.error(`[DVR_SUPERVISOR][${this.job.id}] Failed to set permissions:`, e.message);
        }

        let stats = null;
        try {
            if (fs.existsSync(this.fullFilePath)) {
                stats = fs.statSync(this.fullFilePath);
            }
        } catch (e) {
            console.error(`[DVR_SUPERVISOR][${this.job.id}] File stat failed:`, e.message);
        }

        let durationSeconds = stats ? await getMediaDurationSeconds(this.fullFilePath) : null;
        if (isRecordingFileUsable(stats?.size, durationSeconds)) {
            let finalFilePath = this.fullFilePath;
            let finalSizeBytes = stats.size;
            const wallClockDuration = Math.max(1, Math.round((Date.now() - new Date(this.job.startTime).getTime()) / 1000));

            // If recorded in TS format, fast-remux to MP4 for native browser seeking & zero duplicate storage
            if (this.isTs && this.fullFilePath.endsWith('.ts')) {
                console.log(`[DVR_SUPERVISOR][${this.job.id}] Remuxing completed TS recording to seekable MP4...`);
                const remuxResult = await remuxTsToMp4(this.fullFilePath);
                if (remuxResult.success) {
                    finalFilePath = remuxResult.mp4Path;
                    finalSizeBytes = remuxResult.fileSizeBytes;
                    if (remuxResult.durationSeconds) {
                        durationSeconds = remuxResult.durationSeconds;
                    }
                    console.log(`[DVR_SUPERVISOR][${this.job.id}] Remux complete: ${finalFilePath}`);
                } else {
                    console.warn(`[DVR_SUPERVISOR][${this.job.id}] Remux failed (${remuxResult.error}), retaining original TS file.`);
                }
            }

            if (!durationSeconds) durationSeconds = wallClockDuration;

            // Calculate actualEndTime and actualStartTime accurately
            const scheduledEndMs = new Date(this.job.endTime).getTime();
            const nowMs = Date.now();
            let actualEndTime = this.job.endTime;
            if (reason === 'manual' || reason === 'stopped' || reason === 'interrupted' || nowMs < scheduledEndMs) {
                actualEndTime = new Date(nowMs).toISOString();
            }

            let actualStartTime = (this.actualStartTime instanceof Date) ? this.actualStartTime.toISOString() : (this.job.startTime || new Date().toISOString());
            if (durationSeconds > 0) {
                const endMs = new Date(actualEndTime).getTime();
                actualStartTime = new Date(endMs - (durationSeconds * 1000)).toISOString();
            }

            console.log(`[DVR_SUPERVISOR][${this.job.id}] Preserving recording (${(finalSizeBytes / (1024 * 1024)).toFixed(1)} MB, ${durationSeconds}s, reason: ${reason}, window: ${actualStartTime} -> ${actualEndTime}).`);

            db.run(`INSERT INTO dvr_recordings (job_id, user_id, channelName, programTitle, startTime, durationSeconds, fileSizeBytes, filePath) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [this.job.id, this.job.user_id, this.job.channelName, this.job.programTitle, actualStartTime, durationSeconds, finalSizeBytes, finalFilePath],
                (insertErr) => {
                    if (insertErr) {
                        console.error(`[DVR_SUPERVISOR][${this.job.id}] Failed to insert into dvr_recordings:`, insertErr.message);
                    } else {
                        console.log(`[DVR_SUPERVISOR][${this.job.id}] Successfully logged to dvr_recordings.`);
                        enforceRecordingSizeLimit().catch(() => { });
                    }
                }
            );

            const finalStatus = 'completed';
            const errorMsg = reason === 'interrupted'
                ? `Recording completed partially (Stream dropped after ${this.retryCount} reconnect attempts).`
                : null;

            db.run("UPDATE dvr_jobs SET status = ?, startTime = ?, endTime = ?, ffmpeg_pid = NULL, filePath = ?, errorMessage = ? WHERE id = ?", [finalStatus, actualStartTime, actualEndTime, finalFilePath, errorMsg, this.job.id]);
            broadcastDvrUpdate(this.job.user_id, { jobId: this.job.id, status: finalStatus, startTime: actualStartTime, endTime: actualEndTime, errorMessage: errorMsg });
        } else {
            const errMsg = `Recording failed or produced no usable video. Reason: ${reason}. Output: ${this.lastErrorOutput.slice(-500)}`;
            console.error(`[DVR_SUPERVISOR][${this.job.id}] ${errMsg}`);
            db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errMsg, this.job.id]);
            broadcastDvrUpdate(this.job.user_id, { jobId: this.job.id, status: 'error', errorMessage: errMsg });

            if (stats && !isRecordingFileUsable(stats.size, durationSeconds)) {
                try {
                    fs.unlinkSync(this.fullFilePath);
                    console.log(`[DVR_SUPERVISOR][${this.job.id}] Cleaned up empty/failed file: ${this.fullFilePath}`);
                } catch (e) { }
            }
        }
    }

    stop() {
        console.log(`[DVR_SUPERVISOR][${this.job.id}] Stopping supervisor intentionally.`);
        this.isStoppedIntentionally = true;
        this.stopWatchdog();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }

        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.kill('SIGINT');
            } catch (e) {
                try { this.ffmpegProcess.kill('SIGKILL'); } catch (e2) { }
            }
        } else {
            this.finalizeRecording('stopped');
        }
    }
}

function stopRecording(jobId) {
    cleanupTimeshiftSession(jobId, true);
    const supervisor = activeDvrSupervisors.get(jobId);
    if (supervisor) {
        console.log(`[DVR] Stopping active supervisor for job ${jobId}.`);
        supervisor.stop();
    } else {
        const pid = runningFFmpegProcesses.get(jobId);
        if (pid) {
            console.log(`[DVR] Gracefully stopping recording for job ${jobId} (PID: ${pid}). Sending SIGINT.`);
            try {
                process.kill(pid, 'SIGINT');
            } catch (e) {
                console.error(`[DVR] Error sending SIGINT to ffmpeg process for job ${jobId}: ${e.message}. Trying SIGKILL.`);
                try { process.kill(pid, 'SIGKILL'); } catch (e2) { }
            }
        } else {
            console.warn(`[DVR] Cannot stop job ${jobId}: No running supervisor or ffmpeg process found.`);
        }
    }
}

async function startRecording(job) {
    console.log(`[DVR] Starting recording for job ${job.id}: "${job.programTitle}"`);
    const settings = getSettings();
    const allChannels = readChannels() || [];
    const channel = allChannels.find(c => c.id === job.channelId);

    if (!channel) {
        const errorMsg = `Channel ID ${job.channelId} not found in M3U.`;
        console.error(`[DVR] Cannot start recording job ${job.id}: ${errorMsg}`);
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errorMsg, job.id]);
        broadcastDvrUpdate(job.user_id, { jobId: job.id, status: 'error', errorMessage: errorMsg });
        return;
    }

    const owner = await dbGet(db, "SELECT id, isAdmin, allowed_sources FROM users WHERE id = ?", [job.user_id]);
    if (!owner || !isChannelAllowed(channel, allowedSourcesFromUser(owner))) {
        const errorMsg = 'This channel is no longer available for this user.';
        console.error(`[DVR] Cannot start recording job ${job.id}: ${errorMsg}`);
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errorMsg, job.id]);
        broadcastDvrUpdate(job.user_id, { jobId: job.id, status: 'error', errorMessage: errorMsg });
        return;
    }

    const recProfile = (settings.dvr.recordingProfiles || []).find(p => p.id === job.profileId);
    if (!recProfile) {
        const errorMsg = `Recording profile ID "${job.profileId}" not found.`;
        console.error(`[DVR] Cannot start recording job ${job.id}: ${errorMsg}`);
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errorMsg, job.id]);
        broadcastDvrUpdate(job.user_id, { jobId: job.id, status: 'error', errorMessage: errorMsg });
        return;
    }

    const userAgent = (settings.userAgents || []).find(ua => ua.id === job.userAgentId) || { id: 'default', value: 'ViniPlay/1.0' };

    console.log(`[DVR] Using recording profile: "${recProfile.name}"`);

    const fileExtension = recProfile.command.includes('-f mp4') ? '.mp4' : '.ts';
    const safeFilename = `${job.id}_${job.programTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}${fileExtension}`;
    const fullFilePath = path.join(DVR_DIR, safeFilename);

    const space = await assertDvrFreeSpace(settings);
    if (!space.ok) {
        console.error(`[DVR] Cannot start recording job ${job.id}: ${space.error}`);
        if (activeDvrJobs.has(job.id)) {
            activeDvrJobs.get(job.id)?.cancel();
            activeDvrJobs.delete(job.id);
        }
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [space.error, job.id]);
        broadcastDvrUpdate(job.user_id, { jobId: job.id, status: 'error', errorMessage: space.error });
        return;
    }

    if (activeDvrSupervisors.has(job.id)) {
        activeDvrSupervisors.get(job.id).stop();
    }

    const supervisor = new DvrSupervisor(job, channel, recProfile, userAgent, fullFilePath, settings);
    activeDvrSupervisors.set(job.id, supervisor);
    supervisor.start();
}

function scheduleDvrJob(job) {
    if (activeDvrJobs.has(job.id)) {
        const existing = activeDvrJobs.get(job.id);
        if (existing) {
            if (typeof existing.cancel === 'function') existing.cancel();
            if (existing.startJob) existing.startJob.cancel();
            if (existing.stopJob) existing.stopJob.cancel();
        }
        activeDvrJobs.delete(job.id);
    }

    const startTime = new Date(job.startTime);
    const endTime = new Date(job.endTime);
    const now = new Date();

    if (endTime <= now) {
        console.log(`[DVR] Job ${job.id} for "${job.programTitle}" is already in the past. Skipping schedule.`);
        if (job.status === 'scheduled') {
            db.run("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Job was scheduled for a time in the past.' WHERE id = ?", [job.id]);
        }
        return;
    }

    let startJob = null;
    let stopJob = null;

    if (startTime > now) {
        startJob = schedule.scheduleJob(startTime, () => startRecording(job));
        console.log(`[DVR] Scheduled recording start for job ${job.id} at ${startTime}`);
    } else {
        startRecording(job);
    }

    stopJob = schedule.scheduleJob(endTime, () => stopRecording(job.id));
    console.log(`[DVR] Scheduled recording stop for job ${job.id} at ${endTime}`);

    activeDvrJobs.set(job.id, {
        startJob,
        stopJob,
        cancel: () => {
            if (startJob) startJob.cancel();
            if (stopJob) stopJob.cancel();
        }
    });
}



// ... existing functions ...

// One Node process schedules recordings; this queue keeps check-and-insert atomic.
let dvrScheduleChain = Promise.resolve();
function withDvrScheduleLock(task) {
    const run = dvrScheduleChain.then(task, task);
    dvrScheduleChain = run.catch(() => { });
    return run;
}

async function checkForConflicts(newJob) {
    const settings = getSettings();
    const maxConcurrent = settings.dvr?.maxConcurrentRecordings || 1;
    const jobs = await dbAll(
        db,
        "SELECT id, user_id, channelName, programTitle, startTime, endTime, status FROM dvr_jobs WHERE status IN ('scheduled', 'recording', 'reconnecting')",
        []
    );
    const overlapping = overlappingJobs(jobs, newJob);
    return overlapping.length >= maxConcurrent ? overlapping : [];
}

function getDvrJobForUser(jobId, session) {
    return dbGet(
        db,
        session.isAdmin ? "SELECT * FROM dvr_jobs WHERE id = ?" : "SELECT * FROM dvr_jobs WHERE id = ? AND user_id = ?",
        session.isAdmin ? [jobId] : [jobId, session.userId]
    );
}

// Other users' programme names must not leak in a conflict response.
function conflictsForResponse(jobs, isAdmin) {
    if (isAdmin) return jobs;
    return jobs.map((job) => ({
        id: job.id,
        programTitle: 'Another recording',
        channelName: 'Another channel',
        startTime: job.startTime,
        endTime: job.endTime,
    }));
}

async function autoDeleteOldRecordings() {
    console.log('[DVR_STORAGE] Running daily check for old recordings to delete.');
    db.all("SELECT id FROM users", [], (err, users) => {
        if (err) return console.error('[DVR_STORAGE] Could not fetch users for auto-delete check:', err);

        users.forEach(user => {
            db.get("SELECT value FROM user_settings WHERE user_id = ? AND key = 'dvr'", [user.id], (err, row) => {
                const settings = getSettings();
                const userDvrSettings = row ? { ...settings.dvr, ...JSON.parse(row.value) } : settings.dvr;

                const deleteDays = userDvrSettings.autoDeleteDays;
                if (!deleteDays || deleteDays <= 0) {
                    return;
                }

                const cutoffDate = new Date();
                cutoffDate.setDate(cutoffDate.getDate() - deleteDays);

                db.all("SELECT id, filePath FROM dvr_recordings WHERE user_id = ? AND startTime < ?", [user.id, cutoffDate.toISOString()], (err, recordingsToDelete) => {
                    if (err) return console.error(`[DVR_STORAGE] Error fetching old recordings for user ${user.id}:`, err);
                    if (recordingsToDelete.length > 0) {
                        console.log(`[DVR_STORAGE] Found ${recordingsToDelete.length} old recording(s) to delete for user ${user.id}.`);
                    }

                    recordingsToDelete.forEach(rec => {
                        if (fs.existsSync(rec.filePath)) {
                            fs.unlink(rec.filePath, (unlinkErr) => {
                                if (unlinkErr) {
                                    console.error(`[DVR_STORAGE] Failed to delete file ${rec.filePath}:`, unlinkErr);
                                } else {
                                    db.run("DELETE FROM dvr_recordings WHERE id = ?", [rec.id]);
                                    console.log(`[DVR_STORAGE] Deleted old recording file and DB record: ${rec.filePath}`);
                                }
                            });
                        } else {
                            db.run("DELETE FROM dvr_recordings WHERE id = ?", [rec.id]);
                        }
                    });
                });
            });
        });
    });
}
async function enforceRecordingSizeLimit() {
    const limitGb = getSettings().dvr?.retainNewestGb || 0;
    if (limitGb <= 0) return;
    const limitBytes = limitGb * 1024 * 1024 * 1024;
    try {
        const rows = await dbAll(db, "SELECT id, filePath, fileSizeBytes FROM dvr_recordings ORDER BY startTime DESC", []);
        let total = rows.reduce((sum, row) => sum + (Number(row.fileSizeBytes) || 0), 0);
        for (let i = rows.length - 1; i >= 0 && total > limitBytes; i--) {
            const row = rows[i];
            try {
                if (row.filePath && fs.existsSync(row.filePath)) await fs.promises.unlink(row.filePath);
                await dbRun(db, "DELETE FROM dvr_recordings WHERE id = ?", [row.id]);
                total -= Number(row.fileSizeBytes) || 0;
                console.log(`[DVR_STORAGE] Removed oldest recording to stay under ${limitGb} GB: ${row.filePath}`);
            } catch (e) {
                console.warn('[DVR_STORAGE] Could not remove old recording:', e.message);
            }
        }
    } catch (e) {
        console.error('[DVR_STORAGE] Size cleanup failed:', e.message);
    }
}

async function syncSeriesRules(ruleId = null) {
    await schemaReady;
    const settings = getSettings();
    const dvrSettings = settings.dvr || {};
    const rules = await dbAll(
        db,
        ruleId
            ? "SELECT * FROM dvr_series_rules WHERE id = ? AND enabled = 1"
            : "SELECT * FROM dvr_series_rules WHERE enabled = 1",
        ruleId ? [ruleId] : []
    );
    if (!rules.length) return 0;
    const guide = readEpgGuide() || {};
    const now = Date.now();
    const horizon = now + 7 * 24 * 60 * 60 * 1000;
    const preBuffer = (dvrSettings.preBufferMinutes || 0) * 60 * 1000;
    const postBuffer = (dvrSettings.postBufferMinutes || 0) * 60 * 1000;
    let created = 0;

    for (const rule of rules) {
        const programs = matchingSeriesPrograms(rule, guide[rule.channelId] || [], now, horizon);
        for (const program of programs) {
            const startMs = Date.parse(program.start);
            const stopMs = Date.parse(program.stop);
            if (await dbGet(db, "SELECT id FROM dvr_jobs WHERE channelId = ? AND status IN ('scheduled', 'recording', 'reconnecting', 'completed') AND startTime < ? AND endTime > ? LIMIT 1", [rule.channelId, program.stop, program.start])) continue;
            const window = validateRecordingWindow(program.start, program.stop, dvrSettings.maxRecordingHours);
            if (!window.ok) continue;

            const newJob = {
                user_id: rule.user_id,
                channelId: rule.channelId,
                channelName: rule.channelName,
                programTitle: rule.programTitle,
                startTime: new Date(Math.max(now, startMs - preBuffer)).toISOString(),
                programStart: program.start,
                endTime: new Date(stopMs + postBuffer).toISOString(),
                status: 'scheduled',
                profileId: dvrSettings.activeRecordingProfileId,
                userAgentId: settings.activeUserAgentId,
                preBufferMinutes: dvrSettings.preBufferMinutes || 0,
                postBufferMinutes: dvrSettings.postBufferMinutes || 0,
                series_rule_id: rule.id,
            };
            const result = await withDvrScheduleLock(async () => {
                const conflicts = await checkForConflicts(newJob);
                if (conflicts.length) return null;
                const inserted = await dbRun(db, `INSERT INTO dvr_jobs (user_id, channelId, channelName, programTitle, startTime, endTime, status, profileId, userAgentId, preBufferMinutes, postBufferMinutes, programStart, series_rule_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [newJob.user_id, newJob.channelId, newJob.channelName, newJob.programTitle, newJob.startTime, newJob.endTime, newJob.status, newJob.profileId, newJob.userAgentId, newJob.preBufferMinutes, newJob.postBufferMinutes, newJob.programStart, newJob.series_rule_id]);
                return { ...newJob, id: inserted.lastID };
            });
            if (!result) continue;
            scheduleDvrJob(result);
            broadcastDvrUpdate(result.user_id, { jobId: result.id, status: 'scheduled' });
            created++;
        }
    }
    if (created) console.log(`[DVR_SERIES] Scheduled ${created} recording(s) from series rules.`);
    return created;
}

// --- DVR API Endpoints (MODIFIED & NEW) ---
// ... existing DVR API Endpoints ...

// --- DVR Live Timeshift & Chase Play Session Manager ---
const activeTimeshiftSessions = new Map(); // jobId -> { tailProc, ffmpegProc, dir, playlistPath, lastAccess }

function cleanupTimeshiftSession(jobId, deleteDirectory = false) {
    const session = activeTimeshiftSessions.get(jobId);
    if (!session) {
        if (deleteDirectory) {
            const sessionDir = path.join(DVR_DIR, '.timeshift', String(jobId));
            try {
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    console.log(`[DVR_TIMESHIFT] Removed timeshift directory on completion/deletion: ${sessionDir}`);
                }
            } catch (e) { }
        }
        return;
    }

    console.log(`[DVR_TIMESHIFT] Cleaning up timeshift session for job ${jobId} (deleteDirectory: ${deleteDirectory})`);
    try {
        if (session.tailProc) {
            session.tailProc.kill('SIGTERM');
            try { session.tailProc.kill('SIGKILL'); } catch (e) { }
        }
        if (session.ffmpegProc) {
            session.ffmpegProc.kill('SIGTERM');
            try { session.ffmpegProc.kill('SIGKILL'); } catch (e) { }
        }
    } catch (e) { }

    activeTimeshiftSessions.delete(jobId);

    if (deleteDirectory) {
        setTimeout(() => {
            try {
                if (session.dir && fs.existsSync(session.dir)) {
                    fs.rmSync(session.dir, { recursive: true, force: true });
                    console.log(`[DVR_TIMESHIFT] Removed temporary timeshift directory: ${session.dir}`);
                }
            } catch (e) {
                console.warn(`[DVR_TIMESHIFT] Could not remove timeshift dir ${session.dir}:`, e.message);
            }
        }, 1500);
    }
}

async function getOrCreateTimeshiftSession(jobId, filePath) {
    let session = activeTimeshiftSessions.get(jobId);
    if (session) {
        session.lastAccess = Date.now();
        return session;
    }

    const sessionDir = path.join(DVR_DIR, '.timeshift', String(jobId));
    try {
        // ALWAYS purge any stale files before starting a brand new timeshift session
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`[DVR_TIMESHIFT] Purged stale directory before creating session: ${sessionDir}`);
        }
        fs.mkdirSync(sessionDir, { recursive: true, mode: 0o777 });
    } catch (e) {
        console.warn(`[DVR_TIMESHIFT] Error creating clean sessionDir ${sessionDir}:`, e.message);
    }

    const sessionToken = Date.now().toString(36);
    const playlistPath = path.join(sessionDir, 'stream.m3u8');
    const segmentPattern = path.join(sessionDir, `seg_${sessionToken}_%05d.ts`);

    console.log(`[DVR_TIMESHIFT] Spawning timeshift HLS session for job ${jobId} (token: ${sessionToken}) from ${filePath}...`);

    // Use tail -c +1 -f to follow the growing TS file from the beginning
    const tailProc = spawn('tail', ['-c', '+1', '-f', filePath]);
    const ffmpegArgs = [
        '-y',
        '-f', 'mpegts',
        '-i', 'pipe:0',
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '900',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename', segmentPattern,
        playlistPath
    ];
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
    tailProc.stdout.pipe(ffmpegProc.stdin);

    tailProc.on('error', (err) => console.error(`[DVR_TIMESHIFT][${jobId}] Tail error:`, err.message));
    ffmpegProc.on('error', (err) => console.error(`[DVR_TIMESHIFT][${jobId}] FFmpeg error:`, err.message));

    session = {
        jobId,
        sessionToken,
        tailProc,
        ffmpegProc,
        dir: sessionDir,
        playlistPath,
        lastAccess: Date.now()
    };
    activeTimeshiftSessions.set(jobId, session);

    // Wait until stream.m3u8 is created and has initial playlist content (up to 4000ms)
    const startTime = Date.now();
    while (Date.now() - startTime < 4000) {
        if (fs.existsSync(playlistPath)) {
            try {
                const stat = fs.statSync(playlistPath);
                if (stat.size > 50) break;
            } catch (e) { }
        }
        await new Promise(r => setTimeout(r, 100));
    }

    return session;
}

// Janitor: reap inactive timeshift sessions after 5 minutes of no client activity (stop processes, keep directory)
setInterval(() => {
    const now = Date.now();
    for (const [jobId, session] of activeTimeshiftSessions.entries()) {
        if (now - session.lastAccess > 300000) {
            console.log(`[DVR_TIMESHIFT] Timeshift session for job ${jobId} idle for > 5 min. Stopping background processes.`);
            cleanupTimeshiftSession(jobId, false);
        }
    }
}, 30000);

// Helper to format and serve M3U8 with #EXT-X-START:TIME-OFFSET=0
function sendFormattedTimeshiftPlaylist(playlistPath, res) {
    try {
        let playlist = fs.readFileSync(playlistPath, 'utf-8');
        if (!playlist.includes('#EXT-X-START')) {
            playlist = playlist.replace(/(#EXT-X-PLAYLIST-TYPE:EVENT\r?\n)/, '$1#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
        }
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(playlist);
    } catch (e) {
        res.status(500).send('Error reading timeshift playlist.');
    }
}

// HEAD request handler for HLS probe
app.head('/api/dvr/timeshift/:jobId/stream.m3u8', requireAuth, requireDvrAccess, (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).end();
});

// Primary HLS Playlist endpoint
app.get('/api/dvr/timeshift/:jobId/stream.m3u8', requireAuth, requireDvrAccess, async (req, res) => {
    const { jobId } = req.params;
    const userId = req.session.userId;
    const query = req.session.isAdmin
        ? "SELECT filePath, status FROM dvr_jobs WHERE id = ?"
        : "SELECT filePath, status FROM dvr_jobs WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [jobId] : [jobId, userId];

    db.get(query, params, async (err, job) => {
        if (err || !job) {
            return res.status(404).send('Recording job not found or not authorized.');
        }
        if (job.status !== 'recording' && job.status !== 'reconnecting') {
            return res.status(400).send('Cannot timeshift a recording that is not in progress.');
        }
        if (!job.filePath || !fs.existsSync(job.filePath)) {
            return res.status(404).send('Recording file not found on disk.');
        }

        try {
            const session = await getOrCreateTimeshiftSession(jobId, job.filePath);
            session.lastAccess = Date.now();
            if (!fs.existsSync(session.playlistPath)) {
                return res.status(503).send('Timeshift stream initializing, please retry.');
            }
            sendFormattedTimeshiftPlaylist(session.playlistPath, res);
        } catch (sessionErr) {
            console.error(`[DVR_TIMESHIFT] Error creating session for job ${jobId}:`, sessionErr);
            res.status(500).send('Error creating timeshift session.');
        }
    });
});

// Endpoint to serve segments (seg_*.ts) and stream.m3u8
app.get('/api/dvr/timeshift/:jobId/:file', requireAuth, requireDvrAccess, (req, res) => {
    const { jobId, file } = req.params;
    const query = req.session.isAdmin
        ? "SELECT id FROM dvr_jobs WHERE id = ?"
        : "SELECT id FROM dvr_jobs WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [jobId] : [jobId, req.session.userId];

    db.get(query, params, (err, job) => {
        if (err || !job) {
            return res.status(404).send('Recording job not found or not authorized.');
        }

        const session = activeTimeshiftSessions.get(jobId);
        const sessionDir = session ? session.dir : path.join(DVR_DIR, '.timeshift', String(jobId));

        if (session) {
            session.lastAccess = Date.now();
        }

        if (file === 'stream.m3u8') {
            const playlistPath = path.join(sessionDir, 'stream.m3u8');
            if (!fs.existsSync(playlistPath)) {
                return res.status(404).send('Timeshift stream not found.');
            }
            return sendFormattedTimeshiftPlaylist(playlistPath, res);
        }

        // No slashes: the previous `.*` let an encoded %2F walk out of the session directory.
        if (!/^seg_[a-z0-9]+_\d+\.ts$/i.test(file)) {
            return res.status(400).send('Invalid segment filename.');
        }

        const segPath = path.join(sessionDir, file);
        if (path.dirname(segPath) !== sessionDir) {
            return res.status(400).send('Invalid segment filename.');
        }
        if (!fs.existsSync(segPath)) {
            return res.status(404).send('Segment not found.');
        }

        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Access-Control-Allow-Origin', '*');
        fs.createReadStream(segPath).pipe(res);
    });
});

// Endpoint to explicitly stop/clean up a timeshift session (stops processes, preserves directory)
app.post('/api/dvr/timeshift/:jobId/stop', requireAuth, requireDvrAccess, (req, res) => {
    const { jobId } = req.params;
    const query = req.session.isAdmin
        ? "SELECT id FROM dvr_jobs WHERE id = ?"
        : "SELECT id FROM dvr_jobs WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [jobId] : [jobId, req.session.userId];

    db.get(query, params, (err, job) => {
        if (err || !job) return res.status(404).json({ error: 'Recording job not found or not authorized.' });
        cleanupTimeshiftSession(jobId, false);
        res.json({ success: true });
    });
});

// Legacy redirect for any old timeshift calls
app.get('/api/dvr/timeshift/:jobId', requireAuth, requireDvrAccess, (req, res) => {
    const { jobId } = req.params;
    res.redirect(`/api/dvr/timeshift/${jobId}/stream.m3u8`);
});

// --- Live rewind buffer: one rolling HLS session per channel ---
function liveBufferDir(channelId) {
    const safe = String(channelId).replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    const hash = crypto.createHash('sha1').update(String(channelId)).digest('hex').slice(0, 8);
    return path.join(LIVE_BUFFER_DIR, `${safe}_${hash}`);
}

function directorySizeMb(dir) {
    try {
        return fs.readdirSync(dir).reduce((total, name) => {
            try { return total + fs.statSync(path.join(dir, name)).size; } catch (e) { return total; }
        }, 0) / (1024 * 1024);
    } catch (e) {
        return 0;
    }
}

function stopLiveBuffer(channelId, deleteDirectory = true) {
    const id = String(channelId);
    const session = activeLiveBuffers.get(id);
    if (session?.process) {
        try { session.process.kill('SIGTERM'); } catch (e) { }
        try { session.process.kill('SIGKILL'); } catch (e) { }
    }
    activeLiveBuffers.delete(id);
    if (deleteDirectory) {
        setTimeout(() => {
            if (activeLiveBuffers.has(id)) return;
            try {
                if (session?.dir && fs.existsSync(session.dir)) fs.rmSync(session.dir, { recursive: true, force: true });
            } catch (e) {
                console.warn(`[LIVE_BUFFER] Could not remove ${session?.dir}:`, e.message);
            }
        }, 1000);
    }
}

function cleanupStaleLiveBuffers() {
    try {
        if (!fs.existsSync(LIVE_BUFFER_DIR)) return;
        for (const name of fs.readdirSync(LIVE_BUFFER_DIR)) {
            fs.rmSync(path.join(LIVE_BUFFER_DIR, name), { recursive: true, force: true });
        }
        console.log('[LIVE_BUFFER] Cleared stale rewind directories.');
    } catch (e) {
        console.warn('[LIVE_BUFFER] Could not clear stale directories:', e.message);
    }
}

function waitForFile(filePath, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            try {
                if (fs.existsSync(filePath) && fs.statSync(filePath).size > 50) return resolve(true);
            } catch (e) { }
            if (Date.now() - started >= timeoutMs) return resolve(false);
            setTimeout(tick, 150);
        };
        tick();
    });
}

async function startLiveBuffer(channel, settings) {
    const channelId = String(channel.id);
    const existing = activeLiveBuffers.get(channelId);
    if (existing) return existing;

    assertSafeStreamUrl(channel.url);
    await assertSafeMediaStreamUrl(channel.url);
    const dir = liveBufferDir(channelId);
    const playlistPath = path.join(dir, 'stream.m3u8');
    const segmentPattern = path.join(dir, 'seg_%05d.ts');
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
    } catch (e) {
        throw new Error(`Could not create live rewind directory: ${e.message}`);
    }

    const userAgent = (settings.userAgents || []).find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
    const minutes = settings.liveRewind?.minutes || 15;
    const args = [
        '-v', 'level+error',
        '-user_agent', userAgent,
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
        '-rw_timeout', '15000000',
        '-fflags', '+genpts+discardcorrupt',
        '-i', channel.url,
        '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', String(liveBufferSegmentCount(minutes)),
        '-hls_playlist_type', 'event',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename', segmentPattern,
        playlistPath,
    ];
    console.log(`[LIVE_BUFFER] Starting for channel ${channelId} (${channel.name || channel.displayName}) for ${minutes} minutes.`);
    const process = spawn('ffmpeg', args);
    const session = {
        channelId,
        sourceUrl: channel.url,
        dir,
        playlistPath,
        process,
        lastAccess: Date.now(),
        diskCapMb: settings.liveRewind?.diskCapMb || 4096,
    };
    activeLiveBuffers.set(channelId, session);

    process.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.warn(`[LIVE_BUFFER][${channelId}] ${line}`);
    });
    process.on('error', (err) => console.error(`[LIVE_BUFFER][${channelId}] ${err.message}`));
    process.on('close', (code) => {
        console.log(`[LIVE_BUFFER][${channelId}] FFmpeg exited with code ${code}.`);
        if (activeLiveBuffers.get(channelId) === session) {
            activeLiveBuffers.delete(channelId);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
        }
    });

    if (!(await waitForFile(playlistPath))) {
        stopLiveBuffer(channelId);
        throw new Error('Live rewind buffer did not start in time.');
    }
    return session;
}

function sendLiveBufferPlaylist(playlistPath, res) {
    try {
        const playlist = fs.readFileSync(playlistPath, 'utf-8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(playlist);
    } catch (e) {
        res.status(500).send('Error reading live rewind playlist.');
    }
}

app.head('/api/livebuffer/:channelId/stream.m3u8', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).end();
});

app.get('/api/livebuffer/:channelId/stream.m3u8', requireAuth, async (req, res) => {
    const settings = getSettings();
    if (!settings.liveRewind?.enabled) return res.status(404).send('Live rewind is disabled.');
    const channelId = String(req.params.channelId);
    const channel = (readChannels() || []).find(c => String(c.id) === channelId);
    if (!channel) return res.status(404).send('Channel not found.');

    if (!activeLiveBuffers.has(channelId)) {
        const space = await assertDvrFreeSpace(settings);
        if (!space.ok) return res.status(507).send(space.error);
    }

    try {
        const session = await startLiveBuffer(channel, settings);
        session.lastAccess = Date.now();
        if (!fs.existsSync(session.playlistPath)) return res.status(503).send('Live rewind is initializing.');
        sendLiveBufferPlaylist(session.playlistPath, res);
    } catch (error) {
        console.error(`[LIVE_BUFFER] Could not start channel ${channelId}:`, error.message);
        res.status(503).send(error.message);
    }
});

app.get('/api/livebuffer/:channelId/:file', requireAuth, (req, res) => {
    const channelId = String(req.params.channelId);
    const session = activeLiveBuffers.get(channelId);
    if (!session) return res.status(404).send('Live rewind session not found.');
    session.lastAccess = Date.now();

    const file = req.params.file;
    if (!/^seg_\d+\.ts$/.test(file)) return res.status(400).send('Invalid segment filename.');
    const segmentPath = path.join(session.dir, file);
    if (!segmentPath.startsWith(session.dir + path.sep)) return res.status(400).send('Invalid segment filename.');
    if (!fs.existsSync(segmentPath)) return res.status(404).send('Segment not found.');

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(segmentPath).pipe(res);
});

setInterval(() => {
    const now = Date.now();
    for (const [channelId, session] of activeLiveBuffers.entries()) {
        if (now - session.lastAccess > 300000) {
            console.log(`[LIVE_BUFFER] Stopping idle session for channel ${channelId}.`);
            stopLiveBuffer(channelId);
            continue;
        }
        const sizeMb = directorySizeMb(session.dir);
        if (sizeMb > session.diskCapMb) {
            console.warn(`[LIVE_BUFFER] Channel ${channelId} hit its ${session.diskCapMb} MB cap; stopping.`);
            stopLiveBuffer(channelId);
        }
    }
}, 30000);

cleanupStaleLiveBuffers();
try {
    const timeshiftDir = path.join(DVR_DIR, '.timeshift');
    if (fs.existsSync(timeshiftDir)) {
        for (const name of fs.readdirSync(timeshiftDir)) {
            fs.rmSync(path.join(timeshiftDir, name), { recursive: true, force: true });
        }
    }
} catch (e) {
    console.warn('[DVR_TIMESHIFT] Could not clear stale timeshift directories:', e.message);
}

app.post('/api/dvr/schedule', requireAuth, requireDvrAccess, async (req, res) => {
    try {
        const { channelId, channelName, programTitle, programStart, programStop } = req.body;
        const settings = getSettings();
        const dvrSettings = settings.dvr || {};
        const channel = (readChannels() || []).find(c => String(c.id) === String(channelId));
        if (!channel) return res.status(400).json({ error: 'Channel not found.' });
        if (!isChannelAllowed(channel, allowedSourcesFromUser(req.user))) {
            return res.status(403).json({ error: 'You do not have access to this channel.' });
        }
        const window = validateRecordingWindow(programStart, programStop, dvrSettings.maxRecordingHours);
        if (!window.ok) return res.status(400).json({ error: window.error });

        const preBuffer = (dvrSettings.preBufferMinutes || 0) * 60 * 1000;
        const postBuffer = (dvrSettings.postBufferMinutes || 0) * 60 * 1000;
        const plannedStart = new Date(window.startMs - preBuffer).toISOString();
        const nowMs = Date.now();
        const effectiveStartTime = new Date(plannedStart).getTime() < nowMs ? new Date(nowMs).toISOString() : plannedStart;
        const endTime = new Date(window.endMs + postBuffer).toISOString();
        if (Date.parse(endTime) <= nowMs) return res.status(400).json({ error: 'The programme has already ended.' });

        const newJob = {
            user_id: req.session.userId,
            channelId,
            channelName: channel.displayName || channel.name || channelName,
            programTitle: String(programTitle || channel.displayName || channel.name || 'Recording').slice(0, 200),
            startTime: effectiveStartTime,
            programStart: new Date(window.startMs).toISOString(),
            endTime,
            status: 'scheduled',
            profileId: dvrSettings.activeRecordingProfileId,
            userAgentId: settings.activeUserAgentId,
            preBufferMinutes: dvrSettings.preBufferMinutes || 0,
            postBufferMinutes: dvrSettings.postBufferMinutes || 0
        };

        const result = await withDvrScheduleLock(async () => {
            const conflictingJobs = await checkForConflicts(newJob);
            if (conflictingJobs.length > 0) return { conflicts: conflictingJobs };
            const inserted = await dbRun(db, `INSERT INTO dvr_jobs (user_id, channelId, channelName, programTitle, startTime, endTime, status, profileId, userAgentId, preBufferMinutes, postBufferMinutes, programStart)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [newJob.user_id, newJob.channelId, newJob.channelName, newJob.programTitle, newJob.startTime, newJob.endTime, newJob.status, newJob.profileId, newJob.userAgentId, newJob.preBufferMinutes, newJob.postBufferMinutes, newJob.programStart]);
            return { job: { ...newJob, id: inserted.lastID } };
        });
        if (result.conflicts) {
            return res.status(409).json({ error: 'Recording conflict detected.', newJob, conflictingJobs: conflictsForResponse(result.conflicts, req.session.isAdmin) });
        }
        scheduleDvrJob(result.job);
        res.status(201).json({ success: true, job: result.job });
    } catch (error) {
        console.error('[DVR_API] Error scheduling new recording:', error);
        res.status(500).json({ error: 'Could not schedule recording.' });
    }
});

app.post('/api/dvr/schedule/manual', requireAuth, requireDvrAccess, async (req, res) => {
    try {
        const { channelId, channelName, startTime, endTime, programTitle } = req.body;
        const settings = getSettings();
        const dvrSettings = settings.dvr || {};
        const channel = (readChannels() || []).find(c => String(c.id) === String(channelId));
        if (!channel) return res.status(400).json({ error: 'Channel not found.' });
        if (!isChannelAllowed(channel, allowedSourcesFromUser(req.user))) {
            return res.status(403).json({ error: 'You do not have access to this channel.' });
        }
        const window = validateRecordingWindow(startTime, endTime, dvrSettings.maxRecordingHours);
        if (!window.ok) return res.status(400).json({ error: window.error });
        const effectiveStartMs = Math.max(window.startMs, Date.now());
        if (window.endMs <= effectiveStartMs) return res.status(400).json({ error: 'End time must be in the future.' });

        const newJob = {
            user_id: req.session.userId,
            channelId,
            channelName: channel.displayName || channel.name || channelName,
            programTitle: String(programTitle || `Manual Recording: ${channel.displayName || channel.name || channelName}`).slice(0, 200),
            startTime: new Date(effectiveStartMs).toISOString(),
            endTime: new Date(window.endMs).toISOString(),
            status: 'scheduled',
            profileId: dvrSettings.activeRecordingProfileId,
            userAgentId: settings.activeUserAgentId,
            preBufferMinutes: 0,
            postBufferMinutes: 0
        };

        const result = await withDvrScheduleLock(async () => {
            const conflictingJobs = await checkForConflicts(newJob);
            if (conflictingJobs.length > 0) return { conflicts: conflictingJobs };
            const inserted = await dbRun(db, `INSERT INTO dvr_jobs (user_id, channelId, channelName, programTitle, startTime, endTime, status, profileId, userAgentId, preBufferMinutes, postBufferMinutes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [newJob.user_id, newJob.channelId, newJob.channelName, newJob.programTitle, newJob.startTime, newJob.endTime, newJob.status, newJob.profileId, newJob.userAgentId, newJob.preBufferMinutes, newJob.postBufferMinutes]);
            return { job: { ...newJob, id: inserted.lastID } };
        });
        if (result.conflicts) {
            return res.status(409).json({ error: 'Recording conflict detected.', newJob, conflictingJobs: conflictsForResponse(result.conflicts, req.session.isAdmin) });
        }
        scheduleDvrJob(result.job);
        res.status(201).json({ success: true, job: result.job });
    } catch (error) {
        console.error('[DVR_API] Error scheduling manual recording:', error);
        res.status(500).json({ error: 'Could not schedule recording.' });
    }
});

app.post('/api/dvr/series', requireAuth, requireDvrAccess, async (req, res) => {
    try {
        const { channelId, programTitle } = req.body;
        const channel = (readChannels() || []).find(c => String(c.id) === String(channelId));
        const title = String(programTitle || '').trim();
        if (!channel || !title) return res.status(400).json({ error: 'A valid channel and programme title are required.' });
        await dbRun(db, "INSERT OR IGNORE INTO dvr_series_rules (user_id, channelId, channelName, programTitle) VALUES (?, ?, ?, ?)",
            [req.session.userId, channel.id, channel.displayName || channel.name, title]);
        const rule = await dbGet(db, "SELECT * FROM dvr_series_rules WHERE user_id = ? AND channelId = ? AND programTitle = ?",
            [req.session.userId, channel.id, title]);
        const scheduled = await syncSeriesRules(rule.id);
        res.status(201).json({ success: true, rule, scheduled });
    } catch (error) {
        console.error('[DVR_SERIES] Could not create series rule:', error);
        res.status(500).json({ error: 'Could not create series recording.' });
    }
});

app.get('/api/dvr/series', requireAuth, (req, res) => {
    if (!req.session.isAdmin && !req.session.canUseDvr) return res.json([]);
    const query = req.session.isAdmin
        ? "SELECT r.*, u.username FROM dvr_series_rules r JOIN users u ON u.id = r.user_id ORDER BY r.createdAt DESC"
        : "SELECT r.* FROM dvr_series_rules r WHERE r.user_id = ? ORDER BY r.createdAt DESC";
    db.all(query, req.session.isAdmin ? [] : [req.session.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Could not load series recordings.' });
        res.json(rows);
    });
});

app.delete('/api/dvr/series/:id', requireAuth, requireDvrAccess, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const rule = await dbGet(db,
            req.session.isAdmin ? "SELECT * FROM dvr_series_rules WHERE id = ?" : "SELECT * FROM dvr_series_rules WHERE id = ? AND user_id = ?",
            req.session.isAdmin ? [id] : [id, req.session.userId]);
        if (!rule) return res.status(404).json({ error: 'Series recording not found or not authorized.' });
        const jobs = await dbAll(db, "SELECT id FROM dvr_jobs WHERE series_rule_id = ? AND status = 'scheduled'", [id]);
        for (const job of jobs) {
            if (activeDvrJobs.has(job.id)) {
                activeDvrJobs.get(job.id)?.cancel();
                activeDvrJobs.delete(job.id);
            }
            await dbRun(db, "UPDATE dvr_jobs SET status = 'cancelled' WHERE id = ?", [job.id]);
        }
        await dbRun(db, "DELETE FROM dvr_series_rules WHERE id = ?", [id]);
        res.json({ success: true, cancelled: jobs.length });
    } catch (error) {
        console.error('[DVR_SERIES] Could not delete series rule:', error);
        res.status(500).json({ error: 'Could not delete series recording.' });
    }
});

// MODIFIED: Endpoint logic to show all jobs to admin, or user's jobs to them.
app.get('/api/dvr/jobs', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        // Admins see all jobs, with username and recordedDuration if available
        const query = `
            SELECT j.*, u.username, r.durationSeconds as recordedDuration 
            FROM dvr_jobs j 
            JOIN users u ON j.user_id = u.id 
            LEFT JOIN dvr_recordings r ON r.job_id = j.id 
            ORDER BY j.startTime DESC`;
        db.all(query, [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Failed to retrieve all recording jobs.' });
            res.json(rows);
        });
    } else if (req.session.canUseDvr) {
        // Users with DVR access see only their own jobs
        const query = `
            SELECT j.*, r.durationSeconds as recordedDuration 
            FROM dvr_jobs j 
            LEFT JOIN dvr_recordings r ON r.job_id = j.id 
            WHERE j.user_id = ? 
            ORDER BY j.startTime DESC`;
        db.all(query, [req.session.userId], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Failed to retrieve your recording jobs.' });
            // Add a username to be consistent with admin view
            const jobsWithUser = rows.map(r => ({ ...r, username: req.session.username }));
            res.json(jobsWithUser);
        });
    } else {
        // Users without DVR access see an empty list of scheduled jobs
        res.json([]);
    }
});

// Completed recordings are private to their owner; admins see every user's.
app.get('/api/dvr/recordings', requireAuth, (req, res) => {
    const base = "SELECT r.*, u.username FROM dvr_recordings r JOIN users u ON r.user_id = u.id";
    const query = req.session.isAdmin
        ? `${base} ORDER BY r.startTime DESC`
        : `${base} WHERE r.user_id = ? ORDER BY r.startTime DESC`;
    const params = req.session.isAdmin ? [] : [req.session.userId];
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to retrieve recordings.' });
        const recordingsWithFilename = rows.map(({ filePath, ...r }) => ({ ...r, filename: path.basename(filePath) }));
        res.json(recordingsWithFilename);
    });
});

// Endpoint to on-demand remux a legacy .ts recording to seekable .mp4
app.post('/api/dvr/recordings/:id/remux', requireAuth, requireDvrAccess, async (req, res) => {
    const recordingId = req.params.id;
    const query = req.session.isAdmin
        ? "SELECT * FROM dvr_recordings WHERE id = ?"
        : "SELECT * FROM dvr_recordings WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [recordingId] : [recordingId, req.session.userId];
    db.get(query, params, async (err, recording) => {
        if (err || !recording) {
            return res.status(404).json({ error: 'Recording not found or not authorized.' });
        }
        if (!recording.filePath.endsWith('.ts')) {
            return res.json({ success: true, filename: path.basename(recording.filePath), alreadyMp4: true });
        }
        if (!fs.existsSync(recording.filePath)) {
            return res.status(404).json({ error: 'Recording file missing on disk.' });
        }

        console.log(`[DVR_REMUX_API] Remuxing requested for recording #${recordingId} (${recording.filePath})`);
        const remuxRes = await remuxTsToMp4(recording.filePath);
        if (!remuxRes.success) {
            return res.status(500).json({ error: 'Failed to remux recording: ' + remuxRes.error });
        }

        db.run("UPDATE dvr_recordings SET filePath = ?, fileSizeBytes = ?, durationSeconds = COALESCE(?, durationSeconds) WHERE id = ?",
            [remuxRes.mp4Path, remuxRes.fileSizeBytes, remuxRes.durationSeconds, recordingId]);
        db.run("UPDATE dvr_jobs SET filePath = ? WHERE filePath = ?", [remuxRes.mp4Path, recording.filePath]);

        const newFilename = path.basename(remuxRes.mp4Path);
        res.json({
            success: true,
            filename: newFilename,
            durationSeconds: remuxRes.durationSeconds,
            fileSizeBytes: remuxRes.fileSizeBytes
        });
    });
});


// MODIFIED: Loosened permission to requireAuth, as non-DVR users now see the DVR page.
app.get('/api/dvr/storage', requireAuth, (req, res) => {
    // Only return storage info if user has DVR access, otherwise return empty state.
    if (!req.session.canUseDvr && !req.session.isAdmin) {
        return res.json({ total: 0, used: 0, percentage: 0 });
    }
    try {
        disk.check(DVR_DIR, (err, info) => {
            if (err) {
                console.error('[DVR_STORAGE] Error checking disk usage:', err);
                return res.status(500).json({ error: 'Could not get storage information.' });
            }
            const used = info.total - info.free;
            const percentage = Math.round((used / info.total) * 100);
            res.json({
                total: info.total,
                used: used,
                percentage: percentage
            });
        });
    } catch (e) {
        console.error('[DVR_STORAGE] Unhandled error in diskusage:', e);
        res.status(500).json({ error: 'Server error checking storage.' });
    }
});

app.delete('/api/dvr/jobs/all', requireAuth, requireDvrAccess, (req, res) => {
    const userId = req.session.userId;
    console.log(`[DVR_API] Clearing all scheduled/historical jobs for user ${userId}.`);

    db.all("SELECT id FROM dvr_jobs WHERE user_id = ? AND status = 'scheduled'", [userId], (err, scheduledJobs) => {
        if (err) {
            return res.status(500).json({ error: 'Could not fetch jobs to cancel.' });
        }
        scheduledJobs.forEach(job => {
            if (activeDvrJobs.has(job.id)) {
                activeDvrJobs.get(job.id)?.cancel();
                activeDvrJobs.delete(job.id);
            }
        });

        db.run("DELETE FROM dvr_jobs WHERE user_id = ?", [userId], function (err) {
            if (err) {
                return res.status(500).json({ error: 'Could not clear jobs from database.' });
            }
            res.json({ success: true, deletedCount: this.changes });
        });
    });
});

app.delete('/api/dvr/recordings/all', requireAuth, requireDvrAccess, (req, res) => {
    const userId = req.session.userId;
    console.log(`[DVR_API] Deleting all completed recordings for user ${userId}.`);

    db.all("SELECT id, filePath FROM dvr_recordings WHERE user_id = ?", [userId], (err, recordings) => {
        if (err) {
            return res.status(500).json({ error: 'Could not fetch recordings to delete.' });
        }

        recordings.forEach(rec => {
            if (fs.existsSync(rec.filePath)) {
                fs.unlink(rec.filePath, (unlinkErr) => {
                    if (unlinkErr) console.error(`[DVR_API] Failed to delete file ${rec.filePath}:`, unlinkErr);
                });
            }
        });

        db.run("DELETE FROM dvr_recordings WHERE user_id = ?", [userId], function (err) {
            if (err) {
                return res.status(500).json({ error: 'Could not clear recordings from database.' });
            }
            res.json({ success: true, deletedCount: this.changes });
        });
    });
});


app.delete('/api/dvr/jobs/:id', requireAuth, requireDvrAccess, async (req, res) => {
    try {
        const jobId = parseInt(req.params.id, 10);
        const job = await getDvrJobForUser(jobId, req.session);
        if (!job) return res.status(404).json({ error: 'Job not found or not authorized to cancel.' });

        if (activeDvrJobs.has(jobId)) {
            activeDvrJobs.get(jobId)?.cancel();
            activeDvrJobs.delete(jobId);
        }
        if (job.status === 'scheduled') {
            await dbRun(db, "UPDATE dvr_jobs SET status = 'cancelled' WHERE id = ?", [jobId]);
        } else if (job.status === 'recording' || job.status === 'reconnecting') {
            stopRecording(jobId);
        } else {
            return res.status(400).json({ error: 'Only scheduled or active jobs can be cancelled.' });
        }
        console.log(`[DVR_API] Cancelled job ${jobId}.`);
        res.json({ success: true });
    } catch (error) {
        console.error('[DVR_API] Error cancelling job:', error);
        res.status(500).json({ error: 'Could not cancel job.' });
    }
});

app.delete('/api/dvr/recordings/:id', requireAuth, requireDvrAccess, (req, res) => {
    const { id } = req.params;
    // MODIFIED: Admin can delete any recording, user can only delete their own.
    const query = req.session.isAdmin ? "SELECT filePath FROM dvr_recordings WHERE id = ?" : "SELECT filePath FROM dvr_recordings WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [id] : [id, req.session.userId];

    db.get(query, params, (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Recording not found or not authorized.' });

        if (fs.existsSync(row.filePath)) {
            fs.unlink(row.filePath, (unlinkErr) => {
                if (unlinkErr) console.error(`[DVR_API] Failed to delete file ${row.filePath}:`, unlinkErr);
            });
        }
        db.run("DELETE FROM dvr_recordings WHERE id = ?", [id], (deleteErr) => {
            if (deleteErr) return res.status(500).json({ error: 'Failed to delete recording record.' });
            res.json({ success: true });
        });
    });
});

app.post('/api/dvr/jobs/:id/stop', requireAuth, requireDvrAccess, async (req, res) => {
    try {
        const jobId = parseInt(req.params.id, 10);
        const job = await getDvrJobForUser(jobId, req.session);
        if (!job) return res.status(404).json({ error: 'Job not found or not authorized to stop.' });
        if (job.status !== 'recording' && job.status !== 'reconnecting') {
            return res.status(400).json({ error: 'This job is not recording.' });
        }
        console.log(`[DVR_API] Received request to stop recording for job ${jobId}.`);
        if (activeDvrJobs.has(jobId)) {
            activeDvrJobs.get(jobId)?.cancel();
            activeDvrJobs.delete(jobId);
        }
        stopRecording(jobId);
        const actualEndTime = new Date().toISOString();
        await dbRun(db, "UPDATE dvr_jobs SET status = 'completed', endTime = ? WHERE id = ?", [actualEndTime, jobId]);
        broadcastDvrUpdate(job.user_id, { jobId, status: 'completed', endTime: actualEndTime });
        res.json({ success: true, endTime: actualEndTime });
    } catch (error) {
        console.error('[DVR_API] Error stopping job:', error);
        res.status(500).json({ error: 'Could not update job status after stop.' });
    }
});

app.put('/api/dvr/jobs/:id', requireAuth, requireDvrAccess, async (req, res) => {
    try {
        const { id } = req.params;
        const { startTime, endTime } = req.body;
        const dvrSettings = getSettings().dvr || {};
        const window = validateRecordingWindow(startTime, endTime, dvrSettings.maxRecordingHours);
        if (!window.ok) return res.status(400).json({ error: window.error });

        const job = await getDvrJobForUser(id, req.session);
        if (!job) return res.status(404).json({ error: 'Job not found or unauthorized.' });
        if (job.status !== 'scheduled') return res.status(400).json({ error: 'Only scheduled jobs can be modified.' });

        const startIso = new Date(window.startMs).toISOString();
        const endIso = new Date(window.endMs).toISOString();
        const updatedJob = { ...job, startTime: startIso, endTime: endIso };

        const result = await withDvrScheduleLock(async () => {
            const conflictingJobs = await checkForConflicts(updatedJob);
            if (conflictingJobs.length > 0) return { conflicts: conflictingJobs };
            await dbRun(db, "UPDATE dvr_jobs SET startTime = ?, endTime = ? WHERE id = ?", [startIso, endIso, id]);
            return { job: updatedJob };
        });
        if (result.conflicts) {
            return res.status(409).json({ error: 'Recording conflict detected.', newJob: updatedJob, conflictingJobs: conflictsForResponse(result.conflicts, req.session.isAdmin) });
        }
        scheduleDvrJob(result.job);
        console.log(`[DVR_API] Updated and rescheduled job ${id}.`);
        res.json({ success: true, job: result.job });
    } catch (error) {
        console.error('[DVR_API] Error updating job:', error);
        res.status(500).json({ error: 'Could not update job.' });
    }
});

app.delete('/api/dvr/jobs/:id/history', requireAuth, requireDvrAccess, (req, res) => {
    const { id } = req.params;
    // MODIFIED: Admin can delete any job history, user can only delete their own.
    const query = req.session.isAdmin ? "SELECT status FROM dvr_jobs WHERE id = ?" : "SELECT status FROM dvr_jobs WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [id] : [id, req.session.userId];

    db.get(query, params, (err, job) => {
        if (err || !job) {
            return res.status(404).json({ error: 'Job not found or unauthorized.' });
        }
        if (['error', 'cancelled', 'completed'].includes(job.status)) {
            db.run("DELETE FROM dvr_jobs WHERE id = ?", [id], function (err) {
                if (err) return res.status(500).json({ error: 'Could not delete job history.' });
                console.log(`[DVR_API] Deleted job history for job ${id}.`);
                res.json({ success: true });
            });
        } else {
            return res.status(400).json({ error: 'Only completed, cancelled, or error jobs can be removed from history.' });
        }
    });
});
// ... existing SSE and other endpoints ...
app.get('/api/events', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const clientId = Date.now();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!sseClients.has(userId)) {
        sseClients.set(userId, []);
    }

    const clients = sseClients.get(userId);
    //-- ENHANCEMENT: Store isAdmin status with the client for easy broadcasting.
    clients.push({ id: clientId, res, isAdmin: req.session.isAdmin });
    console.log(`[SSE] Client ${clientId} connected for user ID ${userId}. Total clients for user: ${clients.length}.`);

    res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connection established" })}\n\n`);

    req.on('close', () => {
        const userClients = sseClients.get(userId);
        if (userClients) {
            const index = userClients.findIndex(c => c.id === clientId);
            if (index !== -1) {
                userClients.splice(index, 1);
                console.log(`[SSE] Client ${clientId} disconnected for user ID ${userId}. Remaining clients for user: ${userClients.length}.`);
                if (userClients.length === 0) {
                    sseClients.delete(userId);
                }
            }
        }
    });
});

app.post('/api/validate-url', requireAuth, requireAdmin, async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required.' });
    }
    console.log(`[VALIDATE_URL] Testing URL: ${safeUrlForLog(url)}`);
    try {
        // safeGet blocks non-http(s) schemes and internal/private addresses on every redirect hop.
        const { response } = await safeGet(url, { timeout: 30000 });
        response.destroy(); // Only reachability matters; don't download the whole playlist/EPG.
        res.json({ success: true, message: 'URL is reachable and returned a successful response.' });
    } catch (error) {
        if (error instanceof SsrfBlockedError) {
            console.warn(`[VALIDATE_URL] Blocked: ${error.message}`);
            const hint = /address/.test(error.message) ? ' To allow LAN sources, set SSRF_ALLOW_PRIVATE_NETWORKS=true or list the host in SSRF_ALLOWED_HOSTS.' : '';
            return res.status(400).json({ success: false, error: `${error.message}${hint}` });
        }
        res.status(400).json({ success: false, error: `URL is not reachable. Error: ${error.message}` });
    }
});

// --- NEW: Hardware Info Endpoint ---
app.get('/api/hardware', requireAuth, (req, res) => {
    res.json(detectedHardware);
});

app.get('/api/public-ip', requireAuth, requireAdmin, (req, res) => {
    console.log('[IP_API] Fetching public IP address...');
    https.get('https://ifconfig.me/ip', (ipRes) => {
        let data = '';
        ipRes.on('data', (chunk) => {
            data += chunk;
        });
        ipRes.on('end', () => {
            res.json({ publicIp: data.trim() });
        });
    }).on('error', (err) => {
        console.error('[IP_API] Error fetching public IP:', err.message);
        res.status(500).json({ error: 'Could not fetch public IP address.' });
    });
});

// --- Image Proxy Endpoint (for VOD posters) ---
// Proxies HTTP/HTTPS images to avoid mixed content warnings
// Now with server-side disk caching for performance
// The proxy is open to every LAN device by design, so keep its disk use bounded.
let lastImageCachePrune = 0;
async function pruneImageCache() {
    if (Date.now() - lastImageCachePrune < 10 * 60 * 1000) return;
    lastImageCachePrune = Date.now();
    try {
        const entries = [];
        for (const name of await fs.promises.readdir(IMAGE_CACHE_DIR)) {
            try {
                const { mtimeMs, size } = await fs.promises.stat(path.join(IMAGE_CACHE_DIR, name));
                entries.push({ name, mtimeMs, size });
            } catch (e) { /* raced with another prune */ }
        }
        let total = entries.reduce((sum, e) => sum + e.size, 0);
        if (total <= IMAGE_CACHE_MAX_BYTES) return;
        entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const { name, size } of entries) {
            if (total <= IMAGE_CACHE_MAX_BYTES) break;
            await fs.promises.unlink(path.join(IMAGE_CACHE_DIR, name)).catch(() => { });
            total -= size;
        }
        console.log(`[IMAGE_PROXY] Cache pruned to ${Math.round(total / 1048576)} MB.`);
    } catch (err) {
        console.error('[IMAGE_PROXY] Cache prune failed:', err.message);
    }
}

app.get('/api/image-proxy', allowLocalOrAuth, (req, res) => {
    const imageUrl = req.query.url;

    if (!imageUrl) {
        return res.status(400).send('Missing url parameter');
    }

    // Validate URL scheme and IP-literal hosts up front; hostnames are re-checked at connect time.
    try {
        assertSafeUrl(imageUrl);
    } catch (err) {
        console.warn(`[IMAGE_PROXY] Blocked URL ${safeUrlForLog(imageUrl)}: ${err.message}`);
        return res.status(400).send('Invalid or disallowed URL');
    }

    // Generate a cache filename based on the URL hash
    const urlHash = crypto.createHash('sha256').update(imageUrl).digest('hex');
    const cacheFilePath = path.join(IMAGE_CACHE_DIR, urlHash);
    const cacheMetaPath = path.join(IMAGE_CACHE_DIR, `${urlHash}.meta`);

    // Check if image exists in cache
    if (fs.existsSync(cacheFilePath) && fs.existsSync(cacheMetaPath)) {
        try {
            const meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf-8'));
            const cachedType = String(meta.contentType || '').split(';')[0].trim().toLowerCase();
            if (!IMAGE_PROXY_TYPES.has(cachedType)) {
                // An old cache entry from before SVG was blocked: drop it and fetch again.
                fs.unlinkSync(cacheFilePath);
                fs.unlinkSync(cacheMetaPath);
            } else {
                // sendFile adds ETag and Last-Modified, answers If-None-Match with a 304 and handles Range.
                return res.sendFile(cacheFilePath, {
                    dotfiles: 'allow', headers: { 'Content-Type': cachedType, 'Cache-Control': IMAGE_CACHE_CONTROL, 'X-Cache': 'HIT' },
                }, (err) => {
                    if (err && err.code !== 'ECONNABORTED' && !res.headersSent) res.status(500).send('Cache read error');
                });
            }
        } catch (err) {
            console.error(`[IMAGE_PROXY] Error reading cache metadata:`, err.message);
            // Fall through to fetch fresh
        }
    }

    console.log(`[IMAGE_PROXY] Fetching and caching image: ${safeUrlForLog(imageUrl)}`);

    safeGet(imageUrl, { timeout: 15000 }).then(({ response: imageRes }) => {
        // Only raster images: SVG can execute script when opened directly.
        const mime = String(imageRes.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!IMAGE_PROXY_TYPES.has(mime)) {
            console.error(`[IMAGE_PROXY] Invalid content type: ${mime || '(none)'}`);
            imageRes.destroy();
            return res.status(400).send('URL does not point to a supported image');
        }
        const declaredLength = parseInt(imageRes.headers['content-length'], 10);
        if (declaredLength > IMAGE_PROXY_MAX_BYTES) {
            imageRes.destroy();
            return res.status(413).send('Image too large');
        }

        // Set response headers
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', IMAGE_CACHE_CONTROL);
        res.setHeader('X-Cache', 'MISS');

        // Write to a temp file and only move it into the cache once the full image arrived,
        // so a truncated or oversized download is never served from cache.
        const tempCachePath = `${cacheFilePath}.${process.pid}.${Date.now()}.tmp`;
        const fileStream = fs.createWriteStream(tempCachePath);
        let receivedBytes = 0;
        let aborted = false;

        const discardTemp = () => fs.unlink(tempCachePath, () => { });

        imageRes.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (receivedBytes > IMAGE_PROXY_MAX_BYTES && !aborted) {
                aborted = true;
                console.warn(`[IMAGE_PROXY] Image exceeded ${IMAGE_PROXY_MAX_BYTES} bytes, aborting: ${safeUrlForLog(imageUrl)}`);
                imageRes.destroy();
                fileStream.destroy();
                discardTemp();
                res.destroy();
            }
        });
        imageRes.on('error', () => {
            aborted = true;
            fileStream.destroy();
            discardTemp();
        });

        // Pipe to both cache and response
        imageRes.pipe(fileStream);
        imageRes.pipe(res);

        // Save metadata when done
        fileStream.on('finish', () => {
            if (aborted) return discardTemp();
            const meta = {
                url: imageUrl,
                contentType: mime,
                cachedAt: new Date().toISOString()
            };
            try {
                fs.renameSync(tempCachePath, cacheFilePath);
                fs.writeFileSync(cacheMetaPath, JSON.stringify(meta, null, 2));
                console.log(`[IMAGE_PROXY] Cached image: ${urlHash}`);
                pruneImageCache();
            } catch (err) {
                console.error(`[IMAGE_PROXY] Failed to write cache entry:`, err.message);
                discardTemp();
            }
        });

        fileStream.on('error', (err) => {
            console.error(`[IMAGE_PROXY] Error writing to cache:`, err.message);
            // Continue serving even if cache write fails
        });

    }).catch((err) => {
        if (err instanceof SsrfBlockedError) {
            console.warn(`[IMAGE_PROXY] Blocked ${safeUrlForLog(imageUrl)}: ${err.message}`);
            return res.status(400).send('Invalid or disallowed URL');
        }
        console.error(`[IMAGE_PROXY] Error fetching image from ${safeUrlForLog(imageUrl)}:`, err.message);
        res.status(502).send('Failed to fetch image');
    });
});


// --- Backup & Restore Endpoints ---
const settingsUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DATA_DIR),
        filename: (req, file, cb) => cb(null, 'settings.tmp.json')
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/json') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JSON is allowed.'), false);
        }
    }
});

app.get('/api/settings/export', requireAuth, requireAdmin, (req, res) => {
    if (fs.existsSync(SETTINGS_PATH)) {
        res.download(SETTINGS_PATH, 'viniplay-settings-backup.json', (err) => {
            if (err) {
                console.error('[SETTINGS_EXPORT] Error sending settings file:', err);
            }
        });
    } else {
        res.status(404).json({ error: 'Settings file not found.' });
    }
});

app.post('/api/settings/import', requireAuth, requireAdmin, settingsUpload.single('settingsFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No settings file was uploaded.' });
    }
    const tempPath = path.join(DATA_DIR, 'settings.tmp.json');
    try {
        const fileContent = fs.readFileSync(tempPath, 'utf-8');
        JSON.parse(fileContent); // Validate that it's valid JSON
        fs.renameSync(tempPath, SETTINGS_PATH);
        console.log('[SETTINGS_IMPORT] Settings file imported successfully. App will now use new settings.');
        res.json({ success: true, message: 'Settings imported. The application will use them on next load.' });
    } catch (error) {
        console.error('[SETTINGS_IMPORT] Error processing imported settings file:', error.message);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        res.status(400).json({ error: `Invalid settings file. Error: ${error.message}` });
    }
});
// --- LOG MANAGEMENT API ENDPOINTS ---

/**
 * GET /api/logs/info
 * Returns statistics about current log files.
 */
app.get('/api/logs/info', requireAuth, requireAdmin, (req, res) => {
    try {
        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'))
            .map(file => {
                const filePath = path.join(LOGS_DIR, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    mtime: stats.mtime
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        const totalSize = logFiles.reduce((sum, file) => sum + file.size, 0);
        const oldestFile = logFiles.length > 0 ? logFiles[logFiles.length - 1] : null;

        res.json({
            fileCount: logFiles.length,
            totalSize: totalSize,
            oldestDate: oldestFile ? oldestFile.mtime : null,
            files: logFiles
        });
    } catch (error) {
        console.error('[API] Error getting log info:', error);
        res.status(500).json({ error: 'Failed to get log information.' });
    }
});

/**
 * GET /api/logs/download
 * Downloads all log files combined into a single text file.
 */
app.get('/api/logs/download', requireAuth, requireAdmin, (req, res) => {
    try {
        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'))
            .map(file => ({
                name: file,
                path: path.join(LOGS_DIR, file),
                mtime: fs.statSync(path.join(LOGS_DIR, file)).mtime
            }))
            .sort((a, b) => a.mtime - b.mtime); // Sort by oldest first

        if (logFiles.length === 0) {
            return res.status(404).json({ error: 'No log files found.' });
        }

        // Combine all log files
        let combinedLogs = `ViniPlay Application Logs\n`;
        combinedLogs += `Generated: ${new Date().toISOString()}\n`;
        combinedLogs += `Total Files: ${logFiles.length}\n`;
        combinedLogs += `${'='.repeat(80)}\n\n`;

        logFiles.forEach(file => {
            combinedLogs += `\n${'='.repeat(80)}\n`;
            combinedLogs += `File: ${file.name}\n`;
            combinedLogs += `Modified: ${file.mtime.toISOString()}\n`;
            combinedLogs += `${'='.repeat(80)}\n\n`;

            try {
                const content = fs.readFileSync(file.path, 'utf-8');
                combinedLogs += content;
                combinedLogs += '\n\n';
            } catch (err) {
                combinedLogs += `[ERROR] Could not read file: ${err.message}\n\n`;
            }
        });

        const filename = `viniplay-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(combinedLogs);

        console.log(`[API] User ${req.session.userId} downloaded logs.`);
    } catch (error) {
        console.error('[API] Error downloading logs:', error);
        res.status(500).json({ error: 'Failed to download logs.' });
    }
});

/**
 * POST /api/logs/cleanup
 * Deletes all log files.
 */
app.post('/api/logs/cleanup', requireAuth, requireAdmin, (req, res) => {
    try {
        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'));

        let deletedCount = 0;
        logFiles.forEach(file => {
            try {
                fs.unlinkSync(path.join(LOGS_DIR, file));
                deletedCount++;
            } catch (err) {
                console.error(`[API] Error deleting log file ${file}:`, err);
            }
        });

        // Close current log stream and reset
        if (currentLogStream) {
            currentLogStream.end();
            currentLogStream = null;
        }
        currentLogFilePath = null;
        currentLogSize = 0;

        console.log(`[API] User ${req.session.userId} cleared ${deletedCount} log files.`);
        res.json({ success: true, deletedCount });
    } catch (error) {
        console.error('[API] Error cleaning up logs:', error);
        res.status(500).json({ error: 'Failed to cleanup logs.' });
    }
});

/**
 * POST /api/logs/client
 * Ingestion endpoint for client-side debug telemetry (mobile & desktop).
 * Accepts JSON or text beacons and writes them directly into the server log stream.
 */
app.post('/api/logs/client', requireAuth, express.text({ type: ['text/*', 'application/json'] }), (req, res) => {
    try {
        let payload = req.body;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) {}
        }
        if (!payload || typeof payload !== 'object') {
            return res.sendStatus(204);
        }

        const deviceId = payload.deviceId || 'unknown';
        const logs = Array.isArray(payload.logs) ? payload.logs : (payload.entry ? [payload.entry] : []);

        logs.forEach(entry => {
            const tag = entry.tag || 'CLIENT';
            const msg = entry.message || '';
            const meta = entry.data ? ` | ${typeof entry.data === 'object' ? JSON.stringify(entry.data) : entry.data}` : '';
            // One line per entry: a newline from the browser must not forge a log record.
            console.log(String(`[CLIENT:${deviceId}] [${tag}] ${msg}${meta}`).replace(/[\r\n]+/g, ' '));
        });

        res.sendStatus(204);
    } catch (e) {
        console.error('[CLIENT_TELEMETRY] Error logging client telemetry:', e.message);
        res.sendStatus(204);
    }
});

// --- Main Route Handling ---
// Unknown API paths must not fall through to the SPA and look like a successful HTML 200.
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
});

// Everything real is already served by express.static above. This only handles client-side
// routes; building a path from req.path here let `..` read files outside public/.
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Last-resort error handler: keep stack traces and SQL messages out of responses, and give
// multer/body-parser failures a JSON status instead of the default HTML page.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Upload failed.' });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid JSON body.' });
    console.error('[SERVER_ERROR]', err);
    res.status(500).json({ error: 'Internal server error.' });
});

// --- Server Start ---
// NEW: Run hardware detection before starting the server
detectHardwareAcceleration().then(() => {
    app.listen(port, () => {
        console.log(`\n======================================================`);
        console.log(` VINI PLAY server listening at http://localhost:${port}`);
        console.log(`======================================================\n`);

        runSourceProcessing(null, undefined, true).then((result) => {
            console.log('[INIT] Initial source processing complete.');
            saveProcessedSettings(result.updatedSettings);
            if (!result.success) console.warn(`[INIT] ${result.message}`);
            updateAndScheduleSourceRefreshes();
            syncSeriesRules().catch((e) => console.error('[DVR_SERIES] Startup sync failed:', e.message));
        }).catch(error => console.error('[INIT] Initial source processing failed:', error.message));

        if (notificationCheckInterval) clearInterval(notificationCheckInterval);
        notificationCheckInterval = setInterval(checkAndSendNotifications, 60000);
        console.log('[Push] Notification checker started.');

        setInterval(cleanupInactiveStreams, 60000);
        console.log('[JANITOR] Inactive stream cleanup process started.');

        schedule.scheduleJob('0 2 * * *', async () => {
            try {
                await autoDeleteOldRecordings();
                await enforceRecordingSizeLimit();
                await syncSeriesRules();
            } catch (e) {
                console.error('[DVR_STORAGE] Daily maintenance failed:', e.message);
            }
        });
        schedule.scheduleJob('15 */6 * * *', () => syncSeriesRules().catch((e) => console.error('[DVR_SERIES] Sync failed:', e.message)));
        console.log('[DVR_STORAGE] Scheduled daily cleanup and series-rule sync.');

        // stream_history and notifications were never pruned. Set STREAM_HISTORY_RETENTION_DAYS=0 to keep history forever.
        schedule.scheduleJob('15 2 * * *', () => {
            const cutoff = (days) => new Date(Date.now() - days * 86400000).toISOString();
            const onError = (err) => { if (err) console.error('[DB] Nightly prune failed:', err.message); };
            const historyDays = parseInt(process.env.STREAM_HISTORY_RETENTION_DAYS ?? '90', 10);
            if (historyDays > 0) db.run('DELETE FROM stream_history WHERE start_time < ?', [cutoff(historyDays)], onError);
            db.run('DELETE FROM notifications WHERE notificationTime < ?', [cutoff(30)], onError); // their deliveries go with them
        });

        // Keep the query planner's statistics fresh (cheap; only re-analyzes tables that changed a lot).
        schedule.scheduleJob('30 2 * * *', () => db.run('PRAGMA optimize'));


    });
});

// --- Helper Functions (Full Implementation) ---
