// Shared M3U parser. The display name starts after the comma that follows the last
// quoted attribute; taking the last comma in the line truncated names like
// "CNN, International" to " International".
const { isPlaylistUrl } = require('./streamProtocols');

function displayNameFromExtinf(line) {
    const lastQuote = line.lastIndexOf('"');
    const delimiter = lastQuote >= 0 ? line.indexOf(',', lastQuote + 1) : line.indexOf(',');
    return delimiter >= 0 ? line.slice(delimiter + 1).trim() : 'Unknown';
}

function parseM3U(data) {
    if (!data) return [];
    const lines = data.split('\n');
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXTINF:')) continue;
        const nextLine = lines[i + 1]?.trim();
        if (!nextLine || !isPlaylistUrl(nextLine)) continue;

        const idMatch = line.match(/tvg-id="([^"]*)"/);
        const logoMatch = line.match(/tvg-logo="([^"]*)"/);
        const nameMatch = line.match(/tvg-name="([^"]*)"/);
        const groupMatch = line.match(/group-title="([^"]*)"/);
        const chnoMatch = line.match(/tvg-chno="([^"]*)"/);
        const sourceMatch = line.match(/vini-source="([^"]*)"/);
        const displayName = displayNameFromExtinf(line);

        channels.push({
            id: idMatch ? idMatch[1] : `unknown-${Math.random()}`,
            logo: logoMatch ? logoMatch[1] : '',
            name: nameMatch ? nameMatch[1] : displayName,
            group: groupMatch ? groupMatch[1] : 'Uncategorized',
            chno: chnoMatch ? chnoMatch[1] : null,
            source: sourceMatch ? sourceMatch[1] : 'Default',
            displayName,
            url: nextLine,
        });
        i++; // Skip the URL line in the next iteration
    }
    return channels;
}

module.exports = { parseM3U, displayNameFromExtinf };
