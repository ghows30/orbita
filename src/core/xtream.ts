import { t } from '../i18n';
import { ApiError, fetchJson } from './api';
import type { Channel, EpgItem, Episode, Library, Movie, Series, XtreamSource } from './types';
import { kv, sealGet, sealSet } from './store';
import { cleanTitle, decodeEntities, hash, isAdult } from './util';

/* Le credenziali vengono SEMPRE codificate (l'originale le concatenava in chiaro negli URL API). */
const e = encodeURIComponent;

export function normalizeHost(h: string): string {
  let t = h.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(t)) t = 'http://' + t;
  // accetta anche un link get.php/player_api.php incollato per intero
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}`;
  } catch {
    return t;
  }
}

/** Estrae server/utente/password da un link Xtream incollato (get.php?username=…&password=…). */
export function parseXtreamLink(link: string): { host: string; user: string; pass: string } | null {
  try {
    const u = new URL(link.trim());
    const user = u.searchParams.get('username');
    const pass = u.searchParams.get('password');
    if (!user || !pass) return null;
    return { host: `${u.protocol}//${u.host}`, user, pass };
  } catch {
    return null;
  }
}

const api = (s: XtreamSource, action?: string, extra = '') =>
  `${s.host}/player_api.php?username=${e(s.user)}&password=${e(s.pass)}${action ? `&action=${action}` : ''}${extra}`;

export const liveUrl = (s: XtreamSource, id: number, fmt = s.format) => `${s.host}/live/${e(s.user)}/${e(s.pass)}/${id}.${fmt}`;
export const movieUrl = (s: XtreamSource, id: number, ext = 'mp4') => `${s.host}/movie/${e(s.user)}/${e(s.pass)}/${id}.${ext}`;
export const episodeUrl = (s: XtreamSource, id: number, ext = 'mp4') => `${s.host}/series/${e(s.user)}/${e(s.pass)}/${id}.${ext}`;

/** Catch-up Xtream: /timeshift/user/pass/minuti/AAAA-MM-GG:HH-MM/id.ts nel fuso del server. */
export function timeshiftUrl(s: XtreamSource, id: number, startSec: number, endSec: number, tz?: string): string {
  const min = Math.max(1, Math.ceil((endSec - startSec) / 60));
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(startSec * 1000));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  const stamp = `${p('year')}-${p('month')}-${p('day')}:${p('hour')}-${p('minute')}`;
  return `${s.host}/timeshift/${e(s.user)}/${e(s.pass)}/${min}/${stamp}/${id}.ts`;
}

interface Cat { category_id: string; category_name: string }
interface XLive { stream_id: number; name: string; stream_icon?: string; category_id?: string; epg_channel_id?: string; num?: number; tv_archive?: number; tv_archive_duration?: number | string }
interface XVod { stream_id: number; name: string; stream_icon?: string; category_id?: string; container_extension?: string; rating?: string | number; added?: string; year?: string }
interface XSeries { series_id: number; name: string; cover?: string; category_id?: string; rating?: string | number; last_modified?: string; releaseDate?: string; year?: string }
interface Auth { user_info?: { auth?: number; status?: string; exp_date?: string | null; message?: string }; server_info?: { timezone?: string } }

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const yearOf = (...v: (string | undefined)[]) => {
  for (const x of v) {
    const m = x && /(19|20)\d{2}/.exec(x);
    if (m) return Number(m[0]);
  }
  return undefined;
};
const safeImg = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined);

export async function login(s: XtreamSource, signal?: AbortSignal): Promise<Auth> {
  const a = await fetchJson<Auth>(api(s), s.ua, signal);
  if (!a?.user_info || Number(a.user_info.auth) !== 1) throw new Error(a?.user_info?.message || t('err.login'));
  if (a.user_info.status && a.user_info.status !== 'Active') throw new Error(t('err.inactive', { s: a.user_info.status }));
  return a;
}

export async function loadXtream(s: XtreamSource, onStep?: (msg: string) => void, signal?: AbortSignal): Promise<Library> {
  onStep?.(t('step.login'));
  const auth = await login(s, signal);
  onStep?.(t('step.download'));
  const get = <T>(action: string) => fetchJson<T>(api(s, action), s.ua, signal).catch(() => [] as unknown as T);
  const [lc, vc, sc, ls, vs, ss] = await Promise.all([
    get<Cat[]>('get_live_categories'), get<Cat[]>('get_vod_categories'), get<Cat[]>('get_series_categories'),
    get<XLive[]>('get_live_streams'), get<XVod[]>('get_vod_streams'), get<XSeries[]>('get_series'),
  ]);
  onStep?.(t('step.organize'));
  const names = (cats: Cat[]) => {
    const m = new Map<string, string>();
    if (Array.isArray(cats)) for (const c of cats) m.set(String(c.category_id), decodeEntities(c.category_name || t('common.other')));
    return m;
  };
  const lN = names(lc), vN = names(vc), sN = names(sc);
  const order = (m: Map<string, string>) => {
    const ids = [...m.keys()];
    return (c?: string) => ids.indexOf(String(c));
  };
  const lo = order(lN), vo = order(vN), so = order(sN);

  const live: Channel[] = (Array.isArray(ls) ? ls : [])
    .slice()
    .sort((a, b) => lo(a.category_id) - lo(b.category_id))
    .map((x) => {
      const group = lN.get(String(x.category_id)) || t('common.other');
      const name = decodeEntities(String(x.name || ''));
      return {
        id: 'x' + x.stream_id, xid: x.stream_id, name, group, logo: safeImg(x.stream_icon),
        tvgId: x.epg_channel_id || undefined, num: num(x.num),
        archive: Number(x.tv_archive) === 1 ? Math.min(num(x.tv_archive_duration) || 3, 14) : undefined,
        adult: isAdult(group, name) || undefined,
      };
    });
  const movies: Movie[] = (Array.isArray(vs) ? vs : [])
    .slice()
    .sort((a, b) => vo(a.category_id) - vo(b.category_id))
    .map((x) => {
      const group = vN.get(String(x.category_id)) || t('common.other');
      return {
        id: 'v' + x.stream_id, xid: x.stream_id, name: cleanTitle(String(x.name || '')), group, logo: safeImg(x.stream_icon),
        ext: /^[a-z0-9]{2,5}$/i.test(x.container_extension || '') ? x.container_extension : 'mp4',
        rating: num(x.rating), added: num(x.added), year: num(x.year) || yearOf(x.name), adult: isAdult(group, x.name) || undefined,
      };
    });
  const series: Series[] = (Array.isArray(ss) ? ss : [])
    .slice()
    .sort((a, b) => so(a.category_id) - so(b.category_id))
    .map((x) => {
      const group = sN.get(String(x.category_id)) || t('common.other');
      return {
        id: 'r' + x.series_id, xid: x.series_id, name: cleanTitle(String(x.name || '')), group, logo: safeImg(x.cover),
        rating: num(x.rating), added: num(x.last_modified), year: num(x.year) || yearOf(x.releaseDate, x.name), adult: isAdult(group, x.name) || undefined,
      };
    });
  const exp = num(auth.user_info?.exp_date);
  return {
    live, movies, series,
    epgUrls: [`${s.host}/xmltv.php?username=${e(s.user)}&password=${e(s.pass)}`],
    tz: auth.server_info?.timezone, expires: exp ? exp * 1000 : undefined, loadedAt: Date.now(),
  };
}

export interface VodInfo { tmdbId?: number; plot?: string; cast?: string; director?: string; genre?: string; duration?: string; backdrop?: string; trailer?: string; rating?: number; year?: number }

/* ---------------- richieste di dettaglio: in coda, in cache e con nuovo tentativo su 429 ----------------
   Molti provider limitano le richieste al secondo: scorrendo la home o la guida non vanno mandate a raffica. */
const MAX_PARALLEL = 2;
/** oltre questo tempo si smette di aspettare: meglio "riprova" che una schermata bloccata */
const TIMEOUT_MS = 25000;
/** intervallo minimo tra due chiamate: alcuni provider (Cloudflare) bloccano l'IP per minuti dopo una raffica */
const MIN_GAP_MS = 400;
/** le chiamate in background (guida, anteprime) partono al massimo una ogni 2,5 s */
const BG_GAP_MS = 2500;
let lastBg = 0;
/** una richiesta aperta dall'utente aspetta la fine di un blocco solo se è breve */
const MAX_WAIT_MS = 20000;
let running = 0;
let lastStart = 0;
const waiting: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 502-504 e 520-524 = server del provider lento o giù (errori Cloudflare) */
const flaky = (st: number) => (st >= 502 && st <= 504) || (st >= 520 && st <= 524);
/** dopo un 429 nessuna richiesta parte fino a questo istante: insistere allungherebbe il blocco */
// resta valida anche ricaricando la pagina: Cloudflare (errore 1015) può bloccare l'IP per decine di minuti
const COOL_KEY = 'orbita.providerPause';
let coolUntil = (() => {
  try {
    return Number(localStorage.getItem(COOL_KEY)) || 0;
  } catch {
    return 0;
  }
})();
const setCool = (until: number) => {
  coolUntil = Math.max(coolUntil, until);
  try {
    localStorage.setItem(COOL_KEY, String(coolUntil));
  } catch {
    /* storage non disponibile */
  }
};
/** "44 min" o "50 s": per i messaggi di attesa */
export const waitLabel = (sec: number) => (sec >= 120 ? `${Math.ceil(sec / 60)} min` : `${sec} s`);
/** secondi di pausa rimasti dopo un 429 (0 = si può chiedere) */
export const cooldownLeft = () => Math.max(0, Math.ceil((coolUntil - Date.now()) / 1000));
const busy = () => new ApiError(t('err.busy', { s: waitLabel(cooldownLeft()) }), 429);

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fn(ac.signal);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ApiError(t('err.timeout'), 408); // niente secondo tentativo: altri 25 s di attesa sarebbero troppi
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coda delle chiamate al provider. `urgent` = chiesta dall'utente (episodi, scheda): passa davanti
 * a quelle in background (guida dei canali, anteprime della home), che durante un blocco non partono.
 */
async function queued<T>(fn: (signal: AbortSignal) => Promise<T>, urgent = false): Promise<T> {
  const cooling = () => coolUntil - Date.now();
  if (cooling() > (urgent ? MAX_WAIT_MS : 0)) throw busy();
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => (urgent ? waiting.unshift(r) : waiting.push(r)));
  running++;
  try {
    for (let attempt = 0; ; attempt++) {
      if (cooling() > 0) {
        if (!urgent || cooling() > MAX_WAIT_MS) throw busy();
        await sleep(cooling());
      }
      const gap = Math.max(lastStart + MIN_GAP_MS, urgent ? 0 : lastBg + BG_GAP_MS) - Date.now();
      if (gap > 0) await sleep(gap);
      if (!urgent && cooling() > 0) throw busy(); // nel frattempo il provider ha messo in pausa
      lastStart = Date.now();
      if (!urgent) lastBg = lastStart;
      try {
        return await withTimeout(fn);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.status === 429) {
          // si rispetta tutta la pausa chiesta (fino a un'ora): riprovare prima può allungare il blocco
          setCool(Date.now() + Math.min(3600, e.retryAfter || 60) * 1000);
          if (!urgent || attempt >= 1) throw cooling() > 0 ? busy() : e;
        } else if (!flaky(e.status) || !urgent || attempt >= 1) throw e;
        else await sleep(3000);
      }
    }
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const DETAIL_TTL = 15 * 60 * 1000;
const details = new Map<string, { at: number; p: Promise<unknown> }>();
/* Copia sul dispositivo (cifrata: le risposte possono contenere link con credenziali) delle schede
   già aperte: se il provider è lento o giù, la serie si apre lo stesso e si aggiorna appena possibile. */
const SAVED_MAX = 300;
const savedKey = (url: string) => 'xd:' + hash(url);
async function loadSaved<T>(url: string): Promise<T | undefined> {
  try {
    return (await sealGet<{ j: T }>(savedKey(url)))?.j;
  } catch {
    return undefined;
  }
}
async function save(url: string, j: unknown) {
  try {
    const k = savedKey(url);
    await sealSet(k, { j });
    const idx = ((await kv.get<string[]>('xd:index')) || []).filter((x) => x !== k);
    idx.push(k);
    for (const old of idx.splice(0, Math.max(0, idx.length - SAVED_MAX))) await kv.del(old);
    await kv.set('xd:index', idx);
  } catch {
    /* archivio non disponibile: si va avanti senza copia locale */
  }
}

/** stessa richiesta = stessa risposta per qualche minuto (home, scheda e player la condividono);
 *  con `keep` la risposta si salva sul dispositivo e si usa subito alla riapertura */
function detail<T>(url: string, ua?: string, keep = false, background = false): Promise<T> {
  const hit = details.get(url);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.p as Promise<T>;
  const fresh = queued((signal) => fetchJson<T>(url, ua, signal), !background);
  details.set(url, { at: Date.now(), p: fresh });
  fresh.then((j) => void (keep && save(url, j)), () => details.delete(url));
  if (!keep) return fresh;
  // copia locale se c'è (e intanto si aggiorna in background), altrimenti la risposta del provider
  const p = loadSaved<T>(url).then((old) => (old !== undefined ? (fresh.catch(() => {}), old) : fresh));
  details.set(url, { at: Date.now(), p });
  fresh.then((j) => details.set(url, { at: Date.now(), p: Promise.resolve(j) }), () => {});
  return p;
}

/** `background`: chiamata non chiesta dall'utente (anteprime della home), cede il passo e non insiste */
export async function vodInfo(s: XtreamSource, id: number, background = false): Promise<VodInfo> {
  const j = await detail<{ info?: Record<string, unknown> }>(api(s, 'get_vod_info', `&vod_id=${id}`), s.ua, true, background);
  const i = (j?.info || {}) as Record<string, unknown>;
  const bd = Array.isArray(i.backdrop_path) ? (i.backdrop_path[0] as string) : undefined;
  return {
    tmdbId: num(i.tmdb_id) || undefined, plot: str(i.plot || i.description), cast: str(i.cast || i.actors), director: str(i.director), genre: str(i.genre),
    duration: str(i.duration), backdrop: safeImg(bd), trailer: str(i.youtube_trailer), rating: num(i.rating), year: yearOf(str(i.releasedate) ?? ''),
  };
}

export async function seriesInfo(s: XtreamSource, series: Series, background = false): Promise<{ episodes: Episode[]; tmdbId?: number; plot?: string; backdrop?: string; cast?: string; genre?: string }> {
  const j = await detail<{ info?: Record<string, unknown>; episodes?: Record<string, Record<string, unknown>[]> }>(
    api(s, 'get_series_info', `&series_id=${series.xid}`), s.ua, true, background);
  const episodes: Episode[] = [];
  for (const [season, list] of Object.entries(j?.episodes || {})) {
    if (!Array.isArray(list)) continue;
    for (const ep of list) {
      const info = (ep.info || {}) as Record<string, unknown>;
      const xid = Number(ep.id);
      if (!xid) continue;
      episodes.push({
        id: 'e' + xid, xid, season: Number(ep.season ?? season) || 1, episode: Number(ep.episode_num) || episodes.length + 1,
        title: cleanTitle(String(ep.title || '')), ext: /^[a-z0-9]{2,5}$/i.test(String(ep.container_extension)) ? String(ep.container_extension) : 'mp4',
        logo: safeImg(str(info.movie_image)), plot: str(info.plot), duration: str(info.duration),
      });
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const i = (j?.info || {}) as Record<string, unknown>;
  const bd = Array.isArray(i.backdrop_path) ? (i.backdrop_path[0] as string) : undefined;
  return { episodes, tmdbId: num(i.tmdb) || num(i.tmdb_id) || undefined, plot: str(i.plot), backdrop: safeImg(bd), cast: str(i.cast), genre: str(i.genre) };
}

const b64 = (s: string) => {
  try {
    const bin = atob(s);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
};
function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const t = String(v).trim();
  return t ? t : undefined;
}

/** EPG breve (ora/dopo) dal provider. Titoli e descrizioni arrivano in Base64. */
export async function shortEpg(s: XtreamSource, id: number, limit = 12): Promise<EpgItem[]> {
  type R = { epg_listings?: Record<string, string>[] };
  const j = await queued((sig) => fetchJson<R>(api(s, 'get_simple_data_table', `&stream_id=${id}`), s.ua, sig))
    // l'altra azione solo se questa non esiste sul pannello, non se il provider sta limitando le richieste
    .catch((e) => (e instanceof ApiError && (e.status === 429 || e.status === 408 || flaky(e.status)) ? Promise.reject(e)
      : queued((sig) => fetchJson<R>(api(s, 'get_short_epg', `&stream_id=${id}&limit=${limit}`), s.ua, sig))));
  const now = Date.now() / 1000;
  return (j?.epg_listings || [])
    .map((x) => ({
      s: Number(x.start_timestamp), e: Number(x.stop_timestamp),
      t: decodeEntities(b64(x.title || '')), d: decodeEntities(b64(x.description || '')),
    }))
    .filter((x) => x.s && x.e && x.e > x.s && x.e > now - 7 * 86400)
    .sort((a, b) => a.s - b.s);
}
