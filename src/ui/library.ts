import { img } from '../core/api';
import type { Episode, Movie, Series, XtreamSource } from '../core/types';
import { debounce, fmtTime, fold } from '../core/util';
import { cooldownLeft, seriesInfo, vodInfo, waitLabel } from '../core/xtream';
import { bestRating, cachedMeta, getMeta, hasMetaKeys, type Meta, type MetaKind } from '../core/meta';
import { active, episodeStreamUrl, hidden, isFav, movieStreamUrl, progressOf, state, toggleFav } from '../state';
import { clear, h, icon, modal, thumb, toast } from './dom';
import { locale, num, t } from '../i18n';
import { channelRequest, play } from './player';
import { rememberInfo } from './playerExtras';

export type Item = Movie | Series;
export const isSeries = (x: Item): x is Series => x.id.startsWith('r') || x.id.startsWith('s');
export const kindOf = (x: Item): MetaKind => (isSeries(x) ? 'series' : 'movie');

/* ---------------- voti ---------------- */
/** Piccolo badge sulla copertina: il voto migliore disponibile e la sua fonte. */
export function ratingBadge(x: Item, m?: Meta): HTMLElement | null {
  const r = bestRating(x, m);
  if (!r) return null;
  return h('span', { class: 'rating r-' + r.src, title: r.src === 'provider' ? '' : r.src.toUpperCase() },
    r.src === 'imdb' ? h('b', null, 'IMDb') : r.src === 'tmdb' ? h('b', null, 'TMDB') : icon('star', 11), r.value.toFixed(1));
}

/** Etichette dei voti per vetrina e schede: IMDb, Rotten Tomatoes, TMDB, provider. */
export function ratingChips(x: Item, m?: Meta): HTMLElement | null {
  const chips: HTMLElement[] = [];
  if (m?.imdb) chips.push(h('span', { class: 'rchip imdb' }, h('b', null, 'IMDb'), m.imdb.toFixed(1)));
  if (m?.rt) chips.push(h('span', { class: 'rchip rt' + (m.rt >= 60 ? ' fresh' : ' rotten') }, h('b', null, 'Rotten Tomatoes'), `${m.rt}%`));
  if (m?.tmdb) chips.push(h('span', { class: 'rchip tmdb' }, h('b', null, 'TMDB'), m.tmdb.toFixed(1)));
  if (!chips.length && x.rating) chips.push(h('span', { class: 'rchip' }, icon('star', 13), (x.rating > 10 ? x.rating / 10 : x.rating).toFixed(1)));
  return chips.length ? h('div', { class: 'rchips' }, chips) : null;
}

/** Riga "anno · durata · stagioni · generi". */
export function metaLine(x: Item, m?: Meta): string {
  const run = m?.runtime ? (m.runtime >= 60 ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m` : `${m.runtime}m`) : '';
  return [m?.year || x.year, isSeries(x) ? '' : run, m?.seasons ? (m.seasons === 1 ? t('lib.seasons1') : t('lib.seasonsN', { n: m.seasons })) : '', (m?.genres || []).join(', ') || x.group]
    .filter(Boolean).join('  ·  ');
}

// arricchisce le card solo quando entrano nello schermo: niente raffiche di richieste su cataloghi enormi
const enrichIo = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      enrichIo!.unobserve(e.target);
      (e.target as HTMLElement & { enrich?: () => void }).enrich?.();
    }
  }, { rootMargin: '400px' })
  : null;

/* ---------------- card e griglie ---------------- */
export function poster(x: Item, onOpen: () => void): HTMLElement {
  const kind = kindOf(x);
  const p = !isSeries(x) ? progressOf(`movie:${x.id}`) : undefined;
  const bar = p && p.dur ? h('div', { class: 'card-progress' }, h('i')) : null;
  if (bar && p) (bar.firstChild as HTMLElement).style.width = `${(p.pos / p.dur) * 100}%`;
  const m = cachedMeta(kind, x);
  let art = thumb(img(x.logo || m?.poster), x.name, 'poster');
  let badge = ratingBadge(x, m);
  const box = h('div', { class: 'card-art' }, art, badge, isFav(kind, x.id) ? h('span', { class: 'fav-badge' }, icon('heart', 13)) : null, bar);
  const card = h('button', { class: 'card', on: { click: onOpen }, title: x.name },
    box, h('div', { class: 'card-title' }, x.name),
    h('div', { class: 'card-meta' }, [x.year, x.group].filter(Boolean).join(' · ')));
  if (!m && hasMetaKeys() && enrichIo) {
    (card as HTMLElement & { enrich?: () => void }).enrich = async () => {
      const got = await getMeta(kind, x).catch(() => undefined);
      if (!got) return;
      const nb = ratingBadge(x, got);
      if (nb) badge ? badge.replaceWith(nb) : box.appendChild(nb);
      badge = nb;
      if (!x.logo && got.poster) {
        const na = thumb(img(got.poster), x.name, 'poster');
        art.replaceWith(na);
        art = na;
      }
    };
    enrichIo.observe(card);
  }
  return card;
}

/** Griglia con caricamento progressivo: regge anche decine di migliaia di titoli. */
function grid(items: Item[], open: (x: Item) => void, empty = t('lib.noTitles')): HTMLElement {
  const g = h('div', { class: 'grid' });
  if (!items.length) return h('div', { class: 'empty' }, empty);
  let i = 0;
  const sentinel = h('div', { class: 'sentinel' });
  const more = () => {
    const chunk = items.slice(i, i + 60);
    i += chunk.length;
    sentinel.before(...chunk.map((x) => poster(x, () => open(x))));
    if (i >= items.length) io.disconnect();
  };
  const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && more(), { rootMargin: '800px' });
  g.appendChild(sentinel);
  more();
  queueMicrotask(() => io.observe(sentinel));
  return g;
}

export function rail(title: string, nodes: HTMLElement[]): HTMLElement | null {
  if (!nodes.length) return null;
  const kind = nodes[0].classList.contains('wide') ? ' wide' : nodes[0].classList.contains('ch-tile') ? ' tiles' : '';
  const track = h('div', { class: 'rail-track' + kind }, nodes);
  const scroll = (d: number) => track.scrollBy({ left: d * track.clientWidth * 0.8, behavior: 'smooth' });
  return h('section', { class: 'rail' },
    h('div', { class: 'rail-head' }, h('h3', null, title),
      h('div', { class: 'rail-nav' },
        h('button', { class: 'icon-btn', 'aria-label': t('common.back'), on: { click: () => scroll(-1) } }, icon('back', 18)),
        h('button', { class: 'icon-btn flip', 'aria-label': t('common.forward'), on: { click: () => scroll(1) } }, icon('back', 18)))),
    track);
}

/* ---------------- dettaglio film ---------------- */
export async function openMovie(m: Movie) {
  const src = active();
  const key = `movie:${m.id}`;
  const p = progressOf(key);
  const plot = h('p', { class: 'plot' }, src?.type === 'xtream' || hasMetaKeys() ? t('lib.loadingPlot') : '');
  const facts = h('div', { class: 'facts' });
  const backdrop = h('div', { class: 'd-backdrop' });
  const line = h('div', { class: 'd-line' }, metaLine(m, cachedMeta('movie', m)));
  const chips = h('div', null, ratingChips(m, cachedMeta('movie', m)));
  const fav = h('button', { class: 'btn ghost' });
  const paintFav = () => fav.replaceChildren(icon('heart', 18), isFav('movie', m.id) ? t('lib.inMyList') : t('lib.myList'));
  paintFav();
  fav.addEventListener('click', async () => (await toggleFav('movie', m.id), paintFav()));
  const start = (resume: boolean) => {
    close();
    play({ kind: 'movie', live: false, title: m.name, subtitle: [m.year, m.group].filter(Boolean).join(' · '), logo: m.logo, url: movieStreamUrl(m), resumeKey: key, startAt: resume ? undefined : 0, movie: m });
  };
  const actions = h('div', { class: 'row gap wrap' },
    p && p.pos > 15 ? h('button', { class: 'btn primary', on: { click: () => start(true) } }, icon('play', 18), t('lib.resumeFrom', { t: fmtTime(p.pos) })) : null,
    h('button', { class: 'btn ' + (p && p.pos > 15 ? 'ghost' : 'primary'), on: { click: () => start(false) } }, icon('play', 18), p && p.pos > 15 ? t('lib.fromStart') : t('common.watch')),
    fav);
  const box = h('div', { class: 'detail' }, backdrop,
    h('div', { class: 'd-body' }, thumb(img(m.logo), m.name, 'poster d-poster'),
      h('div', { class: 'd-info' }, h('h2', null, m.name), line, chips,
        plot, facts, actions)));
  const close = modal(box, { wide: true });
  let tmdbId: number | undefined;
  let hasBackdrop = false;
  if (src?.type === 'xtream' && m.xid) {
    try {
      const i = await vodInfo(src as XtreamSource, m.xid);
      tmdbId = i.tmdbId;
      rememberInfo('movie:' + m.id, { plot: i.plot, backdrop: i.backdrop });
      plot.textContent = i.plot || '';
      facts.append(...[[t('lib.director'), i.director], [t('lib.cast'), i.cast]]
        .filter(([, v]) => v).map(([k, v]) => h('div', null, h('b', null, k + ': '), v!)));
      if (i.backdrop) (backdrop.appendChild(h('img', { src: img(i.backdrop)!, alt: '', referrerPolicy: 'no-referrer' })), (hasBackdrop = true));
    } catch {
      /* dettagli del provider non disponibili */
    }
  }
  const meta = await getMeta('movie', m, { full: true, tmdbId }).catch(() => undefined);
  applyMeta(m, meta, { plot, line, chips, backdrop, hasBackdrop });
}

/** Completa una scheda con i dati extra (TMDB/OMDb), senza sovrascrivere quelli del provider. */
function applyMeta(x: Item, m: Meta | undefined, el: { plot: HTMLElement; line: HTMLElement; chips: HTMLElement; backdrop: HTMLElement; hasBackdrop: boolean }) {
  const cur = el.plot.textContent?.trim();
  if (!cur || cur === t('lib.loadingPlot')) el.plot.textContent = m?.overview || t('lib.noPlot');
  el.line.textContent = metaLine(x, m);
  el.chips.replaceChildren(...[ratingChips(x, m)].filter((c): c is HTMLElement => !!c));
  if (!el.hasBackdrop && m?.backdrop) el.backdrop.appendChild(h('img', { src: img(m.backdrop)!, alt: '', referrerPolicy: 'no-referrer' }));
}

/* ---------------- dettaglio serie ---------------- */
export async function openSeries(s: Series, autoEpisode?: Episode) {
  const src = active();
  const seasonsBar = h('div', { class: 'seg seasons' });
  const epList = h('div', { class: 'ep-list' }, h('div', { class: 'skeleton-lines' }, h('i'), h('i'), h('i')));
  const plot = h('p', { class: 'plot' }, src?.type === 'xtream' || hasMetaKeys() ? t('lib.loadingPlot') : '');
  const backdrop = h('div', { class: 'd-backdrop' });
  const line = h('div', { class: 'd-line' }, metaLine(s, cachedMeta('series', s)));
  const chips = h('div', null, ratingChips(s, cachedMeta('series', s)));
  const fav = h('button', { class: 'btn ghost' });
  const paintFav = () => fav.replaceChildren(icon('heart', 18), isFav('series', s.id) ? t('lib.inMyList') : t('lib.myList'));
  paintFav();
  fav.addEventListener('click', async () => (await toggleFav('series', s.id), paintFav()));
  const resumeBtn = h('div');

  const box = h('div', { class: 'detail' }, backdrop,
    h('div', { class: 'd-body' }, thumb(img(s.logo), s.name, 'poster d-poster'),
      h('div', { class: 'd-info' }, h('h2', null, s.name), line, chips,
        plot, h('div', { class: 'row gap wrap' }, resumeBtn, fav))),
    h('div', { class: 'd-episodes' }, seasonsBar, epList));
  const close = modal(box, { wide: true });

  let episodes = s.episodes || [];
  let tmdbId: number | undefined;
  let hasBackdrop = false;
  if (src?.type === 'xtream' && s.xid) {
    try {
      const info = await seriesInfo(src as XtreamSource, s);
      episodes = info.episodes;
      s.episodes = episodes;
      tmdbId = info.tmdbId;
      rememberInfo('series:' + s.id, { plot: info.plot, backdrop: info.backdrop });
      plot.textContent = info.plot || '';
      if (info.backdrop) (backdrop.appendChild(h('img', { src: img(info.backdrop)!, alt: '', referrerPolicy: 'no-referrer' })), (hasBackdrop = true));
    } catch (e) {
      // il provider può rifiutare per un po' (es. troppe richieste): si offre di riprovare invece di "nessun episodio"
      const retry = () => box.isConnected && (close(), openSeries(s, autoEpisode));
      const msg = h('p', null, (e as Error).message);
      epList.replaceChildren(h('div', { class: 'empty' }, msg,
        h('button', { class: 'btn', on: { click: retry } }, icon('refresh', 16), t('common.retry'))));
      if (cooldownLeft() > 0) {
        // pausa del provider: conto alla rovescia e nuovo tentativo da solo, finché la scheda resta aperta
        const tick = setInterval(() => {
          const left = cooldownLeft();
          if (!box.isConnected) return clearInterval(tick);
          if (left > 0) return void (msg.textContent = t('lib.autoRetry', { s: waitLabel(left) }));
          clearInterval(tick);
          retry();
        }, 1000);
        msg.textContent = t('lib.autoRetry', { s: waitLabel(cooldownLeft()) });
      } else toast((e as Error).message, 'error');
      getMeta('series', s, { full: true }).catch(() => undefined).then((m) => applyMeta(s, m, { plot, line, chips, backdrop, hasBackdrop }));
      return;
    }
  }
  getMeta('series', s, { full: true, tmdbId }).catch(() => undefined).then((m) => applyMeta(s, m, { plot, line, chips, backdrop, hasBackdrop }));
  if (!episodes.length) {
    epList.replaceChildren(h('div', { class: 'empty' }, t('lib.noEpisodes')));
    return;
  }
  const playEp = (ep: Episode, resume = true) => {
    close();
    playEpisode(s, ep, resume);
  };
  // ultimo episodio visto
  const last = state.history.find((x) => x.seriesId === s.id);
  const lastEp = last && episodes.find((e) => `series:${e.id}` === last.key);
  resumeBtn.replaceChildren(h('button', { class: 'btn primary', on: { click: () => playEp(lastEp || episodes[0]) } }, icon('play', 18),
    lastEp ? t('lib.resumeEp', { s: lastEp.season, e: lastEp.episode }) : t('lib.watchFirst')));

  const seasons = [...new Set(episodes.map((e) => e.season))];
  let season = lastEp?.season ?? seasons[0];
  const renderSeason = () => {
    seasonsBar.replaceChildren(...seasons.map((n) => h('button', { class: n === season ? 'on' : '', on: { click: () => ((season = n), renderSeason()) } }, t('lib.season', { n }))));
    epList.replaceChildren(...episodes.filter((e) => e.season === season).map((e) => {
      const p = progressOf(`series:${e.id}`);
      const bar = p?.dur ? h('div', { class: 'card-progress' }, h('i')) : null;
      if (bar && p) (bar.firstChild as HTMLElement).style.width = `${(p.pos / p.dur) * 100}%`;
      return h('button', { class: 'ep', on: { click: () => playEp(e) } },
        h('div', { class: 'ep-art' }, thumb(img(e.logo || s.logo), String(e.episode), 'ep-thumb'), bar),
        h('div', { class: 'ep-text' }, h('div', { class: 'ep-title' }, `${e.episode}. ${e.title || t('lib.episode', { n: e.episode })}`),
          e.plot ? h('div', { class: 'ep-plot' }, e.plot) : null, e.duration ? h('small', { class: 'muted' }, e.duration) : null));
    }));
  };
  renderSeason();
  if (autoEpisode) playEp(autoEpisode, false);
}

export function playEpisode(s: Series, ep: Episode, resume = true) {
  play({
    kind: 'episode', live: false, title: s.name, subtitle: `S${ep.season} E${ep.episode}${ep.title ? ' · ' + ep.title : ''}`,
    logo: s.logo, url: episodeStreamUrl(ep), resumeKey: `series:${ep.id}`, startAt: resume ? undefined : 0, series: s, episode: ep,
  });
}

/* ---------------- viste ---------------- */
function catalog(kind: 'movie' | 'series'): HTMLElement {
  const all: Item[] = (kind === 'movie' ? state.lib!.movies : state.lib!.series).filter((x) => !hidden(x));
  const ALL = '\u0000all';
  const groups = [ALL, ...new Set(all.map((x) => x.group))];
  const storeKey = `orbita.${kind}Group`;
  let group = localStorage.getItem(storeKey) || ALL;
  if (!groups.includes(group)) group = ALL;
  let sort = localStorage.getItem(`orbita.${kind}Sort`) || 'default';
  let q = '';
  const chips = h('div', { class: 'chips-scroll' });
  const body = h('div');
  const search = h('input', { class: 'search-input', type: 'search', placeholder: kind === 'movie' ? t('lib.searchMovies') : t('lib.searchSeries') });
  const sel = h('select', { class: 'select', 'aria-label': t('lib.sort') },
    ...[['default', t('lib.sortDefault')], ['added', t('lib.sortAdded')], ['rating', t('lib.sortRating')], ['year', t('lib.sortYear')], ['az', t('lib.sortAz')]].map(([v, l]) => h('option', { value: v }, l)));
  sel.value = sort;
  const open = (x: Item) => (isSeries(x) ? openSeries(x) : openMovie(x as Movie));

  const render = () => {
    chips.replaceChildren(...groups.map((g) => h('button', { class: 'chip-btn' + (g === group ? ' on' : ''), on: { click: () => { group = g; localStorage.setItem(storeKey, g); render(); } } }, g === ALL ? t('lib.all') : g)));
    let list = group === ALL ? all : all.filter((x) => x.group === group);
    if (q) {
      const f = fold(q);
      list = list.filter((x) => fold(x.name).includes(f));
    }
    if (sort !== 'default') {
      list = list.slice();
      const by: Record<string, (a: Item, b: Item) => number> = {
        added: (a, b) => (b.added || 0) - (a.added || 0), rating: (a, b) => (b.rating || 0) - (a.rating || 0),
        year: (a, b) => (b.year || 0) - (a.year || 0), az: (a, b) => a.name.localeCompare(b.name, locale()),
      };
      list.sort(by[sort]);
    }
    body.replaceChildren(h('div', { class: 'count-line' }, t('lib.titles', { n: num(list.length) })), grid(list, open));
  };
  search.addEventListener('input', debounce(() => ((q = search.value.trim()), render()), 180));
  sel.addEventListener('change', () => { sort = sel.value; localStorage.setItem(`orbita.${kind}Sort`, sort); render(); });
  render();
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, kind === 'movie' ? t('lib.moviesTitle') : t('lib.seriesTitle')), h('div', { class: 'row gap' }, search, sel)),
    chips, body);
}
export const moviesView = () => catalog('movie');
export const seriesView = () => catalog('series');

export function searchView(): HTMLElement {
  const input = h('input', { class: 'search-input xl', type: 'search', placeholder: t('search.placeholder') });
  const out = h('div', { class: 'search-out' });
  const lib = state.lib!;
  const run = () => {
    const q = fold(input.value.trim());
    clear(out);
    if (q.length < 2) return out.appendChild(h('div', { class: 'empty' }, t('search.min')));
    const words = q.split(/\s+/);
    const match = (s: string) => {
      const f = fold(s);
      return words.every((w) => f.includes(w));
    };
    const ch = lib.live.filter((c) => !hidden(c) && match(c.name)).slice(0, 40);
    const mv = lib.movies.filter((m) => !hidden(m) && match(m.name)).slice(0, 120);
    const sr = lib.series.filter((m) => !hidden(m) && match(m.name)).slice(0, 120);
    if (!ch.length && !mv.length && !sr.length) return out.appendChild(h('div', { class: 'empty' }, t('search.none')));
    if (ch.length) out.appendChild(rail(t('search.channels', { n: ch.length }), ch.map((c) => h('button', { class: 'ch-tile', on: { click: () => play(channelRequest(c), ch) } }, thumb(img(c.logo), c.name, 'ch-logo lg'), h('span', null, c.name))))!);
    if (mv.length) out.append(h('h3', { class: 'sec-title' }, t('search.movies', { n: mv.length })), grid(mv, (x) => openMovie(x as Movie)));
    if (sr.length) out.append(h('h3', { class: 'sec-title' }, t('search.series', { n: sr.length })), grid(sr, (x) => openSeries(x as Series)));
  };
  input.addEventListener('input', debounce(run, 200));
  if (!document.body.classList.contains('tv')) setTimeout(() => input.focus(), 50); // su TV la tastiera si apre solo con OK
  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, t('nav.search'))), input, out);
}

export function favoritesView(): HTMLElement {
  const lib = state.lib!;
  const ch = lib.live.filter((c) => isFav('live', c.id) && !hidden(c));
  const items: Item[] = [...lib.movies.filter((m) => isFav('movie', m.id)), ...lib.series.filter((s) => isFav('series', s.id))].filter((x) => !hidden(x));
  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, t('nav.favorites'))),
    ch.length ? rail(t('common.channels'), ch.map((c) => h('button', { class: 'ch-tile', on: { click: () => play(channelRequest(c), ch) } }, thumb(img(c.logo), c.name, 'ch-logo lg'), h('span', null, c.name)))) : null,
    h('h3', { class: 'sec-title' }, t('fav.moviesSeries')),
    grid(items, (x) => (isSeries(x) ? openSeries(x) : openMovie(x as Movie)), t('fav.empty')));
}
