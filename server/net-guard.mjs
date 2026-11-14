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

const ALWAYS_BLOCKED_V4 = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '100.64.0.0/10', '192.0.0.0/24', '198.18.0.0/15'];
const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

/** IPv6 in 8 gruppi da 16 bit (qualsiasi scrittura: abbreviata, con IPv4 puntato in coda, con zona). */
function v6Groups(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const n = v4ToInt(dotted[2]);
    s = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const all = tail === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}
const v4From = (hi, lo) => `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    if (ALWAYS_BLOCKED_V4.some((c) => inV4(ip, c))) return true;
    return !ALLOW_PRIVATE && PRIVATE_V4.some((c) => inV4(ip, c));
  }
  if (net.isIPv6(ip)) {
    const g = v6Groups(ip);
    if (!g) return true;
    const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
    // Indirizzi che contengono un IPv4: vale il giudizio su quell'IPv4. Senza questo controllo
    // "[::ffff:7f00:1]" (= 127.0.0.1) o "[::ffff:a9fe:a9fe]" (= metadata cloud) aggirano il filtro.
    if (zero(0, 5) && g[5] === 0xffff) return isBlockedIp(v4From(g[6], g[7])); // ::ffff:a.b.c.d (mapped)
    if (zero(0, 6)) return g[6] === 0 && g[7] <= 1 ? true : isBlockedIp(v4From(g[6], g[7])); // ::, ::1, ::a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isBlockedIp(v4From(g[6], g[7])); // NAT64
    if (g[0] === 0x2002) return isBlockedIp(v4From(g[1], g[2])); // 6to4
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentazione
    if (g[0] === 0x100 && zero(1, 4)) return true; // discard
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if ((g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xfe00) === 0xfc00) return !ALLOW_PRIVATE; // site-local, unique local
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
