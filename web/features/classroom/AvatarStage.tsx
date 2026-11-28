"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import { Field, StatusChip } from "@/shared/ui";

import "./classroom-tokens.css";
import type { AvatarPhase } from "./livliv/AvatarRenderer";
import { LivLivRenderer } from "./livliv/LivLivRenderer";
import {
  DEFAULT_LIVLIV_CHARACTER,
  LIVLIV_CHARACTERS,
  LIVLIV_CREDIT,
  isLivLivCharacterId,
  livlivErrorCode,
  type LivLivCharacterId,
} from "./livliv/characters";
import { phaseLabelKey } from "./voice/model/phase-map";

export type { AvatarPhase } from "./livliv/AvatarRenderer";

export interface VoiceAmplitude {
  mouthOpen: number;
  vowel: number;
}

export interface AvatarStageProps {
  phase?: AvatarPhase;
  /** Synchronous reader supplied by the voice session. It must NOT drive React
   *  state: the animation loop writes straight into the renderer each frame. */
  getAmplitude?: () => VoiceAmplitude;
}

const controlClass =
  "min-h-8 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The classroom avatar is a state renderer, never a second pedagogical agent:
 * it receives a phase from its caller and touches no WebSocket, LLM or audio
 * (AGENTS.md principle 4; classroom plan R11). The CSS orb is the fallback;
 * with the classroom flag on (this component is only mounted then) the
 * LivLiv player is loaded by a dynamic import inside a compact slot.
 *
 * Mouth movement is the only animated channel: while `phase === "explaining"`
 * and the caller supplies `getAmplitude`, a requestAnimationFrame loop samples
 * it and writes to `renderer.setAmplitude()` directly. Reduced-motion users
 * keep the static renderer and no animation frame is scheduled.
 */
export function AvatarStage({
  phase = "idle",
  getAmplitude,
}: AvatarStageProps) {
  const { t } = useTranslation();
  const connecting = phase === "connecting";

  const slotRef = useRef<HTMLDivElement>(null);
  const creditRef = useRef<HTMLParagraphElement>(null);
  const rendererRef = useRef<LivLivRenderer | null>(null);
  const phaseRef = useRef(phase);

  const [active, setActive] = useState(false);
  const [characterId, setCharacterId] = useState<LivLivCharacterId>(
    DEFAULT_LIVLIV_CHARACTER,
  );

  useEffect(() => {
    let cancelled = false;
    const slot = slotRef.current;
    const renderer = new LivLivRenderer({
      characterId,
      phase: phaseRef.current,
      creditElement: creditRef.current,
    });
    rendererRef.current = renderer;

    if (!slot) {
      return () => {
        cancelled = true;
        renderer.dispose();
        rendererRef.current = null;
      };
    }

    void renderer.mount(slot).then(
      () => {
        if (!cancelled) setActive(true);
      },
      (error: unknown) => {
        if (cancelled) return;
        setActive(false);
        console.warn(
          "[classroom] player LivLiv indisponível:",
          livlivErrorCode(error),
        );
      },
    );

    return () => {
      cancelled = true;
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [characterId]);

  useEffect(() => {
    phaseRef.current = phase;
    rendererRef.current?.setState(phase);
  }, [phase, active]);

  // Reset the mouth whenever playback is not active; this is an occasional
  // write, not a per-frame one, so it is safe as an effect.
  useEffect(() => {
    if (phase !== "explaining") rendererRef.current?.setAmplitude?.(0, 0);
  }, [phase, active]);

  useEffect(() => {
    if (phase !== "explaining" || !getAmplitude || !active) return;
    if (typeof window === "undefined") return;
    const raf = window.requestAnimationFrame;
    const cancelRaf = window.cancelAnimationFrame;
    if (typeof raf !== "function" || typeof cancelRaf !== "function") return;
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let frame = 0;
    let cancelled = false;
    const loop = () => {
      if (cancelled) return;
      const { mouthOpen, vowel } = getAmplitude();
      rendererRef.current?.setAmplitude?.(mouthOpen, vowel);
      frame = raf(loop);
    };
    frame = raf(loop);
    return () => {
      cancelled = true;
      cancelRaf(frame);
      rendererRef.current?.setAmplitude?.(0, 0);
    };
  }, [phase, getAmplitude, active]);

  const handleCharacterChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isLivLivCharacterId(next) || next === characterId) return;
    // Hide the outgoing player's credit immediately; the new mount re-shows it.
    setActive(false);
    setCharacterId(next);
  };

  return (
    <section
      aria-label={t("Classroom avatar")}
      className="dt-classroom__stage flex flex-wrap items-center gap-3 rounded-xl px-3 py-2"
    >
      <div className="dt-classroom__avatar-slot flex items-center gap-2">
        {active ? null : (
          <span
            aria-hidden="true"
            className={`dt-classroom__orb ${
              connecting ? "dt-classroom__orb--connecting" : ""
            } grid h-9 w-9 shrink-0 place-items-center rounded-full text-base font-semibold`}
          >
            {connecting ? "…" : "◕"}
          </span>
        )}
        <div ref={slotRef} className="dt-classroom__livliv-slot" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t("Classroom avatar")}</p>
        <p className="dt-classroom__caption truncate text-xs">
          {t("Voice is ready. Speak to your Tutor.")}
        </p>
        <p ref={creditRef} hidden className="dt-classroom__credit text-xs">
          {t(LIVLIV_CREDIT)}
        </p>
      </div>
      {active ? (
        <Field label={t("Character")} className="dt-classroom__character-field">
          <select
            className={controlClass}
            value={characterId}
            onChange={handleCharacterChange}
          >
            {LIVLIV_CHARACTERS.map((character) => (
              <option key={character.id} value={character.id}>
                {t(character.name)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <StatusChip tone={connecting ? "info" : "neutral"}>
        {t(phaseLabelKey(phase))}
      </StatusChip>
    </section>
  );
}
