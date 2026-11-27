"use client";

import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import ChatWorkspace from "@/features/chat/components/ChatWorkspace";
import { useClassroomEnabled } from "@/hooks/useClassroomEnabled";

import "./classroom-tokens.css";

// Voice and avatar are opt-in chrome, not part of the conversation shell.
// Loading them on demand keeps their runtime (chat adapter, audio transports,
// LivLiv renderer) out of the first chunk of /classroom and /chat.
const VoiceLayer = dynamic(
  () => import("./components/VoiceLayer").then((module) => module.VoiceLayer),
  { ssr: false },
);

/**
 * The classroom is composition, not a copy of the chat surface: the existing
 * ChatWorkspace owns the conversation, and this page only adds the surrounding
 * classroom chrome. ChatWorkspace keeps its own /chat navigation for now.
 */
export function ClassroomWorkspace() {
  const { t } = useTranslation();
  const { value: classroomEnabled, loading } = useClassroomEnabled();
  // The voice hook lives in the lazily imported layer below, so it is not
  // created at all while the preference is still loading or switched off.

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
        {/* Static markup instead of the shared EmptyState: the latter imports
            cn()/tailwind-merge, which would otherwise ship 25 KB of utility
            code in the initial /classroom chunk just for the off state. */}
        <section
          className="flex flex-col items-center justify-center gap-2 px-4 py-6 text-center"
        >
          <h3 className="text-sm font-semibold text-foreground">
            {t("Classroom (sala de aula)")}
          </h3>
          <p className="mt-1 max-w-sm text-sm leading-5 text-muted-foreground">
            {t("The classroom is off. Turn it on in Settings → Voice.")}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="dt-page-container dt-classroom flex h-full min-h-0 flex-col gap-3">
      <header className="dt-page-header flex items-center justify-between gap-3">
        <h1 className="dt-page-title font-semibold">{t("Classroom")}</h1>
      </header>
      <VoiceLayer />
      <div className="dt-page-grid min-h-0 flex-1">
        <ChatWorkspace />
      </div>
    </div>
  );
}
