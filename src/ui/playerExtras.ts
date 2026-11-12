// Dati di contorno per i due player (web e nativo): prossimo episodio, fine della sigla
// imparata per serie, schermata di pausa (sfondo, voti, trama).
import { cachedMeta, type Meta } from '../core/meta';
import type { Episode, Movie, PlayRequest, Series } from '../core/types';
import { state } from '../state';
import { metaLine } from './library';

/** Episodio successivo, se l'autoplay è attivo e la serie ne ha un altro. */
export function nextEpisode(req: PlayRequest): Episode | undefined {
  if (req.kind !== 'episode' || !req.series?.episodes || !state.settings.autoNext) return undefined;
  const eps = req.series.episodes;
  const i = eps.findIndex((e) => e.id === req.episode?.id);
  return i < 0 ? undefined : eps[i + 1];
}

export const episodeLabel = (e: Episode) => `S${e.season} E${e.episode}${e.title ? ' · ' + e.title : ''}`;

/* ---------------- sigla: dove finisce, per serie ---------------- */
const introKey = (req: PlayRequest) => (req.kind === 'episode' && req.series ? `orbita.intro.${req.series.id}` : null);

/** Secondi a cui finiva la sigla l'ultima volta (0 = non lo sappiamo ancora). */
export function introEnd(req: PlayRequest): number {
  const k = introKey(req);
  const v = k ? Number(localStorage.getItem(k)) : 0;
  return Number.isFinite(v) && v > 0 && v < 420 ? v : 0;
}

export function saveIntro(req: PlayRequest, sec: number) {
  const k = introKey(req);
  if (k && sec > 0 && sec < 420) localStorage.setItem(k, String(Math.round(sec)));
}

/** Un salto in avanti nei primi minuti di un episodio indica dove finisce la sigla. */
export function learnIntro(req: PlayRequest, from: number, to: number) {
  if (req.kind !== 'episode' || from >= 300 || to > 420 || to - from < 20) return;
  saveIntro(req, to);
}

/* ---------------- schermata di pausa ---------------- */
/** Trama e sfondo del provider (Xtream) letti nella scheda del titolo, per non richiederli di nuovo. */
const provInfo = new Map<string, { plot?: string; backdrop?: string }>();
export const rememberInfo = (key: string, i: { plot?: string; backdrop?: string }) => provInfo.set(key, i);

export interface PauseInfo {
  title: string;
  line: string;
  plot: string;
  backdrop?: string;
  meta?: Meta;
  item?: Movie | Series;
  /** voti in una riga, per il player nativo */
  ratings: string;
}

export function pauseInfo(req: PlayRequest): PauseInfo {
  const item: Movie | Series | undefined = req.kind === 'episode' ? req.series : req.movie;
  const kind = req.kind === 'episode' ? 'series' : 'movie';
  const meta = item ? cachedMeta(kind, item) : undefined;
  const prov = item ? provInfo.get(`${kind}:${item.id}`) : undefined;
  const ep = req.kind === 'episode' ? req.episode : undefined;
  const line = ep ? episodeLabel(ep) : item ? metaLine(item, meta) : req.subtitle || '';
  const plot = ep?.plot || prov?.plot || meta?.overview || '';
  const r: string[] = [];
  if (meta?.imdb) r.push(`IMDb ${meta.imdb.toFixed(1)}`);
  if (meta?.rt) r.push(`Rotten Tomatoes ${meta.rt}%`);
  if (meta?.tmdb) r.push(`TMDB ${meta.tmdb.toFixed(1)}`);
  if (!r.length && item?.rating) r.push(`★ ${(item.rating > 10 ? item.rating / 10 : item.rating).toFixed(1)}`);
  return {
    title: item?.name || req.title,
    line,
    plot,
    backdrop: prov?.backdrop || meta?.backdrop || ep?.logo,
    meta,
    item,
    ratings: r.join('   ·   '),
  };
}
