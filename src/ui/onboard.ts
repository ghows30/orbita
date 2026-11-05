import { native } from '../core/api';
import type { Source } from '../core/types';
import { uid } from '../core/util';
import { normalizeHost, parseXtreamLink } from '../core/xtream';
import { addSource, loadLibrary } from '../state';
import { h, icon, toast } from './dom';

const MAX_FILE = 200 * 1024 * 1024;

/** Form per aggiungere (o modificare) una sorgente. Valida tutto lato client prima di contattare il server. */
export function sourceForm(onDone: () => void, edit?: Source): HTMLElement {
  let tab: Source['type'] = edit?.type ?? 'xtream';
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const body = h('div', { class: 'stack' });
  const progress = h('div', { class: 'form-progress', hidden: true });
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, icon('plus', 18), 'Aggiungi e carica');

  const field = (label: string, input: HTMLInputElement, hint?: string) =>
    h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null);

  const name = h('input', { placeholder: 'Es. Casa', maxLength: 40, value: edit?.name ?? '' });
  const host = h('input', { placeholder: 'http://server.tld:8080', autocomplete: 'off', spellcheck: false, value: edit?.type === 'xtream' ? edit.host : '' });
  const user = h('input', { autocomplete: 'off', autocapitalize: 'off', spellcheck: false, value: edit?.type === 'xtream' ? edit.user : '' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', value: edit?.type === 'xtream' ? edit.pass : '' });
  const fmt = h('select', { class: 'select' },
    h('option', { value: 'm3u8' }, 'HLS (.m3u8) – consigliato'),
    h('option', { value: 'ts' }, 'MPEG-TS (.ts)'));
  if (edit?.type === 'xtream') fmt.value = edit.format;
  const url = h('input', { placeholder: 'https://…/playlist.m3u', autocomplete: 'off', spellcheck: false, value: edit?.type === 'm3u' ? edit.url : '' });
  const epg = h('input', { placeholder: 'https://…/guide.xml(.gz) – opzionale', autocomplete: 'off', spellcheck: false, value: edit?.epgUrl ?? '' });
  const ua = h('input', { placeholder: 'Predefinito: VLC', autocomplete: 'off', maxLength: 200, value: edit?.ua ?? '' });
  const file = h('input', { type: 'file', accept: '.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain' });
  const showPass = h('button', { type: 'button', class: 'link-btn', on: { click: () => (pass.type = pass.type === 'password' ? 'text' : 'password') } }, 'mostra');

  // incollare un link get.php completo riempie i campi
  host.addEventListener('paste', () => setTimeout(() => {
    const x = parseXtreamLink(host.value);
    if (x) {
      host.value = x.host;
      user.value = x.user;
      pass.value = x.pass;
      toast('Link Xtream riconosciuto: campi compilati', 'ok');
    }
  }));

  const renderTab = () => {
    tabs.replaceChildren(
      ...([['xtream', 'Xtream Codes'], ['m3u', 'Link M3U'], ['file', 'File M3U']] as const).filter(([k]) => !(native && k === 'file')).map(([k, l]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', on: { click: () => ((tab = k), renderTab()) } }, l)),
    );
    const adv = h('details', { class: 'adv' }, h('summary', null, 'Opzioni avanzate'),
      field('Guida TV (XMLTV)', epg), field('User-Agent', ua, 'Alcuni provider accettano solo determinati player.'));
    body.replaceChildren(
      field('Nome', name),
      ...(tab === 'xtream'
        ? [field('Server', host, 'Puoi anche incollare il link get.php completo.'), field('Utente', user),
          h('label', { class: 'field' }, h('span', null, 'Password ', showPass), pass), h('label', { class: 'field' }, h('span', null, 'Formato live'), fmt)]
        : tab === 'm3u' ? [field('URL playlist', url)]
          : [field('File', file, 'Il file viene letto solo in locale.')]),
      adv,
    );
  };
  renderTab();

  const form = h('form', { class: 'source-form', autocomplete: 'off' },
    h('h2', null, edit ? 'Modifica playlist' : 'Aggiungi una playlist'),
    h('p', { class: 'muted' }, native ? 'Le credenziali sono cifrate sul dispositivo (AES-256) e inviate solo al tuo provider.' : 'Le credenziali sono cifrate nel browser (AES-256) e inviate solo al tuo server ORBITA locale.'),
    tabs, body, progress, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = edit?.id ?? uid();
    const base = { id, name: name.value.trim().slice(0, 40) || 'Playlist', ua: ua.value.trim() || undefined, epgUrl: epg.value.trim() || undefined };
    if (base.epgUrl && !/^https?:\/\/\S+$/i.test(base.epgUrl)) return toast('URL guida TV non valido', 'error');
    let src: Source;
    let text: string | undefined;
    if (tab === 'xtream') {
      if (!host.value.trim() || !user.value.trim() || !pass.value) return toast('Compila server, utente e password', 'error');
      const hst = normalizeHost(host.value);
      if (!/^https?:\/\/[^\s/]+$/i.test(hst)) return toast('Indirizzo server non valido', 'error');
      src = { ...base, type: 'xtream', host: hst, user: user.value.trim(), pass: pass.value, format: fmt.value as 'm3u8' | 'ts' };
    } else if (tab === 'm3u') {
      if (!/^https?:\/\/\S+$/i.test(url.value.trim())) return toast('Inserisci un URL http(s) valido', 'error');
      src = { ...base, type: 'm3u', url: url.value.trim() };
    } else {
      const f = file.files?.[0];
      if (!f) return toast('Scegli un file .m3u', 'error');
      if (f.size > MAX_FILE) return toast('File troppo grande (max 200 MB)', 'error');
      text = await f.text();
      src = { ...base, type: 'file', fileName: f.name };
    }
    submit.disabled = true;
    progress.hidden = false;
    const step = (m: string) => progress.replaceChildren(h('span', { class: 'spinner' }), h('span', null, m));
    try {
      const lib = await loadLibrary(src, step, text);
      const total = lib.live.length + lib.movies.length + lib.series.length;
      if (!total) throw new Error('La playlist è vuota.');
      await addSource(src, lib);
      toast(`Caricati ${lib.live.length} canali, ${lib.movies.length} film, ${lib.series.length} serie`, 'ok');
      onDone();
    } catch (err) {
      toast((err as Error).message || 'Caricamento non riuscito', 'error');
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
      h('h1', null, 'Benvenuto in ', h('span', { class: 'grad' }, 'ORBITA')),
      h('p', { class: 'lead' }, 'Il tuo player IPTV: TV in diretta con guida, film e serie, riprendi da dove eri rimasto.'),
      h('ul', { class: 'perks' },
        h('li', null, icon('shield', 18), 'Credenziali cifrate, mai negli URL'),
        h('li', null, icon('live', 18), 'Xtream Codes e M3U, HLS e MPEG-TS'),
        h('li', null, icon('clock', 18), 'Guida TV, catch-up e riconnessione automatica')),
      h('button', { class: 'btn ghost', on: { click: demo } }, icon('play', 16), 'Prova con la playlist demo'),
      h('p', { class: 'fine' }, 'ORBITA non fornisce contenuti: usa solo sorgenti che hai il diritto di guardare.')),
    h('div', { class: 'welcome-form card' }, sourceForm(onDone)));
}
