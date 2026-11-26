// Limitador de STT no cliente: o plano gratuito do Groq aceita ~20 RPM.
// Teto conservador de 15/min com janela deslizante, fila e retry de 429
// usando o "Please try again in Ns" devolvido pelo provedor.
// Lógica pura (now/sleep injetados): testável sem rede e sem timers reais.

export const STT_MIN_LIMIT = 15;
export const STT_WINDOW_MS = 60_000;
export const STT_DEFAULT_BACKOFF_MS = 6000;

/** Extrai segundos de mensagens como "Please try again in 13s" / "retry in 5". */
export function parseRetryAfter(texto: unknown, agora = Date.now()): number | null {
  const str = String(texto ?? '');
  const segundos = /try again in\s+(\d+(?:[.,]\d+)?)\s*s/i.exec(str)
    ?? /retry(?:\s+in)?\s+(\d+(?:[.,]\d+)?)\s*s?/i.exec(str)
    ?? /after:\s*(\d+(?:[.,]\d+)?)/i.exec(str);
  if (segundos) return Math.max(0, Math.ceil(Number(segundos[1].replace(',', '.')) * 1000));
  const abs = Date.parse(str);
  if (Number.isFinite(abs)) return Math.max(0, abs - agora);
  return null;
}

export type ErrorLike = { message?: unknown; code?: string } | string | null | undefined;

export interface TakeResult {
  allowed: boolean;
  waitMs: number;
  motivo?: 'cooldown_429' | 'limite_por_minuto';
}

export interface RateLimitErrorInfo {
  code: string;
  waitMs: number;
  at: number;
}

export interface RateLimiterOptions {
  maxPerMinute?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (result: TakeResult) => void;
}

export class SttRateLimiter {
  readonly maxPerMinute: number;
  readonly windowMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onWait: (result: TakeResult) => void;
  timestamps: number[] = [];
  cooldownUntil = 0;
  consumed = 0;
  blocked = 0;
  retries = 0;
  lastError: RateLimitErrorInfo | null = null;

  constructor({
    maxPerMinute = STT_MIN_LIMIT,
    windowMs = STT_WINDOW_MS,
    now = () => Date.now(),
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    onWait = () => {},
  }: RateLimiterOptions = {}) {
    this.maxPerMinute = Math.max(1, Math.floor(maxPerMinute));
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
    this.onWait = onWait;
  }

  /** Remove registros mais antigos que a janela deslizante. */
  #trim(t = this.now()): void {
    this.timestamps = this.timestamps.filter((ts) => t - ts < this.windowMs);
  }

  /** Reserva um slot: devolve {allowed, waitMs}. Não dorme. */
  take(t = this.now()): TakeResult {
    this.#trim(t);
    const ateCooldown = Math.max(0, this.cooldownUntil - t);
    if (ateCooldown > 0) {
      this.blocked += 1;
      return { allowed: false, waitMs: ateCooldown, motivo: 'cooldown_429' };
    }
    if (this.timestamps.length >= this.maxPerMinute) {
      const waitMs = Math.max(1, this.windowMs - (t - this.timestamps[0]));
      this.blocked += 1;
      return { allowed: false, waitMs, motivo: 'limite_por_minuto' };
    }
    this.timestamps.push(t);
    this.consumed += 1;
    return { allowed: true, waitMs: 0 };
  }

  /** Espera até haver slot e então reserve. Usa o sleep injetado. */
  async waitForSlot(): Promise<boolean> {
    for (let tentativa = 0; tentativa < 40; tentativa += 1) {
      const r = this.take();
      if (r.allowed) return true;
      this.onWait(r);
      await this.sleep(Math.min(r.waitMs, this.windowMs));
    }
    return false;
  }

  /** Registra 429: aplica o retry-after do provedor ou backoff padrão. */
  registerError(error: ErrorLike, { retryAfterMs = null }: { retryAfterMs?: number | null } = {}): number {
    const message = typeof error === 'object' && error !== null ? error.message : error;
    const mensagem = String(message ?? error ?? '');
    const sugerido = retryAfterMs === null ? parseRetryAfter(mensagem, this.now()) : Number(retryAfterMs);
    const espera = Number.isFinite(sugerido) && (sugerido as number) > 0 ? (sugerido as number) : STT_DEFAULT_BACKOFF_MS;
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + espera);
    this.retries += 1;
    const code = typeof error === 'object' && error !== null ? error.code : undefined;
    this.lastError = { code: code ?? 'HTTP_429', waitMs: Math.round(espera), at: this.now() };
    // A tentativa que falhou não conta como consumida: devolve o slot.
    this.timestamps.pop();
    return espera;
  }

  get debug(): {
    slotsEmJanela: number;
    limite: number;
    consumidos: number;
    bloqueios: number;
    retries: number;
    cooldownMs: number;
    ultimoErro: RateLimitErrorInfo | null;
  } {
    this.#trim();
    return {
      slotsEmJanela: this.timestamps.length,
      limite: this.maxPerMinute,
      consumidos: this.consumed,
      bloqueios: this.blocked,
      retries: this.retries,
      cooldownMs: Math.max(0, Math.round(this.cooldownUntil - this.now())),
      ultimoErro: this.lastError ? { ...this.lastError } : null,
    };
  }
}
