import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import { AvatarStage } from "@/features/classroom/AvatarStage";

interface RendererInstance {
  characterId?: string;
  phase?: string;
  dispose: () => void;
  setState: (phase: string) => void;
  mount: () => Promise<void>;
}

const mock = vi.hoisted(() => ({
  instances: [] as RendererInstance[],
  fail: false,
  resolvers: [] as Array<() => void>,
}));

vi.mock("@/features/classroom/livliv/LivLivRenderer", () => ({
  LivLivRenderer: class implements RendererInstance {
    characterId?: string;
    phase?: string;
    dispose: () => void;
    setState: (phase: string) => void;
    mount: () => Promise<void>;

    constructor(options: {
      characterId?: string;
      phase?: string;
      creditElement?: HTMLElement | null;
    }) {
      this.characterId = options.characterId;
      this.phase = options.phase;
      const credit = options.creditElement ?? null;
      this.setState = vi.fn();
      this.mount = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            if (mock.fail) {
              reject(new Error("webgl2_indisponivel"));
              return;
            }
            mock.resolvers.push(() => {
              if (credit) credit.hidden = false;
              resolve();
            });
          }),
      );
      this.dispose = vi.fn(() => {
        if (credit) credit.hidden = true;
      });
      mock.instances.push(this);
    }
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

beforeEach(() => {
  mock.instances.length = 0;
  mock.resolvers.length = 0;
  mock.fail = false;
});

it("shows the exact credit and a four-character selector only after the player loads", async () => {
  render(<AvatarStage />);

  expect(screen.getByText("Characters: LivLiv (livliv.ai)").hidden).toBe(true);
  expect(screen.queryByRole("combobox")).toBeNull();
  await act(async () => {
    mock.resolvers[0]();
  });

  expect(screen.getByText("Characters: LivLiv (livliv.ai)").hidden).toBe(false);
  expect(screen.getByRole("combobox")).toBeTruthy();
  for (const name of ["Sena", "Elio", "Hana", "Aster"]) {
    expect(screen.getByRole("option", { name })).toBeTruthy();
  }
  expect(document.querySelector(".dt-classroom__orb")).toBeNull();
});

it("disposes the previous renderer and remounts with the selected character", async () => {
  render(<AvatarStage />);
  await act(async () => {
    mock.resolvers[0]();
  });

  await act(async () => {
    await userEvent.selectOptions(screen.getByRole("combobox"), "v01");
  });
  await waitFor(() => expect(mock.instances).toHaveLength(2));
  expect(mock.instances[0].dispose).toHaveBeenCalledTimes(1);
  expect(mock.instances[1].characterId).toBe("v01");
  expect(screen.getByText("Characters: LivLiv (livliv.ai)").hidden).toBe(true);

  await act(async () => {
    mock.resolvers[1]();
  });
  expect(screen.getByText("Characters: LivLiv (livliv.ai)").hidden).toBe(false);
  expect(document.querySelector<HTMLSelectElement>("select")?.value).toBe("v01");
});

it("keeps the CSS orb and hides the credit when the player fails", async () => {
  mock.fail = true;
  render(<AvatarStage />);
  await act(async () => {});

  await waitFor(() => expect(mock.instances).toHaveLength(1));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("Characters: LivLiv (livliv.ai)").hidden).toBe(true);
  expect(document.querySelector(".dt-classroom__orb")).not.toBeNull();
});
