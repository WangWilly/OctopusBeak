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

test("cutoff-qualified page reads verify the served knowledge point", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id }) => {
      parentPort.postMessage({ id, ok: true, value: { knowledgePoint: 6 } });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    await assert.rejects(
      client.load("assets", { cutoff: { knowledgePoint: 7 } }),
      { message: "canonical-cutoff-unavailable" },
    );
  } finally {
    await client.close();
  }
});

test("cutoff inputs are forwarded for every financial page", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page, input }) => {
      parentPort.postMessage({
        id,
        ok: true,
        value: { page, knowledgePoint: input?.cutoff?.knowledgePoint ?? 0 },
      });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const cutoff = { knowledgePoint: 17 };
    const results = await Promise.all([
      client.load("overview", { cutoff }),
      client.load("assets", { cutoff }),
      client.load("liabilities", { cutoff }),
      client.load("spending", { cutoff }),
    ]);
    assert.deepEqual(results.map((result) => ({
      page: (result as unknown as { page: string }).page,
      knowledgePoint: (result as unknown as { knowledgePoint: number }).knowledgePoint,
    })), [
      { page: "overview", knowledgePoint: 17 },
      { page: "assets", knowledgePoint: 17 },
      { page: "liabilities", knowledgePoint: 17 },
      { page: "spending", knowledgePoint: 17 },
    ]);
  } finally {
    await client.close();
  }
});

test("cutoff inputs and section names are forwarded through the worker seam", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page, section, input }) => {
      parentPort.postMessage({
        id,
        ok: true,
        value: { page, section, knowledgePoint: input?.cutoff?.knowledgePoint ?? 0 },
      });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const result = await client.loadSection("spending", "primary", {
      cutoff: { knowledgePoint: 23 },
    });
    assert.deepEqual(result, {
      page: "spending-section",
      section: "primary",
      knowledgePoint: 23,
    });
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

test("Spending decisions use the worker boundary without blocking the caller", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page }) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 180) {}
      parentPort.postMessage({ id, ok: true, value: { patch: { kind: "spending-purchase-report-patch" } } });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const startedAt = performance.now();
    const action = client.confirmCandidate({ kind: "candidate", candidateId: "candidate" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(performance.now() - startedAt < 100);
    assert.deepEqual(await action, { patch: { kind: "spending-purchase-report-patch" } });
  } finally {
    await client.close();
  }
});
