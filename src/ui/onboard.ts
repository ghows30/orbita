import { native } from '../core/api';
import type { Source } from '../core/types';
import { uid } from '../core/util';
import { normalizeHost, parseXtreamLink } from '../core/xtream';
import { addSource, loadLibrary } from '../state';
import { h, icon, modal, toast } from './dom';
import { t } from '../i18n';

const MAX_FILE = 200 * 1024 * 1024;

/** Campi di una sorgente: dal form della TV o dallo smartphone (quindi non fidati). */
interface Fields {
  type?: unknown;
  name?: unknown;
  host?: unknown;
  user?: unknown;
  pass?: unknown;
  format?: unknown;
  url?: unknown;
  epgUrl?: unknown;
  ua?: unknown;
}

/** Valida i campi e costruisce la sorgente; in caso di errore restituisce il messaggio. */
function buildSource(f: Fields, id: string, fileName?: string): Source | string {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const base = { id, name: str(f.name).slice(0, 40) || t('src.defaultName'), ua: str(f.ua).slice(0, 200) || undefined, epgUrl: str(f.epgUrl) || undefined };
  if (base.epgUrl && !/^https?:\/\/\S+$/i.test(base.epgUrl)) return t('src.err.epg');
  if (f.type === 'xtream') {
    let host = str(f.host);
    let user = str(f.user);
    let pass = typeof f.pass === 'string' ? f.pass : '';
    const link = parseXtreamLink(host);
    if (link) ({ host, user, pass } = link);
    if (!host || !user || !pass) return t('src.err.xtreamFields');
    const hst = normalizeHost(host);
    if (!/^https?:\/\/[^\s/]+$/i.test(hst)) return t('src.err.host');
    return { ...base, type: 'xtream', host: hst, user, pass, format: f.format === 'ts' ? 'ts' : 'm3u8' };
  }
  if (f.type === 'm3u') {
    const url = str(f.url);
    if (!/^https?:\/\/\S+$/i.test(url)) return t('src.err.url');
    return { ...base, type: 'm3u', url };
  }
  if (f.type === 'file' && fileName) return { ...base, type: 'file', fileName };
  return t('src.err.type');
}

/** Scarica la playlist e la salva; restituisce il riepilogo da mostrare. */
async function importSource(src: Source, step: (m: string) => void, text?: string): Promise<string> {
  const lib = await loadLibrary(src, step, text);
  const total = lib.live.length + lib.movies.length + lib.series.length;
  if (!total) throw new Error(t('src.empty'));
  await addSource(src, lib);
  return t('src.loaded', { l: lib.live.length, m: lib.movies.length, s: lib.series.length });
}

/** TV: QR + indirizzo locale; la playlist si compila dallo smartphone e arriva qui tramite il server nativo. */
function addFromPhone(onDone: () => void) {
  if (!native?.remoteStart) return;
  let info: { url: string; code: string; qr: string } | null = null;
  try {
    info = JSON.parse(native.remoteStart() || 'null');
  } catch {
    /* risposta non valida */
  }
  if (!info) return toast(t('phone.noNetwork'), 'error');
  const status = h('div', { class: 'form-progress' });
  const step = (m: string, spin = true) => status.replaceChildren(...(spin ? [h('span', { class: 'spinner' })] : []), h('span', null, m));
  step(t('phone.waiting'));
  let busy = false;
  const close = modal(h('div', { class: 'phone-add' },
    h('h2', null, t('phone.title')),
    h('div', { class: 'phone-add-body' },
      h('img', { class: 'qr', src: info.qr, alt: t('phone.qrAlt') }),
      h('ol', { class: 'steps' },
        h('li', null, t('phone.step1')),
        h('li', null, t('phone.step2'), h('b', null, info.url)),
        h('li', null, t('phone.step3'), h('b', { class: 'pin' }, info.code)),
        h('li', null, t('phone.step4')))),
    status), {
    onClose: () => {
      window.orbitaRemoteSource = undefined;
      native!.remoteStop?.();
    },
  });
  window.orbitaRemoteSource = async (json) => {
    if (busy) return;
    let f: Fields = {};
    try {
      f = JSON.parse(json) ?? {};
    } catch {
      /* gestito da buildSource */
    }
    const src = buildSource(f, uid());
    if (typeof src === 'string') {
      native!.remoteResult?.(false, src);
      return step(t('phone.fix', { m: src }), false);
    }
    busy = true;
    step(t('phone.received'));
    try {
      const msg = await importSource(src, step);
      native!.remoteResult?.(true, msg);
      toast(msg, 'ok');
      step(`✓ ${msg}`, false);
      setTimeout(() => (close(), onDone()), 2500);
    } catch (err) {
      const m = (err as Error).message || t('phone.failed');
      native!.remoteResult?.(false, m);
      step(t('phone.fixDash', { m }), false);
    } finally {
      busy = false;
    }
  };
}

/** Form per aggiungere (o modificare) una sorgente. Valida tutto lato client prima di contattare il server. */
export function sourceForm(onDone: () => void, edit?: Source): HTMLElement {
  let tab: Source['type'] = edit?.type ?? 'xtream';
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const body = h('div', { class: 'stack' });
  const progress = h('div', { class: 'form-progress', hidden: true });
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, icon('plus', 18), t('form.submit'));

  const field = (label: string, input: HTMLInputElement, hint?: string) =>
    h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null);

  const name = h('input', { placeholder: t('form.namePh'), maxLength: 40, value: edit?.name ?? '' });
  const host = h('input', { placeholder: 'http://server.tld:8080', autocomplete: 'off', spellcheck: false, value: edit?.type === 'xtream' ? edit.host : '' });
  const user = h('input', { autocomplete: 'off', autocapitalize: 'off', spellcheck: false, value: edit?.type === 'xtream' ? edit.user : '' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', value: edit?.type === 'xtream' ? edit.pass : '' });
  const fmt = h('select', { class: 'select' },
    h('option', { value: 'm3u8' }, t('form.hls')),
    h('option', { value: 'ts' }, 'MPEG-TS (.ts)'));
  if (edit?.type === 'xtream') fmt.value = edit.format;
  const url = h('input', { placeholder: 'https://…/playlist.m3u', autocomplete: 'off', spellcheck: false, value: edit?.type === 'm3u' ? edit.url : '' });
  const epg = h('input', { placeholder: t('form.epgPh'), autocomplete: 'off', spellcheck: false, value: edit?.epgUrl ?? '' });
  const ua = h('input', { placeholder: t('form.uaPh'), autocomplete: 'off', maxLength: 200, value: edit?.ua ?? '' });
  const file = h('input', { type: 'file', accept: '.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain' });
  const showPass = h('button', { type: 'button', class: 'link-btn', on: { click: () => (pass.type = pass.type === 'password' ? 'text' : 'password') } }, t('form.show'));

  // incollare un link get.php completo riempie i campi
  host.addEventListener('paste', () => setTimeout(() => {
    const x = parseXtreamLink(host.value);
    if (x) {
      host.value = x.host;
      user.value = x.user;
      pass.value = x.pass;
      toast(t('form.linkRecognized'), 'ok');
    }
  }));

  const renderTab = () => {
    tabs.replaceChildren(
      ...([['xtream', 'Xtream Codes'], ['m3u', t('form.tabM3u')], ['file', t('form.tabFile')]] as const).filter(([k]) => !(native && k === 'file')).map(([k, l]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', on: { click: () => ((tab = k), renderTab()) } }, l)),
    );
    const adv = h('details', { class: 'adv' }, h('summary', null, t('form.advanced')),
      field(t('form.epg'), epg), field('User-Agent', ua, t('form.uaHint')));
    body.replaceChildren(
      field(t('form.name'), name),
      ...(tab === 'xtream'
        ? [field(t('form.server'), host, t('form.serverHint')), field(t('form.user'), user),
          h('label', { class: 'field' }, h('span', null, t('form.password') + ' ', showPass), pass), h('label', { class: 'field' }, h('span', null, t('form.liveFormat')), fmt)]
        : tab === 'm3u' ? [field(t('form.url'), url)]
          : [field(t('form.file'), file, t('form.fileHint'))]),
      adv,
    );
  };
  renderTab();

  // su TV scrivere URL e password col telecomando è scomodo: si compila tutto dallo smartphone
  const phone = !edit && native?.remoteStart && native.isTv()
    ? h('button', { type: 'button', class: 'btn ghost phone-btn', on: { click: () => addFromPhone(onDone) } }, icon('phone', 18), t('form.fromPhone'))
    : null;

  const form = h('form', { class: 'source-form', autocomplete: 'off' },
    h('h2', null, edit ? t('form.edit') : t('form.add')),
    h('p', { class: 'muted' }, native ? t('form.noteNative') : t('form.noteWeb')),
    phone, tabs, body, progress, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = edit?.id ?? uid();
    let text: string | undefined;
    let fileName: string | undefined;
    if (tab === 'file') {
      const f = file.files?.[0];
      if (!f) return toast(t('form.chooseFile'), 'error');
      if (f.size > MAX_FILE) return toast(t('form.fileTooBig'), 'error');
      text = await f.text();
      fileName = f.name;
    }
    const src = buildSource({ type: tab, name: name.value, host: host.value, user: user.value, pass: pass.value, format: fmt.value, url: url.value, epgUrl: epg.value, ua: ua.value }, id, fileName);
    if (typeof src === 'string') return toast(src, 'error');
    submit.disabled = true;
    progress.hidden = false;
    const step = (m: string) => progress.replaceChildren(h('span', { class: 'spinner' }), h('span', null, m));
    try {
      toast(await importSource(src, step, text), 'ok');
      onDone();
    } catch (err) {
      toast((err as Error).message || t('phone.failed'), 'error');
    } finally {
      submit.disabled = false;
      progress.hidden = true;
    }
  });
  return form;
}

export function welcome(onDone: () => void): HTMLElement {
  const demo = async () => {
    try {
      const text = await (await fetch('/demo.m3u')).text();
      const src: Source = { id: uid(), name: 'Demo', type: 'file', fileName: 'demo.m3u' };
      const lib = await loadLibrary(src, undefined, text);
      await addSource(src, lib);
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return h('div', { class: 'welcome' },
    h('div', { class: 'welcome-hero' },
      h('div', { class: 'orbit-logo xl' }, h('i'), h('b')),
      h('h1', null, t('welcome.title'), h('span', { class: 'accent' }, 'ORBITA')),
      h('p', { class: 'lead' }, t('welcome.lead')),
      h('ul', { class: 'perks' },
        h('li', null, icon('shield', 18), t('welcome.perk1')),
        h('li', null, icon('live', 18), t('welcome.perk2')),
        h('li', null, icon('clock', 18), t('welcome.perk3'))),
      h('button', { class: 'btn ghost', on: { click: demo } }, icon('play', 16), t('welcome.demo')),
      h('p', { class: 'fine' }, t('welcome.disclaimer'))),
    h('div', { class: 'welcome-form card' }, sourceForm(onDone)));
}
