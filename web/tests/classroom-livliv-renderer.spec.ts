import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LIVLIV_CREDIT, LIVLIV_CHARACTERS } from "@/features/classroom/livliv/characters";
import {
  LivLivRenderer,
  type LivLivPlayerClass,
  type LivLivPlayerLike,
} from "@/features/classroom/livliv/LivLivRenderer";

type MockInstance = LivLivPlayerLike & {
  load: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  lastUrl: string;
};

function makePlayer(supported = true): {
  PlayerRef: LivLivPlayerClass;
  instances: MockInstance[];
  createSpeech: ReturnType<typeof vi.fn>;
} {
  const instances: MockInstance[] = [];
  const createSpeech = vi.fn(() => {
    throw new Error("createSpeech must never be used");
  });

  class MockPlayer implements MockInstance {
    params = { mouthOpen: 0, vowel: 0 };
    disposed = false;
    lastUrl = "";
    load = vi.fn(async (url: string) => {
      this.lastUrl = url;
      return {};
    });
    dispose = vi.fn(() => {
      this.disposed = true;
    });

    constructor(_canvas: HTMLCanvasElement, _options: unknown) {
      instances.push(this);
    }

    static isSupported = vi.fn(() => supported);
    static createSpeech = createSpeech;
  }

  return {
    PlayerRef: MockPlayer as unknown as LivLivPlayerClass,
    instances,
    createSpeech,
  };
}

function makeSlot(): { container: HTMLDivElement; credit: HTMLParagraphElement } {
  const container = document.createElement("div");
  const credit = document.createElement("p");
  credit.hidden = true;
  document.body.append(container, credit);
  return { container, credit };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

it("clamps mouthOpen to [0,1] and vowel to [-1,1] at the only write point", async () => {
  const { PlayerRef, instances } = makePlayer();
  const { container } = makeSlot();
  const renderer = new LivLivRenderer({ PlayerRef });
  await renderer.mount(container);

  renderer.setAmplitude(2, -5);
  expect(instances[0].params).toEqual({ mouthOpen: 1, vowel: -1 });

  renderer.setAmplitude(-2, 5);
  expect(instances[0].params).toEqual({ mouthOpen: 0, vowel: 1 });

  renderer.setAmplitude(Number.NaN, Number.NaN);
  expect(instances[0].params).toEqual({ mouthOpen: 0, vowel: 0 });

  renderer.dispose();
});

it("loads each Featured character from an absolute public URL", async () => {
  for (const { id } of LIVLIV_CHARACTERS) {
    const { PlayerRef, instances } = makePlayer();
    const { container } = makeSlot();
    const renderer = new LivLivRenderer({ characterId: id, PlayerRef });
    await renderer.mount(container);

    const url = instances[0].lastUrl;
    expect(url).toBe(
      new URL(`/classroom-livliv/characters/${id}.livliv`, "http://localhost/").href,
    );
    expect(url).toMatch(/^https?:\/\//);
    expect(url).not.toMatch(/\/classroom\/|p01|p02|p03|d03/);
    renderer.dispose();
  }
});

it("rejects non-Featured ids before touching WebGL or the DOM", async () => {
  for (const id of ["p01", "p02", "p03", "d03", "d03ft", "../k01"]) {
    const { PlayerRef, instances } = makePlayer();
    const { container, credit } = makeSlot();
    const renderer = new LivLivRenderer({ characterId: id, PlayerRef });

    await expect(renderer.mount(container)).rejects.toThrow("personagem_invalido");
    expect(instances).toHaveLength(0);
    expect(container.querySelector("canvas")).toBeNull();
    expect(credit.hidden).toBe(true);
  }
});

it("dispose releases the player and clears canvas and credit", async () => {
  const { PlayerRef, instances } = makePlayer();
  const { container, credit } = makeSlot();
  const renderer = new LivLivRenderer({ PlayerRef, creditElement: credit });
  await renderer.mount(container);

  expect(container.querySelector("canvas")).not.toBeNull();
  expect(credit.hidden).toBe(false);
  expect(credit.textContent).toBe(LIVLIV_CREDIT);

  renderer.dispose();
  expect(instances[0].dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelector("canvas")).toBeNull();
  expect(credit.hidden).toBe(true);

  // A disposed renderer never resurrects a WebGL context.
  await expect(renderer.mount(container)).rejects.toThrow("renderer_disposed");
});

it("keeps the fallback when WebGL2 is unavailable", async () => {
  const { PlayerRef, instances } = makePlayer(false);
  const { container, credit } = makeSlot();
  const renderer = new LivLivRenderer({ PlayerRef });

  await expect(renderer.mount(container)).rejects.toThrow("webgl2_indisponivel");
  expect(instances).toHaveLength(0);
  expect(container.querySelector("canvas")).toBeNull();
  expect(credit.hidden).toBe(true);
});

it("never calls createSpeech or loads the voice module", async () => {
  const { PlayerRef, createSpeech, instances } = makePlayer();
  const { container } = makeSlot();
  const renderer = new LivLivRenderer({ PlayerRef });
  await renderer.mount(container);
  renderer.setAmplitude(0.5, 0.25);

  expect(createSpeech).not.toHaveBeenCalled();
  expect(instances[0].params).toEqual({ mouthOpen: 0.5, vowel: 0.25 });

  const source = fs.readFileSync(
    path.join(process.cwd(), "features/classroom/livliv/LivLivRenderer.ts"),
    "utf8",
  );
  expect(source).not.toMatch(/createSpeech/);
  expect(source).toMatch(/await import\("\.\/vendor\/index\.js"\)/);

  renderer.dispose();
});
