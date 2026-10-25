// ssrfGuard.js
// Server-side request forgery (SSRF) protection for endpoints that fetch a URL a client
// supplied (image proxy, URL validation). Every hop, including redirects, must:
//   - use http: or https:
//   - resolve only to public addresses (no loopback, link-local/cloud metadata,
//     private LAN, multicast or reserved ranges)
// The address check runs inside the socket's DNS lookup, so the IP that was checked is
// the IP that is connected to (no DNS-rebinding window between check and connect).
//
// Environment:
//   SSRF_ALLOW_PRIVATE_NETWORKS=true  Also allow private LAN ranges (10/8, 172.16/12,
//                                     192.168/16, 100.64/10, fc00::/7). Loopback,
//                                     link-local and metadata addresses stay blocked.
//   SSRF_ALLOWED_HOSTS=a.lan,10.0.0.5 Hostnames or IPs exempt from the address checks.

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Never reachable through a proxied fetch.
const reservedRanges = new net.BlockList();
[
    ['0.0.0.0', 8],          // "this" network
    ['127.0.0.0', 8],        // loopback
    ['169.254.0.0', 16],     // link-local, incl. cloud metadata 169.254.169.254
    ['192.0.0.0', 24],       // IETF protocol assignments
    ['192.0.2.0', 24],       // TEST-NET-1
    ['198.18.0.0', 15],      // benchmarking
    ['198.51.100.0', 24],    // TEST-NET-2
    ['203.0.113.0', 24],     // TEST-NET-3
    ['224.0.0.0', 4],        // multicast
    ['240.0.0.0', 4],        // reserved, incl. broadcast
].forEach(([addr, prefix]) => reservedRanges.addSubnet(addr, prefix, 'ipv4'));
[
    ['::', 128],             // unspecified
    ['::1', 128],            // loopback
    ['64:ff9b::', 96],       // NAT64 (embeds an IPv4 address)
    ['100::', 64],           // discard-only
    ['2001:db8::', 32],      // documentation
    ['2002::', 16],          // 6to4 (embeds an IPv4 address)
    ['fe80::', 10],          // link-local
    ['fec0::', 10],          // site-local (deprecated)
    ['ff00::', 8],           // multicast
].forEach(([addr, prefix]) => reservedRanges.addSubnet(addr, prefix, 'ipv6'));

// Private networks: blocked unless SSRF_ALLOW_PRIVATE_NETWORKS=true.
const privateRanges = new net.BlockList();
[
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['100.64.0.0', 10],      // carrier-grade NAT
].forEach(([addr, prefix]) => privateRanges.addSubnet(addr, prefix, 'ipv4'));
privateRanges.addSubnet('fc00::', 7, 'ipv6'); // unique local

class SsrfBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SsrfBlockedError';
        this.code = 'SSRF_BLOCKED';
    }
}

function allowPrivateNetworks() {
    return String(process.env.SSRF_ALLOW_PRIVATE_NETWORKS || '').toLowerCase() === 'true';
}

function isExemptHost(hostname) {
    const list = String(process.env.SSRF_ALLOWED_HOSTS || '')
        .split(',')
        .map(h => h.trim().toLowerCase().replace(/^\[|\]$/g, ''))
        .filter(Boolean);
    return list.includes(String(hostname).toLowerCase());
}

/**
 * Converts an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:XXXX:XXXX) to IPv4.
 * Returns null if the address is not IPv4-mapped.
 */
function unmapIPv4(address) {
    const match = /^::ffff:(?:0:)?([0-9a-f.:]+)$/i.exec(address);
    if (!match) return null;
    const tail = match[1];
    if (net.isIPv4(tail)) return tail;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
    if (!hex) return null;
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/**
 * Returns a reason string if the IP address must not be fetched, or null if it is allowed.
 */
function blockedReason(address) {
    let ip = address;
    let family = net.isIP(ip);
    if (family === 6) {
        const mapped = unmapIPv4(ip);
        if (mapped) {
            ip = mapped;
            family = 4;
        }
    }
    if (family === 0) return 'not a valid IP address';
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (reservedRanges.check(ip, type)) return 'loopback, link-local or reserved address';
    if (!allowPrivateNetworks() && privateRanges.check(ip, type)) return 'private network address';
    return null;
}

// Addresses that are never a legitimate IPTV stream or source: the server itself and
// link-local (cloud metadata). Private LAN ranges stay allowed because self-hosted IPTV
// sources commonly live there.
const alwaysBlockedRanges = new net.BlockList();
[
    ['0.0.0.0', 8],          // "this" network
    ['127.0.0.0', 8],        // loopback
    ['169.254.0.0', 16],     // link-local, incl. cloud metadata 169.254.169.254
    ['::', 128],             // unspecified
    ['::1', 128],            // loopback
    ['fe80::', 10],          // link-local
].forEach(([addr, prefix]) => alwaysBlockedRanges.addSubnet(addr, prefix, net.isIP(addr) === 6 ? 'ipv6' : 'ipv4'));

const LOCAL_HOST_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

/** Reason string when an address must never be used as a stream/source target, else null. */
function alwaysBlockedReason(address) {
    let ip = address;
    let family = net.isIP(ip);
    if (family === 6) {
        const mapped = unmapIPv4(ip);
        if (mapped) {
            ip = mapped;
            family = 4;
        }
    }
    if (family === 0) return 'not a valid IP address';
    return alwaysBlockedRanges.check(ip, family === 4 ? 'ipv4' : 'ipv6')
        ? 'loopback, link-local or metadata address'
        : null;
}

/**
 * Validates a URL handed to ffmpeg/ffprobe (streams, VOD probing, source fetches).
 * Blocks the server itself and cloud metadata endpoints, but keeps private LAN ranges
 * allowed: that is where self-hosted IPTV sources usually live.
 *
 * shortcut: DNS names are not resolved here, so a hostname that resolves to loopback can
 * still reach it; ffmpeg resolves the name itself and its lookup cannot be pinned.
 * Upgrade to an address-pinned fetch if untrusted users ever control stream URLs.
 * @returns {URL}
 */
function assertSafeStreamUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (e) {
        throw new SsrfBlockedError('Invalid URL.');
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!hostname) throw new SsrfBlockedError('URL has no host.');
    const lower = hostname.toLowerCase();
    if (LOCAL_HOST_NAMES.has(lower) || lower.endsWith('.localhost')) {
        throw new SsrfBlockedError(`Refusing to fetch ${hostname}: local address.`);
    }
    if (net.isIP(hostname)) {
        const reason = alwaysBlockedReason(hostname);
        if (reason) throw new SsrfBlockedError(`Refusing to fetch ${hostname}: ${reason}.`);
    }
    return parsed;
}

/**
 * dns.lookup replacement for http(s).request that refuses to connect to blocked addresses.
 */
function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return callback(err);
        for (const { address } of addresses) {
            const reason = blockedReason(address);
            if (reason) {
                return callback(new SsrfBlockedError(`Refusing to connect to ${hostname} (${address}): ${reason}.`));
            }
        }
        if (opts.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
    });
}

/**
 * Validates a URL's scheme and, for IP-literal hosts, its address.
 * Hostnames are checked again at connect time by guardedLookup.
 * @returns {URL}
 */
function assertSafeUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (e) {
        throw new SsrfBlockedError('Invalid URL.');
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new SsrfBlockedError(`Unsupported URL scheme "${parsed.protocol}". Only http and https are allowed.`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!hostname) throw new SsrfBlockedError('URL has no host.');
    // Node skips the lookup step for IP literals, so check them here.
    if (net.isIP(hostname) && !isExemptHost(hostname)) {
        const reason = blockedReason(hostname);
        if (reason) throw new SsrfBlockedError(`Refusing to fetch ${hostname}: ${reason}.`);
    }
    return parsed;
}

/**
 * Opens a GET request to a client-supplied URL with SSRF protection, following up to
 * maxRedirects redirects (each one re-validated). Resolves with the 2xx response stream;
 * the caller must consume or destroy it.
 * @param {string} rawUrl
 * @param {{ maxRedirects?: number, timeout?: number, headers?: object }} [options]
 * @returns {Promise<{ response: import('http').IncomingMessage, url: string }>}
 */
function safeGet(rawUrl, options = {}) {
    const { maxRedirects = 5, timeout = 15000, headers = {} } = options;
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = assertSafeUrl(rawUrl);
        } catch (err) {
            return reject(err);
        }
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
        const client = parsed.protocol === 'https:' ? https : http;
        const requestOptions = { headers, timeout, agent: false };
        if (!isExemptHost(hostname)) requestOptions.lookup = guardedLookup;

        const request = client.get(parsed, requestOptions, (response) => {
            const { statusCode } = response;
            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume();
                if (maxRedirects <= 0) {
                    return reject(new Error('Too many redirects.'));
                }
                let next;
                try {
                    next = new URL(response.headers.location, parsed).href;
                } catch (e) {
                    return reject(new Error('Invalid redirect location.'));
                }
                return safeGet(next, { ...options, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
            }
            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                return reject(new Error(`Status Code ${statusCode}`));
            }
            resolve({ response, url: parsed.href });
        });
        request.on('timeout', () => request.destroy(new Error('Request timed out.')));
        request.on('error', reject);
    });
}

module.exports = { safeGet, assertSafeUrl, assertSafeStreamUrl, alwaysBlockedReason, blockedReason, isExemptHost, SsrfBlockedError };
