// epgMatch.js
// Decides which XMLTV channel feeds which playlist channel. Pure functions, no I/O.
// Precedence per channel: manual override > exact tvg-id > unambiguous name match. Fuzzy matches only ever
// become suggestions (createSuggester): a wrong guess on screen is cheap, a wrong silent assignment is not.

const MIN_CONFIDENCE = 0.3; // below this a suggestion is noise

// Playlist providers decorate names; none of these tell two channels apart.
const NOISE = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', 'hevc', 'h264', 'h265', 'raw', '50fps', '60fps', 'backup']);

/** "US: ESPN HD [Backup]" -> "espn". Spaces kept, for fuzzy search. */
function normalizeName(s) {
    return String(s ?? '')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[[(].*?[\])]/g, ' ')
        .replace(/^\s*[a-z]{2,3}\s*(?::|\||\s-\s)\s*/, '') // "US:" "UK |" "FR - " country/provider prefix; not "BBC-One"
        .replace(/&/g, ' and ')
        .split(/[^a-z0-9]+/).filter((t) => t && !NOISE.has(t)).join(' ');
}

/** Spaces dropped too, so "ESPN 2" equals "ESPN2". */
const nameKey = (s) => normalizeName(s).replace(/ /g, '');

/**
 * @param {Map<string,{originalId:string,name:string}>} channels playlist channels by their prefixed id
 * @param {Object<string,string>} overrides channel id -> XMLTV channel id (manual)
 * @param {{id:string,names:string[]}[]} epgChannels what the guides declare
 * @returns {Map<string,string[]>} XMLTV channel id -> playlist channel ids that take its programmes
 */
function buildTargets({ channels, overrides = {}, epgChannels }) {
    const epgIds = new Set(epgChannels.map((c) => c.id));
    const idsByName = new Map();
    for (const { id, names } of epgChannels) {
        for (const n of names) {
            const key = nameKey(n);
            if (key) idsByName.set(key, (idsByName.get(key) || new Set()).add(id));
        }
    }
    const targets = new Map();
    const add = (xmltvId, channelId) => targets.set(xmltvId, [...(targets.get(xmltvId) || []), channelId]);
    for (const [id, { originalId, name }] of channels) {
        if (overrides[id]) { add(overrides[id], id); continue; }
        add(originalId, id);
        if (epgIds.has(originalId)) continue;
        const hits = idsByName.get(nameKey(name));
        if (hits?.size === 1) add([...hits][0], id); // several candidates: leave it for the user to pick
    }
    return targets;
}

const gramsOf = (key) => {
    const padded = `$${key}$`;
    const grams = new Set();
    for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
    return grams;
};

/**
 * Fuzzy search over the guide's channels, ranked by how many 3-letter chunks the names share (Dice score).
 * Build once, call per channel. Only names sharing a chunk with the query are touched, so a search stays
 * in milliseconds on a guide of tens of thousands of channels (Fuse.js took ~0.4 s per search at 15k).
 */
function createSuggester(epgChannels) {
    const entries = []; // one per searchable name of a channel: {channel, size}
    const postings = new Map(); // chunk -> entries containing it
    for (const channel of epgChannels) {
        const keys = new Set([...channel.names, channel.id.replace(/\.[a-z]{2,3}$/i, '')].map(nameKey).filter(Boolean));
        for (const key of keys) {
            const grams = gramsOf(key);
            const entry = entries.push({ channel, size: grams.size }) - 1;
            for (const g of grams) { const list = postings.get(g); if (list) list.push(entry); else postings.set(g, [entry]); }
        }
    }
    /** @returns {{id:string,names:string[],sample?:string,confidence:number}[]} best first, confidence 0..1 */
    return (name, k = 10) => {
        const key = nameKey(name);
        if (!key) return [];
        const query = gramsOf(key);
        const shared = new Map();
        for (const g of query) for (const entry of postings.get(g) || []) shared.set(entry, (shared.get(entry) || 0) + 1);
        const best = new Map(); // channel -> its best score
        for (const [entry, count] of shared) {
            const { channel, size } = entries[entry];
            const score = (2 * count) / (query.size + size);
            if (score >= MIN_CONFIDENCE && score > (best.get(channel) || 0)) best.set(channel, score);
        }
        return [...best].sort((a, b) => b[1] - a[1]).slice(0, k).map(([channel, score]) => ({ ...channel, confidence: +score.toFixed(3) }));
    };
}

/** Top suggestion, demoted when the runner-up is nearly as good: bulk "accept all" must not take coin flips. */
function bestMatch(suggest, name) {
    const [best, second] = suggest(name, 2);
    if (!best) return null;
    return second && best.confidence - second.confidence < 0.05 ? { ...best, confidence: best.confidence - 0.2 } : best;
}

module.exports = { normalizeName, nameKey, buildTargets, createSuggester, bestMatch };
