import { t, translateRemote } from '../i18n';
// Chiamate al server locale ORBITA. Gli URL dei provider (con credenziali) viaggiano solo
// nel corpo delle POST e tornano come percorsi opachi /p/<token>.

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

/** Ponte esposto dall'app Android TV / Fire TV (assente nel browser). */
export interface NativeBridge {
  prepare(path: string, body: string): string;
  play(json: string): void;
  isTv(): boolean;
  version(): string;
  exit(): void;
  /** server per "Aggiungi dallo smartphone": JSON {url, code, qr} oppure "" */
  remoteStart?(): string;
  remoteStop?(): void;
  remoteResult?(ok: boolean, msg: string): void;
  /** Lingua scelta nell'interfaccia (messaggi nativi e pagina per lo smartphone). Facoltativo: APK vecchi non lo hanno. */
  setLang?(lang: string): void;
  /** Come remoteStart, ma lo smartphone invia le chiavi API TMDB/OMDb. Facoltativo: APK fino alla 1.2.0 non lo hanno. */
  remoteStartKeys?(): string;
}
declare global {
  interface Window {
    OrbitaAndroid?: NativeBridge;
    orbitaBack?: () => boolean;
    orbitaPlayerClosed?: (json: string) => void;
    orbitaRemoteSource?: (json: string) => void;
  }
}
export const native: NativeBridge | undefined = typeof window !== 'undefined' ? window.OrbitaAndroid : undefined;

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let r: Response;
  try {
    if (native) {
      // nell'app Android la richiesta viene registrata nel ponte e poi eseguita dal codice nativo
      const id = native.prepare(path, JSON.stringify(body));
      if (!id) throw new ApiError(t('err.badRequest'));
      r = await fetch(`/__native/${id}`, { cache: 'no-store', signal });
    } else r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orbita': '1' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError' || e instanceof ApiError) throw e;
    throw new ApiError(native ? t('err.networkNative') : t('err.serverDown'));
  }
  if (!r.ok) {
    let msg = t('err.http', { c: r.status });
    try {
      const j = await r.json();
      if (j?.error) msg = translateRemote(String(j.error));
    } catch {
      /* corpo non JSON */
    }
    throw new ApiError(msg, r.status);
  }
  return r;
}

export async function fetchText(url: string, ua?: string, signal?: AbortSignal): Promise<string> {
  return (await post('/api/fetch', { url, ua }, signal)).text();
}

export async function fetchJson<T>(url: string, ua?: string, signal?: AbortSignal): Promise<T> {
  const body = await fetchText(url, ua, signal);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiError(t('err.notJson'));
  }
}

/** Registra un URL di stream e ottiene un percorso locale opaco da dare al player. */
export async function openStream(url: string, ua?: string): Promise<string> {
  const j = (await (await post('/api/open', { url, ua })).json()) as { path: string };
  return j.path;
}

export async function fetchEpg(url: string, ids: string[], ua?: string, signal?: AbortSignal) {
  return (await (await post('/api/epg', { url, ids, ua }, signal)).json()) as Record<string, { s: number; e: number; t: string; d?: string }[]>;
}

/** Immagini dei provider passano dal proxy (niente mixed content, niente referrer verso terzi). */
export function img(u?: string): string | undefined {
  return u && /^https?:\/\//i.test(u) ? `/logo?u=${encodeURIComponent(u)}` : undefined;
}
