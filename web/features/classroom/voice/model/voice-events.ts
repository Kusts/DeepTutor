// Contrato do barramento de eventos da sala. Todos os payloads são objetos
// simples e serializáveis: a UI e o avatar (fatia 3B) consomem sem conhecer a
// implementação de captura/síntese. Nenhum campo secreto entra aqui.

export type VoiceEventPayload = Record<string, unknown>;

/**
 * Mapa de eventos conhecidos. A assinatura de índice mantém o barramento
 * extensível para novos eventos da fatia 3B sem perder tipagem dos existentes.
 */
export type VoiceEventMap = {
  'speech-start': { at: number; rms: number; playbackActive: boolean; continuacao?: boolean };
  'speech-end': { at: number; reason: 'stop' | 'hangover'; durationMs: number };
  'vad-descartado': {
    reason: string;
    durationMs: number;
    at: number;
    rms: number;
    zcr: number;
  };
  'transcription': {
    text: string;
    bruto: string;
    at: number;
    durationMs: number;
    corrigiu: boolean;
  };
  'transcricao-descartada': { reason: string; chars: number; durationMs?: number };
  'audio-state': { state: string; unlocked: boolean };
  'audio-session': Record<string, unknown>;
  'audio-bloqueado': { reason: string };
  'audio-destravado': { at: number };
  'tts-chunk': { turnId: string | null; index: number; at: number; chars: number };
  'tts-drain': Record<string, never>;
  'tts-error': { message: string; code: string | null };
  'tts-gap': { turnId: string | null; index: number; gapMs: number; at: number };
  'tts-descartado': {
    turnId: string | null;
    index: number;
    reason: string;
    attempts: number;
    at: number;
  };
  'phase': { name: string; at: number; turnId?: string | null; [key: string]: unknown };
  'metric': { name: string; value: number; turnId?: string | null };
  'aviso': { texto: string; motivo?: string | null };
  'mode': { mode: string };
  'interrupted': {
    reason: string;
    clientId?: string | null;
    turnId?: string | null;
    generation?: number;
  };
  'clip': { mimeType: string; bytes: number; fallback: boolean; magic: string };
  'microfone-sem-sinal': { nodeKind: string | null; frames: number };
  'captura-interrompida': { reason: string };
  'state': { name: string; [key: string]: unknown };
} & Record<string, VoiceEventPayload>;

export type VoiceEventType = keyof VoiceEventMap & string;
