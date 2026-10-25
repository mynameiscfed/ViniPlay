// Shared setup for the VOD tests: a real SQLite file with the VOD tables as server.js creates them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { configureConnection } = require('../../dbConfig');
const { createTransactionRunner, openConnection, all, get, run } = require('../../dbTransaction');

// Keep in step with the CREATE TABLE statements in server.js.
const VOD_SCHEMA = `
CREATE TABLE movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, year INTEGER, description TEXT, logo TEXT,
    tmdb_id TEXT, imdb_id TEXT, category_name TEXT, provider_unique_id TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE series (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, year INTEGER, description TEXT, logo TEXT,
    tmdb_id TEXT, imdb_id TEXT, category_name TEXT, provider_unique_id TEXT UNIQUE, director TEXT, cast TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL, season_num INTEGER NOT NULL,
    episode_num INTEGER NOT NULL, name TEXT, description TEXT, air_date TEXT, duration TEXT, duration_secs INTEGER,
    tmdb_id TEXT, imdb_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE);
CREATE TABLE vod_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, category_id TEXT UNIQUE NOT NULL, category_name TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE provider_movie_relations (
    provider_id TEXT NOT NULL, movie_id INTEGER NOT NULL, stream_id TEXT NOT NULL, container_extension TEXT,
    last_seen TEXT NOT NULL, FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
    PRIMARY KEY (provider_id, stream_id));
CREATE TABLE provider_series_relations (
    provider_id TEXT NOT NULL, series_id INTEGER NOT NULL, external_series_id TEXT NOT NULL, last_seen TEXT NOT NULL,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE, PRIMARY KEY (provider_id, external_series_id));
CREATE TABLE provider_episode_relations (
    provider_id TEXT NOT NULL, episode_id INTEGER NOT NULL, provider_stream_id TEXT NOT NULL,
    container_extension TEXT, last_seen TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE, PRIMARY KEY (provider_id, episode_id));
`;

const tmpDbPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viniplay-vod-')), 'test.db');

// Opens a main connection the way server.js does (WAL, tuned) plus a transaction runner on the same file.
async function openVodDb({ schema = VOD_SCHEMA } = {}) {
    const file = tmpDbPath();
    const db = await new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(conn)));
    });
    await configureConnection(db, { label: 'test-main' });
    if (schema) await new Promise((resolve, reject) => db.exec(schema, (err) => (err ? reject(err) : resolve())));
    const runner = createTransactionRunner(() => openConnection(file, 'test-tx'));
    return {
        file,
        db,
        withTransaction: runner.withTransaction,
        all: (sql, params) => all(db, sql, params),
        get: (sql, params) => get(db, sql, params),
        run: (sql, params) => run(db, sql, params),
        async close() {
            await runner.close();
            await new Promise((resolve) => db.close(resolve));
        },
    };
}

module.exports = { openVodDb, VOD_SCHEMA, tmpDbPath };
