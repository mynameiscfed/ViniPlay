// processedSettings.js
// processAndMergeSources works on a copy of the settings taken when it started and can run for minutes.
// Writing that copy back would undo whatever was edited meanwhile (a source added, changed or deleted),
// so only what processing produced is applied to the settings as they are now.

const OWNED = ['status', 'statusMessage', 'lastUpdated', 'cachedRawPath'];

// Returns `current` with the processing results of the active sources in `processed` applied.
function applyProcessed(current, processed) {
    for (const kind of ['m3uSources', 'epgSources']) {
        for (const done of processed[kind].filter((s) => s.isActive)) {
            const source = current[kind].find((s) => s.id === done.id);
            if (!source || source.path !== done.path) continue; // deleted or re-pointed meanwhile: the result describes something else
            for (const field of OWNED) {
                if (field in done) source[field] = done[field]; else delete source[field];
            }
        }
    }
    current.sourcesLastUpdated = processed.sourcesLastUpdated;
    return current;
}

module.exports = { applyProcessed };
