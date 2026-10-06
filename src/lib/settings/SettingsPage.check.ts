import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Component } from "svelte";
import { createServer, type ViteDevServer } from "vite";

test("Settings offers onboarding start when none exists and restart only for completed or exited states", async () => {
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
    const renderSettings = (
      onboardingStatus: "active" | "exited" | "completed" | null,
      pending = false,
      extra: Record<string, unknown> = {},
    ) =>
      render(loaded.default, {
        props: {
          onboardingStatus,
          onboardingRestartPending: pending,
          ...extra,
        },
      }).body;
    const text = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const findButton = (body: string, label: string) =>
      [...body.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
        .map(([button]) => button)
        .find((button) => button.includes(label)) ?? null;

    const completedButton = findButton(renderSettings("completed"), "Restart onboarding");
    assert.ok(completedButton, "completed onboarding should expose Restart onboarding");
    assert.ok(findButton(renderSettings("exited"), "Restart onboarding"), "exited onboarding should keep Restart onboarding");
    assert.equal(findButton(renderSettings("active"), "Restart onboarding"), null);
    assert.equal(findButton(renderSettings(null), "Restart onboarding"), null);
    assert.ok(findButton(renderSettings(null), "Start onboarding"), "a user without onboarding state can start it");
    assert.equal(findButton(renderSettings("active"), "Start onboarding"), null);
    assert.equal(findButton(renderSettings("completed"), "Start onboarding"), null);

    const stateChips = { completed: "Completed", exited: "Stopped", active: "In progress", notStarted: "Not started" } as const;
    for (const [status, label] of Object.entries(stateChips)) {
      const body = renderSettings(status === "notStarted" ? null : status as "active" | "exited" | "completed");
      const chip = body.match(/<span class="chip[^"]*"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? "";
      assert.equal(text(chip).trim(), label, `${status} onboarding should show its state chip`);
    }

    const endedAt = "2026-10-05T08:00:00.000Z";
    assert.match(
      text(renderSettings("completed", false, { onboardingEndedAt: endedAt, onboardingLinkedSources: 3, onboardingFirstSyncSucceeded: true })),
      /Completed 2026\/10\/05 · 3 sources linked, first sync succeeded/,
    );
    assert.match(
      text(renderSettings("exited", false, { onboardingEndedAt: endedAt })),
      /Stopped 2026\/10\/05 · Restarting begins at choosing a bank and takes about 3 minutes/,
    );
    assert.doesNotMatch(renderSettings("completed"), /data-onboarding-meta/, "a pre-v5 record with no sources has nothing to report");
    assert.match(
      renderSettings("exited"),
      /<button class="button[^"]*\bprimary\b[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Restart onboarding/,
      "a stopped onboarding leads with restart",
    );
    assert.doesNotMatch(
      renderSettings("completed"),
      /<button class="button[^"]*\bprimary\b[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Restart onboarding/,
      "a finished onboarding keeps restart secondary",
    );

    const rateStatus = (lastRun: unknown) =>
      text(renderSettings("completed", false, { exchangeRateLastRun: lastRun }).match(/<p class="rate-status[\s\S]*?<\/p>/)?.[0] ?? "").trim();
    assert.match(rateStatus({ finishedAt: "2026-10-04T15:59:00.000Z", succeeded: true }), /^Last 10\/4 23:59 succeeded · Next \d+\/\d+ 06:00$/);
    assert.match(rateStatus({ finishedAt: "2026-10-04T15:59:00.000Z", succeeded: false }), /^Last 10\/4 23:59 failed · /);
    assert.match(rateStatus(null), /^Next \d+\/\d+ 06:00$/);

    const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
    assert.match(text(renderSettings("completed")), new RegExp(`OctopusBeak ${version.replaceAll(".", "\\.")}`));

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
