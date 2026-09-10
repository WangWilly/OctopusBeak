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
