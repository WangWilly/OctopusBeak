import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "svelte";
import { createServer, type ViteDevServer } from "vite";

test("Settings offers onboarding restart only for completed or exited states", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let server: ViteDevServer | null = null;

  try {
    server = await createServer({
      configFile: new URL("../../../vite.config.ts", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const { render } = await server.ssrLoadModule("svelte/server") as {
      render: typeof import("svelte/server").render;
    };
    const loaded = await server.ssrLoadModule("/src/lib/settings/SettingsPage.svelte") as {
      default: Component<Record<string, unknown>>;
    };
    const renderSettings = (onboardingStatus: "active" | "exited" | "completed" | null, pending = false) =>
      render(loaded.default, {
        props: {
          onboardingStatus,
          onboardingRestartPending: pending,
        },
      }).body;
    const findButton = (body: string, label: string) =>
      [...body.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
        .map(([button]) => button)
        .find((button) => button.includes(label)) ?? null;

    const completedButton = findButton(renderSettings("completed"), "Restart onboarding");
    assert.ok(completedButton, "completed onboarding should expose Restart onboarding");
    assert.ok(findButton(renderSettings("exited"), "Restart onboarding"), "exited onboarding should keep Restart onboarding");
    assert.equal(findButton(renderSettings("active"), "Restart onboarding"), null);
    assert.equal(findButton(renderSettings(null), "Restart onboarding"), null);

    const stateChips = { completed: "Completed", exited: "Exited", active: "In progress", notStarted: "Not started" } as const;
    for (const [status, label] of Object.entries(stateChips)) {
      const body = renderSettings(status === "notStarted" ? null : status as "active" | "exited" | "completed");
      assert.match(body, new RegExp(`<span class="chip[^"]*"[^>]*>\\s*${label}\\s*</span>`), `${status} onboarding should show its state chip`);
    }

    for (const status of ["completed", "exited"] as const) {
      const pendingButton = findButton(renderSettings(status, true), "Restarting...");
      assert.ok(pendingButton);
      assert.match(pendingButton, /\sdisabled(?:="")?(?:\s|>)/);
    }
  } finally {
    if (server) await server.close();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
