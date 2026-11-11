import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { openStream, img, native } from '../core/api';
import type { Channel, EpgItem, PlayRequest } from '../core/types';
import { clock, fmtTime } from '../core/util';
import { active, channelUrl, epgFor, hidden, nowNext, progressOf, recordProgress, state } from '../state';
import { h, icon, thumb, toast, clear } from './dom';
import { currentLang, locale, t } from '../i18n';
import { ratingChips } from './library';
import { episodeLabel, introEnd, learnIntro, nextEpisode, pauseInfo, saveIntro } from './playerExtras';

type Engine = { destroy(): void; audio?: () => Track[]; setAudio?: (i: number) => void; subs?: () => Track[]; setSub?: (i: number) => void; levels?: () => Track[]; setLevel?: (i: number) => void };
interface Track { id: number; label: string; active: boolean }

const MAX_RETRY = 6;
/** finestra in cui compare "Salta intro" se non sappiamo ancora dove finisce la sigla (s) */
const INTRO_WINDOW = 180;
const INTRO_DEFAULT_SKIP = 85;
/** la scheda del prossimo episodio compare a 30 s dalla fine e parte dopo 15 s */
const NEXT_AT = 30;
const NEXT_COUNTDOWN = 15;
const PAUSE_SCREEN_AFTER = 5000;
let current: PlayerView | null = null;

export function play(req: PlayRequest, playlist?: Channel[]) {
  if (native) return playNative(req, playlist);
  if (current) current.load(req, playlist);
  else current = new PlayerView(req, playlist);
}

const accentColor = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

/* ---------------- Android TV / Fire TV: player nativo ExoPlayer ---------------- */
let nativeReq: PlayRequest | null = null;

function playNative(req: PlayRequest, playlist?: Channel[]) {
  const src = active();
  const altFmt = src?.type === 'xtream' ? (src.format === 'ts' ? 'm3u8' : 'ts') : null;
  if (req.resumeKey && req.startAt == null) {
    const p = progressOf(req.resumeKey);
    if (p && p.pos > 15 && p.dur && p.pos < p.dur - 30) req.startAt = p.pos;
  }
  let list: { id: string; title: string; subtitle: string; url: string; alt?: string; num?: string; logo?: string }[];
  let index = 0;
  const extra: Record<string, unknown> = {};
  if (req.live && req.channel) {
    const chans = (playlist?.length ? playlist : [req.channel]).filter((c) => !hidden(c)).slice(0, 5000);
    index = Math.max(0, chans.findIndex((c) => c.id === req.channel!.id));
    list = chans.map((c, i) => ({
      id: c.id, title: c.name, subtitle: c.group, url: channelUrl(c), alt: altFmt && c.xid ? channelUrl(c, altFmt) : undefined,
      num: String(c.num ?? i + 1), logo: c.logo,
    }));
  } else {
    list = [{ id: req.resumeKey || '', title: req.title, subtitle: req.subtitle || '', url: req.url }];
    const p = pauseInfo(req);
    extra.pause = { title: p.title, line: p.line, plot: p.plot, ratings: p.ratings, backdrop: p.backdrop };
    extra.thumbs = state.settings.seekPreview !== false;
    extra.introEnd = introEnd(req);
    const nx = nextEpisode(req);
    if (nx) extra.next = episodeLabel(nx);
  }
  nativeReq = req;
  native!.play(JSON.stringify({
    kind: req.kind, live: req.live, resumeKey: req.resumeKey, startAt: req.startAt || 0, ua: src?.ua, list, index,
    lang: currentLang(), accent: accentColor(), ...extra,
  }));
}

if (native) {
  window.orbitaPlayerClosed = (json: string) => {
    const req = nativeReq;
    nativeReq = null;
    if (!req) return;
    let r: { key?: string; pos?: number; dur?: number; ended?: boolean; id?: string; introEnd?: number; cancelNext?: boolean } = {};
    try {
      r = JSON.parse(json);
    } catch {
      /* risultato vuoto */
    }
    if (req.live && r.id) localStorage.setItem('orbita.lastChannel', r.id);
    if (r.introEnd) saveIntro(req, r.introEnd);
    if (req.resumeKey && r.dur && r.pos != null) {
      const [kind, id] = req.resumeKey.split(':') as ['movie' | 'series', string];
      recordProgress({ key: req.resumeKey, kind, id, name: req.title, logo: req.logo, seriesId: req.series?.id, pos: r.ended ? r.dur : r.pos, dur: r.dur });
    }
    const nx = r.ended && !r.cancelNext ? nextEpisode(req) : undefined;
    if (nx) {
      toast(t('pl.nextEp', { s: nx.season, e: nx.episode }));
      document.dispatchEvent(new CustomEvent('orbita:play-episode', { detail: { series: req.series, episode: nx } }));
      return;
    }
    document.dispatchEvent(new CustomEvent('orbita:player-closed'));
  };

  /** Il banner del player nativo chiede la guida di un canale: rispondiamo con in onda + i successivi. */
  window.orbitaEpg = (rid: string, channelId: string) => {
    const c = state.lib?.live.find((x) => x.id === channelId);
    if (!c || !native!.epgResult) return false;
    epgFor(c)
      .catch(() => [] as EpgItem[])
      .then((items) => {
        const now = Date.now() / 1000;
        const out = items.filter((x) => x.e > now).slice(0, 4).map(({ s, e, t: title }) => ({ s, e, t: title }));
        native!.epgResult!(rid, JSON.stringify(out));
      });
    return true;
  };
}
export const closePlayer = () => current?.close();
export const playerOpen = () => !!current;

/** Anteprime della barra di avanzamento: un secondo <video> muto che salta al punto richiesto e lo disegna. */
class SeekThumbs {
  v = h('video', { muted: true, preload: 'metadata', playsInline: true });
  canvas = h('canvas', { class: 'p-tip-img', width: 256, height: 144 });
  broken = false;
  private busy = false;
  private want = -1;
  private cur = -1;
  constructor(src: string) {
    this.v.muted = true;
    this.v.addEventListener('seeked', () => {
      this.canvas.getContext('2d')?.drawImage(this.v, 0, 0, this.canvas.width, this.canvas.height);
      this.canvas.classList.add('on');
      this.busy = false;
      if (this.want !== this.cur) this.go(this.want);
    });
    this.v.addEventListener('error', () => (this.broken = true));
    this.v.src = src;
  }
  request(sec: number) {
    if (this.broken) return;
    this.want = Math.floor(sec / 10) * 10;
    if (!this.busy && this.want !== this.cur) this.go(this.want);
  }
  private go(sec: number) {
    if (this.v.readyState < 1) {
      this.v.addEventListener('loadedmetadata', () => this.go(this.want), { once: true });
      return;
    }
    this.busy = true;
    this.cur = sec;
    this.v.currentTime = Math.min(sec, Math.max(0, this.v.duration - 1));
  }
  destroy() {
    this.broken = true;
    this.v.removeAttribute('src');
    this.v.load();
  }
}

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
  bannerTimer?: ReturnType<typeof setTimeout>;
  pauseTimer?: ReturnType<typeof setTimeout>;
  scrubTimer?: ReturnType<typeof setTimeout>;
  clockTimer?: ReturnType<typeof setInterval>;
  loadSeq = 0;
  // film ed episodi
  thumbs: SeekThumbs | null = null;
  intro = 0;
  skipDone = false;
  nextCancelled = false;
  countdown = -1;
  lastTick = 0;
  scrubbing = false;
  scrubFrom = 0;
  scrubTarget = 0;
  scrubRepeat = 0;
  // elementi UI
  title = h('div', { class: 'p-title' });
  sub = h('div', { class: 'p-sub' });
  logoBox = h('div', { class: 'p-logo' });
  status = h('div', { class: 'p-status' });
  progress = h('input', { type: 'range', class: 'p-seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': t('pl.position') });
  timeL = h('span', { class: 'p-time' }, '00:00');
  timeR = h('span', { class: 'p-time' }, '');
  liveBadge = h('span', { class: 'live-badge' }, 'LIVE');
  playBtn = h('button', { class: 'p-btn big', 'aria-label': t('pl.playPause') });
  muteBtn = h('button', { class: 'p-btn', 'aria-label': t('pl.audio') });
  vol = h('input', { type: 'range', class: 'p-vol', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
  fsBtn = h('button', { class: 'p-btn', 'aria-label': t('pl.fullscreen') });
  menu = h('div', { class: 'p-menu', hidden: true });
  drawer = h('aside', { class: 'p-drawer', hidden: true });
  epgLine = h('div', { class: 'p-epg' });
  banner = h('div', { class: 'p-banner', 'aria-live': 'polite' });
  tipTime = h('b');
  tipDelta = h('small');
  tip = h('div', { class: 'p-tip' }, this.tipTime, this.tipDelta);
  skipBtn = h('button', { class: 'p-skip', on: { click: (e) => (e.stopPropagation(), this.skipIntro()) } }, t('pl.skipIntro'), icon('fwd', 18));
  nextTitle = h('div', { class: 'p-next-title' });
  nextCount = h('div', { class: 'p-next-count' });
  nextBar = h('div', { class: 'p-next-bar' }, h('i'));
  nextCard = h('div', { class: 'p-next', hidden: true },
    h('div', { class: 'p-eyebrow' }, t('pl.upNext')), this.nextTitle, this.nextCount, this.nextBar,
    h('div', { class: 'p-next-actions' },
      h('button', { class: 'btn primary', on: { click: (e) => (e.stopPropagation(), this.playNext()) } }, icon('play', 16), t('pl.playNow')),
      h('button', { class: 'btn ghost', on: { click: (e) => (e.stopPropagation(), this.cancelNext()) } }, t('pl.cancel'))));
  pauseEl = h('div', { class: 'p-pause', hidden: true });

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
      if (!Number.isFinite(d)) return;
      const from = this.video.currentTime;
      const to = (Number(this.progress.value) / 1000) * d;
      this.video.currentTime = to;
      learnIntro(this.req, from, to);
    });
    // anteprima al passaggio del mouse sulla barra
    this.progress.addEventListener('mousemove', (e) => {
      const d = this.video.duration;
      if (!Number.isFinite(d) || this.scrubbing) return;
      const r = this.progress.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.showTip(f * d, null);
    });
    this.progress.addEventListener('mouseleave', () => !this.scrubbing && this.tip.classList.remove('on'));

    const root = h('div', { class: 'player', tabindex: -1, role: 'dialog', 'aria-label': 'Player' },
      this.video,
      h('div', { class: 'p-shade' }),
      this.pauseEl,
      this.status,
      h('div', { class: 'p-top' },
        btn('back', t('pl.backEsc'), () => this.close()),
        this.logoBox,
        h('div', { class: 'p-head' }, this.title, this.sub),
        h('div', { class: 'p-top-right' }, h('span', { class: 'p-clock' })),
      ),
      h('div', { class: 'p-center' },
        btn('rew', t('pl.rew'), () => this.seekBy(-10), 'p-btn mid vod-only'),
        this.playBtn,
        btn('fwd', t('pl.fwd'), () => this.seekBy(30), 'p-btn mid vod-only'),
      ),
      h('div', { class: 'p-bottom' },
        this.epgLine,
        h('div', { class: 'p-bar' }, this.timeL, h('div', { class: 'p-seek-wrap' }, this.progress, this.tip), this.timeR, this.liveBadge),
        h('div', { class: 'p-row' },
          h('div', { class: 'p-group' },
            btn('up', t('pl.prevCh'), () => this.zap(-1), 'p-btn live-only'),
            btn('down', t('pl.nextCh'), () => this.zap(1), 'p-btn live-only'),
            this.muteBtn, this.vol),
          h('div', { class: 'p-group' },
            btn('list', t('pl.chList'), () => this.toggleDrawer(), 'p-btn live-only'),
            btn('tracks', t('pl.tracks'), () => this.toggleMenu()),
            btn('pip', 'Picture-in-Picture', () => this.pip()),
            this.fsBtn),
        ),
      ),
      this.banner,
      this.skipBtn,
      this.nextCard,
      this.menu,
      this.drawer,
    );
    root.addEventListener('mousemove', () => this.poke());
    root.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      if (el.closest('.p-pause')) return this.video.play().catch(() => this.needsTap());
      if (e.target === this.video || el.classList.contains('p-shade')) {
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
      if (c) c.textContent = new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    this.clockTimer = setInterval(tick, 15000);
    return root;
  }

  bindVideo() {
    const v = this.video;
    const setPlayIcon = () => {
      clear(this.playBtn);
      this.playBtn.appendChild(icon(v.paused ? 'play' : 'pause', 30));
      this.root.classList.toggle('paused', v.paused);
    };
    v.addEventListener('play', () => (setPlayIcon(), this.armPause()));
    v.addEventListener('pause', () => (setPlayIcon(), this.poke(), this.armPause()));
    v.addEventListener('volumechange', () => {
      clear(this.muteBtn);
      this.muteBtn.appendChild(icon(v.muted || v.volume === 0 ? 'mute' : 'vol', 22));
    });
    v.addEventListener('waiting', () => this.setStatus(t('pl.buffering'), true));
    v.addEventListener('playing', () => {
      this.setStatus('');
      this.retries = 0;
    });
    v.addEventListener('timeupdate', () => (this.updateTime(), this.extrasTick()));
    v.addEventListener('loadedmetadata', () => {
      if (this.req.startAt && Number.isFinite(v.duration) && this.req.startAt < v.duration - 10) v.currentTime = this.req.startAt;
      this.req.startAt = undefined;
    });
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('error', () => this.onFatal(t('pl.mediaError')));
    document.addEventListener('fullscreenchange', this.onFsChange);
  }

  onFsChange = () => {
    clear(this.fsBtn);
    this.fsBtn.appendChild(icon(document.fullscreenElement ? 'exitfull' : 'full', 22));
  };

  async load(req: PlayRequest, list?: Channel[]) {
    const seq = ++this.loadSeq;
    this.req = req;
    if (list) this.list = list;
    this.retries = 0;
    this.fmtFallback = false;
    this.intro = introEnd(req);
    this.skipDone = false;
    this.nextCancelled = false;
    this.cancelScrub();
    this.hideNext();
    this.hidePause();
    this.skipBtn.classList.remove('on');
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
    // in diretta, a ogni cambio canale, il banner al posto dei controlli
    if (req.live && req.channel) this.showBanner(req.channel);
    await this.start(req.url, seq);
    clearInterval(this.saveTimer);
    if (req.resumeKey) this.saveTimer = setInterval(() => this.saveProgress(), 5000);
    if (!req.live) this.poke();
  }

  async start(url: string, seq: number) {
    this.teardown();
    this.setStatus(t('pl.connecting'), true);
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
        } else this.onFatal(d.response?.code ? t('pl.unavailable', { c: d.response.code }) : t('pl.hlsBroken'));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => this.needsTap()));
      hls.loadSource(path);
      hls.attachMedia(v);
      this.engine = {
        destroy: () => hls.destroy(),
        audio: () => hls.audioTracks.map((tr, i) => ({ id: i, label: tr.name || tr.lang || t('pl.track', { n: i + 1 }), active: i === hls.audioTrack })),
        setAudio: (i) => (hls.audioTrack = i),
        subs: () => [{ id: -1, label: t('pl.subsOff'), active: hls.subtitleTrack === -1 },
          ...hls.subtitleTracks.map((tr, i) => ({ id: i, label: tr.name || tr.lang || t('pl.subsN', { n: i + 1 }), active: i === hls.subtitleTrack }))],
        setSub: (i) => (hls.subtitleTrack = i),
        levels: () => [{ id: -1, label: t('pl.auto'), active: hls.autoLevelEnabled },
          ...hls.levels.map((l, i) => ({ id: i, label: l.height ? `${l.height}p${l.bitrate ? ` · ${(l.bitrate / 1e6).toFixed(1)} Mbps` : ''}` : t('pl.level', { n: i + 1 }), active: !hls.autoLevelEnabled && i === hls.currentLevel }))],
        setLevel: (i) => (hls.currentLevel = i),
      };
    } else if (isTs && mpegts.isSupported()) {
      const p = mpegts.createPlayer(
        { type: 'mpegts', isLive: this.req.live, url: path },
        { enableWorker: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 2, lazyLoad: false, autoCleanupSourceBuffer: true },
      );
      p.on(mpegts.Events.ERROR, (_t: string, detail: string) => this.onFatal(t('pl.broken', { d: detail })));
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
      // file diretto (mp4/mkv): si possono estrarre le anteprime con un secondo lettore
      if (!this.req.live && state.settings.seekPreview !== false) this.thumbs = new SeekThumbs(path);
      this.engine = {
        destroy: () => {
          v.removeAttribute('src');
          v.load();
        },
        audio: () => {
          const at = (v as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { label: string; language: string; enabled: boolean } } }).audioTracks;
          return at ? Array.from({ length: at.length }, (_, i) => ({ id: i, label: at[i].label || at[i].language || t('pl.track', { n: i + 1 }), active: at[i].enabled })) : [];
        },
        setAudio: (i) => {
          const at = (v as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
          if (at) for (let k = 0; k < at.length; k++) at[k].enabled = k === i;
        },
        subs: () => [{ id: -1, label: t('pl.subsOff'), active: ![...v.textTracks].some((tr) => tr.mode === 'showing') },
          ...[...v.textTracks].map((tr, i) => ({ id: i, label: tr.label || tr.language || t('pl.subsN', { n: i + 1 }), active: tr.mode === 'showing' }))],
        setSub: (i) => [...v.textTracks].forEach((tr, k) => (tr.mode = k === i ? 'showing' : 'disabled')),
      };
    }
  }

  needsTap() {
    this.setStatus(t('pl.tap'));
    this.root.classList.add('paused');
  }

  teardown() {
    clearTimeout(this.retryTimer);
    this.engine?.destroy();
    this.engine = null;
    this.thumbs?.destroy();
    this.thumbs = null;
    this.tip.querySelector('canvas')?.remove();
  }

  /** Riconnessione con backoff; per Xtream live prova anche il formato alternativo (m3u8 ↔ ts). */
  onFatal(msg: string) {
    if (!this.req) return;
    const src = active();
    if (this.req.live && this.req.channel?.xid && src?.type === 'xtream' && !this.fmtFallback) {
      this.fmtFallback = true;
      const alt = src.format === 'ts' ? 'm3u8' : 'ts';
      this.req.url = channelUrl(this.req.channel, alt);
      this.setStatus(t('pl.altFormat'), true);
      this.start(this.req.url, this.loadSeq);
      return;
    }
    if (this.retries < MAX_RETRY) {
      const wait = Math.min(1000 * 2 ** this.retries, 15000);
      this.retries++;
      if (!this.req.live && Number.isFinite(this.video.currentTime) && this.video.currentTime > 5) this.req.startAt = this.video.currentTime;
      this.setStatus(t('pl.retry', { m: msg, s: Math.round(wait / 1000), r: this.retries, x: MAX_RETRY }), true);
      const seq = this.loadSeq;
      this.retryTimer = setTimeout(() => seq === this.loadSeq && this.start(this.req.url, seq), wait);
    } else {
      this.teardown();
      this.setStatus(t('pl.cannot', { m: msg }));
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
    if (document.activeElement !== this.progress && !this.scrubbing) this.progress.value = String(Math.round((v.currentTime / d) * 1000));
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
        next ? h('div', { class: 'epg-next' }, t('pl.next'), h('b', null, clock(next.s)), ' ', next.t) : '',
      );
    }
  }

  /* ---------------- diretta: banner canale ---------------- */
  showBanner(c: Channel) {
    const visible = this.list.filter((x) => !hidden(x));
    const n = c.num ?? (visible.findIndex((x) => x.id === c.id) + 1 || undefined);
    const nowBox = h('div', { class: 'p-banner-epg loading' });
    clear(this.banner);
    this.banner.append(
      thumb(img(c.logo), c.name, 'p-banner-logo'),
      h('div', { class: 'p-banner-body' },
        h('div', { class: 'p-banner-head' },
          n ? h('span', { class: 'p-banner-num' }, String(n)) : null,
          h('span', { class: 'p-banner-name' }, c.name),
          h('span', { class: 'p-banner-clock' }, new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }))),
        c.group ? h('div', { class: 'p-banner-group' }, c.group) : null,
        nowBox));
    this.root.classList.add('idle');
    this.banner.classList.add('on');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.banner.classList.remove('on'), 5000);
    epgFor(c).catch(() => [] as EpgItem[]).then((items) => {
      if (this.req.channel?.id !== c.id) return;
      const { now, next } = nowNext(items);
      nowBox.classList.remove('loading');
      if (!now && !next) return nowBox.replaceChildren(h('div', { class: 'p-banner-none' }, t('pl.noEpg')));
      const bar = h('div', { class: 'p-banner-bar' }, h('i'));
      if (now) (bar.firstChild as HTMLElement).style.width = `${Math.min(100, Math.max(0, ((Date.now() / 1000 - now.s) / (now.e - now.s)) * 100))}%`;
      nowBox.replaceChildren(
        now ? h('div', { class: 'p-banner-now' }, h('b', null, `${clock(now.s)}–${clock(now.e)}`), h('span', null, now.t)) : h('div', { class: 'p-banner-none' }, t('pl.noEpg')),
        now ? bar : '',
        next ? h('div', { class: 'p-banner-next' }, t('pl.next'), h('b', null, clock(next.s)), ' ', next.t) : '');
    });
  }

  /* ---------------- film ed episodi ---------------- */
  extrasTick() {
    const v = this.video;
    const d = v.duration;
    if (this.req.live || !Number.isFinite(d)) return;
    const pos = v.currentTime;
    // "Salta intro": negli episodi, nei primi minuti o fino a dove finiva la sigla di questa serie
    const limit = this.intro || INTRO_WINDOW;
    const skip = this.req.kind === 'episode' && !this.skipDone && !this.scrubbing && pos >= 3 && pos < limit - 2;
    this.skipBtn.classList.toggle('on', skip);
    // prossimo episodio
    const nx = nextEpisode(this.req);
    const now = performance.now();
    const dt = this.lastTick ? Math.min(1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (nx && !this.nextCancelled && d > 300 && d - pos <= NEXT_AT && this.countdown < 0 && !this.scrubbing) {
      this.countdown = NEXT_COUNTDOWN;
      this.nextTitle.textContent = episodeLabel(nx);
      this.nextCard.hidden = false;
      this.skipBtn.classList.remove('on');
      this.nextCard.querySelector<HTMLElement>('.btn.primary')?.focus({ preventScroll: true });
    } else if (this.countdown >= 0) {
      if (d - pos > NEXT_AT + 5) return this.hideNext();
      if (!v.paused) this.countdown -= dt;
      if (this.countdown <= 0) return this.playNext();
    }
    if (this.countdown >= 0) {
      this.nextCount.textContent = t('pl.startsIn', { s: Math.ceil(this.countdown) });
      (this.nextBar.firstChild as HTMLElement).style.width = `${(this.countdown / NEXT_COUNTDOWN) * 100}%`;
    }
  }

  playNext() {
    const nx = nextEpisode(this.req);
    this.hideNext();
    if (!nx) return;
    this.saveProgress(true);
    toast(t('pl.nextEp', { s: nx.season, e: nx.episode }));
    document.dispatchEvent(new CustomEvent('orbita:play-episode', { detail: { series: this.req.series, episode: nx } }));
  }

  cancelNext() {
    this.nextCancelled = true;
    this.hideNext();
  }

  hideNext() {
    this.countdown = -1;
    this.nextCard.hidden = true;
  }

  skipIntro() {
    const v = this.video;
    const pos = v.currentTime;
    const target = this.intro > pos ? this.intro : pos + INTRO_DEFAULT_SKIP;
    v.currentTime = Math.min(target, v.duration - 5);
    if (this.intro <= pos) {
      learnIntro(this.req, pos, target);
      this.intro = introEnd(this.req);
    }
    this.skipDone = true;
    this.skipBtn.classList.remove('on');
  }

  /** Anteprima sopra la barra: tempo, salto rispetto a dove si era e, se possibile, il fotogramma. */
  showTip(sec: number, jump: number | null) {
    const d = this.video.duration;
    const f = Math.min(1, Math.max(0, sec / d));
    this.tip.style.left = `${f * 100}%`;
    this.tipTime.textContent = fmtTime(sec);
    this.tipDelta.textContent = jump ? (jump > 0 ? '+' : '−') + fmtTime(Math.abs(jump)) : '';
    if (this.thumbs && !this.thumbs.broken) {
      if (!this.thumbs.canvas.isConnected) this.tip.prepend(this.thumbs.canvas);
      this.thumbs.request(sec);
    } else this.thumbs?.canvas.remove();
    this.tip.classList.add('on');
  }

  /** Frecce: si accumula il salto (accelerando tenendo premuto) e si salta una volta sola, alla fine. */
  scrub(dir: number, repeat: boolean) {
    const v = this.video;
    const d = v.duration;
    if (this.req.live || !Number.isFinite(d)) return;
    if (!this.scrubbing) {
      this.scrubbing = true;
      this.scrubFrom = v.currentTime;
      this.scrubTarget = this.scrubFrom;
      this.hidePause();
    }
    this.scrubRepeat = repeat ? this.scrubRepeat + 1 : 0;
    const r = this.scrubRepeat;
    const step = r < 4 ? 10 : r < 12 ? 30 : r < 24 ? 60 : 120;
    this.scrubTarget = Math.max(0, Math.min(d - 1, this.scrubTarget + dir * step));
    this.progress.value = String(Math.round((this.scrubTarget / d) * 1000));
    this.showTip(this.scrubTarget, this.scrubTarget - this.scrubFrom);
    clearTimeout(this.scrubTimer);
    this.scrubTimer = setTimeout(() => this.commitScrub(), 700);
  }

  commitScrub() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    clearTimeout(this.scrubTimer);
    this.video.currentTime = this.scrubTarget;
    learnIntro(this.req, this.scrubFrom, this.scrubTarget);
    if (this.scrubTarget > this.scrubFrom) this.intro = introEnd(this.req);
    setTimeout(() => !this.scrubbing && this.tip.classList.remove('on'), 500);
  }

  cancelScrub() {
    this.scrubbing = false;
    clearTimeout(this.scrubTimer);
    this.tip.classList.remove('on');
  }

  armPause() {
    clearTimeout(this.pauseTimer);
    if (!this.video.paused || this.req.live) return this.hidePause();
    this.pauseTimer = setTimeout(() => this.showPause(), PAUSE_SCREEN_AFTER);
  }

  showPause() {
    const v = this.video;
    if (!v.paused || this.req.live || this.scrubbing || !Number.isFinite(v.duration) || !v.currentTime) return;
    const p = pauseInfo(this.req);
    const bar = h('div', { class: 'p-pause-bar' }, h('i'));
    (bar.firstChild as HTMLElement).style.width = `${(v.currentTime / v.duration) * 100}%`;
    const chips = p.item ? ratingChips(p.item, p.meta) : null;
    this.pauseEl.replaceChildren(
      p.backdrop ? h('img', { class: 'p-pause-bg', src: img(p.backdrop)!, alt: '', referrerPolicy: 'no-referrer' }) : '',
      h('div', { class: 'p-pause-body' },
        h('div', { class: 'p-eyebrow' }, t('pl.paused')),
        h('h2', null, p.title),
        p.line ? h('div', { class: 'p-pause-line' }, p.line) : '',
        chips || '',
        p.plot ? h('p', null, p.plot) : '',
        bar,
        h('div', { class: 'p-pause-pos' }, `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`)));
    this.pauseEl.hidden = false;
    this.root.classList.add('pause-screen', 'idle');
  }

  hidePause() {
    clearTimeout(this.pauseTimer);
    this.pauseEl.hidden = true;
    this.root.classList.remove('pause-screen');
  }

  saveProgress(ended = false) {
    const v = this.video;
    const r = this.req;
    if (!r.resumeKey || !Number.isFinite(v.duration) || v.currentTime < 5) return;
    const [kind, id] = r.resumeKey.split(':') as ['movie' | 'series', string];
    recordProgress({
      key: r.resumeKey, kind, id, name: r.title, logo: r.logo, seriesId: r.series?.id,
      pos: ended ? v.duration : v.currentTime, dur: v.duration,
    });
  }

  onEnded() {
    this.saveProgress();
    if (this.nextCancelled) return;
    const nx = nextEpisode(this.req);
    if (nx) {
      this.hideNext();
      toast(t('pl.nextEp', { s: nx.season, e: nx.episode }));
      document.dispatchEvent(new CustomEvent('orbita:play-episode', { detail: { series: this.req.series, episode: nx } }));
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
    const from = v.currentTime;
    v.currentTime = Math.max(0, Math.min(v.duration - 1, from + s));
    learnIntro(this.req, from, v.currentTime);
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
      toast(t('pl.noPip'), 'error');
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
    if (this.root.classList.contains('pause-screen')) return;
    this.root.classList.remove('idle');
    this.banner.classList.remove('on');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused && this.menu.hidden && this.drawer.hidden && !this.scrubbing) this.root.classList.add('idle');
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
        items.map((tr) => h('button', { class: 'p-opt' + (tr.active ? ' on' : ''), on: { click: () => (set(tr.id), (this.menu.hidden = true), toast(`${name}: ${tr.label}`, 'ok')) } }, tr.label)));
    };
    const speeds = this.req.live ? null : h('div', { class: 'p-menu-sec' }, h('h4', null, t('pl.speed')),
      [0.75, 1, 1.25, 1.5, 2].map((r) => h('button', { class: 'p-opt' + (this.video.playbackRate === r ? ' on' : ''), on: { click: () => ((this.video.playbackRate = r), (this.menu.hidden = true)) } }, `${r}×`)));
    const fit = h('div', { class: 'p-menu-sec' }, h('h4', null, t('pl.format')),
      [['contain', t('pl.fit')], ['cover', t('pl.fill')], ['fill', t('pl.stretch')]].map(([k, l]) =>
        h('button', { class: 'p-opt' + ((this.video.style.objectFit || 'contain') === k ? ' on' : ''), on: { click: () => ((this.video.style.objectFit = k), (this.menu.hidden = true)) } }, l)));
    const parts = [section(t('pl.audio'), e?.audio?.(), e?.setAudio), section(t('pl.subs'), e?.subs?.(), e?.setSub), section(t('pl.quality'), e?.levels?.(), e?.setLevel), speeds, fit].filter(Boolean);
    const info = h('div', { class: 'p-menu-sec tech' }, h('h4', null, t('pl.tech')),
      h('p', null, this.video.videoWidth ? `${this.video.videoWidth}×${this.video.videoHeight}` : t('pl.noRes')));
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
    this.drawer.append(h('h4', null, group || t('common.channels')), list);
    this.drawer.hidden = false;
    const on = list.querySelector<HTMLElement>('.on');
    on?.scrollIntoView({ block: 'center' });
    (on || list.querySelector<HTMLElement>('button'))?.focus();
  }

  onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('.modal-wrap')) return;
    const panelOpen = !this.menu.hidden || !this.drawer.hidden;
    const k = e.key;
    const stop = () => (e.preventDefault(), e.stopPropagation());
    // schermata di pausa: qualsiasi tasto la chiude; spazio/invio riprendono la visione
    if (!this.pauseEl.hidden) {
      stop();
      this.hidePause();
      if (k === ' ' || k === 'k' || k === 'Enter' || k === 'MediaPlayPause') this.video.play().catch(() => this.needsTap());
      else (this.poke(), this.armPause());
      return;
    }
    if (this.scrubbing && k === 'Enter') return (stop(), this.commitScrub());
    if (!this.nextCard.hidden && (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack')) return (stop(), this.cancelNext());
    if (!this.nextCard.hidden && k === 'Enter' && document.activeElement?.closest('.p-next')) return;
    if (this.skipBtn.classList.contains('on') && k === 'Enter' && this.root.classList.contains('idle')) return (stop(), this.skipIntro());
    let handled = true;
    if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack') {
      if (this.scrubbing) this.cancelScrub();
      else if (panelOpen) this.hidePanels();
      else if (this.banner.classList.contains('on')) this.banner.classList.remove('on');
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
    else if (this.req.live && (k === 'i' || k === 'Info') && this.req.channel) return (stop(), this.showBanner(this.req.channel));
    else if (k === 'i' || k === 'Enter') this.toggleMenu();
    else if (k === 'l' || k === 'c') this.toggleDrawer();
    else if (k === 'ArrowLeft' || k === 'MediaRewind') this.scrub(-1, e.repeat);
    else if (k === 'ArrowRight' || k === 'MediaFastForward') this.scrub(1, e.repeat);
    else if (k === 'ArrowUp' || k === 'PageUp' || k === 'ChannelUp') this.req.live ? this.zap(-1) : this.volume(0.05);
    else if (k === 'ArrowDown' || k === 'PageDown' || k === 'ChannelDown') this.req.live ? this.zap(1) : this.volume(-0.05);
    else if (k === '+' || k === '=') this.volume(0.05);
    else if (k === '-') this.volume(-0.05);
    else handled = false;
    if (handled) {
      stop();
      // cambiando canale resta il banner; negli altri casi compaiono i controlli
      const zapKey = this.req.live && /^(ArrowUp|ArrowDown|PageUp|PageDown|ChannelUp|ChannelDown)$/.test(k);
      if (!zapKey) this.poke();
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
    clearInterval(this.clockTimer);
    clearTimeout(this.bannerTimer);
    clearTimeout(this.pauseTimer);
    clearTimeout(this.scrubTimer);
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('fullscreenchange', this.onFsChange);
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
