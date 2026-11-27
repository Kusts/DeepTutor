"use client";

import { AvatarStage } from "../AvatarStage";
import { useVoiceSession } from "../voice/useVoiceSession";
import { VoiceControls } from "./VoiceControls";

/**
 * Lazy voice/avatar layer of the classroom.
 *
 * Kept out of the initial /classroom chunk: the voice runtime (chat state
 * adapter, STT/TTS/VAD transports and the LivLiv renderer) is only fetched
 * after the classroom opt-in has been read and the route is actually shown.
 * Conversation rendering stays with ChatWorkspace, which owns the chat turn.
 */
export function VoiceLayer() {
  const voice = useVoiceSession();

  return (
    <>
      <AvatarStage phase={voice.phase} getAmplitude={voice.getAmplitude} />
      <VoiceControls
        phase={voice.phase}
        level={voice.level}
        metrics={voice.metrics}
        onToggleMic={voice.toggleMic}
        onSpeak={() => {
          void voice.start();
        }}
        onInterrupt={voice.interrupt}
      />
    </>
  );
}
