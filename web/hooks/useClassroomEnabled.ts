"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";

// Minimal mirror of useVoiceAutoplay's preference half: one per-user flag,
// cached across hooks, read from /api/settings and written through the same
// dedicated PUT endpoint. No session token in a URL, no secrets in the client.
const GLOBAL_EVENT = "deeptutor:classroom-enabled";
const SAVE_ERROR = "Could not save the classroom setting.";

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

function broadcast(value: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GLOBAL_EVENT, { detail: { value } }));
}

function fetchPreference(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (!inflight) {
    inflight = apiFetch(apiUrl("/api/settings"))
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const next = payload?.ui?.classroom_enabled === true;
        cached = next;
        return next;
      })
      .catch(() => {
        cached = false;
        return false;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Read/write the persisted classroom opt-in. Absent or unreadable settings
 * resolve to `false`, so a deployment that predates the flag stays unchanged.
 */
export function useClassroomEnabled() {
  const [value, setVal] = useState<boolean>(cached ?? false);
  const [loading, setLoading] = useState<boolean>(cached === null);

  useEffect(() => {
    let active = true;
    fetchPreference().then((next) => {
      if (active) {
        setVal(next);
        setLoading(false);
      }
    });
    const onGlobal = (event: Event) =>
      setVal(Boolean((event as CustomEvent).detail?.value));
    window.addEventListener(GLOBAL_EVENT, onGlobal);
    return () => {
      active = false;
      window.removeEventListener(GLOBAL_EVENT, onGlobal);
    };
  }, []);

  const setValue = useCallback(async (next: boolean) => {
    // `cached` is the shared source of truth across every hook instance, so
    // this rollback target cannot be a stale render's `value`.
    const previous = cached ?? false;
    cached = next;
    setVal(next);
    broadcast(next);

    let saved = false;
    try {
      const response = await apiFetch(apiUrl("/api/settings/classroom-enabled"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classroom_enabled: next }),
      });
      saved = Boolean(response?.ok);
    } catch {
      saved = false;
    }

    if (!saved) {
      cached = previous;
      setVal(previous);
      broadcast(previous);
      // A fixed message: never echo a server body or transport error to UI.
      throw new Error(SAVE_ERROR);
    }
  }, []);

  return { value, setValue, loading };
}
