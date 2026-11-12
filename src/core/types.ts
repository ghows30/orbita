export type Kind = 'live' | 'movie' | 'series';

export interface Channel {
  id: string;
  name: string;
  group: string;
  logo?: string;
  /** URL diretto (solo M3U). Per Xtream l'URL si costruisce al momento con le credenziali. */
  url?: string;
  xid?: number;
  tvgId?: string;
  num?: number;
  /** giorni di archivio (catch-up) */
  archive?: number;
  adult?: boolean;
}

export interface Movie {
  id: string;
  name: string;
  group: string;
  logo?: string;
  url?: string;
  xid?: number;
  ext?: string;
  year?: number;
  rating?: number;
  added?: number;
  adult?: boolean;
}

export interface Episode {
  id: string;
  season: number;
  episode: number;
  title: string;
  url?: string;
  xid?: number;
  ext?: string;
  logo?: string;
  plot?: string;
  duration?: string;
}

export interface Series {
  id: string;
  name: string;
  group: string;
  logo?: string;
  xid?: number;
  year?: number;
  rating?: number;
  added?: number;
  adult?: boolean;
  /** episodi già noti (M3U); per Xtream si caricano a richiesta */
  episodes?: Episode[];
}

export interface Library {
  live: Channel[];
  movies: Movie[];
  series: Series[];
  epgUrls: string[];
  /** fuso orario del server Xtream (per il catch-up) */
  tz?: string;
  expires?: number;
  loadedAt: number;
}

interface SourceBase {
  id: string;
  name: string;
  ua?: string;
  epgUrl?: string;
}
export interface XtreamSource extends SourceBase {
  type: 'xtream';
  host: string;
  user: string;
  pass: string;
  format: 'm3u8' | 'ts';
}
export interface M3uSource extends SourceBase {
  type: 'm3u';
  url: string;
}
export interface FileSource extends SourceBase {
  type: 'file';
  fileName: string;
}
export type Source = XtreamSource | M3uSource | FileSource;

export interface EpgItem {
  s: number;
  e: number;
  t: string;
  d?: string;
}

export interface HistoryEntry {
  key: string; // kind:id
  kind: Kind;
  id: string;
  name: string;
  logo?: string;
  /** per episodi: id serie */
  seriesId?: string;
  pos: number;
  dur: number;
  at: number;
}

export interface PlayRequest {
  kind: Kind | 'episode' | 'catchup';
  title: string;
  subtitle?: string;
  logo?: string;
  url: string;
  /** chiave per riprendi visione */
  resumeKey?: string;
  startAt?: number;
  channel?: Channel;
  series?: Series;
  episode?: Episode;
  /** film (per la schermata di pausa) */
  movie?: Movie;
  live: boolean;
}
