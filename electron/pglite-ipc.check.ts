import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./pglite-ipc.ts", import.meta.url), "utf8");

for (const channel of [
  "data-views:subscribe",
  "data-views:unsubscribe",
  "data-views:rows",
  "data-views:error",
]) {
  assert.match(source, new RegExp(channel.replace(/[-:]/gu, "[-:]")));
}
assert.match(source, /workerData:\s*\{\s*dataDir:/u, "the worker gets one explicit data directory");
assert.match(source, /sender\.id/u, "subscriptions are scoped by renderer sender");
assert.match(source, /once\("destroyed"/u, "renderer destruction cleans owned subscriptions");
assert.match(source, /worker\.onError/u, "worker failure is translated to typed renderer errors");
assert.match(source, /did-navigate/u, "renderer navigation cleans old page subscriptions");
assert.match(source, /PGlite data worker is unavailable/u, "worker errors do not expose raw database details");
assert.match(source, /duplicate-subscription/u);
assert.match(source, /worker-unavailable/u);
assert.doesNotMatch(source, /ipcMain\.handle\([^\n]*sql/u, "IPC must not expose arbitrary SQL");
assert.doesNotMatch(source, /\.query\(/u, "IPC must delegate to named worker views");
