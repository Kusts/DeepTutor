// Mapeamento puro entre os sinais internos da sessão de voz e as fases do
// avatar. Mantido fora do hook para ser testável sem React, DOM ou áudio.

import type { AvatarPhase } from "../../livliv/AvatarRenderer";

/** Sinais emitidos pela máquina de estados da sessão de voz. */
export type VoiceSignal =
  | "reset"
  | "connecting"
  | "listening"
  | "thinking"
  | "explaining"
  | "interrupted"
  | "error"
  | "idle";

/**
 * Colapsa os sinais internos nas fases públicas do avatar. `transcribing` não é
 * uma fase separada: durante a ida ao STT o avatar continua "listening", e
 * passa a "thinking" assim que o turno entra no chat.
 */
export function avatarPhaseFor(signal: VoiceSignal): AvatarPhase {
  switch (signal) {
    case "connecting":
      return "connecting";
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "explaining":
      return "explaining";
    case "interrupted":
      return "interrupted";
    case "error":
      return "error";
    case "idle":
    case "reset":
    default:
      return "idle";
  }
}

/** Chaves i18n compartilhadas entre o palco e os controles de voz. */
export const PHASE_LABEL_KEYS: Readonly<Record<AvatarPhase, string>> = Object.freeze({
  idle: "Idle",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  explaining: "Explaining",
  interrupted: "Interrupted",
  error: "Error",
});

export function phaseLabelKey(phase: AvatarPhase): string {
  return PHASE_LABEL_KEYS[phase] ?? PHASE_LABEL_KEYS.idle;
}
