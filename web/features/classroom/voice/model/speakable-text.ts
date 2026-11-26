// falavel.js + prosodia.js portados: converte a resposta do Tutor em texto
// falável e fatia em blocos. O conteúdo COMPLETO (Markdown, código, fórmulas)
// continua indo para a tela; aqui só produzimos o que será enviado ao TTS
// (texto puro, sem SSML). Regras de prosódia em pt-BR aplicadas antes do POST.

// ---------------------------------------------------------------------------
// prosodia: regras PEQUENAS e ORDENADAS que transformam texto em fala pt-BR.
// ---------------------------------------------------------------------------

const UNIDADES = [
  'zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito',
  'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis',
  'dezessete', 'dezoito', 'dezenove',
];
const DEZENAS = ['', 'dez', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cem', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

/** Inteiro até 999.999 por extenso; fora disso mantém a forma original. */
export function inteiroPorExtenso(valor: unknown): string {
  const texto = String(valor ?? '').trim();
  const n = Number(texto);
  if (!Number.isFinite(n) || n < 0) return texto;
  const v = Math.floor(n);
  if (v === 0) return 'zero';
  if (v < 20) return UNIDADES[v];
  if (v < 100) {
    const d = Math.floor(v / 10); const u = v % 10;
    return u ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d];
  }
  if (v < 1000) {
    const c = Math.floor(v / 100); const resto = v % 100;
    const centena = c === 1 && resto === 0 ? 'cem' : CENTENAS[c];
    return resto ? `${centena} e ${inteiroPorExtenso(resto)}` : centena;
  }
  if (v < 1000000) {
    const mil = Math.floor(v / 1000); const resto = v % 1000;
    if (mil === 1) return resto ? `mil e ${inteiroPorExtenso(resto)}` : 'mil';
    return resto ? `${inteiroPorExtenso(mil)} mil e ${inteiroPorExtenso(resto)}` : `${inteiroPorExtenso(mil)} mil`;
  }
  return texto;
}

/** "10.5" / "3,5" -> "dez vírgula cinco" / "três vírgula cinco". */
export function decimalPorExtenso(valor: unknown): string {
  const partes = String(valor ?? '').replace(',', '.').split('.');
  if (partes.length !== 2) return inteiroPorExtenso(valor);
  const decimos = [...partes[1]].map((d) => UNIDADES[Number(d)] ?? d).join(' ');
  return `${inteiroPorExtenso(partes[0])} vírgula ${decimos}`;
}

/** "R$ 10,50" -> "dez reais e cinquenta centavos". */
export function moedaPorExtenso(valor: unknown): string {
  const [inteiro, centavos = ''] = String(valor).replace('.', ',').split(',');
  const reais = inteiroPorExtenso(inteiro);
  if (!centavos) return `${reais} ${reais === 'um' ? 'real' : 'reais'}`;
  const c = centavos.padEnd(2, '0').slice(0, 2);
  const cent = inteiroPorExtenso(c);
  return `${reais} ${reais === 'um' ? 'real' : 'reais'} e ${cent} ${cent === 'um' ? 'centavo' : 'centavos'}`;
}

/** Regra 1: nunca deixar pontuação dupla/contraditória. */
export function corrigirPontuacaoDupla(texto: unknown): string {
  let t = String(texto ?? '');
  t = t.replace(/…+/g, '.');
  t = t.replace(/\s*:\s*\./g, '.');
  t = t.replace(/\s*\?\s*\./g, '?');
  t = t.replace(/\s*!\s*\./g, '!');
  t = t.replace(/,\s*\./g, ',');
  t = t.replace(/;\s*\./g, '.');
  t = t.replace(/\.\s*\./g, '.');
  t = t.replace(/:\s*:/g, ':');
  t = t.replace(/([,;:!?])\s*\1+/g, '$1');
  t = t.replace(/\s+([,.;:!?])/g, '$1');
  return t;
}

/** Regra 2a: travessão/hífen de aposto -> vírgula (pausa curta). */
export function normalizarTravessao(texto: unknown): string {
  return String(texto ?? '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/(?<!\d)\s+-\s+(?!\d)/g, ', ');
}

/** Regra 2b: ";" -> vírgula em cláusula curta, ponto em cláusula longa. */
export function normalizarPontoVirgula(texto: unknown): string {
  return String(texto ?? '').replace(/;/g, (_match: string, offset: number, full: string) => {
    const antes = full.slice(0, offset);
    const inicio = Math.max(
      antes.lastIndexOf('.'), antes.lastIndexOf('!'), antes.lastIndexOf('?'), antes.lastIndexOf('\n'),
    );
    return offset - inicio <= 45 ? ',' : '.';
  });
}

/** Regra 2c: parênteses explicativos curtos -> vírgulas; "()" some. */
export function normalizarParenteses(texto: unknown): string {
  return String(texto ?? '')
    .replace(/\b([A-Za-z_]\w*)\s*\(\s*\)/g, '$1')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\(\s*([^()]{1,60}?)\s*\)/g, (_match: string, inner: string) => {
      const limpo = String(inner).trim();
      return limpo ? `, ${limpo}, ` : ' ';
    })
    .replace(/\s+([,.;:!?])/g, '$1');
}

const MAPA_COMPARACAO: Readonly<Record<string, string>> = Object.freeze({
  '==': ' é igual a ', '!=': ' é diferente de ', '<=': ' menor ou igual a ',
  '>=': ' maior ou igual a ', '<': ' menor que ', '>': ' maior que ',
});
const SIGLAS: Readonly<Record<string, string>> = Object.freeze({
  API: 'A P I', JSON: 'J S O N', HTML: 'H T M L', CPU: 'C P U', SQL: 'S Q L',
});

interface RegraSimbolo {
  id: string;
  re: RegExp;
  fn: (substring: string, ...args: string[]) => string;
}

const REGRAS_SIMBOLOS: RegraSimbolo[] = [
  { id: 'moeda', re: /R\$\s*(\d+(?:[.,]\d{1,2})?)/g, fn: (_m, v) => ` ${moedaPorExtenso(v)} ` },
  { id: 'seta', re: /->|→|⇒/g, fn: () => ' resulta em ' },
  { id: 'aproximadamente', re: /≈/g, fn: () => ' aproximadamente ' },
  { id: 'comparacao', re: /==|!=|<=|>=|<|>/g, fn: (m) => MAPA_COMPARACAO[m] ?? ` ${m} ` },
  { id: 'potencia-caret', re: /(\w)\s*(?:\^|\*\*)\s*2\b/g, fn: (_m, x) => `${x} ao quadrado` },
  { id: 'potencia-2', re: /(\w)²/g, fn: (_m, x) => `${x} ao quadrado` },
  { id: 'potencia-3', re: /(\w)³/g, fn: (_m, x) => `${x} ao cubo` },
  { id: 'vezes-simbolo', re: /\s*×\s*/g, fn: () => ' vezes ' },
  { id: 'divisao-simbolo', re: /\s*÷\s*/g, fn: () => ' dividido por ' },
];

function aplicarRegras(texto: string, regras: readonly RegraSimbolo[]): string {
  return regras.reduce((t, regra) => t.replace(regra.re, regra.fn), texto);
}

/** Regras 3: símbolos com leitura pt-BR natural e consistente. */
export function falarSimbolos(texto: unknown, { contexto = 'geral' }: { contexto?: string } = {}): string {
  let t = aplicarRegras(String(texto ?? ''), REGRAS_SIMBOLOS);

  // Horário antes dos decimais: "10:30" -> "dez e trinta".
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h: string, m: string) => `${inteiroPorExtenso(h)} e ${inteiroPorExtenso(m)}`);
  // Decimais: 10.5 / 3,5 -> "dez vírgula cinco".
  t = t.replace(/\b(\d+(?:[.,]\d+)?)\b/g, (m) => (/[.,]/.test(m) ? decimalPorExtenso(m) : m));
  // "%" operador (resto) ANTES da porcentagem: 10 % 3 não é "10 por cento 3".
  t = t.replace(/\b(\d+)\s*%\s*(\d+)/g, '$1 resto da divisão por $2');
  // Porcentagem: 20% -> "vinte por cento".
  t = t.replace(/\b(\d+(?:\s+vírgula\s+\d+)?)\s*%/g, (_m, n: string) => ` ${/\s+vírgula\s+/.test(n) ? n : decimalPorExtenso(n)} por cento `);

  // Aritmética entre números. Aplica até estabilizar (7 + 8 + 9).
  const aritmeticas: Array<[RegExp, string]> = [
    [/\b(\d+(?:\s+vírgula\s+\d+)?)\s*\+\s*(\d+(?:\s+vírgula\s+\d+)?)/g, '$1 mais $2'],
    [/\b(\d+(?:\s+vírgula\s+\d+)?)\s*-\s*(\d+(?:\s+vírgula\s+\d+)?)/g, '$1 menos $2'],
    [/\b(\d+(?:\s+vírgula\s+\d+)?)\s*\*\s*(\d+(?:\s+vírgula\s+\d+)?)/g, '$1 vezes $2'],
    [/\b(\d+(?:\s+vírgula\s+\d+)?|[A-Za-z_]\w*)\s*\/\s*(\d+(?:\s+vírgula\s+\d+)?|[A-Za-z_]\w*)/g, '$1 dividido por $2'],
  ];
  for (const [re, troca] of aritmeticas) {
    let anterior: string;
    do { anterior = t; t = t.replace(re, troca); } while (t !== anterior);
  }

  // "=": "recebe" em atribuição (identificador = valor), "igual a" em matemática.
  t = t.replace(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-zÀ-ÿ_][\wÀ-ÿ_]*|\d+)/g, '$1 recebe $2');
  if (contexto === 'codigo') {
    t = t.replace(/\b([A-Za-z_]\w*)\s*=\s*([^\s,;)]+)/g, '$1 recebe $2');
  }
  t = t.replace(/\s*=\s*/g, ' igual a ');

  // Colchetes/chaves: frutas[0] -> "frutas, posição zero".
  t = t.replace(/\[\s*\]/g, ' colchetes ').replace(/\{\s*\}/g, ' chaves ');
  t = t.replace(/\b(\w+)\[(\d+)\]/g, (_m, nome: string, idx: string) => `${nome}, posição ${inteiroPorExtenso(idx)}`);
  t = t.replace(/\[([^\]]{1,60})\]/g, (_m, inner: string) => ` colchetes, ${inner}, colchetes `);
  t = t.replace(/\{([^}]{1,60})\}/g, (_m, inner: string) => ` chaves, ${inner}, chaves `);

  // snake_case e sublinhado avulso.
  t = t.replace(/\b([A-Za-zÀ-ÿ]+(?:_[A-Za-zÀ-ÿ]+)+)\b/g, (m) => m.replace(/_/g, ' '));
  t = t.replace(/(^|\s)_(\s|$)/g, '$1sublinhado$2');

  // Siglas por letra (consistente) e booleanos (decisão documentada no ADR).
  t = t.replace(/\b(API|JSON|HTML|CPU|SQL)\b/g, (m) => SIGLAS[m] ?? m);
  t = t.replace(/\bTrue\b/g, 'Verdadeiro').replace(/\bFalse\b/g, 'Falso').replace(/\bNone\b/g, 'None');

  // Aspas decorativas e símbolos que sobraram.
  t = t.replace(/["“”‘’`]/g, ' ');
  t = t.replace(/[\p{Extended_Pictographic}\p{So}\p{Sk}\p{Sm}\p{Cf}]/gu, ' ');
  return t;
}

/** Pipeline completo. `contexto='codigo'` é usado pelo código inline. */
export function normalizarProsodia(texto: unknown, { contexto = 'geral' }: { contexto?: string } = {}): string {
  let t = String(texto ?? '');
  t = corrigirPontuacaoDupla(t);
  t = normalizarTravessao(t);
  t = normalizarPontoVirgula(t);
  t = normalizarParenteses(t);
  t = falarSimbolos(t, { contexto });
  t = corrigirPontuacaoDupla(t);
  // Maiúscula após terminador ajuda o Edge a fechar a entonação da frase.
  t = t.replace(/([.!?])\s+([a-zà-ÿ])/g, (_m, ponto: string, letra: string) => `${ponto} ${letra.toUpperCase()}`);
  t = t.replace(/\be\s+e\b/g, 'e').replace(/\be\s+de\b/g, 'de');
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/,\s*([,.;:])/g, '$1');
  return t.trim();
}

const PALAVRAS_FRACAS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para',
  'com', 'sem', 'sobre', 'entre', 'até', 'desde', 'como', 'que', 'e', 'ou', 'mas',
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'se', 'ao', 'aos', 'à', 'às',
  'pelo', 'pela', 'pelos', 'pelas', 'num', 'numa',
]);

/** Um trecho nunca deve terminar em preposição/artigo. */
export function terminaEmPalavraFraca(texto: unknown): boolean {
  const ultima = String(texto ?? '').trim().split(/\s+/).at(-1) ?? '';
  return PALAVRAS_FRACAS.has(ultima.toLowerCase().replace(/[.,;:!?]+$/, ''));
}

/** Terminador exato: um (e somente um) para o TTS fechar a entonação. */
export function garantirTerminador(texto: unknown, terminador = '.'): string {
  const t = String(texto ?? '').replace(/[.,;:]+$/, '').trim();
  if (!t) return '';
  return /[!?]$/.test(t) ? t : `${t}${terminador}`;
}

const ABBREVIACOES_PROSODIA = [
  'dr', 'dra', 'sr', 'sra', 'prof', 'profa', 'ex', 'etc', 'vs', 'min', 'seg',
  'nº', 'fig', 'cap', 'pág', 'obs', 'aprox',
];
const ABBREV_DOT_PROSODIA = new RegExp(`\\b(${ABBREVIACOES_PROSODIA.join('|')})\\.`, 'gi');
const SENTINELA_PONTO = '\uE000';
const SEP_PONTO = '\uE003';
const SEP_VIRGULA = '\uE004';

/** Protege abreviações, decimais e horários contra quebra de sentença. */
export function protegerParaQuebra(texto: unknown): string {
  return String(texto ?? '')
    .replace(ABBREV_DOT_PROSODIA, (_m, w: string) => w + SENTINELA_PONTO)
    .replace(/\b(\d+)([.,])(\d+)\b/g, (_m, a: string, sep: string, b: string) => a + (sep === '.' ? SEP_PONTO : SEP_VIRGULA) + b)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, '$1#$2')
    .replace(/…/g, SENTINELA_PONTO);
}

export function desprotegerDepoisDeQuebra(texto: unknown): string {
  return String(texto ?? '')
    .split(SENTINELA_PONTO).join('.')
    .split(SEP_PONTO).join('.').split(SEP_VIRGULA).join(',')
    .replace(/#/g, ':');
}

/** Fronteira segura: fim de frase, ou vírgula com trecho já longo o bastante. */
export function ehFronteiraSegura(trecho: unknown, minimo = 60): boolean {
  const t = String(trecho ?? '').trim();
  if (!t) return false;
  if (/[.!?]$/.test(t)) return true;
  return /,$/.test(t) && t.length >= minimo;
}

// ---------------------------------------------------------------------------
// falavel: remove marcações e fatia o texto para o TTS.
// ---------------------------------------------------------------------------

const CODIGO_SENTINEL = '\uE001';
const MOEDA_SENTINEL = '\uE002';

const ORDINAIS = [
  'Primeiro', 'Segundo', 'Terceiro', 'Quarto', 'Quinto',
  'Sexto', 'Sétimo', 'Oitavo', 'Nono', 'Décimo',
];
const OPERADORES: Readonly<Record<string, string>> = Object.freeze({
  '==': ' é igual a ', '=': ' recebe ', '!=': ' é diferente de ',
  '<=': ' menor ou igual a ', '>=': ' maior ou igual a ',
  '<': ' menor que ', '>': ' maior que ',
  '+': ' mais ', '-': ' menos ', '*': ' vezes ', '/': ' dividido por ',
  '%': ' resto da divisão por ',
});

/**
 * Código inline curto é falado; código com argumentos/operadores é locutado.
 * Palavras como `print()` perdem os parênteses e são lidas como "print".
 */
export function expandInlineCode(code: unknown): string {
  const texto = String(code ?? '').trim();
  if (!texto) return '';
  // Função sem argumentos: print() -> print.
  if (/^[A-Za-z_]\w*\s*\(\s*\)$/.test(texto)) {
    return normalizarProsodia(texto.replace(/\s*\(\s*\)$/, ''), { contexto: 'codigo' });
  }
  // Identificador simples (inclui snake_case e booleanos de Python).
  if (/^[\p{L}_][\p{L}\p{N}_]{0,24}$/u.test(texto)) {
    return normalizarProsodia(texto, { contexto: 'codigo' });
  }
  if (/^\d+(?:[.,]\d+)?$/.test(texto)) return normalizarProsodia(texto, { contexto: 'codigo' });
  // Índice de lista: frutas[0] -> "frutas, posição zero".
  if (/^[\p{L}\p{N}_]+\s*\[\s*\d+\s*\]$/u.test(texto)) {
    return normalizarProsodia(texto, { contexto: 'codigo' });
  }
  // Expressão simples: operadores são locutados em português.
  if (/^[\p{L}\p{N}_]+(?:\s*(?:==|!=|<=|>=|=|\+|-|\*|\/|%)\s*[\p{L}\p{N}_]+)+$/u.test(texto)) {
    const locutado = texto.replace(/==|!=|<=|>=|=|\+|-|\*|\/|%/g, (op) => OPERADORES[op] ?? op);
    return normalizarProsodia(locutado, { contexto: 'codigo' });
  }
  return '';
}

const FENCE_RE = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*/gm;
const TABLE_SEP_RE = /^[ \t]*:?-{3,}:?([ \t]*\|[ \t]*:?-{3,}:?)+[ \t]*$/;

/**
 * Remove marcações e conteúdo que não deve ser lido em voz alta.
 * Preserva acentuação e o conteúdo em linguagem natural.
 */
export function toSpeakable(input: unknown): string {
  if (typeof input !== 'string' || !input.length) return '';

  let t = input.replace(/\r\n?/g, '\n');

  // Bloco de código: marcado para anúncio ÚNICO, sem calar o que vem depois.
  // Se a resposta for só código, nada é falado (comportamento legado mantido).
  let codigoAnunciado = false;
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(FENCE_RE, () => {
    if (codigoAnunciado) return ' ';
    codigoAnunciado = true;
    return ` ${CODIGO_SENTINEL} `;
  });
  // Código inline: nomes curtos e expressões simples são falados; o resto some.
  t = t.replace(/`([^`\n]*)`/g, (_match, code: string) => {
    const falado = expandInlineCode(code);
    return falado ? ` ${falado} ` : ' ';
  });

  // Imagens some; link mantém o texto, mas descarta URLs longas.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string) => {
    const label = String(text).trim();
    // Mantém o rótulo legível; descarta apenas quando o próprio rótulo é uma URL.
    return /^(?:https?:\/\/|www\.)/i.test(label) ? ' ' : label;
  });
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, ' ');

  // Decimais LaTeX ($10{,}5$) e potências são falados, não silenciados.
  t = t.replace(/\{,\}/g, ',').replace(/\$(?=\d)/g, '');
  t = t.replace(/\^\{?([23])\}?/g, (_m, n: string) => (n === '2' ? '²' : '³'));
  // Protege R$ antes de remover fórmulas "$...$" (senão o $ da moeda some).
  t = t.replace(/R\$/g, MOEDA_SENTINEL);
  t = t.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  t = t.replace(/\$[^$\n]{1,160}\$/g, ' ');
  t = t.replace(new RegExp(MOEDA_SENTINEL, 'g'), 'R$');
  t = t.split('\n').filter((line) => !/^[ \t]*\|/.test(line) && !TABLE_SEP_RE.test(line)).join('\n');

  // HTML e marcadores Markdown.
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/^[ \t]{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^[ \t]{0,3}>\s?/gm, '');
  // Listas: itens numerados recebem ordinais falados ("Primeiro, …"); os
  // marcadores de lista comuns são apenas removidos, o TEXTO É PRESERVADO.
  t = t.replace(/^[ \t]*(\d{1,2})[.)]\s+/gm, (_match, numero: string) => {
    const indice = Number(numero) - 1;
    return indice >= 0 && indice < ORDINAIS.length ? `${ORDINAIS[indice]}, ` : `${numero}, `;
  });
  t = t.replace(/^[ \t]*[-*+]\s+/gm, '');
  t = t.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  // "_" NÃO é marcador de ênfase aqui: snake_case deve sobreviver (Etapa 2g).
  t = t.replace(/(\*|~~)([\s\S]*?)\1/g, '$2');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, 'e').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");

  // Quebras viram pausa; espaços repetidos colapsam.
  t = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '. ');
  t = t.replace(/^[ .;,:]+|[ .;,:]+$/g, '').trim();
  if (codigoAnunciado) {
    const narrativa = t.split(CODIGO_SENTINEL).join('').replace(/[\s.;,:!?]/g, '').trim();
    t = t.split(CODIGO_SENTINEL).join(narrativa ? ' O código está na tela. ' : ' ').trim();
  }
  t = t.replace(/^[ .;,:]+|[ .;,:]+$/g, '').trim();

  // Etapa 2g: prosódia (pontuação exata, símbolos em pt-BR, parênteses, etc.).
  t = normalizarProsodia(t);
  t = corrigirPontuacaoDupla(t);
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

/** Ajusta uma quebra para não terminar em preposição/artigo. */
function semPalavraFracaNoFim(anterior: string, proxima: string): [string, string] {
  if (!anterior || !terminaEmPalavraFraca(anterior)) return [anterior, proxima];
  const partes = anterior.trim().split(/\s+/);
  if (partes.length < 2) return [anterior, proxima];
  const movida = partes.pop() ?? '';
  return [partes.join(' '), `${movida} ${proxima}`.trim()];
}

function splitClauses(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const parts = sentence.split(/([,;:—–])/).filter(Boolean);
  const clauses: string[] = [];
  let current = '';
  for (const part of parts) {
    const ehPontuacao = /^[,;:—–]$/.test(part);
    const piece = ehPontuacao ? current + part : (current ? current + ' ' + part : part);
    if (piece.length <= maxChars) {
      current = piece;
      continue;
    }
    if (current) clauses.push(current.trim());
    current = '';
    if (ehPontuacao) continue;
    // Cláusula ainda longa: quebra por palavras, sem terminar em palavra fraca.
    for (const word of part.split(/\s+/)) {
      if (!word) continue;
      if ((current + ' ' + word).trim().length > maxChars && current) {
        const [fechada, sobra] = semPalavraFracaNoFim(current.trim(), word);
        if (fechada) clauses.push(fechada);
        current = sobra;
      } else {
        current = (current ? current + ' ' : '') + word;
      }
    }
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses.map((c) => c.trim()).filter(Boolean);
}

export interface ChunkOptions {
  maxChars?: number;
  garantirTerminador?: boolean;
}

/** Fatia texto falável em blocos curtos, respeitando frases e abreviações pt-BR. */
export function chunkForSpeech(text: unknown, { maxChars = 170, garantirTerminador: fechar = false }: ChunkOptions = {}): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const limit = Number.isFinite(maxChars) && maxChars >= 40 ? Math.floor(maxChars) : 170;

  const protegido = protegerParaQuebra(text);
  const sentences = protegido
    .split(/(?<=[.!?])\s+(?=[A-ZÀÁÂÃÄÉÈÊÍÌÎÕÓÔÖÚÙÛÇ0-9"“])/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of sentences) {
    const restored = desprotegerDepoisDeQuebra(sentence);
    for (const clause of splitClauses(restored, limit)) {
      const clean = clause.trim();
      if (clean && !/^[,;.:\s]+$/.test(clean)) chunks.push(fechar ? garantirTerminador(clean) : clean);
    }
  }

  // Junta blocos muito curtos para reduzir o número de requisições de TTS.
  const merged: string[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.length + 1 + chunk.length <= limit) merged[merged.length - 1] = last + ' ' + chunk;
    else merged.push(chunk);
  }
  return merged;
}

/** Conveniência: texto Markdown -> blocos prontos para o TTS. */
export function speakableChunks(markdown: unknown, options: ChunkOptions = {}): string[] {
  return chunkForSpeech(toSpeakable(markdown), options);
}

function quebrarNoEspaco(texto: string, limite: number): string[] {
  if (texto.length <= limite) return [texto];
  const corte = /\s+\S*$/.exec(texto.slice(0, limite + 1));
  if (!corte || corte.index < Math.floor(limite * 0.5)) return [texto];
  const a = texto.slice(0, corte.index).trim();
  const b = texto.slice(corte.index).trim();
  const [fechada, sobra] = semPalavraFracaNoFim(a, b);
  return [fechada, sobra].filter(Boolean);
}

export interface GroupOptions {
  minChars?: number;
  maxChars?: number;
  firstMaxChars?: number;
  maxSentences?: number;
  garantirTerminador?: boolean;
}

/**
 * Agrupa o texto falável em trechos naturais de 1–3 sentenças (alvo 120–280
 * caracteres) para UMA única síntese por trecho — menos requisições, prosódia
 * contínua e menos emendas. A PRIMEIRA sentença fica curta para não atrasar o
 * primeiro áudio. Nenhuma palavra é descartada.
 */
export function groupForSpeech(text: unknown, {
  minChars = 120, maxChars = 280, firstMaxChars = 120, maxSentences = 3,
  garantirTerminador: fechar = false,
}: GroupOptions = {}): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const limite = Number.isFinite(maxChars) && maxChars >= 40 ? Math.floor(maxChars) : 280;
  const primeiroLimite = Number.isFinite(firstMaxChars) && firstMaxChars >= 20
    ? Math.min(Math.floor(firstMaxChars), limite) : Math.min(120, limite);

  const protegido = protegerParaQuebra(text);
  const sentencas = protegido
    .split(/(?<=[.!?])\s+(?=[A-ZÀÁÂÃÄÉÈÊÍÌÎÕÓÔÖÚÙÛÇ0-9"“])/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => splitClauses(desprotegerDepoisDeQuebra(s), limite))
    .filter(Boolean);
  if (!sentencas.length) return [];

  // A primeira frase curta é preservada mesmo quando a sentença é longa.
  const pecas = [...sentencas];
  if (pecas[0].length > primeiroLimite) {
    pecas.splice(0, 1, ...quebrarNoEspaco(pecas[0], primeiroLimite));
  }

  const grupos: string[] = [];
  let atual = '';
  let contador = 0;
  for (const peca of pecas) {
    const candidato = atual ? `${atual} ${peca}` : peca;
    const primeiro = grupos.length === 0;
    const limiteAtual = primeiro ? primeiroLimite : limite;
    const excedeu = candidato.length > limiteAtual;
    const podeFechar = primeiro || atual.length >= Math.min(minChars, limite);
    if (!atual || (excedeu && podeFechar) || contador >= maxSentences) {
      if (atual) grupos.push(atual);
      atual = peca;
      contador = 1;
    } else {
      atual = candidato;
      contador += 1;
    }
  }
  if (atual) grupos.push(atual);
  return grupos.map((g) => (fechar ? garantirTerminador(g.trim()) : g.trim())).filter(Boolean);
}

/** Markdown -> trechos agrupados prontos para o TTS. */
export function speakableGroups(markdown: unknown, options: GroupOptions = {}): string[] {
  return groupForSpeech(toSpeakable(markdown), options);
}
