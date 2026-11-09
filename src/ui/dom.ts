// Costruzione DOM sicura: i dati dei provider entrano SOLO come textContent o attributi
// controllati, mai come HTML. Così un titolo malevolo nella playlist non può iniettare script.
import { t } from '../i18n';

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; on?: Record<string, EventListener> };

const URL_ATTRS = new Set(['src', 'href', 'poster', 'action']);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else {
        const s = String(v);
        if (URL_ATTRS.has(k) && !/^(\/|#|blob:|data:image\/)/.test(s)) continue; // solo URL locali/proxy
        el.setAttribute(k, v === true ? '' : s);
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/* ---------------- icone (path statici, nessun dato esterno) ---------------- */
const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  live: 'M4 7h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm4-4 4 4 4-4',
  movie: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  series: 'M3 6h18v12H3zM7 21h10M10 10l5 2.5-5 2.5z',
  heart: 'M12 20s-7-4.4-9.2-9A5 5 0 0 1 12 6a5 5 0 0 1 9.2 5C19 15.6 12 20 12 20z',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5',
  settings: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  play: 'M7 4.5v15a.5.5 0 0 0 .77.42l11.5-7.5a.5.5 0 0 0 0-.84L7.77 4.08A.5.5 0 0 0 7 4.5z',
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6 6 18',
  fwd: 'M12 5a7 7 0 1 1-7 7M12 5V2l4 3-4 3V5',
  rew: 'M12 5a7 7 0 1 0 7 7M12 5V2L8 5l4 3V5',
  vol: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  exitfull: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  pip: 'M3 5h18v14H3zM12 12h7v5h-7z',
  tracks: 'M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v6M12 7.5h.01',
  phone: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
};

export function icon(name: keyof typeof P | string, size = 20, cls = ''): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ico ' + cls);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', P[name] || '');
  const filled = name === 'play' || name === 'pause' || name === 'star';
  path.setAttribute('fill', filled ? 'currentColor' : 'none');
  path.setAttribute('stroke', filled ? 'none' : 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** Immagine con fallback a iniziali se il logo non carica. */
export function thumb(src: string | undefined, label: string, cls = 'thumb'): HTMLElement {
  const box = h('div', { class: cls });
  const initials = h('span', { class: 'initials' }, label.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 2).toUpperCase() || '•');
  box.appendChild(initials);
  if (src) {
    const im = h('img', { src, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' });
    im.addEventListener('load', () => box.classList.add('loaded'));
    im.addEventListener('error', () => im.remove());
    box.appendChild(im);
  }
  return box;
}

/* ---------------- toast ---------------- */
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

/* ---------------- modale ---------------- */
export function modal(content: HTMLElement, opts: { wide?: boolean; onClose?: () => void } = {}): () => void {
  const prev = document.activeElement as HTMLElement | null;
  const close = () => {
    wrap.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => wrap.remove(), 180);
    opts.onClose?.();
    prev?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    const open = document.querySelectorAll('.modal-wrap:not(.out)');
    if (open[open.length - 1] !== wrap) return; // con modali sovrapposte chiude solo quella in cima
    if (e.key === 'Escape' || e.key === 'Backspace' && !(e.target instanceof HTMLInputElement)) {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('button', { class: 'icon-btn modal-x', 'aria-label': t('common.close'), on: { click: close } }, icon('close')),
    content);
  const wrap = h('div', { class: 'modal-wrap', on: { mousedown: (e) => e.target === wrap && close() } }, box);
  document.body.appendChild(wrap);
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => (box.querySelector<HTMLElement>('input,button:not(.modal-x),[tabindex]') || box).focus());
  return close;
}

/** Conferma in stile ORBITA (al posto di confirm(), brutto su TV). "Annulla" ha il focus: un OK distratto non cancella nulla. */
export function askConfirm(message: string, okLabel = t('common.delete')): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      done = true;
      close();
      resolve(v);
    };
    const cancel = h('button', { class: 'btn ghost', on: { click: () => finish(false) } }, t('common.cancel'));
    const box = h('div', { class: 'stack' }, h('h3', null, t('common.sure')), h('p', { class: 'muted' }, message),
      h('div', { class: 'row gap' }, cancel, h('button', { class: 'btn danger', on: { click: () => finish(true) } }, okLabel)));
    const close = modal(box, { onClose: () => !done && resolve(false) });
    requestAnimationFrame(() => cancel.focus());
  });
}

/** Richiesta PIN (4-8 cifre). */
export function askPin(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', maxLength: 8, class: 'pin-input', 'aria-label': 'PIN' });
    const form = h('form', { class: 'stack' }, h('h3', null, title), input,
      h('button', { class: 'btn primary', type: 'submit' }, t('common.confirm')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!/^\d{4,8}$/.test(input.value)) return toast(t('pin.invalid'), 'error');
      done = true;
      close();
      resolve(input.value);
    });
    const close = modal(form, { onClose: () => !done && resolve(null) });
  });
}
