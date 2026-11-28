/**
 * Minimal renderer contract for the classroom avatar. The classroom never
 * drives audio or a second pedagogical agent: implementations only render a
 * phases and (later) a mouth amplitude supplied by the voice slice.
 */
/**
 * Fases públicas do avatar. `idle` e `connecting` são as originais (fatia 3A);
 * as demais são alimentadas pela sessão de voz da fatia 3B, sempre sem
 * iniciar um segundo agente pedagógico nem áudio próprio no renderizador.
 */
export type AvatarPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "explaining"
  | "interrupted"
  | "error";

export interface AvatarRenderer {
  /** Creates a fresh rendering surface inside `container`. */
  mount(container: HTMLElement): Promise<void>;
  /** Renders an idle/connecting state; never starts audio or speech. */
  setState(phase: AvatarPhase): void;
  /** Sole entry point for mouth parameters; values are clamped by the renderer. */
  setAmplitude(mouthOpen: number, vowel: number): void;
  /** Releases the rendering surface and any credit element it owns. */
  dispose(): void;
}
