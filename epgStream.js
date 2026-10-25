// epgStream.js
// Walks an XMLTV stream one <programme> at a time. Real-world guides (e.g. epgshare01's
// ALL_SOURCES) decompress past V8's ~512M-character string limit, so the whole file can
// never be held, let alone parsed, as one string. Only the current programme is buffered.
// shortcut: finds programmes by text scan, so a literal "</programme>" inside a CDATA block
// would split it; upgrade to a SAX parser if a real guide ever does that.

const xmlJS = require('xml-js');
const { nameKey } = require('./epgMatch');

const PROGRAMME = /<programme\b[^>]*?(?:\/>|>[\s\S]*?<\/programme>)/g;

async function forEachProgramme(stream, onProgramme) {
    stream.setEncoding('utf8');
    let buf = '';
    for await (const chunk of stream) {
        buf += chunk;
        let end = 0;
        PROGRAMME.lastIndex = 0;
        for (let m; (m = PROGRAMME.exec(buf));) {
            onProgramme(xmlJS.xml2js(m[0], { compact: true }).programme);
            end = PROGRAMME.lastIndex;
        }
        // Keep only an unfinished <programme (or a possible split "<progr" prefix of one).
        const rest = buf.slice(end);
        const open = rest.lastIndexOf('<programme');
        buf = open >= 0 ? rest.slice(open) : rest.slice(-10);
    }
}

const CHANNEL = /<channel\b[^>]*?(?:\/>|>[\s\S]*?<\/channel>)/g;
const text = (n) => (n?._cdata ?? n?._text ?? '').toString().trim();

// Calls onChannel({id, names}) for each <channel>, and stops reading at the first <programme>: XMLTV puts
// channels first, so the pass stays cheap even on a huge guide.
// shortcut: a <channel> placed after the first <programme> is missed, upgrade by scanning the whole file.
async function forEachChannel(stream, onChannel) {
    stream.setEncoding('utf8');
    let buf = '';
    for await (const chunk of stream) {
        buf += chunk;
        const stop = buf.indexOf('<programme');
        const head = stop === -1 ? buf : buf.slice(0, stop);
        let end = 0;
        CHANNEL.lastIndex = 0;
        for (let m; (m = CHANNEL.exec(head));) {
            const ch = xmlJS.xml2js(m[0], { compact: true }).channel;
            const id = ch._attributes?.id;
            const names = [].concat(ch['display-name'] || []).map(text).filter(Boolean);
            // Guides sometimes leave channel ids empty; fall back to a slug so the channel stays name-matchable.
            if (!id) {
                const slug = names[0] && nameKey(names[0]);
                if (!slug) continue;
                onChannel({ id: slug, names, synthetic: true });
            } else {
                onChannel({ id, names });
            }
            end = CHANNEL.lastIndex;
        }
        if (stop !== -1) return; // leaving the loop closes the stream
        const rest = buf.slice(end);
        const open = rest.lastIndexOf('<channel');
        buf = open >= 0 ? rest.slice(open) : rest.slice(-10);
    }
}

module.exports = { forEachProgramme, forEachChannel };
