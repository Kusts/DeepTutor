import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ChatMessage {
  id?: number;
  role: string;
  content: string;
  rawContent?: string;
}

const fixture = vi.hoisted(() => ({
  chat: {
    sendMessage: vi.fn(),
    cancelStreamingTurn: vi.fn(),
    state: { messages: [] as ChatMessage[], isStreaming: false },
  },
}));

vi.mock("@/features/chat/ChatStateAdapter", () => ({
  useChatStateAdapter: () => fixture.chat,
}));

import { EventBus } from "@/features/classroom/voice/model/event-bus";
import type { MouthController, MouthSnapshot } from "@/features/classroom/voice/model/mouth-controller";
import { SttRateLimiter } from "@/features/classroom/voice/model/stt-rate-limiter";
import type { EnergyVadOptions } from "@/features/classroom/voice/model/vad";
import type { AudioPlayerLike, NodeHandler } from "@/features/classroom/voice/transport/audio-output";
import type { TtsQueueOptions } from "@/features/classroom/voice/transport/tts-queue";
import {
  useVoiceSession,
  type VoiceCaptureLike,
  type VoiceClipLike,
  type VoiceOutputLike,
  type VoiceSessionDeps,
  type VoiceTtsLike,
  type VoiceVadLike,
} from "@/features/classroom/voice/useVoiceSession";

class FakeOutput implements VoiceOutputLike {
  monitor = null;
  sharedContext = { fake: "context" };
  state = "running";
  unlocked = false;
  stopped = 0;
  players = 0;

  async unlock(): Promise<boolean> {
    this.unlocked = true;
    return true;
  }

  stop(): number | null {
    this.stopped += 1;
    return 0;
  }

  createPlayer(url: string): AudioPlayerLike {
    this.players += 1;
    const el: AudioPlayerLike = {
      onplaying: null as NodeHandler,
      onended: null as NodeHandler,
      onerror: null as NodeHandler,
      preload: "auto",
      src: url,
      currentTime: 0,
      play() {
        queueMicrotask(() => el.onended?.());
      },
      pause() {},
      load() {},
      removeAttribute() {},
    };
    return el;
  }
}

class FakeCapture implements VoiceCaptureLike {
  analyser = { fftSize: 256, getFloatTimeDomainData: () => {} };
  started = 0;
  resets = 0;
  finalized = 0;
  stopped = 0;

  constructor(readonly clip: VoiceClipLike | null) {}

  async start() {
    this.started += 1;
    return this.analyser;
  }

  resetRecording(): void {
    this.resets += 1;
  }

  async finalizeClip(): Promise<VoiceClipLike | null> {
    this.finalized += 1;
    return this.clip;
  }

  stop(): void {
    this.stopped += 1;
  }
}

class FakeVad implements VoiceVadLike {
  static last: FakeVad | null = null;
  started = 0;
  stops = 0;
  playbackActive = false;
  playbackCalls: boolean[] = [];

  constructor(readonly options: EnergyVadOptions) {
    FakeVad.last = this;
  }

  start(): void {
    this.started += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  setPlaybackActive(active: boolean): void {
    this.playbackActive = active;
    this.playbackCalls.push(active);
  }
}

class FakeTts implements VoiceTtsLike {
  static last: FakeTts | null = null;
  generation = 0;
  stops = 0;
  enqueued: Array<{ chunks: string[]; turnId: string | null; generation: number }> = [];

  constructor(readonly options: TtsQueueOptions) {
    FakeTts.last = this;
  }

  enqueue(
    chunks: string[] | string,
    opts: { turnId: string | null; generation?: number },
  ): void {
    this.enqueued.push({
      chunks: Array.isArray(chunks) ? chunks : [chunks],
      turnId: opts.turnId,
      generation: opts.generation ?? this.generation,
    });
  }

  stop(): void {
    this.stops += 1;
    this.generation += 1;
  }
}

class FakeMouth implements MouthController {
  ticks = 0;
  forced: string[] = [];
  releases = 0;
  disposed = 0;

  tick(): MouthSnapshot {
    this.ticks += 1;
    return {
      mouthOpen: 0.5,
      vowel: 0.2,
      open: true,
      reason: null,
      timestamp: null,
      frames: this.ticks,
    };
  }

  forceClose(motivo?: string | null): MouthSnapshot {
    this.forced.push(motivo ?? "");
    return this.snapshot();
  }

  release(): MouthSnapshot {
    this.releases += 1;
    return this.snapshot();
  }

  snapshot(): MouthSnapshot {
    return {
      mouthOpen: 0,
      vowel: 0,
      open: false,
      reason: null,
      timestamp: null,
      frames: 0,
    };
  }

  dispose(): void {
    this.disposed += 1;
  }
}

function makeHarness({
  transcricao = "Olá doutor, explora a derivada.",
  clip = true,
  slot = true,
  erroTranscricao = null,
}: {
  transcricao?: string;
  clip?: boolean;
  slot?: boolean;
  erroTranscricao?: Error | null;
} = {}) {
  const output = new FakeOutput();
  const audioClip: VoiceClipLike | null = clip
    ? {
        blob: new Blob(["wav"], { type: "audio/wav" }),
        durationMs: 1200,
        mimeType: "audio/wav",
        bytes: 3,
      }
    : null;
  const capture = new FakeCapture(audioClip);
  const transcribe = vi.fn(async () => {
    if (erroTranscricao) throw erroTranscricao;
    return transcricao;
  });
  const limiter = {
    waitForSlot: vi.fn(async () => slot),
    registerError: vi.fn(() => 6000),
  };
  const bus = new EventBus();
  const setSessionType = vi.fn(
    (type: "auto" | "playback" | "play-and-record") => ({
      supported: false,
      type: null,
      requested: type,
      error: null,
    }),
  );
  const mouth = new FakeMouth();
  const deps: VoiceSessionDeps = {
    bus,
    now: () => 1000,
    createOutput: () => output,
    createCapture: () => capture,
    createVad: (options) => new FakeVad(options),
    createTts: (options) => new FakeTts(options),
    createLimiter: () => limiter,
    createMouth: () => mouth,
    transcribe,
    setSessionType,
  };
  const types: string[] = [];
  bus.on("*", (event) => types.push(event.type));
  return { deps, output, capture, transcribe, limiter, bus, mouth, setSessionType, types };
}

async function falar(h: ReturnType<typeof makeHarness>, result: { current: { start(): Promise<void> } }) {
  await act(async () => {
    await result.current.start();
  });
  const vad = FakeVad.last;
  expect(vad).not.toBeNull();
  await act(async () => {
    vad?.options.onSpeechStart?.({ at: 1000, rms: 0.2, playbackActive: false });
    vad?.options.onSpeechEnd?.({ at: 1500, reason: "hangover", durationMs: 1200 });
  });
  await waitFor(() => expect(h.capture.finalized).toBe(1));
}

beforeEach(() => {
  fixture.chat.sendMessage.mockReset();
  fixture.chat.cancelStreamingTurn.mockReset();
  fixture.chat.state.messages = [];
  fixture.chat.state.isStreaming = false;
  FakeVad.last = null;
  FakeTts.last = null;
});

describe("useVoiceSession", () => {
  it("fala → transcrição corrigida → sendMessage, com contexto e sessão compartilhados", async () => {
    const h = makeHarness();
    const { result } = renderHook(() => useVoiceSession(h.deps));

    await falar(h, result);

    await waitFor(() =>
      expect(fixture.chat.sendMessage).toHaveBeenCalledWith(
        "Olá tutor, explora a derivada.",
      ),
    );
    expect(h.output.unlocked).toBe(true);
    expect(h.capture.started).toBe(1);
    expect(h.capture.resets).toBe(1);
    expect(h.setSessionType).toHaveBeenCalledWith("playback");
    expect(h.setSessionType).toHaveBeenCalledWith("play-and-record");
    expect(h.limiter.waitForSlot).toHaveBeenCalledTimes(1);
    expect(h.types).toEqual(
      expect.arrayContaining(["speech-start", "speech-end", "clip", "transcription"]),
    );
    // Nenhum texto bruto é publicado no barramento.
    expect(h.types).not.toContain("log");
    expect(result.current.metrics.transcricoes).toBe(1);
  });

  it("resposta final → TTS uma única vez, player da saída e anti-eco ligado", async () => {
    const h = makeHarness();
    const { result, rerender } = renderHook(() => useVoiceSession(h.deps));
    await falar(h, result);
    await waitFor(() => expect(fixture.chat.sendMessage).toHaveBeenCalled());

    fixture.chat.state.isStreaming = true;
    fixture.chat.state.messages = [{ id: 1, role: "user", content: "pergunta" }];
    rerender();
    expect(FakeTts.last).toBeNull();

    fixture.chat.state.isStreaming = false;
    fixture.chat.state.messages = [
      { id: 1, role: "user", content: "pergunta" },
      {
        id: 2,
        role: "assistant",
        content: "**Derivada** mede a taxa de variação. Ela é usada em física.",
        rawContent: "Derivada mede a taxa de variação. Ela é usada em física.",
      },
    ];
    await act(async () => {
      rerender();
    });

    const tts = FakeTts.last;
    expect(tts).not.toBeNull();
    expect(tts?.enqueued).toHaveLength(1);
    expect(tts?.enqueued[0]?.turnId).toBe("2");
    expect(tts?.enqueued[0]?.chunks.length).toBeGreaterThan(0);
    expect(result.current.phase).toBe("explaining");
    expect(FakeVad.last?.playbackCalls).toContain(true);
    expect(h.types).toContain("phase");

    // Um re-render com o mesmo conteúdo não sintetiza de novo.
    fixture.chat.state.messages = [...fixture.chat.state.messages];
    rerender();
    expect(tts?.enqueued).toHaveLength(1);

    // O player vem do WebAudioOutput compartilhado.
    h.output.players = 0;
    tts?.options.playerFactory?.("blob:fake");
    expect(h.output.players).toBe(1);
    expect(result.current.getAmplitude()).toEqual({ mouthOpen: 0.5, vowel: 0.2 });
  });

  it("barge-in cancela o turno, para saída/TTS, incrementa geração e trava a boca", async () => {
    const h = makeHarness();
    const { result, rerender } = renderHook(() => useVoiceSession(h.deps));
    await falar(h, result);
    await waitFor(() => expect(fixture.chat.sendMessage).toHaveBeenCalled());
    fixture.chat.state.isStreaming = false;
    fixture.chat.state.messages = [
      {
        id: 9,
        role: "assistant",
        content: "Resposta longa o bastante para falar.",
        rawContent: "Resposta longa o bastante para falar.",
      },
    ];
    await act(async () => {
      rerender();
    });
    await waitFor(() => expect(result.current.phase).toBe("explaining"));

    const tts = FakeTts.last;
    expect(tts).not.toBeNull();
    const generationAntes = tts?.generation ?? 0;

    const stopsOutput = h.output.stopped;
    act(() => result.current.interrupt());

    expect(fixture.chat.cancelStreamingTurn).toHaveBeenCalled();
    expect(h.output.stopped).toBe(stopsOutput + 1);
    expect(tts?.stops).toBe(1);
    expect(tts?.generation).toBe(generationAntes + 1);
    expect(FakeVad.last?.playbackActive).toBe(false);
    expect(h.mouth.forced).toContain("barge-in");
    expect(result.current.phase).toBe("interrupted");
    expect(h.types).toContain("interrupted");
  });

  it("sem slot de STT ou alucinação: descarta sem turno novo", async () => {
    const bloqueado = makeHarness({ slot: false });
    const a = renderHook(() => useVoiceSession(bloqueado.deps));
    await falar(bloqueado, a.result);
    await waitFor(() => expect(bloqueado.types).toContain("transcricao-descartada"));
    expect(fixture.chat.sendMessage).not.toHaveBeenCalled();

    const alucinacao = makeHarness({ transcricao: "Obrigados por assistir." });
    const b = renderHook(() => useVoiceSession(alucinacao.deps));
    await falar(alucinacao, b.result);
    await waitFor(() => expect(alucinacao.types).toContain("transcricao-descartada"));
    expect(fixture.chat.sendMessage).not.toHaveBeenCalled();
    expect(b.result.current.metrics.descartesTranscricao).toBe(1);
  });

  it("429 de STT devolve o slot e aplica cooldown sem trocar a fase", async () => {
    const h = makeHarness({
      erroTranscricao: new Error("STT falhou (HTTP 429): Please try again in 6s"),
    });
    const real = new SttRateLimiter({ now: () => 1000 });
    h.deps.createLimiter = () => real;
    const { result } = renderHook(() => useVoiceSession(h.deps));

    await falar(h, result);

    await waitFor(() => expect(real.debug.slotsEmJanela).toBe(0));
    expect(real.debug.cooldownMs).toBe(6000);
    expect(h.types).toEqual(expect.arrayContaining(["aviso", "metric"]));
    expect(result.current.phase).toBe("thinking");
    expect(fixture.chat.sendMessage).not.toHaveBeenCalled();
  });

  it("não fala a resposta antiga presente no envio; fala a nova exatamente uma vez", async () => {
    const antiga = {
      id: 1,
      role: "assistant",
      content: "Resposta antiga",
      rawContent: "Resposta antiga",
    };
    fixture.chat.state.messages = [antiga];
    fixture.chat.state.isStreaming = false;
    const h = makeHarness();
    const { result, rerender } = renderHook(() => useVoiceSession(h.deps));

    await act(async () => {
      rerender();
    });
    expect(FakeTts.last).toBeNull();

    await falar(h, result);
    await waitFor(() => expect(fixture.chat.sendMessage).toHaveBeenCalled());
    // O efeito pode rodar antes do novo stream: a resposta antiga não é falada.
    await act(async () => {
      rerender();
    });
    expect(FakeTts.last).toBeNull();

    fixture.chat.state.messages = [
      antiga,
      {
        id: 2,
        role: "assistant",
        content: "Nova resposta do tutor.",
        rawContent: "Nova resposta do tutor.",
      },
    ];
    await act(async () => {
      rerender();
    });
    await waitFor(() => expect(FakeTts.last?.enqueued).toHaveLength(1));

    fixture.chat.state.messages = [...fixture.chat.state.messages];
    rerender();
    expect(FakeTts.last?.enqueued).toHaveLength(1);
  });
});
