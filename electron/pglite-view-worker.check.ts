import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteViewWorkerClient,
  PGLITE_WORKER_SHUTDOWN_TIMEOUT_MS,
} from "./pglite-view-worker-client.ts";
import { startPGliteViewWorker } from "./pglite-view-worker.ts";
import { createViewPortClient, createViewPortServer } from "../src/lib/data-views/server/view-port.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for PGlite view worker");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the worker entry serves only the financial live views and never treats a view name as SQL", async () => {
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
  });
  const client = createPGliteViewWorkerClient(worker);
  try {
    await assert.rejects(
      client.subscribe("SELECT 1", {}, () => {}),
      /subscription-failed/u,
      "renderer input must not be treated as SQL",
    );
    await assert.rejects(client.subscribe("system.health", {}, () => {}), /subscription-failed/u);
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
    try {
      // Reaching the view source's own rejection proves the worker became ready.
      await assert.rejects(client.subscribe("SELECT 1", {}, () => {}), /subscription-failed/u);
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

test("the worker serves its injected view source, closes subscriptions, and removes owned data", async () => {
  let stops = 0;
  const source = {
    async subscribe(view: string, _params: object, onValue: (value: unknown) => void) {
      if (view !== "fake.value") throw new Error(`Unknown view: ${view}`);
      onValue({ ready: true });
      return async () => { stops += 1; };
    },
  };
  const channel = new MessageChannel();
  const runtime = await startPGliteViewWorker(channel.port1, () => source);
  const client = createViewPortClient(channel.port2);
  const values: unknown[] = [];
  try {
    assert.ok(existsSync(runtime.dataDir));
    const stop = await client.subscribe("fake.value", {}, (value) => values.push(value));
    await waitFor(() => values.length === 1);
    assert.deepEqual(values, [{ ready: true }]);
    await stop();
    assert.equal(stops, 1);
    await assert.rejects(client.subscribe("SELECT 1", {}, () => {}), /subscription-failed/u);
    await client.close();
    await runtime.close();
    assert.equal(existsSync(runtime.dataDir), false);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test("closing the client gives a slow worker shutdown its full bound before terminating", async (t) => {
  // The worker's close ends with PGlite's shutdown checkpoint. Terminating it
  // early leaves the ledger needing WAL recovery on the next launch.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const posted: unknown[] = [];
  let terminated = 0;
  const worker = Object.assign(new EventEmitter(), {
    postMessage(message: unknown) { posted.push(message); },
    terminate() { terminated += 1; return Promise.resolve(1); },
  });
  const client = createPGliteViewWorkerClient(
    worker as unknown as Parameters<typeof createPGliteViewWorkerClient>[0],
  );

  const closing = client.close();
  await settle();
  assert.deepEqual(posted.at(-1), { kind: "shutdown" });
  t.mock.timers.tick(PGLITE_WORKER_SHUTDOWN_TIMEOUT_MS - 1);
  await settle();
  assert.equal(terminated, 0);

  worker.emit("message", { kind: "worker-stopped" });
  await closing;
  assert.equal(terminated, 1);
});

test("a financial view's error after its first value reaches the port as a failed subscription", async () => {
  let fail: (error: unknown) => void = () => {};
  const financial = {
    async subscribe(_view: string, _params: object, onValue: (value: unknown) => void, onError?: (error: unknown) => void) {
      onValue({ page: 1 });
      fail = (error) => onError?.(error);
      return async () => {};
    },
  };
  const channel = new MessageChannel();
  const server = createViewPortServer(channel.port1, financial);
  const responses: unknown[] = [];
  channel.port2.on("message", (message) => responses.push(message));
  try {
    channel.port2.postMessage({ kind: "subscribe", id: 1, view: "financial.overview.current", params: {} });
    await waitFor(() => responses.some((response) => (response as { kind: string }).kind === "value"));
    fail(new Error("recompute failed"));
    await waitFor(() => responses.some((response) => (response as { kind: string }).kind === "error"));
    assert.deepEqual(responses.at(-1), { kind: "error", id: 1, code: "subscription-failed" });
  } finally {
    await server.close();
    channel.port1.close();
    channel.port2.close();
  }
});
