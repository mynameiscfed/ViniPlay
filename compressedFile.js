// EPG guides are often served as .xml.gz, sometimes with a query string, and uploaded
// guides may be gzipped under an .xml name. Decide by the file's bytes, not its name.
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream');

function isGzipFile(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const header = Buffer.alloc(2);
        const read = fs.readSync(fd, header, 0, 2, 0);
        return read === 2 && header[0] === 0x1f && header[1] === 0x8b;
    } catch (e) {
        return false;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function openMaybeGzip(file) {
    const stream = fs.createReadStream(file);
    return isGzipFile(file) ? pipeline(stream, zlib.createGunzip(), () => { }) : stream;
}

module.exports = { isGzipFile, openMaybeGzip };
