// dbTransaction.js
// Multi-statement transactions on a connection of their own.
//
// The app shares a single node-sqlite3 connection, and node-sqlite3 hands statements to the
// SQLite thread as they arrive. A handler that ran BEGIN ... await ... COMMIT therefore had
// every other request's statements land inside its transaction, and a second handler's BEGIN
// failed with "cannot start a transaction within a transaction" and then rolled the first
// one back in its catch. Transactions now run here instead: one dedicated connection, one
// transaction at a time, and ROLLBACK only when BEGIN succeeded.
//
// With WAL (see dbConfig.js) readers and the main connection keep working while a
// transaction is open; a competing write waits on the busy timeout, so keep transactions
// short (batch big imports into a transaction per few thousand rows).

const sqlite3 = require('sqlite3');
const { configureConnection } = require('./dbConfig');

const run = (conn, sql, params = []) => new Promise((resolve, reject) => {
    conn.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this); // { lastID, changes }
    });
});

const all = (conn, sql, params = []) => new Promise((resolve, reject) => {
    conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const get = (conn, sql, params = []) => new Promise((resolve, reject) => {
    conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

function openConnection(dbPath, label) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            // The main connection owns the journal mode; this one only reports it.
            configureConnection(conn, { label, setJournalMode: false }).then(() => resolve(conn), reject);
        });
    });
}

/**
 * @param {() => Promise<sqlite3.Database>} openConn Opens (and configures) the dedicated
 *   connection. Called lazily, on first use, and again after a failed attempt.
 */
function createTransactionRunner(openConn) {
    let connPromise = null;
    let tail = Promise.resolve();

    const getConn = () => {
        if (!connPromise) {
            connPromise = Promise.resolve().then(openConn).catch((err) => {
                connPromise = null;
                throw err;
            });
        }
        return connPromise;
    };

    /**
     * Runs fn(conn) inside BEGIN IMMEDIATE ... COMMIT, one transaction at a time, and rolls
     * back if fn throws. fn must use the conn it is given (not the shared db) and must not
     * call withTransaction itself, since it would wait on its own transaction.
     */
    function withTransaction(fn) {
        const task = tail.then(async () => {
            const conn = await getConn();
            await run(conn, 'BEGIN IMMEDIATE');
            try {
                const result = await fn(conn);
                await run(conn, 'COMMIT');
                return result;
            } catch (err) {
                try {
                    await run(conn, 'ROLLBACK');
                } catch (rollbackErr) {
                    console.error(`[DB] ROLLBACK failed after "${err.message}": ${rollbackErr.message}`);
                }
                throw err;
            }
        });
        tail = task.catch(() => { });
        return task;
    }

    function close() {
        const pending = connPromise;
        connPromise = null;
        if (!pending) return Promise.resolve();
        return pending.then((conn) => new Promise((resolve) => conn.close(() => resolve())), () => { });
    }

    return { withTransaction, close };
}

module.exports = { createTransactionRunner, openConnection, run, all, get };
