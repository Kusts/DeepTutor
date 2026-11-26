// Captura de microfone: getUserMedia + AnalyserNode (VAD) + PCM via
// AudioWorklet (preferencial) com fallback para ScriptProcessorNode.
// O nó de captura SEMPRE é ligado a um GainNode(0) -> destination: no iOS,
// nós sem saída conectada podem não processar amostras (WebKit Web Audio).
// O AudioContext é CRIADO/RESUMIDO sincronamente no gesto, ANTES do await do
// getUserMedia (política de ativação do Safari) e é compartilhado com a saída.
// Nunca MediaRecorder/webm (D3 do ADR 0002).

import { encodeWavMono } from './wav';
import { currentAudioSessionType } from './audio-session';

export const AUDIO_CONSTRAINTS: Readonly<{ audio: MediaStreamConstraints['audio'] }> = Object.freeze({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
});

export const TARGET_SAMPLE_RATE = 16000;

interface CaptureGlobals {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
  AudioWorkletNode?: unknown;
}

function captureGlobals(): typeof globalThis & CaptureGlobals {
  return globalThis as typeof globalThis & CaptureGlobals;
}

const WORKLET_SOURCE = `
class TutorCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = (options && options.processorOptions && options.processorOptions.chunkSize) || 2048;
    this.buffer = new Float32Array(this.chunkSize);
    this.used = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i += 1) {
        this.buffer[this.used++] = input[i];
        if (this.used >= this.chunkSize) {
          this.port.postMessage(this.buffer);
          this.buffer = new Float32Array(this.chunkSize);
          this.used = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tutor-capture', TutorCaptureProcessor);
`;

/** FIR passa-baixa (Hann) aplicada ANTES da decimação. Sem isso, reamostrar
 *  48 kHz -> 16 kHz por interpolação linear cria aliasing na faixa do STT. */
export function lowpassBeforeDecimation(input: Float32Array, factor: number): Float32Array {
  if (!(factor > 1) || input.length === 0) return input;
  const half = Math.max(2, Math.ceil(factor));
  const size = half * 2 + 1;
  const cutoff = 0.5 / factor; // normalizado pela frequência de Nyquist de entrada
  const taps = new Float64Array(size);
  let sum = 0;
  for (let n = -half; n <= half; n += 1) {
    const sinc = n === 0 ? 2 * cutoff : (Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n)) * 2;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + half)) / (size - 1));
    const value = sinc * window;
    taps[n + half] = value;
    sum += value;
  }
  for (let i = 0; i < taps.length; i += 1) taps[i] /= sum || 1;
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let acc = 0;
    for (let k = 0; k < size; k += 1) {
      const idx = Math.min(input.length - 1, Math.max(0, i + k - half));
      acc += input[idx] * taps[k];
    }
    out[i] = acc;
  }
  return out;
}

/** Reamostragem PCM mono com filtro passa-baixa quando há decimação. */
export function resampleMono(input: Float32Array, fromRate: number, toRate = TARGET_SAMPLE_RATE): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0) return input;
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const filtered = ratio < 1 ? lowpassBeforeDecimation(input, 1 / ratio) : input;
  const length = Math.max(1, Math.floor(filtered.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i / ratio;
    const left = Math.floor(pos);
    const right = Math.min(filtered.length - 1, left + 1);
    const weight = pos - left;
    out[i] = (filtered[left] ?? 0) * (1 - weight) + (filtered[right] ?? 0) * weight;
  }
  return out;
}

export interface Connectable {
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface CaptureAnalyser extends Connectable {
  fftSize: number;
  smoothingTimeConstant: number;
  getFloatTimeDomainData(buffer: Float32Array): void;
}

export interface CaptureGain extends Connectable {
  gain: { value: number };
}

export type WorkletMessageHandler = (event: { data: unknown }) => void;

export interface CaptureProcessor extends Connectable {
  port?: {
    onmessage: unknown;
    postMessage(message: unknown): void;
  };
  onaudioprocess?: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
}

export interface CaptureContext {
  readonly state: string;
  readonly sampleRate: number;
  readonly destination: unknown;
  audioWorklet?: { addModule(url: string): Promise<unknown> };
  resume(): Promise<unknown>;
  createMediaStreamSource(stream: MediaStream): Connectable;
  createAnalyser(): CaptureAnalyser;
  createGain(): CaptureGain;
  createScriptProcessor?(bufferSize: number, inputChannels: number, outputChannels: number): CaptureProcessor;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
  close(): Promise<unknown>;
}

export interface AudioCaptureOptions {
  AudioContextCtor?: (new () => CaptureContext) | null;
  context?: CaptureContext | null;
  getMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> | undefined;
  createWorkletUrl?: ((source: string) => string) | null;
  AudioWorkletNodeCtor?: (new (
    context: CaptureContext,
    name: string,
    options: {
      numberOfInputs: number;
      numberOfOutputs: number;
      outputChannelCount: number[];
      processorOptions: { chunkSize: number };
    },
  ) => CaptureProcessor) | null;
  now?: () => number;
  targetSampleRate?: number;
  preRollMs?: number;
  paddingMs?: number;
}

export interface CaptureIssue {
  kind: string;
  name: string | null;
  message: string;
  at: number;
}

export interface CaptureHealth {
  ok: boolean;
  reason: string | null;
}

export interface AudioClip {
  blob: Blob;
  durationMs: number;
  mimeType: string;
  bytes: number;
  usedFallback: boolean;
  preRollMs: number;
  preRollSamples: number;
  paddingMs: number;
}

export class AudioCapture {
  readonly AudioContextCtor: AudioCaptureOptions['AudioContextCtor'];
  readonly getMedia: NonNullable<AudioCaptureOptions['getMedia']>;
  readonly createWorkletUrl: AudioCaptureOptions['createWorkletUrl'];
  readonly AudioWorkletNodeCtor: AudioCaptureOptions['AudioWorkletNodeCtor'];
  readonly now: () => number;
  readonly targetSampleRate: number;
  readonly preRollMs: number;
  readonly paddingMs: number;

  context: CaptureContext | null;
  ownsContext: boolean;
  recentChunks: Float32Array[] = [];
  recentSamples = 0;
  pendingPadding = false;
  preRollAplicado = 0;
  stream: MediaStream | null = null;
  track: MediaStreamTrack | null = null;
  analyser: CaptureAnalyser | null = null;
  source: Connectable | null = null;
  node: CaptureProcessor | null = null;
  nodeKind: 'audioworklet' | 'scriptprocessor' | null = null;
  silentGain: CaptureGain | null = null;
  workletUrl: string | null = null;
  chunks: Float32Array[] = [];
  framesReceived = 0;
  maxRms = 0;
  signalIssues: CaptureIssue[] = [];
  lastError: CaptureIssue | null = null;
  recordingSince = 0;
  active = false;
  onSignalChange: (issue: CaptureIssue & { health: CaptureHealth }) => void = () => {};
  onStateChange: (state: { state: string; at: number }) => void = () => {};
  lastRms = 0;
  private _resumePromise: Promise<unknown> | null = null;
  private _stateHandler: (() => void) | null = null;

  constructor({
    AudioContextCtor = (captureGlobals().AudioContext ?? captureGlobals().webkitAudioContext) as AudioCaptureOptions['AudioContextCtor'],
    context = null,
    getMedia = (constraints) => navigator.mediaDevices?.getUserMedia?.(constraints),
    createWorkletUrl = null,
    AudioWorkletNodeCtor = captureGlobals().AudioWorkletNode as unknown as AudioCaptureOptions['AudioWorkletNodeCtor'],
    now = () => Date.now(),
    targetSampleRate = TARGET_SAMPLE_RATE,
    preRollMs = 300,
    paddingMs = 250,
  }: AudioCaptureOptions = {}) {
    this.AudioContextCtor = AudioContextCtor;
    this.context = context;
    this.ownsContext = !context;
    this.getMedia = getMedia;
    this.createWorkletUrl = createWorkletUrl;
    this.AudioWorkletNodeCtor = AudioWorkletNodeCtor;
    this.now = now;
    this.targetSampleRate = targetSampleRate;
    this.preRollMs = preRollMs;
    this.paddingMs = paddingMs;
  }

  #ensureContext(): CaptureContext {
    if (!this.context || this.context.state === 'closed') {
      if (!this.AudioContextCtor) throw new TypeError('AudioContext indisponível');
      this.context = new this.AudioContextCtor();
      this.ownsContext = true;
    }
    if (this.context.state === 'suspended' && !this._resumePromise) {
      // Chamada SINCRONAMENTE no gesto: não guardar Promise de contexto alheio.
      try { this._resumePromise = this.context.resume(); } catch (error) { this.#issue('resume', error); }
    }
    return this.context;
  }

  #issue(kind: string, error: unknown = null): CaptureIssue {
    const entry: CaptureIssue = {
      kind,
      name: error instanceof Error ? error.name : null,
      message: String(error instanceof Error ? error.message : '').slice(0, 120),
      at: this.now(),
    };
    if (kind === 'track_muted' || kind === 'track_unmuted') {
      this.signalIssues = this.signalIssues.filter((i) => i.kind !== entry.kind && i.kind !== 'sem_sinal');
      this.signalIssues.push(entry);
    } else if (kind === 'sem_sinal' || kind === 'context_interrupted' || kind === 'track_ended') {
      if (!this.signalIssues.some((i) => i.kind === kind)) this.signalIssues.push(entry);
    }
    this.lastError = entry;
    this.onSignalChange({ ...entry, health: this.health });
    return entry;
  }

  get health(): CaptureHealth {
    if (!this.active) return { ok: false, reason: 'inativo' };
    if (this.track?.readyState === 'ended') return { ok: false, reason: 'track_encerrado' };
    if (this.track?.muted) return { ok: false, reason: 'track_muted' };
    const ctxState = this.context?.state;
    if (ctxState === 'interrupted' || ctxState === 'suspended' || ctxState === 'closed') {
      return { ok: false, reason: `contexto_${ctxState}` };
    }
    if (this.signalIssues.some((i) => i.kind === 'sem_sinal')) return { ok: false, reason: 'sem_sinal' };
    return { ok: true, reason: null };
  }

  async start(): Promise<CaptureAnalyser> {
    if (this.active && this.analyser) return this.analyser;
    const ctx = this.#ensureContext();
    if (typeof this.getMedia !== 'function') {
      throw new Error('getUserMedia indisponível neste navegador');
    }
    // getUserMedia é chamado no mesmo gesto (antes de qualquer await aqui).
    const stream = await this.getMedia(AUDIO_CONSTRAINTS);
    if (!stream?.getAudioTracks?.().length) throw new Error('Microfone não entregou faixas de áudio');
    if (this._resumePromise) {
      try { await this._resumePromise; } catch (error) { this.#issue('resume', error); }
      this._resumePromise = null;
    }

    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.track = track;
    if (track.muted) this.#issue('track_muted');
    track.addEventListener('mute', () => this.#issue('track_muted'));
    track.addEventListener('unmute', () => this.#issue('track_unmuted'));
    track.addEventListener('ended', () => this.#issue('track_ended'));
    this._stateHandler = () => {
      const state = ctx.state;
      if (state === 'interrupted') this.#issue('context_interrupted');
      if (state === 'running') this.signalIssues = this.signalIssues.filter((i) => i.kind !== 'context_interrupted');
      this.onStateChange({ state, at: this.now() });
    };
    ctx.addEventListener?.('statechange', this._stateHandler);

    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 0;

    await this.#attachProcessor();
    this.source.connect(this.analyser);
    this.analyser.connect(this.node as CaptureProcessor);
    (this.node as CaptureProcessor).connect(this.silentGain);
    this.silentGain.connect(ctx.destination);

    this.active = true;
    this.recordingSince = this.now();
    return this.analyser;
  }

  async #attachProcessor(): Promise<void> {
    const ctx = this.context as CaptureContext;
    // AudioWorklet é preferencial: roda na thread de áudio e não sofre
    // engasgos da UI. Blob URL gerada localmente (sem CDN e sem arquivo extra).
    try {
      if (!ctx.audioWorklet || typeof this.AudioWorkletNodeCtor !== 'function') {
        throw new Error('AudioWorklet indisponível');
      }
      const blob = typeof Blob === 'function'
        ? new Blob([WORKLET_SOURCE], { type: 'text/javascript' }) : null;
      if (!blob || !globalThis.URL?.createObjectURL) throw new Error('Blob URL indisponível');
      this.workletUrl = this.createWorkletUrl
        ? this.createWorkletUrl(WORKLET_SOURCE) : globalThis.URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(this.workletUrl);
      this.node = new this.AudioWorkletNodeCtor(ctx, 'tutor-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { chunkSize: 2048 },
      });
      const handler: WorkletMessageHandler = ({ data }) => {
        if (data instanceof Float32Array) this.#acceptFrames(data);
      };
      if (this.node.port) this.node.port.onmessage = handler;
      this.nodeKind = 'audioworklet';
      return;
    } catch (error) {
      this.#issue('audioworklet_fallback', error);
    }
    // Fallback legado: ScriptProcessor ligado ao destino silencioso.
    if (typeof ctx.createScriptProcessor !== 'function') throw new Error('Nó de captura indisponível');
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (event) => {
      this.#acceptFrames(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    this.nodeKind = 'scriptprocessor';
  }

  #acceptFrames(data: Float32Array): void {
    this.framesReceived += data.length;
    if (!this.active) return;
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const rms = data.length ? Math.sqrt(sum / data.length) : 0;
    this.lastRms = rms;
    if (rms > this.maxRms) this.maxRms = rms;
    this.chunks.push(data);
    // Janela deslizante de ~preRollMs: o início da palavra que o VAD detecta
    // já passou pelo analisador; sem isso o STT recebe a frase decapitada.
    this.recentChunks.push(data);
    this.recentSamples += data.length;
    const limite = Math.max(1, Math.round((this.context?.sampleRate ?? 48000) * this.preRollMs / 1000));
    while (this.recentSamples > limite && this.recentChunks.length > 1) {
      this.recentSamples -= this.recentChunks[0].length;
      this.recentChunks.shift();
    }
  }

  /** Lê o nível atual do analisador (usado pela barra ao vivo e pelo teste de microfone). */
  measureLevel(): { rms: number; peak: number } {
    if (!this.analyser) return { rms: 0, peak: 0 };
    const buffer = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    let peak = 0;
    for (const v of buffer) {
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const rms = Math.sqrt(sum / buffer.length);
    if (rms > this.maxRms) this.maxRms = rms;
    return { rms, peak };
  }

  /** Marca explicitamente ausência de sinal (usado pelo watchdog da sala). */
  markNoSignal(detail: { lastRms?: number } = {}): void {
    this.#issue('sem_sinal', null);
    if (detail.lastRms !== undefined) this.lastRms = detail.lastRms;
  }

  resetRecording(): void {
    if (!this.active) return;
    // Pre-roll: reaproveita o tail recente (áudio antes do onset do VAD).
    this.chunks = this.recentChunks.map((chunk) => new Float32Array(chunk));
    this.recordingSince = this.now();
    this.pendingPadding = true;
    this.preRollAplicado = this.chunks.reduce((n, c) => n + c.length, 0);
  }

  async finalizeClip(): Promise<AudioClip | null> {
    if (!this.active || !this.context) return null;
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!length) return null;
    const merged = new Float32Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    let pcm = resampleMono(merged, this.context.sampleRate, this.targetSampleRate);
    if (this.pendingPadding) {
      const padding = Math.round(this.targetSampleRate * this.paddingMs / 1000);
      const extended = new Float32Array(pcm.length + padding);
      extended.set(pcm, 0);
      pcm = extended;
    }
    const wav = encodeWavMono({
      sampleRate: this.targetSampleRate,
      length: pcm.length,
      numberOfChannels: 1,
      getChannelData: () => pcm,
    });
    const blob = new Blob([wav], { type: 'audio/wav' });
    const result: AudioClip = {
      blob,
      durationMs: this.now() - this.recordingSince,
      mimeType: 'audio/wav',
      bytes: blob.size,
      usedFallback: this.nodeKind !== 'audioworklet',
      preRollMs: this.preRollMs,
      preRollSamples: this.preRollAplicado,
      paddingMs: this.pendingPadding ? this.paddingMs : 0,
    };
    this.chunks = [];
    this.recordingSince = this.now();
    this.pendingPadding = false;
    this.preRollAplicado = 0;
    return result;
  }

  stop(): void {
    if (this.node) {
      this.node.port?.postMessage?.({ type: 'stop' });
      try { this.node.disconnect(); } catch { /* já desconectado */ }
      if (this.node.onaudioprocess) this.node.onaudioprocess = null;
    }
    this.silentGain?.disconnect();
    this.analyser?.disconnect();
    this.source?.disconnect();
    if (this._stateHandler) this.context?.removeEventListener?.('statechange', this._stateHandler);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.ownsContext && this.context && this.context.state !== 'closed') {
      void this.context.close().catch(() => {});
    }
    if (this.workletUrl && !this.createWorkletUrl) globalThis.URL?.revokeObjectURL(this.workletUrl);
    this.stream = null;
    this.track = null;
    this.context = this.ownsContext ? null : this.context;
    this.analyser = null;
    this.source = null;
    this.node = null;
    this.nodeKind = null;
    this.silentGain = null;
    this.workletUrl = null;
    this._resumePromise = null;
    this._stateHandler = null;
    this.chunks = [];
    this.recentChunks = [];
    this.recentSamples = 0;
    this.pendingPadding = false;
    this.preRollAplicado = 0;
    this.active = false;
  }

  get debug(): Record<string, unknown> {
    return {
      active: this.active,
      nodeKind: this.nodeKind,
      framesRecebidas: this.framesReceived,
      maxRms: Number(this.maxRms.toFixed(4)),
      lastRms: this.lastRms,
      tracks: this.stream?.getTracks().map((t) => ({
        kind: t.kind, readyState: t.readyState, muted: Boolean(t.muted), enabled: t.enabled,
      })) ?? [],
      trackMuted: Boolean(this.track?.muted),
      trackReadyState: this.track?.readyState ?? null,
      sampleRateNativo: this.context?.sampleRate ?? null,
      sampleRateUsado: this.targetSampleRate,
      contextState: this.context?.state ?? null,
      audioSessionType: currentAudioSessionType(),
      bufferedChunks: this.chunks.length,
      preRollMs: this.preRollMs,
      paddingMs: this.paddingMs,
      recentChunks: this.recentChunks.length,
      signalIssues: this.signalIssues.map((i) => ({ ...i })),
      lastError: this.lastError ? { ...this.lastError } : null,
      health: this.health,
    };
  }
}
