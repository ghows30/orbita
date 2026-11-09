import { t } from '../i18n';
import type { Channel, Episode, Library, Movie, Series } from './types';
import { cleanTitle, decodeEntities, hash, isAdult } from './util';

const ATTR = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const VIDEO_FILE = /\.(mp4|mkv|avi|mov|wmv|m4v|webm)(\?|$)/i;
const VOD_GROUP = /\b(vod|movies?|film[s]?|cinema)\b/i;
const SE = /^(.*?)[\s._-]*S(\d{1,2})\s*E(\d{1,3})\b/i;
const SEPARATOR = /^\s*(\*{3}|-{3}|={3}|#{3}|_{3})/;

export interface ExtInf {
  attrs: Record<string, string>;
  name: string;
}

/** Divide una riga #EXTINF in attributi e titolo; la virgola di separazione è la prima fuori dalle virgolette. */
export function parseExtInf(line: string): ExtInf {
  const body = line.slice(line.indexOf(':') + 1);
  let inQ = false;
  let split = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) {
      split = i;
      break;
    }
  }
  const head = split >= 0 ? body.slice(0, split) : body;
  const name = split >= 0 ? body.slice(split + 1).trim() : '';
  const attrs: Record<string, string> = {};
  for (const m of head.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
  return { attrs, name: decodeEntities(name || attrs['tvg-name'] || '') };
}

export function classify(url: string, name: string, group: string): 'live' | 'movie' | 'series' {
  if (/\/series\//i.test(url) || SE.test(name)) return 'series';
  if (/\/movie\//i.test(url) || VIDEO_FILE.test(url) || VOD_GROUP.test(group)) return 'movie';
  return 'live';
}

const isHttp = (u: string) => /^https?:\/\/\S+$/i.test(u);

export function parseM3u(text: string): Library {
  const live: Channel[] = [];
  const movies: Movie[] = [];
  const seriesMap = new Map<string, Series>();
  const epgUrls: string[] = [];

  let cur: ExtInf | null = null;
  let extGroup = '';
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXTM3U')) {
      const h = parseExtInf('#EXTM3U:' + l.slice(7) + ',');
      for (const k of ['url-tvg', 'x-tvg-url']) {
        if (h.attrs[k]) epgUrls.push(...h.attrs[k].split(',').map((s) => s.trim()).filter(isHttp));
      }
      continue;
    }
    if (l.startsWith('#EXTINF')) {
      cur = parseExtInf(l);
      extGroup = '';
      continue;
    }
    if (l.startsWith('#EXTGRP:')) {
      extGroup = l.slice(8).trim();
      continue;
    }
    if (l.startsWith('#')) continue;
    if (!cur) continue;
    const url = l;
    const info = cur;
    cur = null;
    if (!isHttp(url) || SEPARATOR.test(info.name) || !info.name) continue;

    const a = info.attrs;
    const group = decodeEntities(a['group-title'] || extGroup || t('common.other'));
    const logo = isHttp(a['tvg-logo'] || '') ? a['tvg-logo'] : undefined;
    const kind = classify(url, info.name, group);
    const adult = isAdult(group, info.name) || undefined;

    if (kind === 'live') {
      const days = Number(a['catchup-days'] || a['timeshift'] || a['tvg-rec'] || 0);
      live.push({
        id: 'm' + hash(url),
        name: info.name,
        group,
        logo,
        url,
        tvgId: a['tvg-id'] || undefined,
        num: a['tvg-chno'] ? Number(a['tvg-chno']) || undefined : undefined,
        archive: days > 0 ? Math.min(days, 14) : undefined,
        adult,
      });
    } else if (kind === 'movie') {
      const y = /\((19|20)\d{2}\)/.exec(info.name);
      movies.push({ id: 'm' + hash(url), name: cleanTitle(info.name), group, logo, url, year: y ? Number(y[0].slice(1, 5)) : undefined, adult });
    } else {
      const m = SE.exec(info.name);
      const title = cleanTitle((m ? m[1] : info.name).trim() || info.name);
      const key = (group + '|' + title).toLowerCase();
      let s = seriesMap.get(key);
      if (!s) {
        s = { id: 's' + hash(key), name: title, group, logo, episodes: [], adult };
        seriesMap.set(key, s);
      }
      const ep: Episode = {
        id: 'e' + hash(url),
        season: m ? Number(m[2]) : 1,
        episode: m ? Number(m[3]) : s.episodes!.length + 1,
        title: info.name,
        url,
        logo,
      };
      s.episodes!.push(ep);
    }
  }
  const series = [...seriesMap.values()];
  for (const s of series) s.episodes!.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { live, movies, series, epgUrls: [...new Set(epgUrls)], loadedAt: Date.now() };
}
