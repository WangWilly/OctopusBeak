import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { errors, type Page, type Response } from "playwright";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type { WorkflowBrowserPort, WorkflowFinancialCommitPort } from "../workflow-executor.ts";
import { SINOPAC_LOGIN_URL } from "../../../workflows/sinopac-statements.ts";
import { taskById } from "./tasks.ts";
import { executeTaskRunForCheck } from "./task-run-check-support.ts";
import { appWorkflowRegistration, workflowStartUrlForWorkflow } from "./app-workflow-registry.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { fakeProviderReply } from "../../../workflows/provider-response-reader.fixtures.ts";

const TRANSACTION_URL = "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx";
const ACCOUNT_URL = "https://mma.sinopac.com/ws/bank/transdetail/ws_debitacct.ashx?1";
const TRANSACTIONS_URL = "https://mma.sinopac.com/ws/bank/transdetail/ws_transdetailMerge.ashx?1";

const credentialKey = (suffix: string) => ["LIBRETTO", "CLOUD", "SINOPAC", suffix].join("_");
const syntheticEnvironment = () => ({
  [credentialKey("USER_ID")]: "synthetic-user-id",
  [credentialKey("ACCOUNT")]: "synthetic-account",
  [credentialKey("PASSWORD")]: "synthetic-password",
});

function response(url: string, value: unknown): Response {
  return fakeProviderReply({
    url,
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(value),
  });
}

type SourceFault =
  | "malformedTransactionSource"
  | "malformedAccountList"
  | "transactionTimeout"
  | "accountListTimeout";

const timeout = () => new errors.TimeoutError("Timeout 60000ms exceeded.");

function createPage(options: { fault?: SourceFault } = {}) {
  const capturedCredentials = new Map<string, string>();
  const accountResponse = response(ACCOUNT_URL, [{
    Header: "SUCCESS",
    Message: "",
    SubInfo: [{
      DataText: "Synthetic TWD deposit",
      DataValue: options.fault === "malformedAccountList" ? 1 : "000000000001",
      DisplayText: "TWD",
    }],
  }]);
  const transactionPayload = options.fault === "malformedTransactionSource"
    ? [{ Header: "SUCCESS", Message: "", SubInfo: [{ DataText1: 42 }] }]
    : [{ Header: "FAIL", Message: "查無資料" }];
  const mainFrame = {};
  const page = {
    url: () => TRANSACTION_URL,
    context: () => ({ cookies: async () => [] }),
    locator(selector: string) {
      return {
        first() { return this; },
        async isVisible() {
          if (selector.includes("user-logout") || selector.includes("MMALogout") || selector === "#StartDate") return true;
          return false;
        },
        async click() { return undefined; },
        async waitFor() { return undefined; },
        async count() { return 0; },
        async all() { return []; },
        async getAttribute() { return null; },
        async fill(value: string) { capturedCredentials.set(selector, value); },
        async inputValue() { return capturedCredentials.get(selector) ?? ""; },
      };
    },
    getByText: () => ({ async count() { return 0; } }),
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    async goto() { return undefined; },
    async waitForResponse(predicate: (candidate: Response) => boolean) {
      if (predicate(accountResponse)) {
        if (options.fault === "accountListTimeout") throw timeout();
        return accountResponse;
      }
      throw new Error("Unexpected SinoPac App response waiter.");
    },
    async evaluate<T>(
      expression: unknown,
      argument?: { url?: string },
    ): Promise<T> {
      if (typeof argument?.url === "string") {
        if (options.fault === "transactionTimeout" && argument.url.includes("ws_transdetailMerge")) throw timeout();
        return {
          url: argument.url.includes("ws_debitacct") ? ACCOUNT_URL : TRANSACTIONS_URL,
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          base64: Buffer.from(JSON.stringify(transactionPayload), "utf8").toString("base64"),
        } as T;
      }
      if (typeof expression === "string") {
        return {
          botGlobal: false,
          fetchSource: "function fetch() { [native code] }",
          openSource: "function open() { [native code] }",
        } as T;
      }
      return undefined as T;
    },
  };
  return Object.assign(page, {
    credential(selector: string) { return capturedCredentials.get(selector) ?? ""; },
  }) as unknown as Page & { credential(selector: string): string };
}

async function createRun(provider: ReturnType<typeof createPgliteOperationalProvider>) {
  const task = taskById("sinopac-statements");
  assert.ok(task);
  const created = await provider.automation.createTaskRun({
    taskId: task.id,
    kind: task.kind,
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  return created.taskRunId;
}

function commitPort(receivedItems: unknown[][]): WorkflowFinancialCommitPort {
  return {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      receivedItems.push(received);
      return {
        status: "completed",
        items: received.map((item) => ({
          itemKey: item.itemKey,
          provider: item.provider,
          product: item.product,
          status: "committed",
          admissionSummaries: [],
          value: {},
          relationWarnings: [],
        })),
        diagnostics: [],
        committedCount: received.length,
        failedCount: 0,
      } as never;
    },
  };
}

test("SinoPac App task dispatches through typed workflow and injected financial commit", async () => {
  const task = taskById("sinopac-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "sinopac-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  assert.equal(workflowStartUrlForWorkflow(task.workflowId), SINOPAC_LOGIN_URL);
  assert.deepEqual(appWorkflowRegistration(task.workflowId)?.inputFromEnvironment(syntheticEnvironment()), {
    credentials: {
      sinopac_user_id: "synthetic-user-id",
      sinopac_account: "synthetic-account",
      sinopac_password: "synthetic-password",
    },
    statementTypes: ["deposit"],
    attachedPreviewProducts: [],
  });

  const root = await mkdtemp(join(tmpdir(), "sinopac-app-workflow-"));
  const previousDirectory = process.cwd();
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  const committed: unknown[][] = [];
  const page = createPage();
  const financialCommit = commitPort(committed);
  let observedStartUrl: string | undefined;
  try {
    process.chdir(root);
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider);
    const browser: WorkflowBrowserPort = {
      async withPage(run) { return run(page); },
    };
    const result = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workerPorts: { financialCommit, now: () => "2026-09-25T12:00:00.000Z" },
      workflowBrowserPort: ({ startUrl }) => {
        observedStartUrl = startUrl;
        return browser;
      },
    });

    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(result.status, "completed");
    assert.equal(observedStartUrl, SINOPAC_LOGIN_URL);
    assert.equal(committed.length, 1);
    assert.ok((committed[0]?.[0] as { provider?: string }).provider === "sinopac");
    assert.equal(run?.status, "completed");
    assert.equal(Object.hasOwn(run ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(run ?? {}, "logTail"), false);
    assert.ok(run?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(root), [], "typed App dispatch writes no source, output, or log files");

    // ADR 0106: only a check of the reply names a validation failure; a wait for it stays collection.
    for (const [fault, errorCode] of [
      ["malformedTransactionSource", "source-validation-failed"],
      ["malformedAccountList", "source-validation-failed"],
      ["transactionTimeout", "source-collection-failed"],
      ["accountListTimeout", "source-collection-failed"],
    ] as const) {
      const rejectedRunId = await createRun(provider);
      const invalidPage = createPage({ fault });
      const invalidBrowser: WorkflowBrowserPort = {
        async withPage(runPage) { return runPage(invalidPage); },
      };
      const rejected = await executeTaskRunForCheck(task, provider.automation, {
        taskRunId: rejectedRunId,
        launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
        workerPorts: { financialCommit, now: () => "2026-09-25T12:00:00.000Z" },
        workflowBrowserPort: () => invalidBrowser,
      });
      assert.equal(rejected.status, "failed", fault);
      assert.equal(committed.length, 1, `${fault} is rejected before Canonical Financial Commit`);
      const rejectedRun = await provider.automation.taskRunById(rejectedRunId);
      assert.equal(rejectedRun?.appWorkflowOutcome?.errorCode, errorCode, fault);
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
