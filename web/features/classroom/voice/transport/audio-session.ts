// Política de sessão de áudio no iOS Safari (Safari >= 16.4; MDN: Baseline 2025).
//
// FATO (WebKit bug 237322 / 251532): Web Audio roda na categoria "ambient" por
// padrão no iOS e é silenciada pelo interruptor físico; `playback`/'play-and-record'
// colocam a página na categoria de mídia e ignoram o interruptor.
// INFERÊNCIA documentada (spec AudioSession + WebKit MediaDevices.cpp): `playback`
// é somente saída e pode encerrar tracks de captura; enquanto o microfone estiver
// ligado usamos `play-and-record`. Só o aparelho do usuário confirma o resultado.
//
// Nenhuma credencial ou dado de usuário entra neste módulo.

import { encodeWavMono } from './wav';

export const SESSION_TYPES = Object.freeze(['auto', 'playback', 'play-and-record'] as const);
export type SessionType = (typeof SESSION_TYPES)[number];

export interface AudioSessionLike {
  type?: string | null;
}

export interface NavigatorLike {
  audioSession?: AudioSessionLike | null;
  userAgent?: string;
  maxTouchPoints?: number;
}

export interface SetSessionOptions {
  nav?: NavigatorLike | null;
  onError?: (info: { name: string; message: string }) => void;
}

export interface SetSessionResult {
  supported: boolean;
  type: string | null;
  requested: SessionType;
  error: { name: string; message: string } | null;
}

interface VoiceNavigatorGlobal {
  navigator?: NavigatorLike | null;
  document?: DocumentRef | null;
  URL?: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };
}

interface AudioElementLike {
  loop: boolean;
  preload: string;
  hidden: boolean;
  src: string;
  setAttribute(name: string, value: string): void;
  play(): { catch(fn: (error: unknown) => void): void } | Promise<unknown> | undefined;
  pause(): void;
  currentTime: number;
  remove(): void;
}

export interface DocumentRef {
  createElement(tag: 'audio'): AudioElementLike;
  body: { append(element: AudioElementLike): void };
}

export interface LegacyIosHandle {
  element: AudioElementLike;
  stop(): void;
}

export interface LegacyIosOptions {
  documentRef?: DocumentRef | null;
  nav?: NavigatorLike | null;
  createObjectURL?: ((blob: Blob) => string) | null;
  revokeObjectURL?: ((url: string) => void) | null;
}

function globals(): typeof globalThis & VoiceNavigatorGlobal {
  return globalThis as typeof globalThis & VoiceNavigatorGlobal;
}

export function audioSessionApi(nav: NavigatorLike | null | undefined = globals().navigator): AudioSessionLike | null {
  const session = nav?.audioSession;
  if (!session || typeof session !== 'object') return null;
  return session;
}

export function setAudioSessionType(
  type: SessionType,
  { nav = globals().navigator, onError = () => {} }: SetSessionOptions = {},
): SetSessionResult {
  const session = audioSessionApi(nav);
  if (!session || !SESSION_TYPES.includes(type as (typeof SESSION_TYPES)[number])) {
    return { supported: false, type: null, requested: type, error: null };
  }
  try {
    session.type = type;
    return { supported: true, type: session.type ?? type, requested: type, error: null };
  } catch (error) {
    const info = {
      name: error instanceof Error ? error.name : 'Error',
      message: String(error instanceof Error ? error.message : '').slice(0, 120),
    };
    onError(info);
    return { supported: true, type: session.type ?? null, requested: type, error: info };
  }
}

export function currentAudioSessionType(nav: NavigatorLike | null | undefined = globals().navigator): string | null {
  return audioSessionApi(nav)?.type ?? null;
}

export function isIOS(nav: NavigatorLike | null | undefined = globals().navigator): boolean {
  const ua = String(nav?.userAgent ?? '');
  const mobile = /iPad|iPhone|iPod/.test(ua);
  const ipadDesktop = /Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1;
  return mobile || ipadDesktop;
}

/** Cria um <audio> silencioso e em loop, preparado DENTRO do gesto do usuário.
 *  fallback legado para iOS < 16.4 (sem AudioSession API). O áudio é gerado
 *  localmente: nenhum arquivo externo, rede ou CDN. */
export function prepareLegacyIosAudio({
  documentRef = globals().document,
  nav = globals().navigator,
  createObjectURL = globals().URL?.createObjectURL,
  revokeObjectURL = globals().URL?.revokeObjectURL,
}: LegacyIosOptions = {}): LegacyIosHandle | null {
  if (!isIOS(nav) || !documentRef || audioSessionApi(nav)) return null;
  try {
    const chunk = new Float32Array(4000); // 0,5 s de silêncio a 8 kHz
    const wav = encodeWavMono({
      sampleRate: 8000, length: chunk.length, numberOfChannels: 1, getChannelData: () => chunk,
    });
    const url = createObjectURL?.(new Blob([wav], { type: 'audio/wav' }));
    if (!url) return null;
    const audio = documentRef.createElement('audio');
    audio.loop = true;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.src = url;
    audio.hidden = true;
    documentRef.body.append(audio);
    const played = audio.play();
    if (played && typeof played.catch === 'function') played.catch(() => {}); // gesto inválido não derruba a sala
    return {
      element: audio,
      stop() {
        try { audio.pause(); audio.currentTime = 0; } catch { /* já parado */ }
        audio.remove();
        revokeObjectURL?.(url);
      },
    };
  } catch {
    return null;
  }
}
