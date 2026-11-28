import { describe, expect, it } from 'vitest';

import {
  AUDIO_CONSTRAINTS,
  TARGET_SAMPLE_RATE,
  lowpassBeforeDecimation,
  resampleMono,
} from '@/features/classroom/voice/transport/audio-capture';
import { encodeWavMono } from '@/features/classroom/voice/transport/wav';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function u32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24);
}

describe('WAV PCM mono', () => {
  it('escreve cabeçalho RIFF/WAVE PCM 16 bits mono à taxa pedida', () => {
    const pcm = Float32Array.from({ length: 400 }, (_, i) => Math.sin(i / 10) * 0.5);
    const buffer = encodeWavMono({ sampleRate: 16000, length: pcm.length, getChannelData: () => pcm });
    const bytes = new Uint8Array(buffer);

    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(u32(bytes, 4)).toBe(36 + pcm.length * 2);
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(u32(bytes, 16)).toBe(16); // tamanho do bloco fmt
    expect(bytes[20]! | (bytes[21]! << 8)).toBe(1); // PCM (não compressed)
    expect(bytes[22]! | (bytes[23]! << 8)).toBe(1); // mono
    expect(u32(bytes, 24)).toBe(16000);
    expect(u32(bytes, 28)).toBe(32000); // byte rate = 16000 * 1 * 2
    expect(bytes[32]! | (bytes[33]! << 8)).toBe(2); // block align
    expect(bytes[34]! | (bytes[35]! << 8)).toBe(16); // bits por amostra
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(u32(bytes, 40)).toBe(pcm.length * 2);
    expect(bytes.byteLength).toBe(44 + pcm.length * 2);
  });

  it('codifica amostras com sinal e escala de 16 bits', () => {
    const pcm = new Float32Array([0.5, -0.5, 2, -2, 0]);
    const view = new DataView(encodeWavMono({ sampleRate: 16000, length: pcm.length, getChannelData: () => pcm }));
    expect(view.getInt16(44, true)).toBe(16383); // 0.5 * 0x7fff
    expect(view.getInt16(46, true)).toBe(-16384); // -0.5 * 0x8000
    expect(view.getInt16(48, true)).toBe(32767); // clamp
    expect(view.getInt16(50, true)).toBe(-32768);
    expect(view.getInt16(52, true)).toBe(0);
  });

  it('downmix de estéreo para mono sem alterar o canal de entrada', () => {
    const left = new Float32Array([1, 0.5, -0.25]);
    const right = new Float32Array([0, 0.5, -0.75]);
    const buffer = encodeWavMono({
      sampleRate: 16000,
      length: left.length,
      numberOfChannels: 2,
      getChannelData: (channel) => (channel === 0 ? left : right),
    });
    const view = new DataView(buffer);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)])
      .toEqual([16383, 16383, -16384]);
  });
});

describe('captura PCM', () => {
  it('usa 16 kHz e constraints que favorecem a voz', () => {
    expect(TARGET_SAMPLE_RATE).toBe(16000);
    expect(AUDIO_CONSTRAINTS.audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
  });

  it('resampleMono mantém 16 kHz e converte 48 kHz', () => {
    expect([...resampleMono(new Float32Array([1, 0, -1]), 16000, 16000)]).toEqual([1, 0, -1]);
    const out = resampleMono(new Float32Array(48000).fill(0.5), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(out[0]).toBe(0.5);
  });

  it('filtro passa-baixa antes da decimação atenua aliasing de 12 kHz', () => {
    const rms = (arr: Float32Array): number => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length);
    const tom = (freq: number): Float32Array => Float32Array.from(
      { length: 48000 }, (_, i) => Math.sin((2 * Math.PI * freq * i) / 48000),
    );
    const util = rms(lowpassBeforeDecimation(tom(1000), 3));
    const aliasing = rms(lowpassBeforeDecimation(tom(12000), 3));
    expect(aliasing).toBeLessThan(util * 0.2);
  });
});
