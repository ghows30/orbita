import { img } from '../core/api';
import type { Channel, Episode, Movie, Series, XtreamSource } from '../core/types';
import { debounce, fmtTime, fold } from '../core/util';
import { seriesInfo, vodInfo } from '../core/xtream';
import { active, episodeStreamUrl, hidden, isFav, movieStreamUrl, progressOf, state, toggleFav } from '../state';
import { clear, h, icon, modal, thumb, toast } from './dom';
import { channelRequest, play } from './player';

type Item = Movie | Series;
const isSeries = (x: Item): x is Series => x.id.startsWith('r') || x.id.startsWith('s');

/* ---------------- card e griglie ---------------- */
function poster(x: Item, onOpen: () => void): HTMLElement {
  const kind = isSeries(x) ? 'series' : 'movie';
  const p = !isSeries(x) ? progressOf(`movie:${x.id}`) : undefined;
  const bar = p && p.dur ? h('div', { class: 'card-progress' }, h('i')) : null;
  if (bar && p) (bar.firstChild as HTMLElement).style.width = `${(p.pos / p.dur) * 100}%`;
  return h('button', { class: 'card', on: { click: onOpen }, title: x.name },
    h('div', { class: 'card-art' }, thumb(img(x.logo), x.name, 'poster'),
      x.rating ? h('span', { class: 'rating' }, icon('star', 11), x.rating.toFixed(1)) : null,
      isFav(kind, x.id) ? h('span', { class: 'fav-badge' }, icon('heart', 13)) : null, bar),
    h('div', { class: 'card-title' }, x.name),
    h('div', { class: 'card-meta' }, [x.year, x.group].filter(Boolean).join(' · ')));
}

/** Griglia con caricamento progressivo: regge anche decine di migliaia di titoli. */
function grid(items: Item[], open: (x: Item) => void, empty = 'Nessun titolo.'): HTMLElement {
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

function rail(title: string, nodes: HTMLElement[]): HTMLElement | null {
  if (!nodes.length) return null;
  const kind = nodes[0].classList.contains('wide') ? ' wide' : nodes[0].classList.contains('ch-tile') ? ' tiles' : '';
  const track = h('div', { class: 'rail-track' + kind }, nodes);
  const scroll = (d: number) => track.scrollBy({ left: d * track.clientWidth * 0.8, behavior: 'smooth' });
  return h('section', { class: 'rail' },
    h('div', { class: 'rail-head' }, h('h3', null, title),
      h('div', { class: 'rail-nav' },
        h('button', { class: 'icon-btn', 'aria-label': 'Indietro', on: { click: () => scroll(-1) } }, icon('back', 18)),
        h('button', { class: 'icon-btn flip', 'aria-label': 'Avanti', on: { click: () => scroll(1) } }, icon('back', 18)))),
    track);
}

/* ---------------- dettaglio film ---------------- */
export async function openMovie(m: Movie) {
  const src = active();
  const key = `movie:${m.id}`;
  const p = progressOf(key);
  const plot = h('p', { class: 'plot' }, src?.type === 'xtream' ? 'Carico la trama…' : '');
  const facts = h('div', { class: 'facts' });
  const backdrop = h('div', { class: 'd-backdrop' });
  const fav = h('button', { class: 'btn ghost' });
  const paintFav = () => fav.replaceChildren(icon('heart', 18), isFav('movie', m.id) ? 'Nella mia lista' : 'La mia lista');
  paintFav();
  fav.addEventListener('click', async () => (await toggleFav('movie', m.id), paintFav()));
  const start = (resume: boolean) => {
    close();
    play({ kind: 'movie', live: false, title: m.name, subtitle: [m.year, m.group].filter(Boolean).join(' · '), logo: m.logo, url: movieStreamUrl(m), resumeKey: key, startAt: resume ? undefined : 0 });
  };
  const actions = h('div', { class: 'row gap wrap' },
    p && p.pos > 15 ? h('button', { class: 'btn primary', on: { click: () => start(true) } }, icon('play', 18), `Riprendi da ${fmtTime(p.pos)}`) : null,
    h('button', { class: 'btn ' + (p && p.pos > 15 ? 'ghost' : 'primary'), on: { click: () => start(false) } }, icon('play', 18), p && p.pos > 15 ? 'Dall\'inizio' : 'Guarda'),
    fav);
  const box = h('div', { class: 'detail' }, backdrop,
    h('div', { class: 'd-body' }, thumb(img(m.logo), m.name, 'poster d-poster'),
      h('div', { class: 'd-info' }, h('h2', null, m.name),
        h('div', { class: 'chips' }, m.year ? h('span', { class: 'chip' }, String(m.year)) : null, m.rating ? h('span', { class: 'chip' }, icon('star', 12), m.rating.toFixed(1)) : null, h('span', { class: 'chip' }, m.group)),
        plot, facts, actions)));
  const close = modal(box, { wide: true });
  if (src?.type === 'xtream' && m.xid) {
    try {
      const i = await vodInfo(src as XtreamSource, m.xid);
      plot.textContent = i.plot || 'Nessuna trama disponibile.';
      facts.append(...[['Genere', i.genre], ['Durata', i.duration], ['Regia', i.director], ['Cast', i.cast]]
        .filter(([, v]) => v).map(([k, v]) => h('div', null, h('b', null, k + ': '), v!)));
      if (i.backdrop) backdrop.appendChild(h('img', { src: img(i.backdrop)!, alt: '', referrerPolicy: 'no-referrer' }));
    } catch {
      plot.textContent = '';
    }
  }
}

/* ---------------- dettaglio serie ---------------- */
export async function openSeries(s: Series, autoEpisode?: Episode) {
  const src = active();
  const seasonsBar = h('div', { class: 'seg seasons' });
  const epList = h('div', { class: 'ep-list' }, h('div', { class: 'skeleton-lines' }, h('i'), h('i'), h('i')));
  const plot = h('p', { class: 'plot' });
  const backdrop = h('div', { class: 'd-backdrop' });
  const fav = h('button', { class: 'btn ghost' });
  const paintFav = () => fav.replaceChildren(icon('heart', 18), isFav('series', s.id) ? 'Nella mia lista' : 'La mia lista');
  paintFav();
  fav.addEventListener('click', async () => (await toggleFav('series', s.id), paintFav()));
  const resumeBtn = h('div');

  const box = h('div', { class: 'detail' }, backdrop,
    h('div', { class: 'd-body' }, thumb(img(s.logo), s.name, 'poster d-poster'),
      h('div', { class: 'd-info' }, h('h2', null, s.name),
        h('div', { class: 'chips' }, s.year ? h('span', { class: 'chip' }, String(s.year)) : null, s.rating ? h('span', { class: 'chip' }, icon('star', 12), s.rating.toFixed(1)) : null, h('span', { class: 'chip' }, s.group)),
        plot, h('div', { class: 'row gap wrap' }, resumeBtn, fav))),
    h('div', { class: 'd-episodes' }, seasonsBar, epList));
  const close = modal(box, { wide: true });

  let episodes = s.episodes || [];
  if (src?.type === 'xtream' && s.xid) {
    try {
      const info = await seriesInfo(src as XtreamSource, s);
      episodes = info.episodes;
      s.episodes = episodes;
      plot.textContent = info.plot || '';
      if (info.backdrop) backdrop.appendChild(h('img', { src: img(info.backdrop)!, alt: '', referrerPolicy: 'no-referrer' }));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  if (!episodes.length) {
    epList.replaceChildren(h('div', { class: 'empty' }, 'Nessun episodio disponibile.'));
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
    lastEp ? `Riprendi S${lastEp.season} E${lastEp.episode}` : 'Guarda S1 E1'));

  const seasons = [...new Set(episodes.map((e) => e.season))];
  let season = lastEp?.season ?? seasons[0];
  const renderSeason = () => {
    seasonsBar.replaceChildren(...seasons.map((n) => h('button', { class: n === season ? 'on' : '', on: { click: () => ((season = n), renderSeason()) } }, `Stagione ${n}`)));
    epList.replaceChildren(...episodes.filter((e) => e.season === season).map((e) => {
      const p = progressOf(`series:${e.id}`);
      const bar = p?.dur ? h('div', { class: 'card-progress' }, h('i')) : null;
      if (bar && p) (bar.firstChild as HTMLElement).style.width = `${(p.pos / p.dur) * 100}%`;
      return h('button', { class: 'ep', on: { click: () => playEp(e) } },
        h('div', { class: 'ep-art' }, thumb(img(e.logo || s.logo), String(e.episode), 'ep-thumb'), bar),
        h('div', { class: 'ep-text' }, h('div', { class: 'ep-title' }, `${e.episode}. ${e.title || 'Episodio ' + e.episode}`),
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
  const groups = ['Tutti', ...new Set(all.map((x) => x.group))];
  const storeKey = `orbita.${kind}Group`;
  let group = localStorage.getItem(storeKey) || 'Tutti';
  if (!groups.includes(group)) group = 'Tutti';
  let sort = localStorage.getItem(`orbita.${kind}Sort`) || 'default';
  let q = '';
  const chips = h('div', { class: 'chips-scroll' });
  const body = h('div');
  const search = h('input', { class: 'search-input', type: 'search', placeholder: kind === 'movie' ? 'Cerca film…' : 'Cerca serie…' });
  const sel = h('select', { class: 'select', 'aria-label': 'Ordina' },
    ...[['default', 'Ordine provider'], ['added', 'Aggiunti di recente'], ['rating', 'Più votati'], ['year', 'Più recenti'], ['az', 'A → Z']].map(([v, l]) => h('option', { value: v }, l)));
  sel.value = sort;
  const open = (x: Item) => (isSeries(x) ? openSeries(x) : openMovie(x as Movie));

  const render = () => {
    chips.replaceChildren(...groups.map((g) => h('button', { class: 'chip-btn' + (g === group ? ' on' : ''), on: { click: () => { group = g; localStorage.setItem(storeKey, g); render(); } } }, g)));
    let list = group === 'Tutti' ? all : all.filter((x) => x.group === group);
    if (q) {
      const f = fold(q);
      list = list.filter((x) => fold(x.name).includes(f));
    }
    if (sort !== 'default') {
      list = list.slice();
      const by: Record<string, (a: Item, b: Item) => number> = {
        added: (a, b) => (b.added || 0) - (a.added || 0), rating: (a, b) => (b.rating || 0) - (a.rating || 0),
        year: (a, b) => (b.year || 0) - (a.year || 0), az: (a, b) => a.name.localeCompare(b.name, 'it'),
      };
      list.sort(by[sort]);
    }
    body.replaceChildren(h('div', { class: 'count-line' }, `${list.length.toLocaleString('it-IT')} titoli`), grid(list, open));
  };
  search.addEventListener('input', debounce(() => ((q = search.value.trim()), render()), 180));
  sel.addEventListener('change', () => { sort = sel.value; localStorage.setItem(`orbita.${kind}Sort`, sort); render(); });
  render();
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, kind === 'movie' ? 'Film' : 'Serie TV'), h('div', { class: 'row gap' }, search, sel)),
    chips, body);
}
export const moviesView = () => catalog('movie');
export const seriesView = () => catalog('series');

export function homeView(go: (r: string) => void): HTMLElement {
  const lib = state.lib!;
  const movies = lib.movies.filter((m) => !hidden(m));
  const series = lib.series.filter((m) => !hidden(m));
  const live = lib.live.filter((c) => !hidden(c));
  const byId = new Map<string, Movie | Series>([...movies, ...series].map((x) => [x.id, x]));

  // continua a guardare
  const cont = state.history.filter((x) => x.dur && x.pos / x.dur < 0.95).slice(0, 20).map((x) => {
    const target = x.kind === 'movie' ? byId.get(x.id) : x.seriesId ? byId.get(x.seriesId) : undefined;
    if (!target) return null;
    const bar = h('div', { class: 'card-progress' }, h('i'));
    (bar.firstChild as HTMLElement).style.width = `${(x.pos / x.dur) * 100}%`;
    return h('button', { class: 'card wide', on: { click: () => (isSeries(target) ? openSeries(target) : openMovie(target as Movie)) } },
      h('div', { class: 'card-art' }, thumb(img(x.logo || target.logo), x.name, 'poster wide'), bar,
        h('span', { class: 'play-over' }, icon('play', 22))),
      h('div', { class: 'card-title' }, x.name), h('div', { class: 'card-meta' }, `${fmtTime(x.dur - x.pos)} rimanenti`));
  }).filter((x): x is HTMLButtonElement => !!x);

  const favLive = live.filter((c) => isFav('live', c.id)).slice(0, 30);
  const chTile = (c: Channel) => h('button', { class: 'ch-tile', on: { click: () => play(channelRequest(c), favLive.length ? favLive : live) } },
    thumb(img(c.logo), c.name, 'ch-logo lg'), h('span', null, c.name));
  const recent = (xs: Item[]) => xs.some((x) => x.added) ? xs.slice().sort((a, b) => (b.added || 0) - (a.added || 0)) : xs.slice(-30).reverse();
  const open = (x: Item) => (isSeries(x) ? openSeries(x) : openMovie(x as Movie));
  const myList = [...movies, ...series].filter((x) => isFav(isSeries(x) ? 'series' : 'movie', x.id));

  // hero: primo titolo di "continua" oppure un film ben votato
  const pick = (cont.length && state.history[0] && (byId.get(state.history[0].seriesId || state.history[0].id))) ||
    movies.filter((m) => m.logo).sort((a, b) => (b.rating || 0) - (a.rating || 0))[Math.floor(Math.random() * 8)] || movies[0] || series[0];
  const hero = pick ? h('section', { class: 'hero' },
    h('div', { class: 'hero-art' }, thumb(img(pick.logo), pick.name, 'hero-img')),
    h('div', { class: 'hero-text' },
      h('span', { class: 'eyebrow' }, isSeries(pick) ? 'Serie in evidenza' : 'Film in evidenza'),
      h('h1', null, pick.name),
      h('div', { class: 'chips' }, pick.year ? h('span', { class: 'chip' }, String(pick.year)) : null, pick.rating ? h('span', { class: 'chip' }, icon('star', 12), pick.rating.toFixed(1)) : null, h('span', { class: 'chip' }, pick.group)),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary lg', on: { click: () => open(pick) } }, icon('play', 18), 'Guarda ora'),
        h('button', { class: 'btn ghost lg', on: { click: () => go('live') } }, icon('live', 18), 'TV in diretta')))) : null;

  const stats = h('div', { class: 'stats' },
    ...[['live', live.length, 'Canali', 'live'], ['movie', movies.length, 'Film', 'movies'], ['series', series.length, 'Serie', 'series']].map(([ic, n, l, r]) =>
      h('button', { class: 'stat', on: { click: () => go(r as string) } }, icon(ic as string, 22), h('b', null, (n as number).toLocaleString('it-IT')), h('span', null, l as string))));

  return h('div', { class: 'page home' }, hero, stats,
    rail('Continua a guardare', cont),
    rail('Canali preferiti', favLive.map(chTile)),
    rail('La mia lista', myList.slice(0, 30).map((x) => poster(x, () => open(x)))),
    rail('Film aggiunti di recente', recent(movies).slice(0, 30).map((x) => poster(x, () => open(x)))),
    rail('Serie aggiunte di recente', recent(series).slice(0, 30).map((x) => poster(x, () => open(x)))),
    !favLive.length ? rail('In diretta', live.slice(0, 30).map(chTile)) : null);
}

export function searchView(): HTMLElement {
  const input = h('input', { class: 'search-input xl', type: 'search', placeholder: 'Cerca canali, film, serie…' });
  const out = h('div', { class: 'search-out' });
  const lib = state.lib!;
  const run = () => {
    const q = fold(input.value.trim());
    clear(out);
    if (q.length < 2) return out.appendChild(h('div', { class: 'empty' }, 'Scrivi almeno 2 lettere.'));
    const words = q.split(/\s+/);
    const match = (s: string) => {
      const f = fold(s);
      return words.every((w) => f.includes(w));
    };
    const ch = lib.live.filter((c) => !hidden(c) && match(c.name)).slice(0, 40);
    const mv = lib.movies.filter((m) => !hidden(m) && match(m.name)).slice(0, 120);
    const sr = lib.series.filter((m) => !hidden(m) && match(m.name)).slice(0, 120);
    if (!ch.length && !mv.length && !sr.length) return out.appendChild(h('div', { class: 'empty' }, 'Nessun risultato.'));
    if (ch.length) out.appendChild(rail(`Canali (${ch.length})`, ch.map((c) => h('button', { class: 'ch-tile', on: { click: () => play(channelRequest(c), ch) } }, thumb(img(c.logo), c.name, 'ch-logo lg'), h('span', null, c.name))))!);
    if (mv.length) out.append(h('h3', { class: 'sec-title' }, `Film (${mv.length})`), grid(mv, (x) => openMovie(x as Movie)));
    if (sr.length) out.append(h('h3', { class: 'sec-title' }, `Serie (${sr.length})`), grid(sr, (x) => openSeries(x as Series)));
  };
  input.addEventListener('input', debounce(run, 200));
  if (!document.body.classList.contains('tv')) setTimeout(() => input.focus(), 50); // su TV la tastiera si apre solo con OK
  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Cerca')), input, out);
}

export function favoritesView(): HTMLElement {
  const lib = state.lib!;
  const ch = lib.live.filter((c) => isFav('live', c.id) && !hidden(c));
  const items: Item[] = [...lib.movies.filter((m) => isFav('movie', m.id)), ...lib.series.filter((s) => isFav('series', s.id))].filter((x) => !hidden(x));
  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Preferiti')),
    ch.length ? rail('Canali', ch.map((c) => h('button', { class: 'ch-tile', on: { click: () => play(channelRequest(c), ch) } }, thumb(img(c.logo), c.name, 'ch-logo lg'), h('span', null, c.name)))) : null,
    h('h3', { class: 'sec-title' }, 'Film e serie'),
    grid(items, (x) => (isSeries(x) ? openSeries(x) : openMovie(x as Movie)), 'Aggiungi film e serie con "La mia lista".'));
}
