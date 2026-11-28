import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { expect, it, vi } from "vitest";

import { SidebarNav } from "@/components/sidebar/SidebarNav";

const fixture = vi.hoisted(() => ({
  classroomEnabled: false,
  allowedSurfaces: null as string[] | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("next/link", () => ({
  default: ({ children, prefetch: _prefetch, ...props }: Omit<ComponentProps<"a">, "prefetch"> & {
    children?: ReactNode;
    prefetch?: boolean;
  }) => <a {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/chat" }));
vi.mock("@/components/access/CapabilityAccessContext", () => ({
  useCapabilityAccess: () => ({ has: () => true }),
}));
vi.mock("@/hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    learningPolicy: fixture.allowedSurfaces
      ? { allowedSurfaces: fixture.allowedSurfaces }
      : null,
  }),
}));
vi.mock("@/hooks/useModules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useModules")>();
  return { ...actual, useModules: () => ({ modules: [] }) };
});
vi.mock("@/hooks/useClassroomEnabled", () => ({
  useClassroomEnabled: () => ({
    value: fixture.classroomEnabled,
    setValue: vi.fn(),
    loading: false,
  }),
}));
vi.mock("@/shared/ui/Tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderNav() {
  return render(
    <SidebarNav
      collapsed={false}
      onHomeClick={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
}

it("hides the classroom entry while the opt-in flag is off", () => {
  fixture.classroomEnabled = false;
  fixture.allowedSurfaces = null;
  renderNav();
  expect(screen.queryByRole("link", { name: /Classroom/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Partners/ })).toBeTruthy();
});

it("shows the classroom entry once the flag is on", () => {
  fixture.classroomEnabled = true;
  fixture.allowedSurfaces = null;
  renderNav();
  expect(screen.getByRole("link", { name: /Classroom/ })).toHaveAttribute("href", "/classroom");
});

it("keeps the classroom visible under a chat learning policy only", () => {
  fixture.classroomEnabled = true;
  fixture.allowedSurfaces = ["chat"];
  const chatPolicy = renderNav();
  expect(screen.getByRole("link", { name: /Classroom/ })).toBeTruthy();
  chatPolicy.unmount();

  fixture.allowedSurfaces = ["reading"];
  renderNav();
  expect(screen.queryByRole("link", { name: /Classroom/ })).toBeNull();
});
