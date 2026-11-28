import type { AvatarPhase, AvatarRenderer } from "./AvatarRenderer";
import {
  DEFAULT_LIVLIV_CHARACTER,
  LIVLIV_CREDIT,
  livlivCharacterUrl,
} from "./characters";

/** Minimal structural view of the player; the vendor bundle stays untyped. */
export interface LivLivPlayerLike {
  params: { mouthOpen: number; vowel: number };
  load(url: string, options?: { poster?: null }): Promise<unknown>;
  dispose(): void;
  disposed?: boolean;
}

export interface LivLivPlayerOptions {
  lang: "pt-BR";
  maxPixelRatio: number;
  followPointer: boolean;
  idle: boolean;
}

export interface LivLivPlayerClass {
  isSupported?: () => boolean;
  new (canvas: HTMLCanvasElement, options: LivLivPlayerOptions): LivLivPlayerLike;
}

export interface LivLivRendererOptions {
  characterId?: string;
  phase?: AvatarPhase;
  creditElement?: HTMLElement | null;
  /** Injection point for focused tests; production uses the dynamic import. */
  PlayerRef?: LivLivPlayerClass;
  documentRef?: Document;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));

/**
 * Isolated renderer: the vendor player is loaded with a dynamic import so it
 * never enters the initial /classroom chunk. A disposed WebGL2 context is
 * never reused — every mount creates a brand-new canvas.
 */
export class LivLivRenderer implements AvatarRenderer {
  private player: LivLivPlayerLike | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly creditElement: HTMLElement | null;
  private readonly options: LivLivRendererOptions;
  private phase: AvatarPhase;
  private sequence = 0;
  private disposed = false;

  constructor(options: LivLivRendererOptions = {}) {
    this.options = options;
    this.creditElement = options.creditElement ?? null;
    this.phase = options.phase ?? "idle";
  }

  private async playerClass(): Promise<LivLivPlayerClass> {
    if (this.options.PlayerRef) return this.options.PlayerRef;
    const vendor = (await import("./vendor/index.js")) as unknown as {
      Player: LivLivPlayerClass;
    };
    return vendor.Player;
  }

  private removeCanvas(): void {
    this.canvas?.remove();
    this.canvas = null;
  }

  private releasePlayer(): void {
    if (!this.player) return;
    try {
      this.player.dispose();
    } catch {
      // Player already released; nothing else to clean up.
    }
    this.player = null;
  }

  private showCredit(): void {
    if (!this.creditElement) return;
    this.creditElement.textContent = LIVLIV_CREDIT;
    this.creditElement.hidden = false;
  }

  private hideCredit(): void {
    if (this.creditElement) this.creditElement.hidden = true;
  }

  async mount(container: HTMLElement): Promise<void> {
    if (this.disposed) throw new Error("renderer_disposed");

    const characterId = this.options.characterId ?? DEFAULT_LIVLIV_CHARACTER;
    const url = livlivCharacterUrl(characterId);
    if (!url) throw new Error("personagem_invalido");

    const PlayerRef = await this.playerClass();
    if (typeof PlayerRef.isSupported === "function" && !PlayerRef.isSupported()) {
      throw new Error("webgl2_indisponivel");
    }

    const attempt = ++this.sequence;
    // Release before instantiating; a WebGL2 context is not reusable.
    this.releasePlayer();
    this.removeCanvas();

    const doc =
      this.options.documentRef ??
      container.ownerDocument ??
      globalThis.document;
    if (!doc) throw new Error("palco_indisponivel");

    const canvas = doc.createElement("canvas");
    canvas.className = "dt-classroom__livliv-canvas";
    canvas.width = 320;
    canvas.height = 400;
    canvas.setAttribute("aria-hidden", "true");
    container.insertBefore(canvas, container.firstChild);
    this.canvas = canvas;

    const reduceMotion =
      doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ===
      true;

    let next: LivLivPlayerLike | null = null;
    try {
      next = new PlayerRef(canvas, {
        lang: "pt-BR",
        maxPixelRatio: 1,
        followPointer: false,
        idle: !reduceMotion,
      });
      await next.load(url, { poster: null });
    } catch (error) {
      try {
        next?.dispose();
      } catch {
        // Nothing left to release.
      }
      this.removeCanvas();
      this.hideCredit();
      throw error;
    }

    if (this.disposed || attempt !== this.sequence) {
      try {
        next.dispose();
      } catch {
        // Nothing left to release.
      }
      this.removeCanvas();
      this.hideCredit();
      return;
    }

    this.player = next;
    this.showCredit();
  }

  setState(phase: AvatarPhase): void {
    this.phase = phase;
  }

  getState(): AvatarPhase {
    return this.phase;
  }

  /** Sole writer of mouth parameters; no speech driver is used here. */
  setAmplitude(mouthOpen: number, vowel: number): void {
    if (!this.player || this.player.disposed) return;
    this.player.params.mouthOpen = clamp(mouthOpen, 0, 1);
    this.player.params.vowel = clamp(vowel, -1, 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sequence += 1;
    this.releasePlayer();
    this.removeCanvas();
    this.hideCredit();
  }
}
