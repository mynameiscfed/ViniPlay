// dbConfig.js
// Connection tuning and secondary indexes for the SQLite database.

// WAL is the default: readers no longer block the writer and a commit no longer costs
// a full fsync. Set SQLITE_JOURNAL_MODE=DELETE if /data lives on a network share
// (NFS/SMB), where WAL's shared-memory file is not reliable.
const ALLOWED_JOURNAL_MODES = ['WAL', 'DELETE', 'TRUNCATE', 'PERSIST'];
const BUSY_TIMEOUT_MS = 5000;
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const JOURNAL_MODE_ATTEMPTS = 3;
// SQLITE_FOREIGN_KEYS=off turns foreign key enforcement off, in case something relies on a dangling reference.
const FOREIGN_KEYS_OFF = /^(0|off|false|no)$/i;

function resolveJournalMode(raw = process.env.SQLITE_JOURNAL_MODE) {
    const mode = String(raw || 'WAL').trim().toUpperCase();
    if (ALLOWED_JOURNAL_MODES.includes(mode)) return mode;
    console.warn(`[DB] Ignoring unsupported SQLITE_JOURNAL_MODE "${raw}". Using WAL. Allowed: ${ALLOWED_JOURNAL_MODES.join(', ')}.`);
    return 'WAL';
}

const pragmaGet = (conn, sql) => new Promise((resolve, reject) => {
    conn.get(sql, (err, row) => (err ? reject(err) : resolve(row)));
});

const pragmaExec = (conn, sql) => new Promise((resolve, reject) => {
    conn.exec(sql, (err) => (err ? reject(err) : resolve()));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyJournalMode(conn, label, requested) {
    let lastError = null;
    for (let attempt = 1; attempt <= JOURNAL_MODE_ATTEMPTS; attempt++) {
        try {
            const row = await pragmaGet(conn, `PRAGMA journal_mode=${requested}`);
            return String(row && row.journal_mode).toLowerCase();
        } catch (err) {
            // Switching modes needs a moment with no other connection mid-transaction (the
            // session store creates its table at boot), so retry instead of giving up.
            lastError = err;
            if (attempt < JOURNAL_MODE_ATTEMPTS) await sleep(1000);
        }
    }
    console.warn(`[DB] (${label}) Could not switch journal mode to ${requested}: ${lastError && lastError.message}. Continuing with the current mode.`);
    const row = await pragmaGet(conn, 'PRAGMA journal_mode').catch(() => null);
    return String((row && row.journal_mode) || 'unknown').toLowerCase();
}

/**
 * Applies busy timeout and PRAGMAs to a connection. Resolves to the journal mode in effect.
 * The journal mode is a property of the database file, so only one connection needs to set
 * it (setJournalMode); the others just report it.
 * synchronous=NORMAL is only safe together with WAL, so it is applied only when WAL is active.
 */
async function configureConnection(conn, { label = 'db', setJournalMode = true, tuneCache = true } = {}) {
    conn.configure('busyTimeout', BUSY_TIMEOUT_MS);
    let mode = 'unknown';
    try {
        if (setJournalMode) {
            mode = await applyJournalMode(conn, label, resolveJournalMode());
        } else {
            const row = await pragmaGet(conn, 'PRAGMA journal_mode');
            mode = String(row.journal_mode).toLowerCase();
        }
        if (mode === 'wal') {
            await pragmaExec(conn, `PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES};`);
        }
        // ON DELETE CASCADE / SET NULL in the schema only work with this on (SQLite defaults to off).
        await pragmaExec(conn, `PRAGMA foreign_keys=${FOREIGN_KEYS_OFF.test(process.env.SQLITE_FOREIGN_KEYS || '') ? 'OFF' : 'ON'}`);
        if (tuneCache) {
            // 32 MiB page cache; temp b-trees (ORDER BY, DISTINCT) stay in memory.
            await pragmaExec(conn, 'PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;');
        }
        console.log(`[DB] (${label}) Configured connection. journal_mode=${mode}, busy_timeout=${BUSY_TIMEOUT_MS}ms.`);
    } catch (err) {
        console.warn(`[DB] (${label}) Could not apply connection settings: ${err.message}`);
    }
    return mode;
}

// Secondary indexes. Every statement is idempotent, so this runs on each boot.
// Only PRIMARY KEY / UNIQUE constraints created implicit indexes before these.
const INDEX_DDL = [
    // VOD: lookups by the "child" column (also what ON DELETE CASCADE needs)
    'CREATE INDEX IF NOT EXISTS ix_pmr_movie ON provider_movie_relations(movie_id)',
    'CREATE INDEX IF NOT EXISTS ix_psr_series ON provider_series_relations(series_id)',
    'CREATE INDEX IF NOT EXISTS ix_per_episode ON provider_episode_relations(episode_id)',
    // episodes(series_id, season_num, episode_num) is a UNIQUE index created by vodStore.ready()
    // Admin activity history: ORDER BY / range filters on start_time
    'CREATE INDEX IF NOT EXISTS ix_stream_history_start ON stream_history(start_time)',
    // Notifications and the 60 s delivery checker
    'CREATE INDEX IF NOT EXISTS ix_notif_user_time ON notifications(user_id, notificationTime)',
    'CREATE INDEX IF NOT EXISTS ix_notif_time ON notifications(notificationTime)',
    'CREATE INDEX IF NOT EXISTS ix_deliv_notif ON notification_deliveries(notification_id, status)',
    'CREATE INDEX IF NOT EXISTS ix_deliv_sub ON notification_deliveries(subscription_id)',
    "CREATE INDEX IF NOT EXISTS ix_deliv_pending ON notification_deliveries(status) WHERE status = 'pending'",
    'CREATE INDEX IF NOT EXISTS ix_push_subs_user ON push_subscriptions(user_id)',
    // DVR
    'CREATE INDEX IF NOT EXISTS ix_dvr_jobs_user_status ON dvr_jobs(user_id, status)',
    'CREATE INDEX IF NOT EXISTS ix_dvr_jobs_status ON dvr_jobs(status)',
    'CREATE INDEX IF NOT EXISTS ix_dvr_rec_job ON dvr_recordings(job_id)',
    'CREATE INDEX IF NOT EXISTS ix_dvr_rec_user_start ON dvr_recordings(user_id, startTime)',
    // Multi-view
    'CREATE INDEX IF NOT EXISTS ix_multiview_user ON multiview_layouts(user_id)',
];

// Foreign keys were never enforced, so rows whose parent is gone piled up (a deleted user's push
// subscriptions kept receiving reminders). Idempotent; run at boot, children of children last.
const ORPHAN_CLEANUP_SQL = [
    ...['user_settings', 'multiview_layouts', 'notifications', 'push_subscriptions', 'dvr_jobs', 'dvr_recordings', 'watch_progress']
        .map((table) => `DELETE FROM ${table} WHERE user_id NOT IN (SELECT id FROM users)`),
    'DELETE FROM notification_deliveries WHERE notification_id NOT IN (SELECT id FROM notifications) OR subscription_id NOT IN (SELECT id FROM push_subscriptions)',
    'UPDATE dvr_recordings SET job_id = NULL WHERE job_id IS NOT NULL AND job_id NOT IN (SELECT id FROM dvr_jobs)',
    'DELETE FROM provider_movie_relations WHERE movie_id NOT IN (SELECT id FROM movies)',
    'DELETE FROM provider_series_relations WHERE series_id NOT IN (SELECT id FROM series)',
    'DELETE FROM episodes WHERE series_id NOT IN (SELECT id FROM series)',
    'DELETE FROM provider_episode_relations WHERE episode_id NOT IN (SELECT id FROM episodes)',
];

module.exports = { configureConnection, resolveJournalMode, INDEX_DDL, ORPHAN_CLEANUP_SQL, BUSY_TIMEOUT_MS };
