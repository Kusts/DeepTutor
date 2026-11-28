import { describe, expect, it, vi } from 'vitest';

import {
  AUDIO_CONSTRAINTS,
  AudioCapture,
  type CaptureContext,
  type CaptureProcessor,
  type WorkletMessageHandler,
} from '@/features/classroom/voice/transport/audio-capture';
import {
  currentAudioSessionType,
  isIOS,
  prepareLegacyIosAudio,
  setAudioSessionType,
  type DocumentRef,
  type NavigatorLike,
} from '@/features/classroom/voice/transport/audio-session';

function fakeTrack() {
  const listeners = new Map<string, () => void>();
  return {
    kind: 'audio',
    readyState: 'live',
    muted: false,
    enabled: true,
    addEventListener(type: string, fn: () => void) { listeners.set(type, fn); },
    removeEventListener(type: string) { listeners.delete(type); },
    stop() { this.readyState = 'ended'; },
    fire(type: string) { listeners.get(type)?.(); },
  };
}

function fakeContext({ sampleRate = 48000, failWorklet = false } = {}) {
  const calls: string[] = [];
  const listeners: Record<string, () => void> = {};
  const ctx = {
    state: 'suspended',
    sampleRate,
    destination: { name: 'destination' },
    calls,
    listeners,
    audioWorklet: {
      addModule: async () => { calls.push('addModule'); if (failWorklet) throw new Error('wasm'); },
    },
    resume() { calls.push('resume'); this.state = 'running'; return Promise.resolve(); },
    addEventListener(type: string, fn: () => void) { listeners[type] = fn; },
    removeEventListener(type: string) { delete listeners[type]; },
    createMediaStreamSource() {
      calls.push('createMediaStreamSource');
      return { connect(dest: { name?: string; kind?: string }) { calls.push(`source->${dest.kind ?? dest.name}`); }, disconnect() {} };
    },
    createAnalyser() {
      calls.push('createAnalyser');
      return {
        kind: 'analyser', fftSize: 0, smoothingTimeConstant: 0,
        connect(dest: { name?: string; kind?: string }) { calls.push(`analyser->${dest.kind ?? dest.name}`); },
        disconnect() {}, getFloatTimeDomainData() {},
      };
    },
    createGain() {
      calls.push('createGain');
      return {
        kind: 'gain', gain: { value: 1 },
        connect(dest: { name?: string; kind?: string }) { calls.push(`gain->${dest.kind ?? dest.name}`); },
        disconnect() {},
      };
    },
    createScriptProcessor() {
      calls.push('createScriptProcessor');
      return {
        kind: 'scriptprocessor', onaudioprocess: null,
        connect(dest: { name?: string; kind?: string }) { calls.push(`processor->${dest.kind ?? dest.name}`); },
        disconnect() {},
      };
    },
    close() { calls.push('close'); this.state = 'closed'; return Promise.resolve(); },
  };
  return ctx;
}

class FakeWorkletNode {
  kind = 'audioworklet';
  port = { onmessage: null as unknown, postMessage: vi.fn() };
  constructor(
    readonly ctx: ReturnType<typeof fakeContext>,
    readonly name: string,
    readonly options: unknown,
  ) {
    ctx.calls.push('newWorkletNode');
  }
  connect(dest: { name?: string; kind?: string }) { this.ctx.calls.push(`audioworklet->${dest.kind ?? dest.name}`); }
  disconnect() {}
}

function harness(opts: { sampleRate?: number; failWorklet?: boolean; noWorkletCtor?: boolean } = {}) {
  const ctx = fakeContext(opts);
  const track = fakeTrack();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const ordem: string[] = [];
  const getMedia = async (constraints: MediaStreamConstraints) => {
    ordem.push(`getUserMedia:${ctx.calls.includes('resume') ? 'contexto-antes' : 'contexto-depois'}`);
    void constraints;
    return stream;
  };
  function FakeContextCtor() { ordem.push('new AudioContext'); return ctx; }
  const capture = new AudioCapture({
    AudioContextCtor: FakeContextCtor as unknown as (new () => CaptureContext),
    getMedia: getMedia as unknown as NonNullable<ConstructorParameters<typeof AudioCapture>[0]>['getMedia'],
    AudioWorkletNodeCtor: opts.noWorkletCtor
      ? undefined
      : (FakeWorkletNode as unknown as NonNullable<ConstructorParameters<typeof AudioCapture>[0]>['AudioWorkletNodeCtor']),
    createWorkletUrl: () => 'blob:fake-worklet',
  });
  return { ctx, track, stream, ordem, capture };
}

describe('captura de microfone', () => {
  it('nasce no gesto: contexto antes do getUserMedia, constraints e grafo até destination', async () => {
    const { capture, ctx, ordem } = harness();
    const analyser = await capture.start();
    expect(analyser).toBeTruthy();
    expect(ordem[0]).toBe('new AudioContext');
    expect(ctx.calls[0]).toBe('resume');
    expect(ordem[1]).toMatch(/contexto-antes/);
    expect(AUDIO_CONSTRAINTS.audio).toMatchObject({
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
    });
    expect(ctx.calls).toContain('addModule');
    expect(capture.nodeKind).toBe('audioworklet');
    expect(ctx.calls.filter((c) => c.includes('->'))).toEqual([
      'source->analyser', 'analyser->audioworklet', 'audioworklet->gain', 'gain->destination',
    ]);
    capture.stop();
  });

  it('ganho silencioso e fallback ScriptProcessor quando o worklet falha', async () => {
    const { capture, ctx } = harness({ failWorklet: true });
    await capture.start();
    expect(capture.nodeKind).toBe('scriptprocessor');
    expect(ctx.calls).toContain('processor->gain');
    expect(ctx.calls).toContain('gain->destination');
    capture.stop();
  });

  it('sem construtor de AudioWorklet cai para ScriptProcessor sem quebrar', async () => {
    const { capture } = harness({ noWorkletCtor: true });
    await capture.start();
    expect(capture.nodeKind).toBe('scriptprocessor');
    capture.stop();
  });

  it('mute/unmute/ended e contexto interrupted aparecem na saúde', async () => {
    const { capture, ctx, track } = harness();
    await capture.start();
    expect(capture.health).toEqual({ ok: true, reason: null });

    track.muted = true; track.fire('mute');
    expect(capture.health).toEqual({ ok: false, reason: 'track_muted' });
    expect(capture.debug.trackMuted).toBe(true);
    track.muted = false; track.fire('unmute');
    expect(capture.health.ok).toBe(true);

    ctx.state = 'interrupted'; ctx.listeners.statechange();
    expect(capture.health.reason).toBe('contexto_interrupted');
    ctx.state = 'running'; ctx.listeners.statechange();
    expect(capture.health.ok).toBe(true);

    track.readyState = 'ended'; track.fire('ended');
    expect(capture.health.reason).toBe('track_encerrado');
    capture.stop();
  });

  it('conta quadros/pico e registra ausência de sinal explicitamente', async () => {
    const { capture } = harness();
    await capture.start();
    const handler = capture.node?.port?.onmessage as WorkletMessageHandler;
    handler({ data: new Float32Array([0.1, -0.2, 0.3]) });
    expect(capture.debug.framesRecebidas).toBe(3);
    expect(capture.chunks).toHaveLength(1);
    expect(capture.debug.maxRms).toBeGreaterThan(0.2);
    capture.markNoSignal({ lastRms: 0 });
    expect(capture.health.reason).toBe('sem_sinal');
    capture.stop();
  });

  it('finaliza clipe WAV RIFF a 16 kHz com pre-roll e padding', async () => {
    const { capture } = harness({ sampleRate: 48000 });
    await capture.start();
    for (let i = 0; i < 10; i += 1) {
      const handler = capture.node?.port?.onmessage as WorkletMessageHandler;
      handler({ data: new Float32Array(2048).fill(0.2) });
    }
    capture.resetRecording();
    expect(capture.chunks.length).toBeGreaterThanOrEqual(1);
    const clip = await capture.finalizeClip();
    expect(clip).not.toBeNull();
    const bytes = new Uint8Array(await clip!.blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)).toBe(16000);
    expect(clip!.mimeType).toBe('audio/wav');
    expect(clip!.preRollMs).toBe(300);
    expect(clip!.paddingMs).toBe(250);
    expect(clip!.preRollSamples).toBeGreaterThan(0);
    expect(clip!.bytes).toBeGreaterThan(0);
    expect(capture.debug.sampleRateNativo).toBe(48000);
    expect(capture.debug.sampleRateUsado).toBe(16000);
    capture.stop();
  });
});

describe('AudioSession (iOS)', () => {
  it('usa play-and-record na captura e playback somente na saída', () => {
    const nav = { audioSession: { type: 'auto' } } as unknown as NavigatorLike;
    expect(setAudioSessionType('play-and-record', { nav }).type).toBe('play-and-record');
    expect(currentAudioSessionType(nav)).toBe('play-and-record');
    expect(setAudioSessionType('playback', { nav }).requested).toBe('playback');
  });

  it('sem API não altera nada e falha ao definir é registrada sem lançar', () => {
    expect(setAudioSessionType('playback', { nav: {} })).toEqual({
      supported: false, type: null, requested: 'playback', error: null,
    });
    const erros: Array<{ message: string }> = [];
    const nav = {
      audioSession: {
        set type(_value: string) { throw new Error('bloqueado'); },
        get type() { return 'auto'; },
      },
    } as unknown as NavigatorLike;
    const result = setAudioSessionType('playback', { nav, onError: (e) => erros.push(e) });
    expect(result.supported).toBe(true);
    expect(result.error?.message).toBe('bloqueado');
    expect(erros).toHaveLength(1);
  });

  it('detecta iPhone e iPad em modo desktop', () => {
    expect(isIOS({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)' })).toBe(true);
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false);
  });

  it('fallback legado cria áudio local apenas em iOS sem AudioSession', () => {
    const element = {
      loop: false, preload: '', src: '', hidden: false,
      setAttribute() {}, play() { return Promise.resolve(); }, pause() {},
      currentTime: 0, remove() { this.removido = true; }, removido: false,
    };
    const criados: typeof element[] = [];
    const doc = { body: { append(el: typeof element) { criados.push(el); } }, createElement: () => element };
    const nav = { userAgent: 'iPhone', maxTouchPoints: 1 };
    const handle = prepareLegacyIosAudio({
      documentRef: doc as unknown as DocumentRef,
      nav,
      createObjectURL: () => 'blob:silencio',
      revokeObjectURL: () => {},
    });
    expect(handle).not.toBeNull();
    expect(element.loop).toBe(true);
    expect(element.src).toBe('blob:silencio');
    expect(criados).toHaveLength(1);
    handle!.stop();
    expect(element.removido).toBe(true);
    expect(prepareLegacyIosAudio({
      documentRef: doc as unknown as DocumentRef,
      nav: { userAgent: 'iPhone', audioSession: { type: 'auto' } },
    })).toBeNull();
  });
});
