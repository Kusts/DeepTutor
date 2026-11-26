import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api", () => ({
  apiUrl: (url: string) => url,
  apiFetch: (...args: unknown[]) => api.fetch(...args),
}));

async function loadUseClassroomEnabled(
  payload: unknown,
  ok = true,
  put: "ok" | "not-ok" | "throw" = "ok",
) {
  // The hook caches the global value at module scope; a fresh module stands in
  // for a fresh page load so each case starts from the default-off state.
  vi.resetModules();
  api.fetch.mockReset();
  api.fetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      if (put === "throw") return Promise.reject(new Error("upstream 500 secret detail"));
      return Promise.resolve({ ok: put === "ok", status: 503 });
    }
    return Promise.resolve({
      ok,
      json: async () => payload,
    });
  });
  const loaded = await import("@/hooks/useClassroomEnabled");
  return loaded.useClassroomEnabled;
}

it("defaults to false when settings omit or fail to provide the flag", async () => {
  for (const [payload, ok] of [
    [{ ui: {} }, true],
    [{ ui: { classroom_enabled: false } }, true],
    [null, false],
  ] as [unknown, boolean][]) {
    const useClassroomEnabled = await loadUseClassroomEnabled(payload, ok);
    const view = renderHook(() => useClassroomEnabled());
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.value).toBe(false);
    view.unmount();
  }
});

it("reads the persisted flag from payload.ui.classroom_enabled", async () => {
  const useClassroomEnabled = await loadUseClassroomEnabled({
    ui: { classroom_enabled: true },
  });
  const view = renderHook(() => useClassroomEnabled());
  await waitFor(() => expect(view.result.current.value).toBe(true));
  expect(api.fetch).toHaveBeenCalledWith("/api/settings");
});

it("writes the flag through the dedicated PUT endpoint without a token in the URL", async () => {
  const useClassroomEnabled = await loadUseClassroomEnabled({ ui: {} });
  const view = renderHook(() => useClassroomEnabled());
  await waitFor(() => expect(view.result.current.loading).toBe(false));

  await act(async () => {
    await view.result.current.setValue(true);
  });

  expect(view.result.current.value).toBe(true);
  expect(api.fetch).toHaveBeenCalledWith("/api/settings/classroom-enabled", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classroom_enabled: true }),
  });
  const [url] = api.fetch.mock.calls.at(-1) as [string];
  expect(url).not.toMatch(/token|secret|key=/i);
});

it("rolls back state, cache and the global event when the PUT fails", async () => {
  for (const mode of ["not-ok", "throw"] as const) {
    const useClassroomEnabled = await loadUseClassroomEnabled({ ui: {} }, true, mode);
    const view = renderHook(() => useClassroomEnabled());
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    const events: unknown[] = [];
    const onEvent = (event: Event) =>
      events.push((event as CustomEvent).detail?.value);
    window.addEventListener("deeptutor:classroom-enabled", onEvent);
    let reported = "";
    await act(async () => {
      try {
        await view.result.current.setValue(true);
      } catch (error) {
        reported = (error as Error).message;
      }
    });
    window.removeEventListener("deeptutor:classroom-enabled", onEvent);

    expect(reported).toBe("Could not save the classroom setting.");
    expect(reported).not.toMatch(/upstream|500|secret|503/);
    expect(view.result.current.value).toBe(false);
    expect(events).toEqual([true, false]);

    // A fresh hook in the same module reads the rolled-back shared cache.
    const second = renderHook(() => useClassroomEnabled());
    expect(second.result.current.value).toBe(false);
    expect(second.result.current.loading).toBe(false);
    second.unmount();
    view.unmount();
  }
});
