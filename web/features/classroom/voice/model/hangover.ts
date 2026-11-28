// Lógica pura de hangover/retomada: fala que volta pouco depois do fim é a
// MESMA frase (pausa), não um novo turno. Testável sem DOM nem áudio.

export const RESUME_WINDOW_MS = 400;

/** Uma fala iniciada em `startAt` continua o segmento encerrado em `endAt`? */
export function isContinuation(
  endAt: number | null | undefined,
  startAt: number | null | undefined,
  windowMs = RESUME_WINDOW_MS,
): boolean {
  if (!Number.isFinite(endAt) || !Number.isFinite(startAt)) return false;
  const delta = (startAt as number) - (endAt as number);
  return delta >= 0 && delta <= windowMs;
}

/** Mescla segmentos consecutivos, descartando vazios e preservando a ordem. */
export function mergeSegments(segments: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    const texto = String(segment ?? '').trim();
    if (!texto) continue;
    const last = out[out.length - 1];
    if (last) out[out.length - 1] = `${last} ${texto}`.trim();
    else out.push(texto);
  }
  return out;
}
