/** Hash FNV-1a a 32 bit in base36: id stabili per voci M3U senza id. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Minuscolo senza accenti: ricerca tollerante ("perche" trova "Perché"). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const ADULT = /\b(adult[io]?|xxx|18\+|porn|hot\s?club|for adults|erotic)/i;
export const isAdult = (...s: (string | undefined)[]) => s.some((x) => !!x && ADULT.test(x));

/** Decodifica entità HTML comuni nei titoli dei provider ("Tom &amp; Jerry"). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, k: string) => {
    const l = k.toLowerCase();
    if (l[0] === '#') {
      const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[l];
  });
}

/** Rimuove prefissi lingua tipo "|IT| ", "IT: ", "[IT] " dai titoli. */
export function cleanTitle(s: string): string {
  const d = decodeEntities(s).trim();
  const t = d.replace(/^\s*(?:\|\s*[a-z]{2,3}\s*\||[a-z]{2,3}\s*[|:]|\[\s*[a-z]{2,3}\s*\])\s*/i, '').trim();
  return t || d;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor((sec / 60) % 60), h = Math.floor(sec / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export const clock = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function uid(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Ordina gruppi mantenendo l'ordine di prima comparsa. */
export function groupsOf<T extends { group: string }>(items: T[]): string[] {
  const seen = new Set<string>();
  for (const i of items) seen.add(i.group);
  return [...seen];
}
