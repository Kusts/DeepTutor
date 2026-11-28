import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '@/features/classroom/voice/model/event-bus';
import type { VoiceEventMap } from '@/features/classroom/voice/model/voice-events';

describe('event bus', () => {
  it('on/off/emit com payload tipado', () => {
    const bus = new EventBus<VoiceEventMap>();
    const seen: number[] = [];
    const off = bus.on('speech-start', (event) => {
      seen.push(event.at);
      expect(event.playbackActive).toBe(false);
    });
    bus.emit('speech-start', { at: 123, rms: 0.2, playbackActive: false });
    expect(seen).toEqual([123]);
    off();
    bus.emit('speech-start', { at: 456, rms: 0.2, playbackActive: false });
    expect(seen).toEqual([123]);
    expect(bus.types).toEqual([]);
  });

  it('curinga "*" recebe todos os eventos antes dos listeners específicos', () => {
    const bus = new EventBus();
    const ordem: string[] = [];
    bus.on('*', (event) => ordem.push(`*:${event.type}`));
    bus.on('interrupted', () => ordem.push('interrupted'));
    bus.emit('interrupted', { reason: 'barge-in' });
    expect(ordem).toEqual(['*:interrupted', 'interrupted']);
    expect(bus.types).toEqual(['*', 'interrupted']);
  });

  it('evento emitido é congelado e carrega timestamp', () => {
    const bus = new EventBus();
    vi.spyOn(Date, 'now').mockReturnValue(1700);
    const event = bus.emit('metric', { name: 'latencia', value: 42 });
    expect(event).toEqual({ type: 'metric', at: 1700, name: 'latencia', value: 42 });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('rejeita listener que não é função', () => {
    const bus = new EventBus();
    expect(() => bus.on('mode', null as unknown as () => void)).toThrow(TypeError);
  });
});
