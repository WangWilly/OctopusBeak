import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildErrorReport,
  errorReportUrl,
  forgetFailureDiagnostics,
  forgetStaleFailureDiagnostic,
  InvalidErrorReport,
  maskNumbers,
  rememberFailureDiagnostic,
  sendErrorReport,
} from "./error-report.ts";
import type { WorkflowFailureDiagnostic } from "./workflow-failure-diagnostics.ts";

const CONTEXT = { appVersion: "0.9.5", osVersion: "15.4", locale: "zh-TW" as const };
const RECORD: WorkflowFailureDiagnostic = {
  version: 1,
  occurredAt: "2026-10-30T02:00:00.000Z",
  workflowId: "esun-credit-card-statements",
  taskRunId: "run-1",
  source: "workflow-worker",
  errorCode: "source-unavailable",
  stage: "authentication",
  error: { chain: [{ type: "TimeoutError", frames: [{ file: "build-electron/app-workflow-worker.cjs", line: 1, column: 2 }] }] },
};
const INPUT = {
  taskId: "esun-credit-card-statements",
  code: "source-unavailable",
  stage: "authentication",
  note: " 卡號 4311-2222-3333-4444 登入失敗 ",
  email: " me@example.com ",
};

test("the report carries the remembered diagnostic without its run id or time, and masks the note", () => {
  forgetFailureDiagnostics();
  rememberFailureDiagnostic(INPUT.taskId, RECORD);
  const report = buildErrorReport(INPUT, CONTEXT);
  assert.deepEqual(report, {
    schema: 1,
    appVersion: "0.9.5",
    osVersion: "15.4",
    arch: "arm64",
    locale: "zh-TW",
    source: "esun-credit-card-statements",
    code: "source-unavailable",
    stage: "authentication",
    diagnostic: { source: "workflow-worker", errorCode: "source-unavailable", stage: "authentication", chain: RECORD.error.chain },
    note: "卡號 [已遮蔽] 登入失敗",
    email: "me@example.com",
  });
  assert.doesNotMatch(JSON.stringify(report), /run-1|2026-10-30T02/);
});

test("a diagnostic from a different failure, or none at all, is left out", () => {
  forgetFailureDiagnostics();
  assert.equal(buildErrorReport(INPUT, CONTEXT).diagnostic, null);
  rememberFailureDiagnostic(INPUT.taskId, { ...RECORD, errorCode: "authentication-failed" });
  assert.equal(buildErrorReport(INPUT, CONTEXT).diagnostic, null);
});

test("inputs outside the report contract are refused before anything is sent", () => {
  for (const input of [
    { ...INPUT, taskId: "Bad Task" },
    { ...INPUT, code: "made-up" },
    { ...INPUT, stage: "somewhere" },
    { ...INPUT, note: "x".repeat(1001) },
    { ...INPUT, email: "nope" },
  ]) {
    assert.throws(() => buildErrorReport(input, CONTEXT), InvalidErrorReport);
  }
});

test("the report endpoint sits beside the ping endpoint; no endpoint means unavailable", async () => {
  assert.equal(errorReportUrl("https://t.example/v1/ping"), "https://t.example/v1/report");
  assert.equal(errorReportUrl(""), "");
  assert.deepEqual(await sendErrorReport("", buildErrorReport(INPUT, CONTEXT)), { ok: false, reason: "unavailable" });
});

test("responses map to what the person is told", async () => {
  const payload = buildErrorReport(INPUT, CONTEXT);
  const answer = (status: number, body = "") => (async () => new Response(body, { status })) as unknown as typeof fetch;
  assert.deepEqual(await sendErrorReport("https://t", payload, answer(201, JSON.stringify({ id: "r-1" }))), { ok: true, id: "r-1" });
  assert.deepEqual(await sendErrorReport("https://t", payload, answer(429)), { ok: false, reason: "rate-limited" });
  assert.deepEqual(await sendErrorReport("https://t", payload, answer(400)), { ok: false, reason: "invalid" });
  assert.deepEqual(await sendErrorReport("https://t", payload, answer(503)), { ok: false, reason: "unavailable" });
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.deepEqual(await sendErrorReport("https://t", payload, offline), { ok: false, reason: "network" });
});

test("masking catches full-width digits and any separator, and keeps short numbers", () => {
  assert.equal(maskNumbers("錯誤 503，版本 0.9.5"), "錯誤 503，版本 0.9.5");
  for (const card of ["４３１１２２２２３３３３４４４４", "4311 - 2222 - 3333 - 4444", "4311.2222.3333.4444", "4311－2222－3333－4444", "4311/2222/3333/4444"]) {
    assert.equal(maskNumbers(`卡號 ${card} 失敗`), "卡號 [已遮蔽] 失敗", card);
  }
});

test("a record from an earlier run is dropped once a later run of the task finishes", () => {
  forgetFailureDiagnostics();
  rememberFailureDiagnostic(INPUT.taskId, RECORD);
  forgetStaleFailureDiagnostic(INPUT.taskId, "run-1");
  assert.notEqual(buildErrorReport(INPUT, CONTEXT).diagnostic, null, "the run the record came from keeps it");
  forgetStaleFailureDiagnostic(INPUT.taskId, "run-2");
  assert.equal(buildErrorReport(INPUT, CONTEXT).diagnostic, null);
});

test("frames outside the app bundle are left out so the receiver accepts the report", () => {
  forgetFailureDiagnostics();
  rememberFailureDiagnostic(INPUT.taskId, {
    ...RECORD,
    error: { chain: [{ type: "Error", frames: [{ file: "src/lib/x.ts", line: 1, column: 1 }, ...RECORD.error.chain[0].frames] }] },
  });
  assert.deepEqual(buildErrorReport(INPUT, CONTEXT).diagnostic?.chain[0].frames, RECORD.error.chain[0].frames);
});

test("non-string inputs are refused as invalid", () => {
  assert.throws(() => buildErrorReport({ ...INPUT, taskId: null } as never, CONTEXT), InvalidErrorReport);
  assert.throws(() => buildErrorReport({ ...INPUT, stage: 3 } as never, CONTEXT), InvalidErrorReport);
});
