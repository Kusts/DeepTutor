// Fila de reprodução TTS por sentença, com pré-busca e invalidação por geração.
// Uma interrupção incrementa a geração: nenhum chunk antigo chega ao player.
// Sem streaming: cada trecho vira um Blob inteiro enviado ao player.

import { synthesizeAudio } from './voice-clients';
import type { AudioPlayerLike } from './audio-output';

const SEM_ACAO = () => {};

/** Divide um trecho ao meio (fronteira de espaço) para fallback de síntese. */
export function dividirTrecho(texto: unknown): string[] {
  const str = String(texto ?? '');
  if (str.length < 48) return [str];
  const meio = Math.ceil(str.length / 2);
  const antes = str.lastIndexOf(' ', meio);
  const depois = str.indexOf(' ', meio);
  const corte = antes >= Math.floor(meio * 0.6) ? antes : (depois > 0 ? depois : -1);
  if (corte < 10 || corte > str.length - 10) return [str];
  return [str.slice(0, corte).trim(), str.slice(corte).trim()].filter(Boolean);
}

export interface TtsItem {
  text: string;
  turnId: string | null;
  index: number;
  generation: number;
  splitDepth?: number;
}

export type Synth = (text: string, opts: { voice: string | null }) => Promise<Blob>;

export type SynthOutcome =
  | { blob: Blob; error?: undefined }
  | { error: unknown; blob?: undefined };

export interface PlayResult {
  stopped?: boolean;
  ended?: boolean;
  error?: boolean;
  code?: string | null;
  at?: number;
}

export interface TtsQueueOptions {
  synthesize?: Synth;
  AudioCtor?: (new (src?: string) => AudioPlayerLike) | null;
  playerFactory?: ((url: string) => AudioPlayerLike) | null;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  onFirstAudio?: (event: { turnId: string | null; at: number; chunkIndex: number; text: string }) => void;
  onSynthReady?: (event: {
    turnId: string | null; index: number; at: number; bytes: number; mimeType: string;
  }) => void;
  onChunkPlayed?: (event: { turnId: string | null; index: number; text: string; at: number }) => void;
  onDrain?: (event: { at: number }) => void;
  onError?: (event: { error: unknown; turnId: string | null }) => void;
  onBlocked?: (event: { turnId: string | null; reason: string }) => void;
  onDiscard?: (event: Record<string, unknown>) => void;
  onGap?: (event: { turnId: string | null; index: number; gapMs: number; at: number }) => void;
  onBuffering?: (event: { ativo: boolean; turnId: string | null; index: number | null; at: number }) => void;
  onSplitFallback?: (event: Record<string, unknown>) => void;
  now?: () => number;
  minIntervalMs?: number;
  prefetchCount?: number;
  maxConcurrent?: number;
  loadingThresholdMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  voice?: string | null;
}

export interface EnqueueOptions {
  turnId: string | null;
  generation?: number;
}

export type TtsDiscard = {
  turnId: string | null;
  index: number;
  text: string;
  reason: string;
  attempts: number;
  at: number;
} & Record<string, unknown>;

export class TtsQueue {
  readonly synthesize: Synth;
  readonly AudioCtor: TtsQueueOptions['AudioCtor'];
  readonly playerFactory: TtsQueueOptions['playerFactory'];
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly onFirstAudio: NonNullable<TtsQueueOptions['onFirstAudio']>;
  readonly onSynthReady: NonNullable<TtsQueueOptions['onSynthReady']>;
  readonly onChunkPlayed: NonNullable<TtsQueueOptions['onChunkPlayed']>;
  readonly onDrain: NonNullable<TtsQueueOptions['onDrain']>;
  readonly onError: NonNullable<TtsQueueOptions['onError']>;
  readonly onBlocked: NonNullable<TtsQueueOptions['onBlocked']>;
  readonly onDiscard: NonNullable<TtsQueueOptions['onDiscard']>;
  readonly onGap: NonNullable<TtsQueueOptions['onGap']>;
  readonly onBuffering: NonNullable<TtsQueueOptions['onBuffering']>;
  readonly temBuffering: boolean;
  readonly onSplitFallback: NonNullable<TtsQueueOptions['onSplitFallback']>;
  readonly now: () => number;
  readonly minIntervalMs: number;
  readonly prefetchCount: number;
  readonly maxConcurrent: number;
  readonly loadingThresholdMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly voice: string | null;

  lastSynthesizeAt = 0;
  generation = 0;
  items: TtsItem[] = [];
  cache = new Map<string, Promise<SynthOutcome>>();
  created: Array<Record<string, unknown>> = [];
  played: Array<Record<string, unknown>> = [];
  aborted: Array<Record<string, unknown>> = [];
  currentAudio: AudioPlayerLike | null = null;
  currentUrl: string | null = null;
  pumping = false;
  firstAudioFor = new Set<string | null>();
  lastStopAt: number | null = null;
  blocked = false;
  failed: Array<Record<string, unknown>> = [];
  discards: TtsDiscard[] = [];
  gaps: Array<Record<string, unknown>> = [];
  lastEndedAt: number | null = null;
  inFlight = 0;
  buffering = false;
  paused: TtsItem[] = [];
  retries = 0;
  private _pendingResolve: ((value: PlayResult) => void) | null = null;

  constructor({
    synthesize = (text, opts) => synthesizeAudio(text, opts),
    AudioCtor = (globalThis.Audio ?? null) as TtsQueueOptions['AudioCtor'],
    playerFactory = null,
    onFirstAudio = () => {},
    onSynthReady = () => {},
    onChunkPlayed = () => {},
    onDrain = () => {},
    onError = () => {},
    onBlocked = () => {},
    onDiscard = () => {},
    onGap = () => {},
    onBuffering = SEM_ACAO,
    onSplitFallback = SEM_ACAO,
    now = () => Date.now(),
    // Edge TTS não tem cota por janela: não há intervalo mínimo entre sínteses.
    minIntervalMs = 0,
    prefetchCount = 3,
    maxConcurrent = 2,
    loadingThresholdMs = 1200,
    maxAttempts = 3,
    retryBaseMs = 400,
    voice = null,
    createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url),
  }: TtsQueueOptions = {}) {
    this.synthesize = synthesize;
    this.AudioCtor = AudioCtor;
    this.playerFactory = playerFactory;
    this.onFirstAudio = onFirstAudio;
    this.onSynthReady = onSynthReady;
    this.onChunkPlayed = onChunkPlayed;
    this.onDrain = onDrain;
    this.onError = onError;
    this.onBlocked = onBlocked;
    this.onDiscard = onDiscard;
    this.onGap = onGap;
    this.onBuffering = onBuffering;
    this.temBuffering = onBuffering !== SEM_ACAO;
    this.onSplitFallback = onSplitFallback;
    this.now = now;
    this.minIntervalMs = minIntervalMs;
    this.prefetchCount = Math.max(1, Math.floor(prefetchCount));
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.loadingThresholdMs = Math.max(0, loadingThresholdMs);
    this.maxAttempts = Math.max(1, maxAttempts);
    this.retryBaseMs = retryBaseMs;
    this.voice = voice;
    this.createObjectURL = createObjectURL;
    this.revokeObjectURL = revokeObjectURL;
  }

  /** Adiciona sentenças de um turno à fila. `generation` deve ser a geração atual. */
  enqueue(chunks: string[] | string, { turnId, generation = this.generation }: EnqueueOptions): void {
    const list = (Array.isArray(chunks) ? chunks : [chunks])
      .filter((c): c is string => typeof c === 'string' && Boolean(c.trim()));
    if (!list.length) return;
    list.forEach((text, index) => this.items.push({ text, turnId, index, generation }));
    this.#prefetch();
    void this.#pump().catch((error: unknown) => this.onError({ error, turnId }));
  }

  // Espaçamento configurável, zerado por padrão com o perfil Edge TTS (sem cota).
  async #synth(text: string): Promise<Blob> {
    let lastError: unknown;
    for (let tentativa = 0; tentativa < this.maxAttempts; tentativa += 1) {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastSynthesizeAt));
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      this.lastSynthesizeAt = Date.now();
      try {
        return await this.synthesize(text, { voice: this.voice });
      } catch (error) {
        lastError = error;
        const code = String(
          (error as { code?: unknown; message?: unknown } | null)?.code
          ?? (error as { message?: unknown } | null)?.message ?? '',
        );
        // 429 (cota) e erros de requisição inválida não melhoram com retry local.
        const transitório = /50[2364]|NoAudio|timeout|econnreset|network/i.test(code);
        if (!transitório || tentativa === this.maxAttempts - 1) break;
        this.retries += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, this.retryBaseMs * (tentativa + 1)));
      }
    }
    throw lastError;
  }

  #makePlayer(url: string): AudioPlayerLike {
    if (this.playerFactory) return this.playerFactory(url);
    if (!this.AudioCtor) throw new Error('Player de áudio indisponível');
    const audio = new this.AudioCtor();
    audio.preload = 'auto';
    audio.src = url;
    return audio;
  }

  /** Retoma a fila depois que o usuário destravou o áudio com um toque. */
  retry(): boolean {
    if (!this.blocked) return false;
    this.blocked = false;
    void this.#pump().catch((error: unknown) => this.onError({ error, turnId: null }));
    return true;
  }

  #prefetch(): void {
    const vagas = Math.max(0, this.maxConcurrent - this.inFlight);
    if (vagas <= 0) return;
    const pending = this.items
      .filter((item) => !this.cache.has(item.text))
      .slice(0, Math.min(this.prefetchCount, vagas));
    for (const item of pending) {
      const promise: Promise<SynthOutcome> = this.#synth(item.text)
        .then<SynthOutcome, SynthOutcome>((blob) => ({ blob }), (error: unknown) => ({ error }));
      this.cache.set(item.text, promise);
      this.inFlight += 1;
      const liberar = () => { this.inFlight = Math.max(0, this.inFlight - 1); };
      void promise.then(liberar, liberar);
    }
  }

  /**
   * Interrupção por voz: guarda o que restava em vez de descartar, para que a
   * UI ofereça "Continuar de onde parou". A fila atual é parada (geração nova).
   */
  pauseForInterruption(): string[] {
    const salvos = this.items.map((item) => ({ ...item }));
    this.stop();
    this.paused = salvos;
    return salvos.map((s) => s.text);
  }

  /** Descarta o restante guardado (nova aula/encerramento). */
  clearPaused(): number {
    const n = this.paused.length;
    this.paused = [];
    return n;
  }

  /** Retoma os trechos guardados com a geração atual. Nunca toca os já falados. */
  resumePaused(): number {
    if (!this.paused.length) return 0;
    const salvos = this.paused;
    this.paused = [];
    for (const item of salvos) {
      this.items.push({ ...item, generation: this.generation });
    }
    this.#prefetch();
    void this.#pump().catch((error: unknown) => this.onError({ error, turnId: null }));
    return salvos.length;
  }

  #setBuffering(ativo: boolean, item: Partial<TtsItem> = {}): void {
    if (this.buffering === ativo) return;
    this.buffering = ativo;
    this.onBuffering({ ativo, turnId: item.turnId ?? null, index: item.index ?? null, at: this.now() });
  }

  /** Para imediatamente: áudio, fila e pré-buscas. Incrementa a geração. */
  stop(): void {
    this.generation += 1;
    this.blocked = false;
    this.lastEndedAt = null;
    this.lastStopAt = this.now();
    this.#setBuffering(false);
    // `paused` NÃO é limpo aqui: pauseForInterruption() guarda o restante e a
    // interrupção do controlador chama stop() logo em seguida.
    const discarded = this.items.map((item) => ({ turnId: item.turnId, index: item.index, reason: 'stop' }));
    this.aborted.push(...discarded);
    this.items = [];
    this.cache.clear();
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve({ stopped: true });
    }
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
        this.currentAudio.removeAttribute('src');
        this.currentAudio.load();
      } catch { /* player já liberado */ }
      this.currentAudio = null;
    }
    if (this.currentUrl) {
      this.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  async #pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift() as TtsItem;
        if (item.generation !== this.generation) {
          this.aborted.push({ turnId: item.turnId, index: item.index, reason: 'generation' });
          continue;
        }
        this.#prefetch();
        const cached = this.cache.get(item.text);
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (cached && this.temBuffering) {
          timer = setTimeout(() => this.#setBuffering(true, item), this.loadingThresholdMs);
        }
        let result: SynthOutcome;
        try {
          result = cached
            ? await cached
            : await this.#synth(item.text).then<SynthOutcome, SynthOutcome>(
              (blob) => ({ blob }),
              (error: unknown) => ({ error }),
            );
        } finally {
          if (timer) clearTimeout(timer);
          this.#setBuffering(false, item);
        }
        this.cache.delete(item.text);
        if (item.generation !== this.generation || result.error || !result.blob) {
          const motivo = result.error
            ? `erro_tts: ${String(
              (result.error as { message?: unknown } | null)?.message ?? result.error,
            ).slice(0, 120)}`
            : 'generation';
          this.aborted.push({ turnId: item.turnId, index: item.index, reason: motivo });
          if (result.error) {
            const depth = Number(item.splitDepth) || 0;
            const partes = dividirTrecho(item.text);
            // NUNCA para a fila: tenta dividir ao meio antes de descartar.
            if (depth < 2 && partes.length === 2) {
              this.items.unshift(
                { ...item, text: partes[0], splitDepth: depth + 1 },
                { ...item, text: partes[1], splitDepth: depth + 1 },
              );
              this.onSplitFallback({
                turnId: item.turnId, index: item.index, partes: 2, reason: motivo, at: this.now(),
              });
              continue;
            }
            const descarte: TtsDiscard = {
              turnId: item.turnId, index: item.index, text: item.text,
              reason: motivo, attempts: this.maxAttempts * (depth + 1), at: this.now(),
            };
            this.discards.push(descarte);
            this.onDiscard(descarte);
            this.onError({ error: result.error, turnId: item.turnId });
          }
          continue;
        }
        const synthAt = this.now();
        const blob = result.blob;
        this.onSynthReady({
          turnId: item.turnId, index: item.index, at: synthAt,
          bytes: blob.size, mimeType: blob.type || 'audio/mpeg',
        });
        const url = this.createObjectURL(blob);
        const audio = this.#makePlayer(url);
        this.currentAudio = audio;
        this.currentUrl = url;
        this.created.push({
          turnId: item.turnId, index: item.index, at: synthAt,
          bytes: blob.size, mimeType: blob.type || 'audio/mpeg',
        });

        const started = await new Promise<PlayResult>((resolve) => {
          let settled = false;
          const finish = (value: PlayResult) => {
            if (settled) return;
            settled = true;
            audio.onplaying = null;
            audio.onended = null;
            audio.onerror = null;
            this._pendingResolve = null;
            resolve(value);
          };
          this._pendingResolve = finish;
          audio.onplaying = () => {
            if (item.generation !== this.generation) return finish({ stopped: true });
            const at = this.now();
            if (this.lastEndedAt !== null && item.generation === this.generation) {
              const gapMs = Math.max(0, at - this.lastEndedAt);
              this.gaps.push({ turnId: item.turnId, index: item.index, gapMs, at });
              this.onGap({ turnId: item.turnId, index: item.index, gapMs, at });
            }
            if (!this.firstAudioFor.has(item.turnId)) {
              this.firstAudioFor.add(item.turnId);
              this.onFirstAudio({ turnId: item.turnId, at, chunkIndex: item.index, text: item.text });
            }
          };
          audio.onended = () => finish({ ended: true, at: this.now() });
          audio.onerror = () => finish({ error: true, at: this.now() });
          const playResult = audio.play();
          if (playResult && typeof (playResult as Promise<void>).catch === 'function') {
            (playResult as Promise<void>).catch((error: unknown) => finish({
              error: true, code: (error as { code?: string | null } | null)?.code ?? null, at: this.now(),
            }));
          }
        });

        if (this.currentAudio === audio) {
          this.currentAudio = null;
          if (this.currentUrl === url) {
            this.revokeObjectURL(url);
            this.currentUrl = null;
          }
        }
        if (started.stopped || item.generation !== this.generation) {
          this.aborted.push({ turnId: item.turnId, index: item.index, reason: 'stopped_before_play' });
          continue;
        }
        if (started.error) {
          const motivo = String(started.code ?? 'player_de_audio_falhou');
          this.failed.push({ turnId: item.turnId, index: item.index, code: started.code ?? null, reason: motivo });
          if (started.code !== 'AUTOPLAY_BLOCKED') {
            const descarte: TtsDiscard = {
              turnId: item.turnId, index: item.index, text: item.text,
              reason: motivo, attempts: 1, at: this.now(),
            };
            this.discards.push(descarte);
            this.onDiscard(descarte);
          }
          if (started.code === 'AUTOPLAY_BLOCKED') {
            this.blocked = true;
            this.items.unshift(item); // não descarta: retoma ao toque do usuário
            this.onBlocked({ turnId: item.turnId, reason: started.code });
            return;
          }
          this.onError({ error: new Error('player de áudio falhou'), turnId: item.turnId });
          continue;
        }
        this.played.push({ turnId: item.turnId, index: item.index, at: started.at ?? this.now() });
        this.lastEndedAt = started.at ?? this.now();
        this.onChunkPlayed({
          turnId: item.turnId, index: item.index, text: item.text, at: started.at ?? this.now(),
        });
      }
    } finally {
      this.pumping = false;
      if (this.items.length === 0) this.onDrain({ at: this.now() });
    }
  }

  get debug(): Record<string, unknown> {
    return {
      generation: this.generation,
      queueLength: this.items.length,
      playing: Boolean(this.currentAudio),
      blocked: this.blocked,
      failed: this.failed.map((item) => ({ ...item })),
      discards: this.discards.map((item) => ({ ...item })),
      gaps: this.gaps.map((item) => ({ ...item })),
      voice: this.voice,
      buffering: this.buffering,
      inFlight: this.inFlight,
      prefetchCount: this.prefetchCount,
      maxConcurrent: this.maxConcurrent,
      retries: this.retries,
      paused: this.paused.map((p) => ({ turnId: p.turnId, index: p.index, chars: p.text.length })),
      lastStopAt: this.lastStopAt,
      created: [...this.created],
      played: [...this.played],
      aborted: [...this.aborted],
    };
  }
}
