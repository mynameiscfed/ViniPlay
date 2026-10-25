// Identity for /stream and the image proxy. Local playback is allowed without a login,
// but it must never become a session user: express-session saves every modified session
// as a Set-Cookie, so writing userId = 1 used to log every LAN device in as the first
// account (usually the admin). This module only reads the session.

const LOCAL_V4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/;

function isLocalAddress(ip) {
    const m = String(ip || '').match(LOCAL_V4);
    return !!(ip === '::1' || (m && (
        m[1] === '127' || m[1] === '10' ||
        (m[1] === '192' && m[2] === '168') ||
        (m[1] === '172' && +m[2] >= 16 && +m[2] <= 31)
    )));
}

/**
 * @returns {{ok:true, userId:number|null, username:string, localAccess:boolean}}
 *        or {{ok:false, status:number, message:string}}
 */
function resolveStreamIdentity(req, { castTokens, trustProxy } = {}) {
    if (req.session && req.session.userId) {
        return { ok: true, userId: req.session.userId, username: req.session.username, localAccess: false };
    }

    const castToken = req.query && req.query.castToken;
    if (castToken) {
        const tokenData = castTokens && castTokens.get(castToken);
        if (!tokenData) return { ok: false, status: 401, message: 'Invalid cast token' };
        if (tokenData.expiresAt < Date.now()) {
            castTokens.delete(castToken);
            return { ok: false, status: 401, message: 'Expired cast token' };
        }
        castTokens.delete(castToken); // one-time use
        return { ok: true, userId: tokenData.userId, username: 'Cast User', localAccess: false };
    }

    // With a proxy in front and no configured trusted proxy, req.ip is the proxy's
    // address; "local" cannot be established safely.
    if (req.headers && req.headers['x-forwarded-for'] && !trustProxy) {
        return { ok: false, status: 401, message: 'Authentication required' };
    }

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    if (isLocalAddress(ip)) {
        return { ok: true, userId: null, username: 'Local Network', localAccess: true };
    }

    return { ok: false, status: 401, message: 'Authentication required' };
}

module.exports = { isLocalAddress, resolveStreamIdentity };
