import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import ClassroomPage from "@/app/(workspace)/classroom/page";

const fixture = vi.hoisted(() => ({ flag: true, loading: false }));

vi.mock("@/hooks/useClassroomEnabled", () => ({
  useClassroomEnabled: () => ({
    value: fixture.flag,
    setValue: vi.fn(),
    loading: fixture.loading,
  }),
}));
vi.mock("@/features/chat/components/ChatWorkspace", () => ({
  default: () => <div data-testid="conversation">conversation</div>,
}));
// A sala compõe a sessão de voz, que lê o adaptador do chat. O provider real
// vive no layout; neste teste isolado basta o contrato mínimo.
vi.mock("@/features/chat/ChatStateAdapter", () => ({
  useChatStateAdapter: () => ({
    sendMessage: vi.fn(),
    cancelStreamingTurn: vi.fn(),
    state: { messages: [], isStreaming: false },
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

it("renders the classroom shell around the existing conversation when enabled", async () => {
  fixture.flag = true;
  fixture.loading = false;
  expect(() => render(<ClassroomPage />)).not.toThrow();
  expect(screen.getByRole("heading", { name: "Classroom" })).toBeTruthy();
  // The voice/avatar layer is loaded on demand; wait for it instead of
  // asserting on a synchronous mount that no longer exists in production.
  expect(await screen.findByRole("region", { name: "Classroom avatar" })).toBeTruthy();
  expect(await screen.findByText("Voice is ready. Speak to your Tutor.")).toBeTruthy();
  expect(screen.getByTestId("conversation")).toBeTruthy();
});

it("shows a short disabled state without chat or avatar when the flag is off", () => {
  fixture.flag = false;
  fixture.loading = false;
  render(<ClassroomPage />);
  expect(
    screen.getByText("The classroom is off. Turn it on in Settings → Voice."),
  ).toBeTruthy();
  expect(screen.queryByTestId("conversation")).toBeNull();
  expect(screen.queryByRole("region", { name: "Classroom avatar" })).toBeNull();
});

it("renders only a neutral busy state while the flag is loading", () => {
  fixture.flag = false;
  fixture.loading = true;
  render(<ClassroomPage />);
  expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  expect(screen.queryByTestId("conversation")).toBeNull();
  expect(screen.queryByRole("region", { name: "Classroom avatar" })).toBeNull();
});
