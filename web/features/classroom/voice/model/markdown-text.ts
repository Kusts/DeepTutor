// Normalização leve do Markdown vindo do stream do /ws.
// O DeepTutor envia `content` em pedaços; às vezes um cabeçalho ou lista chega
// colado no parágrafo anterior. Este módulo só insere quebras onde o Markdown
// exige, sem tocar em blocos de código cercados por ```.

export function normalizarMarkdown(texto: unknown): string {
  const bruto = String(texto ?? '').replace(/\r\n?/g, '\n').trim();
  if (!bruto) return '';
  const partes = bruto.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < partes.length; i += 2) {
    partes[i] = partes[i]
      // marca de título solitária produzida por alguns provedores
      .replace(/^#[ \t]*$/gm, '')
      // "frase.## Título" -> "frase.\n\n## Título"
      .replace(/([^\n])(#{1,6}[ \t]+)/g, '$1\n\n$2')
      // dois títulos seguidos ("#\n\n## Título") viram apenas o último
      .replace(/^#{1,6}[ \t]*\n+(?=#{1,6}[ \t])/gm, '')
      // remove espaços em branco no fim de linha e excesso de linhas vazias
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }
  return partes.join('').trim();
}
