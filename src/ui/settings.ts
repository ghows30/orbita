import { native } from '../core/api';
import { kv } from '../core/store';
import { active, clearHistory, emit, refreshActive, removeSource, saveSettings, setPin, state, switchSource, unlock } from '../state';
import { askConfirm, askPin, h, icon, modal, toast } from './dom';
import { phoneLink, sourceForm } from './onboard';
import { currentTheme, setTheme, THEMES } from './theme';
import { currentLang, LANGS, locale, num, setLang, t } from '../i18n';
import { metaKeys, saveMetaKeys, setMetaLang, testMetaKeys } from '../core/meta';

/** Chiavi dallo smartphone: un campo vuoto mantiene la chiave già salvata; si provano prima di salvarle. */
function keysFromPhone(rerender: () => void) {
  phoneLink({
    title: t('set.metaPhoneTitle'),
    start: () => native!.remoteStartKeys!(),
    lastStep: t('set.metaPhoneStep'),
    onDone: rerender,
    handle: async (json) => {
      let k: { tmdb?: unknown; omdb?: unknown } = {};
      try {
        k = JSON.parse(json) ?? {};
      } catch {
        /* sotto: nessuna chiave */
      }
      const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
      const cur = metaKeys();
      const next = { tmdb: str(k.tmdb) || cur.tmdb || '', omdb: str(k.omdb) || cur.omdb || '' };
      if (!str(k.tmdb) && !str(k.omdb)) throw new Error(t('set.metaNone'));
      const ok = await testMetaKeys({ tmdb: str(k.tmdb) || undefined, omdb: str(k.omdb) || undefined });
      const bad = (['tmdb', 'omdb'] as const).filter((s) => ok[s] === false);
      if (bad.length) throw new Error(t('set.metaBad', { s: bad.map((s) => s.toUpperCase()).join(', ') }));
      await saveMetaKeys(next);
      return t('set.metaSaved');
    },
  });
}

/** Chiavi TMDB / OMDb: facoltative, cifrate sul dispositivo, provate prima di salvarle. */
function metaSection(rerender: () => void): HTMLElement {
  const k = metaKeys();
  const inp = (value: string | undefined, label: string) =>
    h('input', { value: value || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': label, placeholder: '••••••••' });
  const tmdb = inp(k.tmdb, 'TMDB');
  const omdb = inp(k.omdb, 'OMDb');
  const save = h('button', { class: 'btn primary', type: 'submit' }, icon('check', 18), t('set.metaSave'));
  // su TV incollare chiavi lunghe col telecomando è impossibile: si inviano dallo smartphone
  const phone = native?.remoteStartKeys && native.isTv()
    ? h('button', { type: 'button', class: 'btn ghost', on: { click: () => keysFromPhone(rerender) } }, icon('phone', 18), t('set.metaPhone'))
    : null;
  const form = h('form', { class: 'stack meta-form' },
    h('p', { class: 'muted' }, t('set.metaDesc')),
    h('label', { class: 'field' }, h('span', null, t('set.tmdbKey')), tmdb, h('small', null, t('set.tmdbHint'))),
    h('label', { class: 'field' }, h('span', null, t('set.omdbKey')), omdb, h('small', null, t('set.omdbHint'))),
    h('div', { class: 'row gap wrap' }, phone, save),
    h('p', { class: 'fine' }, t('set.metaPrivacy')),
    h('p', { class: 'fine' }, t('set.tmdbNotice')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const next = { tmdb: tmdb.value.trim(), omdb: omdb.value.trim() };
      const ok = await testMetaKeys(next);
      const bad = (['tmdb', 'omdb'] as const).filter((s) => ok[s] === false);
      if (bad.length) return toast(t('set.metaBad', { s: bad.map((s) => s.toUpperCase()).join(', ') }), 'error');
      await saveMetaKeys(next);
      toast(next.tmdb || next.omdb ? t('set.metaSaved') : t('set.metaCleared'), 'ok');
      rerender();
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

/** Scelta del tema: cambia sul posto, senza ridisegnare la pagina (il focus resta dov'è). */
function themePicker(): HTMLElement {
  const cur = currentTheme();
  const opts: HTMLButtonElement[] = THEMES.map((th) =>
    h('button', { class: 'theme-opt' + (th.id === cur ? ' on' : ''), 'aria-pressed': String(th.id === cur), on: { click: () => {
      setTheme(th.id);
      for (const [i, o] of opts.entries()) {
        o.classList.toggle('on', THEMES[i].id === th.id);
        o.setAttribute('aria-pressed', String(THEMES[i].id === th.id));
      }
    } } },
      h('div', { class: 'theme-prev', 'data-theme': th.id, 'aria-hidden': 'true' },
        h('div', { class: 'tp-side' }, h('i'), h('i'), h('i')),
        h('div', { class: 'tp-main' }, h('i'), h('i'), h('b'))),
      h('div', { class: 'theme-meta' }, h('b', null, th.name), h('small', null, t(`theme.${th.id}`)))));
  return h('div', { class: 'theme-list' }, opts);
}

/** Scelta della lingua: ridisegna tutta l'interfaccia e riporta il focus sul pulsante scelto. */
function langPicker(rerender: () => void): HTMLElement {
  const cur = currentLang();
  return h('div', { class: 'seg lang-seg', role: 'radiogroup', 'aria-label': t('set.language') },
    LANGS.map((l) => h('button', { class: l.id === cur ? 'on' : '', role: 'radio', 'aria-checked': String(l.id === cur), lang: l.id, 'data-lang': l.id,
      on: { click: () => {
        if (l.id === currentLang()) return;
        setLang(l.id);
        setMetaLang(locale());
        native?.setLang?.(l.id);
        rerender();
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`.lang-seg [data-lang="${l.id}"]`)?.focus());
      } } }, l.name)));
}

export function settingsView(rerender: () => void): HTMLElement {
  const cur = active();
  const sources = h('div', { class: 'src-list' },
    state.sources.map((s) => {
      const isActive = s.id === cur?.id;
      const detail = s.type === 'xtream' ? `Xtream · ${new URL(s.host).host}` : s.type === 'm3u' ? `M3U · ${safeHost(s.url)}` : `File · ${s.fileName}`;
      return h('div', { class: 'src' + (isActive ? ' on' : '') },
        h('div', { class: 'src-dot' }),
        h('div', { class: 'src-text' }, h('b', null, s.name), h('small', null, detail)),
        h('div', { class: 'row gap' },
          !isActive ? h('button', { class: 'btn tiny', on: { click: async () => (await switchSource(s.id), toast(t('set.active', { n: s.name }), 'ok'), rerender()) } }, t('set.use')) : h('span', { class: 'tag ok' }, t('set.activeTag')),
          s.type !== 'file' ? h('button', { class: 'icon-btn', title: t('set.edit'), 'aria-label': t('set.edit'), on: { click: () => { const close = modal(sourceForm(() => (close(), rerender()), s), { wide: false }); } } }, icon('settings', 18)) : null,
          h('button', { class: 'icon-btn danger', title: t('common.delete'), 'aria-label': t('common.delete'), on: { click: async () => { if (await askConfirm(t('set.confirmDelete', { n: s.name }))) { await removeSource(s.id); rerender(); } } } }, icon('trash', 18))));
    }));

  const refreshBtn = h('button', { class: 'btn ghost', disabled: !cur || cur.type === 'file' }, icon('refresh', 18), t('set.refresh'));
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await refreshActive((m) => (refreshBtn.lastChild!.textContent = m));
      toast(t('set.refreshed'), 'ok');
      rerender();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.lastChild!.textContent = t('set.refresh');
    }
  });

  const lib = state.lib;
  const exp = lib?.expires ? new Date(lib.expires).toLocaleDateString(locale()) : null;

  const toggle = (label: string, desc: string, value: boolean, set: (v: boolean) => Promise<void> | void) => {
    const input = h('input', { type: 'checkbox', checked: value, class: 'switch' });
    input.addEventListener('change', () => set(input.checked));
    return h('label', { class: 'setting' }, h('div', null, h('b', null, label), h('small', null, desc)), input);
  };

  const parental = toggle(t('set.parental'), t('set.parentalDesc'), state.settings.parental, async (v) => {
    if (!v && state.settings.pin) {
      const pin = await askPin(t('set.pinDisable'));
      if (!pin || !(await unlock(pin))) {
        toast(t('set.pinWrong'), 'error');
        return rerender();
      }
    }
    if (v && !state.settings.pin) {
      const pin = await askPin(t('set.pinChoose'));
      if (!pin) return rerender();
      await setPin(pin);
    }
    state.settings.parental = v;
    state.unlocked = false;
    await saveSettings();
    rerender();
  });

  const unlockBtn = state.settings.parental && state.settings.pin
    ? h('button', { class: 'btn ghost', on: { click: async () => {
      if (state.unlocked) { state.unlocked = false; emit(); return rerender(); }
      const pin = await askPin(t('set.unlockPrompt'));
      if (pin && (await unlock(pin))) { toast(t('set.unlocked'), 'ok'); rerender(); } else if (pin) toast(t('set.pinWrong'), 'error');
    } } }, icon('lock', 18), state.unlocked ? t('set.relock') : t('set.unlock'))
    : null;

  const autoNext = toggle(t('set.autoNext'), t('set.autoNextDesc'), state.settings.autoNext, async (v) => {
    state.settings.autoNext = v;
    await saveSettings();
  });

  const seekPreview = toggle(t('set.seekPreview'), t('set.seekPreviewDesc'), state.settings.seekPreview !== false, async (v) => {
    state.settings.seekPreview = v;
    await saveSettings();
  });

  const wipe = h('button', { class: 'btn danger', on: { click: async () => {
    if (!(await askConfirm(t('set.wipeConfirm'), t('set.wipeOk')))) return;
    await kv.clear();
    localStorage.clear();
    location.reload();
  } } }, icon('trash', 18), t('set.wipe'));

  return h('div', { class: 'page settings' },
    h('div', { class: 'page-head' }, h('h1', null, t('set.title'))),
    h('section', { class: 'card pad' },
      h('div', { class: 'card-head' }, h('h3', null, t('set.playlists')),
        h('button', { class: 'btn primary', on: { click: () => { const close = modal(sourceForm(() => (close(), rerender()))); } } }, icon('plus', 18), t('set.add'))),
      sources,
      lib ? h('p', { class: 'muted' }, t('set.libSummary', { l: num(lib.live.length), m: num(lib.movies.length), s: num(lib.series.length), d: new Date(lib.loadedAt).toLocaleString(locale()) }) + (exp ? t('set.expires', { d: exp }) : '')) : null,
      refreshBtn),
    h('section', { class: 'card pad' }, h('h3', null, t('set.language')), langPicker(rerender)),
    h('section', { class: 'card pad' }, h('h3', null, t('set.appearance')), themePicker()),
    h('section', { class: 'card pad' }, h('h3', null, t('set.meta')), metaSection(rerender)),
    h('section', { class: 'card pad' }, h('h3', null, t('set.playback')), autoNext, seekPreview),
    h('section', { class: 'card pad' }, h('h3', null, t('set.protection')), parental, unlockBtn,
      h('button', { class: 'btn ghost', on: { click: async () => (await clearHistory(), toast(t('set.historyCleared'), 'ok')) } }, icon('clock', 18), t('set.clearHistory'))),
    h('section', { class: 'card pad' }, h('h3', null, t('set.security')),
      h('ul', { class: 'sec-list' },
        h('li', null, icon('shield', 16), t('set.sec1')),
        h('li', null, icon('shield', 16), native ? t('set.sec2Native') : t('set.sec2Web')),
        h('li', null, icon('shield', 16), native ? t('set.sec3Native') : t('set.sec3Web')),
        h('li', null, icon('shield', 16), t('set.sec4')),
        h('li', null, icon('shield', 16), t('set.sec5'))),
      wipe),
    h('p', { class: 'fine center' }, `ORBITA ${native ? native.version() : '1.0'} · ${t('set.keys')}`));
}

function safeHost(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
