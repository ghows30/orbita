import { locale, t } from './i18n';
import { loadMetaKeys, setMetaLang } from './core/meta';
import { fetchEpg, fetchText } from './core/api';
import { parseM3u } from './core/m3u';
import { checkPin, hashPin, kv, sealGet, sealSet, type PinHash } from './core/store';
import type { Channel, EpgItem, Episode, HistoryEntry, Kind, Library, Movie, Source, XtreamSource } from './core/types';
import { episodeUrl, liveUrl, loadXtream, movieUrl, shortEpg } from './core/xtream';

export interface Settings {
  parental: boolean;
  pin?: PinHash;
  autoNext: boolean;
  /** anteprime dei fotogrammi durante la ricerca in film ed episodi */
  seekPreview?: boolean;
  activeSource?: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((f) => f());

export const state = {
  sources: [] as Source[],
  lib: null as Library | null,
  settings: { parental: true, autoNext: true } as Settings,
  favorites: new Set<string>(),
  history: [] as HistoryEntry[],
  unlocked: false,
  epg: new Map<string, EpgItem[]>(),
  epgStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
};

export const active = (): Source | undefined =>
  state.sources.find((s) => s.id === state.settings.activeSource) || state.sources[0];

export async function init(): Promise<void> {
  state.sources = (await sealGet<Source[]>('sources')) || [];
  state.settings = { ...state.settings, ...((await kv.get<Settings>('settings')) || {}) };
  state.favorites = new Set((await kv.get<string[]>('favorites')) || []);
  state.history = (await kv.get<HistoryEntry[]>('history')) || [];
  setMetaLang(locale());
  await loadMetaKeys().catch(() => {});
  const src = active();
  if (src) state.lib = (await sealGet<Library>('lib:' + src.id)) || null;
}

export async function saveSettings() {
  await kv.set('settings', state.settings);
  emit();
}

/* ---------------- fonti ---------------- */
export async function addSource(src: Source, lib: Library) {
  state.sources = [...state.sources.filter((s) => s.id !== src.id), src];
  await sealSet('sources', state.sources);
  await sealSet('lib:' + src.id, lib);
  state.settings.activeSource = src.id;
  state.lib = lib;
  state.epg.clear();
  state.epgStatus = 'idle';
  await saveSettings();
}

export async function removeSource(id: string) {
  state.sources = state.sources.filter((s) => s.id !== id);
  await sealSet('sources', state.sources);
  await kv.del('lib:' + id);
  if (state.settings.activeSource === id) {
    state.settings.activeSource = state.sources[0]?.id;
    state.lib = state.sources[0] ? (await sealGet<Library>('lib:' + state.sources[0].id)) || null : null;
  }
  state.epg.clear();
  await saveSettings();
}

export async function switchSource(id: string) {
  state.settings.activeSource = id;
  state.lib = (await sealGet<Library>('lib:' + id)) || null;
  state.epg.clear();
  state.epgStatus = 'idle';
  await saveSettings();
}

export async function loadLibrary(src: Source, onStep?: (m: string) => void, fileText?: string): Promise<Library> {
  if (src.type === 'xtream') return loadXtream(src, onStep);
  onStep?.(t('step.playlist'));
  const text = src.type === 'file' ? fileText ?? '' : await fetchText(src.url, src.ua);
  if (!/#EXTM3U|#EXTINF/i.test(text.slice(0, 4096))) throw new Error(t('err.notM3u'));
  onStep?.(t('step.parse'));
  await new Promise((r) => setTimeout(r, 0));
  return parseM3u(text);
}

export async function refreshActive(onStep?: (m: string) => void) {
  const src = active();
  if (!src || src.type === 'file') return;
  const lib = await loadLibrary(src, onStep);
  await addSource(src, lib);
}

/* ---------------- preferiti / cronologia ---------------- */
export const favKey = (kind: Kind, id: string) => `${kind}:${id}`;
export const isFav = (kind: Kind, id: string) => state.favorites.has(favKey(kind, id));
export async function toggleFav(kind: Kind, id: string) {
  const k = favKey(kind, id);
  state.favorites.has(k) ? state.favorites.delete(k) : state.favorites.add(k);
  await kv.set('favorites', [...state.favorites]);
  emit();
}

let histTimer: ReturnType<typeof setTimeout> | undefined;
export function recordProgress(e: Omit<HistoryEntry, 'at'>) {
  state.history = [{ ...e, at: Date.now() }, ...state.history.filter((h) => h.key !== e.key)].slice(0, 200);
  clearTimeout(histTimer);
  histTimer = setTimeout(() => kv.set('history', state.history), 800);
}
export const progressOf = (key: string) => state.history.find((h) => h.key === key);
export async function clearHistory() {
  state.history = [];
  await kv.set('history', []);
  emit();
}

/* ---------------- controllo parentale ---------------- */
export const hidden = (x: { adult?: boolean }) => !!x.adult && state.settings.parental && !state.unlocked;
export async function setPin(pin: string) {
  state.settings.pin = await hashPin(pin);
  await saveSettings();
}
export async function unlock(pin: string): Promise<boolean> {
  if (!state.settings.pin) return false;
  const ok = await checkPin(pin, state.settings.pin);
  if (ok) {
    state.unlocked = true;
    emit();
  }
  return ok;
}

/* ---------------- URL di riproduzione ---------------- */
const xs = () => {
  const s = active();
  return s?.type === 'xtream' ? (s as XtreamSource) : undefined;
};
export function channelUrl(c: Channel, fmt?: 'm3u8' | 'ts'): string {
  const s = xs();
  return s && c.xid ? liveUrl(s, c.xid, fmt) : c.url!;
}
export function movieStreamUrl(m: Movie): string {
  const s = xs();
  return s && m.xid ? movieUrl(s, m.xid, m.ext) : m.url!;
}
export function episodeStreamUrl(e: Episode): string {
  const s = xs();
  return s && e.xid ? episodeUrl(s, e.xid, e.ext) : e.url!;
}

/* ---------------- EPG ---------------- */
export async function loadGuide(): Promise<void> {
  const src = active();
  const lib = state.lib;
  if (!src || !lib || state.epgStatus === 'loading' || state.epgStatus === 'ready') return;
  const urls = [src.epgUrl, ...lib.epgUrls].filter((u): u is string => !!u);
  const ids = [...new Set(lib.live.map((c) => c.tvgId?.toLowerCase()).filter((x): x is string => !!x))];
  if (!urls.length || !ids.length) {
    state.epgStatus = 'ready';
    return;
  }
  state.epgStatus = 'loading';
  emit();
  for (const u of urls.slice(0, 3)) {
    try {
      const data = await fetchEpg(u, ids, src.ua);
      for (const [k, v] of Object.entries(data)) if (!state.epg.has(k)) state.epg.set(k, v);
    } catch {
      /* guida opzionale: si prosegue */
    }
  }
  state.epgStatus = state.epg.size ? 'ready' : 'error';
  emit();
}

const shortCache = new Map<string, { at: number; items: EpgItem[] }>();
export async function epgFor(c: Channel): Promise<EpgItem[]> {
  const fromGuide = c.tvgId ? state.epg.get(c.tvgId.toLowerCase()) : undefined;
  if (fromGuide?.length) return fromGuide;
  const s = xs();
  if (!s || !c.xid) return [];
  const hit = shortCache.get(c.id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.items;
  const items = await shortEpg(s, c.xid).catch(() => []);
  shortCache.set(c.id, { at: Date.now(), items });
  return items;
}
export function nowNext(items: EpgItem[], t = Date.now() / 1000): { now?: EpgItem; next?: EpgItem } {
  const i = items.findIndex((x) => x.s <= t && x.e > t);
  if (i < 0) return { next: items.find((x) => x.s > t) };
  return { now: items[i], next: items[i + 1] };
}

export { emit };
