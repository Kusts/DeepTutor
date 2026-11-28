import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIO_ERROR,
  WebAudioOutput,
  type OutputContext,
} from '@/features/classroom/voice/transport/audio-output';

const blob = () => new Blob([new Uint8Array(16)], { type: 'audio/mpeg' });

function ctor(ctx: ReturnType<typeof fakeContext>): new () => OutputContext {
  return function FakeContextCtor() { return ctx; } as unknown as new () => OutputContext;
}

function fakeContext({ staySuspended = false, failDecode = false } = {}) {
  const ramps: number[] = [];
  const ctx = {
    state: 'suspended',
    sampleRate: 48000,
    destination: {},
    currentTime: 0,
    resume() { if (!staySuspended) this.state = 'running'; return Promise.resolve(); },
    createBuffer(_channels: number, length: number) { return { length, duration: length / 48000 }; },
    createBufferSource() {
      return {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        onended: null,
        connect() {}, disconnect() {},
        start() { ctx.starts += 1; }, stop() { ctx.stops += 1; },
      };
    },
    createGain() {
      return {
        gain: {
          value: 1,
          setValueAtTime() {},
          linearRampToValueAtTime(value: number) { ramps.push(value); },
        },
        connect() {}, disconnect() {},
      };
    },
    createAnalyser() {
      return {
        fftSize: 256,
        connect() {},
        getFloatTimeDomainData(buffer: Float32Array) { buffer.fill(0.25); },
      };
    },
    decodeAudioData() {
      if (failDecode) return Promise.reject(new Error('mp3 inválido'));
      return Promise.resolve({ duration: 1 });
    },
    starts: 0,
    stops: 0,
    ramps,
  };
  return ctx;
}

function harness(options: { staySuspended?: boolean; failDecode?: boolean } = {}) {
  const ctx = fakeContext(options);
  const blocked: Array<{ reason: string }> = [];
  const out = new WebAudioOutput({
    AudioContextCtor: ctor(ctx),
    onBlocked: (e) => blocked.push(e),
    fetchImpl: async () => ({ ok: true, blob: async () => blob() }),
  });
  return { ctx, out, blocked };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saída de áudio', () => {
  it('unlock cria um contexto único, resume e toca buffer silencioso no gesto', async () => {
    const { ctx, out, blocked } = harness();
    expect(await out.unlock()).toBe(true);
    expect(ctx.state).toBe('running');
    expect(out.debug.silentPlays).toBe(1);
    expect(out.debug.unlocked).toBe(true);
    expect(blocked).toHaveLength(0);
    await out.unlock();
    expect(out.debug.silentPlays).toBe(2);
    expect(out.debug.contextState).toBe('running');
  });

  it('toca por AudioBufferSource e para na interrupção sem fim natural', async () => {
    const { ctx, out } = harness();
    await out.unlock();
    let played = 0;
    let ended = 0;
    const player = out.createPlayer('blob:fake');
    player.onplaying = () => { played += 1; };
    player.onended = () => { ended += 1; };
    await player.play();
    expect(played).toBe(1);
    expect(out.debug.started).toBe(1);
    expect(ctx.starts).toBe(2); // 1 silencioso no unlock + 1 chunk TTS
    out.stop();
    expect(ctx.stops).toBe(1);
    expect(out.debug.stopped).toBe(1);
    expect(ended).toBe(0);
  });

  it('expõe o analisador de monitor para o lip-sync da fatia 3B', async () => {
    const { out } = harness();
    await out.unlock();
    expect(out.monitor).not.toBeNull();
    expect(out.sharedContext).toBe(out.context);
    expect(out.medirNivelSaida()).toBeCloseTo(0.25, 5);
  });

  it('emenda com fade nas bordas e taxa de reprodução limitada', async () => {
    const { ctx, out } = harness();
    ctx.createBufferSource = () => ({
      buffer: null as unknown, playbackRate: { value: 1 }, onended: null,
      connect() {}, disconnect() {}, start() { ctx.starts += 1; }, stop() { ctx.stops += 1; },
    });
    const aged = new WebAudioOutput({
      AudioContextCtor: ctor(ctx),
      fetchImpl: async () => ({ ok: true, blob: async () => blob() }),
      fadeInMs: 20, fadeOutMs: 40, playbackRate: 1.1,
    });
    await aged.unlock();
    expect(aged.debug.playbackRate).toBe(1.1);
    expect(aged.setPlaybackRate(2)).toBe(1.2);
    expect(aged.setPlaybackRate(0.1)).toBe(0.9);
    await aged.createPlayer('blob:fake').play();
    expect(ctx.ramps).toEqual([1, 0]);
  });

  it('autoplay bloqueado gera erro curto e sinaliza a interface', async () => {
    const { out, blocked } = harness({ staySuspended: true });
    expect(await out.unlock()).toBe(false);
    expect(blocked[0]?.reason).toBe(AUDIO_ERROR.AUTOPLAY_BLOCKED);
    const player = out.createPlayer('blob:fake');
    await expect(player.play()).rejects.toMatchObject({ code: AUDIO_ERROR.AUTOPLAY_BLOCKED });
    expect(out.debug.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'autoplay' }),
    ]));
  });

  it('falha de decode é registrada com código próprio', async () => {
    const { out } = harness({ failDecode: true });
    await out.unlock();
    await expect(out.createPlayer('blob:fake').play()).rejects.toMatchObject({
      code: AUDIO_ERROR.DECODE_FAILED,
    });
  });

  it('fetch de blob é chamado com o contexto global (regressão: Illegal invocation)', async () => {
    const ctx = fakeContext();
    let contextoOk = false;
    const out = new WebAudioOutput({
      AudioContextCtor: ctor(ctx),
      fetchImpl: function () {
        contextoOk = this === globalThis;
        return Promise.resolve({ ok: true, blob: async () => blob() });
      },
    });
    await out.unlock();
    await out.createPlayer('blob:fake').play();
    expect(contextoOk).toBe(true);
    expect(out.debug.started).toBe(1);
  });

  it('sem Web Audio usa <audio> e continua destravando', async () => {
    let tocou = 0;
    class FakeAudio {
      src: string;
      preload = '';
      attrs: string[] = [];
      currentTime = 0;
      readyState = 0;
      onplaying: (() => void) | null = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(src: string) { this.src = src; tocou += 1; }
      setAttribute(k: string) { this.attrs.push(k); }
      addEventListener() {}
      play() { this.onplaying?.(); return Promise.resolve(); }
      pause() { this.pausado = true; }
      pausado = false;
    }
    vi.stubGlobal('Audio', FakeAudio);
    const out = new WebAudioOutput({ AudioContextCtor: null });
    expect(await out.unlock()).toBe(true);
    expect(out.debug.contextState).toBe('indisponivel');
    await out.createPlayer('blob:sem-webaudio').play();
    expect(tocou).toBe(1);
    expect(out.debug.started).toBe(1);
    out.stop();
    expect(out.currentHtml).toBeNull();
  });

  it('mudo zera o ganho sem parar a reprodução', async () => {
    const { out } = harness();
    await out.unlock();
    await out.createPlayer('blob:fake').play();
    expect(out.setMuted(true)).toBe(true);
    expect(out.currentGain?.gain.value).toBe(0);
    expect(out.debug.started).toBe(1);
  });

  it('nunca chama sintetizador de fala do avatar neste caminho', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'features/classroom/voice/transport/audio-output.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/createSpeech/);
  });
});
