// Barramento de eventos minúsculo, sem dependências e sem `any`.
// Usado para expor à UI e ao avatar (fatia 3B) os eventos de estado e de turno.

import type { VoiceEventMap, VoiceEventPayload } from './voice-events';

export type BusEvent<
  M extends Record<string, VoiceEventPayload>,
  K extends keyof M & string,
> = Readonly<{ type: K; at: number } & M[K]>;

export type AnyBusEvent<M extends Record<string, VoiceEventPayload>> = BusEvent<M, keyof M & string>;

type Listener<E> = (event: E) => void;
type StoredListener = (event: unknown) => void;

export class EventBus<M extends Record<string, VoiceEventPayload> = VoiceEventMap> {
  readonly #listeners = new Map<string, Set<StoredListener>>();

  on<K extends keyof M & string = keyof M & string>(
    type: K | '*',
    listener: Listener<BusEvent<M, K>>,
  ): () => void {
    if (typeof listener !== 'function') throw new TypeError('listener deve ser função');
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set<StoredListener>();
      this.#listeners.set(type, set);
    }
    const stored = listener as unknown as StoredListener;
    set.add(stored);
    return () => this.off(type, listener);
  }

  off<K extends keyof M & string = keyof M & string>(
    type: K | '*',
    listener: Listener<BusEvent<M, K>>,
  ): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    set.delete(listener as unknown as StoredListener);
    if (set.size === 0) this.#listeners.delete(type);
  }

  emit<K extends keyof M & string = keyof M & string>(
    type: K | '*',
    payload: Partial<M[K]> = {},
  ): BusEvent<M, K> {
    const event = Object.freeze({ type, at: Date.now(), ...payload }) as unknown as BusEvent<M, K>;
    for (const listener of this.#listeners.get('*') ?? []) listener(event);
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
    return event;
  }

  get types(): string[] {
    return [...this.#listeners.keys()];
  }
}
