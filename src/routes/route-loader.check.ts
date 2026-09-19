import assert from "node:assert/strict";
import test from "node:test";

import { createRouteLoadCache } from "./route-loader.ts";

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

test("a forced refresh keeps the cached view while the replacement is pending", async () => {
  const cache = createRouteLoadCache<{ overview: { version: number } }>();
  let release!: (value: { version: number }) => void;
  const replacement = new Promise<{ version: number }>((resolve) => {
    release = resolve;
  });

  await cache.load("overview", async () => ({ version: 1 }));
  const refreshing = cache.load("overview", () => replacement, { force: true });

  assert.deepEqual(cache.read("overview"), { version: 1 }, "refresh must not blank a cached view");
  assert.strictEqual(
    cache.load("overview", async () => ({ version: 3 }), { force: true }),
    refreshing,
    "repeated forced refreshes share the pending replacement",
  );

  release({ version: 2 });
  assert.deepEqual(await refreshing, { version: 2 });
  assert.deepEqual(cache.read("overview"), { version: 2 });
});

test("a failed forced refresh keeps the last successful view available for retry", async () => {
  const cache = createRouteLoadCache<{ overview: { version: number } }>();
  await cache.load("overview", async () => ({ version: 1 }));

  await assert.rejects(cache.load("overview", async () => {
    throw new Error("temporary failure");
  }, { force: true }), /temporary failure/);

  assert.deepEqual(cache.read("overview"), { version: 1 });
});
