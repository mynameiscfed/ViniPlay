// epgMerge.js
// The CPU-heavy half of the guide refresh: scan every guide for its channels, match them to the playlist,
// parse the programmes and write epg.json. It runs in a worker thread so a multi-minute parse cannot stall
// streams or SSE on the main thread, and the memory it takes (the whole merged guide) goes back to the OS
// when the worker exits.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { openMaybeGzip } = require('./compressedFile');
const { forEachProgramme, forEachChannel } = require('./epgStream');
const { buildTargets } = require('./epgMatch');
const { parseEpgTime } = require('./epgTime');
const { writeFileAtomic } = require('./fileStore');

const HEAP_MB = Number(process.env.VINIPLAY_EPG_HEAP_MB) || 2048;

/**
 * @param {object} job
 * @param {{id: string, name: string, file: string}[]} job.sources Guides already on disk.
 * @param {Map} job.liveChannels prefixed channel id -> {originalId, name, ...}
 * @param {{status: (message: string, type?: string) => void, log: (message: string) => void}} out
 * @returns {Promise<{sources: Object<string, {error?: string, programCount?: number, epgAddedCount?: number}>}>}
 */
async function runEpgMerge({ sources, liveChannels, overrides, timeZone, offsetHours, epgPath, channelsPath }, out) {
    const results = {};
    const readable = [];

    // Pass 1: list the channels each guide declares, so channels can be matched by name.
    const epgChannels = new Map(); // XMLTV channel id -> {id, names}, across all guides
    const syntheticChannelIds = new Set(); // guide channels whose <channel id=""> had to be synthesized from the name
    for (const source of sources) {
        try {
            await forEachChannel(openMaybeGzip(source.file), ({ id, names, synthetic }) => {
                if (synthetic) syntheticChannelIds.add(id);
                const known = epgChannels.get(id);
                epgChannels.set(id, { id, names: known ? [...new Set([...known.names, ...names])] : names });
            });
            readable.push(source);
        } catch (error) {
            results[source.id] = { error: error.message };
        }
    }

    // Which playlist channels each XMLTV channel feeds: manual overrides, then exact ids, then unambiguous names.
    const targets = buildTargets({ channels: liveChannels, overrides, epgChannels: [...epgChannels.values()] });
    if (syntheticChannelIds.size) {
        out.status(`Warning: ${syntheticChannelIds.size} guide channels had an empty channel id and were matched by name only.`, 'info');
    }
    const sample = new Map(); // XMLTV channel id -> one programme title, so the picker can show what a channel airs
    const titleOf = (prog) => (prog.title && prog.title._cdata ? prog.title._cdata : (prog.title?._text || 'No Title')).trim();
    const mergedProgramData = {};

    // Pass 2: programmes, for the channels that have a target.
    for (const source of readable) {
        try {
            let programCount = 0;
            let epgAddedCount = 0; // programmes added to the live guide (one per target channel)

            await forEachProgramme(openMaybeGzip(source.file), (prog) => {
                const channelId = prog._attributes?.channel;
                if (!channelId) return;
                programCount++;
                if (!sample.has(channelId)) sample.set(channelId, titleOf(prog));
                const ids = targets.get(channelId);
                if (!ids) return;

                const descNode = prog.desc && prog.desc._cdata ? prog.desc._cdata : (prog.desc?._text || '');
                const entry = {
                    start: parseEpgTime(prog._attributes.start, { timeZone, offsetHours }).toISOString(),
                    stop: parseEpgTime(prog._attributes.stop, { timeZone, offsetHours }).toISOString(),
                    title: titleOf(prog),
                    desc: descNode.trim()
                };
                for (const id of ids) {
                    (mergedProgramData[id] ||= []).push(entry);
                    epgAddedCount++;
                }
            });
            results[source.id] = { programCount, epgAddedCount };
        } catch (error) {
            results[source.id] = { error: error.message };
        }
    }
    // ISO timestamps sort as strings; comparing Dates would allocate two per comparison.
    for (const channelId in mergedProgramData) {
        mergedProgramData[channelId].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    }
    try {
        writeFileAtomic(epgPath, JSON.stringify(mergedProgramData));
        out.log(`[EPG] Merged EPG JSON content saved to ${epgPath}.`);
        out.status('Successfully merged all EPG data for live channels.', 'success');
    } catch (writeErr) {
        out.log(`[EPG] Error writing merged EPG JSON file: ${writeErr.message}`);
        out.status(`Error writing merged EPG JSON file: ${writeErr.message}`, 'error');
    }
    try { // What the guides offer, for the manual EPG picker
        writeFileAtomic(channelsPath, JSON.stringify([...epgChannels.values()].map(c => ({ ...c, sample: sample.get(c.id) }))));
    } catch (writeErr) {
        out.log(`[EPG] Error writing EPG channel index: ${writeErr.message}`);
    }
    return { sources: results };
}

/** Same as runEpgMerge, on a worker thread. Rejects if the worker crashes or runs out of memory (the old files stay). */
function mergeEpgInWorker(job, out) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: HEAP_MB } });
        let settled = false;
        const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
        worker.on('message', (m) => {
            if (m.type === 'status') out.status(m.message, m.level);
            else if (m.type === 'log') out.log(m.message);
            else if (m.type === 'done') settle(resolve, m.result);
        });
        worker.on('error', (err) => settle(reject, err));
        worker.on('exit', (code) => settle(reject, new Error(`EPG worker exited with code ${code} before finishing.`)));
    });
}

if (!isMainThread && workerData?.sources) {
    const post = (m) => parentPort.postMessage(m);
    runEpgMerge(workerData, {
        status: (message, level) => post({ type: 'status', message, level }),
        log: (message) => post({ type: 'log', message }),
    }).then((result) => post({ type: 'done', result }), (err) => { throw err; });
}

module.exports = { runEpgMerge, mergeEpgInWorker };
