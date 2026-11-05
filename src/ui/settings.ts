import { native } from '../core/api';
import { kv } from '../core/store';
import { active, clearHistory, emit, refreshActive, removeSource, saveSettings, setPin, state, switchSource, unlock } from '../state';
import { askConfirm, askPin, h, icon, modal, toast } from './dom';
import { sourceForm } from './onboard';

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
          !isActive ? h('button', { class: 'btn tiny', on: { click: async () => (await switchSource(s.id), toast(`Playlist attiva: ${s.name}`, 'ok'), rerender()) } }, 'Usa') : h('span', { class: 'tag ok' }, 'Attiva'),
          s.type !== 'file' ? h('button', { class: 'icon-btn', title: 'Modifica', 'aria-label': 'Modifica', on: { click: () => { const close = modal(sourceForm(() => (close(), rerender()), s), { wide: false }); } } }, icon('settings', 18)) : null,
          h('button', { class: 'icon-btn danger', title: 'Elimina', 'aria-label': 'Elimina', on: { click: async () => { if (await askConfirm(`Eliminare "${s.name}"? Credenziali e libreria verranno cancellate.`)) { await removeSource(s.id); rerender(); } } } }, icon('trash', 18))));
    }));

  const refreshBtn = h('button', { class: 'btn ghost', disabled: !cur || cur.type === 'file' }, icon('refresh', 18), 'Aggiorna libreria');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await refreshActive((m) => (refreshBtn.lastChild!.textContent = m));
      toast('Libreria aggiornata', 'ok');
      rerender();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.lastChild!.textContent = 'Aggiorna libreria';
    }
  });

  const lib = state.lib;
  const exp = lib?.expires ? new Date(lib.expires).toLocaleDateString('it-IT') : null;

  const toggle = (label: string, desc: string, value: boolean, set: (v: boolean) => Promise<void> | void) => {
    const input = h('input', { type: 'checkbox', checked: value, class: 'switch' });
    input.addEventListener('change', () => set(input.checked));
    return h('label', { class: 'setting' }, h('div', null, h('b', null, label), h('small', null, desc)), input);
  };

  const parental = toggle('Controllo parentale', 'Nasconde categorie per adulti finché non inserisci il PIN.', state.settings.parental, async (v) => {
    if (!v && state.settings.pin) {
      const pin = await askPin('Inserisci il PIN per disattivare');
      if (!pin || !(await unlock(pin))) {
        toast('PIN errato', 'error');
        return rerender();
      }
    }
    if (v && !state.settings.pin) {
      const pin = await askPin('Scegli un PIN (4-8 cifre)');
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
      const pin = await askPin('Sblocca contenuti protetti');
      if (pin && (await unlock(pin))) { toast('Contenuti sbloccati per questa sessione', 'ok'); rerender(); } else if (pin) toast('PIN errato', 'error');
    } } }, icon('lock', 18), state.unlocked ? 'Blocca di nuovo' : 'Sblocca con PIN')
    : null;

  const autoNext = toggle('Episodio successivo automatico', 'Alla fine di un episodio parte il successivo.', state.settings.autoNext, async (v) => {
    state.settings.autoNext = v;
    await saveSettings();
  });

  const wipe = h('button', { class: 'btn danger', on: { click: async () => {
    if (!(await askConfirm('Cancellare TUTTI i dati di ORBITA da questo dispositivo (playlist, credenziali, preferiti, cronologia)?', 'Cancella tutto'))) return;
    await kv.clear();
    localStorage.clear();
    location.reload();
  } } }, icon('trash', 18), 'Cancella tutti i dati');

  return h('div', { class: 'page settings' },
    h('div', { class: 'page-head' }, h('h1', null, 'Impostazioni')),
    h('section', { class: 'card pad' },
      h('div', { class: 'card-head' }, h('h3', null, 'Playlist'),
        h('button', { class: 'btn primary', on: { click: () => { const close = modal(sourceForm(() => (close(), rerender()))); } } }, icon('plus', 18), 'Aggiungi')),
      sources,
      lib ? h('p', { class: 'muted' }, `${lib.live.length} canali · ${lib.movies.length} film · ${lib.series.length} serie · aggiornata ${new Date(lib.loadedAt).toLocaleString('it-IT')}${exp ? ` · abbonamento fino al ${exp}` : ''}`) : null,
      refreshBtn),
    h('section', { class: 'card pad' }, h('h3', null, 'Riproduzione'), autoNext),
    h('section', { class: 'card pad' }, h('h3', null, 'Protezione'), parental, unlockBtn,
      h('button', { class: 'btn ghost', on: { click: async () => (await clearHistory(), toast('Cronologia cancellata', 'ok')) } }, icon('clock', 18), 'Cancella cronologia')),
    h('section', { class: 'card pad' }, h('h3', null, 'Sicurezza'),
      h('ul', { class: 'sec-list' },
        h('li', null, icon('shield', 16), 'Credenziali e librerie cifrate AES-GCM 256 con chiave non estraibile del browser.'),
        native
          ? h('li', null, icon('shield', 16), "L'interfaccia gira in una WebView chiusa: niente pagine esterne, nessuna porta aperta sul dispositivo.")
          : h('li', null, icon('shield', 16), 'Il server ascolta solo su 127.0.0.1 e blocca richieste da altri siti (CSRF / DNS rebinding).'),
        native
          ? h('li', null, icon('shield', 16), 'Riproduzione nel player nativo: password mai nella cronologia o nei log.')
          : h('li', null, icon('shield', 16), 'Gli stream usano token opachi: password mai negli URL, nei log o nella cronologia.'),
        h('li', null, icon('shield', 16), 'Il proxy rifiuta indirizzi interni (SSRF) e i dati della playlist non vengono mai interpretati come HTML.'),
        h('li', null, icon('shield', 16), 'PIN parentale con PBKDF2 (210.000 iterazioni), mai salvato in chiaro.')),
      wipe),
    h('p', { class: 'fine center' }, `ORBITA ${native ? native.version() : '1.0'} · Tasti: Spazio play/pausa · ←/→ salta · ↑/↓ canale · F schermo intero · I tracce · L lista canali · Esc indietro`));
}

function safeHost(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
