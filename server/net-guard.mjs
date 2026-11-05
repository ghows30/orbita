// Richieste verso i provider con protezione SSRF: solo http/https, niente indirizzi
// loopback / link-local / metadata cloud (e reti private salvo ORBITA_ALLOW_PRIVATE=1),
// controllo ripetuto ad ogni redirect, timeout e limiti di dimensione.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export const ALLOW_PRIVATE = process.env.ORBITA_ALLOW_PRIVATE === '1';
const MAX_REDIRECTS = 5;
export const DEFAULT_UA = 'VLC/3.0.21 LibVLC/3.0.21';

function v4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

const ALWAYS_BLOCKED_V4 = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '100.64.0.0/10'];
const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    if (ALWAYS_BLOCKED_V4.some((c) => inV4(ip, c))) return true;
    return !ALLOW_PRIVATE && PRIVATE_V4.some((c) => inV4(ip, c));
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (l === '::' || l === '::1') return true;
    if (/^fe[89ab]/.test(l)) return true; // link-local
    if (/^ff/.test(l)) return true; // multicast
    if (/^f[cd]/.test(l)) return !ALLOW_PRIVATE; // unique local
    return false;
  }
  return true;
}

/** lookup DNS che rifiuta indirizzi vietati (protegge anche dal DNS rebinding: il controllo è sull'IP effettivo). */
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isBlockedIp(a.address));
    if (!ok.length) {
      const e = new Error('Indirizzo di destinazione non consentito');
      e.code = 'EBLOCKED';
      return cb(e);
    }
    if (options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

export function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) return null;
  if (/^localhost$|\.localhost$/i.test(host)) return null;
  return u;
}

export function sanitizeUa(ua) {
  if (typeof ua !== 'string') return DEFAULT_UA;
  const t = ua.replace(/[\r\n\0]/g, '').trim().slice(0, 200);
  return t || DEFAULT_UA;
}

/** Nasconde credenziali per i log. */
export function redact(u) {
  try {
    const x = new URL(String(u));
    return `${x.protocol}//${x.host}/…`;
  } catch {
    return '[url]';
  }
}

/**
 * Esegue GET seguendo i redirect in modo sicuro. Risolve con { res, finalUrl }.
 * `headers` aggiuntivi consentiti: range.
 */
export function guardedGet(rawUrl, { ua, range, timeoutMs = 20000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (urlObj) => {
      const lib = urlObj.protocol === 'https:' ? https : http;
      const headers = { 'user-agent': sanitizeUa(ua), accept: '*/*', 'accept-encoding': 'identity' };
      if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range;
      const req = lib.request(urlObj, { method: 'GET', headers, lookup: guardedLookup, timeout: timeoutMs }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          if (++hops > MAX_REDIRECTS) return reject(Object.assign(new Error('Troppi redirect'), { code: 'EREDIRECT' }));
          const next = validateUrl(new URL(loc, urlObj).toString());
          if (!next) return reject(Object.assign(new Error('Redirect verso indirizzo non consentito'), { code: 'EBLOCKED' }));
          return go(next);
        }
        resolve({ res, finalUrl: urlObj.toString() });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
      req.end();
    };
    const first = validateUrl(rawUrl);
    if (!first) return reject(Object.assign(new Error('URL non valido o non consentito'), { code: 'EBLOCKED' }));
    go(first);
  });
}

/** Legge l'intero corpo con limite di dimensione. */
export function readBody(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(Object.assign(new Error('Risposta troppo grande'), { code: 'ETOOBIG' }));
      } else chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
