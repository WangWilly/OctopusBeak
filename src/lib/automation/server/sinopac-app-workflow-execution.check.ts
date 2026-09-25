import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Page, Response } from "playwright";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type { WorkflowBrowserPort, WorkflowFinancialCommitPort } from "../workflow-executor.ts";
import { SINOPAC_LOGIN_URL } from "../../../workflows/sinopac-statements.ts";
import { taskById } from "./tasks.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { workflowInputForTask, workflowStartUrlForTask } from "./app-workflow-registry.ts";

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
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    url: () => url,
    status: () => 200,
    request: () => ({ method: () => "POST" }),
    body: async () => bytes,
    allHeaders: async () => ({ "content-type": "application/json; charset=utf-8" }),
  } as unknown as Response;
}

function createPage(options: { malformedTransactionSource?: boolean } = {}) {
  const capturedCredentials = new Map<string, string>();
  const accountResponse = response(ACCOUNT_URL, [{
    Header: "SUCCESS",
    Message: "",
    SubInfo: [{
      DataText: "Synthetic TWD deposit",
      DataValue: "000000000001",
      DisplayText: "TWD",
    }],
  }]);
  const transactionPayload = options.malformedTransactionSource
    ? [{ Header: "SUCCESS", Message: "", SubInfo: [{ DataText1: 42 }] }]
    : [{ Header: "FAIL", Message: "查無資料" }];
  const page = {
    url: () => TRANSACTION_URL,
    context: () => ({ cookies: async () => [] }),
    locator(selector: string) {
      return {
        first() { return this; },
        async isVisible() {
          if (selector.includes("user-logout") || selector.includes("MMALogout")) return true;
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
    async goto() { return undefined; },
    async waitForResponse(predicate: (candidate: Response) => boolean) {
      if (predicate(accountResponse)) return accountResponse;
      throw new Error("Unexpected SinoPac App response waiter.");
    },
    async evaluate<T>(
      expression: unknown,
      argument?: { path?: string; bodyText?: string },
    ): Promise<T> {
      if (typeof argument?.path === "string") {
        return {
          url: argument.path.includes("ws_debitacct") ? ACCOUNT_URL : TRANSACTIONS_URL,
          status: 200,
          method: "POST",
          contentType: "application/json; charset=utf-8",
          bytes: [...Buffer.from(JSON.stringify(transactionPayload), "utf8")],
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
    script: task.script,
    kind: task.kind,
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
    logPath: "",
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
  assert.deepEqual(task.command, []);
  assert.equal(task.script, "workflow:sinopac-statements");
  assert.equal(workflowStartUrlForTask(task.workflowId), SINOPAC_LOGIN_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    credentials: {
      sinopac_user_id: "synthetic-user-id",
      sinopac_account: "synthetic-account",
      sinopac_password: "synthetic-password",
    },
  });

  const root = await mkdtemp(join(tmpdir(), "sinopac-app-workflow-"));
  const previousDirectory = process.cwd();
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const committed: unknown[][] = [];
  const page = createPage();
  const financialCommit = commitPort(committed);
  let observedStartUrl: string | undefined;
  try {
    process.chdir(root);
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider);
    const browser: WorkflowBrowserPort = {
      async withPage(run) { return run(page); },
    };
    const result = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: { financialCommit, now: () => "2026-09-25T12:00:00.000Z" },
      workflowBrowserPortFactory: ({ startUrl }) => {
        observedStartUrl = startUrl;
        return browser;
      },
    }, async () => {});

    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(result.status, "completed");
    assert.equal(observedStartUrl, SINOPAC_LOGIN_URL);
    assert.equal(committed.length, 1);
    assert.ok((committed[0]?.[0] as { provider?: string }).provider === "sinopac");
    assert.equal(run?.status, "completed");
    assert.equal(run?.logPath, "");
    assert.equal(run?.logTail, "");
    assert.ok(run?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(root), [], "typed App dispatch writes no source, output, or log files");

    const rejectedRunId = await createRun(provider);
    const invalidPage = createPage({ malformedTransactionSource: true });
    const invalidBrowser: WorkflowBrowserPort = {
      async withPage(runPage) { return runPage(invalidPage); },
    };
    const rejected = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: rejectedRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: { financialCommit, now: () => "2026-09-25T12:00:00.000Z" },
      workflowBrowserPortFactory: () => invalidBrowser,
    }, async () => {});
    assert.equal(rejected.status, "failed");
    assert.equal(committed.length, 1, "malformed source is rejected before Canonical Financial Commit");
    const rejectedRun = await provider.automation.taskRunById(rejectedRunId);
    assert.ok(rejectedRun?.events.some((event) => event.code === "source-response-rejected"));
    assert.deepEqual(await readdir(root), []);
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
