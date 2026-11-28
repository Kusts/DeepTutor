import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, apiUrlMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  apiUrlMock: vi.fn((p: string) => `/scoped${p}`),
}));

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock, apiUrl: apiUrlMock }));

import {
  checkSession,
  metadadosUltimaTranscricao,
  synthesizeAudio,
  transcribeAudio,
} from '@/features/classroom/voice/transport/voice-clients';

const blob = () => new Blob([new Uint8Array(16)], { type: 'audio/mpeg' });

beforeEach(() => {
  apiFetchMock.mockReset();
  apiUrlMock.mockClear();
});

describe('voice clients (same-origin via apiFetch/apiUrl)', () => {
  it('STT usa multipart { file, language? } e devolve só o texto', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: '  Olá, tutor.  ', extra_real_do_servidor: 42 }),
    });
    const texto = await transcribeAudio(blob(), { filename: 'fala.wav', language: 'pt-BR' });
    expect(texto).toBe('Olá, tutor.');
    expect(apiUrlMock).toHaveBeenCalledWith('/api/voice/stt');
    const [url, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/scoped/api/voice/stt');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    const form = init.body as FormData;
    expect(form.get('language')).toBe('pt-BR');
    expect((form.get('file') as File).name).toBe('fala.wav');

    const meta = metadadosUltimaTranscricao();
    expect(meta?.text).toBe('  Olá, tutor.  ');
    expect(meta?.extra_real_do_servidor).toBe(42);
    expect(Number.isFinite(meta?.at)).toBe(true);
  });

  it('STT repassa 429 ao chamador sem gastar chamadas extras', async () => {
    let chamadas = 0;
    const fetchImpl = async () => {
      chamadas += 1;
      return { ok: false, status: 429, text: async () => 'Please try again in 9s' };
    };
    await expect(transcribeAudio(blob(), {
      fetchImpl: fetchImpl as never, attempts: 1,
    })).rejects.toThrow(/429|Please try again/);
    expect(chamadas).toBe(1);
  });

  it('TTS envia { text, voice?, format? } e bytes', async () => {
    const chamadas: Array<{ url: string; body: Record<string, string> }> = [];
    const fetchImpl = async (url: string, opts: RequestInit) => {
      chamadas.push({ url, body: JSON.parse(String(opts.body)) as Record<string, string> });
      return { ok: true, blob: async () => blob() };
    };
    await synthesizeAudio('Olá, tutor.', {
      fetchImpl: fetchImpl as never, voice: 'pt-BR-AntonioNeural', format: 'mp3',
    });
    expect(chamadas[0]?.url).toBe('/scoped/api/voice/tts');
    expect(chamadas[0]?.body).toEqual({
      text: 'Olá, tutor.', voice: 'pt-BR-AntonioNeural', format: 'mp3',
    });
  });

  it('sem voice/format o corpo permanece { text }', async () => {
    let corpo: Record<string, string> | undefined;
    const fetchImpl = async (_url: string, opts: RequestInit) => {
      corpo = JSON.parse(String(opts.body)) as Record<string, string>;
      return { ok: true, blob: async () => blob() };
    };
    await synthesizeAudio('Explique variáveis.', { fetchImpl: fetchImpl as never });
    expect(corpo).toEqual({ text: 'Explique variáveis.' });
  });

  it('TTS 429 não é atenuado por retry local', async () => {
    let chamadas = 0;
    const fetchImpl = async () => {
      chamadas += 1;
      return { ok: false, status: 429, text: async () => 'quota' };
    };
    await expect(synthesizeAudio('Oi', { fetchImpl: fetchImpl as never, attempts: 3 }))
      .rejects.toMatchObject({ code: 'TTS_429' });
    expect(chamadas).toBe(1);
  });

  it('checkSession usa a mesma base', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await checkSession()).toEqual({ ok: true, status: 200 });
    expect(apiUrlMock).toHaveBeenCalledWith('/api/sessions');
  });

  it('nenhum fetch cru no módulo', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'features/classroom/voice/transport/voice-clients.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/await fetch\s*\(/);
    expect(source).toContain('apiFetch');
    expect(source).toContain('apiUrl');
  });
});
