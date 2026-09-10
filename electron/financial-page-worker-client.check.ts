import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createFinancialPageWorkerClient } from "./financial-page-worker-client.ts";

test("a blocking financial read cannot block the Electron main event loop", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page }) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 180) {}
      parentPort.postMessage({ id, ok: true, value: { page } });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const startedAt = performance.now();
    const page = client.load("assets");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(
      performance.now() - startedAt < 100,
      "a worker-side projection must leave timers and input delivery responsive",
    );
    assert.deepEqual(await page, { page: "assets" });
  } finally {
    await client.close();
  }
});

test("worker failures reject the matching page request", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id }) => {
      parentPort.postMessage({ id, ok: false, error: "synthetic projection failure" });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    await assert.rejects(client.load("overview"), /synthetic projection failure/);
  } finally {
    await client.close();
  }
});

test("closing the worker rejects pending and future page requests deterministically", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", () => setTimeout(() => {}, 1_000));
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  const pending = assert.rejects(
    client.load("spending"),
    { message: "Financial page worker is closed." },
  );

  await client.close();
  await pending;
  await assert.rejects(
    client.load("overview"),
    { message: "Financial page worker is closed." },
  );
});
