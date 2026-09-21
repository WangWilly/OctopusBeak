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

test("financial reads carry the refresh generation to the worker boundary", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, options }) => {
      parentPort.postMessage({ id, ok: true, value: options });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    assert.deepEqual(await client.load("overview", { expectedVersion: 7 }), {
      expectedVersion: 7,
    });
  } finally {
    await client.close();
  }
});

test("block reads are independently addressable at the worker boundary", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page, target, block, options }) => {
      parentPort.postMessage({ id, ok: true, value: { page, target, block, options } });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    assert.deepEqual(await client.loadBlock("overview", "chart", { expectedVersion: 7 }), {
      page: "block",
      target: "overview",
      block: "chart",
      options: { expectedVersion: 7 },
    });
  } finally {
    await client.close();
  }
});

test("automation details carry only sanitized credential state across the worker boundary", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, automationCredentialState }) => {
      parentPort.postMessage({ id, ok: true, value: automationCredentialState });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const state = {
      revision: 4,
      status: { USER: true },
      fileNames: { CERT: "client.p12" },
      invalidFileKeys: [],
      invalidFileReasons: {},
    } as const;
    assert.deepEqual(
      await client.loadBlock("automation", "details", undefined, state),
      state,
    );
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

test("pairing candidate ranking uses the worker boundary without blocking the caller", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page }) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 180) {}
      parentPort.postMessage({
        id,
        ok: true,
        value: {
          page,
          dataVersion: 7,
          candidates: [{
            purchaseId: "transaction:tx",
            transactionId: "tx",
            description: "Coffee shop",
            amount: { coefficient: "1000", scale: 0, currency: "TWD" },
            occurrence: { value: "2026-09-01", precision: "date", timeZone: "Asia/Taipei", origin: "source-reported" },
            stream: "bank",
            effectiveDateBasis: "consume-date",
          }],
          totalCandidateCount: 1,
          nextOffset: null,
        },
      });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const startedAt = performance.now();
    const pairing = client.rankPairingCandidates({ invoiceIdentityId: "invoice", dataVersion: 7 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(performance.now() - startedAt < 100);
    assert.deepEqual(await pairing, {
      page: "spending-pairing",
      dataVersion: 7,
      candidates: [{
        purchaseId: "transaction:tx",
        transactionId: "tx",
        description: "Coffee shop",
        amount: { coefficient: "1000", scale: 0, currency: "TWD" },
        occurrence: { value: "2026-09-01", precision: "date", timeZone: "Asia/Taipei", origin: "source-reported" },
        stream: "bank",
        effectiveDateBasis: "consume-date",
      }],
      totalCandidateCount: 1,
      nextOffset: null,
    });
  } finally {
    await client.close();
  }
});

test("pairing index prewarm uses the worker boundary without blocking the caller", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page, input }) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 180) {}
      parentPort.postMessage({
        id,
        ok: true,
        value: { page, status: "ready", dataVersion: input.dataVersion, reused: false },
      });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const startedAt = performance.now();
    const prewarm = client.prewarmPairingCandidates({ dataVersion: 7 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(performance.now() - startedAt < 100);
    assert.deepEqual(await prewarm, {
      page: "spending-pairing-prewarm",
      status: "ready",
      dataVersion: 7,
      reused: false,
    });
  } finally {
    await client.close();
  }
});
