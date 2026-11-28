// Barreira de qualidade antes de enviar uma transcrição ao LLM.
// Ruído não é pergunta: descartes são registrados por motivo, sem turno novo.
// Lista configurável e testável; nenhuma rede, nenhuma chave, nenhum efeito externo.
//
// Etapa 2f: lista ampliada de alucinações do Whisper em pt-BR/en (inclui
// "Legenda por Sônia Ruberti"), detecção de repetição idêntica em janela curta,
// checagem de idioma quando o chamador a fornece e correção conservadora de
// termos do domínio ("doutor" -> "tutor" somente no início de frase).
// O endpoint REST /api/voice/stt do DeepTutor devolve APENAS { text } — não há
// no_speech_prob/avg_logprob/segments (confirmado em services/voice). Por isso
// nenhuma pontuação de confiança é inventada aqui: ela só entra se o chamador
// fornecer `confidence` obtida de alguma fonte real.

export interface FilterDefaults {
  minChars: number;
  minUsefulMs: number;
  duplicateWindowMs: number;
  expectedLanguage: string;
  hallucinationPatterns: readonly RegExp[];
}

export const FILTER_DEFAULTS: Readonly<FilterDefaults> = Object.freeze({
  minChars: 2,
  minUsefulMs: 400,
  duplicateWindowMs: 3000,
  expectedLanguage: 'pt-BR',
  // Frases típicas de "alucinação" do Whisper sobre ruído/silêncio em pt-BR/en.
  hallucinationPatterns: Object.freeze([
    /^\s*(?:obrigad[oa]s?(?:\s+por\s+(?:assistir|ver|ouvir|assistindo))?|legendas?|inscreva[-\s]?se|inscreva[-\s]?se\s+no\s+canal|tchau|tchau\s+tchau|adeus|até\s+logo|the\s+end|thank\s+you(?:\s+for\s+watching)?|thanks\s+for\s+watching|amara\.?org|subtitles?|closed\s+captions?(?:\s+by)?|captions?|music|música|silêncio|silence|you|yes|no|hmm|hm|ah|ok|okay)\s*[.!?…,]*\s*$/i,
    /^\s*(?:\.|\.\.\.|…|-|_|~|\s)+$/u,
    /^\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/,
    // Legendas automáticas: "Legenda por Sônia Ruberti", "Legendas pela comunidade
    // Amara.org", "Transcrição e legendas por ...", variações sem acento.
    /^\s*legendas?\b/i,
    /^\s*(?:transcrição|transcricao)\s+e\s+legendas?\b/i,
    /\bamara\.?\s*org\b/i,
    /\b(?:s[ôo]nia\s+ruberti|ruberti)\b/i,
    /^\s*(?:e\s+a[ií]|é|ahn+|ham|hum+|uhm+|uh+|legal|certo|então|entao|beleza)\s*[.!?…,]*\s*$/iu,
    /^\s*(?:e\s+a[ií])(?:\s*[,.]?\s*e\s+a[ií])+\s*[.!?…,]*\s*$/iu,
    // A mesma palavra repetida ("sim sim sim", "não não não") é alucinação
    // sobre silêncio/ruído, não conteúdo didático.
    /^\s*(\p{L}{2,})(?:[\s,]+)\1(?:[\s,]+(?:\1))*\s*[.!?…]*\s*$/iu,
  ]),
});

const LANG_NORMALIZE = (lang: unknown): string =>
  String(lang ?? '').toLowerCase().replace('_', '-');

export type ClassificationReason =
  | 'vazio'
  | 'fala_curta_demais'
  | 'so_pontuacao'
  | 'muito_curta'
  | 'alucinacao'
  | 'repetida'
  | 'idioma_diferente'
  | 'baixa_confianca'
  | 'ok';

export interface Classification {
  accepted: boolean;
  reason: ClassificationReason;
}

export interface ClassifyOptions {
  minChars?: number;
  minUsefulMs?: number;
  durationMs?: number | null;
  hallucinationPatterns?: readonly RegExp[];
  previousText?: string | null;
  sinceLastMs?: number | null;
  duplicateWindowMs?: number;
  detectedLanguage?: string | null;
  expectedLanguage?: string;
  confidence?: number | null;
}

/**
 * Classifica uma transcrição: `{ accepted, reason }`. `reason` é estável para métricas.
 *
 * Opções novas (todas opcionais, compatíveis com chamadas antigas):
 * - `previousText` + `sinceLastMs`: repetição idêntica em janela curta -> 'repetida'.
 * - `detectedLanguage`: quando fornecido e diferente de `expectedLanguage` -> 'idioma_diferente'.
 * - `confidence`: quando fornecido (0..1) e muito baixo com até 2 palavras -> 'baixa_confianca'.
 */
export function classifyTranscription(text: unknown, {
  minChars = FILTER_DEFAULTS.minChars,
  minUsefulMs = FILTER_DEFAULTS.minUsefulMs,
  durationMs = null,
  hallucinationPatterns = FILTER_DEFAULTS.hallucinationPatterns,
  previousText = null,
  sinceLastMs = null,
  duplicateWindowMs = FILTER_DEFAULTS.duplicateWindowMs,
  detectedLanguage = null,
  expectedLanguage = FILTER_DEFAULTS.expectedLanguage,
  confidence = null,
}: ClassifyOptions = {}): Classification {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return { accepted: false, reason: 'vazio' };
  if (Number.isFinite(durationMs) && (durationMs as number) < minUsefulMs) {
    return { accepted: false, reason: 'fala_curta_demais' };
  }
  if (!/\p{L}|\p{N}/u.test(clean)) return { accepted: false, reason: 'so_pontuacao' };
  const letters = clean.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length <= minChars) return { accepted: false, reason: 'muito_curta' };
  for (const pattern of hallucinationPatterns) {
    if (pattern.test(clean)) return { accepted: false, reason: 'alucinacao' };
  }
  // Repetição idêntica à transcrição anterior em menos de 3 s: eco/ruído
  // reinterpretado pelo STT, não uma nova pergunta.
  if (previousText && Number.isFinite(sinceLastMs) && (sinceLastMs as number) >= 0
      && (sinceLastMs as number) < duplicateWindowMs && clean === String(previousText).trim()) {
    return { accepted: false, reason: 'repetida' };
  }
  if (detectedLanguage && LANG_NORMALIZE(detectedLanguage) !== LANG_NORMALIZE(expectedLanguage)
      && !LANG_NORMALIZE(detectedLanguage).startsWith('pt')) {
    return { accepted: false, reason: 'idioma_diferente' };
  }
  const wordCount = clean.split(/\s+/u).filter(Boolean).length;
  if (Number.isFinite(confidence) && (confidence as number) < 0.55 && wordCount <= 2) {
    return { accepted: false, reason: 'baixa_confianca' };
  }
  return { accepted: true, reason: 'ok' };
}

/**
 * Correção pós-STT estritamente conservadora: troca "doutor" por "tutor"
 * somente quando a frase é um cumprimento dirigido ao Tutor no início.
 * Nada de adivinhação sobre o meio da frase ("O doutor explicou...").
 */
export function corrigirTranscricao(text: unknown): { text: string; changed: boolean } {
  const original = typeof text === 'string' ? text : '';
  const corrigida = original
    .replace(/^(\s*(?:olá|ola|oi|bom\s+dia|boa\s+tarde|boa\s+noite)[,!]?\s+)doutor\b/iu, '$1tutor')
    .replace(/^\s*doutor\s*[,!]\s*/iu, (match) => match.replace(/doutor/iu, 'Tutor'));
  return { text: corrigida, changed: corrigida !== original };
}

/** Número de palavras úteis (para a regra de confirmação de falas curtas). */
export function contarPalavras(text: unknown): number {
  return String(text ?? '').trim().split(/\s+/u).filter((p) => /\p{L}|\p{N}/u.test(p)).length;
}

export interface DiscardItem {
  reason: string;
  at: number;
  [key: string]: unknown;
}

/** Contador de descartes por motivo, com limite para não crescer sem controle. */
export class DiscardLog {
  readonly limit: number;
  itens: DiscardItem[] = [];
  contagem: Record<string, number> = Object.create(null) as Record<string, number>;

  constructor(limit = 200) {
    this.limit = limit;
  }

  add(reason: string, detalhe: Record<string, unknown> = {}): DiscardItem {
    const item: DiscardItem = { reason, at: Date.now(), ...detalhe };
    this.itens.unshift(item);
    if (this.itens.length > this.limit) this.itens.length = this.limit;
    this.contagem[reason] = (this.contagem[reason] ?? 0) + 1;
    return item;
  }

  get all(): DiscardItem[] {
    return this.itens.map((item) => ({ ...item }));
  }

  get resumo(): Record<string, number> {
    return { ...this.contagem };
  }
}
