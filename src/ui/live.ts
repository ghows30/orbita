// TV in diretta: in alto il canale e il programma selezionati, sotto la guida a griglia
// (canali in verticale, orari in orizzontale). La griglia è un unico elemento con il focus
// che gestisce da sé le frecce e disegna solo le righe visibili: regge anche migliaia di canali.
import { img } from '../core/api';
import type { Channel, EpgItem, XtreamSource } from '../core/types';
import { buildTree, isNode, type GroupNode } from '../core/groups';
import { clock, fold } from '../core/util';
import { timeshiftUrl } from '../core/xtream';
import { active, epgFor, hidden, isFav, loadGuide, onChange, state, toggleFav } from '../state';
import { append, clear, h, icon, thumb, toast } from './dom';
import { channelRequest, play } from './player';
import { t } from '../i18n';

// chiavi interne (salvate in localStorage), indipendenti dalla lingua
const FAV = '\u0000fav';
const ALL = '\u0000all';

const HALF = 1800;
const floorHalf = (s: number) => Math.floor(s / HALF) * HALF;
const now = () => Date.now() / 1000;

/** cella della griglia: un programma, oppure un segnaposto per i canali senza guida */
interface Cell { s: number; e: number; t: string; d?: string; none?: boolean }

export function liveView(): HTMLElement {
  const lib = state.lib!;
  const channels = lib.live.filter((c) => !hidden(c));
  // gruppi nell'ordine del provider, con il numero di canali, poi l'albero a due livelli
  const counts = new Map<string, number>();
  for (const c of channels) counts.set(c.group, (counts.get(c.group) || 0) + 1);
  const catTree = buildTree([...counts].map(([name, count]) => ({ name, count })));
  // prima volta: i preferiti se ci sono, altrimenti la prima categoria (non migliaia di canali tutti insieme)
  const first = catTree[0];
  let group = localStorage.getItem('orbita.liveGroup') || (channels.some((c) => isFav('live', c.id)) ? FAV
    : first ? (isNode(first) ? 'p:' + first.key : 'g:' + first.group) : ALL);
  let query = '';
  let list: Channel[] = [];

  const src = active();
  const canArchive = (c: Channel) => !!c.archive && src?.type === 'xtream' && !!c.xid;
  // finestra di tempo navigabile: un po' di passato (di più se c'è il replay) e il resto della giornata
  const minStart = floorHalf(now()) - (channels.some(canArchive) ? 6 * 3600 : HALF);
  const maxEnd = floorHalf(now()) + 24 * 3600;

  // posizione nella griglia
  let row = 0; // indice in list
  let top = 0; // prima riga visibile
  // primo istante visibile: sempre almeno un quarto d'ora di passato a sinistra della linea "adesso"
  const startView = () => Math.max(minStart, floorHalf(now() - 900));
  let vs = startView();
  let anchor = now(); // istante di riferimento per spostarsi su/giù tra i canali
  let cur: Cell | undefined; // cella selezionata

  /* ---------------- dati della guida ---------------- */
  const short = new Map<string, EpgItem[]>(); // guida breve Xtream, chiesta solo per le righe visibili
  const asked = new Set<string>();
  const itemsOf = (c: Channel): EpgItem[] => {
    const full = c.tvgId ? state.epg.get(c.tvgId.toLowerCase()) : undefined;
    if (full?.length) return full;
    const got = short.get(c.id);
    if (got) return got;
    return [];
  };
  // guida breve Xtream solo per il canale su cui il focus si ferma: una richiesta per ogni riga
  // visibile (o per ogni canale attraversato scorrendo) farebbe scattare i limiti del provider
  let epgTimer: ReturnType<typeof setTimeout> | undefined;
  const wantShort = () => {
    clearTimeout(epgTimer);
    epgTimer = setTimeout(() => {
      const c = list[row];
      if (!c || !view.isConnected || asked.has(c.id) || src?.type !== 'xtream' || !c.xid) return;
      if (c.tvgId && state.epg.get(c.tvgId.toLowerCase())?.length) return;
      asked.add(c.id);
      epgFor(c).then((items) => {
        short.set(c.id, items);
        if (view.isConnected && list.includes(c)) draw();
      }).catch(() => asked.delete(c.id)); // provider in pausa: si potrà richiedere più tardi
    }, 700);
  };
  /** celle della riga nella finestra [from, to]; senza guida una cella unica per tutta la finestra */
  const cellsOf = (c: Channel, from: number, to: number): Cell[] => {
    const xs = itemsOf(c).filter((p) => p.e > from && p.s < to);
    return xs.length ? xs : [{ s: from, e: to, t: c.name, none: true }];
  };
  const nowOf = (c: Channel) => itemsOf(c).find((p) => p.s <= now() && p.e > now());

  /* ---------------- struttura ---------------- */
  const preview = h('div', { class: 'lv-preview' });
  const info = h('div', { class: 'lv-info' });
  const tree = h('nav', { class: 'lv-tree', 'aria-label': t('live.categories') });
  const filter = h('input', { class: 'search-input lv-filter', type: 'search', placeholder: t('live.filter'), 'aria-label': t('live.filter') });
  const count = h('span', { class: 'count' });
  const times = h('div', { class: 'lv-times' });
  const body = h('div', { class: 'lv-body' });
  const grid = h('div', { class: 'lv-grid', tabindex: '0', role: 'grid', 'aria-label': t('live.guide') }, times, body);
  const crumb = h('div', { class: 'lv-crumb' });

  const view = h('div', { class: 'live2' },
    h('aside', { class: 'lv-side' }, h('h3', { class: 'pane-title' }, t('live.categories')), filter, tree),
    h('section', { class: 'lv-top' }, preview, info),
    h('div', { class: 'lv-main' }, h('div', { class: 'lv-head' }, crumb, count), grid));

  /* ---------------- categorie a due livelli ---------------- */
  const leafKey = (g: string) => 'g:' + g;
  const nodeKey = (k: string) => 'p:' + k;
  const groupsOf = (key: string): Set<string> | null => {
    if (key.startsWith('g:')) return new Set([key.slice(2)]);
    const n = catTree.find((x): x is GroupNode => isNode(x) && nodeKey(x.key) === key);
    return n ? new Set(n.children.map((c) => c.group)) : null;
  };
  const labelOf = (key: string): string => {
    if (key === FAV) return t('live.favorites');
    if (key === ALL) return t('live.all');
    for (const x of catTree) {
      if (!isNode(x)) { if (leafKey(x.group) === key) return x.label; continue; }
      if (nodeKey(x.key) === key) return x.label;
      const c = x.children.find((y) => leafKey(y.group) === key);
      if (c) return `${x.label} › ${c.label}`;
    }
    return '';
  };
  // compatibilità: prima si salvava il nome del gruppo così com'era
  if (group !== FAV && group !== ALL && !group.startsWith('g:') && !group.startsWith('p:')) group = leafKey(group);
  if (group !== FAV && group !== ALL && !groupsOf(group)) group = ALL;
  /** categoria aperta: quella che contiene la selezione, oppure quella scelta dall'utente */
  let open = localStorage.getItem('orbita.liveOpen') || '';
  const parentOf = (key: string) => catTree.find((x): x is GroupNode => isNode(x) && (nodeKey(x.key) === key || x.children.some((c) => leafKey(c.group) === key)));
  if (!open) open = parentOf(group)?.key || '';

  const choose = (key: string) => {
    group = key;
    localStorage.setItem('orbita.liveGroup', key);
    if (query) (query = ''), (filter.value = '');
    renderCats();
    refilter();
    grid.focus();
  };
  const toggle = (k: string) => {
    open = open === k ? '' : k;
    localStorage.setItem('orbita.liveOpen', open);
    renderCats();
    tree.querySelector<HTMLElement>(`[data-node="${CSS.escape(k)}"]`)?.focus();
  };

  function renderCats() {
    const favN = channels.filter((c) => isFav('live', c.id)).length;
    const leaf = (key: string, label: string, n: number, cls = '') =>
      h('button', { class: 'lv-cat ' + cls + (group === key && !query ? ' on' : ''), 'data-key': key, on: { click: () => choose(key) } },
        h('span', null, label), h('em', null, String(n)));
    const items: HTMLElement[] = [leaf(FAV, t('live.favorites'), favN), leaf(ALL, t('live.all'), channels.length)];
    for (const x of catTree) {
      if (!isNode(x)) {
        items.push(leaf(leafKey(x.group), x.label, x.count));
        continue;
      }
      const isOpen = open === x.key;
      const inside = parentOf(group) === x;
      items.push(h('button', { class: 'lv-cat node' + (isOpen ? ' open' : '') + (inside && !query ? ' has' : ''), 'data-node': x.key, 'aria-expanded': String(isOpen),
        on: { click: () => toggle(x.key) } }, icon('down', 16, 'chev'), h('span', null, x.label), h('em', null, String(x.count))));
      if (isOpen) {
        items.push(leaf(nodeKey(x.key), t('live.allIn', { c: x.label }), x.count, 'sub all'));
        for (const c of x.children) items.push(leaf(leafKey(c.group), c.label, c.count, 'sub'));
      }
    }
    tree.replaceChildren(...items);
  }

  const refilter = (keep?: Channel) => {
    let xs: Channel[];
    if (query) {
      // la ricerca guarda tutti i canali, non solo la categoria aperta
      const q = fold(query);
      xs = channels.filter((c) => fold(c.name).includes(q));
    } else if (group === FAV) xs = channels.filter((c) => isFav('live', c.id));
    else if (group === ALL) xs = channels;
    else {
      const set = groupsOf(group);
      xs = set ? channels.filter((c) => set.has(c.group)) : channels;
    }
    list = xs;
    crumb.textContent = query ? t('live.results', { q: query }) : labelOf(group);
    count.textContent = t('live.count', { n: list.length });
    const want = keep?.id || localStorage.getItem('orbita.lastChannel');
    row = Math.max(0, list.findIndex((c) => c.id === want));
    top = Math.max(0, row - 2);
    vs = startView();
    anchor = now();
    cur = undefined;
    draw();
  };

  /* ---------------- disegno ---------------- */
  // ore visibili: due e mezza, una sola sugli schermi stretti (telefono)
  const span = () => (grid.clientWidth && grid.clientWidth < 900 ? 3600 : 2.5 * 3600);
  const rowH = () => parseFloat(getComputedStyle(grid).getPropertyValue('--row')) || 76;
  const chW = () => parseFloat(getComputedStyle(grid).getPropertyValue('--chw')) || 260;
  const visibleRows = () => Math.max(1, Math.floor(body.clientHeight / rowH()));

  function pickCell() {
    const c = list[row];
    if (!c) return (cur = undefined);
    const cells = cellsOf(c, vs, vs + span());
    cur = cells.find((x) => x.s <= anchor && x.e > anchor) || cells.reduce((a, b) => (Math.abs(b.s - anchor) < Math.abs(a.s - anchor) ? b : a));
  }

  function draw() {
    if (!list.length) {
      clear(times);
      body.replaceChildren(h('div', { class: 'empty' }, group === FAV ? t('live.noFav') : t('live.none')));
      clear(preview);
      clear(info);
      return;
    }
    row = Math.min(row, list.length - 1);
    const n = visibleRows();
    if (row < top) top = row;
    if (row >= top + n) top = row - n + 1;
    if (!cur || cur.none) pickCell();

    const ve = vs + span();
    const cw = chW();
    const pps = (grid.clientWidth - cw) / span(); // pixel al secondo
    const x = (s: number) => cw + (Math.max(s, vs) - vs) * pps;

    // le etichette orarie troppo vicine alla linea "adesso" si nascondono, la sua etichetta le coprirebbe
    const nowX = x(now());
    times.replaceChildren(...Array.from({ length: span() / HALF }, (_, i) => cw + i * HALF * pps)
      .map((left, i) => h('span', { style: { left: `${left}px`, visibility: Math.abs(left - nowX) < 56 ? 'hidden' : '' } }, clock(vs + i * HALF))));

    const rh = rowH();
    const nodes: HTMLElement[] = [];
    const tNow = now();
    for (let i = top; i < Math.min(list.length, top + n + 1); i++) {
      const c = list[i];
      const y = (i - top) * rh;
      nodes.push(h('div', { class: 'lv-ch' + (i === row ? ' on' : ''), style: { top: `${y}px` }, on: { click: () => focusAt(i, tNow) } },
        h('span', { class: 'lv-num' }, String(c.num ?? i + 1)),
        thumb(img(c.logo), c.name, 'ch-logo'),
        h('span', { class: 'lv-name' }, c.name),
        isFav('live', c.id) ? icon('star', 13, 'fav-dot') : null));
      for (const p of cellsOf(c, vs, ve)) {
        const isNow = p.s <= tNow && p.e > tNow;
        const past = p.e <= tNow;
        const sel = i === row && cur && p.s === cur.s && p.t === cur.t;
        const w = (Math.min(p.e, ve) - Math.max(p.s, vs)) * pps - 6;
        const cell = h('div', {
          class: 'lv-cell' + (isNow ? ' now' : '') + (past ? ' past' : '') + (p.none ? ' none' : '') + (sel ? ' sel' : ''),
          style: { top: `${y}px`, left: `${x(p.s)}px`, width: `${Math.max(w, 4)}px` },
          on: { click: () => { row = i; cur = p; anchor = Math.max(p.s, vs); grid.focus(); draw(); }, dblclick: () => act() },
        });
        if (w > 64) append(cell, [
          h('b', null, p.none ? t('live.noInfo') : p.t || t('live.untitled')),
          p.none ? null : h('small', null, `${clock(p.s)} – ${clock(p.e)}`, past && canArchive(c) && p.s > tNow - c.archive! * 86400 ? h('em', null, ' · ', t('live.replay')) : null)]);
        if (isNow && !p.none) cell.style.setProperty('--p', `${Math.min(100, ((tNow - p.s) / (p.e - p.s)) * 100)}%`);
        nodes.push(cell);
      }
    }
    if (tNow >= vs && tNow < ve) nodes.push(h('div', { class: 'lv-nowline', style: { left: `${x(tNow)}px` } }, h('span', null, clock(tNow))));
    body.replaceChildren(...nodes);
    drawTop();
    wantShort();
  }

  /* ---------------- canale e programma selezionati ---------------- */
  function drawTop() {
    const c = list[row];
    const p = cur;
    if (!c || !p) return;
    const tNow = now();
    const on = nowOf(c);
    const bar = (x: EpgItem) => {
      const b = h('div', { class: 'lv-progress' }, h('i'));
      (b.firstChild as HTMLElement).style.width = `${Math.min(100, ((tNow - x.s) / (x.e - x.s)) * 100)}%`;
      return b;
    };
    clear(preview);
    append(preview, [
      thumb(img(c.logo), c.name, 'lv-logo'),
      h('div', { class: 'lv-pv-bar' },
        h('span', { class: 'lv-pv-num' }, String(c.num ?? row + 1)), h('span', { class: 'lv-pv-name' }, c.name), h('span', { class: 'live-tag' }, 'LIVE'),
        on ? h('span', { class: 'lv-pv-now' }, on.t) : null),
      on ? bar(on) : null]);

    const isNow = !p.none && p.s <= tNow && p.e > tNow;
    const past = !p.none && p.e <= tNow;
    const archivable = past && canArchive(c) && p.s > tNow - c.archive! * 86400;
    const fav = isFav('live', c.id);
    const when = p.none ? c.group : `${isNow ? t('live.onNow') : past ? (archivable ? t('live.catchup') : t('live.earlier')) : t('live.later')} · ${clock(p.s)} – ${clock(p.e)}`;
    const btns: HTMLElement[] = [];
    if (archivable) btns.push(h('button', { class: 'btn primary lg', on: { click: () => playArchive(c, p) } }, icon('rew', 18), t('live.replay')));
    btns.push(h('button', { class: 'btn lg ' + (archivable ? 'ghost' : 'primary'), on: { click: () => play(channelRequest(c), list) } }, icon('play', 18), t('common.watch')));
    if (isNow && canArchive(c)) btns.push(h('button', { class: 'btn ghost lg', on: { click: () => playArchive(c, p) } }, icon('rew', 18), t('lib.fromStart')));
    btns.push(h('button', { class: 'btn ghost lg icon-only', title: fav ? t('live.inFav') : t('live.fav'), 'aria-label': t('live.fav'), 'aria-pressed': String(fav),
      on: { click: async () => { await toggleFav('live', c.id); draw(); info.querySelector<HTMLElement>('.icon-only')?.focus(); } } },
    icon('star', 18)));

    clear(info);
    append(info, [
      h('span', { class: 'eyebrow' }, when),
      h('h1', { class: 'lv-title' }, p.none ? c.name : p.t || t('live.untitled')),
      h('div', { class: 'lv-chline' }, thumb(img(c.logo), c.name, 'ch-logo sm'), h('span', null, c.name), c.archive ? h('span', { class: 'tag', title: t('live.archiveDays', { n: c.archive }) }, 'REC') : null),
      p.d ? h('p', { class: 'lv-desc' }, p.d) : p.none && state.epgStatus === 'loading' ? h('p', { class: 'lv-desc' }, t('live.loadingGuide')) : null,
      isNow ? bar(p) : null,
      h('div', { class: 'row gap lv-actions' }, btns)]);
  }

  /* ---------------- azioni ---------------- */
  function act() {
    const c = list[row];
    const p = cur;
    if (!c) return;
    const tNow = now();
    if (p && !p.none && p.e <= tNow && canArchive(c) && p.s > tNow - c.archive! * 86400) playArchive(c, p);
    else play(channelRequest(c), list);
  }

  function playArchive(c: Channel, p: EpgItem) {
    const s = active() as XtreamSource;
    const url = timeshiftUrl(s, c.xid!, p.s, Math.min(p.e, now() + 60), state.lib?.tz);
    play({ kind: 'catchup', live: false, title: p.t || c.name, subtitle: `${c.name} · ${clock(p.s)}`, logo: c.logo, url, channel: c });
    toast(t('live.archivePlaying'), 'ok');
  }

  function focusAt(i: number, at: number) {
    row = i;
    anchor = at;
    cur = undefined;
    grid.focus();
    draw();
  }

  /** sposta la finestra perché la cella sia leggibile, entro i limiti navigabili */
  function reveal(p: Cell) {
    if (p.s < vs) vs = Math.max(minStart, floorHalf(p.s));
    else if (p.s >= vs + span() - HALF) vs = Math.min(maxEnd - span(), floorHalf(p.s) - HALF);
  }

  function focusCats() {
    const p = parentOf(group);
    if (p && open !== p.key && !query) {
      open = p.key;
      renderCats();
    }
    (tree.querySelector<HTMLElement>('.lv-cat.on') || tree.querySelector<HTMLElement>('.lv-cat'))?.focus();
  }
  // da una categoria: → va alla griglia, ← su una categoria aperta la chiude
  tree.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (e.key === 'ArrowRight' && list.length) {
      e.preventDefault();
      e.stopPropagation();
      grid.focus();
    } else if (e.key === 'ArrowLeft' && el.dataset.node && el.classList.contains('open')) {
      e.preventDefault();
      e.stopPropagation();
      toggle(el.dataset.node);
    }
  });
  // con il filtro: ↓ porta ai risultati
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && list.length) (e.preventDefault(), e.stopPropagation(), grid.focus());
  });

  /* ---------------- telecomando ---------------- */
  grid.addEventListener('keydown', (e) => {
    const c = list[row];
    if (!c) return;
    let handled = true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'ChannelDown' || e.key === 'ChannelUp') {
      const step = e.key.startsWith('Arrow') ? 1 : visibleRows();
      const down = e.key.endsWith('Down');
      if (!down && row === 0) {
        info.querySelector<HTMLElement>('.btn')?.focus(); // sopra la griglia: i pulsanti del programma
      } else {
        row = Math.max(0, Math.min(list.length - 1, row + (down ? step : -step)));
        if (cur && !cur.none) anchor = Math.max(cur.s, vs) + 1;
        cur = undefined;
        draw();
      }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const right = e.key === 'ArrowRight';
      const all = cellsOf(c, minStart, maxEnd);
      const i = cur ? all.findIndex((x) => x.s === cur!.s && x.t === cur!.t) : -1;
      if (cur?.none || i < 0) {
        // canale senza guida: si scorre il tempo di mezz'ora
        const nvs = vs + (right ? HALF : -HALF);
        if (nvs < minStart) handled = false;
        else if (nvs + span() <= maxEnd) (vs = nvs), (anchor = vs + 1), (cur = undefined), draw();
      } else {
        const next = all[i + (right ? 1 : -1)];
        // senza replay il passato non si può guardare: ← dal programma in onda torna alle categorie
        const nowLive = cur!.s <= now() && cur!.e > now();
        if (!right && nowLive && !canArchive(c)) handled = false;
        else if (!next || next.e <= minStart) handled = right; // a sinistra si esce verso le categorie
        else if (next.s < maxEnd) {
          cur = next;
          anchor = Math.max(next.s, minStart) + 1;
          reveal(next);
          draw();
        }
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      act();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'ArrowLeft') {
      // uscita dalla griglia: sulla categoria attiva (aperta, se è una sottocategoria)
      e.preventDefault();
      e.stopPropagation();
      focusCats();
    }
  });
  grid.addEventListener('wheel', (e) => {
    if (!list.length) return;
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      vs = Math.max(minStart, Math.min(maxEnd - span(), vs + Math.sign(e.deltaX) * HALF));
    } else {
      row = Math.max(0, Math.min(list.length - 1, row + Math.sign(e.deltaY) * 2));
      cur = undefined;
    }
    draw();
  }, { passive: false });
  grid.addEventListener('focus', () => grid.classList.add('focused'));
  grid.addEventListener('blur', () => grid.classList.remove('focused'));

  filter.addEventListener('input', () => {
    query = filter.value.trim();
    renderCats();
    refilter();
  });

  renderCats();
  // le misure servono dopo l'inserimento nella pagina
  requestAnimationFrame(() => {
    refilter();
    grid.focus({ preventScroll: true });
  });
  const ro = new ResizeObserver(() => view.isConnected && list.length && draw());
  ro.observe(grid);
  // la linea "adesso" e le barre di avanzamento si aggiornano ogni 30 s
  const tick = setInterval(() => (view.isConnected ? document.activeElement !== filter && draw() : (clearInterval(tick), ro.disconnect())), 30000);

  // la guida XMLTV si carica in background; quando arriva si ridisegna
  let epgSeen = state.epgStatus === 'ready';
  const off = onChange(() => {
    if (!view.isConnected) return off();
    if (state.epgStatus === 'ready' && !epgSeen) {
      epgSeen = true;
      cur = undefined;
      draw();
    }
  });
  queueMicrotask(() => loadGuide());
  return view;
}
