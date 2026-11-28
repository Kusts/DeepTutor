// Núcleo puro de lip-sync portado de web/sala/js/avatar-lipsync.js (Tutor).
// Não acessa DOM nem WebAudio diretamente: o analyser é uma dependência
// injetada. A soma de quadrados usa compensação de Kahan; os limiares usam
// histerese exata em Float32 (0,08 abre / 0,035 fecha) e o latch de forceClose
// só é liberado por release(). Nenhum `any`.

const TAMANHO_AMOSTRAS = 2048;
const TAMANHO_FREQUENCIAS = 1024;
const SEM_AMOSTRAS = new Float32Array(0);

function limitar(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

// O analyser da saída tem fftSize=256. Alocar o buffer padrão (2048) faria o
// getFloatTimeDomainData preencher só a primeira janela e diluir o RMS em
// sqrt(256/2048). Com analyser injetado, os buffers seguem o próprio nó.
function tamanhoDoAnalyser(valor: number | undefined, fallback: number): number {
  return Number.isFinite(valor) && (valor as number) > 0 ? Math.floor(valor as number) : fallback;
}

/** Analisador mínimo: o monitor da saída expõe o domínio do tempo; o de
 *  frequência é opcional (quando ausente, `vowel` fica neutro). */
export interface MouthAnalyser {
  readonly fftSize?: number;
  readonly frequencyBinCount?: number;
  getFloatTimeDomainData(buffer: Float32Array): void;
  getFloatFrequencyData?(buffer: Float32Array): void;
}

export interface MouthSnapshot {
  mouthOpen: number;
  vowel: number;
  open: boolean;
  reason: string | null;
  timestamp: number | null;
  frames: number;
}

export interface MouthControllerOptions {
  analyser?: MouthAnalyser | null;
  openThreshold?: number;
  closeThreshold?: number;
  mouthGain?: number;
  smoothing?: number;
  onFrame?: ((snapshot: MouthSnapshot) => void) | null;
  now?: () => number;
}

export interface MouthController {
  tick(amostras?: Float32Array, frequencias?: Float32Array): MouthSnapshot;
  forceClose(motivo?: string | null): MouthSnapshot;
  release(): MouthSnapshot;
  snapshot(): MouthSnapshot;
  dispose(): void;
}

/** RMS com compensação de Kahan: estável para sinais longos e de baixa amplitude. */
export function calcularRms(amostras: Float32Array | undefined | null): number {
  if (!amostras || amostras.length === 0) return 0;

  let somaDosQuadrados = 0;
  let compensacao = 0;
  for (let i = 0; i < amostras.length; i += 1) {
    const quadrado = amostras[i] * amostras[i];
    const valorAjustado = quadrado - compensacao;
    const novaSoma = somaDosQuadrados + valorAjustado;
    compensacao = (novaSoma - somaDosQuadrados) - valorAjustado;
    somaDosQuadrados = novaSoma;
  }
  return Math.sqrt(somaDosQuadrados / amostras.length);
}

// Chamadas diretas usam magnitudes lineares; `frequenciasEmDb` marca os dados
// de getFloatFrequencyData, que são decibéis e precisam virar potência.
export function calcularVowel(
  frequencias: Float32Array | undefined | null,
  frequenciasEmDb = false,
): number {
  if (!frequencias || frequencias.length === 0) return 0;

  const meio = Math.floor(frequencias.length / 2);
  let energiaBaixa = 0;
  let energiaAlta = 0;

  for (let i = 0; i < frequencias.length; i += 1) {
    // Em dB, -Infinity vira 0 naturalmente e representa silêncio.
    const energia = frequenciasEmDb
      ? 10 ** (frequencias[i] / 10)
      : frequencias[i] * frequencias[i];
    if (i < meio) energiaBaixa += energia;
    else energiaAlta += energia;
  }

  const energiaTotal = energiaBaixa + energiaAlta;
  if (energiaTotal === 0) return 0;
  return limitar((energiaBaixa - energiaAlta) / energiaTotal, -1, 1);
}

export function createMouthController({
  analyser: analyserInicial = null,
  openThreshold = 0.08,
  closeThreshold = 0.035,
  mouthGain = 8,
  smoothing = 0.35,
  onFrame: onFrameInicial = null,
  now = () => performance.now(),
}: MouthControllerOptions = {}): MouthController {
  let analyser = analyserInicial;
  let onFrame = onFrameInicial;
  const fatorSuavizacao = limitar(smoothing, 0, 1);
  const limiarAbertura = Math.fround(openThreshold);
  const limiarFechamento = Math.fround(closeThreshold);
  const tamanhoAmostras = tamanhoDoAnalyser(analyser?.fftSize, TAMANHO_AMOSTRAS);
  const tamanhoFrequencias = tamanhoDoAnalyser(analyser?.frequencyBinCount, TAMANHO_FREQUENCIAS);
  let amostrasAnalyser: Float32Array | null = analyser ? new Float32Array(tamanhoAmostras) : null;
  let frequenciasAnalyser: Float32Array | null = analyser ? new Float32Array(tamanhoFrequencias) : null;

  let mouthOpen = 0;
  let vowel = 0;
  let open = false;
  let reason: string | null = null;
  let timestamp: number | null = null;
  let frames = 0;
  let travado = false;
  let descartado = false;

  function snapshot(): MouthSnapshot {
    return { mouthOpen, vowel, open, reason, timestamp, frames };
  }

  function obterAmostras(amostras?: Float32Array): Float32Array {
    if (amostras) return amostras;
    if (!analyser || typeof analyser.getFloatTimeDomainData !== "function" || !amostrasAnalyser) {
      return SEM_AMOSTRAS;
    }
    analyser.getFloatTimeDomainData(amostrasAnalyser);
    return amostrasAnalyser;
  }

  function obterFrequencias(frequencias?: Float32Array): Float32Array {
    if (frequencias) return frequencias;
    if (
      !analyser ||
      typeof analyser.getFloatFrequencyData !== "function" ||
      !frequenciasAnalyser
    ) {
      return SEM_AMOSTRAS;
    }
    analyser.getFloatFrequencyData(frequenciasAnalyser);
    return frequenciasAnalyser;
  }

  function tick(amostras?: Float32Array, frequencias?: Float32Array): MouthSnapshot {
    if (descartado) return snapshot();

    if (travado) {
      mouthOpen = 0;
      vowel = 0;
      open = false;
    } else {
      const rms = calcularRms(obterAmostras(amostras));

      if (rms >= limiarAbertura) open = true;
      else if (rms <= limiarFechamento) open = false;

      const alvo = open
        ? limitar((rms - limiarFechamento) * mouthGain, 0, 1)
        : 0;
      mouthOpen = fatorSuavizacao === 0
        ? alvo
        : mouthOpen + (alvo - mouthOpen) * fatorSuavizacao;
      const frequenciasEmDb = !frequencias;
      vowel = open ? calcularVowel(obterFrequencias(frequencias), frequenciasEmDb) : 0;
      reason = null;
      timestamp = null;
    }

    frames += 1;
    const estado = snapshot();
    if (typeof onFrame === "function") onFrame(estado);
    return estado;
  }

  function forceClose(motivo?: string | null): MouthSnapshot {
    if (descartado) return snapshot();

    travado = true;
    mouthOpen = 0;
    vowel = 0;
    open = false;
    reason = motivo ?? null;
    timestamp = now();
    return snapshot();
  }

  function release(): MouthSnapshot {
    if (!descartado) travado = false;
    return snapshot();
  }

  function dispose(): void {
    if (descartado) return;

    descartado = true;
    onFrame = null;
    analyser = null;
    amostrasAnalyser = null;
    frequenciasAnalyser = null;
    travado = false;
    mouthOpen = 0;
    vowel = 0;
    open = false;
    reason = null;
    timestamp = null;
    frames = 0;
  }

  return { tick, forceClose, release, snapshot, dispose };
}
