// ORBITA – server locale: serve l'app e fa da proxy verso i provider IPTV.
// Ascolta SOLO su 127.0.0.1. Le credenziali viaggiano nel corpo delle POST e vengono
// sostituite da token opachi: non finiscono mai nella cronologia, nei log o negli URL del player.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { guardedGet, readBody, validateUrl, sanitizeUa, redact, ALLOW_PRIVATE } from './net-guard.mjs';
import { parseXmltv } from './xmltv.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 7878;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const DEV = process.env.ORBITA_DEV === '1' || process.argv.includes('--dev');

const MAX_JSON_BODY = 64 * 1024;
const MAX_TEXT = 250 * 1024 * 1024; // playlist enormi esistono davvero
const MAX_HLS = 8 * 1024 * 1024;
const MAX_LOGO = 3 * 1024 * 1024;
const TOKEN_TTL = 12 * 3600 * 1000;
const MAX_TOKENS = 200_000;

/* ---------------- token opachi ---------------- */
const tokens = new Map();
function register(url, ua) {
  const id = crypto.randomBytes(18).toString('base64url');
  tokens.set(id, { url, ua, exp: Date.now() + TOKEN_TTL });
  if (tokens.size > MAX_TOKENS) {
    const drop = tokens.size - MAX_TOKENS;
    let i = 0;
    for (const k of tokens.keys()) {
      if (i++ >= drop) break;
      tokens.delete(k);
    }
  }
  return id;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.exp < now) tokens.delete(k);
}, 10 * 60 * 1000).unref();

/* ---------------- sicurezza richiesta ---------------- */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
if (DEV) ['127.0.0.1:5173', 'localhost:5173'].forEach((h) => ALLOWED_HOSTS.add(h));

function hostOk(req) {
  // blocca DNS rebinding: il browser deve aver chiamato davvero localhost
  return ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase());
}
function notCrossSite(req) {
  const s = req.headers['sec-fetch-site'];
  return !s || s === 'same-origin' || s === 'none';
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return ALLOWED_HOSTS.has(new URL(o).host);
  } catch {
    return false;
  }
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/* I contenuti inoltrati (stream, playlist, copertine) arrivano da server che non controlliamo e vengono
   serviti dalla nostra origine: se qualcuno li aprisse come pagina non devono poter eseguire nulla.
   "sandbox" toglie script e accesso all'origine; i tipi "attivi" diventano dati generici. */
const UNTRUSTED = { 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' };
const ACTIVE_TYPE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/(x-)?javascript|application\/ecmascript|text\/css)/i;
const safeType = (ct) => (ACTIVE_TYPE.test(String(ct || '').trim()) ? 'application/octet-stream' : String(ct || 'application/octet-stream'));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
}
function fail(res, err) {
  const code = err?.code;
  const map = {
    EBLOCKED: [403, 'Indirizzo non consentito per sicurezza.'],
    ETOOBIG: [413, 'Risposta del provider troppo grande.'],
    ETIMEDOUT: [504, 'Il provider non risponde (timeout).'],
    ENOTFOUND: [502, 'Server del provider non trovato.'],
    ECONNREFUSED: [502, 'Connessione rifiutata dal provider.'],
    ECONNRESET: [502, 'Connessione interrotta dal provider.'],
    EREDIRECT: [502, 'Troppi redirect dal provider.'],
  };
  const [st, msg] = map[code] || [502, 'Errore di rete verso il provider.'];
  if (!res.headersSent) json(res, st, { error: msg });
  else res.destroy();
}

async function readJson(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/json')) throw Object.assign(new Error('bad ct'), { status: 415 });
  const buf = await readBody(req, MAX_JSON_BODY);
  return JSON.parse(buf.toString('utf8'));
}

/* ---------------- HLS: riscrittura playlist ---------------- */
function isHls(ct, finalUrl) {
  return /mpegurl/i.test(ct || '') || /\.m3u8(\?|$)/i.test(new URL(finalUrl).pathname + new URL(finalUrl).search);
}
function rewriteHls(text, baseUrl, ua) {
  const tok = (ref) => {
    const abs = validateUrl(new URL(ref, baseUrl).toString());
    return abs ? `/p/${register(abs.toString(), ua)}` : ref;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${tok(u)}"`);
      return tok(l);
    })
    .join('\n');
}

/* ---------------- rispetto dei limiti del provider ----------------
   Molti provider stanno dietro Cloudflare: centinaia di copertine dallo stesso host in pochi secondi
   fanno scattare il 429 sull'IP, e da lì falliscono anche le chiamate API (episodi delle serie).
   Per ogni host: poche copertine alla volta e, dopo un 429, una pausa in cui le copertine non partono. */
const LOGO_PARALLEL = 3;
const hosts = new Map();
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const gate = (host) => {
  let g = hosts.get(host);
  if (!g) {
    // una playlist con migliaia di host diversi non deve far crescere la mappa all'infinito
    if (hosts.size > 2000) for (const [k, v] of hosts) if (!v.active && !v.queue.length && v.coolUntil < Date.now()) hosts.delete(k);
    hosts.set(host, (g = { active: 0, queue: [], coolUntil: 0 }));
  }
  return g;
};
function noteStatus(url, status, retryAfter) {
  if (status !== 429) return;
  const g = gate(hostOf(url));
  const wait = Math.min(120, Number(retryAfter) || 20) * 1000;
  g.coolUntil = Math.max(g.coolUntil, Date.now() + wait);
  console.warn(`[orbita] 429 da ${hostOf(url)}: pausa copertine ${Math.round(wait / 1000)} s`);
}
const logoCount = new Map();
async function withLogoSlot(url, fn) {
  // registro: quante copertine per host (la prima e poi ogni 50), per capire se pesano sul provider
  const h = hostOf(url);
  const n = (logoCount.get(h) || 0) + 1;
  if (logoCount.size > 2000) logoCount.clear();
  logoCount.set(h, n);
  if (n === 1 || n % 50 === 0) console.log(`[orbita] copertine da ${h}: ${n}`);
  const g = gate(h);
  if (g.coolUntil > Date.now()) throw Object.assign(new Error('cooldown'), { code: 'ECOOL' });
  if (g.active >= LOGO_PARALLEL) await new Promise((r) => g.queue.push(r));
  g.active++;
  try {
    return await fn();
  } finally {
    g.active--;
    g.queue.shift()?.();
  }
}
/* ---------------- handler API ---------------- */
async function apiOpen(req, res) {
  const b = await readJson(req);
  const u = validateUrl(b.url);
  if (!u) return json(res, 400, { error: 'URL non valido.' });
  json(res, 200, { path: `/p/${register(u.toString(), sanitizeUa(b.ua))}` });
}

async function apiFetch(req, res) {
  const b = await readJson(req);
  // registro senza credenziali: solo host, azione Xtream e id
  let what = redact(b.url);
  try {
    const u = new URL(b.url);
    const q = u.searchParams;
    const safe = (v) => (/^[\w.-]{1,40}$/.test(v || '') ? v : '…');
    const isApi = u.pathname.endsWith('/player_api.php');
    // solo host, azione Xtream e id numerici: mai pezzi di percorso o altri parametri (possono contenere credenziali o chiavi)
    what = `${u.host} ${isApi ? safe(q.get('action') || 'login') : '(richiesta)'}${isApi ? ['series_id', 'vod_id', 'stream_id'].map((k) => (/^\d{1,12}$/.test(q.get(k) || '') ? ` ${k}=${q.get(k)}` : '')).join('') : ''}`;
  } catch { /* URL già validato più avanti */ }
  const t0 = Date.now();
  console.log(`[orbita] → ${what}`);
  res.on('close', () => console.log(`[orbita] ← ${what}  ${res.statusCode}  ${Date.now() - t0} ms${res.writableFinished ? '' : '  (chiusa dal browser)'}`));
  const { res: up } = await guardedGet(b.url, { ua: b.ua, timeoutMs: 45000 });
  if (up.statusCode < 200 || up.statusCode >= 300) {
    up.resume();
    noteStatus(b.url, up.statusCode, up.headers['retry-after']);
    // Retry-After (secondi) per i 429: il client aspetta quanto chiede il provider invece di insistere
    const retryAfter = Number(up.headers['retry-after']) || undefined;
    return json(res, 502, { error: `Il provider ha risposto con errore ${up.statusCode}.`, status: up.statusCode, retryAfter });
  }
  const body = await readBody(up, MAX_TEXT);
  send(res, 200, body, { 'content-type': 'text/plain; charset=utf-8' });
}

async function apiEpg(req, res) {
  const b = await readJson(req);
  const ids = new Set((Array.isArray(b.ids) ? b.ids : []).slice(0, 20000).map((x) => String(x).toLowerCase()));
  if (!ids.size) return json(res, 200, {});
  const now = Date.now() / 1000;
  const fromSec = Number(b.from) || now - 8 * 3600;
  const toSec = Number(b.to) || now + 30 * 3600;
  const { res: up } = await guardedGet(b.url, { ua: b.ua, timeoutMs: 60000 });
  if (up.statusCode !== 200) {
    up.resume();
    return json(res, 502, { error: `Guida EPG non disponibile (${up.statusCode}).` });
  }
  json(res, 200, await parseXmltv(up, ids, { fromSec, toSec }));
}

async function proxyStream(req, res, id) {
  const t = tokens.get(id);
  if (!t) return json(res, 404, { error: 'Sessione stream scaduta.' });
  t.exp = Date.now() + TOKEN_TTL;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const { res: up, finalUrl } = await guardedGet(t.url, { ua: t.ua, range: req.headers.range, timeoutMs: 20000, signal: ac.signal });
  const ct = up.headers['content-type'] || 'application/octet-stream';
  if (up.statusCode >= 400) {
    up.resume();
    return json(res, 502, { error: `Stream non disponibile (${up.statusCode}).`, status: up.statusCode });
  }
  if (isHls(ct, finalUrl)) {
    const text = (await readBody(up, MAX_HLS)).toString('utf8');
    if (text.trimStart().startsWith('#EXTM3U')) {
      return send(res, 200, rewriteHls(text, finalUrl, t.ua), { ...UNTRUSTED, 'content-type': 'application/vnd.apple.mpegurl' });
    }
    return send(res, 200, text, { ...UNTRUSTED, 'content-type': safeType(ct) });
  }
  const h = { ...BASE_HEADERS, ...UNTRUSTED, 'content-type': safeType(ct), 'cache-control': 'no-store' };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) if (up.headers[k]) h[k] = up.headers[k];
  res.writeHead(up.statusCode === 206 ? 206 : 200, h);
  up.pipe(res);
  up.on('error', () => res.destroy());
}

/* logo/poster: solo immagini, cache in memoria */
const logoCache = new Map();
let logoBytes = 0;
const MAX_LOGO_CACHE = 160 * 1024 * 1024; // tetto alla memoria: 3000 immagini da 3 MB sarebbero 9 GB
function cacheLogo(key, entry) {
  logoCache.set(key, entry);
  logoBytes += entry.body.length;
  while ((logoBytes > MAX_LOGO_CACHE || logoCache.size > 3000) && logoCache.size > 1) {
    const [k, v] = logoCache.entries().next().value;
    logoCache.delete(k);
    logoBytes -= v.body.length;
  }
}
async function proxyLogo(req, res, raw) {
  const hit = logoCache.get(raw);
  if (hit) return send(res, 200, hit.body, { ...UNTRUSTED, 'content-type': hit.ct, 'cache-control': 'private, max-age=86400' });
  let up;
  try {
    ({ res: up } = await withLogoSlot(raw, () => guardedGet(raw, { timeoutMs: 12000 })));
  } catch (err) {
    if (err?.code === 'ECOOL') return send(res, 503, '', { 'retry-after': '30' });
    throw err;
  }
  noteStatus(raw, up.statusCode, up.headers['retry-after']);
  const ct = String(up.headers['content-type'] || '');
  if (up.statusCode !== 200 || !/^image\/(png|jpe?g|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)/i.test(ct)) {
    up.resume();
    return send(res, 404, '');
  }
  const body = await readBody(up, MAX_LOGO);
  // gli SVG possono contenere script: come <img> non li eseguono, e aperti da soli li blocca la CSP "sandbox"
  const type = /svg/i.test(ct) ? 'image/svg+xml' : ct.split(';')[0].trim().toLowerCase();
  cacheLogo(raw, { body, ct: type });
  send(res, 200, body, { ...UNTRUSTED, 'content-type': type, 'cache-control': 'private, max-age=86400' });
}

/* ---------------- statici ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.m3u': 'audio/x-mpegurl', '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.includes('\0')) return send(res, 400, '');
  let file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return send(res, 403, '');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) return send(res, 503, 'Build mancante: esegui "npm run build".', { 'content-type': 'text/plain; charset=utf-8' });
  const ext = path.extname(file);
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  if (ext === '.html') headers['content-security-policy'] = CSP;
  headers['cache-control'] = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { ...BASE_HEADERS, ...headers });
  fs.createReadStream(file).pipe(res);
}

/* ---------------- router ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 421, 'Host non consentito');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p.startsWith('/api/')) {
      if (req.method !== 'POST') return json(res, 405, { error: 'Metodo non consentito' });
      // header personalizzato = preflight CORS obbligatorio per altri siti, che noi non concediamo
      if (req.headers['x-orbita'] !== '1' || !originOk(req) || !notCrossSite(req)) return json(res, 403, { error: 'Richiesta non autorizzata' });
      if (p === '/api/open') return await apiOpen(req, res);
      if (p === '/api/fetch') return await apiFetch(req, res);
      if (p === '/api/epg') return await apiEpg(req, res);
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '');
    if (p.startsWith('/p/')) {
      if (!notCrossSite(req)) return send(res, 403, '');
      return await proxyStream(req, res, p.slice(3).split('/')[0]);
    }
    if (p === '/logo') {
      if (!notCrossSite(req)) return send(res, 403, '');
      const u = url.searchParams.get('u') || '';
      if (!validateUrl(u)) return send(res, 400, '');
      return await proxyLogo(req, res, u);
    }
    serveStatic(req, res, p);
  } catch (err) {
    if (err?.status) return json(res, err.status, { error: 'Richiesta non valida' });
    if (err instanceof SyntaxError) return json(res, 400, { error: 'JSON non valido' });
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err?.name !== 'AbortError') {
      console.warn(`[orbita] ${req.method} ${redact('http://x' + (req.url || '').split('?')[0])} → ${err?.code || err?.message}`);
    }
    fail(res, err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ORBITA pronto →  http://${HOST}:${PORT}\n`);
  if (ALLOW_PRIVATE) console.log('  ⚠ ORBITA_ALLOW_PRIVATE=1: il proxy può raggiungere la rete locale.');
});
