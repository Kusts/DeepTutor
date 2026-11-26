import { describe, expect, it } from "vitest";

import {
  PHASE_LABEL_KEYS,
  avatarPhaseFor,
  phaseLabelKey,
  type VoiceSignal,
} from "@/features/classroom/voice/model/phase-map";

describe("mapeamento de fases do avatar", () => {
  it("cobre as sete fases públicas a partir dos sinais internos", () => {
    const esperado: Record<VoiceSignal, string> = {
      idle: "idle",
      reset: "idle",
      connecting: "connecting",
      listening: "listening",
      thinking: "thinking",
      explaining: "explaining",
      interrupted: "interrupted",
      error: "error",
    };
    for (const [signal, fase] of Object.entries(esperado)) {
      expect(avatarPhaseFor(signal as VoiceSignal)).toBe(fase);
    }
    expect(new Set(Object.values(PHASE_LABEL_KEYS)).size).toBe(7);
  });

  it("mantém chaves i18n estáveis e compatíveis com idle/connecting", () => {
    expect(phaseLabelKey("idle")).toBe("Idle");
    expect(phaseLabelKey("connecting")).toBe("Connecting");
    expect(phaseLabelKey("listening")).toBe("Listening");
    expect(phaseLabelKey("thinking")).toBe("Thinking");
    expect(phaseLabelKey("explaining")).toBe("Explaining");
    expect(phaseLabelKey("interrupted")).toBe("Interrupted");
    expect(phaseLabelKey("error")).toBe("Error");
  });
});
