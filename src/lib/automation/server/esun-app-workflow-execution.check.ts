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
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "./config-files.ts";
import { createAppWorkflowBrowserPort } from "./app-browser-host.ts";
import { taskById } from "./tasks.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { workflowInputForTask, workflowStartUrlForTask } from "./app-workflow-registry.ts";

const BANK_ENTRY_URL = "https://ebank.esunbank.com.tw/index.jsp";
const TIMELINE_URL = "https://ebank.esunbank.com.tw/GW/creditLastYear/getFilterResult";
const SUMMARY_URL = "https://ebank.esunbank.com.tw/GW/creditBill/getSummaryResult";
const testEnvironment = () => ({
  [["LIBRETTO", "CLOUD", "ESUN", "USER", "ID"].join("_")]: "synthetic-user-id",
  [["LIBRETTO", "CLOUD", "ESUN", "ACCOUNT"].join("_")]: "synthetic-account",
  [["LIBRETTO", "CLOUD", "ESUN", "PASSWORD"].join("_")]: "synthetic-password",
  [CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]: "synthetic-esun-managed-secret",
});

function monthAtOffset(now: Date, offset: number) {
  const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const day = Math.min(now.getDate(), new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(day).padStart(2, "0"),
  };
}

function response(value: unknown, url: string): Response {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    status: () => 200,
    url: () => url,
    request: () => ({ method: () => "POST" }),
    body: async () => bytes,
    headers: () => ({}),
  } as unknown as Response;
}

function timelineResponse(now: Date) {
  return {
    body: {
      rtnCode: "S",
      cursor: 1,
      transList: Array.from({ length: 13 }, (_, offset) => {
        const month = monthAtOffset(now, offset);
        return {
          year: month.year,
          month: month.month,
          transDetailList: [{
            merchantName: `Synthetic purchase ${offset}`,
            paymentCurrency: "TWD",
            paymentAmount: 100 + offset,
            transCurrency: "TWD",
            transAmount: 100 + offset,
            cardNo: "1234-****-****-5678",
            statusName: offset === 0 ? "已入帳" : "未入帳",
            transMonthDay: `${month.month}${month.day}`,
          }],
        };
      }),
    },
  };
}

function statementSummary(period: string) {
  const [year, month] = period.split("/").map(Number);
  const lastDay = new Date(year!, month!, 0).getDate();
  const dueDate = new Date(year!, month!, 20);
  return {
    body: {
      rtnCode: "S",
      billInfo: {
        billDate: `${year}${String(month).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`,
        paymentDueDate: `${dueDate.getFullYear()}${String(dueDate.getMonth() + 1).padStart(2, "0")}20`,
        billTotalInfoList: [{ billTotalCurrency: "TWD", billTotalAmount: 3200 }],
        minimumPaymentInfoList: [{ minimumPaymentCurrency: "TWD", minimumPaymentAmount: 200 }],
      },
    },
  };
}

function fakePage(now: Date) {
  const summaries = [monthAtOffset(now, 1), monthAtOffset(now, 2)]
    .map(({ year, month }) => `${year}/${month}`);
  const timeline = response(timelineResponse(now), TIMELINE_URL);
  const summaryResponses = summaries.map((period) => response(statementSummary(period), SUMMARY_URL));
  const inputValues = new Map<string, string>();
  let signedIn = false;
  let popupRequestCount = 0;
  const makeLocator = (selector: string) => ({
    waitFor: async () => undefined,
    click: async () => undefined,
    fill: async (value: string) => { inputValues.set(selector, value); },
    inputValue: async () => inputValues.get(selector) ?? "",
    isVisible: async () => true,
    allTextContents: async () => selector === ".info-scrollable li" ? summaries : [],
    first() { return this; },
    last() { return this; },
    nth() { return this; },
    evaluate: async () => undefined,
    boundingBox: async () => ({ x: 0, y: 0, width: 900, height: 700 }),
  });
  const popup = (bill: boolean) => ({
    waitForURL: async () => undefined,
    waitForResponse: async (predicate: (candidate: Response) => boolean) => {
      const candidates = bill ? summaryResponses : [timeline];
      const index = candidates.findIndex(predicate);
      if (index < 0) throw new Error("Unexpected E.SUN App workflow response waiter.");
      return candidates.splice(index, 1)[0]!;
    },
    locator: makeLocator,
    getByText: () => ({ click: async () => undefined, isVisible: async () => true }),
    close: async () => undefined,
  });
  const page = {
    url: () => BANK_ENTRY_URL,
    goto: async () => undefined,
    on: () => undefined,
    getByText: (text: string) => ({
      isVisible: async () => text !== "信用卡" || signedIn,
      waitFor: async () => {
        if (text === "信用卡" && !signedIn) throw new Error("E.SUN sign-in is incomplete.");
      },
      click: async () => undefined,
    }),
    waitForEvent: async () => {
      popupRequestCount += 1;
      return popup(popupRequestCount === 2);
    },
    waitForResponse: async (predicate: (candidate: Response) => boolean) => {
      const optionalResponse = {
        status: () => 204,
        url: () => "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
      } as unknown as Response;
      if (predicate(optionalResponse)) return optionalResponse;
      throw new Error("Unexpected E.SUN App workflow response waiter.");
    },
    locator: makeLocator,
    getByRole: (_role: string, options: { name?: string } = {}) => ({
      click: async () => undefined,
      isVisible: async () => options.name !== "確定登入",
    }),
  };
  return {
    page: page as unknown as Page,
    finishSignIn() { signedIn = true; },
    credential(selector: string) { return inputValues.get(selector) ?? ""; },
  };
}

async function createRun(provider: ReturnType<typeof createPgliteOperationalProvider>) {
  const created = await provider.automation.createTaskRun({
    taskId: "esun-credit-card-statements",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  return created.taskRunId;
}

test("E.SUN App task dispatch maps credentials, hosted URL, human assistance, events, and commit", async () => {
  const task = taskById("esun-credit-card-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "esun-credit-card-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  assert.equal(workflowStartUrlForTask(task.workflowId), BANK_ENTRY_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, testEnvironment()), {
    credentials: {
      esun_user_id: "synthetic-user-id",
      esun_account: "synthetic-account",
      esun_password: "synthetic-password",
    },
    managedIdentitySecret: "synthetic-esun-managed-secret",
  });

  const root = await mkdtemp(join(tmpdir(), "esun-app-workflow-"));
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const now = new Date("2026-09-25T12:00:00.000Z");
  const hostPage = fakePage(now);
  const committed: unknown[][] = [];
  let observedStartUrl: string | undefined;
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider);
    const financialCommit: WorkflowFinancialCommitPort = {
      async execute(items) {
        const received = [];
        for await (const item of items) received.push(item);
        committed.push(received);
        return {
          status: "completed",
          items: received.map(() => ({ status: "committed" })),
          diagnostics: [],
          committedCount: received.length,
          failedCount: 0,
        } as never;
      },
    };
    const browserPort: WorkflowBrowserPort = {
      async withPage(run) {
        return run(hostPage.page);
      },
    };
    const result = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId,
      launchEnv: { ...testEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: {
        financialCommit,
        now: () => now.toISOString(),
        humanAssistance: {
          async request(contract) {
            assert.equal(contract.stageId, "esun-login-verification");
            assert.equal(contract.targets[0]?.id, "sign-in-page");
            hostPage.finishSignIn();
            return "verified";
          },
        },
      },
      workflowBrowserPortFactory: ({ startUrl }) => {
        observedStartUrl = startUrl;
        return browserPort;
      },
    }, async () => {});

    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(result.status, "completed", JSON.stringify({ events: run?.events.map(({ stage, code, completed, total }) => [stage, code, completed, total]), committed: committed.length }));
    assert.equal(observedStartUrl, BANK_ENTRY_URL);
    assert.equal(hostPage.credential('input[name="id"]'), "synthetic-user-id");
    assert.equal(hostPage.credential('input[name="userName"]'), "synthetic-account");
    assert.equal(hostPage.credential('input[name="pxssword"]'), "synthetic-password");
    assert.equal(committed.length, 1);
    assert.equal(committed[0]?.length, 1);
    assert.equal((committed[0]?.[0] as { provider?: string }).provider, "esun");
    assert.equal(run?.status, "completed");
    assert.equal(Object.hasOwn(run ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(run ?? {}, "logTail"), false);
    assert.ok(run?.events.some((event) => event.code === "human-assistance-requested"));
    assert.ok(run?.events.some((event) => event.code === "source-decoding-completed"));
    assert.ok(run?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(root), [], "typed App dispatch writes no source or output files");

    const cancelRunId = await createRun(provider);
    const cancelPage = fakePage(now);
    const cancelBrowser: WorkflowBrowserPort = {
      async withPage(runPage) {
        return runPage(cancelPage.page);
      },
    };
    let cancellationRequested = false;
    const cancelledResult = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: cancelRunId,
      launchEnv: { ...testEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      isCancellationRequested: () => cancellationRequested,
      workflowPorts: {
        financialCommit,
        now: () => now.toISOString(),
        humanAssistance: {
          async request(contract) {
            assert.equal(contract.stageId, "esun-login-verification");
            cancelPage.finishSignIn();
            return "verified";
          },
        },
        events: {
          async append(event) {
            await provider.automation.appendRunEvent(event);
            if (event.code === "collection-started") {
              cancellationRequested = true;
              await new Promise((resolve) => setTimeout(resolve, 75));
            }
          },
        },
      },
      workflowBrowserPortFactory: () => cancelBrowser,
    }, async () => {});
    assert.equal(cancelledResult.status, "cancelled");
    assert.equal((await provider.automation.taskRunById(cancelRunId))?.status, "cancelled");
    assert.equal(committed.length, 1, "cancelled E.SUN run does not reach financial commit");
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("App browser host opens a catalog start URL before invoking the workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "esun-app-browser-host-"));
  const visited: string[] = [];
  const page = { goto: async (url: string) => { visited.push(url); } } as unknown as Page;
  const context = { pages: () => [page], close: async () => undefined };
  try {
    const browser = createAppWorkflowBrowserPort({
      taskId: "esun-credit-card-statements",
      taskRunId: "run-esun-start-url-check",
      signal: new AbortController().signal,
      userDataDirectory: root,
      startUrl: BANK_ENTRY_URL,
      launchPersistentContext: async () => context as never,
    });
    const output = await browser.withPage(async () => "workflow-dispatched");
    assert.equal(output, "workflow-dispatched");
    assert.deepEqual(visited, [BANK_ENTRY_URL]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
