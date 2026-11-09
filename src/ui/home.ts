// Home: vetrina a tutto schermo che ruota tra i titoli in evidenza, poi file orizzontali.
// I dati extra (voti, sfondi, trame) arrivano da provider/TMDB/OMDb e si aggiungono man mano.
import { img } from '../core/api';
import { getMeta, cachedMeta, hasMetaKeys, onMeta, warmMeta, type Meta } from '../core/meta';
import type { Channel, EpgItem, Movie } from '../core/types';
import { clock, debounce, fmtTime } from '../core/util';
import { seriesInfo, vodInfo } from '../core/xtream';
import { t } from '../i18n';
import { active, epgFor, hidden, isFav, loadGuide, nowNext, onChange, state, toggleFav } from '../state';
import { clear, h, icon, thumb } from './dom';
import { isSeries, kindOf, metaLine, openMovie, openSeries, poster, rail, ratingChips, type Item } from './library';
import { channelRequest, play } from './player';

const ROTATE_MS = 9000;
const open = (x: Item) => (isSeries(x) ? openSeries(x) : openMovie(x as Movie));

/** Dati del provider Xtream per la vetrina (sfondo, trama, id TMDB), una richiesta per titolo. */
interface ProvInfo { backdrop?: string; plot?: string; tmdbId?: number }
const providerInfo = new Map<string, Promise<ProvInfo>>();
function fromProvider(x: Item): Promise<ProvInfo> {
  const src = active();
  if (src?.type !== 'xtream' || !x.xid) return Promise.resolve<ProvInfo>({});
  let p = providerInfo.get(x.id);
  if (!p) {
    p = (isSeries(x) ? seriesInfo(src, x).then((i) => ((x.episodes = i.episodes), i)) : vodInfo(src, x.xid))
      .then((i) => ({ backdrop: i.backdrop, plot: i.plot, tmdbId: i.tmdbId }))
      .catch((): ProvInfo => ({}));
    providerInfo.set(x.id, p);
  }
  return p;
}

/* ---------------- vetrina ---------------- */
function hero(picks: Item[]): HTMLElement | null {
  if (!picks.length) return null;
  let idx = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  const bgA = h('div', { class: 'hero2-bg' });
  const bgB = h('div', { class: 'hero2-bg' });
  let front = bgA;
  const body = h('div', { class: 'hero2-body' });
  const side = h('div', { class: 'hero2-poster' });
  const dots = h('div', { class: 'hero2-dots', 'aria-hidden': 'true' });
  const root = h('section', { class: 'hero2' }, bgA, bgB, h('div', { class: 'hero2-shade' }), side, body, dots);

  const setBg = (url: string | undefined, posterMode: boolean) => {
    const back = front === bgA ? bgB : bgA;
    clear(back);
    if (url) {
      const im = h('img', { src: img(url)!, alt: '', referrerPolicy: 'no-referrer', decoding: 'async' });
      im.addEventListener('load', () => {
        back.classList.add('on');
        front.classList.remove('on');
        front = back;
      });
      back.appendChild(im);
    } else {
      front.classList.remove('on');
    }
    root.classList.toggle('poster-mode', posterMode);
  };

  const paint = (x: Item, m: Meta | undefined, extra: { backdrop?: string; plot?: string }) => {
    const backdrop = extra.backdrop || m?.backdrop;
    const art = x.logo || m?.poster;
    setBg(backdrop || art, !backdrop);
    side.replaceChildren(...(!backdrop && art ? [thumb(img(art), x.name, 'poster')] : []));
    const plot = extra.plot || m?.overview;
    const fav = isFav(kindOf(x), x.id);
    const favBtn = h('button', { class: 'btn ghost lg icon-only', title: fav ? t('lib.inMyList') : t('lib.myList'), 'aria-label': t('lib.myList'), 'aria-pressed': String(fav),
      on: { click: async () => { await toggleFav(kindOf(x), x.id); paint(x, m, extra); body.querySelector<HTMLElement>('.icon-only')?.focus(); } } },
    icon(fav ? 'check' : 'plus', 20));
    body.replaceChildren(
      h('span', { class: 'eyebrow' }, isSeries(x) ? t('home.featuredSeries') : t('home.featuredMovie')),
      h('h1', { class: 'hero2-title' }, m?.title && m.title.length < x.name.length + 6 ? m.title : x.name),
      h('div', { class: 'hero2-meta' }, metaLine(x, m)),
      ratingChips(x, m) || '',
      plot ? h('p', { class: 'hero2-plot' }, plot) : '',
      h('div', { class: 'row gap hero2-actions' },
        h('button', { class: 'btn primary lg', on: { click: () => open(x) } }, icon('play', 20), t('home.watchNow')),
        h('button', { class: 'btn ghost lg', on: { click: () => open(x) } }, icon('info', 20), t('home.moreInfo')),
        favBtn));
    body.classList.remove('in');
    void body.offsetWidth; // riavvia l'animazione di entrata
    body.classList.add('in');
  };

  const show = async (i: number) => {
    idx = (i + picks.length) % picks.length;
    const x = picks[idx];
    dots.replaceChildren(...picks.map((_, k) => h('i', { class: k === idx ? 'on' : '', on: { click: () => (show(k), schedule()) } })));
    paint(x, cachedMeta(kindOf(x), x), {});
    const extra = await fromProvider(x);
    const m = await getMeta(kindOf(x), x, { full: true, tmdbId: extra.tmdbId }).catch(() => undefined);
    if (picks[idx] === x && root.isConnected) {
      const focusIn = root.contains(document.activeElement);
      const which = focusIn ? [...body.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement) : -1;
      paint(x, m, extra);
      if (which >= 0) body.querySelectorAll('button')[which]?.focus();
    }
    // prepara il prossimo titolo in anticipo
    const nx = picks[(idx + 1) % picks.length];
    if (nx !== x) fromProvider(nx).then((e) => getMeta(kindOf(nx), nx, { full: true, tmdbId: e.tmdbId })).catch(() => {});
  };
  const schedule = () => {
    clearTimeout(timer);
    if (picks.length < 2) return;
    timer = setTimeout(() => {
      if (!root.isConnected) return;
      if (!paused && !document.hidden) show(idx + 1);
      schedule();
    }, ROTATE_MS);
  };
  root.addEventListener('mouseenter', () => (paused = true));
  root.addEventListener('mouseleave', () => (paused = false));
  root.addEventListener('focusin', () => (paused = true));
  root.addEventListener('focusout', () => (paused = false));
  show(0);
  schedule();
  return root;
}

/* ---------------- canali in onda ---------------- */
function onAirRow(channels: Channel[]): HTMLElement | null {
  if (!channels.length) return null;
  const tiles = channels.map((c) => {
    const now = h('div', { class: 'air-now' }, c.group);
    const bar = h('div', { class: 'mini-bar' }, h('i'));
    const time = h('span', { class: 'air-time' });
    const tile = h('button', { class: 'air-tile', on: { click: () => play(channelRequest(c), channels) } },
      thumb(img(c.logo), c.name, 'ch-logo lg'),
      h('div', { class: 'air-text' }, h('div', { class: 'air-name' }, c.name, time), now, bar));
    const fill = (items: EpgItem[]) => {
      const { now: n, next } = nowNext(items);
      if (!n) return;
      now.textContent = n.t;
      time.textContent = `${clock(n.s)}–${clock(n.e)}`;
      (bar.firstChild as HTMLElement).style.width = Math.min(100, ((Date.now() / 1000 - n.s) / (n.e - n.s)) * 100) + '%';
      tile.classList.add('has-epg');
      tile.title = next ? `${t('pl.next')}${clock(next.s)} ${next.t}` : '';
    };
    epgFor(c).then(fill).catch(() => {});
    return Object.assign(tile, { fill: () => epgFor(c).then(fill).catch(() => {}) });
  });
  const row = rail(t('home.onAirNow'), tiles);
  if (row) {
    row.classList.add('rail-air');
    const off = onChange(() => {
      if (!row.isConnected) return off();
      if (state.epgStatus === 'ready') tiles.forEach((x) => x.fill());
    });
    setTimeout(() => loadGuide(), 0);
  }
  return row;
}

/* ---------------- continua a guardare ---------------- */
function continueRow(byId: Map<string, Item>): HTMLElement | null {
  const cards = state.history.filter((x) => x.dur && x.pos / x.dur < 0.95).slice(0, 20).map((x) => {
    const target = x.kind === 'movie' ? byId.get(x.id) : x.seriesId ? byId.get(x.seriesId) : undefined;
    if (!target) return null;
    const m = cachedMeta(kindOf(target), target);
    const bar = h('div', { class: 'card-progress' }, h('i'));
    (bar.firstChild as HTMLElement).style.width = `${(x.pos / x.dur) * 100}%`;
    return h('button', { class: 'card wide', on: { click: () => open(target) } },
      h('div', { class: 'card-art' }, thumb(img(m?.backdrop || x.logo || target.logo), x.name, 'poster wide'), bar,
        h('span', { class: 'play-over' }, icon('play', 26))),
      h('div', { class: 'card-title' }, x.name), h('div', { class: 'card-meta' }, t('lib.left', { t: fmtTime(x.dur - x.pos) })));
  }).filter((x): x is HTMLButtonElement => !!x);
  return rail(t('home.continue'), cards);
}

/* ---------------- vista ---------------- */
export function homeView(go: (r: string) => void): HTMLElement {
  const lib = state.lib!;
  const movies = lib.movies.filter((m) => !hidden(m));
  const series = lib.series.filter((m) => !hidden(m));
  const live = lib.live.filter((c) => !hidden(c));
  const all: Item[] = [...movies, ...series];
  const byId = new Map<string, Item>(all.map((x) => [x.id, x]));
  const score = (x: Item) => {
    const m = cachedMeta(kindOf(x), x);
    return m?.imdb || m?.tmdb || (x.rating && x.rating > 10 ? x.rating / 10 : x.rating) || 0;
  };
  const recent = (xs: Item[]) => (xs.some((x) => x.added) ? xs.slice().sort((a, b) => (b.added || 0) - (a.added || 0)) : xs.slice(-30).reverse());

  // vetrina: titolo in corso, poi i migliori tra i più recenti, con un po' di varietà a ogni apertura
  const lastSeen = state.history[0] && byId.get(state.history[0].seriesId || state.history[0].id);
  const pool = recent(all.filter((x) => x.logo || cachedMeta(kindOf(x), x)?.backdrop)).slice(0, 60).sort((a, b) => score(b) - score(a)).slice(0, 14);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = [...new Set([lastSeen, ...pool].filter((x): x is Item => !!x))].slice(0, 6);

  const favLive = live.filter((c) => isFav('live', c.id)).slice(0, 20);
  const myList = all.filter((x) => isFav(kindOf(x), x.id));
  const card = (x: Item) => poster(x, () => open(x));
  const topRated = () => all.filter((x) => score(x) > 0).sort((a, b) => score(b) - score(a)).slice(0, 24);
  const topSlot = h('div', { class: 'rail-slot' }, rail(t('home.topRated'), topRated().map(card)));

  // generi più presenti tra i film, una fila ciascuno
  const groups = new Map<string, Item[]>();
  for (const m of movies) (groups.get(m.group) || groups.set(m.group, []).get(m.group)!).push(m);
  const genreRows = [...groups.entries()].filter(([, xs]) => xs.length >= 4).sort((a, b) => b[1].length - a[1].length).slice(0, 3)
    .map(([g, xs]) => rail(g, xs.slice(0, 30).map(card)));

  const rows = h('div', { class: 'rows' },
    continueRow(byId),
    onAirRow(favLive.length ? favLive : live.slice(0, 16)),
    rail(t('lib.myList'), myList.slice(0, 30).map(card)),
    topSlot,
    rail(t('home.recentMovies'), recent(movies).slice(0, 30).map(card)),
    rail(t('home.recentSeries'), recent(series).slice(0, 30).map(card)),
    ...genreRows);

  const page = h('div', { class: 'page home2' + (picks.length ? '' : ' no-hero') }, hero(picks), rows);
  if (!picks.length) rows.prepend(h('div', { class: 'row gap' }, h('button', { class: 'btn primary lg', on: { click: () => go('live') } }, icon('live', 18), t('nav.live'))));
  // voti già salvati su disco: riempie "I più votati" anche subito dopo l'avvio
  const fillTop = () => topSlot.replaceChildren(...[rail(t('home.topRated'), topRated().map(card))].filter((r): r is HTMLElement => !!r));
  if (hasMetaKeys()) {
    const recentAll = recent(all).slice(0, 400);
    warmMeta(recentAll.map((x) => ({ kind: kindOf(x), x }))).then((n) => {
      if (n && page.isConnected) fillTop();
    });
    // al primo avvio la fila nasce quasi vuota: si aggiorna man mano che le copertine ricevono i voti
    const later = debounce(() => page.isConnected && !topSlot.contains(document.activeElement) && fillTop(), 1500);
    const off = onMeta(() => (page.isConnected ? later() : off()));
  }
  return page;
}
