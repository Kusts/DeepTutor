"use client";

// Integração da fatia 3B: liga o classroom ao runtime de voz existente SEM
// segundo agente LLM. O áudio da resposta vem do TTS nativo (/api/voice/tts)
// tocado pelo mesmo WebAudioOutput; nenhum createSpeech é chamado.
//
// O chat é o dono do turno: a fala vira sendMessage(text) e a resposta final
// (isStreaming === false) é que vira TTS. Toda dependência de áudio/rede pode
// ser injetada para testes — nenhum microfone real é necessário.

import { useCallback, useEffect, useRef, useState } from "react";

import { useChatStateAdapter } from "@/features/chat/ChatStateAdapter";

import type { AvatarPhase } from "../livliv/AvatarRenderer";
import type { VoiceAmplitude } from "../AvatarStage";
import { EventBus } from "./model/event-bus";
import { isContinuation } from "./model/hangover";
import {
  createMouthController,
  type MouthAnalyser,
  type MouthController,
  type MouthControllerOptions,
} from "./model/mouth-controller";
import { avatarPhaseFor, type VoiceSignal } from "./model/phase-map";
import { speakableGroups } from "./model/speakable-text";
import { SttRateLimiter } from "./model/stt-rate-limiter";
import {
  classifyTranscription,
  corrigirTranscricao,
} from "./model/transcription-filter";
import { EnergyVad, type EnergyVadOptions } from "./model/vad";
import { AudioCapture, type AudioCaptureOptions } from "./transport/audio-capture";
import { setAudioSessionType } from "./transport/audio-session";
import {
  WebAudioOutput,
  type AudioOutputOptions,
  type AudioPlayerLike,
  type NodeHandler,
} from "./transport/audio-output";
import { TtsQueue, type TtsQueueOptions, type Synth } from "./transport/tts-queue";
import { transcribeAudio } from "./transport/voice-clients";

/** Subconjunto do adaptador de chat usado pela sala. Nenhuma outra API é tocada. */
interface VoiceChatMessage {
  readonly id?: number | string;
  readonly role?: string;
  readonly content?: string;
  readonly rawContent?: string;
}

interface VoiceChatSubset {
  sendMessage?: (content: string) => void;
  cancelStreamingTurn?: () => void;
  state?: {
    messages?: readonly VoiceChatMessage[];
    isStreaming?: boolean;
  };
}

/** Superfícies mínimas que o hook consome — permitem fakes sem casts nos testes. */
export interface VoiceOutputLike {
  readonly monitor?: MouthAnalyser | null;
  readonly sharedContext: unknown;
  readonly state: string;
  readonly unlocked: boolean;
  unlock(): Promise<boolean>;
  stop(): number | null;
  createPlayer(url: string): AudioPlayerLike;
}

export interface VoiceClipLike {
  blob: Blob;
  durationMs: number;
  mimeType: string;
  bytes: number;
  usedFallback?: boolean;
}

export interface VoiceCaptureLike {
  start(): Promise<EnergyVadOptions["analyser"]>;
  resetRecording(): void;
  finalizeClip(): Promise<VoiceClipLike | null>;
  stop(): void;
}

export interface VoiceVadLike {
  start(): void;
  stop(): void;
  setPlaybackActive(active: boolean): void;
}

export interface VoiceTtsLike {
  readonly generation: number;
  enqueue(
    chunks: string[] | string,
    options: { turnId: string | null; generation?: number },
  ): void;
  stop(): void;
}

export interface VoiceLimiterLike {
  waitForSlot(): Promise<boolean>;
  /** Devolve o slot consumido e aplica o retry-after/backoff do 429. */
  registerError(error: unknown): number;
}

export interface VoiceSessionDeps {
  bus?: EventBus;
  now?: () => number;
  createOutput?: (options: AudioOutputOptions) => VoiceOutputLike;
  createCapture?: (options: AudioCaptureOptions) => VoiceCaptureLike;
  createVad?: (options: EnergyVadOptions) => VoiceVadLike;
  createTts?: (options: TtsQueueOptions) => VoiceTtsLike;
  createLimiter?: () => VoiceLimiterLike;
  createMouth?: (options: MouthControllerOptions) => MouthController;
  transcribe?: typeof transcribeAudio;
  synthesize?: Synth | null;
  setSessionType?: typeof setAudioSessionType;
}

export interface VoiceMetrics {
  transcricoes: number;
  descartesTranscricao: number;
  descartesVad: number;
  turnosFalados: number;
  interrupcoes: number;
  erros: number;
}

export interface VoiceSession {
  phase: AvatarPhase;
  start: () => Promise<void>;
  stop: () => void;
  interrupt: () => void;
  toggleMic: () => void;
  level: number;
  getAmplitude: () => VoiceAmplitude;
  metrics: VoiceMetrics;
  bus: EventBus;
}

const METRICAS_ZERO: VoiceMetrics = Object.freeze({
  transcricoes: 0,
  descartesTranscricao: 0,
  descartesVad: 0,
  turnosFalados: 0,
  interrupcoes: 0,
  erros: 0,
});

/** Player mudo usado apenas se a saída tiver sido liberada antes do TTS chegar. */
function silentPlayer(url: string): AudioPlayerLike {
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

/** Chave estável de uma resposta do assistente, usada para não re-falar. */
function answerKey(message: VoiceChatMessage | undefined): string | null {
  if (!message || message.role !== "assistant") return null;
  const markdown = message.rawContent || message.content || "";
  if (!markdown.trim()) return null;
  return `${String(message.id ?? "assistant")}:${markdown.length}`;
}

function lastAnswerKey(messages: readonly VoiceChatMessage[] | undefined): string | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const key = answerKey(messages?.[i]);
    if (key) return key;
  }
  return null;
}

/** O STT nativo sinaliza 429 na mensagem; alguns clientes usam `code`. */
function isRateLimitError(error: unknown): boolean {
  const detail = error as { message?: unknown; code?: unknown } | null;
  const texto = `${String(detail?.message ?? error ?? "")} ${String(detail?.code ?? "")}`;
  return /\b429\b|HTTP_429/i.test(texto);
}

export function useVoiceSession(deps: VoiceSessionDeps = {}): VoiceSession {
  const chat = useChatStateAdapter();
  const chatApi = chat as unknown as VoiceChatSubset;
  const depsRef = useRef(deps);
  const [bus] = useState<EventBus>(() => deps.bus ?? new EventBus());

  // Refs are updated after render (touching `.current` during render is not
  // allowed); the effects declared below therefore see the latest deps.
  useEffect(() => {
    depsRef.current = deps;
  }, [deps]);

  const outputRef = useRef<VoiceOutputLike | null>(null);
  const captureRef = useRef<VoiceCaptureLike | null>(null);
  const vadRef = useRef<VoiceVadLike | null>(null);
  const ttsRef = useRef<VoiceTtsLike | null>(null);
  const mouthRef = useRef<MouthController | null>(null);
  const limiterRef = useRef<VoiceLimiterLike | null>(null);
  const startedRef = useRef(false);
  const awaitingReplyRef = useRef(false);
  const spokenKeyRef = useRef<string | null>(null);
  const baseAnswerKeyRef = useRef<string | null>(null);
  const currentTurnRef = useRef<string | null>(null);
  const lastTextRef = useRef<{ text: string; at: number } | null>(null);
  const lastSpeechEndRef = useRef<number | null>(null);
  const lastLevelAtRef = useRef(0);

  const [phase, setPhase] = useState<AvatarPhase>("idle");
  const [level, setLevel] = useState(0);
  const [metrics, setMetrics] = useState<VoiceMetrics>(METRICAS_ZERO);

  const bump = useCallback((key: keyof VoiceMetrics) => {
    setMetrics((previous) => ({ ...previous, [key]: previous[key] + 1 }));
  }, []);

  const setVoicePhase = useCallback((signal: VoiceSignal, turnId?: string | null) => {
    const next = avatarPhaseFor(signal);
    if (bus) {
      bus.emit("phase", {
        name: next,
        at: (depsRef.current.now ?? Date.now)(),
        turnId: turnId ?? currentTurnRef.current ?? null,
      });
    }
    setPhase(next);
  }, [bus]);

  const ensureMouth = useCallback(() => {
    if (mouthRef.current) return;
    const analyser = outputRef.current?.monitor ?? null;
    const options: MouthControllerOptions = { analyser };
    mouthRef.current = depsRef.current.createMouth
      ? depsRef.current.createMouth(options)
      : createMouthController(options);
  }, []);

  const ensureLimiter = useCallback((): VoiceLimiterLike => {
    if (!limiterRef.current) {
      limiterRef.current = depsRef.current.createLimiter
        ? depsRef.current.createLimiter()
        : new SttRateLimiter();
    }
    return limiterRef.current;
  }, []);

  const ensureTts = useCallback((): VoiceTtsLike => {
    if (ttsRef.current) return ttsRef.current;
    const d = depsRef.current;
    const now = d.now ?? Date.now;
    const options: TtsQueueOptions = {
      synthesize: d.synthesize ?? undefined,
      playerFactory: (url: string) => {
        const output = outputRef.current;
        return output ? output.createPlayer(url) : silentPlayer(url);
      },
      onFirstAudio: (event) => {
        vadRef.current?.setPlaybackActive(true);
        mouthRef.current?.release();
        setVoicePhase("explaining", event.turnId);
      },
      onChunkPlayed: (event) => {
        vadRef.current?.setPlaybackActive(true);
        setVoicePhase("explaining", event.turnId);
        bus?.emit("tts-chunk", {
          turnId: event.turnId,
          index: event.index,
          at: event.at,
          chars: event.text.length,
        });
      },
      onDrain: () => {
        vadRef.current?.setPlaybackActive(false);
        bus?.emit("tts-drain", {});
        setVoicePhase(startedRef.current ? "listening" : "idle");
      },
      onError: (event) => {
        bump("erros");
        bus?.emit("tts-error", {
          message: event.error instanceof Error ? event.error.name : "Error",
          code: null,
        });
      },
      onDiscard: (event) => {
        bus?.emit("tts-descartado", {
          turnId: typeof event.turnId === "string" ? event.turnId : null,
          index: Number(event.index) || 0,
          reason: String(event.reason ?? ""),
          attempts: Number(event.attempts) || 0,
          at: Number(event.at) || now(),
        });
      },
      onGap: (event) => {
        bus?.emit("tts-gap", {
          turnId: event.turnId,
          index: event.index,
          gapMs: event.gapMs,
          at: event.at,
        });
      },
      onBlocked: (event) => {
        bus?.emit("audio-bloqueado", { reason: event.reason });
      },
    };
    const tts = d.createTts ? d.createTts(options) : new TtsQueue(options);
    ttsRef.current = tts;
    return tts;
  }, [bump, bus, setVoicePhase]);

  /** Voz → transcrição → turno no chat. Nunca envia texto ao barramento. */
  const handleTranscription = useCallback(
    async (capture: VoiceCaptureLike, durationMs: number) => {
      const d = depsRef.current;
        const now = d.now ?? Date.now;
      setVoicePhase("thinking");
      try {
        const clip = await capture.finalizeClip();
        if (!clip) {
          setVoicePhase("listening");
          return;
        }
        bus?.emit("clip", {
          mimeType: clip.mimeType,
          bytes: clip.bytes,
          fallback: Boolean(clip.usedFallback),
          magic: "RIFF",
        });

        if (!(await ensureLimiter().waitForSlot())) {
          bus?.emit("transcricao-descartada", {
            reason: "rate_limit",
            chars: 0,
            durationMs,
          });
          setVoicePhase("listening");
          return;
        }

        const transcribe = d.transcribe ?? transcribeAudio;
        const bruto = await transcribe(clip.blob, { language: "pt" });
        const anterior = lastTextRef.current;
        const classificacao = classifyTranscription(bruto, {
          durationMs: clip.durationMs,
          previousText: anterior?.text ?? null,
          sinceLastMs: anterior ? now() - anterior.at : null,
        });
        if (!classificacao.accepted) {
          bus?.emit("transcricao-descartada", {
            reason: classificacao.reason,
            chars: bruto.length,
            durationMs,
          });
          bump("descartesTranscricao");
          setVoicePhase("listening");
          return;
        }

        const corrigida = corrigirTranscricao(bruto);
        const text = corrigida.text;
        lastTextRef.current = { text, at: now() };
        bump("transcricoes");
        bus?.emit("transcription", {
          at: now(),
          durationMs: clip.durationMs,
          corrigiu: corrigida.changed,
        });
        bus?.emit("metric", { name: "transcription.chars", value: text.length });

        if (typeof chatApi.sendMessage === "function") {
          // Congela a resposta que já estava na tela ANTES do envio: se o
          // efeito rodar enquanto isStreaming ainda é false, ela não é falada.
          baseAnswerKeyRef.current = lastAnswerKey(chatApi.state?.messages);
          spokenKeyRef.current = baseAnswerKeyRef.current;
          awaitingReplyRef.current = true;
          chatApi.sendMessage(text);
        } else {
          awaitingReplyRef.current = false;
          bus?.emit("aviso", { texto: "Chat indisponível", motivo: "sendMessage" });
        }
      } catch (error) {
        bump("erros");
        if (isRateLimitError(error)) {
          // waitForSlot() já consumiu um timestamp; registerError devolve o
          // slot e aplica o retry-after/backoff sem inventar outra espera.
          const esperaMs = ensureLimiter().registerError(error);
          bus?.emit("aviso", { texto: "STT rate limit", motivo: "HTTP_429" });
          bus?.emit("metric", { name: "stt.cooldownMs", value: esperaMs });
        } else {
          bus?.emit("aviso", {
            texto: "Falha na transcrição",
            motivo: error instanceof Error ? error.name : "Error",
          });
          setVoicePhase("error");
        }
      }
    },
    [bump, bus, chatApi, ensureLimiter, setVoicePhase],
  );

  const speakFinal = useCallback(
    (markdown: string, turnId: string) => {
        const chunks = speakableGroups(markdown);
      if (!chunks.length) {
        setVoicePhase("listening");
        return;
      }
      const tts = ensureTts();
      currentTurnRef.current = turnId;
      vadRef.current?.setPlaybackActive(true);
      setVoicePhase("explaining", turnId);
      tts.enqueue(chunks, { turnId, generation: tts.generation });
      bump("turnosFalados");
      bus?.emit("metric", { name: "tts.chunks", value: chunks.length, turnId });
    },
    [bump, bus, ensureTts, setVoicePhase],
  );

  const start = useCallback(async () => {
    if (startedRef.current) return;
    const d = depsRef.current;
    const now = d.now ?? Date.now;
    const session = d.setSessionType ?? setAudioSessionType;
    setVoicePhase("connecting");

    try {
      const outputOptions: AudioOutputOptions = {
        onState: (detail) => {
          bus?.emit("audio-state", {
            state: detail.state,
            unlocked: detail.unlocked,
          });
        },
      };
      const output = d.createOutput
        ? d.createOutput(outputOptions)
        : new WebAudioOutput(outputOptions);
      outputRef.current = output;
      await output.unlock();
      bus?.emit("audio-state", { state: output.state, unlocked: output.unlocked });
      // A saída sozinha usa 'playback'; com microfone ativo usa 'play-and-record'.
      session("playback");

      const captureOptions: AudioCaptureOptions = {
        // O mesmo AudioContext do iOS é compartilhado; o cast é apenas estrutural
        // (OutputContext e CaptureContext descrevem o mesmo nó em runtime).
        context: output.sharedContext as AudioCaptureOptions["context"] | null,
      };
      const capture = d.createCapture
        ? d.createCapture(captureOptions)
        : new AudioCapture(captureOptions);
      captureRef.current = capture;
      session("play-and-record");
      bus?.emit("audio-session", { capture: "play-and-record", output: "playback" });

      const analyser = await capture.start();
      const vadOptions: EnergyVadOptions = {
        analyser,
        onSpeechStart: (event) => {
          bus?.emit("speech-start", {
            at: event.at,
            rms: event.rms,
            playbackActive: event.playbackActive,
            continuacao: isContinuation(lastSpeechEndRef.current, event.at),
          });
          capture.resetRecording();
          mouthRef.current?.release();
          setVoicePhase("listening");
        },
        onSpeechEnd: (event) => {
          lastSpeechEndRef.current = event.at;
          bus?.emit("speech-end", {
            at: event.at,
            reason: event.reason,
            durationMs: event.durationMs,
          });
          void handleTranscription(capture, event.durationMs);
        },
        onSample: (debug) => {
          const t = now();
          if (t - lastLevelAtRef.current >= 100) {
            lastLevelAtRef.current = t;
            setLevel(Math.min(1, Math.round(debug.rms * 400) / 100));
          }
        },
        onDiscard: (event) => {
          bus?.emit("vad-descartado", { ...event });
          bump("descartesVad");
        },
      };
      const vad = d.createVad
        ? d.createVad(vadOptions)
        : new EnergyVad(vadOptions);
      vadRef.current = vad;
      ensureMouth();
      vad.start();
      startedRef.current = true;
      setVoicePhase("listening");
    } catch (error) {
      bump("erros");
      bus?.emit("audio-bloqueado", {
        reason: error instanceof Error ? error.name : "Error",
      });
      setVoicePhase("error");
    }
  }, [bump, bus, ensureMouth, handleTranscription, setVoicePhase]);

  const stop = useCallback(() => {
    const d = depsRef.current;
    if (!startedRef.current && !ttsRef.current && !outputRef.current) return;

    startedRef.current = false;
    awaitingReplyRef.current = false;
    if (typeof chatApi.cancelStreamingTurn === "function") {
      chatApi.cancelStreamingTurn();
    }
    vadRef.current?.stop();
    captureRef.current?.stop();
    outputRef.current?.stop();
    ttsRef.current?.stop();
    mouthRef.current?.dispose();
    vadRef.current = null;
    captureRef.current = null;
    ttsRef.current = null;
    mouthRef.current = null;
    limiterRef.current = null;
    currentTurnRef.current = null;
    (d.setSessionType ?? setAudioSessionType)("playback");
    bus?.emit("audio-state", {
      state: outputRef.current?.state ?? "none",
      unlocked: false,
    });
    setLevel(0);
    setVoicePhase("idle");
  }, [bus, chatApi, setVoicePhase]);

  const interrupt = useCallback(() => {
    const reason = "barge-in";
    bump("interrupcoes");

    if (typeof chatApi.cancelStreamingTurn === "function") {
      chatApi.cancelStreamingTurn();
    }
    outputRef.current?.stop();
    ttsRef.current?.stop(); // incrementa a geração: nenhum chunk antigo toca
    vadRef.current?.setPlaybackActive(false);
    mouthRef.current?.forceClose(reason);
    awaitingReplyRef.current = false;

    bus?.emit("interrupted", {
      reason,
      generation: ttsRef.current?.generation ?? 0,
      turnId: currentTurnRef.current,
    });
    setVoicePhase("interrupted");
  }, [bump, bus, chatApi, setVoicePhase]);

  const toggleMic = useCallback(() => {
    if (startedRef.current) stop();
    else void start();
  }, [start, stop]);

  // Nenhum estado do React é tocado por frame: o loop de boca em AvatarStage
  // chama getAmplitude() direto e escreve no renderer.
  const getAmplitude = useCallback((): VoiceAmplitude => {
    const controller = mouthRef.current;
    if (!controller) return { mouthOpen: 0, vowel: 0 };
    const state = controller.tick();
    return { mouthOpen: state.mouthOpen, vowel: state.vowel };
  }, []);

  const messages = chatApi.state?.messages;
  const isStreaming = chatApi.state?.isStreaming;

  // Resposta FINAL do chat (stream encerrado) é a única fonte de TTS.
  useEffect(() => {
    if (!awaitingReplyRef.current || isStreaming) return;
    const last = [...(messages ?? [])]
      .reverse()
      .find((message) => message?.role === "assistant");
    if (!last) return;
    const key = answerKey(last);
    if (!key) return;
    const markdown = last.rawContent || last.content || "";
    const turnId = String(last.id ?? "assistant");
    // A resposta que já existia no envio é o "base": mesmo que o efeito rode
    // antes do novo stream, ela não pode virar TTS.
    if (key === baseAnswerKeyRef.current || key === spokenKeyRef.current) return;
    spokenKeyRef.current = key;
    awaitingReplyRef.current = false;
    // Defere a atualização de fase para fora do efeito: o compilador React
    // proíbe setState síncrono em efeito (cascading renders).
    queueMicrotask(() => speakFinal(markdown, turnId));
  }, [messages, isStreaming, speakFinal]);

  useEffect(
    () => () => {
      vadRef.current?.stop();
      captureRef.current?.stop();
      outputRef.current?.stop();
      ttsRef.current?.stop();
      mouthRef.current?.dispose();
    },
    [],
  );

  return {
    phase,
    start,
    stop,
    interrupt,
    toggleMic,
    level,
    getAmplitude,
    metrics,
    bus,
  };
}
