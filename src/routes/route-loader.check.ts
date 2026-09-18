import assert from "node:assert/strict";
import test from "node:test";

import {
  createRouteLoadCache,
  createFinancialRouteGenerationCoordinator,
} from "./route-loader.ts";

test("route navigation deduplicates in-flight loads and reuses warm data", async () => {
  const cache = createRouteLoadCache<{
    assets: { version: number };
  }>();
  let calls = 0;
  const loader = async () => ({ version: ++calls });

  const first = cache.load("assets", loader);
  const second = cache.load("assets", loader);

  assert.equal(calls, 1, "one route navigation must start one backend load");
  assert.strictEqual(second, first, "concurrent navigation must share one promise");
  assert.deepEqual(await first, { version: 1 });
  assert.deepEqual(cache.read("assets"), { version: 1 });

  assert.deepEqual(await cache.load("assets", loader), { version: 1 });
  assert.equal(calls, 1, "a warm route must not reload before an explicit refresh");

  assert.deepEqual(await cache.load("assets", loader, { force: true }), { version: 2 });
  assert.equal(calls, 2, "an explicit refresh may replace the warm route data");

  cache.clearAll();
  assert.equal(cache.read("assets"), undefined, "an import invalidates every financial route");
  assert.deepEqual(await cache.load("assets", loader), { version: 3 });
});

test("forced refresh preserves stale data while loading and restores it on failure", async () => {
  const cache = createRouteLoadCache<{ assets: { version: number } }>();
  await cache.load("assets", async () => ({ version: 1 }), { cutoff: { knowledgePoint: 1 } });
  cache.markStale("assets", 2);
  let rejectRefresh: ((error: Error) => void) | undefined;
  const refresh = cache.load("assets", () => new Promise<{ version: number }>((_, reject) => {
    rejectRefresh = reject;
  }), { force: true, cutoff: { knowledgePoint: 2 } });

  assert.deepEqual(cache.read("assets"), { version: 1 });
  assert.equal(cache.isStale("assets"), true);
  rejectRefresh?.(new Error("refresh-failed"));
  await assert.rejects(refresh, /refresh-failed/);
  assert.deepEqual(cache.read("assets"), { version: 1 });
  assert.equal(cache.isStale("assets"), true);

  cache.markStale("assets", 3);
  assert.deepEqual(
    await cache.load("assets", async () => ({ version: 2 }), {
      force: true,
      cutoff: { knowledgePoint: 2 },
    }),
    { version: 2 },
  );
  assert.equal(cache.isStale("assets"), true, "a late lower cutoff cannot hide a newer invalidation");
});

test("financial route invalidation coalesces bursts and refreshes only the visible route", async () => {
  const loads: Array<{ route: string; knowledgePoint: number }> = [];
  const stale: Array<{ route: string; knowledgePoint: number }> = [];
  let resolveLoad: (() => void) | undefined;
  const coordinator = createFinancialRouteGenerationCoordinator({
    routes: ["overview", "assets", "spending"] as const,
    subscribe: () => () => {},
    latestKnowledgePoint: async () => 0,
    load: async ({ route, cutoff }) => {
      loads.push({ route, knowledgePoint: cutoff.knowledgePoint });
      await new Promise<void>((resolve) => { resolveLoad = resolve; });
    },
    onRouteStale: (route, knowledgePoint) => stale.push({ route, knowledgePoint }),
  });

  coordinator.setVisibleRoute("assets");
  coordinator.observeKnowledgePoint(105);
  coordinator.observeKnowledgePoint(106);
  coordinator.observeKnowledgePoint(107);

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(stale.slice(0, 3), [
    { route: "overview", knowledgePoint: 105 },
    { route: "assets", knowledgePoint: 105 },
    { route: "spending", knowledgePoint: 105 },
  ]);
  assert.equal(stale.at(-1)?.knowledgePoint, 107);
  assert.deepEqual(loads, [{ route: "assets", knowledgePoint: 107 }]);

  resolveLoad?.();
  await coordinator.waitForIdle();
  assert.deepEqual(loads, [{ route: "assets", knowledgePoint: 107 }]);
  assert.equal(coordinator.isStale("overview"), true, "hidden routes remain stale");
  assert.equal(coordinator.isStale("spending"), true, "hidden routes remain stale");
});

test("a newer knowledge point aborts an active generation before it can publish", async () => {
  const loads: Array<{ knowledgePoint: number; signal: AbortSignal }> = [];
  const coordinator = createFinancialRouteGenerationCoordinator({
    routes: ["spending"] as const,
    subscribe: () => () => {},
    latestKnowledgePoint: async () => 0,
    load: async ({ cutoff, signal }) => {
      loads.push({ knowledgePoint: cutoff.knowledgePoint, signal });
      if (cutoff.knowledgePoint === 1) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    },
  });

  coordinator.setVisibleRoute("spending");
  coordinator.observeKnowledgePoint(1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(loads.map(({ knowledgePoint }) => knowledgePoint), [1]);

  coordinator.observeKnowledgePoint(2);
  assert.equal(loads[0]?.signal.aborted, true, "a superseded read is cancelled immediately");
  await coordinator.waitForIdle();

  assert.deepEqual(loads.map(({ knowledgePoint }) => knowledgePoint), [1, 2]);
  assert.equal(coordinator.getState("spending").knowledgePoint, 2);
  assert.equal(coordinator.getState("spending").stale, false);
});

test("late route results are discarded after navigation and do not refresh a hidden route", async () => {
  const loads: string[] = [];
  const results: string[] = [];
  let resolveAssets: (() => void) | undefined;
  const coordinator = createFinancialRouteGenerationCoordinator({
    routes: ["assets", "spending"] as const,
    subscribe: () => () => {},
    latestKnowledgePoint: async () => 4,
    load: async ({ route }) => {
      loads.push(route);
      if (route === "assets") {
        await new Promise<void>((resolve) => { resolveAssets = resolve; });
      }
      results.push(route);
    },
    onRouteFresh: (route) => results.push(`fresh:${route}`),
  });

  coordinator.setVisibleRoute("assets");
  coordinator.observeKnowledgePoint(4);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  coordinator.setVisibleRoute("spending");
  resolveAssets?.();
  await coordinator.waitForIdle();

  assert.deepEqual(loads, ["assets", "spending"]);
  assert.deepEqual(results, ["assets", "spending", "fresh:spending"]);
  assert.equal(coordinator.isStale("assets"), true);
});

test("reconciliation recovers a missed event and cleanup unsubscribes listeners", async () => {
  let listener: ((event: { knowledgePoint: number }) => void) | undefined;
  let unsubscribeCalls = 0;
  const loads: number[] = [];
  const coordinator = createFinancialRouteGenerationCoordinator({
    routes: ["overview"] as const,
    subscribe: (next) => {
      listener = next;
      return () => { unsubscribeCalls += 1; listener = undefined; };
    },
    latestKnowledgePoint: async () => 9,
    load: async ({ cutoff }) => { loads.push(cutoff.knowledgePoint); },
  });

  coordinator.start();
  coordinator.setVisibleRoute("overview");
  await coordinator.reconcile();
  await coordinator.waitForIdle();
  assert.deepEqual(loads, [9]);

  coordinator.stop();
  assert.equal(unsubscribeCalls, 1);
  listener?.({ knowledgePoint: 10 });
  await coordinator.waitForIdle();
  assert.deepEqual(loads, [9], "events after unsubscribe cannot start a load");
});

test("a failed refresh keeps stale data and waits for a new signal before retrying", async () => {
  let calls = 0;
  const coordinator = createFinancialRouteGenerationCoordinator({
    routes: ["spending"] as const,
    subscribe: () => () => {},
    latestKnowledgePoint: async () => 2,
    load: async () => {
      calls += 1;
      throw new Error("temporary-read-failure");
    },
  });

  coordinator.setVisibleRoute("spending");
  coordinator.observeKnowledgePoint(2);
  await coordinator.waitForIdle();
  assert.equal(calls, 1, "a failed refresh must not tight-loop");
  assert.equal(coordinator.getState("spending").stale, true);
  assert.equal(coordinator.getState("spending").error, "temporary-read-failure");

  coordinator.setVisibleRoute(null);
  coordinator.setVisibleRoute("spending");
  await coordinator.waitForIdle();
  assert.equal(calls, 2, "route re-entry may explicitly retry stale data");
});
