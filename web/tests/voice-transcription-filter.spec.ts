import { describe, expect, it } from 'vitest';

import {
  classifyTranscription,
  contarPalavras,
  corrigirTranscricao,
  DiscardLog,
} from '@/features/classroom/voice/model/transcription-filter';
import {
  parseRetryAfter,
  SttRateLimiter,
  STT_MIN_LIMIT,
} from '@/features/classroom/voice/model/stt-rate-limiter';

describe('filtro de transcrição', () => {
  it('aceita perguntas reais em pt-BR', () => {
    for (const texto of [
      'Quero aprender Python do zero',
      'Explique o que é uma variável em uma frase.',
      'Quanto é dois mais dois?',
    ]) {
      expect(classifyTranscription(texto, { durationMs: 1800 })).toEqual({ accepted: true, reason: 'ok' });
    }
  });

  it('descarta vazio, curto, só pontuação e fala abaixo da duração útil', () => {
    expect(classifyTranscription('   ').reason).toBe('vazio');
    expect(classifyTranscription('oi', { durationMs: 900 }).reason).toBe('muito_curta');
    expect(classifyTranscription('...', { durationMs: 900 }).reason).toBe('so_pontuacao');
    expect(classifyTranscription('Pergunta longa válida', { durationMs: 200 }).reason).toBe('fala_curta_demais');
  });

  it('descarta alucinações típicas do Whisper sobre ruído em pt-BR e en', () => {
    const alucinacoes = [
      'Obrigado por assistir', 'Obrigada por assistir.', 'Legendas', 'Inscreva-se',
      'Inscreva-se no canal', 'Tchau', 'Até logo', 'Thank you for watching',
      'Amara.org', 'Subtitles', 'Music', 'Música',
    ];
    for (const texto of alucinacoes) {
      expect(classifyTranscription(texto, { durationMs: 3000 }).reason, texto).toBe('alucinacao');
    }
  });

  it('bloqueia legendista, interjeições e repetição sem confiar na transcrição', () => {
    for (const texto of [
      'Legenda por Sônia Ruberti',
      'Legendas pela comunidade Amara.org',
      'Transcrição e legendas por Sônia Ruberti',
      'Legenda por Sonia Ruberti',
      'E aí',
      'E aí, e aí, e aí',
      'Sim sim sim',
      'Música',
      '[Música]',
      '(música)',
      'Tchau tchau',
    ]) {
      expect(classifyTranscription(texto, { durationMs: 3000 }), texto)
        .toEqual({ accepted: false, reason: 'alucinacao' });
    }
    expect(classifyTranscription('E aí tudo bem?', {
      durationMs: 2500, previousText: 'E aí tudo bem?', sinceLastMs: 1200,
    }).reason).toBe('repetida');
    expect(classifyTranscription('Hello, how are you today?', {
      durationMs: 1500, detectedLanguage: 'en',
    }).reason).toBe('idioma_diferente');
    expect(classifyTranscription('Oi', { durationMs: 1500, confidence: 0.2 }).reason).toBe('muito_curta');
  });

  it('corrige "doutor" apenas no cumprimento inicial e lista é configurável', () => {
    expect(corrigirTranscricao('Olá, doutor, boa tarde.').text).toBe('Olá, tutor, boa tarde.');
    expect(corrigirTranscricao('Doutor, tudo bem?').text).toBe('Tutor, tudo bem?');
    expect(corrigirTranscricao('O doutor explicou a matéria.').text).toBe('O doutor explicou a matéria.');
    expect(corrigirTranscricao('Olá, doutor, boa tarde.').changed).toBe(true);
    expect(contarPalavras('Olá, tutor, boa tarde.')).toBe(4);
    expect(classifyTranscription('eco', { hallucinationPatterns: [/^eco$/i] }).reason).toBe('alucinacao');
  });

  it('contabiliza descartes por motivo com limite', () => {
    const log = new DiscardLog(3);
    log.add('alucinacao', { chars: 12 });
    log.add('curto');
    log.add('curto');
    log.add('vazio');
    log.add('vazio');
    expect(log.resumo).toEqual({ alucinacao: 1, curto: 2, vazio: 2 });
    expect(log.all).toHaveLength(3);
  });
});

describe('limitador de STT', () => {
  function relogio(inicial = 0) {
    let t = inicial;
    return {
      now: () => t,
      passar: (ms: number) => { t += ms; },
      sleep: async (ms: number) => { t += ms; },
    };
  }

  it('lê retry-after do provedor', () => {
    expect(parseRetryAfter('Please try again in 13s', 0)).toBe(13000);
    expect(parseRetryAfter('Rate limit reached. Please try again in 6s.', 0)).toBe(6000);
    expect(parseRetryAfter('retry in 2', 0)).toBe(2000);
    expect(parseRetryAfter('erro qualquer', 0)).toBeNull();
  });

  it('limite é 15 chamadas por minuto com janela deslizante', () => {
    expect(STT_MIN_LIMIT).toBe(15);
    const r = relogio();
    const limiter = new SttRateLimiter({ now: r.now, sleep: r.sleep });
    for (let i = 0; i < 15; i += 1) expect(limiter.take().allowed).toBe(true);
    const negado = limiter.take();
    expect(negado).toMatchObject({ allowed: false, motivo: 'limite_por_minuto', waitMs: 60000 });
    r.passar(60001);
    expect(limiter.take().allowed).toBe(true);
  });

  it('429 usa retry-after e devolve o slot da tentativa falha', () => {
    const r = relogio(1000);
    const limiter = new SttRateLimiter({ now: r.now, sleep: r.sleep });
    limiter.take();
    expect(limiter.registerError(new Error('Please try again in 7s'))).toBe(7000);
    expect(limiter.debug.cooldownMs).toBe(7000);
    expect(limiter.take().allowed).toBe(false);
    r.passar(7001);
    expect(limiter.take().allowed).toBe(true);
    expect(limiter.debug.retries).toBe(1);
  });

  it('429 sem retry-after usa 6 s e waitForSlot espera a janela', async () => {
    expect(new SttRateLimiter({ now: () => 0 }).registerError(new Error('HTTP 429'))).toBe(6000);
    const r = relogio();
    const esperas: number[] = [];
    const limiter = new SttRateLimiter({
      now: r.now,
      sleep: async (ms) => { esperas.push(ms); r.passar(ms); },
    });
    for (let i = 0; i < 15; i += 1) limiter.take();
    expect(await limiter.waitForSlot()).toBe(true);
    expect(esperas).toHaveLength(1);
    expect(limiter.debug.slotsEmJanela).toBe(1);
    expect(JSON.stringify(limiter.debug)).not.toContain('token');
  });
});
