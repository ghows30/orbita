import { t } from '../i18n';
import { fetchJson } from './api';
import type { Channel, EpgItem, Episode, Library, Movie, Series, XtreamSource } from './types';
import { cleanTitle, decodeEntities, isAdult } from './util';

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

export async function vodInfo(s: XtreamSource, id: number): Promise<VodInfo> {
  const j = await fetchJson<{ info?: Record<string, unknown> }>(api(s, 'get_vod_info', `&vod_id=${id}`), s.ua);
  const i = (j?.info || {}) as Record<string, unknown>;
  const bd = Array.isArray(i.backdrop_path) ? (i.backdrop_path[0] as string) : undefined;
  return {
    tmdbId: num(i.tmdb_id) || undefined, plot: str(i.plot || i.description), cast: str(i.cast || i.actors), director: str(i.director), genre: str(i.genre),
    duration: str(i.duration), backdrop: safeImg(bd), trailer: str(i.youtube_trailer), rating: num(i.rating), year: yearOf(str(i.releasedate) ?? ''),
  };
}

export async function seriesInfo(s: XtreamSource, series: Series): Promise<{ episodes: Episode[]; tmdbId?: number; plot?: string; backdrop?: string; cast?: string; genre?: string }> {
  const j = await fetchJson<{ info?: Record<string, unknown>; episodes?: Record<string, Record<string, unknown>[]> }>(
    api(s, 'get_series_info', `&series_id=${series.xid}`), s.ua);
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
  const j = await fetchJson<{ epg_listings?: Record<string, string>[] }>(api(s, 'get_simple_data_table', `&stream_id=${id}`), s.ua)
    .catch(() => fetchJson<{ epg_listings?: Record<string, string>[] }>(api(s, 'get_short_epg', `&stream_id=${id}&limit=${limit}`), s.ua));
  const now = Date.now() / 1000;
  return (j?.epg_listings || [])
    .map((x) => ({
      s: Number(x.start_timestamp), e: Number(x.stop_timestamp),
      t: decodeEntities(b64(x.title || '')), d: decodeEntities(b64(x.description || '')),
    }))
    .filter((x) => x.s && x.e && x.e > x.s && x.e > now - 7 * 86400)
    .sort((a, b) => a.s - b.s);
}
