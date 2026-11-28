import { describe, expect, it } from 'vitest';

import {
  EnergyVad,
  VAD_DEFAULTS,
  type SpeechEndEvent,
  type SpeechStartEvent,
  type VadDiscardEvent,
} from '@/features/classroom/voice/model/vad';
import {
  cabecaHttpSemThreads,
  criarVadComFallback,
  resolveVadKind,
} from '@/features/classroom/voice/model/vad-runtime';
import {
  isContinuation,
  mergeSegments,
  RESUME_WINDOW_MS,
} from '@/features/classroom/voice/model/hangover';

const RATE = 24000;
const FRAME = 1024;

/** Fala sintética com crista > 1,6 e ZCR na faixa da voz (trens de pulso). */
function speech(seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(RATE * seconds));
  for (let i = 0; i < out.length; i += 1) {
    const phase = i % 64;
    const group = Math.floor(i / 64) % 2;
    out[i] = phase < 6 ? (group ? -0.3 : 0.3) : 0;
  }
  return out;
}

function silence(seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(RATE * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = 0.002 * Math.sin(i / 7);
  return out;
}

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function harness(samples: Float32Array, options: { playbackActive?: boolean } = {}) {
  let now = 1000;
  let cursor = 0;
  const starts: SpeechStartEvent[] = [];
  const ends: SpeechEndEvent[] = [];
  const discards: VadDiscardEvent[] = [];
  const analyser = {
    fftSize: FRAME,
    getFloatTimeDomainData(buffer: Float32Array) {
      for (let i = 0; i < FRAME; i += 1) buffer[i] = samples[cursor + i] ?? 0;
      cursor += FRAME;
    },
  };
  const vad = new EnergyVad({
    analyser,
    now: () => now,
    onSpeechStart: (e) => starts.push(e),
    onSpeechEnd: (e) => ends.push(e),
    onDiscard: (e) => discards.push(e),
  });
  if (options.playbackActive) vad.setPlaybackActive(true);
  return {
    vad, starts, ends, discards,
    run(maxFrames = Math.floor(samples.length / FRAME)) {
      vad.start();
      const frames = Math.min(maxFrames, Math.floor(samples.length / FRAME));
      for (let i = 0; i < frames; i += 1) { now += VAD_DEFAULTS.intervalMs; vad.tick(); }
      vad.stop();
      return { starts: [...starts], ends: [...ends], discards: [...discards] };
    },
  };
}

describe('VAD de energia', () => {
  it('usa histerese, calibração de ruído e portas documentadas', () => {
    expect(VAD_DEFAULTS.hangoverMs).toBe(600);
    expect(VAD_DEFAULTS.resumeWindowMs).toBe(400);
    expect(VAD_DEFAULTS.minSpeechMs).toBe(600);
    expect(VAD_DEFAULTS.playbackFactor).toBe(2.4);
    expect(VAD_DEFAULTS.minPeakAbs).toBeGreaterThanOrEqual(0.02);
    expect(VAD_DEFAULTS.minVoiceRatio).toBeGreaterThan(0);
    expect(VAD_DEFAULTS.minNoiseRatio).toBeGreaterThanOrEqual(1.5);
    expect(VAD_DEFAULTS.hangoverMs).toBeLessThan(900);
  });

  it('silêncio contínuo não abre turno e a calibração acompanha o piso', () => {
    const h = harness(silence(6));
    const result = h.run();
    expect(result.starts).toHaveLength(0);
    expect(h.vad.noiseFloor).toBeGreaterThan(0);
    expect(h.vad.noiseFloor).toBeLessThan(0.01);
  });

  it('fala real sintética abre e fecha um turno com duração útil', () => {
    const result = harness(join(silence(1), speech(1.5), silence(1.5))).run();
    expect(result.starts.length).toBe(1);
    const validas = result.ends.filter((e) => e.durationMs >= VAD_DEFAULTS.minSpeechMs);
    expect(validas).toHaveLength(1);
    expect(validas[0]!.reason).toBe('hangover');
  });

  it('interjeição curta não chega ao STT', () => {
    const result = harness(join(silence(1), speech(0.08), silence(1))).run();
    expect(result.ends).toHaveLength(0);
  });

  it('limiar é endurecido durante playback (anti-eco)', () => {
    const h = harness(silence(2));
    h.vad.noiseFloor = 0.004;
    const base = h.vad.thresholds.trigger;
    h.vad.setPlaybackActive(true);
    expect(h.vad.thresholds.trigger).toBeCloseTo(base * VAD_DEFAULTS.playbackFactor, 6);

    // Amplitude que passa no limiar normal, mas não no endurecido.
    const baseSpeech = speech(1);
    const moderate = new Float32Array(baseSpeech.length);
    for (let i = 0; i < moderate.length; i += 1) moderate[i] = baseSpeech[i]! * 0.21;
    expect(harness(join(silence(1), moderate, silence(1))).run().starts.length).toBeGreaterThan(0);
    expect(harness(join(silence(1), moderate, silence(1)), { playbackActive: true }).run().starts.length).toBe(0);
  });

  it('registra descarte por curto quando fala é interrompida antes do mínimo', () => {
    const h = harness(join(silence(1), speech(0.5)));
    h.run(); // calibração no silêncio + onset confirmado, menos de 600 ms úteis
    expect(h.discards[0]?.reason).toBe('curto');
  });
});

describe('vad-runtime', () => {
  it('sem assets neurais, VAD de energia é o caminho padrão', () => {
    const r = resolveVadKind({ assets: null, wasm: function () {}, crossOriginIsolated: false });
    expect(r).toMatchObject({ kind: 'energia', neuralDisponivel: false, motivo: 'sem_assets_neural' });
  });

  it('sem COOP/COEP cai para energia', () => {
    const r = resolveVadKind({
      assets: { wasm: 'vad.wasm', model: 'silero.onnx' },
      wasm: function () {}, crossOriginIsolated: false,
    });
    expect(r).toMatchObject({ kind: 'energia', motivo: 'sem_coop_coep' });
    expect(cabecaHttpSemThreads(false)).toBe(true);
  });

  it('single-thread com assets e carregador usa neural', () => {
    const r = resolveVadKind({
      assets: { wasm: 'vad.wasm', model: 'silero.onnx', requiresThreads: false },
      wasm: function () {}, crossOriginIsolated: true, carregarNeural: async () => ({}),
    });
    expect(r.kind).toBe('neural');
  });

  it('falha ao carregar neural faz fallback automático para energia', async () => {
    const energy = { tipo: 'energia' };
    const r = await criarVadComFallback({
      criarEnergyVad: () => energy,
      assets: { wasm: 'vad.wasm', model: 'silero.onnx', requiresThreads: false },
      wasm: function () {}, crossOriginIsolated: true,
      carregarNeural: async () => { throw new Error('WASM indisponível no iOS'); },
    });
    expect(r).toMatchObject({ kind: 'energia', motivo: 'neural_falhou' });
    expect(r.instancia).toBe(energy);
  });
});

describe('hangover', () => {
  it('fala dentro da janela de retomada é continuação, não novo turno', () => {
    expect(RESUME_WINDOW_MS).toBe(400);
    expect(isContinuation(1000, 1100)).toBe(true);
    expect(isContinuation(1000, 1000)).toBe(true);
    expect(isContinuation(1000, 1400)).toBe(true);
    expect(isContinuation(1000, 1401)).toBe(false);
    expect(isContinuation(1000, 900)).toBe(false);
  });

  it('valores ausentes nunca viram continuação e segmentos vazios são mesclados', () => {
    expect(isContinuation(null, 1000)).toBe(false);
    expect(isContinuation(1000, undefined)).toBe(false);
    expect(mergeSegments(['Olá,', '', 'como vai?'])).toEqual(['Olá, como vai?']);
    expect(mergeSegments([])).toEqual([]);
  });
});
