import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import test from "node:test";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { startPGliteViewWorker } from "./pglite-view-worker.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for PGlite view worker");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("dedicated PGlite worker exposes only named live views and closes subscriptions", async () => {
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
  });
  const client = createPGliteViewWorkerClient(worker);
  const rows: unknown[][] = [];
  try {
    const stop = await client.subscribe("system.health", {}, (value) => rows.push(value));
    await waitFor(() => rows.length === 1);
    assert.deepEqual(rows[0], [{ ready: true }]);

    await stop();
    await assert.rejects(
      client.subscribe("SELECT 1", {}, () => {}),
      /subscription-failed/u,
      "renderer input must not be treated as SQL",
    );
  } finally {
    await client.close();
  }
});

test("bundled worker reopens its explicit data directory after durable close", async () => {
  const bundledWorker = join(process.cwd(), "build-electron", "pglite-view-worker.cjs");
  assert.ok(existsSync(bundledWorker), "build:electron must emit the dedicated worker");
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-pglite-bundle-check-"));
  const openAndClose = async () => {
    const worker = new Worker(bundledWorker, { workerData: { dataDir } });
    const client = createPGliteViewWorkerClient(worker);
    const rows: unknown[][] = [];
    try {
      await client.subscribe("system.health", {}, (value) => rows.push(value));
      await waitFor(() => rows.length === 1);
      assert.deepEqual(rows[0], [{ ready: true }]);
    } finally {
      await client.close();
    }
  };
  try {
    await openAndClose();
    assert.ok((await readdir(dataDir)).length > 0, "the worker must use the supplied data directory");
    await openAndClose();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("worker-owned temporary data is removed after shutdown", async () => {
  const channel = new MessageChannel();
  const runtime = await startPGliteViewWorker(channel.port1);
  try {
    assert.ok(existsSync(runtime.dataDir));
    await runtime.close();
    assert.equal(existsSync(runtime.dataDir), false);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});
