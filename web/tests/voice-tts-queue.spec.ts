import { describe, expect, it } from 'vitest';

import { dividirTrecho, TtsQueue } from '@/features/classroom/voice/transport/tts-queue';
import type { AudioPlayerLike, NodeHandler } from '@/features/classroom/voice/transport/audio-output';

class FakeAudio implements AudioPlayerLike {
  static instances: FakeAudio[] = [];
  onplaying: NodeHandler = null;
  onended: NodeHandler = null;
  onerror: NodeHandler = null;
  preload = 'auto';
  src = '';
  currentTime = 0;
  constructor() { FakeAudio.instances.push(this); }
  play() {
    queueMicrotask(() => this.onplaying?.());
    queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }
  pause() {}
  load() {}
  removeAttribute() {}
}

const blob = () => new Blob([new Uint8Array(1234)], { type: 'audio/mpeg' });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(overrides: Record<string, unknown> = {}) {
  const synthCalls: string[] = [];
  const ready: Array<Record<string, unknown>> = [];
  const played: Array<Record<string, unknown>> = [];
  const first: Array<Record<string, unknown>> = [];
  const errors: unknown[] = [];
  const queue = new TtsQueue({
    AudioCtor: FakeAudio,
    synthesize: async (text: string) => { synthCalls.push(text); return blob(); },
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
    onSynthReady: (e) => ready.push(e),
    onChunkPlayed: (e) => played.push(e),
    onFirstAudio: (e) => first.push(e),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return { queue, synthCalls, ready, played, first, errors };
}

describe('fila TTS', () => {
  it('sem intervalo artificial: Edge TTS não tem cota por janela', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    try {
      const { queue, synthCalls } = harness();
      expect(queue.minIntervalMs).toBe(0);
      queue.enqueue(['Primeira frase.', 'Segunda frase.'], { turnId: 'turn-a' });
      await new Promise((r) => realSetTimeout(r, 60));
      expect(synthCalls).toHaveLength(2);
      expect(delays.every((ms) => ms < 1000)).toBe(true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('síntese pronta antes da reprodução; primeira fala dispara uma vez por turno', async () => {
    const { queue, ready, first, played } = harness();
    queue.enqueue(['Uma.', 'Dois.'], { turnId: 'turn-c' });
    await wait(60);
    expect(ready).toHaveLength(2);
    expect(ready[0]).toMatchObject({ turnId: 'turn-c', mimeType: 'audio/mpeg', bytes: 1234 });
    expect(first).toHaveLength(1);
    expect(played).toHaveLength(2);
    expect(Number(ready[0]!.at)).toBeLessThanOrEqual(Number(first[0]!.at));
  });

  it('retenta falha transitória, registra descarte e continua com a próxima', async () => {
    const tentativas: string[] = [];
    const tocados: Array<Record<string, unknown>> = [];
    const descartes: Array<Record<string, unknown>> = [];
    const queue = new TtsQueue({
      AudioCtor: FakeAudio,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {},
      retryBaseMs: 1,
      maxAttempts: 3,
      synthesize: async (text: string) => {
        tentativas.push(text);
        if (text === 'Falha.') {
          const erro = new Error('NoAudioReceived') as Error & { code: string };
          erro.code = 'TTS_502';
          throw erro;
        }
        return blob();
      },
      onDiscard: (e) => descartes.push(e),
      onChunkPlayed: (e) => tocados.push(e),
    });
    queue.enqueue(['Falha.', 'Boa.'], { turnId: 't-retry' });
    await wait(120);
    expect(tentativas.filter((t) => t === 'Falha.')).toHaveLength(3);
    expect(descartes).toEqual([expect.objectContaining({ index: 0, attempts: 3 })]);
    expect(tocados).toEqual([expect.objectContaining({ index: 1, text: 'Boa.' })]);
  });

  it('stop() impede que síntese em voo toque após a interrupção', async () => {
    const { queue, played } = harness({
      synthesize: (text: string) => new Promise<Blob>((resolve) => {
        void text;
        setTimeout(() => resolve(blob()), 40);
      }),
    });
    queue.enqueue(['Turno antigo.'], { turnId: 'turn-old' });
    queue.stop();
    await wait(90);
    expect(played).toHaveLength(0);
    expect(queue.aborted.some((a) => a.turnId === 'turn-old')).toBe(true);
  });

  it('autoplay bloqueado mantém o chunk e retoma ao toque, sem duplo áudio', async () => {
    const tocados: Array<Record<string, unknown>> = [];
    const bloqueios: unknown[] = [];
    let allow = false;
    const player = (): AudioPlayerLike => ({
      onplaying: null, onended: null, onerror: null,
      preload: 'auto', src: '', currentTime: 0,
      play() {
        if (!allow) {
          const error = new Error('bloqueado') as Error & { code: string };
          error.code = 'AUTOPLAY_BLOCKED';
          return Promise.reject(error);
        }
        queueMicrotask(() => this.onplaying?.());
        queueMicrotask(() => this.onended?.());
        return Promise.resolve();
      },
      pause() {}, load() {}, removeAttribute() {},
    });
    const queue = new TtsQueue({
      synthesize: async () => blob(),
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {},
      playerFactory: player,
      onBlocked: (e) => bloqueios.push(e),
      onChunkPlayed: (e) => tocados.push(e),
    });
    queue.enqueue(['Primeira frase falada.'], { turnId: 't1' });
    await wait(60);
    expect(queue.blocked).toBe(true);
    expect(bloqueios).toHaveLength(1);
    expect(tocados).toHaveLength(0);
    expect(queue.debug.queueLength).toBe(1);

    allow = true;
    expect(queue.retry()).toBe(true);
    await wait(60);
    expect(queue.blocked).toBe(false);
    expect(tocados).toHaveLength(1);
    expect(queue.debug.queueLength).toBe(0);
    expect(queue.retry()).toBe(false);
    expect(tocados).toHaveLength(1);
  });

  it('pré-busca paralela limitada a 2 requisições simultâneas', async () => {
    let ativas = 0;
    let maxAtivas = 0;
    const { queue, played } = harness({
      maxConcurrent: 2,
      prefetchCount: 3,
      synthesize: async () => {
        ativas += 1; maxAtivas = Math.max(maxAtivas, ativas);
        await wait(20);
        ativas -= 1;
        return blob();
      },
    });
    queue.enqueue(Array.from({ length: 6 }, (_, i) => `Trecho ${i}.`), { turnId: 't' });
    await wait(240);
    expect(maxAtivas).toBeLessThanOrEqual(2);
    expect(played).toHaveLength(6);
  });

  it('trecho longo que falha é dividido ao meio e a fila continua', async () => {
    const longo = 'Primeira metade da explicação sobre variáveis e listas em Python, com exemplos práticos.';
    const tocados: Array<Record<string, unknown>> = [];
    const splits: unknown[] = [];
    const descartes: unknown[] = [];
    let chamadas = 0;
    const queue = new TtsQueue({
      AudioCtor: FakeAudio,
      maxAttempts: 1, retryBaseMs: 1, maxConcurrent: 1,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {},
      synthesize: async (texto: string) => {
        chamadas += 1;
        if (texto === longo) throw new Error('NoAudioReceived');
        return blob();
      },
      onChunkPlayed: (e) => tocados.push(e),
      onSplitFallback: (e) => splits.push(e),
      onDiscard: (e) => descartes.push(e),
    });
    queue.enqueue([longo, 'Agora a segunda parte.'], { turnId: 't' });
    await wait(180);
    expect(splits).toHaveLength(1);
    expect(tocados).toHaveLength(3);
    expect(descartes).toHaveLength(0);
    expect(chamadas).toBeGreaterThanOrEqual(4);
  });

  it('interrupção guarda o restante e resumePaused continua do ponto', async () => {
    const tocados: Array<Record<string, unknown>> = [];
    const { queue } = harness({
      maxConcurrent: 1,
      synthesize: async () => { await wait(50); return blob(); },
      onChunkPlayed: (e: { at: number }) => tocados.push(e),
    });
    queue.enqueue(['Um.', 'Dois.', 'Três.', 'Quatro.'], { turnId: 't' });
    await wait(20);
    const guardados = queue.pauseForInterruption();
    expect(guardados.length).toBeGreaterThan(0);
    expect(queue.debug.queueLength).toBe(0);
    const antes = tocados.length;
    expect(queue.resumePaused()).toBeGreaterThan(0);
    await wait(320);
    expect(tocados.length).toBeGreaterThan(antes);
    expect(queue.debug.paused).toHaveLength(0);
  });

  it('estado de carregamento só aparece se a espera passar do limite', async () => {
    const eventos: Array<{ ativo: boolean }> = [];
    const { queue } = harness({
      maxConcurrent: 1, loadingThresholdMs: 25,
      synthesize: async () => { await wait(60); return blob(); },
      onBuffering: (e: { ativo: boolean }) => eventos.push(e),
    });
    queue.enqueue(['Trecho lento.'], { turnId: 't' });
    await wait(170);
    expect(eventos.filter((e) => e.ativo)).toHaveLength(1);
    expect(eventos.filter((e) => !e.ativo)).toHaveLength(1);
  });

  it('dividirTrecho quebra ao meio sem cortar palavras', () => {
    const texto = 'Primeira parte bem longa da explicação sobre Python e listas, segunda parte também longa.';
    const partes = dividirTrecho(texto);
    expect(partes).toHaveLength(2);
    expect(partes.join(' ')).toBe(texto);
    expect(dividirTrecho('curto')).toEqual(['curto']);
  });
});
