import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { openStream, img, native } from '../core/api';
import type { Channel, EpgItem, PlayRequest } from '../core/types';
import { clock, fmtTime } from '../core/util';
import { active, channelUrl, epgFor, hidden, nowNext, progressOf, recordProgress, state } from '../state';
import { h, icon, thumb, toast, clear } from './dom';

type Engine = { destroy(): void; audio?: () => Track[]; setAudio?: (i: number) => void; subs?: () => Track[]; setSub?: (i: number) => void; levels?: () => Track[]; setLevel?: (i: number) => void };
interface Track { id: number; label: string; active: boolean }

const MAX_RETRY = 6;
let current: PlayerView | null = null;

export function play(req: PlayRequest, playlist?: Channel[]) {
  if (native) return playNative(req, playlist);
  if (current) current.load(req, playlist);
  else current = new PlayerView(req, playlist);
}

/* ---------------- Android TV / Fire TV: player nativo ExoPlayer ---------------- */
let nativeReq: PlayRequest | null = null;

function playNative(req: PlayRequest, playlist?: Channel[]) {
  const src = active();
  const altFmt = src?.type === 'xtream' ? (src.format === 'ts' ? 'm3u8' : 'ts') : null;
  if (req.resumeKey && req.startAt == null) {
    const p = progressOf(req.resumeKey);
    if (p && p.pos > 15 && p.dur && p.pos < p.dur - 30) req.startAt = p.pos;
  }
  let list: { id: string; title: string; subtitle: string; url: string; alt?: string }[];
  let index = 0;
  if (req.live && req.channel) {
    const chans = (playlist?.length ? playlist : [req.channel]).filter((c) => !hidden(c)).slice(0, 5000);
    index = Math.max(0, chans.findIndex((c) => c.id === req.channel!.id));
    list = chans.map((c) => ({ id: c.id, title: c.name, subtitle: c.group, url: channelUrl(c), alt: altFmt && c.xid ? channelUrl(c, altFmt) : undefined }));
  } else {
    list = [{ id: req.resumeKey || '', title: req.title, subtitle: req.subtitle || '', url: req.url }];
  }
  nativeReq = req;
  native!.play(JSON.stringify({ live: req.live, resumeKey: req.resumeKey, startAt: req.startAt || 0, ua: src?.ua, list, index }));
}

if (native) {
  window.orbitaPlayerClosed = (json: string) => {
    const req = nativeReq;
    nativeReq = null;
    if (!req) return;
    let r: { key?: string; pos?: number; dur?: number; ended?: boolean; id?: string } = {};
    try {
      r = JSON.parse(json);
    } catch {
      /* risultato vuoto */
    }
    if (req.live && r.id) localStorage.setItem('orbita.lastChannel', r.id);
    if (req.resumeKey && r.dur && r.pos != null) {
      const [kind, id] = req.resumeKey.split(':') as ['movie' | 'series', string];
      recordProgress({ key: req.resumeKey, kind, id, name: req.title, logo: req.logo, seriesId: req.series?.id, pos: r.ended ? r.dur : r.pos, dur: r.dur });
    }
    if (r.ended && req.kind === 'episode' && req.series?.episodes && state.settings.autoNext) {
      const eps = req.series.episodes;
      const nx = eps[eps.findIndex((e) => e.id === req.episode?.id) + 1];
      if (nx) {
        toast(`Prossimo episodio: S${nx.season} E${nx.episode}`);
        document.dispatchEvent(new CustomEvent('orbita:play-episode', { detail: { series: req.series, episode: nx } }));
        return;
      }
    }
    document.dispatchEvent(new CustomEvent('orbita:player-closed'));
  };
}
export const closePlayer = () => current?.close();
export const playerOpen = () => !!current;

class PlayerView {
  root: HTMLElement;
  video: HTMLVideoElement;
  engine: Engine | null = null;
  req!: PlayRequest;
  list: Channel[] = [];
  retries = 0;
  fmtFallback = false;
  hideTimer?: ReturnType<typeof setTimeout>;
  saveTimer?: ReturnType<typeof setInterval>;
  epgTimer?: ReturnType<typeof setInterval>;
  retryTimer?: ReturnType<typeof setTimeout>;
  loadSeq = 0;
  // elementi UI
  title = h('div', { class: 'p-title' });
  sub = h('div', { class: 'p-sub' });
  logoBox = h('div', { class: 'p-logo' });
  status = h('div', { class: 'p-status' });
  progress = h('input', { type: 'range', class: 'p-seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Posizione' });
  timeL = h('span', { class: 'p-time' }, '00:00');
  timeR = h('span', { class: 'p-time' }, '');
  liveBadge = h('span', { class: 'live-badge' }, 'LIVE');
  playBtn = h('button', { class: 'p-btn big', 'aria-label': 'Play/Pausa' });
  muteBtn = h('button', { class: 'p-btn', 'aria-label': 'Audio' });
  vol = h('input', { type: 'range', class: 'p-vol', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
  fsBtn = h('button', { class: 'p-btn', 'aria-label': 'Schermo intero' });
  menu = h('div', { class: 'p-menu', hidden: true });
  drawer = h('aside', { class: 'p-drawer', hidden: true });
  epgLine = h('div', { class: 'p-epg' });

  constructor(req: PlayRequest, list?: Channel[]) {
    this.video = h('video', { class: 'p-video', playsInline: true, autoplay: true, preload: 'auto' });
    this.video.volume = Number(localStorage.getItem('orbita.vol') ?? 1);
    this.vol.value = String(this.video.volume);
    this.root = this.build();
    document.body.appendChild(this.root);
    document.body.classList.add('playing');
    document.addEventListener('keydown', this.onKey, true);
    this.bindVideo();
    this.load(req, list);
    this.root.focus();
  }

  build(): HTMLElement {
    const btn = (ic: string, label: string, fn: () => void, cls = 'p-btn') =>
      h('button', { class: cls, 'aria-label': label, title: label, on: { click: (e) => (e.stopPropagation(), fn()) } }, icon(ic, 22));
    this.playBtn.appendChild(icon('pause', 30));
    this.playBtn.addEventListener('click', (e) => (e.stopPropagation(), this.toggle()));
    this.muteBtn.appendChild(icon('vol', 22));
    this.muteBtn.addEventListener('click', (e) => (e.stopPropagation(), (this.video.muted = !this.video.muted)));
    this.fsBtn.appendChild(icon('full', 22));
    this.fsBtn.addEventListener('click', (e) => (e.stopPropagation(), this.fullscreen()));
    this.vol.addEventListener('input', () => {
      this.video.volume = Number(this.vol.value);
      this.video.muted = false;
      localStorage.setItem('orbita.vol', this.vol.value);
    });
    this.progress.addEventListener('input', () => {
      const d = this.video.duration;
      if (Number.isFinite(d)) this.video.currentTime = (Number(this.progress.value) / 1000) * d;
    });

    const root = h('div', { class: 'player', tabindex: -1, role: 'dialog', 'aria-label': 'Player' },
      this.video,
      h('div', { class: 'p-shade' }),
      this.status,
      h('div', { class: 'p-top' },
        btn('back', 'Indietro (Esc)', () => this.close()),
        this.logoBox,
        h('div', { class: 'p-head' }, this.title, this.sub),
        h('div', { class: 'p-top-right' }, h('span', { class: 'p-clock' })),
      ),
      h('div', { class: 'p-center' },
        btn('rew', 'Indietro 10s', () => this.seekBy(-10), 'p-btn mid vod-only'),
        this.playBtn,
        btn('fwd', 'Avanti 30s', () => this.seekBy(30), 'p-btn mid vod-only'),
      ),
      h('div', { class: 'p-bottom' },
        this.epgLine,
        h('div', { class: 'p-bar' }, this.timeL, this.progress, this.timeR, this.liveBadge),
        h('div', { class: 'p-row' },
          h('div', { class: 'p-group' },
            btn('up', 'Canale precedente', () => this.zap(-1), 'p-btn live-only'),
            btn('down', 'Canale successivo', () => this.zap(1), 'p-btn live-only'),
            this.muteBtn, this.vol),
          h('div', { class: 'p-group' },
            btn('list', 'Lista canali', () => this.toggleDrawer(), 'p-btn live-only'),
            btn('tracks', 'Audio, sottotitoli, qualità', () => this.toggleMenu()),
            btn('pip', 'Picture-in-Picture', () => this.pip()),
            this.fsBtn),
        ),
      ),
      this.menu,
      this.drawer,
    );
    root.addEventListener('mousemove', () => this.poke());
    root.addEventListener('click', (e) => {
      if (e.target === this.video || (e.target as HTMLElement).classList.contains('p-shade')) {
        if (!this.menu.hidden || !this.drawer.hidden) return this.hidePanels();
        if (root.classList.contains('idle')) return this.poke();
        this.toggle();
      }
    });
    root.addEventListener('dblclick', (e) => {
      if (e.target === this.video || (e.target as HTMLElement).classList.contains('p-shade')) this.fullscreen();
    });
    const tick = () => {
      const c = root.querySelector('.p-clock');
      if (c) c.textContent = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    setInterval(tick, 15000);
    return root;
  }

  bindVideo() {
    const v = this.video;
    const setPlayIcon = () => {
      clear(this.playBtn);
      this.playBtn.appendChild(icon(v.paused ? 'play' : 'pause', 30));
      this.root.classList.toggle('paused', v.paused);
    };
    v.addEventListener('play', setPlayIcon);
    v.addEventListener('pause', () => (setPlayIcon(), this.poke()));
    v.addEventListener('volumechange', () => {
      clear(this.muteBtn);
      this.muteBtn.appendChild(icon(v.muted || v.volume === 0 ? 'mute' : 'vol', 22));
    });
    v.addEventListener('waiting', () => this.setStatus('Buffering…', true));
    v.addEventListener('playing', () => {
      this.setStatus('');
      this.retries = 0;
    });
    v.addEventListener('timeupdate', () => this.updateTime());
    v.addEventListener('loadedmetadata', () => {
      if (this.req.startAt && Number.isFinite(v.duration) && this.req.startAt < v.duration - 10) v.currentTime = this.req.startAt;
      this.req.startAt = undefined;
    });
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('error', () => this.onFatal('Errore di riproduzione del media'));
    document.addEventListener('fullscreenchange', () => {
      clear(this.fsBtn);
      this.fsBtn.appendChild(icon(document.fullscreenElement ? 'exitfull' : 'full', 22));
    });
  }

  async load(req: PlayRequest, list?: Channel[]) {
    const seq = ++this.loadSeq;
    this.req = req;
    if (list) this.list = list;
    this.retries = 0;
    this.fmtFallback = false;
    this.root.classList.toggle('is-live', req.live);
    this.title.textContent = req.title;
    this.sub.textContent = req.subtitle || '';
    clear(this.logoBox);
    if (req.logo) this.logoBox.appendChild(thumb(img(req.logo), req.title, 'p-logo-img'));
    this.epgLine.textContent = '';
    this.hidePanels();
    clearInterval(this.epgTimer);
    if (req.channel) {
      this.updateEpg(req.channel);
      this.epgTimer = setInterval(() => req.channel && this.updateEpg(req.channel), 30000);
      localStorage.setItem('orbita.lastChannel', req.channel.id);
    }
    if (req.resumeKey && req.startAt == null) {
      const p = progressOf(req.resumeKey);
      if (p && p.pos > 15 && p.dur && p.pos < p.dur - 30) req.startAt = p.pos;
    }
    await this.start(req.url, seq);
    clearInterval(this.saveTimer);
    if (req.resumeKey) this.saveTimer = setInterval(() => this.saveProgress(), 5000);
    this.poke();
  }

  async start(url: string, seq: number) {
    this.teardown();
    this.setStatus('Connessione…', true);
    let path: string;
    try {
      path = await openStream(url, active()?.ua);
    } catch (e) {
      return this.onFatal((e as Error).message);
    }
    if (seq !== this.loadSeq) return;
    const v = this.video;
    const isHls = /\.m3u8(\?|$)/i.test(url) || /\/live\/.*\.m3u8/i.test(url);
    const isTs = /\.ts(\?|$)/i.test(url) || (!isHls && this.req.live && !/\.(mp4|mkv|webm|mov)(\?|$)/i.test(url));

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true, lowLatencyMode: false, backBufferLength: 60, maxBufferLength: 30,
        manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4,
      });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && this.retries < 2) {
          this.retries++;
          hls.recoverMediaError();
        } else this.onFatal(d.response?.code ? `Stream non disponibile (${d.response.code})` : 'Stream HLS interrotto');
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => this.needsTap()));
      hls.loadSource(path);
      hls.attachMedia(v);
      this.engine = {
        destroy: () => hls.destroy(),
        audio: () => hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Traccia ${i + 1}`, active: i === hls.audioTrack })),
        setAudio: (i) => (hls.audioTrack = i),
        subs: () => [{ id: -1, label: 'Disattivati', active: hls.subtitleTrack === -1 },
          ...hls.subtitleTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Sottotitoli ${i + 1}`, active: i === hls.subtitleTrack }))],
        setSub: (i) => (hls.subtitleTrack = i),
        levels: () => [{ id: -1, label: 'Automatica', active: hls.autoLevelEnabled },
          ...hls.levels.map((l, i) => ({ id: i, label: l.height ? `${l.height}p${l.bitrate ? ` · ${(l.bitrate / 1e6).toFixed(1)} Mbps` : ''}` : `Livello ${i + 1}`, active: !hls.autoLevelEnabled && i === hls.currentLevel }))],
        setLevel: (i) => (hls.currentLevel = i),
      };
    } else if (isTs && mpegts.isSupported()) {
      const p = mpegts.createPlayer(
        { type: 'mpegts', isLive: this.req.live, url: path },
        { enableWorker: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 2, lazyLoad: false, autoCleanupSourceBuffer: true },
      );
      p.on(mpegts.Events.ERROR, (_t: string, detail: string) => this.onFatal(`Stream interrotto (${detail})`));
      p.attachMediaElement(v);
      p.load();
      Promise.resolve(p.play()).catch(() => this.needsTap());
      this.engine = {
        destroy: () => {
          try {
            p.pause();
            p.unload();
            p.detachMediaElement();
            p.destroy();
          } catch {
            /* già distrutto */
          }
        },
      };
    } else {
      v.src = path;
      v.play().catch(() => this.needsTap());
      this.engine = {
        destroy: () => {
          v.removeAttribute('src');
          v.load();
        },
        audio: () => {
          const at = (v as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { label: string; language: string; enabled: boolean } } }).audioTracks;
          return at ? Array.from({ length: at.length }, (_, i) => ({ id: i, label: at[i].label || at[i].language || `Traccia ${i + 1}`, active: at[i].enabled })) : [];
        },
        setAudio: (i) => {
          const at = (v as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
          if (at) for (let k = 0; k < at.length; k++) at[k].enabled = k === i;
        },
        subs: () => [{ id: -1, label: 'Disattivati', active: ![...v.textTracks].some((t) => t.mode === 'showing') },
          ...[...v.textTracks].map((t, i) => ({ id: i, label: t.label || t.language || `Sottotitoli ${i + 1}`, active: t.mode === 'showing' }))],
        setSub: (i) => [...v.textTracks].forEach((t, k) => (t.mode = k === i ? 'showing' : 'disabled')),
      };
    }
  }

  needsTap() {
    this.setStatus('Premi play per avviare');
    this.root.classList.add('paused');
  }

  teardown() {
    clearTimeout(this.retryTimer);
    this.engine?.destroy();
    this.engine = null;
  }

  /** Riconnessione con backoff; per Xtream live prova anche il formato alternativo (m3u8 ↔ ts). */
  onFatal(msg: string) {
    if (!this.req) return;
    const src = active();
    if (this.req.live && this.req.channel?.xid && src?.type === 'xtream' && !this.fmtFallback) {
      this.fmtFallback = true;
      const alt = src.format === 'ts' ? 'm3u8' : 'ts';
      this.req.url = channelUrl(this.req.channel, alt);
      this.setStatus('Provo un formato alternativo…', true);
      this.start(this.req.url, this.loadSeq);
      return;
    }
    if (this.retries < MAX_RETRY) {
      const wait = Math.min(1000 * 2 ** this.retries, 15000);
      this.retries++;
      if (!this.req.live && Number.isFinite(this.video.currentTime) && this.video.currentTime > 5) this.req.startAt = this.video.currentTime;
      this.setStatus(`${msg}. Riconnessione tra ${Math.round(wait / 1000)}s… (${this.retries}/${MAX_RETRY})`, true);
      const seq = this.loadSeq;
      this.retryTimer = setTimeout(() => seq === this.loadSeq && this.start(this.req.url, seq), wait);
    } else {
      this.teardown();
      this.setStatus(`${msg}. Impossibile riprodurre questo contenuto.`);
    }
  }

  setStatus(msg: string, spin = false) {
    clear(this.status);
    this.status.classList.toggle('on', !!msg);
    if (msg) {
      if (spin) this.status.appendChild(h('span', { class: 'spinner' }));
      this.status.appendChild(h('span', null, msg));
    }
  }

  updateTime() {
    const v = this.video;
    const d = v.duration;
    const live = this.req.live || !Number.isFinite(d);
    this.root.classList.toggle('no-seek', live);
    if (live) {
      this.timeL.textContent = '';
      this.timeR.textContent = '';
      return;
    }
    this.timeL.textContent = fmtTime(v.currentTime);
    this.timeR.textContent = '-' + fmtTime(d - v.currentTime);
    if (document.activeElement !== this.progress) this.progress.value = String(Math.round((v.currentTime / d) * 1000));
    const buf = v.buffered.length ? v.buffered.end(v.buffered.length - 1) / d : 0;
    this.progress.style.setProperty('--p', `${(v.currentTime / d) * 100}%`);
    this.progress.style.setProperty('--b', `${buf * 100}%`);
  }

  async updateEpg(c: Channel) {
    const items: EpgItem[] = await epgFor(c);
    if (this.req.channel?.id !== c.id) return;
    const { now, next } = nowNext(items);
    clear(this.epgLine);
    if (now) {
      const pct = Math.min(100, Math.max(0, ((Date.now() / 1000 - now.s) / (now.e - now.s)) * 100));
      const bar = h('div', { class: 'epg-bar' }, h('i'));
      (bar.firstChild as HTMLElement).style.width = pct + '%';
      this.epgLine.append(
        h('div', { class: 'epg-now' }, h('b', null, `${clock(now.s)}–${clock(now.e)}`), ' ', now.t),
        bar,
        next ? h('div', { class: 'epg-next' }, 'Dopo: ', h('b', null, clock(next.s)), ' ', next.t) : '',
      );
    }
  }

  saveProgress() {
    const v = this.video;
    const r = this.req;
    if (!r.resumeKey || !Number.isFinite(v.duration) || v.currentTime < 5) return;
    const [kind, id] = r.resumeKey.split(':') as ['movie' | 'series', string];
    recordProgress({
      key: r.resumeKey, kind, id, name: r.title, logo: r.logo, seriesId: r.series?.id,
      pos: v.currentTime, dur: v.duration,
    });
  }

  onEnded() {
    this.saveProgress();
    if (this.req.kind === 'episode' && this.req.series?.episodes && state.settings.autoNext) {
      const eps = this.req.series.episodes;
      const i = eps.findIndex((e) => e.id === this.req.episode?.id);
      const nx = eps[i + 1];
      if (nx) {
        toast(`Prossimo episodio: S${nx.season} E${nx.episode}`);
        document.dispatchEvent(new CustomEvent('orbita:play-episode', { detail: { series: this.req.series, episode: nx } }));
      }
    }
  }

  /* ---------------- controlli ---------------- */
  toggle() {
    const v = this.video;
    if (v.paused) v.play().catch(() => this.needsTap());
    else v.pause();
    this.poke();
  }
  seekBy(s: number) {
    const v = this.video;
    if (this.req.live || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + s));
    this.poke();
  }
  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen?.().catch(() => {});
  }
  async pip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {
      toast('Picture-in-Picture non disponibile per questo stream', 'error');
    }
  }
  zap(dir: number) {
    const c = this.req.channel;
    if (!c || !this.list.length) return;
    const visible = this.list.filter((x) => !hidden(x));
    const i = visible.findIndex((x) => x.id === c.id);
    const n = visible[(i + dir + visible.length) % visible.length];
    if (n) this.load(channelRequest(n));
  }

  poke() {
    this.root.classList.remove('idle');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused && this.menu.hidden && this.drawer.hidden) this.root.classList.add('idle');
    }, 3200);
  }

  hidePanels() {
    this.menu.hidden = true;
    this.drawer.hidden = true;
  }

  toggleMenu() {
    this.drawer.hidden = true;
    if (!this.menu.hidden) return (this.menu.hidden = true);
    clear(this.menu);
    const e = this.engine;
    const section = (name: string, items: Track[] | undefined, set?: (i: number) => void) => {
      if (!items?.length || !set) return null;
      return h('div', { class: 'p-menu-sec' }, h('h4', null, name),
        items.map((t) => h('button', { class: 'p-opt' + (t.active ? ' on' : ''), on: { click: () => (set(t.id), (this.menu.hidden = true), toast(`${name}: ${t.label}`, 'ok')) } }, t.label)));
    };
    const speeds = this.req.live ? null : h('div', { class: 'p-menu-sec' }, h('h4', null, 'Velocità'),
      [0.75, 1, 1.25, 1.5, 2].map((r) => h('button', { class: 'p-opt' + (this.video.playbackRate === r ? ' on' : ''), on: { click: () => ((this.video.playbackRate = r), (this.menu.hidden = true)) } }, `${r}×`)));
    const fit = h('div', { class: 'p-menu-sec' }, h('h4', null, 'Formato'),
      [['contain', 'Adatta'], ['cover', 'Riempi'], ['fill', 'Allunga']].map(([k, l]) =>
        h('button', { class: 'p-opt' + ((this.video.style.objectFit || 'contain') === k ? ' on' : ''), on: { click: () => ((this.video.style.objectFit = k), (this.menu.hidden = true)) } }, l)));
    const parts = [section('Audio', e?.audio?.(), e?.setAudio), section('Sottotitoli', e?.subs?.(), e?.setSub), section('Qualità', e?.levels?.(), e?.setLevel), speeds, fit].filter(Boolean);
    const info = h('div', { class: 'p-menu-sec tech' }, h('h4', null, 'Info tecniche'),
      h('p', null, this.video.videoWidth ? `${this.video.videoWidth}×${this.video.videoHeight}` : 'Risoluzione n/d'));
    this.menu.append(...(parts as HTMLElement[]), info);
    this.menu.hidden = false;
    this.menu.querySelector<HTMLElement>('button')?.focus();
  }

  toggleDrawer() {
    this.menu.hidden = true;
    if (!this.drawer.hidden) return (this.drawer.hidden = true);
    clear(this.drawer);
    const cur = this.req.channel;
    const group = cur?.group;
    const items = this.list.filter((c) => !hidden(c));
    const list = h('div', { class: 'p-drawer-list' },
      items.slice(0, 1500).map((c) =>
        h('button', { class: 'p-ch' + (c.id === cur?.id ? ' on' : ''), on: { click: () => this.load(channelRequest(c)) } },
          thumb(img(c.logo), c.name, 'ch-logo sm'), h('span', null, c.name))));
    this.drawer.append(h('h4', null, group || 'Canali'), list);
    this.drawer.hidden = false;
    const on = list.querySelector<HTMLElement>('.on');
    on?.scrollIntoView({ block: 'center' });
    (on || list.querySelector<HTMLElement>('button'))?.focus();
  }

  onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('.modal-wrap')) return;
    const panelOpen = !this.menu.hidden || !this.drawer.hidden;
    const k = e.key;
    let handled = true;
    if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack') {
      if (panelOpen) this.hidePanels();
      else if (document.fullscreenElement) document.exitFullscreen();
      else this.close();
    } else if (panelOpen && (k === 'ArrowUp' || k === 'ArrowDown')) {
      const btns = [...(this.menu.hidden ? this.drawer : this.menu).querySelectorAll<HTMLElement>('button')];
      const i = btns.indexOf(document.activeElement as HTMLElement);
      btns[Math.max(0, Math.min(btns.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (panelOpen && (k === 'Enter')) {
      handled = false;
    } else if (k === ' ' || k === 'k' || k === 'MediaPlayPause') this.toggle();
    else if (k === 'f') this.fullscreen();
    else if (k === 'm') this.video.muted = !this.video.muted;
    else if (k === 'p') this.pip();
    else if (k === 'i' || k === 'Enter') this.toggleMenu();
    else if (k === 'l' || k === 'c') this.toggleDrawer();
    else if (k === 'ArrowLeft') this.seekBy(-10);
    else if (k === 'ArrowRight') this.seekBy(30);
    else if (k === 'ArrowUp' || k === 'PageUp' || k === 'ChannelUp') this.req.live ? this.zap(-1) : this.volume(0.05);
    else if (k === 'ArrowDown' || k === 'PageDown' || k === 'ChannelDown') this.req.live ? this.zap(1) : this.volume(-0.05);
    else if (k === '+' || k === '=') this.volume(0.05);
    else if (k === '-') this.volume(-0.05);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      this.poke();
    }
  };

  volume(d: number) {
    const v = Math.max(0, Math.min(1, this.video.volume + d));
    this.video.volume = v;
    this.video.muted = false;
    this.vol.value = String(v);
    localStorage.setItem('orbita.vol', String(v));
    this.setStatus(`Volume ${Math.round(v * 100)}%`);
    setTimeout(() => this.status.textContent?.startsWith('Volume') && this.setStatus(''), 900);
  }

  close() {
    this.saveProgress();
    this.loadSeq++;
    this.teardown();
    clearInterval(this.saveTimer);
    clearInterval(this.epgTimer);
    document.removeEventListener('keydown', this.onKey, true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    this.root.remove();
    document.body.classList.remove('playing');
    current = null;
    document.dispatchEvent(new CustomEvent('orbita:player-closed'));
  }
}

export function channelRequest(c: Channel): PlayRequest {
  return { kind: 'live', live: true, title: c.name, subtitle: c.group, logo: c.logo, url: channelUrl(c), channel: c };
}
