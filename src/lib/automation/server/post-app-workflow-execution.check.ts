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
import {
  POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
  POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT,
  POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
} from "../../../workflows/post-current-deposit-balances.ts";
import { taskById } from "./tasks.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { workflowInputForTask, workflowStartUrlForTask } from "./app-workflow-registry.ts";

const HOME_URL = "https://ipost.post.gov.tw/pst/home.html";
const INDEX_URL = "https://ipost.post.gov.tw/pst/index.html";
const DISPATCHER_URL = "https://ipost.post.gov.tw/pst/EsoafDispatcher";
const accountId = ["0311", "5240", "5293", "95"].join("");

function syntheticEnvironment() {
  const credentialPrefix = "LIBRETTO_CLOUD";
  return Object.fromEntries([
    [`${credentialPrefix}_POST_USER_ID`, "test-user-id"],
    [`${credentialPrefix}_POST_ACCOUNT`, "test-account"],
    [`${credentialPrefix}_POST_PASSWORD`, "test-password"],
  ]);
}

test("Chunghwa Post task is catalogued as an App-owned typed workflow", () => {
  const task = taskById("post-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "post-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  assert.equal(workflowStartUrlForTask(task.workflowId), HOME_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    credentials: {
      post_user_id: "test-user-id",
      post_account: "test-account",
      post_password: "test-password",
    },
  });
});

function statementResponse(options: { malformed?: boolean; incomplete?: boolean; onRead(): void }): Response {
  const requestPostData = JSON.stringify({
    header: { TxnCode: "EB100200", BizCode: "inquire" },
    body: { _USER_ID: accountId, DATE: "20260201", END_DATE: "20260824" },
  });
  const screen = {
    header: { EndBracket: false, OutputType: "Screen" },
    body: {
      host_rs_1: {
        ITEM: [{
          PRS_DATE: "20260802",
          TX_TIME: "091011",
          MEM: "Synthetic deposit",
          TX_AMT: "100",
          BAL_AMT: "900",
          DR_FLG: "+",
        }],
      },
    },
  };
  const terminal = {
    header: { EndBracket: false, OutputType: "EndBracket" },
    body: { result: "success" },
  };
  const bytes = options.malformed
    ? Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28])
    : Buffer.from(JSON.stringify(options.incomplete ? [screen] : [screen, terminal]), "utf8");
  return {
    url: () => DISPATCHER_URL,
    status: () => 200,
    request: () => ({ method: () => "POST", postData: () => requestPostData }),
    body: async () => {
      options.onRead();
      return bytes;
    },
    allHeaders: async () => ({ "content-type": "application/json; charset=utf-8" }),
  } as unknown as Response;
}

function balanceResponse(onRead: () => void): Response {
  const requestPostData = JSON.stringify({
    header: {
      TxnCode: POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
      BizCode: POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
    },
    body: { pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT },
  });
  const payload = [
    {
      header: { EndBracket: false, OutputType: "Screen" },
      body: { itemList: [{ ACT_TYPE: "PS", ACT_NO: accountId, BAL: "123" }] },
    },
    {
      header: {
        EndBracket: false,
        OutputType: "EndBracket",
        OutputData: { SERVER_TIMESTAMP: "1788919984" },
      },
      body: { result: "success" },
    },
  ];
  return {
    url: () => DISPATCHER_URL,
    status: () => 200,
    request: () => ({ method: () => "POST", postData: () => requestPostData }),
    body: async () => {
      onRead();
      return Buffer.from(JSON.stringify(payload), "utf8");
    },
    allHeaders: async () => ({
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store,private,max-age=900",
      date: "Wed, 09 Sep 2026 02:13:03 GMT",
    }),
  } as unknown as Response;
}

function fakePostPage(options: {
  signedIn?: boolean;
  malformed?: boolean;
  incomplete?: boolean;
} = {}) {
  let signedIn = options.signedIn ?? false;
  let currentUrl = HOME_URL;
  let sourceResponseReads = 0;
  const credentialValues = new Map<string, string>();
  const pendingResponses = [
    statementResponse({
      malformed: options.malformed,
      incomplete: options.incomplete,
      onRead() { sourceResponseReads += 1; },
    }),
    balanceResponse(() => { sourceResponseReads += 1; }),
  ];
  const makeLocator = (selector: string) => {
    const locator = {
      first() { return locator; },
      last() { return locator; },
      nth() { return locator; },
      filter() { return locator; },
      waitFor: async () => undefined,
      isVisible: async () => selector.includes("btn_td_orange_dtl") ? signedIn : false,
      count: async () => selector.includes("btn_td_orange_dtl") && signedIn ? 1 : 0,
      click: async () => undefined,
      fill: async (value: string) => { credentialValues.set(selector, value); },
      focus: async () => undefined,
      inputValue: async () => credentialValues.get(selector) ?? "",
      isChecked: async () => true,
      elementHandle: async () => ({ dispose: async () => undefined }),
      boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 24 }),
      evaluate: async () => true,
    };
    return locator;
  };
  const page = {
    locator: makeLocator,
    getByText: (text: string) => makeLocator(`text:${text}`),
    url: () => currentUrl,
    goto: async (url: string) => { currentUrl = url; },
    on: () => undefined,
    off: () => undefined,
    waitForTimeout: async () => undefined,
    waitForResponse: async (predicate: (candidate: Response) => boolean) => {
      const index = pendingResponses.findIndex(predicate);
      if (index < 0) throw new Error("No synthetic Post App response matched.");
      return pendingResponses.splice(index, 1)[0]!;
    },
  };
  const result = Object.assign(page, {
    setSignedIn(value: boolean) { signedIn = value; },
    credential(selector: string) { return credentialValues.get(selector) ?? ""; },
  }) as unknown as Page & {
    setSignedIn(value: boolean): void;
    credential(selector: string): string;
    readonly sourceResponseReads: number;
  };
  Object.defineProperty(result, "sourceResponseReads", { get: () => sourceResponseReads });
  return result;
}

async function createRun(provider: ReturnType<typeof createPgliteOperationalProvider>) {
  const task = taskById("post-statements");
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

function financialCommitPort(committed: unknown[][], hasSource: () => boolean): WorkflowFinancialCommitPort {
  return {
    async execute(items) {
      assert.equal(hasSource(), true, "all source responses are read before financial commit");
      const received = [];
      for await (const item of items) received.push(item);
      committed.push(received);
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

test("Post App task dispatches the typed provider with human assistance, complete sources, and injected financial commit", async () => {
  const task = taskById("post-statements");
  assert.ok(task);
  const root = await mkdtemp(join(tmpdir(), "post-app-workflow-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await PGlite.create());
  const page = fakePostPage();
  const committed: unknown[][] = [];
  const commitPort = financialCommitPort(committed, () => page.sourceResponseReads === 2);
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
      workflowPorts: {
        financialCommit: commitPort,
        now: () => "2026-09-25T12:00:00.000Z",
        humanAssistance: {
          async request(contract) {
            assert.equal(contract.stageId, "ipost-login-captcha");
            assert.equal(contract.targets[0]?.id, "captcha-input");
            page.setSignedIn(true);
            return "verified";
          },
        },
      },
      workflowBrowserPortFactory: ({ startUrl }) => {
        observedStartUrl = startUrl;
        return browser;
      },
    }, async () => {});

    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(result.status, "completed", JSON.stringify({
      events: run?.events.map(({ stage, code }) => [stage, code]),
      errorCode: run?.appWorkflowOutcome?.errorCode,
      sourceResponseReads: page.sourceResponseReads,
      commits: committed.length,
    }));
    assert.equal(observedStartUrl, HOME_URL);
    assert.equal(page.credential("#cifID"), "test-user-id");
    assert.equal(page.credential("#userID_1_Input"), "test-account");
    assert.equal(page.credential("#userPWD_1_Input"), "test-password");
    assert.equal(committed.length, 1);
    assert.ok(committed[0]!.length > 0);
    assert.ok(committed[0]!.every((item) => (item as { provider: string }).provider === "post"));
    assert.equal(run?.status, "completed");
    assert.equal(Object.hasOwn(run ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(run ?? {}, "logTail"), false);
    assert.ok(run?.events.some((event) => event.code === "human-assistance-requested"));
    assert.ok(run?.events.some((event) => event.code === "human-assistance-completed"));
    assert.ok(run?.events.some((event) => event.code === "source-decoding-completed"));
    assert.ok(run?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(root), [], "typed App dispatch writes no source, output, or log files");
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Post App dispatch rejects malformed and incomplete EndBracket sources before commit", async () => {
  const task = taskById("post-statements");
  assert.ok(task);
  const root = await mkdtemp(join(tmpdir(), "post-app-invalid-source-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await PGlite.create());
  const committed: unknown[][] = [];
  try {
    process.chdir(root);
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    for (const source of [{ malformed: true }, { incomplete: true }]) {
      const taskRunId = await createRun(provider);
      const page = fakePostPage({ signedIn: true, ...source });
      const result = await runAutomationTaskExecution(task, provider.automation, {
        taskRunId,
        launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
        workflowPorts: { financialCommit: financialCommitPort(committed, () => page.sourceResponseReads === 2) },
        workflowBrowserPortFactory: () => ({ async withPage(run) { return run(page); } }),
      }, async () => {});
      assert.equal(result.status, "failed");
      assert.equal(committed.length, 0);
      const run = await provider.automation.taskRunById(taskRunId);
      assert.ok(run?.events.some((event) => event.code === "source-response-rejected" || event.code === "source-decode-rejected"));
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Post App dispatch cancellation during human assistance does not collect or commit", async () => {
  const task = taskById("post-statements");
  assert.ok(task);
  const root = await mkdtemp(join(tmpdir(), "post-app-cancel-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await PGlite.create());
  const committed: unknown[][] = [];
  let cancellationRequested = false;
  try {
    process.chdir(root);
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider);
    const page = fakePostPage();
    const result = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      isCancellationRequested: () => cancellationRequested,
      workflowPorts: {
        financialCommit: financialCommitPort(committed, () => page.sourceResponseReads === 2),
        humanAssistance: {
          async request() {
            cancellationRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 100));
            return "verified";
          },
        },
      },
      workflowBrowserPortFactory: () => ({ async withPage(run) { return run(page); } }),
    }, async () => {});
    assert.equal(result.status, "cancelled");
    assert.equal(committed.length, 0);
    assert.equal(page.sourceResponseReads, 0);
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.status, "cancelled");
    assert.deepEqual(await readdir(root), []);
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
