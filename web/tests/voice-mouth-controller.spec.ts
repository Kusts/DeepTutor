import { describe, expect, it } from "vitest";

import {
  calcularRms,
  createMouthController,
  type MouthAnalyser,
} from "@/features/classroom/voice/model/mouth-controller";

function constante(valor: number, tamanho = 2048): Float32Array {
  return new Float32Array(tamanho).fill(valor);
}

function senoide(amplitude: number, tamanho = 4096): Float32Array {
  const out = new Float32Array(tamanho);
  for (let i = 0; i < tamanho; i += 1) {
    out[i] = Math.sin((2 * Math.PI * i) / tamanho) * amplitude;
  }
  return out;
}

function controlador(opcoes: Parameters<typeof createMouthController>[0] = {}) {
  return createMouthController({ smoothing: 0, ...opcoes });
}

function analyserPequeno({
  fftSize = 256,
  dbBaixa = -20,
  dbAlta = -80,
}: { fftSize?: number; dbBaixa?: number; dbAlta?: number } = {}): MouthAnalyser {
  const bins = fftSize / 2;
  return {
    fftSize,
    frequencyBinCount: bins,
    getFloatTimeDomainData(destino) {
      destino.fill(0.5, 0, Math.min(fftSize, destino.length));
    },
    getFloatFrequencyData(destino) {
      const fim = Math.min(bins, destino.length);
      destino.fill(dbBaixa, 0, Math.floor(fim / 2));
      destino.fill(dbAlta, Math.floor(fim / 2), fim);
    },
  };
}

describe("mouth-controller (lip-sync puro)", () => {
  it("usa RMS com compensação de Kahan, não pico", () => {
    const boca = controlador({ closeThreshold: 0, mouthGain: 1 });
    boca.tick(constante(0.5));
    expect(Math.abs(boca.snapshot().mouthOpen - 0.5)).toBeLessThan(1e-6);
    boca.tick(senoide(0.5));
    expect(Math.abs(boca.snapshot().mouthOpen - 0.35355339)).toBeLessThan(1e-6);
    boca.tick(new Float32Array([1, 0, 0, 0]));
    expect(Math.abs(boca.snapshot().mouthOpen - 0.5)).toBeLessThan(1e-6);
    expect(calcularRms(new Float32Array(0))).toBe(0);
  });

  it("aplica histerese exata nos limiares Float32 0,08 / 0,035", () => {
    const boca = controlador();
    boca.tick(new Float32Array([0.079]));
    expect(boca.snapshot().open).toBe(false);
    boca.tick(new Float32Array([0.08]));
    expect(boca.snapshot().open).toBe(true);
    expect(Math.abs(boca.snapshot().mouthOpen - 0.36)).toBeLessThan(1e-6);
    boca.tick(new Float32Array([0.036]));
    expect(boca.snapshot().open).toBe(true);
    boca.tick(new Float32Array([0.035]));
    expect(boca.snapshot().open).toBe(false);
    expect(boca.snapshot().frames).toBe(4);
  });

  it("dimensiona o buffer pelo analyser e não dilui o RMS (fftSize=256)", () => {
    const boca = createMouthController({
      analyser: analyserPequeno(),
      closeThreshold: 0,
      mouthGain: 1,
      smoothing: 0,
    });
    boca.tick();
    expect(Math.abs(boca.snapshot().mouthOpen - 0.5)).toBeLessThan(1e-6);
    expect(boca.snapshot().vowel).toBeGreaterThan(0);
  });

  it("converte dB em potência e inverte vowel quando a banda alta domina", () => {
    const baixa = controlador({ analyser: analyserPequeno({ dbBaixa: -20, dbAlta: -80 }) });
    baixa.tick();
    expect(baixa.snapshot().vowel).toBeGreaterThan(0);
    const alta = controlador({ analyser: analyserPequeno({ dbBaixa: -80, dbAlta: -20 }) });
    alta.tick();
    expect(alta.snapshot().vowel).toBeLessThan(0);
    const silencio = controlador({
      analyser: analyserPequeno({ dbBaixa: -Infinity, dbAlta: -Infinity }),
    });
    silencio.tick();
    expect(silencio.snapshot().vowel).toBe(0);
  });

  it("latch forceClose congela a boca e release só libera o próximo tick", () => {
    let instante = 100;
    const boca = controlador({ now: () => instante });
    const voiced = constante(0.5);
    const baixas = new Float32Array([1, 1, 0, 0, 0, 0, 0, 0]);

    boca.tick(voiced, baixas);
    expect(boca.snapshot().open).toBe(true);
    instante = 250;
    expect(boca.forceClose("barge-in")).toEqual({
      mouthOpen: 0,
      vowel: 0,
      open: false,
      reason: "barge-in",
      timestamp: 250,
      frames: 1,
    });
    instante = 260;
    boca.tick(voiced, baixas);
    expect(boca.snapshot().open).toBe(false);
    expect(boca.snapshot().reason).toBe("barge-in");
    boca.release();
    boca.tick(voiced, baixas);
    expect(boca.snapshot().open).toBe(true);
    expect(boca.snapshot().reason).toBeNull();
    expect(boca.snapshot().timestamp).toBeNull();
  });

  it("suaviza em direção ao alvo e limita mouthOpen a [0,1]", () => {
    const suave = controlador({ smoothing: 0.25 });
    suave.tick(constante(0.2));
    expect(suave.snapshot().mouthOpen).toBe(0.25);
    suave.tick(constante(0.2));
    expect(suave.snapshot().mouthOpen).toBe(0.4375);
    const exato = controlador();
    exato.tick(constante(0.2));
    expect(exato.snapshot().mouthOpen).toBe(1);
    exato.tick(constante(0));
    expect(exato.snapshot().mouthOpen).toBe(0);
  });

  it("snapshot é estável e dispose é idempotente", () => {
    let chamadas = 0;
    const boca = controlador({
      onFrame: () => {
        chamadas += 1;
      },
    });
    boca.tick(constante(0.5));
    expect(chamadas).toBe(1);
    const copia = boca.snapshot();
    copia.mouthOpen = 99;
    expect(boca.snapshot().mouthOpen).toBe(1);

    boca.dispose();
    const limpo = {
      mouthOpen: 0,
      vowel: 0,
      open: false,
      reason: null,
      timestamp: null,
      frames: 0,
    };
    expect(boca.snapshot()).toEqual(limpo);
    boca.dispose();
    boca.tick(constante(0.5));
    boca.forceClose("depois");
    boca.release();
    expect(chamadas).toBe(1);
    expect(boca.snapshot()).toEqual(limpo);
  });
});
