import { describe, expect, it } from 'vitest';

import { normalizarMarkdown } from '@/features/classroom/voice/model/markdown-text';
import {
  chunkForSpeech,
  expandInlineCode,
  groupForSpeech,
  speakableChunks,
  speakableGroups,
  toSpeakable,
} from '@/features/classroom/voice/model/speakable-text';

describe('normalizarMarkdown', () => {
  it('quebra cabeçalho colado no parágrafo anterior', () => {
    expect(normalizarMarkdown('Experimente.Olá! Vamos continuar.## 1. Primeiro passo\nTexto.'))
      .toBe('Experimente.Olá! Vamos continuar.\n\n## 1. Primeiro passo\nTexto.');
  });

  it('não altera conteúdo dentro de bloco de código', () => {
    const entrada = 'Antes.\n```python\nprint("a")## nao é titulo\n```\nDepois.';
    expect(normalizarMarkdown(entrada)).toBe(entrada);
  });

  it('normaliza CRLF, excesso de linhas vazias e entrada vazia', () => {
    expect(normalizarMarkdown('  Um\r\n\r\n\r\nDois  \n')).toBe('Um\n\nDois');
    expect(normalizarMarkdown('#\n\n# Primeiro passo\n\nTexto.')).toBe('# Primeiro passo\n\nTexto.');
    expect(normalizarMarkdown(null)).toBe('');
    expect(normalizarMarkdown('   \n')).toBe('');
  });
});

describe('texto falável', () => {
  it('remove blocos de código, código inline e mantém a narrativa depois', () => {
    const md = 'Primeiro a explicação.\n\n```python\nprint(x)\n```\n\nDepois do código, exercícios.\n\n```js\nlet y=1;\n```\n\nSua vez: responda.';
    const out = toSpeakable(md);
    expect((out.match(/O código está na tela\./g) ?? [])).toHaveLength(1);
    expect(out).toContain('Primeiro a explicação');
    expect(out).toContain('Depois do código, exercícios');
    expect(out).toContain('Sua vez: responda');
    expect(out).not.toContain('print');
  });

  it('descarta URLs longas, mas mantém o rótulo do link', () => {
    const md = 'Leia [a documentação](https://exemplo.com/um/caminho/muito/longo/para/nao/ser/lido) e acesse https://outro.site/a/b/c?x=1 agora.';
    const out = toSpeakable(md);
    expect(out).toContain('Leia a documentação');
    expect(out).not.toContain('https://');
    expect(out).not.toContain('exemplo.com');
  });

  it('remove fórmulas, tabelas e marcações mantendo acentos', () => {
    const md = '## Título Ação\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nA fórmula $x^2 + y^2$ some. **Negrito**, *ênfase* e ~~riscado~~ ficam.';
    const out = toSpeakable(md);
    expect(out).toContain('Título Ação');
    expect(out).toContain('Negrito, ênfase e riscado');
    expect(out).not.toContain('x^2');
    expect(out).not.toContain('|');
    expect(out).toContain('Ação');
  });

  it('listas numeradas viram ordinais e nenhum item é calado', () => {
    const md = 'Os passos são:\n\n1. Crie uma variável\n2. Use um loop for\n3. Imprima a lista\n\nAgora pratique.';
    const out = toSpeakable(md);
    expect(out).toContain('Primeiro, Crie uma variável');
    expect(out).toContain('Segundo, Use um loop for');
    expect(out).toContain('Terceiro, Imprima a lista');
    expect(out).toContain('Agora pratique');
  });

  it('fala código inline curto e locuta expressões simples', () => {
    expect(expandInlineCode('variavel')).toBe('variavel');
    expect(expandInlineCode('print()')).toBe('print');
    expect(expandInlineCode('x = 5')).toBe('x recebe 5');
    const out = toSpeakable('Use `idade` e `x = 5` na função. Certo?');
    expect(out).toContain('idade');
    expect(out).toContain('x recebe 5');
    expect(out).toContain('função');
  });

  it('não trunca texto longo e preserva seções após tabelas', () => {
    const base = 'Vamos estudar variáveis e listas com calma. ';
    const md = `${base.repeat(30)}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDepois da tabela, o resumo final.`;
    const out = toSpeakable(md);
    expect(out.length).toBeGreaterThan(1200);
    expect(out).toContain('resumo final');
    expect(out).not.toContain('|');
  });
});

describe('fatiamento para TTS', () => {
  it('chunkForSpeech preserva acentos e divide por frases', () => {
    const text = 'Primeiro, entendemos variáveis. Depois, exemplos práticos. Por fim, exercícios de fixação.';
    const chunks = chunkForSpeech(text, { maxChars: 60 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join(' ')).toBe(text);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
  });

  it('não quebra abreviações pt-BR e quebra sentenças longas por cláusulas', () => {
    const abreviado = chunkForSpeech('O Dr. Silva explicou. Depois, a Sra. Ana chegou.', { maxChars: 80 });
    expect(abreviado.some((c) => c.includes('Dr. Silva'))).toBe(true);
    expect(abreviado.some((c) => c.includes('Sra. Ana'))).toBe(true);

    const text = 'Vamos usar uma analogia com caixas, etiquetas e números, e depois comparar com a vida real, sempre com calma.';
    const chunks = chunkForSpeech(text, { maxChars: 45 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.length <= 45)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('speakableChunks lida com código, URL e acentos de uma vez', () => {
    const md = 'Olá! Para começar, veja `print("oi")` e depois leia https://site.longo/a/b.\n\nAgora, **variáveis** são caixas com nomes, como *idade* e *nota*.';
    const joined = speakableChunks(md, { maxChars: 90 }).join(' ');
    expect(joined).toContain('Olá!');
    expect(joined).toContain('variáveis são caixas');
    expect(joined).toContain('idade');
    expect(joined).not.toContain('https://');
    expect(joined).not.toContain('print');
  });

  it('groupForSpeech agrupa em trechos naturais sem perder palavras', () => {
    const texto = [
      'Olá, hoje vamos falar de variáveis.',
      'Uma variável guarda um valor na memória do computador.',
      'Por exemplo, idade recebe o número quinze.',
      'Depois usamos essa variável em uma função.',
      'A função transforma o valor e devolve o resultado.',
      'Por fim, imprimimos o resultado na tela.',
    ].join(' ');
    const grupos = groupForSpeech(texto, { minChars: 120, maxChars: 280, firstMaxChars: 120, maxSentences: 3 });
    expect(grupos.length).toBeGreaterThanOrEqual(2);
    expect(grupos[0]!.length).toBeLessThanOrEqual(120);
    expect(grupos.every((g) => g.length <= 280 && g.length > 0)).toBe(true);
    expect(grupos.join(' ')).toBe(texto.replace(/\s+/g, ' ').trim());
  });

  it('speakableGroups lida com Markdown longo e entradas vazias', () => {
    const md = '## Variáveis\n\n' + 'Uma variável é como uma caixa com nome. '.repeat(40)
      + '\n\n1. Primeiro passo\n2. Segundo passo';
    const grupos = speakableGroups(md);
    expect(grupos.length).toBeGreaterThanOrEqual(3);
    expect(grupos.some((g) => g.includes('Primeiro passo'))).toBe(true);
    expect(grupos.every((g) => g.length <= 280)).toBe(true);

    expect(toSpeakable('')).toBe('');
    expect(chunkForSpeech('   ')).toEqual([]);
    expect(speakableChunks('```js\nlet x=1;\n```')).toEqual([]);
  });
});
