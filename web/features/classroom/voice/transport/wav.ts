// Codificador WAV PCM 16 bits mono — evita depender do formato aceito pelo STT.
// Funciona no navegador (AudioBuffer) e em Node (ArrayBuffer) para testes.
// D3 (ADR 0002): MediaRecorder/webm devolveu invalid_media_file no provedor;
// o caminho provado em produção é PCM 16 bits a 16 kHz neste formato.

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export interface WavSource {
  sampleRate: number;
  length: number;
  numberOfChannels?: number;
  getChannelData(channel: number): Float32Array;
}

/** Converte um AudioBuffer (ou objeto {sampleRate, getChannelData}) em ArrayBuffer WAV mono. */
export function encodeWavMono(audioBuffer: WavSource): ArrayBuffer {
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const channels = Math.min(audioBuffer.numberOfChannels ?? 1, 2);
  const data = audioBuffer.getChannelData(0);
  if (channels === 2) {
    const right = audioBuffer.getChannelData(1);
    for (let i = 0; i < length; i += 1) data[i] = (data[i] + right[i]) / 2;
  }
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + length * bytesPerSample);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + length * bytesPerSample, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, length * bytesPerSample, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}
