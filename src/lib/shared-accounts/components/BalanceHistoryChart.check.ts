import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "svelte";
import { createServer, type ViteDevServer } from "vite";

test("a lone balance point sits in the middle of the plot", async () => {
  let server: ViteDevServer | null = null;
  try {
    server = await createServer({
      configFile: new URL("../../../../vite.config.ts", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const { render } = await server.ssrLoadModule("svelte/server") as { render: typeof import("svelte/server").render };
    const chart = await server.ssrLoadModule("/src/lib/shared-accounts/components/BalanceHistoryChart.svelte") as {
      default: Component<Record<string, unknown>>;
    };
    const draw = (points: { day: string; balance: number }[]) => render(chart.default, {
      props: { points, today: "2026-10-06", todayLabel: "Today", currency: "TWD", label: "Balance" },
    }).body;
    const endX = (body: string) => Number(body.match(/<circle class="end-dot[^"]*" cx="([\d.]+)"/)?.[1]);
    const plot = { left: 64, right: 800 - 12 };

    assert.equal(endX(draw([{ day: "2026-10-06", balance: 100 }])), (plot.left + plot.right) / 2);
    assert.equal(endX(draw([{ day: "2026-10-05", balance: 90 }, { day: "2026-10-06", balance: 100 }])), plot.right, "a series still ends at the right edge");
  } finally {
    await server?.close();
  }
});
