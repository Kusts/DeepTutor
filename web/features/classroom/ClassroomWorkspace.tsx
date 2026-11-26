"use client";

import { useTranslation } from "react-i18next";

import ChatWorkspace from "@/features/chat/components/ChatWorkspace";
import { useClassroomEnabled } from "@/hooks/useClassroomEnabled";
import { EmptyState } from "@/shared/ui";

import { AvatarStage } from "./AvatarStage";
import { VoiceControls } from "./components/VoiceControls";
import "./classroom-tokens.css";
import { useVoiceSession } from "./voice/useVoiceSession";

/**
 * The classroom is composition, not a copy of the chat surface: the existing
 * ChatWorkspace owns the conversation, and this page only adds the surrounding
 * classroom chrome. ChatWorkspace keeps its own /chat navigation for now.
 */
export function ClassroomWorkspace() {
  const { t } = useTranslation();
  const { value: classroomEnabled, loading } = useClassroomEnabled();
  // Hooks are called before the early returns so hook order is stable. The
  // session stays inert until a user gesture calls start()/toggleMic(), so
  // nothing voice-related is mounted while the flag is off.
  const voice = useVoiceSession();

  // No content flicker while the persisted preference is still being read.
  if (loading) {
    return (
      <div className="dt-page-container dt-classroom flex h-full min-h-0 flex-col gap-3">
        <header className="dt-page-header flex items-center justify-between gap-3">
          <h1 className="dt-page-title font-semibold">{t("Classroom")}</h1>
        </header>
        <div
          aria-busy="true"
          className="dt-page-grid min-h-0 flex-1 rounded-xl border border-[var(--border)]/60 bg-[var(--card)]/40"
        />
      </div>
    );
  }

  if (!classroomEnabled) {
    return (
      <div className="dt-page-container dt-classroom flex h-full min-h-0 flex-col gap-3">
        <header className="dt-page-header flex items-center justify-between gap-3">
          <h1 className="dt-page-title font-semibold">{t("Classroom")}</h1>
        </header>
        <EmptyState
          compact
          title={t("Classroom (sala de aula)")}
          description={t("The classroom is off. Turn it on in Settings → Voice.")}
        />
      </div>
    );
  }

  return (
    <div className="dt-page-container dt-classroom flex h-full min-h-0 flex-col gap-3">
      <header className="dt-page-header flex items-center justify-between gap-3">
        <h1 className="dt-page-title font-semibold">{t("Classroom")}</h1>
      </header>
      <AvatarStage phase={voice.phase} getAmplitude={voice.getAmplitude} />
      <VoiceControls
        phase={voice.phase}
        level={voice.level}
        metrics={voice.metrics}
        onToggleMic={voice.toggleMic}
        onSpeak={() => { void voice.start(); }}
        onInterrupt={voice.interrupt}
      />
      <div className="dt-page-grid min-h-0 flex-1">
        <ChatWorkspace />
      </div>
    </div>
  );
}
