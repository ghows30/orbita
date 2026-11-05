import './styles.css';
import type { Episode, Series } from './core/types';
import { native } from './core/api';
import { active, init, state } from './state';
import { clear, h, icon, toast } from './ui/dom';
import { favoritesView, homeView, moviesView, playEpisode, searchView, seriesView } from './ui/library';
import { liveView } from './ui/live';
import { welcome } from './ui/onboard';
import { playerOpen } from './ui/player';
import { settingsView } from './ui/settings';

type Route = 'home' | 'live' | 'movies' | 'series' | 'favorites' | 'search' | 'settings';
const NAV: [Route, string, string][] = [
  ['home', 'Home', 'home'], ['live', 'TV in diretta', 'live'], ['movies', 'Film', 'movie'], ['series', 'Serie', 'series'],
  ['favorites', 'Preferiti', 'heart'], ['search', 'Cerca', 'search'], ['settings', 'Impostazioni', 'settings'],
];

const app = document.getElementById('app')!;
const main = h('main', { class: 'main', id: 'main' });
const nav = h('nav', { class: 'sidebar', 'aria-label': 'Navigazione' });

const route = (): Route => {
  const r = location.hash.replace(/^#\/?/, '') as Route;
  return NAV.some(([k]) => k === r) ? r : 'home';
};
const go = (r: string) => {
  if (location.hash === '#/' + r) render();
  else location.hash = '/' + r;
};

function renderNav() {
  const r = route();
  const src = active();
  clear(nav);
  nav.append(
    h('a', { class: 'brand', href: '#/home', 'aria-label': 'ORBITA home' }, h('div', { class: 'orbit-logo' }, h('i'), h('b')), h('span', null, 'ORBITA')),
    h('div', { class: 'nav-items' }, NAV.map(([k, label, ic]) =>
      h('a', { class: 'nav-item' + (k === r ? ' on' : ''), href: '#/' + k, 'aria-current': k === r ? 'page' : null, title: label }, icon(ic, 22), h('span', null, label)))),
    src ? h('div', { class: 'nav-src', title: 'Playlist attiva' }, h('i', { class: 'src-dot' }), h('span', null, src.name)) : '',
  );
}

function render() {
  renderNav();
  clear(main);
  if (!state.lib || !state.sources.length) {
    document.body.classList.add('onboarding');
    main.appendChild(welcome(() => go('home')));
    return;
  }
  document.body.classList.remove('onboarding');
  const r = route();
  const view =
    r === 'live' ? liveView()
      : r === 'movies' ? moviesView()
        : r === 'series' ? seriesView()
          : r === 'favorites' ? favoritesView()
            : r === 'search' ? searchView()
              : r === 'settings' ? settingsView(render)
                : homeView(go);
  main.appendChild(view);
  main.scrollTop = 0;
  if (r !== 'search') requestAnimationFrame(() =>
    (main.querySelector<HTMLElement>('.ch-row.on') || main.querySelector<HTMLElement>('.on') || main.querySelector<HTMLElement>('button, a'))?.focus({ preventScroll: true }));
}

/* ---------------- navigazione spaziale (telecomando / frecce) ---------------- */
function spatial(e: KeyboardEvent) {
  if (playerOpen() || document.querySelector('.modal-wrap') && !(e.target as HTMLElement).closest('.modal-wrap')) return;
  const dirs: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const d = dirs[e.key];
  const t = e.target as HTMLElement;
  if (!d) return;
  if (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'range' && (d[0] !== 0)) return;
  if (t instanceof HTMLSelectElement) return;
  const scope = (t.closest('.modal-wrap') || document.body) as HTMLElement;
  const all = [...scope.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, [tabindex="0"]')]
    .filter((x) => x.offsetParent !== null && x !== t);
  const r = t.getBoundingClientRect ? t.getBoundingClientRect() : new DOMRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const dx = x - cx, dy = y - cy;
    const along = dx * d[0] + dy * d[1];
    if (along <= 4) continue;
    const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
    const score = along + across * 2.5;
    if (score < bestScore) (bestScore = score), (best = el);
  }
  // entrando nella barra laterale si va sulla voce della pagina attuale, non sulla più vicina
  if (best?.classList.contains('nav-item') && !t.closest('.sidebar')) best = nav.querySelector<HTMLElement>('.nav-item.on') || best;
  if (best) {
    e.preventDefault();
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

async function boot() {
  app.append(nav, main);
  try {
    await init();
  } catch (e) {
    toast('Impossibile aprire l\'archivio locale: ' + (e as Error).message, 'error');
  }
  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', spatial);
  document.addEventListener('keydown', (e) => {
    if (playerOpen() || document.querySelector('.modal-wrap')) return;
    const t = e.target as HTMLElement;
    if (e.key === '/' && !(t instanceof HTMLInputElement)) (e.preventDefault(), go('search'));
  });
  document.addEventListener('orbita:play-episode', (e) => {
    const { series, episode } = (e as CustomEvent<{ series: Series; episode: Episode }>).detail;
    playEpisode(series, episode, false);
  });
  document.addEventListener('orbita:player-closed', () => {
    if (route() === 'home') render();
  });
  if (native) setupNative();
  render();
}

/** App Android TV / Fire TV: layout da TV e tasto Indietro del telecomando. */
function setupNative() {
  document.body.classList.add('native');
  if (native!.isTv()) {
    document.body.classList.add('tv');
    // 1280 px CSS su qualsiasi TV (720p/1080p/4K): layout completo a tre colonne e testi leggibili da divano
    document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=1280, user-scalable=no');
  }
  window.orbitaBack = () => {
    if (document.querySelector('.modal-wrap')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    }
    if (state.lib && route() !== 'home') {
      go('home');
      return true;
    }
    return false;
  };
}

boot();
