// Saída de áudio robusta para iOS Safari / Android Chrome.
// UM AudioContext persistente, resume()+buffer silencioso DENTRO do gesto do
// usuário, e reprodução dos MP3 do TTS via decodeAudioData -> AudioBufferSource.
// O "elemento" devolvido por createPlayer() tem a interface mínima usada por
// TtsQueue (src/play/pause/onplaying/onended/onerror), sem mudar a fila.
// A fatia 3B consome apenas o player/analisador daqui: nenhum sintetizador de
// fala do avatar é chamado neste caminho.

import { currentAudioSessionType } from './audio-session';

export const AUDIO_ERROR = Object.freeze({
  AUTOPLAY_BLOCKED: 'AUTOPLAY_BLOCKED',
  DECODE_FAILED: 'DECODE_FAILED',
  CONTEXT_CLOSED: 'CONTEXT_CLOSED',
} as const);

export type AudioErrorCode = (typeof AUDIO_ERROR)[keyof typeof AUDIO_ERROR];

interface AudioGlobals {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
}

function audioGlobals(): typeof globalThis & AudioGlobals {
  return globalThis as typeof globalThis & AudioGlobals;
}

export interface Connectable {
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface OutputAnalyser extends Connectable {
  fftSize: number;
  getFloatTimeDomainData(buffer: Float32Array): void;
}

export interface OutputGain extends Connectable {
  gain: {
    value: number;
    setValueAtTime(value: number, startTime: number): void;
    linearRampToValueAtTime(value: number, endTime: number): void;
  };
}

export type NodeHandler = ((...args: never[]) => void) | null;

export interface OutputBufferSource extends Connectable {
  buffer: unknown;
  playbackRate?: { value: number };
  onended?: NodeHandler;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface OutputBuffer {
  duration: number;
}

export interface OutputContext {
  readonly state: string;
  readonly sampleRate: number;
  readonly destination: unknown;
  readonly currentTime: number;
  resume(): Promise<unknown>;
  createAnalyser?(): OutputAnalyser;
  createBuffer(channels: number, length: number, sampleRate: number): OutputBuffer;
  createBufferSource(): OutputBufferSource;
  createGain(): OutputGain;
  decodeAudioData(data: ArrayBuffer): Promise<OutputBuffer>;
}

export interface BlobResponse {
  ok: boolean;
  status?: number;
  blob(): Promise<Blob>;
}

export type FetchAudio = (input: string, init?: RequestInit) => Promise<BlobResponse>;

export interface AudioPlayerLike {
  onplaying: NodeHandler;
  onended: NodeHandler;
  onerror: NodeHandler;
  preload: string;
  src: string;
  currentTime: number;
  play(): void | Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  _stopped?: boolean;
  _source?: OutputBufferSource | null;
}

export interface AudioOutputOptions {
  AudioContextCtor?: (new () => OutputContext) | null;
  now?: () => number;
  onBlocked?: (detail: { reason: AudioErrorCode; state: string }) => void;
  onState?: (detail: { state: string; unlocked: boolean; at: number }) => void;
  onElementEvent?: (type: string, detail: Record<string, unknown>) => void;
  fetchImpl?: FetchAudio | null;
  context?: OutputContext | null;
  prepareLegacy?: (() => unknown) | null;
  fadeInMs?: number;
  fadeOutMs?: number;
  playbackRate?: number;
}

export interface OutputErrorEntry {
  type: string;
  name: string;
  message: string;
  at: number;
}

export class WebAudioOutput {
  readonly available: boolean;
  readonly AudioContextCtor: AudioOutputOptions['AudioContextCtor'];
  readonly now: () => number;
  readonly onBlocked: NonNullable<AudioOutputOptions['onBlocked']>;
  readonly onState: NonNullable<AudioOutputOptions['onState']>;
  readonly onElementEvent: NonNullable<AudioOutputOptions['onElementEvent']>;
  readonly fetchImpl: FetchAudio | null;
  readonly prepareLegacy: AudioOutputOptions['prepareLegacy'];
  readonly fadeInMs: number;
  readonly fadeOutMs: number;

  /** Analisador da saída: exposto para o lip-sync da fatia 3B. */
  monitor: AnalyserNode | null = null;
  playbackRate: number;
  context: OutputContext | null = null;
  unlocked = false;
  muted = false;
  silentPlays = 0;
  started = 0;
  stopped = 0;
  errors: OutputErrorEntry[] = [];
  current: AudioPlayerLike | null = null;
  currentGain: OutputGain | null = null;
  currentHtml: { pause(): void; currentTime: number } | null = null;
  legacyHandle: unknown = null;

  constructor({
    AudioContextCtor = (audioGlobals().AudioContext ?? audioGlobals().webkitAudioContext) as AudioOutputOptions['AudioContextCtor'],
    now = () => Date.now(),
    onBlocked = () => {},
    onState = () => {},
    onElementEvent = () => {},
    fetchImpl = globalThis.fetch as FetchAudio | undefined,
    context = null,
    prepareLegacy = null,
    fadeInMs = 15,
    fadeOutMs = 30,
    playbackRate = 1,
  }: AudioOutputOptions = {}) {
    // WebKit headless (e navegadores sem Web Audio) não têm AudioContext: a
    // sala continua utilizável com <audio>; o Safari real sempre o fornece.
    this.available = Boolean(AudioContextCtor || context);
    this.AudioContextCtor = AudioContextCtor;
    this.now = now;
    this.onBlocked = onBlocked;
    this.onState = onState;
    this.onElementEvent = onElementEvent;
    this.prepareLegacy = prepareLegacy;
    // fetch exige `this === window` no navegador: nunca chamá-lo como método da fila.
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : fetchImpl ?? null;
    this.fadeInMs = fadeInMs;
    this.fadeOutMs = fadeOutMs;
    this.playbackRate = Math.min(1.2, Math.max(0.9, Number(playbackRate) || 1));
    if (context) {
      this.context = context;
      this.#attachMonitor();
    }
  }

  #attachMonitor(): void {
    try {
      const ctx = this.context;
      if (ctx && typeof ctx.createAnalyser === 'function') {
        this.monitor = ctx.createAnalyser() as unknown as AnalyserNode;
        this.monitor.fftSize = 256;
        this.monitor.connect(ctx.destination as AudioNode);
      }
    } catch { /* monitor opcional: a saída continua normal */ }
  }

  #ensureContext(): OutputContext | null {
    if (!this.AudioContextCtor && !this.context) return null;
    if (!this.context || this.context.state === 'closed') {
      this.context = new this.AudioContextCtor!();
      this.unlocked = false;
      this.current = null;
      this.monitor = null;
      this.#attachMonitor();
    }
    return this.context;
  }

  /** Nível RMS da saída (usado para calibrar eco e correlação no barge-in). */
  medirNivelSaida(): number {
    if (!this.monitor || typeof this.monitor.getFloatTimeDomainData !== 'function') return 0;
    try {
      const buf = new Float32Array(this.monitor.fftSize || 256);
      this.monitor.getFloatTimeDomainData(buf);
      let soma = 0;
      for (const v of buf) soma += v * v;
      return buf.length ? Math.sqrt(soma / buf.length) : 0;
    } catch { return 0; }
  }

  /** Contexto compartilhado com a captura (um único AudioContext no iOS). */
  get sharedContext(): OutputContext | null {
    return this.context;
  }

  #error(type: string, error: unknown): OutputErrorEntry {
    const entry: OutputErrorEntry = {
      type,
      name: error instanceof Error ? error.name : 'Error',
      message: String(error instanceof Error ? error.message : '').slice(0, 120),
      at: this.now(),
    };
    this.errors.push(entry);
    if (this.errors.length > 30) this.errors.shift();
    return entry;
  }

  get state(): string {
    return this.context?.state ?? 'none';
  }

  /** Chamada SINCRONAMENTE no gesto do usuário (clique/toque em Iniciar aula/mic). */
  async unlock(): Promise<boolean> {
    const ctx = this.#ensureContext();
    if (!ctx) {
      this.unlocked = true;
      this.onState({ state: 'indisponivel', unlocked: true, at: this.now() });
      return true;
    }
    // Fallback legado para iOS < 16.4: <audio> silencioso em loop, preparado
    // no gesto. O audioSession.type é definido pela sala (play-and-record
    // durante a captura; playback quando só há saída).
    if (!this.legacyHandle && typeof this.prepareLegacy === 'function') {
      this.legacyHandle = this.prepareLegacy();
    }
    // resume() e o buffer silencioso devem começar no mesmo tick do gesto.
    const resumePromise = ctx.state === 'suspended' ? ctx.resume() : null;
    try {
      const length = Math.max(1, Math.ceil((ctx.sampleRate ?? 48000) * 0.02));
      const silent = ctx.createBuffer(1, length, ctx.sampleRate ?? 48000);
      const source = ctx.createBufferSource();
      source.buffer = silent;
      source.connect(ctx.destination);
      source.start(0);
      this.silentPlays += 1;
    } catch (error) {
      this.#error('silent_buffer', error);
    }
    if (resumePromise) {
      try { await resumePromise; } catch (error) { this.#error('resume', error); }
    }
    this.unlocked = ctx.state === 'running';
    this.onState({ state: ctx.state, unlocked: this.unlocked, at: this.now() });
    if (!this.unlocked) this.onBlocked({ reason: AUDIO_ERROR.AUTOPLAY_BLOCKED, state: ctx.state });
    return this.unlocked;
  }

  setMuted(value: boolean): boolean {
    this.muted = Boolean(value);
    if (this.currentGain) this.currentGain.gain.value = this.muted ? 0 : 1;
    return this.muted;
  }

  /** Velocidade 0,9–1,2 aplicada no nó de reprodução (observação: altera o tom). */
  setPlaybackRate(value: number): number {
    const rate = Number(value);
    this.playbackRate = Number.isFinite(rate) ? Math.min(1.2, Math.max(0.9, rate)) : 1;
    if (this.current?._source?.playbackRate) {
      try { this.current._source.playbackRate.value = this.playbackRate; } catch { /* fonte já liberada */ }
    }
    return this.playbackRate;
  }

  /** Fecha a fonte atual imediatamente (barge-in). Devolve o instante da parada. */
  stop(): number | null {
    (this.legacyHandle as { stop?: () => void } | null)?.stop?.();
    this.legacyHandle = null;
    if (this.currentHtml) {
      try { this.currentHtml.pause(); this.currentHtml.currentTime = 0; } catch { /* já parado */ }
      this.currentHtml = null;
    }
    const el = this.current;
    if (!el) return null;
    this.#stopElement(el);
    const at = this.now();
    this.stopped += 1;
    this.onElementEvent('pause', { estado: this.state, recovered: false });
    return at;
  }

  #stopElement(el: AudioPlayerLike): void {
    if (!el || el._stopped) return;
    el._stopped = true;
    try { el._source?.stop(0); } catch { /* já terminou */ }
    try { el._source?.disconnect(); } catch { /* já desconectado */ }
    if (this.current === el) this.current = null;
    this.currentGain = null;
  }

  /** Interface mínima de elemento de áudio consumida por TtsQueue. */
  createPlayer(src: string): AudioPlayerLike {
    const self = this;
    return {
      onplaying: null,
      onended: null,
      onerror: null,
      preload: 'auto',
      src,
      currentTime: 0,
      _stopped: false,
      _source: null,
      play() { return self.#playElement(this); },
      pause() { self.#stopElement(this); },
      load() {},
      removeAttribute() {},
    };
  }

  async #playElement(el: AudioPlayerLike): Promise<void> {
    const ctx = this.#ensureContext();
    if (!ctx) return this.#playHtmlFallback(el);
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (error) { this.#error('resume_play', error); }
      if (ctx.state !== 'running') {
        const error = new Error('Áudio bloqueado pelo navegador');
        error.name = 'NotAllowedError';
        (error as Error & { code: AudioErrorCode }).code = AUDIO_ERROR.AUTOPLAY_BLOCKED;
        this.#error('autoplay', error);
        this.onBlocked({ reason: AUDIO_ERROR.AUTOPLAY_BLOCKED, state: ctx.state });
        throw error;
      }
    }
    let buffer: OutputBuffer;
    try {
      if (!this.fetchImpl) throw new Error('fetch indisponível');
      const response = await this.fetchImpl(el.src);
      if (!response?.ok) throw new Error(`fetch do áudio falhou (${response?.status ?? 0})`);
      const arrayBuffer = await response.blob().then((blob) => blob.arrayBuffer());
      buffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (error) {
      const entry = this.#error('decode', error);
      const wrapped = new Error(`Falha ao decodificar áudio: ${entry.name}`);
      (wrapped as Error & { code: AudioErrorCode }).code = AUDIO_ERROR.DECODE_FAILED;
      throw wrapped;
    }
    if (el._stopped || ctx.state !== 'running') return;

    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : 1;
    gain.connect(this.monitor ?? ctx.destination);
    this.onElementEvent('play', { estado: ctx.state, currentTime: ctx.currentTime ?? 0 });
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (source.playbackRate) {
      try { source.playbackRate.value = this.playbackRate; } catch { /* nó sem taxa configurável */ }
    }
    source.connect(gain);
    // Rampa curta nas bordas elimina o "clique" das emendas entre MP3s.
    try {
      const inicio = ctx.currentTime ?? 0;
      const duracao = (buffer.duration ?? 0) / this.playbackRate;
      const alvo = this.muted ? 0 : 1;
      const fadeIn = Math.max(0, this.fadeInMs) / 1000;
      const fadeOut = Math.max(0, this.fadeOutMs) / 1000;
      gain.gain.setValueAtTime(0, inicio);
      gain.gain.linearRampToValueAtTime(alvo, inicio + fadeIn);
      if (fadeOut > 0 && duracao > fadeIn + fadeOut) {
        gain.gain.setValueAtTime(alvo, inicio + duracao - fadeOut);
        gain.gain.linearRampToValueAtTime(0, inicio + duracao);
      }
    } catch { /* automação não suportada: áudio ainda toca */ }
    source.onended = () => {
      if (el._stopped) return;
      el._stopped = true;
      if (this.current === el) this.current = null;
      this.currentGain = null;
      this.stopped += 1;
      this.onElementEvent('ended', { estado: ctx.state, currentTime: ctx.currentTime ?? 0 });
      el.onended?.();
    };
    el._source = source;
    this.current = el;
    this.currentGain = gain;
    source.start(0);
    this.started += 1;
    // Marca o início da reprodução EFETIVA (não o da síntese).
    el.onplaying?.();
  }

  /** Reprodução por <audio> quando não há Web Audio (ex WebKit headless). */
  async #playHtmlFallback(el: AudioPlayerLike): Promise<void> {
    const AudioCtor = globalThis.Audio;
    if (!AudioCtor) {
      const error = new Error('Áudio indisponível neste navegador');
      (error as Error & { code: AudioErrorCode }).code = AUDIO_ERROR.CONTEXT_CLOSED;
      throw error;
    }
    const audio = new AudioCtor(el.src);
    audio.preload = 'auto';
    audio.setAttribute?.('playsinline', '');
    const registrar = (evento: string) => this.onElementEvent(evento, {
      readyState: audio.readyState ?? null,
      currentTime: Number(audio.currentTime) || 0,
      estado: this.state,
    });
    audio.onplaying = () => {
      if (el._stopped) return;
      this.started += 1;
      registrar('playing');
      el.onplaying?.();
    };
    audio.onended = () => {
      if (el._stopped) return;
      el._stopped = true;
      this.stopped += 1;
      registrar('ended');
      el.onended?.();
    };
    audio.onerror = () => { registrar('error'); el.onerror?.(); };
    for (const evento of ['waiting', 'stalled', 'suspend', 'interrupted', 'pause']) {
      audio.addEventListener?.(evento, () => registrar(evento));
    }
    this.currentHtml = audio;
    try {
      await audio.play();
    } catch (error) {
      const entry = this.#error('autoplay_html', error);
      if (/NotAllowedError/i.test(entry.name)) {
        this.onBlocked({ reason: AUDIO_ERROR.AUTOPLAY_BLOCKED, state: 'indisponivel' });
        const blocked = new Error('Áudio bloqueado pelo navegador');
        (blocked as Error & { code: AudioErrorCode }).code = AUDIO_ERROR.AUTOPLAY_BLOCKED;
        throw blocked;
      }
      throw error;
    }
  }

  get debug(): Record<string, unknown> {
    return {
      contextState: this.available ? this.state : 'indisponivel',
      available: this.available,
      audioSessionType: currentAudioSessionType(),
      legacyIosPrepared: Boolean(this.legacyHandle),
      unlocked: this.unlocked,
      muted: this.muted,
      playbackRate: this.playbackRate,
      fadeInMs: this.fadeInMs,
      fadeOutMs: this.fadeOutMs,
      silentPlays: this.silentPlays,
      started: this.started,
      stopped: this.stopped,
      errors: this.errors.map((e) => ({ ...e })),
    };
  }
}
