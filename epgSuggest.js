// epgSuggest.js
// Pending EPG match suggestions and the background job that produces them. Pure wiring: the file and the
// model are injected, so both test without a server. Suggestions persist so a refresh or restart loses
// nothing, and a re-run skips channels that already have one (no double AI billing).

/** File-backed map channelId -> suggestion. read() returns the file text (undefined while missing). */
function createSuggestStore(read, write) {
    const parse = () => {
        try { return JSON.parse(read() || '{}') || {}; }
        catch (e) { console.error('[EPG] Bad suggestions file, starting over:', e.message); return {}; }
    };
    return {
        all: () => Object.values(parse()),
        merge(items) { const s = parse(); for (const it of items) s[it.channelId] = it; write(JSON.stringify(s)); },
        remove(ids) { const s = parse(); let changed = false; for (const id of ids) if (id in s) { delete s[id]; changed = true; } if (changed) write(JSON.stringify(s)); },
    };
}

/**
 * Suggestions for one chunk of channels ({id, name, group}). With `withAi`, channels the name match is not
 * confident about go to the model. Returns the chunk's suggestions; a failed AI call fails only this chunk.
 */
async function suggestChunk(items, { suggestName, bestOf, pickWithLlm, withAi, apiKey, model, CONFIDENT, AI_CONFIDENCE }) {
    const suggestions = {}; // channel id -> suggestion
    const ask = []; // for the model
    for (const { id, name, group } of items) {
        const best = bestOf(suggestName, name);
        if (best) {
            suggestions[id] = { channelId: id, epgId: best.id, names: best.names, sample: best.sample, confidence: best.confidence, confident: best.confidence >= CONFIDENT, via: 'name' };
        }
        const candidates = suggestName(name, 10);
        if (withAi && candidates.length && !suggestions[id]?.confident) ask.push({ id, name, group, candidates });
    }
    let failed = 0;
    if (withAi && ask.length) {
        try {
            const picks = await pickWithLlm(ask, { apiKey, model });
            ask.forEach(({ id, candidates }, i) => {
                const pick = picks[i];
                if (pick === undefined) return; // no usable answer: keep the name-based suggestion
                const found = candidates.find((c) => c.id === pick);
                if (found) {
                    suggestions[id] = { channelId: id, epgId: found.id, names: found.names, sample: found.sample, confidence: AI_CONFIDENCE, confident: false, via: 'ai' };
                } else if (suggestions[id]) {
                    // The model judged none to be the same channel: demote the name suggestion, don't drop it.
                    suggestions[id] = { ...suggestions[id], confident: false, aiDisagreed: true };
                }
            });
        } catch (e) {
            return { suggestions, error: e.message, failed: ask.length };
        }
    }
    return { suggestions, failed };
}

/** Runs `processChunk` over every chunk with bounded concurrency, persisting each chunk as it lands. */
async function runMatchJob({ chunks, processChunk, persist, onProgress, concurrency = 4 }) {
    const pending = [...chunks];
    const total = pending.length;
    let suggested = 0;
    let failed = 0;
    let done = 0;
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
        for (;;) {
            const chunk = pending.shift();
            if (!chunk) return;
            let suggestions = {};
            let f = 0;
            try {
                ({ suggestions, failed: f } = await processChunk(chunk));
            } catch (e) {
                console.error('[EPG] Match chunk failed:', e.message);
                f = chunk.length;
            }
            const list = Object.values(suggestions);
            if (list.length) { try { persist(list); } catch (e) { console.error('[EPG] Persisting suggestions failed:', e.message); } }
            suggested += list.length;
            failed += f || 0;
            done += 1;
            onProgress?.({ done, total, suggested, failed });
        }
    });
    await Promise.all(workers);
    return { done, total, suggested, failed };
}

module.exports = { createSuggestStore, suggestChunk, runMatchJob };