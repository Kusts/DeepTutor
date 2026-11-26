// Clientes REST nativos do DeepTutor. Nenhuma chave de provedor é vista aqui:
// a sessão autenticada (cookie dt_token) é enviada pelo navegador (same-origin).
// Toda chamada passa por apiFetch/apiUrl de @/lib/api — nunca fetch cru.
// Sem streaming: /api/voice/stt devolve { text }, /api/voice/tts devolve bytes.

import { apiFetch, apiUrl } from '@/lib/api';

function safeDetail(text: unknown): string {
  return String(text ?? '').slice(0, 200);
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type VoiceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { skipAuthRedirect?: boolean },
) => Promise<Response>;
export type VoiceUrl = (path: string) => string;

export interface VoiceClientOptions {
  fetchImpl?: VoiceFetch;
  url?: VoiceUrl;
  attempts?: number;
}

export interface TranscribeOptions extends VoiceClientOptions {
  language?: string;
  filename?: string;
}

export interface SynthesizeOptions extends VoiceClientOptions {
  signal?: AbortSignal;
  voice?: string | null;
  format?: string | null;
}

export interface SessionOptions extends VoiceClientOptions {}

/** Último payload bruto do STT (somente o que o servidor realmente respondeu). */
let ultimaRespostaStt: Record<string, unknown> | null = null;
export function metadadosUltimaTranscricao(): Record<string, unknown> | null {
  return ultimaRespostaStt ? { ...ultimaRespostaStt } : null;
}

/** POST /api/voice/stt (multipart: file + language), com retentativa transitória. */
export async function transcribeAudio(
  blob: Blob,
  {
    language = 'pt',
    filename = 'fala.wav',
    fetchImpl = apiFetch,
    url = apiUrl,
    attempts = 3,
  }: TranscribeOptions = {},
): Promise<string> {
  let lastError: Error | undefined;
  for (let i = 0; i < attempts; i += 1) {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('language', language);
    const response = await fetchImpl(url('/api/voice/stt'), {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });
    if (response.ok) {
      const data: unknown = await response.json();
      const text = (data as { text?: unknown } | null)?.text;
      if (typeof text !== 'string') throw new Error('STT devolveu resposta sem texto');
      // O endpoint nativo devolve SOMENTE { text }. Guardamos o payload cru
      // para diagnóstico/futuros metadados, sem inventar confiança.
      ultimaRespostaStt = { ...(data as Record<string, unknown>), at: Date.now() };
      return String(text).trim();
    }
    lastError = new Error(`STT falhou (HTTP ${response.status}): ${safeDetail(await response.text().catch(() => ''))}`);
    if (!TRANSIENT.has(response.status) || i === attempts - 1) break;
    await sleep(600 * (i + 1));
  }
  throw lastError ?? new Error('STT falhou');
}

/** POST /api/voice/tts ({text, voice?, format?}) -> bytes de áudio.
 *  O perfil ativo é Edge TTS (`audio/mpeg`); o player usa Blob URL e é
 *  independente do formato. Respostas WAV de outros perfis continuam válidas.
 */
export async function synthesizeAudio(
  text: string,
  {
    signal,
    fetchImpl = apiFetch,
    url = apiUrl,
    attempts = 2,
    voice = null,
    format = null,
  }: SynthesizeOptions = {},
): Promise<Blob> {
  let lastError: (Error & { code?: string }) | undefined;
  const body: Record<string, string> = { text };
  // Confirmado em services/voice: /api/voice/tts aceita { text, voice?, format? }
  // e o adaptador edge aplica `voice` por chamada — troca no menu sem catálogo.
  if (voice) body.voice = voice;
  if (format) body.format = format;
  for (let i = 0; i < attempts; i += 1) {
    const response = await fetchImpl(url('/api/voice/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
    if (response.ok) return response.blob();
    if (response.status === 429) {
      const error = new Error('TTS: cota excedida (429)') as Error & { code: string };
      error.code = 'TTS_429';
      throw error;
    }
    const error = new Error(
      `TTS falhou (HTTP ${response.status}): ${safeDetail(await response.text().catch(() => ''))}`,
    ) as Error & { code: string };
    error.code = `TTS_${response.status}`;
    lastError = error;
    // Com Edge TTS não há cota por janela: 502/503/504 são falhas transitórias
    // de rede e merecem apenas backoff curto (antes era 15 s por causa do Gemini).
    if (![502, 503, 504].includes(response.status) || i === attempts - 1) break;
    await sleep(600 * (i + 1));
  }
  throw lastError ?? new Error('TTS falhou');
}

/** Verifica a sessão autenticada; chamada na carga da página. */
export async function checkSession({
  fetchImpl = apiFetch,
  url = apiUrl,
}: SessionOptions = {}): Promise<{ ok: boolean; status: number }> {
  const response = await fetchImpl(url('/api/sessions'), { credentials: 'same-origin' });
  return { ok: response.ok, status: response.status };
}
