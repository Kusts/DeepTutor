// VAD de energia ENDURECIDO: histerese + calibração contínua de ruído + gate
// espectral simples (taxa de cruzamento por zero e fator de crista) + duração
// mínima de fala. Sem modelo local, sem CDN e com custo desprezível no celular.
// A decisão (e por que não Silero/ONNX nesta V1) está em docs/decisoes/0004-vad-v1.md.

export interface VadConfig {
  intervalMs: number;
  calibrationMs: number;
  noiseFactor: number;
  minThreshold: number;
  releaseFactor: number;
  onsetFrames: number;
  hangoverMs: number;
  resumeWindowMs: number;
  playbackFactor: number;
  playbackMinSpeechMs: number;
  minSpeechMs: number;
  minZcr: number;
  maxZcr: number;
  minCrest: number;
  cooldownMs: number;
  minPeakAbs: number;
  minVoiceRatio: number;
  minNoiseRatio: number;
}

export const VAD_DEFAULTS: Readonly<VadConfig> = Object.freeze({
  intervalMs: 30,
  calibrationMs: 500,
  noiseFactor: 3.0,
  minThreshold: 0.012,
  releaseFactor: 1.7,
  onsetFrames: 4,          // ~120 ms de fala confirmada para abrir turno
  hangoverMs: 600,         // silêncio para fechar (era 900 ms)
  resumeWindowMs: 400,     // fala que volta nessa janela NÃO abre turno novo
  playbackFactor: 2.4,     // limiar maior enquanto o Tutor fala (anti-eco)
  playbackMinSpeechMs: 250, // confirmação mais longa durante reprodução
  minSpeechMs: 600,        // duração útil mínima (era 400 ms); interjeições não viram turno
  minZcr: 0.008,           // ruído estacionário (ventilador) fica abaixo
  maxZcr: 0.5,             // estalos/zipper ficam acima
  minCrest: 1.6,           // voz tem pico bem acima da RMS média
  cooldownMs: 150,
  // Etapa 2f: gates adicionais contra disparos por ruído de microfone.
  minPeakAbs: 0.04,        // pico absoluto mínimo do candidato (silêncio com ganho alto)
  minVoiceRatio: 0.55,     // fração de frames "voz" dentro da janela de confirmação
  minNoiseRatio: 2.0,      // RMS do candidato / piso de ruído calibrado
});

export interface SpeechStartEvent {
  at: number;
  rms: number;
  playbackActive: boolean;
}

export interface SpeechEndEvent {
  at: number;
  reason: 'stop' | 'hangover';
  durationMs: number;
}

export interface VadDiscardEvent {
  reason: string;
  durationMs: number;
  at: number;
  rms: number;
  zcr: number;
}

export interface VadDebug {
  samples: number;
  rms: number;
  peak: number;
  candidatePeak: number;
  voiceRatio: number;
  zcr: number;
  crest: number;
  noiseFloor: number;
  speaking: boolean;
  playbackActive: boolean;
  triggers: number;
  discards: { curto: number; espectro: number; energia: number; total: number };
  trigger: number;
  release: number;
}

export interface EnergyVadOptions {
  analyser: { fftSize: number; getFloatTimeDomainData(buffer: Float32Array): void };
  onSpeechStart?: (event: SpeechStartEvent) => void;
  onSpeechEnd?: (event: SpeechEndEvent) => void;
  onSample?: (debug: VadDebug) => void;
  onDiscard?: (event: VadDiscardEvent) => void;
  options?: Partial<VadConfig>;
  now?: () => number;
}

export class EnergyVad {
  readonly analyser: EnergyVadOptions['analyser'];
  readonly onSpeechStart: (event: SpeechStartEvent) => void;
  readonly onSpeechEnd: (event: SpeechEndEvent) => void;
  readonly onSample: (debug: VadDebug) => void;
  readonly onDiscard: (event: VadDiscardEvent) => void;
  readonly options: VadConfig;
  readonly now: () => number;
  readonly buffer: Float32Array;

  running = false;
  timer: ReturnType<typeof setInterval> | null = null;
  speaking = false;
  playbackActive = false;
  startedAt = 0;
  noiseFloor = 0.004;
  aboveCount = 0;
  speechStartedAt = 0;
  lastVoiceAt = 0;
  lastEndedAt = 0;
  samples = 0;
  triggers = 0;
  peak = 0;
  candidateFrames = 0;
  voiceFrames = 0;
  candidatePeak = 0;
  rms = 0;
  zcr = 0;
  crest = 1;
  discards = { curto: 0, espectro: 0, energia: 0, total: 0 };

  constructor({
    analyser,
    onSpeechStart,
    onSpeechEnd,
    onSample,
    onDiscard,
    options = {},
    now = () => Date.now(),
  }: EnergyVadOptions) {
    if (!analyser) throw new TypeError('analyser é obrigatório');
    this.analyser = analyser;
    this.onSpeechStart = onSpeechStart ?? (() => {});
    this.onSpeechEnd = onSpeechEnd ?? (() => {});
    this.onSample = onSample ?? (() => {});
    this.onDiscard = onDiscard ?? (() => {});
    this.options = { ...VAD_DEFAULTS, ...options };
    this.now = now;
    this.buffer = new Float32Array(analyser.fftSize);
  }

  setPlaybackActive(active: boolean): void {
    this.playbackActive = Boolean(active);
  }

  get thresholds(): { trigger: number; release: number } {
    const base = Math.max(this.options.minThreshold, this.noiseFloor * this.options.noiseFactor);
    const trigger = this.playbackActive ? base * this.options.playbackFactor : base;
    return { trigger, release: trigger / this.options.releaseFactor };
  }

  get debug(): VadDebug {
    return {
      samples: this.samples,
      rms: this.rms,
      peak: this.peak,
      candidatePeak: this.candidatePeak,
      voiceRatio: this.candidateFrames ? this.voiceFrames / this.candidateFrames : 0,
      zcr: this.zcr,
      crest: this.crest,
      noiseFloor: this.noiseFloor,
      speaking: this.speaking,
      playbackActive: this.playbackActive,
      triggers: this.triggers,
      discards: { ...this.discards },
      ...this.thresholds,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.samples = 0;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.speaking) {
      this.speaking = false;
      const durationMs = this.now() - this.speechStartedAt;
      if (durationMs >= this.options.minSpeechMs) {
        this.onSpeechEnd({ at: this.now(), reason: 'stop', durationMs });
      } else {
        this.#discard('curto', durationMs);
      }
    }
  }

  /** Medidas do frame: RMS, pico, taxa de cruzamento por zero e fator de crista. */
  #measure(): number {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    let peak = 0;
    let crossings = 0;
    let previous = this.buffer[0] ?? 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const v = this.buffer[i];
      sum += v * v;
      const mag = Math.abs(v);
      if (mag > peak) peak = mag;
      if ((v >= 0) !== (previous >= 0)) crossings += 1;
      previous = v;
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    this.rms = rms;
    this.peak = peak;
    this.zcr = crossings / this.buffer.length;
    this.crest = rms > 0 ? peak / rms : 0;
    this.samples += 1;
    return rms;
  }

  #resetCandidate(): void {
    this.candidateFrames = 0;
    this.voiceFrames = 0;
    this.candidatePeak = 0;
  }

  /** Confirmação conservadora: energia absoluta, razão de voz e razão com o piso. */
  #energiaConfirmada(): boolean {
    const { minPeakAbs, minVoiceRatio, minNoiseRatio } = this.options;
    if (this.candidatePeak < minPeakAbs) return false;
    if (this.candidateFrames > 0 && this.voiceFrames / this.candidateFrames < minVoiceRatio) return false;
    if (this.noiseFloor > 0 && this.rms / this.noiseFloor < minNoiseRatio) return false;
    return true;
  }

  #speechLike(trigger: number): boolean {
    if (this.rms < trigger) return false;
    const { minZcr, maxZcr, minCrest } = this.options;
    if (this.zcr < minZcr || this.zcr > maxZcr) return false;
    if (this.crest < minCrest) return false;
    return true;
  }

  #discard(reason: string, durationMs = 0): void {
    this.discards[reason as keyof typeof this.discards] =
      (this.discards[reason as keyof typeof this.discards] ?? 0) + 1;
    this.discards.total += 1;
    this.onDiscard({ reason, durationMs, at: this.now(), rms: this.rms, zcr: this.zcr });
  }

  tick(): void {
    if (!this.running) return;
    const rms = this.#measure();
    const elapsed = this.now() - this.startedAt;
    if (elapsed < this.options.calibrationMs) {
      this.noiseFloor = this.samples === 1 ? rms : Math.min(this.noiseFloor, Math.max(rms, 0.001));
      this.onSample(this.debug);
      return;
    }

    const { trigger, release } = this.thresholds;
    const t = this.now();
    if (!this.speaking) {
      // Cooldown evita reabrir no rabo de um segmento recém-fechado.
      if (t - this.lastEndedAt < this.options.cooldownMs) {
        this.onSample(this.debug);
        return;
      }
      const like = this.#speechLike(trigger);
      if (like) {
        this.aboveCount += 1;
        this.candidateFrames += 1;
        this.voiceFrames += 1;
        this.candidatePeak = Math.max(this.candidatePeak, this.peak);
      } else {
        this.aboveCount = 0;
        this.#resetCandidate();
      }
      if (this.aboveCount >= this.options.onsetFrames) {
        if (!this.#energiaConfirmada()) {
          this.#discard('energia', this.candidateFrames * this.options.intervalMs);
          this.aboveCount = 0;
          this.#resetCandidate();
          this.lastEndedAt = t;
          this.onSample(this.debug);
          return;
        }
        this.speaking = true;
        this.speechStartedAt = t - (this.aboveCount - 1) * this.options.intervalMs;
        this.lastVoiceAt = t;
        this.aboveCount = 0;
        this.#resetCandidate();
        this.triggers += 1;
        this.onSample(this.debug);
        this.onSpeechStart({ at: t, rms, playbackActive: this.playbackActive });
        return;
      }
    } else {
      if (this.#speechLike(release)) this.lastVoiceAt = t;
      const duration = t - this.speechStartedAt;
      const silence = t - this.lastVoiceAt;
      const minDuration = this.playbackActive ? this.options.playbackMinSpeechMs : this.options.minSpeechMs;
      if (silence >= this.options.hangoverMs) {
        this.speaking = false;
        this.lastEndedAt = t;
        this.#resetCandidate();
        if (duration < minDuration) {
          this.#discard('curto', duration);
        } else {
          this.onSample(this.debug);
          this.onSpeechEnd({ at: t, reason: 'hangover', durationMs: duration });
        }
      }
    }
    // Ruído de fundo acompanha devagar, apenas fora de fala.
    if (!this.speaking && rms < release) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
    this.onSample(this.debug);
  }
}
