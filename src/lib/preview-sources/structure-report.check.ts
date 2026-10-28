import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageChannel, type WorkerOptions } from "node:worker_threads";
import { PREVIEW_SOURCE_FIXTURE_ENV } from "./fixture-source.ts";

process.env[PREVIEW_SOURCE_FIXTURE_ENV] = "1";
const workDirectory = mkdtempSync(join(tmpdir(), "preview-structure-report-"));
process.chdir(workDirectory);
process.on("exit", () => rmSync(workDirectory, { recursive: true, force: true }));

const { inventoryFields } = await import("./response-shape.ts");
const {
  MAX_PREVIEW_RESPONSE_SHAPES_CHARS,
  parsePreviewResponseShapes,
  previewResponseShapes,
  previewStructureReportIssueUrl,
  previewStructureReports,
  renderPreviewStructureReport,
} = await import("./structure-report.ts");
const { PREVIEW_FIXTURE_SOURCE } = await import("./fixture-source.ts");
const { previewWorkflowDefinition, takePreviewObservations } = await import("./workflow.ts");
const { runAppWorkflowWorker } = await import("../automation/server/app-workflow-worker-runtime.ts");
const { APP_WORKFLOW_WORKER_PROTOCOL_VERSION, parseAppWorkflowWorkerOutboundFrame } = await import("../automation/server/app-workflow-worker-protocol.ts");
const { CHECK_PGLITE_RPC, executeTaskRunForCheck } = await import("../automation/server/task-run-check-support.ts");
const { taskById } = await import("../automation/server/tasks.ts");
const { createPgliteOperationalProvider } = await import("../../ledger/pglite/operational.ts");
const { createTestPGlite } = await import("../../ledger/pglite/baseline-test-template.ts");
const { PGliteStore } = await import("../../ledger/pglite/transaction.ts");

type OutboundFrame = ReturnType<typeof parseAppWorkflowWorkerOutboundFrame>;
type ResponseShapes = ReturnType<typeof previewResponseShapes>;

const SENSITIVE = {
  account: ["0081", "2345", "67890123"].join(""),
  card: ["4311", "9512", "3456", "7788"].join("-"),
  holder: "王小明",
  holderLatin: "Wang Hsiao Ming",
  amount: "128,450.75",
  balance: 98234.5,
  date: "2026/10/14",
  remark: "轉帳給房東 十月租金",
  token: ["synthetic", "session", "marker"].join("-"),
  email: "someone@example.com",
};

const syntheticBody = {
  resultCode: "0000",
  accountList: [{
    accountNo: SENSITIVE.account,
    accountName: SENSITIVE.holder,
    nickname: SENSITIVE.holderLatin,
    currency: "TWD",
    accountType: "SAV",
    balance: SENSITIVE.balance,
    availableAmount: SENSITIVE.amount,
    [`acct${SENSITIVE.account}`]: "x",
  }],
  transactions: [{ txDate: SENSITIVE.date, memo: SENSITIVE.remark, amount: "-1,200", cardNo: SENSITIVE.card }],
  session: { token: SENSITIVE.token, email: SENSITIVE.email },
};

function assertNoSensitiveContent(text: string) {
  for (const [name, value] of Object.entries(SENSITIVE)) {
    assert.equal(text.includes(String(value)), false, `${name} must not appear`);
  }
  assert.equal(text.includes("1,200"), false, "transaction amounts must not appear");
}

function assertOnlyAllowedDigitRuns(text: string, allowed: readonly string[]) {
  const runs = text.match(/\d{4,}/gu) ?? [];
  assert.deepEqual(runs.filter((run) => !allowed.includes(run)), [], "only allowed codes keep 4+ digit runs");
}

test("the report reuses the probe's field inventory and carries no identifiers, names, amounts, dates, or free text", () => {
  const shapes = previewResponseShapes([{
    endpoint: `https://bank.example/api/v1/accounts/${SENSITIVE.account}/detail?token=${SENSITIVE.token}`,
    status: 200,
    body: syntheticBody,
  }]);
  assert.deepEqual(shapes.responses[0]?.fields, inventoryFields(syntheticBody), "one sanitizer serves the probe and the App");
  assert.equal(shapes.responses[0]?.endpoint, "/api/v1/accounts/{segment}/detail");
  const text = renderPreviewStructureReport({
    previewSource: "synthetic",
    institution: "bank-009",
    product: "deposit",
    failure: { stage: "collection", errorCode: "source-validation-failed" },
    ...shapes,
  }, "0.8.2");
  assertNoSensitiveContent(text);
  assertOnlyAllowedDigitRuns(text, []);
  const report = JSON.parse(text) as Record<string, unknown>;
  assert.equal(report.appVersion, "0.8.2");
  assert.equal(report.previewSource, "synthetic");
  assert.deepEqual(report.failure, { stage: "collection", errorCode: "source-validation-failed" });
  assert.match(text, /"\$\.accountList\[\]\.currency"/u);
  assert.match(text, /"TWD"/u);
});

test("the worker boundary refuses shapes that smuggle raw values", () => {
  const valid = previewResponseShapes([{ endpoint: "/accounts", status: 200, body: syntheticBody }]);
  assert.deepEqual(parsePreviewResponseShapes(JSON.parse(JSON.stringify(valid))), valid);
  const withField = (path: string, shape: unknown) => ({
    responses: [{ endpoint: "/accounts", status: 200, fields: { [path]: shape } }],
    omittedResponses: 0,
  });
  assert.throws(() => parsePreviewResponseShapes(withField("$.name", { types: ["string"], present: 1, of: 1, values: [SENSITIVE.account] })));
  assert.throws(() => parsePreviewResponseShapes(withField("$.name", { types: ["string"], present: 1, of: 1, values: [SENSITIVE.holder] })));
  assert.throws(() => parsePreviewResponseShapes(withField(`$.${SENSITIVE.holder}`, { types: ["string"], present: 1, of: 1 })));
  assert.throws(() => parsePreviewResponseShapes(withField("$.memo", { types: ["string"], present: 1, of: 1, sample: SENSITIVE.remark })));
  assert.throws(() => parsePreviewResponseShapes({
    responses: [{ endpoint: `/accounts/${SENSITIVE.account}`, status: 200, fields: {} }],
    omittedResponses: 0,
  }));
});

test("the report stays within the size bound and keeps the most recent responses", () => {
  const wide = (seed: number) => Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${seed}_${index}`, "A"]));
  const observations = Array.from({ length: 30 }, (_, index) => ({ endpoint: `/page${index}`, status: 200, body: wide(index) }));
  const shapes = previewResponseShapes(observations);
  assert.ok(JSON.stringify(shapes.responses, null, 2).length <= MAX_PREVIEW_RESPONSE_SHAPES_CHARS);
  assert.ok(shapes.omittedResponses > 0);
  assert.equal(shapes.responses.length + shapes.omittedResponses, observations.length);
  assert.equal(shapes.responses.at(-1)?.endpoint, "/page29");
  assert.throws(() => parsePreviewResponseShapes({
    responses: observations.slice(0, 20).map((observation) => ({
      endpoint: observation.endpoint,
      status: 200,
      fields: inventoryFields(observation.body),
    })),
    omittedResponses: 0,
  }), "an oversized report is refused at the worker boundary");
});

test("the GitHub issue link carries a fixed template and no report content", () => {
  const shapes = previewResponseShapes([{ endpoint: "/api/accounts", status: 500, body: syntheticBody }]);
  const url = new URL(previewStructureReportIssueUrl(PREVIEW_FIXTURE_SOURCE));
  assert.equal(`${url.origin}${url.pathname}`, "https://github.com/WangWilly/OctopusBeak/issues/new");
  assert.deepEqual([...url.searchParams.keys()], ["title", "body"]);
  assert.equal(url.searchParams.get("title"), "Preview source report: Preview fixture bank deposit");
  const href = decodeURIComponent(url.href);
  for (const path of Object.keys(shapes.responses[0]!.fields).filter((path) => path !== "$")) {
    assert.equal(href.includes(path), false, `${path} stays out of the URL`);
  }
  assert.equal(href.includes("/api/accounts"), false);
  assert.equal(href.includes("TWD"), false);
  assert.match(url.searchParams.get("body") ?? "", /```json\n\n```$/u);
});

test("a failed preview run sanitizes its observations inside the worker and releases the raw bodies", async () => {
  const failure = new Error("unexpected response shape");
  const definition = previewWorkflowDefinition({
    ...PREVIEW_FIXTURE_SOURCE,
    async run(context) {
      context.preview.observe({ endpoint: `/accounts/${SENSITIVE.account}`, status: 200, body: syntheticBody });
      throw failure;
    },
  });
  const channel = new MessageChannel();
  const raw: string[] = [];
  const terminal = new Promise<OutboundFrame>((resolve) => {
    channel.port2.on("message", (value: unknown) => {
      raw.push(JSON.stringify(value));
      const frame = parseAppWorkflowWorkerOutboundFrame(value);
      if (frame.kind === "call" && frame.method === "event") {
        channel.port2.postMessage({ protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION, kind: "reply", callId: frame.callId, ok: true, result: null });
      }
      else if (frame.kind === "failed" || frame.kind === "completed" || frame.kind === "cancelled") resolve(frame);
    });
  });
  try {
    await runAppWorkflowWorker({
      port: channel.port1,
      workerData: {
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        workflowId: definition.id,
        taskRunId: "run-preview-1",
        input: { startUrl: PREVIEW_FIXTURE_SOURCE.startUrl, credentials: {} },
        browserConnection: { endpoint: "http://127.0.0.1:9222", targetId: "fixture-target" },
      },
      resolveDefinition: () => definition,
      browser: { async withPage(run) { return await run({} as never); } },
      previewWrite: { write: async () => ({ accounts: 0, balances: 0, transactions: 0, statements: 0, closedAccounts: 0 }) },
    });
    const frame = await terminal;
    assert.equal(frame.kind, "failed");
    const shapes = frame.kind === "failed" ? frame.previewResponses : undefined;
    assert.equal(shapes?.responses.length, 1);
    assert.equal(shapes?.responses[0]?.endpoint, "/accounts/{segment}");
    assert.deepEqual(shapes?.responses[0]?.fields, inventoryFields(syntheticBody));
    for (const message of raw) assertNoSensitiveContent(message);
    assert.deepEqual(takePreviewObservations(failure), [], "the worker took and dropped the raw observations");
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

class TerminalFakeWorker extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  constructor(workerData: WorkerOptions["workerData"], terminal: (taskRunId: string) => Record<string, unknown>) {
    super();
    const start = workerData as { taskRunId: string };
    setImmediate(() => {
      this.emit("online");
      this.emit("message", { protocolVersion: 2, ...terminal(start.taskRunId) });
      this.emit("exit", 0);
    });
  }
  postMessage() {}
  terminate() {
    setImmediate(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }
}

test("only a failed preview run keeps a report, and it keeps nothing but the sanitized report", async () => {
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  try {
    const provider = createPgliteOperationalProvider(store);
    const shapes: ResponseShapes = previewResponseShapes([{ endpoint: "/accounts", status: 200, body: syntheticBody }]);
    const run = async (taskId: string, terminal: (taskRunId: string) => Record<string, unknown>) => {
      const task = taskById(taskId);
      assert.ok(task, `${taskId} is registered`);
      const { taskRunId } = await provider.automation.createTaskRun({
        taskId: task.id,
        kind: task.kind,
        status: "preparing",
        attempt: 1,
        maxAttempts: 1,
        startedAt: new Date().toISOString(),
      });
      const result = await executeTaskRunForCheck(task, provider.automation, {
        taskRunId,
        pgliteRpc: CHECK_PGLITE_RPC,
        launchEnv: {},
        workflowBrowserPortFactory: () => ({ async withPage(work) { return await work({} as never); } }),
        appWorkflowBrowserConnectionForRun: (runId) => ({ endpoint: "http://127.0.0.1:43121", targetId: `host-page-${runId}` }),
        appWorkflowWorkerFactory: (_path, options) => new TerminalFakeWorker(options.workerData, terminal),
      });
      return { result, taskRunId };
    };
    const failed = (taskRunId: string) => ({ kind: "failed", taskRunId, errorCode: "source-validation-failed", previewResponses: shapes });

    const previewFailure = await run("preview-synthetic", failed);
    assert.equal(previewFailure.result.status, "failed");
    const report = previewStructureReports.get("preview-synthetic");
    assert.deepEqual(report, {
      previewSource: "synthetic",
      institution: "bank-009",
      product: "deposit",
      failure: { stage: null, errorCode: "source-validation-failed" },
      responses: shapes.responses,
      omittedResponses: 0,
    });
    assertNoSensitiveContent(JSON.stringify(report));
    const persisted = await provider.automation.taskRunById(previewFailure.taskRunId);
    assertNoSensitiveContent(JSON.stringify(persisted));
    assert.equal(JSON.stringify(persisted).includes("accountList"), false, "the report is not persisted with the run");

    const previewSuccess = await run("preview-synthetic", (taskRunId) => ({ kind: "completed", taskRunId, summary: null }));
    assert.equal(previewSuccess.result.status, "completed");
    assert.equal(previewStructureReports.get("preview-synthetic"), null, "a later successful run drops the earlier report");

    const verifiedFailure = await run("ctbc-statements", failed);
    assert.equal(verifiedFailure.result.status, "failed");
    assert.equal(previewStructureReports.get("ctbc-statements"), null, "a verified source never gets a report");
  } finally {
    await store.close();
  }
});
