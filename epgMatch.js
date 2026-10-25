// epgMatch.js
// Decides which XMLTV channel feeds which playlist channel. Pure functions, no I/O.
// Precedence per channel: manual override > exact tvg-id > unambiguous name match. Fuzzy matches only ever
// become suggestions (createSuggester): a wrong guess on screen is cheap, a wrong silent assignment is not.

const MIN_CONFIDENCE = 0.3; // below this a suggestion is noise
const CONFIDENT = 0.9; // at or above this a suggestion may be accepted in bulk

// Playlist providers decorate names; none of these tell two channels apart.
const NOISE = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', 'hevc', 'h264', 'h265', 'raw', '50fps', '60fps', 'backup', 'tnt', 'ondemand']);

// Leading country/provider/category codes, dropped only while a real name still follows. A whitelist, not a
// rule: stripping any 2-3 letters would mangle names like "BBC - One".
// shortcut: extends for feeds we see; a pattern heuristic is deliberately avoided here.
const PREFIXES = new Set([
    'us', 'uk', 'fr', 'de', 'es', 'it', 'nl', 'pt', 'se', 'no', 'dk', 'fi', 'ro', 'pl', 'tr', 'gr', 'at', 'ch', 'be', 'ru', 'ua', 'cz', 'hu', 'bg', 'rs', 'hr', 'ba', 'mk',
    'ae', 'sa', 'qa', 'eg', 'egy', 'ma', 'dz', 'tn', 'ly', 'sd', 'iq', 'jo', 'lb', 'sy', 'ye', 'om', 'kw', 'bh', 'so', 'mr', 'ps',
    'in', 'pk', 'bd', 'lk', 'id', 'my', 'sg', 'th', 'vn', 'ph', 'jp', 'kr', 'cn', 'tw', 'hk', 'af', 'ir',
    'ca', 'mx', 'br', 'ar', 'cl', 'co', 'pe', 've', 'ec', 'uy', 'py', 'bo', 'cr', 'pa', 'do', 'hn', 'gt', 'sv', 'ni', 'pr', 'cu',
    'au', 'nz', 'za', 'ng', 'gh', 'ke', 'et', 'tz', 'ug', 'rw', 'sn',
    'art', 'aff', 'arsp', 'trsp',
]);

const NUMWORD_RE = /(one|two|three|four|five|six|seven|eight|nine|zero)\b/g;
const NUMWORDS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

// Latin spellings of the same Arabic name, canonicalized to one. Arabic-script input still needs a full map.
const ALIASES = { misr: 'masr', arriyadia: 'arryadia', khalijia: 'khaleejia', khaleejiya: 'khaleejia' };

/** A time-shift marker ("+1", "plus 2"): a shifted channel is not the same channel as its base. */
function shiftOf(s) {
    const str = String(s ?? '');
    let m = str.match(/\+\s*(\d+)/);
    if (m) return +m[1];
    m = str.match(/\bplus\s*(\d+)\b/i);
    return m ? +m[1] : null;
}

/** "AR-SP| MA ARRYADIA TNT" -> "arryadia", "ESPN +1" -> "espn +1" (the shift is kept: +1 and base differ). */
function normalizeName(s) {
    let str = String(s ?? '')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[[(].*?[\])]/g, ' ')
        .replace(/&/g, ' and ')
        .replace(NUMWORD_RE, (_, w) => NUMWORDS[w]);
    const shift = shiftOf(str);
    str = str.replace(/\+\s*\d+|\bplus\s*\d+/gi, ' ');
    let tokens = str.split(/[^a-z0-9]+/).filter(Boolean);
    // "AR-SP|" splits to ["ar", "sp"]: rejoin hyphenated category codes so they drop as one prefix.
    if (/^(ar|tr)$/.test(tokens[0] || '') && tokens[1] === 'sp') tokens = ['arsp', ...tokens.slice(2)];
    let i = 0;
    while (i < tokens.length - 1 && PREFIXES.has(tokens[i])) i++;
    tokens = tokens.slice(i).map((t) => ALIASES[t] || t).filter((t) => !NOISE.has(t));
    const out = tokens.join(' ');
    return shift != null ? `${out} +${shift}` : out;
}

/** Spaces dropped too, so "ESPN 2" equals "ESPN2". */
const nameKey = (s) => normalizeName(s).replace(/ /g, '');

// Region words that appear in group titles and guide names; used to break "ESPN" into ESPN US / ESPN UK.
const REGIONS = new Set(['usa', 'uk', 'france', 'germany', 'italy', 'spain', 'portugal', 'poland', 'greece', 'cyprus', 'turkey', 'canada', 'australia', 'brazil', 'mexico', 'argentina', 'india', 'pakistan',
    'ksa', 'saudi', 'saudia', 'egypt', 'egy', 'uae', 'emirati', 'emirates', 'dubai', 'qatar', 'bahrain', 'kuwait', 'oman', 'lebanon', 'jordan', 'syria', 'iraq', 'yemen', 'palestine',
    'morocco', 'maghreb', 'algeria', 'tunisia', 'libya', 'sudan']);

/** The one guide channel whose tokens name the group's region, or null when the group names none or several. */
function pickByGroup(hits, group, epgById) {
    if (!group) return null;
    const groupTokens = String(group).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const token of groupTokens) {
        if (!REGIONS.has(token)) continue;
        const matches = [...hits].filter((id) => {
            const c = epgById.get(id);
            return [...(c?.names || []), c?.id || id].join(' ').toLowerCase().split(/[^a-z0-9]+/).includes(token);
        });
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) return null; // the group names more than one candidate: still ambiguous
    }
    return null;
}

/**
 * @param {Map<string,{originalId:string,name:string,tvgName?:string,group?:string}>} channels playlist channels by their prefixed id
 * @param {Object<string,string>} overrides channel id -> XMLTV channel id (manual)
 * @param {{id:string,names:string[]}[]} epgChannels what the guides declare
 * @returns {Map<string,string[]>} XMLTV channel id -> playlist channel ids that take its programmes
 */
function buildTargets({ channels, overrides = {}, epgChannels }) {
    const epgById = new Map(epgChannels.map((c) => [c.id, c]));
    const epgIds = new Set(epgById.keys());
    const idsByName = new Map();
    // First-token index of the same normalized names. The prefix search below only scans the bucket for the
    // query's first token; scanning every guide channel per playlist channel was O(n*m) normalizeName calls
    // and pinned the CPU on big guides.
    const byFirst = new Map(); // first token -> {channelId, tokens}[]
    const index = (key, id) => { if (key) idsByName.set(key, (idsByName.get(key) || new Set()).add(id)); };
    for (const { id, names } of epgChannels) {
        // The id slug is often cleaner than the display-name ("arryadia.ma" vs "AR-SP| MA ARRYADIA TNT").
        for (const n of new Set([...names, id.replace(/\.[a-z]{2,3}$/i, '')])) {
            const key = nameKey(n);
            index(key, id);
            const tokens = normalizeName(n).split(' ').filter(Boolean);
            if (!tokens.length) continue;
            const bucket = byFirst.get(tokens[0]);
            if (bucket) bucket.push({ channelId: id, tokens });
            else byFirst.set(tokens[0], [{ channelId: id, tokens }]);
        }
    }
    const targets = new Map();
    const add = (xmltvId, channelId) => targets.set(xmltvId, [...(targets.get(xmltvId) || []), channelId]);

    /** Exact key, then a base name whose guide names only add region/quality decoration ("Rotana Cinema" vs "… KSA"/"… Egypt"). */
    const matchByName = (name, group) => {
        if (!name) return null;
        const hits = idsByName.get(nameKey(name));
        if (hits) return hits.size === 1 ? [...hits][0] : pickByGroup(hits, group, epgById);
        const base = normalizeName(name).split(' ').filter(Boolean);
        if (!base.length) return null;
        const cand = new Set();
        for (const { channelId, tokens } of (byFirst.get(base[0]) || [])) {
            if (tokens.length > base.length && base.every((w, j) => tokens[j] === w)
                && tokens.slice(base.length).every((w) => REGIONS.has(w) || NOISE.has(w) || w.startsWith('+'))) {
                cand.add(channelId);
            }
        }
        if (cand.size === 1) return [...cand][0];
        return cand.size > 1 ? pickByGroup(cand, group, epgById) : null;
    };

    for (const [id, { originalId, name, tvgName, group }] of channels) {
        if (overrides[id]) { add(overrides[id], id); continue; }
        add(originalId, id);
        if (epgIds.has(originalId)) continue;
        const matched = matchByName(name, group) || matchByName(tvgName, group);
        if (matched) add(matched, id);
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

/**
 * Top suggestion. Returns flags the caller needs to place it: `tie` when the runner-up is nearly as good
 * (bulk accept must not take coin flips) and `shiftBad` when a shifted query only matched a non-shifted
 * guide (never confident). Confidence is demoted by the same amounts for display and tests.
 */
function bestMatch(suggest, name) {
    const shift = shiftOf(name);
    const found = suggest(name, 10);
    let [best, second] = found;
    if (!best) return null;
    let tie = false;
    let shiftBad = false;
    if (shift != null) {
        const same = found.find((c) => shiftOf(`${c.names[0]} ${c.id}`) === shift);
        if (same) { best = same; second = undefined; }
        else { shiftBad = true; best = { ...best, confidence: Math.min(best.confidence, CONFIDENT - 0.01) }; }
    }
    if (second && best.confidence - second.confidence < 0.05) { tie = true; best = { ...best, confidence: best.confidence - 0.2 }; }
    return { ...best, tie, shiftBad };
}

module.exports = { normalizeName, nameKey, shiftOf, buildTargets, createSuggester, bestMatch, CONFIDENT };