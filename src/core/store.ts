import { t } from '../i18n';
// Persistenza locale in IndexedDB. Fonti (credenziali) e librerie (URL con credenziali) sono
// cifrate AES-GCM 256 con una chiave NON estraibile generata dal browser: nemmeno il codice
// della pagina può leggerne i byte, e i dati su disco non sono in chiaro.
// Nessun fallback in chiaro: se WebCrypto manca, l'app si rifiuta di salvare credenziali.

const DB = 'orbita';
const VER = 1;
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('kv');
      r.result.createObjectStore('keys');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((res, rej) => {
        const t = d.transaction(store, mode);
        const q = fn(t.objectStore(store));
        t.oncomplete = () => res(q.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      }),
  );
}

export const kv = {
  get: <T>(k: string) => tx<T | undefined>('kv', 'readonly', (s) => s.get(k) as IDBRequest<T | undefined>),
  set: (k: string, v: unknown) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  del: (k: string) => tx('kv', 'readwrite', (s) => s.delete(k)),
  clear: async () => {
    await tx('kv', 'readwrite', (s) => s.clear());
    await tx('keys', 'readwrite', (s) => s.clear());
  },
};

let keyp: Promise<CryptoKey> | null = null;
function masterKey(): Promise<CryptoKey> {
  if (!crypto?.subtle) return Promise.reject(new Error(t('err.noCrypto')));
  return (keyp ||= (async () => {
    const existing = await tx<CryptoKey | undefined>('keys', 'readonly', (s) => s.get('master') as IDBRequest<CryptoKey | undefined>);
    if (existing) return existing;
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await tx('keys', 'readwrite', (s) => s.put(k, 'master'));
    return k;
  })());
}

interface Sealed { v: 1; iv: Uint8Array; ct: ArrayBuffer }

export async function sealSet(k: string, value: unknown): Promise<void> {
  const key = await masterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(k) }, key, data);
  await kv.set(k, { v: 1, iv, ct } satisfies Sealed);
}

export async function sealGet<T>(k: string): Promise<T | undefined> {
  const s = await kv.get<Sealed>(k);
  if (!s || s.v !== 1) return undefined;
  const key = await masterKey();
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv, additionalData: new TextEncoder().encode(k) }, key, s.ct);
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return undefined; // dato manomesso o chiave cambiata
  }
}

/* PIN parental: PBKDF2-SHA256, 210k iterazioni, salt casuale. Il PIN non viene mai salvato. */
export interface PinHash { salt: Uint8Array; hash: ArrayBuffer }

async function derive(pin: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210_000 }, base, 256);
}
export async function hashPin(pin: string): Promise<PinHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt, hash: await derive(pin, salt) };
}
export async function checkPin(pin: string, h: PinHash): Promise<boolean> {
  const a = new Uint8Array(await derive(pin, h.salt));
  const b = new Uint8Array(h.hash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
