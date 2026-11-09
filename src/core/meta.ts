// Dati extra su film e serie: voti, sfondi, trame tradotte, generi.
// Fonti (tutte facoltative, in ordine): provider Xtream, TMDB (chiave v3), OMDb (voti IMDb e Rotten Tomatoes).
// Le chiamate passano dalla stessa strada delle playlist (server locale o codice nativo); i risultati
// restano in cache su IndexedDB per non ripetere le richieste a ogni avvio.
import { fetchJson } from './api';
import { kv, sealGet, sealSet } from './store';
import type { Movie, Series } from './types';
import { cleanTitle } from './util';

export type MetaKind = 'movie' | 'series';

export interface Meta {
  tmdbId?: number;
  imdbId?: string;
  title?: string;
  overview?: string;
  tagline?: string;
  genres?: string[];
  /** minuti */
  runtime?: number;
  seasons?: number;
  year?: number;
  backdrop?: string;
  poster?: string;
  /** voti su 10 (rt in percentuale) */
  tmdb?: number;
  imdb?: number;
  rt?: number;
  /** OMDb già interrogato (anche senza esito) */
  omdbDone?: boolean;
}

export interface MetaKeys {
  tmdb?: string;
  omdb?: string;
}

const TTL = 21 * 86400_000;
const TTL_MISS = 3 * 86400_000;
const IMG = 'https://image.tmdb.org/t/p/';

let keys: MetaKeys = {};
let lang = 'en-GB';
const mem = new Map<string, Meta>();
const pending = new Map<string, Promise<Meta>>();
const listeners = new Set<() => void>();

export async function loadMetaKeys() {
  keys = (await sealGet<MetaKeys>('metaKeys').catch(() => undefined)) || {};
}
export const metaKeys = (): MetaKeys => ({ ...keys });
export const hasMetaKeys = () => !!(keys.tmdb || keys.omdb);
export async function saveMetaKeys(k: MetaKeys) {
  keys = { tmdb: k.tmdb?.trim() || undefined, omdb: k.omdb?.trim() || undefined };
  await sealSet('metaKeys', keys);
  mem.clear();
}
/** Lingua delle trame TMDB (it-IT, en-GB, …). */
export function setMetaLang(l: string) {
  if (l !== lang) mem.clear();
  lang = l;
}
/** Avvisa quando arrivano dati nuovi (per aggiornare voti nelle card). */
export const onMeta = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));

/** Titolo pulito per la ricerca: niente anno, qualità, tag di lingua. */
export function searchTitle(name: string): { title: string; year?: number } {
  let s = cleanTitle(name);
  const y = /[([]\s*((?:19|20)\d{2})\s*[)\]]|\s-\s((?:19|20)\d{2})\b|\s((?:19|20)\d{2})$/.exec(s);
  const year = y ? Number(y[1] || y[2] || y[3]) : undefined;
  s = s
    .replace(/[([]\s*(?:19|20)\d{2}\s*[)\]]/g, ' ')
    .replace(/\s-\s(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s(?:19|20)\d{2}$/, ' ')
    .replace(/\b(?:4k|uhd|fhd|hd|sd|hevc|h\.?26[45]|x26[45]|1080p|720p|2160p|multi|sub(?:bed|s)?|ita|eng|vost\w*)\b/gi, ' ')
    .replace(/[[\]()|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { title: s || cleanTitle(name), year };
}

const keyOf = (kind: MetaKind, name: string, year?: number) => {
  const q = searchTitle(name);
  return `meta:${lang}:${kind}:${q.title.toLowerCase()}:${year || q.year || ''}`;
};

/** Valore già in memoria (sincrono): per disegnare subito ciò che si sa. */
export function cachedMeta(kind: MetaKind, x: Movie | Series): Meta | undefined {
  return mem.get(keyOf(kind, x.name, x.year));
}

/** Voto principale da mostrare: IMDb, poi TMDB, poi quello del provider. */
export function bestRating(x: { rating?: number }, m?: Meta): { value: number; src: 'imdb' | 'tmdb' | 'provider' } | undefined {
  if (m?.imdb) return { value: m.imdb, src: 'imdb' };
  if (m?.tmdb) return { value: m.tmdb, src: 'tmdb' };
  if (x.rating) return { value: x.rating > 10 ? x.rating / 10 : x.rating, src: 'provider' };
  return undefined;
}

/** Porta in memoria i dati già in cache su disco (nessuna richiesta di rete). */
export async function warmMeta(items: { kind: MetaKind; x: Movie | Series }[]): Promise<number> {
  let n = 0;
  await Promise.all(items.map(async ({ kind, x }) => {
    const k = keyOf(kind, x.name, x.year);
    if (mem.has(k)) return;
    const saved = await kv.get<{ at: number; m: Meta }>(k).catch(() => undefined);
    if (saved && Date.now() - saved.at < TTL) (mem.set(k, saved.m), n++);
  }));
  return n;
}

/* ---------------- coda: poche richieste in parallelo ---------------- */
let running = 0;
const queue: (() => void)[] = [];
function limited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      fn().then(resolve, reject).finally(() => {
        running--;
        queue.shift()?.();
      });
    };
    if (running < 4) run();
    else queue.push(run);
  });
}

/* ---------------- TMDB ---------------- */
interface TmdbHit { id: number; title?: string; name?: string; release_date?: string; first_air_date?: string; popularity?: number }
async function tmdb<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const q = new URLSearchParams({ api_key: keys.tmdb!, language: lang });
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  return limited(() => fetchJson<T>(`https://api.themoviedb.org/3/${path}?${q}`));
}

async function tmdbFind(kind: MetaKind, name: string, year?: number): Promise<number | undefined> {
  const { title, year: y2 } = searchTitle(name);
  const yr = year || y2;
  const type = kind === 'movie' ? 'movie' : 'tv';
  const yearKey = kind === 'movie' ? 'year' : 'first_air_date_year';
  let r = await tmdb<{ results?: TmdbHit[] }>(`search/${type}`, { query: title, [yearKey]: yr, include_adult: 'false' });
  if (!r.results?.length && yr) r = await tmdb<{ results?: TmdbHit[] }>(`search/${type}`, { query: title, include_adult: 'false' });
  return r.results?.[0]?.id;
}

async function tmdbDetails(kind: MetaKind, id: number): Promise<Meta> {
  const d = await tmdb<Record<string, unknown>>(`${kind === 'movie' ? 'movie' : 'tv'}/${id}`, { append_to_response: 'external_ids' });
  const ext = (d.external_ids || {}) as Record<string, unknown>;
  const date = String(d.release_date || d.first_air_date || '');
  const run = kind === 'movie' ? Number(d.runtime) : Number((d.episode_run_time as number[] | undefined)?.[0]);
  const vote = Number(d.vote_average);
  return {
    tmdbId: id,
    imdbId: String(d.imdb_id || ext.imdb_id || '') || undefined,
    title: String(d.title || d.name || '') || undefined,
    overview: String(d.overview || '') || undefined,
    tagline: String(d.tagline || '') || undefined,
    genres: Array.isArray(d.genres) ? (d.genres as { name: string }[]).map((g) => g.name).slice(0, 3) : undefined,
    runtime: run > 0 ? run : undefined,
    seasons: Number(d.number_of_seasons) || undefined,
    year: Number(date.slice(0, 4)) || undefined,
    backdrop: d.backdrop_path ? IMG + 'w1280' + d.backdrop_path : undefined,
    poster: d.poster_path ? IMG + 'w500' + d.poster_path : undefined,
    tmdb: vote > 0 && Number(d.vote_count) >= 5 ? Math.round(vote * 10) / 10 : undefined,
  };
}

/* ---------------- OMDb ---------------- */
async function omdb(kind: MetaKind, m: Meta, name: string, year?: number): Promise<Partial<Meta>> {
  const q = new URLSearchParams({ apikey: keys.omdb! });
  if (m.imdbId) q.set('i', m.imdbId);
  else {
    const s = searchTitle(m.title || name);
    q.set('t', s.title);
    q.set('type', kind === 'movie' ? 'movie' : 'series');
    if (year || s.year) q.set('y', String(year || s.year));
  }
  const r = await limited(() => fetchJson<Record<string, unknown>>(`https://www.omdbapi.com/?${q}`));
  if (r.Response === 'False') return {};
  const imdb = Number(r.imdbRating);
  const rt = (r.Ratings as { Source: string; Value: string }[] | undefined)?.find((x) => x.Source === 'Rotten Tomatoes');
  return {
    imdbId: m.imdbId || String(r.imdbID || '') || undefined,
    imdb: imdb > 0 ? imdb : undefined,
    rt: rt ? parseInt(rt.Value, 10) || undefined : undefined,
  };
}

/**
 * Dati extra di un titolo. `full` interroga anche OMDb (limite giornaliero basso: solo per vetrina e schede).
 * `tmdbId` arriva dal provider Xtream quando lo conosce, e fa saltare la ricerca per titolo.
 */
export async function getMeta(kind: MetaKind, x: Movie | Series, opts: { full?: boolean; tmdbId?: number } = {}): Promise<Meta> {
  const k = keyOf(kind, x.name, x.year);
  const have = mem.get(k);
  if (have && (!opts.full || have.omdbDone || !keys.omdb)) return have;
  if (!hasMetaKeys()) return have || {};
  const p = pending.get(k + (opts.full ? ':full' : ''));
  if (p) return p;
  const job = (async () => {
    let m: Meta | undefined = have;
    if (!m) {
      const saved = await kv.get<{ at: number; m: Meta }>(k).catch(() => undefined);
      if (saved && Date.now() - saved.at < (saved.m.tmdbId || saved.m.imdb ? TTL : TTL_MISS)) m = saved.m;
    }
    let changed = false;
    if (!m) {
      m = {};
      if (keys.tmdb) {
        try {
          const id = opts.tmdbId || (await tmdbFind(kind, x.name, x.year));
          if (id) m = await tmdbDetails(kind, id);
        } catch {
          /* titolo non trovato o chiave errata: si prosegue */
        }
      }
      changed = true;
    }
    if (opts.full && keys.omdb && !m.omdbDone) {
      try {
        m = { ...m, ...(await omdb(kind, m, x.name, x.year)) };
      } catch {
        /* limite raggiunto o chiave errata */
      }
      m.omdbDone = true;
      changed = true;
    }
    mem.set(k, m);
    if (changed) kv.set(k, { at: Date.now(), m }).catch(() => {});
    listeners.forEach((f) => f());
    return m;
  })();
  pending.set(k + (opts.full ? ':full' : ''), job);
  try {
    return await job;
  } finally {
    pending.delete(k + (opts.full ? ':full' : ''));
  }
}

/** Prova delle chiavi dalle Impostazioni: true/false per ciascuna inserita. */
export async function testMetaKeys(k: MetaKeys): Promise<{ tmdb?: boolean; omdb?: boolean }> {
  const out: { tmdb?: boolean; omdb?: boolean } = {};
  if (k.tmdb) out.tmdb = await fetchJson<{ success?: boolean; status_code?: number }>(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(k.tmdb.trim())}`)
    .then((r) => !!r && r.success !== false && !r.status_code, () => false);
  if (k.omdb) out.omdb = await fetchJson<{ Response?: string }>(`https://www.omdbapi.com/?apikey=${encodeURIComponent(k.omdb.trim())}&i=tt0111161`)
    .then((r) => r.Response === 'True', () => false);
  return out;
}
