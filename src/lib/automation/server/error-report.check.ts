import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildErrorReport,
  errorReportUrl,
  forgetFailureDiagnostics,
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

test("masking keeps short numbers", () => {
  assert.equal(maskNumbers("錯誤 503，版本 0.9.5"), "錯誤 503，版本 0.9.5");
});
