// epgStream.js
// Walks an XMLTV stream one <programme> at a time. Real-world guides (e.g. epgshare01's
// ALL_SOURCES) decompress past V8's ~512M-character string limit, so the whole file can
// never be held, let alone parsed, as one string. Only the current programme is buffered.
// shortcut: finds programmes by text scan, so a literal "</programme>" inside a CDATA block
// would split it; upgrade to a SAX parser if a real guide ever does that.

const xmlJS = require('xml-js');

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

module.exports = { forEachProgramme };
