// Seleção do VAD com fallback automático. O VAD neural (@ricky0123/vad-web / ONNX)
// NÃO é distribuído nesta sala (ADR 0004): ~13,6 MB de assets e threads que
// exigem COOP/COEP. Quando um bundle opcional é configurado pelo operador e
// falha ao carregar (ou o ambiente não tem single-thread WASM), caímos para o
// VAD de energia endurecido, que é o caminho padrão e testado.

export interface VadAssets {
  wasm?: unknown;
  model?: unknown;
  requiresThreads?: boolean;
}

export type VadKind = 'energia' | 'neural';

export interface VadResolution<TInstance = unknown> {
  kind: VadKind;
  neuralDisponivel: boolean;
  motivo: string;
  carregarNeural?: (options: unknown) => TInstance | Promise<TInstance>;
}

export type VadFallbackResult<TInstance> = VadResolution<TInstance> & {
  instancia: TInstance;
  erro?: string;
};

export interface ResolveVadConfig<TInstance = unknown> {
  assets?: VadAssets | null;
  wasm?: unknown;
  crossOriginIsolated?: boolean;
  carregarNeural?: ((options: unknown) => TInstance | Promise<TInstance>) | null;
}

interface VoiceGlobal {
  __TUTOR_VAD_ASSETS?: VadAssets | null;
  crossOriginIsolated?: boolean;
  WebAssembly?: unknown;
}

function globals(): typeof globalThis & VoiceGlobal {
  return globalThis as typeof globalThis & VoiceGlobal;
}

export function cabecaHttpSemThreads(
  crossOriginIsolated: boolean | undefined = globals().crossOriginIsolated,
): boolean {
  return !Boolean(crossOriginIsolated);
}

export function resolveVadKind<TInstance = unknown>({
  assets = globals().__TUTOR_VAD_ASSETS ?? null,
  wasm = globals().WebAssembly,
  crossOriginIsolated = globals().crossOriginIsolated,
  carregarNeural = null,
}: ResolveVadConfig<TInstance> = {}): VadResolution<TInstance> {
  if (!assets?.wasm || !assets?.model || typeof wasm !== 'function') {
    return { kind: 'energia', neuralDisponivel: false, motivo: 'sem_assets_neural' };
  }
  if (cabecaHttpSemThreads(crossOriginIsolated) && assets.requiresThreads !== false) {
    return { kind: 'energia', neuralDisponivel: true, motivo: 'sem_coop_coep' };
  }
  if (typeof carregarNeural !== 'function') {
    return { kind: 'energia', neuralDisponivel: true, motivo: 'sem_carregador' };
  }
  return { kind: 'neural', neuralDisponivel: true, motivo: 'carregado', carregarNeural };
}

/** Tenta o VAD neural; qualquer falha devolve o VAD de energia. */
export async function criarVadComFallback<TInstance>({
  criarEnergyVad,
  opcoes = {},
  ...config
}: ResolveVadConfig<TInstance> & {
  criarEnergyVad: (opcoes: unknown) => TInstance;
  opcoes?: unknown;
}): Promise<VadFallbackResult<TInstance>> {
  const escolha = resolveVadKind<TInstance>(config);
  if (escolha.kind === 'neural' && escolha.carregarNeural) {
    try {
      const instancia = await escolha.carregarNeural(opcoes);
      if (instancia) return { ...escolha, instancia: instancia as TInstance };
      return {
        ...escolha, kind: 'energia', motivo: 'neural_sem_instancia',
        instancia: criarEnergyVad(opcoes),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      return {
        ...escolha, kind: 'energia', motivo: 'neural_falhou',
        erro: name.slice(0, 60), instancia: criarEnergyVad(opcoes),
      };
    }
  }
  return { ...escolha, instancia: criarEnergyVad(opcoes) };
}
