// fileStore.js
// Helpers for the files under DATA_DIR (settings.json, the merged M3U and EPG).
const fs = require('fs');

// Returns a reader for `file` that parses it once and hands back the same result until the file changes
// (mtime or size), or undefined while it does not exist. Callers share the result, so they must not modify it.
// shortcut: a rewrite that keeps both mtime and size is not noticed, upgrade to a content hash if a writer ever does that.
function cachedFile(file, parse) {
    let stamp;
    let value;
    return () => {
        let stat;
        try {
            stat = fs.statSync(file);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            stamp = value = undefined;
            return undefined;
        }
        const current = `${stat.mtimeMs}:${stat.size}`;
        if (current !== stamp) {
            value = parse(fs.readFileSync(file, 'utf-8'));
            stamp = current;
        }
        return value;
    };
}

// Readers see the old file or the new one, never half of it, and a crash cannot leave a truncated file behind.
// `mode` (e.g. 0o600 for a secret) is set when the file is created, so it is never readable by others, not even briefly.
function writeFileAtomic(file, data, mode) {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, data, mode === undefined ? undefined : { mode });
    fs.renameSync(temp, file);
}

module.exports = { cachedFile, writeFileAtomic };
