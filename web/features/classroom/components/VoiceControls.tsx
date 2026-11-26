"use client";

import { Mic, MicOff, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, StatusChip, type StatusTone } from "@/shared/ui";

import "../classroom-tokens.css";
import type { AvatarPhase } from "../livliv/AvatarRenderer";
import { phaseLabelKey } from "../voice/model/phase-map";
import type { VoiceMetrics } from "../voice/useVoiceSession";

export interface VoiceControlsProps {
  phase: AvatarPhase;
  level: number;
  metrics: VoiceMetrics;
  onToggleMic: () => void;
  onSpeak: () => void;
  onInterrupt: () => void;
}

function toneForPhase(phase: AvatarPhase): StatusTone {
  if (phase === "error") return "danger";
  if (phase === "interrupted") return "warning";
  if (phase === "connecting" || phase === "listening" || phase === "explaining") {
    return "info";
  }
  return "neutral";
}

/**
 * Controles de voz da sala. A única coisa que aqui acontece é chamar o
 * useVoiceSession — nenhum texto de fala, credencial ou áudio é registrado.
 * Toda string é chave i18n; o nível é exposto como progressbar acessível.
 */
export function VoiceControls({
  phase,
  level,
  metrics,
  onToggleMic,
  onSpeak,
  onInterrupt,
}: VoiceControlsProps) {
  const { t } = useTranslation();
  const micOn = phase !== "idle" && phase !== "error";
  const canInterrupt = phase === "explaining" || phase === "thinking";
  const valor = Math.max(0, Math.min(100, Math.round((Number(level) || 0) * 100)));

  return (
    <section
      aria-label={t("Voice controls")}
      className="dt-classroom__voice-controls flex flex-wrap items-center gap-2 rounded-xl px-3 py-2"
    >
      <Button
        size="sm"
        variant={micOn ? "primary" : "secondary"}
        aria-label={t(micOn ? "Disable microphone" : "Enable microphone")}
        aria-pressed={micOn}
        icon={
          micOn ? (
            <MicOff aria-hidden="true" className="h-4 w-4" />
          ) : (
            <Mic aria-hidden="true" className="h-4 w-4" />
          )
        }
        onClick={onToggleMic}
      />

      <Button
        size="sm"
        variant="secondary"
        aria-label={t("Speak")}
        icon={<Volume2 aria-hidden="true" className="h-4 w-4" />}
        onClick={onSpeak}
        disabled={micOn}
      >
        {t("Speak")}
      </Button>

      <Button
        size="sm"
        variant="danger"
        aria-label={t("Interrupt")}
        icon={<Square aria-hidden="true" className="h-4 w-4" />}
        onClick={onInterrupt}
        disabled={!canInterrupt}
      >
        {t("Interrupt")}
      </Button>

      <div
        role="progressbar"
        aria-label={t("Microphone level")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valor}
        className="dt-classroom__voice-level h-2 min-w-16 flex-1 overflow-hidden rounded-full"
      >
        <div
          className="dt-classroom__voice-level-fill h-full rounded-full"
          style={{ width: `${valor}%` }}
        />
      </div>

      <StatusChip tone={toneForPhase(phase)}>{t(phaseLabelKey(phase))}</StatusChip>

      <p role="status" className="dt-classroom__caption text-xs">
        {t("Voice: {{n}} transcriptions, {{m}} interruptions", {
          n: metrics.transcricoes,
          m: metrics.interrupcoes,
        })}
      </p>
    </section>
  );
}
