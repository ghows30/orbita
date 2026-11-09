// Temi dell'interfaccia: i colori sono tutti in styles.css ([data-theme="…"]),
// qui c'è solo la scelta (salvata sul dispositivo) e l'applicazione all'avvio.

export const THEMES = [
  { id: 'brace', name: 'Brace', bg: '#0e0d0c', light: false },
  { id: 'assenzio', name: 'Assenzio', bg: '#08110f', light: false },
  { id: 'cobalto', name: 'Cobalto', bg: '#0b0c0f', light: false },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const KEY = 'orbita.theme';

export function currentTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY);
    const hit = THEMES.find((x) => x.id === t);
    if (hit) return hit.id;
  } catch {
    /* storage non disponibile: tema predefinito */
  }
  return THEMES[0].id;
}

export function applyTheme(id: ThemeId = currentTheme()) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', t.light ? 'light' : 'dark');
}

export function setTheme(id: ThemeId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* resta valido solo per questa sessione */
  }
  applyTheme(id);
}
