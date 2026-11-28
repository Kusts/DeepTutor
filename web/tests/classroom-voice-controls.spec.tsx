import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { VoiceControls } from "@/features/classroom/components/VoiceControls";
import type { VoiceMetrics } from "@/features/classroom/voice/useVoiceSession";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options
        ? key
            .replace("{{n}}", String(options.n))
            .replace("{{m}}", String(options.m))
        : key,
  }),
}));

const metrics: VoiceMetrics = {
  transcricoes: 3,
  descartesTranscricao: 1,
  descartesVad: 2,
  turnosFalados: 3,
  interrupcoes: 1,
  erros: 0,
};

function setup(phase: "idle" | "explaining" | "error" = "idle", level = 0) {
  const handlers = {
    onToggleMic: vi.fn(),
    onSpeak: vi.fn(),
    onInterrupt: vi.fn(),
  };
  render(
    <VoiceControls
      phase={phase}
      level={level}
      metrics={metrics}
      {...handlers}
    />,
  );
  return handlers;
}

it("expõe estado acessível e desabilita Interromper quando não há fala", async () => {
  const handlers = setup("idle");
  const mic = screen.getByRole("button", { name: "Enable microphone" });
  expect(mic).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "Interrupt" })).toBeDisabled();
  const bar = screen.getByRole("progressbar", { name: "Microphone level" });
  expect(bar).toHaveAttribute("aria-valuenow", "0");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Voice: 3 transcriptions, 1 interruptions",
  );
  await userEvent.click(mic);
  expect(handlers.onToggleMic).toHaveBeenCalledTimes(1);
});

it("durante a explicação mostra microfone ativo, nível e Interromper habilitado", async () => {
  const handlers = setup("explaining", 0.42);
  const mic = screen.getByRole("button", { name: "Disable microphone" });
  expect(mic).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Speak" })).toBeDisabled();
  const bar = screen.getByRole("progressbar", { name: "Microphone level" });
  expect(bar).toHaveAttribute("aria-valuenow", "42");
  const interrupt = screen.getByRole("button", { name: "Interrupt" });
  expect(interrupt).toBeEnabled();
  await userEvent.click(interrupt);
  expect(handlers.onInterrupt).toHaveBeenCalledTimes(1);
});

it("Falar inicia a sessão quando o microfone está desligado", async () => {
  const handlers = setup("idle");
  const speak = screen.getByRole("button", { name: "Speak" });
  expect(speak).toBeEnabled();
  await userEvent.click(speak);
  expect(handlers.onSpeak).toHaveBeenCalledTimes(1);
});

it("estado de erro mantém o microfone desligado e sem interrupção", () => {
  setup("error", 1);
  expect(screen.getByRole("button", { name: "Enable microphone" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "Interrupt" })).toBeDisabled();
  expect(
    screen.getByRole("progressbar", { name: "Microphone level" }),
  ).toHaveAttribute("aria-valuenow", "100");
});
