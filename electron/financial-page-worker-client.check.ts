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
    const action = client.confirmCandidate({
      kind: "candidate",
      invoiceIdentityId: "invoice",
      transactionIdentityId: "transaction",
      idempotencyKey: "candidate-confirmation-1",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(performance.now() - startedAt < 100);
    assert.deepEqual(await action, { patch: { kind: "spending-purchase-report-patch" } });
  } finally {
    await client.close();
  }
});

test("Spending command identity and idempotency inputs cross the worker unchanged", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, input }) => {
      parentPort.postMessage({
        id,
        ok: true,
        value: {
          knowledgePoint: 12,
          patch: {
            kind: "spending-recognition-patch",
            baseKnowledgeAt: 11,
            knowledgeAt: 12,
            operation: "establish-link",
            invoiceId: input.invoiceIdentityId,
            transactionId: input.transactionIdentityId,
            eventId: "event",
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const result = await client.confirmCandidate({
      kind: "candidate",
      invoiceIdentityId: "invoice",
      transactionIdentityId: "transaction",
      idempotencyKey: "renderer-key-unchanged",
    });
    assert.equal((result as unknown as { knowledgePoint: number }).knowledgePoint, 12);
    assert.equal(
      (result.patch as unknown as { idempotencyKey: string }).idempotencyKey,
      "renderer-key-unchanged",
    );
  } finally {
    await client.close();
  }
});

test("cancelling a generation removes queued reads and lets the newer generation proceed", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    let dispatches = 0;
    parentPort.on("message", ({ id, requestToken }) => {
      const dispatchIndex = ++dispatches;
      const delay = dispatchIndex === 1 ? 30 : 0;
      setTimeout(() => parentPort.postMessage({
        id,
        requestToken,
        ok: true,
        value: { knowledgePoint: 4, dispatchIndex, requestToken },
      }), delay);
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const cancelledActive = client.loadSection("spending", "primary", undefined, "generation-old");
    const cancelledQueued = client.loadSection("spending", "secondary", undefined, "generation-old");
    const current = client.loadSection("spending", "primary", undefined, "generation-current");

    client.cancel("generation-old");

    await assert.rejects(cancelledActive, { name: "FinancialReadCancelledError" });
    await assert.rejects(cancelledQueued, { name: "FinancialReadCancelledError" });
    assert.deepEqual(await current, {
      knowledgePoint: 4,
      dispatchIndex: 2,
      requestToken: "generation-current",
    });
  } finally {
    await client.close();
  }
});

test("a mismatched worker token is ignored until the matching response arrives", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, requestToken }) => {
      parentPort.postMessage({ id, requestToken: "different-generation", ok: true, value: { knowledgePoint: 5 } });
      setTimeout(() => parentPort.postMessage({ id, requestToken, ok: true, value: { knowledgePoint: 5 } }), 10);
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    let settled = false;
    const result = client.loadSection("assets", "primary", undefined, "generation-current")
      .then((value) => {
        settled = true;
        return value;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    assert.equal(settled, false, "a response from another generation cannot settle the request");
    await result;
    assert.equal(settled, true);
  } finally {
    await client.close();
  }
});

test("cancelling reads never cancels a spending mutation command", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page, requestToken }) => {
      if (page === "spending-action") {
        parentPort.postMessage({ id, ok: true, value: { knowledgePoint: 8, action: true } });
        return;
      }
      setTimeout(() => parentPort.postMessage({ id, requestToken, ok: true, value: { knowledgePoint: 8 } }), 20);
    });
  `, { eval: true });
  const client = createFinancialPageWorkerClient(worker);
  try {
    const read = client.loadSection("spending", "primary", undefined, "generation-old");
    const action = client.confirmCandidate({
      kind: "candidate",
      invoiceIdentityId: "invoice",
      transactionIdentityId: "transaction",
      idempotencyKey: "mutation-1",
    });
    const readOutcome = assert.rejects(read, { name: "FinancialReadCancelledError" });
    client.cancel("generation-old");
    assert.deepEqual(await action, { knowledgePoint: 8, action: true });
    await readOutcome;
  } finally {
    await client.close();
  }
});
