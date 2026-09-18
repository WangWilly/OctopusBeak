import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  financialPerformanceTelemetry,
} from "../src/lib/performance/financial-performance-telemetry.ts";
import { createFinancialPageWorkerClient } from "./financial-page-worker-client.ts";

test("financial page loads and spending actions emit correlated privacy-bounded stages", async () => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ id, page, input }) => {
      const value = page.endsWith("section")
        ? { knowledgePoint: input?.cutoff?.knowledgePoint ?? 3, value: {} }
        : page === "spending-action"
          ? { knowledgePoint: 4, patch: { kind: "spending-purchase-report-patch", knowledgeAt: 4, baseKnowledgeAt: 3 } }
          : { knowledgePoint: 3 };
      parentPort.postMessage({ id, ok: true, value });
    });
  `, { eval: true });
  const events: Array<{
    operation: string;
    span: string;
    correlationId: string;
    errorCode?: string;
  }> = [];
  const unsubscribe = financialPerformanceTelemetry.subscribe((event) => {
    events.push({
      operation: event.operation,
      span: event.span,
      correlationId: event.correlationId,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    });
  });
  financialPerformanceTelemetry.clear();
  const client = createFinancialPageWorkerClient(worker);
  try {
    await client.loadSection("spending", "primary", { cutoff: { knowledgePoint: 3 } });
    await client.loadSection("spending", "secondary", { cutoff: { knowledgePoint: 3 } });
    await client.confirmCandidate({
      kind: "direct",
      invoiceIdentityId: "invoice",
      transactionIdentityId: "transaction",
      idempotencyKey: "pair-1",
    });
    await client.denyCandidate({ kind: "candidate", candidateId: "candidate" });
    await client.revokeLink({ invoiceId: "invoice", transactionId: "transaction", idempotencyKey: "unlink-1" });
  } finally {
    await client.close();
    unsubscribe();
  }

  const loadEvents = events.filter((event) => event.operation === "financial-load");
  const actionEvents = events.filter((event) => event.operation === "spending-action");
  assert.equal(loadEvents.filter((event) => event.span === "worker-dispatch").length, 2);
  assert.equal(loadEvents.filter((event) => event.span === "worker-response").length, 2);
  assert.equal(actionEvents.filter((event) => event.span === "worker-dispatch").length, 3);
  assert.equal(actionEvents.filter((event) => event.span === "worker-response").length, 3);
  for (const group of [loadEvents, actionEvents]) {
    const correlationIds = new Set(group.map((event) => event.correlationId));
    assert.ok(correlationIds.size >= 1);
  }
  assert.equal(events.some((event) => event.errorCode), false);
  assert.equal(JSON.stringify(events).includes("invoice"), false);
  assert.equal(JSON.stringify(events).includes("transaction"), false);
});
