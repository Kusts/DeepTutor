import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { VoicePlaybackPrefs } from "@/features/settings/sections/models/VoicePlaybackPrefs";

const fixture = vi.hoisted(() => ({
  value: false,
  loading: false,
  setValue: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/useVoiceAutoplay", () => ({
  useVoiceAutoplayPreference: () => ({
    value: false,
    loading: false,
    setValue: vi.fn(),
  }),
}));
vi.mock("@/hooks/useVoiceMathSpeak", () => ({
  useVoiceMathSpeakPreference: () => ({
    value: false,
    loading: false,
    setValue: vi.fn(),
  }),
}));
vi.mock("@/hooks/useClassroomEnabled", () => ({
  useClassroomEnabled: () => ({
    value: fixture.value,
    loading: fixture.loading,
    setValue: fixture.setValue,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("adds the classroom opt-in as an accessible third switch", () => {
  fixture.value = false;
  fixture.loading = false;
  fixture.setValue.mockClear();
  render(<VoicePlaybackPrefs />);

  const toggle = screen.getByRole("switch", { name: "Classroom (sala de aula)" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).not.toBeDisabled();
  fireEvent.click(toggle);
  expect(fixture.setValue).toHaveBeenCalledWith(true);
  expect(
    screen.getByText(
      "Show the classroom in the sidebar. Voice and lip-sync are not available yet.",
    ),
  ).toBeTruthy();
});

it("disables the switch while the preference loads and shows the saved state", () => {
  fixture.value = true;
  fixture.loading = true;
  render(<VoicePlaybackPrefs />);

  const toggle = screen.getByRole("switch", { name: "Classroom (sala de aula)" });
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(toggle).toBeDisabled();
});
