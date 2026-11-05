import { img } from '../core/api';
import type { Channel, EpgItem, XtreamSource } from '../core/types';
import { clock, fold } from '../core/util';
import { timeshiftUrl } from '../core/xtream';
import { active, epgFor, hidden, isFav, loadGuide, nowNext, onChange, state, toggleFav } from '../state';
import { clear, h, icon, thumb, toast } from './dom';
import { channelRequest, play } from './player';

const FAV = '★ Preferiti';
const ALL = 'Tutti i canali';

export function liveView(): HTMLElement {
  const lib = state.lib!;
  const channels = lib.live.filter((c) => !hidden(c));
  const groups = [FAV, ALL, ...new Set(channels.map((c) => c.group))];
  let group = localStorage.getItem('orbita.liveGroup') || (channels.some((c) => isFav('live', c.id)) ? FAV : ALL);
  if (!groups.includes(group)) group = ALL;
  let query = '';
  let selected: Channel | undefined;

  const catList = h('nav', { class: 'cat-list', 'aria-label': 'Categorie' });
  const chList = h('div', { class: 'ch-list', role: 'listbox' });
  const filter = h('input', { class: 'search-input', type: 'search', placeholder: 'Filtra canali…', 'aria-label': 'Filtra canali' });
  const detail = h('section', { class: 'ch-detail' });
  const count = h('span', { class: 'count' });

  const inGroup = () => {
    let list = group === FAV ? channels.filter((c) => isFav('live', c.id)) : group === ALL ? channels : channels.filter((c) => c.group === group);
    if (query) {
      const q = fold(query);
      list = list.filter((c) => fold(c.name).includes(q));
    }
    return list;
  };

  const renderCats = () => {
    clear(catList);
    for (const g of groups) {
      const n = g === FAV ? channels.filter((c) => isFav('live', c.id)).length : g === ALL ? channels.length : 0;
      catList.appendChild(h('button', { class: 'cat' + (g === group ? ' on' : ''), on: { click: () => { group = g; localStorage.setItem('orbita.liveGroup', g); renderCats(); renderList(); } } },
        h('span', null, g), n ? h('em', null, String(n)) : null));
    }
  };

  const nowFor = (c: Channel) => {
    const items = c.tvgId ? state.epg.get(c.tvgId.toLowerCase()) : undefined;
    return items ? nowNext(items).now : undefined;
  };

  let rendered = 0;
  let current: Channel[] = [];
  const PAGE = 120;
  const sentinel = h('div', { class: 'sentinel' });
  const io = new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && more(), { root: chList, rootMargin: '400px' });

  const row = (c: Channel) => {
    const now = nowFor(c);
    const pct = now ? Math.min(100, ((Date.now() / 1000 - now.s) / (now.e - now.s)) * 100) : 0;
    const bar = h('div', { class: 'mini-bar' }, h('i'));
    (bar.firstChild as HTMLElement).style.width = pct + '%';
    const r = h('button', {
      class: 'ch-row' + (selected?.id === c.id ? ' on' : ''), role: 'option', 'data-id': c.id,
      on: {
        click: () => select(c),
        dblclick: () => play(channelRequest(c), current),
        keydown: (e) => (e as KeyboardEvent).key === 'Enter' && selected?.id === c.id && (e.preventDefault(), play(channelRequest(c), current)),
      },
    },
      c.num ? h('span', { class: 'ch-num' }, String(c.num)) : null,
      thumb(img(c.logo), c.name, 'ch-logo'),
      h('div', { class: 'ch-text' }, h('div', { class: 'ch-name' }, c.name),
        now ? h('div', { class: 'ch-now' }, now.t) : h('div', { class: 'ch-now dim' }, c.group)),
      isFav('live', c.id) ? icon('star', 14, 'fav-dot') : null,
      c.archive ? h('span', { class: 'tag', title: `Archivio ${c.archive} giorni` }, 'REC') : null,
      now ? bar : null);
    return r;
  };

  function more() {
    const next = current.slice(rendered, rendered + PAGE);
    rendered += next.length;
    sentinel.before(...next.map(row));
  }

  const renderList = () => {
    current = inGroup();
    rendered = 0;
    clear(chList);
    chList.appendChild(sentinel);
    count.textContent = `${current.length} canali`;
    if (!current.length) {
      chList.prepend(h('div', { class: 'empty' }, group === FAV ? 'Nessun preferito. Seleziona un canale e premi ★.' : 'Nessun canale trovato.'));
      return;
    }
    more();
    io.observe(sentinel);
    if (!selected || !current.includes(selected)) {
      const last = localStorage.getItem('orbita.lastChannel');
      select(current.find((c) => c.id === last) || current[0], false);
    }
  };

  async function select(c: Channel, focus = true) {
    selected = c;
    chList.querySelectorAll('.ch-row.on').forEach((x) => x.classList.remove('on'));
    const el = chList.querySelector<HTMLElement>(`[data-id="${CSS.escape(c.id)}"]`);
    el?.classList.add('on');
    if (focus) el?.focus();
    renderDetail(c, null);
    const items = await epgFor(c);
    if (selected?.id === c.id) renderDetail(c, items);
  }

  function renderDetail(c: Channel, items: EpgItem[] | null) {
    clear(detail);
    const fav = isFav('live', c.id);
    const t = Date.now() / 1000;
    const src = active();
    const canArchive = !!c.archive && src?.type === 'xtream' && !!c.xid;
    const hero = h('div', { class: 'ch-hero' },
      thumb(img(c.logo), c.name, 'ch-logo xl'),
      h('div', null, h('h2', null, c.name), h('div', { class: 'muted' }, c.group)));
    const actions = h('div', { class: 'row gap' },
      h('button', { class: 'btn primary', on: { click: () => play(channelRequest(c), current) } }, icon('play', 18), 'Guarda'),
      h('button', { class: 'btn ghost', 'aria-pressed': String(fav), on: { click: async () => { await toggleFav('live', c.id); renderDetail(c, items); renderCats(); const r = chList.querySelector(`[data-id="${CSS.escape(c.id)}"]`); r?.replaceWith(row(c)); } } },
        icon('star', 18), fav ? 'Nei preferiti' : 'Preferito'));
    const guide = h('div', { class: 'epg-list' });
    if (items === null) guide.appendChild(h('div', { class: 'skeleton-lines' }, h('i'), h('i'), h('i')));
    else if (!items.length) guide.appendChild(h('div', { class: 'empty small' }, state.epgStatus === 'loading' ? 'Carico la guida TV…' : 'Guida TV non disponibile per questo canale.'));
    else {
      const startIdx = Math.max(0, items.findIndex((x) => x.e > t) - (canArchive ? 6 : 0));
      for (const p of items.slice(startIdx, startIdx + 30)) {
        const isNow = p.s <= t && p.e > t;
        const past = p.e <= t;
        const archivable = canArchive && past && p.s > t - c.archive! * 86400;
        const pct = isNow ? ((t - p.s) / (p.e - p.s)) * 100 : 0;
        const bar = isNow ? h('div', { class: 'mini-bar' }, h('i')) : null;
        if (bar) (bar.firstChild as HTMLElement).style.width = pct + '%';
        guide.appendChild(h('div', { class: 'epg-item' + (isNow ? ' now' : '') + (past ? ' past' : '') },
          h('div', { class: 'epg-time' }, clock(p.s)),
          h('div', { class: 'epg-body' }, h('div', { class: 'epg-title' }, p.t || 'Senza titolo'), p.d ? h('div', { class: 'epg-desc' }, p.d) : null, bar),
          archivable ? h('button', { class: 'btn tiny', title: 'Guarda dall\'archivio', on: { click: () => playArchive(c, p) } }, icon('rew', 14), 'Rivedi') : null,
          isNow && canArchive ? h('button', { class: 'btn tiny', title: 'Dall\'inizio', on: { click: () => playArchive(c, p) } }, icon('rew', 14), 'Dall\'inizio') : null));
      }
    }
    detail.append(hero, actions, h('h3', { class: 'sec-title' }, 'Guida TV'), guide);
  }

  function playArchive(c: Channel, p: EpgItem) {
    const src = active() as XtreamSource;
    const url = timeshiftUrl(src, c.xid!, p.s, Math.min(p.e, Date.now() / 1000 + 60), state.lib?.tz);
    play({ kind: 'catchup', live: false, title: p.t || c.name, subtitle: `${c.name} · ${clock(p.s)}`, logo: c.logo, url, channel: c });
    toast('Riproduzione dall\'archivio', 'ok');
  }

  filter.addEventListener('input', () => {
    query = filter.value.trim();
    renderList();
  });

  const view = h('div', { class: 'live' },
    h('aside', { class: 'live-cats' }, h('h3', { class: 'pane-title' }, 'Categorie'), catList),
    h('section', { class: 'live-chs' }, h('div', { class: 'pane-head' }, filter, count), chList),
    detail);

  // telecomando: ←/→ salta tra le colonne in modo prevedibile (categorie ↔ canali ↔ dettaglio)
  view.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    let to: HTMLElement | null = null;
    if (e.key === 'ArrowRight' && t.closest('.cat-list')) to = chList.querySelector('.ch-row.on') || chList.querySelector('.ch-row');
    else if (e.key === 'ArrowRight' && t.closest('.ch-list')) to = detail.querySelector('.btn');
    else if (e.key === 'ArrowLeft' && t.closest('.ch-list')) to = catList.querySelector('.cat.on');
    else if (e.key === 'ArrowLeft' && (t === detail.querySelector('.btn') || t.closest('.epg-item'))) to = chList.querySelector('.ch-row.on');
    if (to) {
      e.preventDefault();
      e.stopPropagation();
      to.focus();
      to.scrollIntoView({ block: 'nearest' });
    }
  });

  renderCats();
  renderList();
  // la guida XMLTV si carica in background; quando arriva aggiorniamo la lista
  let epgSeen = state.epgStatus === 'ready';
  const off = onChange(() => {
    if (!view.isConnected) return off();
    if (state.epgStatus === 'ready' && !epgSeen) {
      epgSeen = true;
      const keep = chList.scrollTop;
      renderList();
      chList.scrollTop = keep;
      if (selected) select(selected, false);
    }
  });
  loadGuide();
  return view;
}
