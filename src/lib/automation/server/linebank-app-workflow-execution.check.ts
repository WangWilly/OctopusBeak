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
import { linebankEpochMillisecondsFromSourceDateTime } from "../../../workflows/linebank-statements.ts";
import { taskById } from "./tasks.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { workflowInputForTask, workflowStartUrlForTask } from "./app-workflow-registry.ts";

const LOGIN_URL = "https://accessibility.linebank.com.tw/login";
const TRANSACTION_URL = "https://accessibility.linebank.com.tw/transaction";
const ACCOUNT_URL = "https://accessibility.linebank.com.tw/v1/account/common/payables?featureTypeCode=01";
const TRANSACTIONS_URL = "https://accessibility.linebank.com.tw/v1/account/history/transactions";
const account = {
  acctNbr: "123456789012",
  arrId: "arr-main",
  acctNick: "Main account",
  pdNm: "LINE Bank account",
  currCd: "TWD",
};
const accountSource = {
  ...account,
  acctBal: "1000.00",
  wdrwAvblAmt: "900.00",
  acctColrTpCd: "01",
  acctColrTpVal: "blue",
  acctCardImgUrl: null,
  pdCd: "TWD-DEP",
  simpAcctTpCd: null,
  jntAcctMbrTpCd: "personal-main-account",
  isSecuAcctBndg: false,
  debitCardFundBlcknYn: "N",
  txBlcknYn: "N",
  opnDtm: 1_700_000_000_000,
  jntMbrListCnt: 0,
  totJntAcctMbrCnt: 0,
  rcntTxfrListCnt: 0,
};
const syntheticEnvironment = () => ({
  [["LIBRETTO", "CLOUD", "LINEBANK", "USER", "ID"].join("_")]: "synthetic-user-id",
  [["LIBRETTO", "CLOUD", "LINEBANK", "ACCOUNT"].join("_")]: "synthetic-account",
  [["LIBRETTO", "CLOUD", "LINEBANK", "PASSWORD"].join("_")]: "synthetic-password",
});

function transactionResponse(options: { pageNbr: number; incomplete?: boolean }) {
  const rows = options.pageNbr === 1
    ? [{
        txSeqNbr: "101",
        crrnDpstNthCnt: 1,
        txDt: "20260910",
        txTm: "101112",
        txDtm: linebankEpochMillisecondsFromSourceDateTime("20260910", "101112"),
        dpstWdrwDsCd: "1",
        txAmt: "100.00",
        afTxBal: "1000.00",
        bizTxFuncTpNm: "Synthetic deposit",
        cncdTxYn: "N",
        cnclTxYn: "N",
      }]
    : [];
  return {
    code: "200",
    content: {
      ...accountSource,
      pageNbr: options.pageNbr,
      pageCnt: 1000,
      totTxCnt: options.incomplete ? 2 : 1,
      txCnt: rows.length,
      txLst: rows,
    },
  };
}

function createPage(options: {
  signedIn?: boolean;
  malformedTransactions?: boolean;
  incompleteTransactions?: boolean;
  onSourceRead?: () => void;
} = {}) {
  let signedIn = options.signedIn ?? true;
  let currentUrl = signedIn ? TRANSACTION_URL : LOGIN_URL;
  const accountBody = JSON.stringify({
    code: "200",
    message: "success",
    content: { dpstAcctList: [{ ...account, wdrwAvblAmt: "900.00" }] },
  });
  const headers = {
    date: "Wed, 09 Sep 2026 02:09:43 GMT",
    "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
    "content-type": "application/json;charset=UTF-8",
  };
  const credentialValues = new Map<string, string>();
  const locator = (selector: string) => ({
    first() { return locator(selector); },
    last() { return locator(selector); },
    nth() { return locator(selector); },
    filter() { return this; },
    async count() {
      if (selector === "#account-dropdown") return signedIn ? 1 : 0;
      if (selector.includes("登入友善網路銀行")) return 1;
      return 0;
    },
    async isVisible() {
      if (selector === "#account-dropdown") return signedIn;
      if (selector === "body") return true;
      return selector.includes("登入友善網路銀行");
    },
    async waitFor() { return undefined; },
    async fill(value: string) { credentialValues.set(selector, value); },
    async click() { return undefined; },
    async textContent() { return "2026/09"; },
    async boundingBox() { return { x: 1, y: 1, width: 640, height: 480 }; },
  });
  const page = {
    url: () => currentUrl,
    locator,
    getByRole: (_role: string, roleOptions?: { name?: string }) =>
      locator(`role:${roleOptions?.name ?? ""}`),
    async goto(url: string) { currentUrl = url; },
    async waitForTimeout() { return undefined; },
    async waitForURL() { return undefined; },
    async evaluate(
      _expression: unknown,
      argument: { path: string; body?: { pageNbr?: number } },
    ) {
      options.onSourceRead?.();
      const isAccount = argument.path.includes("/v1/account/common/payables");
      const body = isAccount
        ? accountBody
        : JSON.stringify(transactionResponse({
            pageNbr: argument.body?.pageNbr ?? 1,
            incomplete: options.incompleteTransactions,
          }));
      const bodyBytes = isAccount || !options.malformedTransactions
        ? [...new TextEncoder().encode(body)]
        : [0xc3, 0x28];
      return {
        bodyBytes,
        url: isAccount ? ACCOUNT_URL : TRANSACTIONS_URL,
        status: 200,
        method: isAccount ? "GET" : "POST",
        headers,
      };
    },
    setSignedIn(value: boolean) {
      signedIn = value;
      currentUrl = value ? TRANSACTION_URL : LOGIN_URL;
    },
  };
  return Object.assign(page, {
    credential(selector: string) { return credentialValues.get(selector) ?? ""; },
  }) as unknown as Page & {
    setSignedIn(value: boolean): void;
    credential(selector: string): string;
  };
}

async function createRun(provider: ReturnType<typeof createPgliteOperationalProvider>) {
  const created = await provider.automation.createTaskRun({
    taskId: "linebank-statements",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  return created.taskRunId;
}

function commitPort(committed: unknown[][]): WorkflowFinancialCommitPort {
  return {
    async execute(items) {
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

test("LINE Bank App task dispatches through the typed browser host and injected commit", async () => {
  const task = taskById("linebank-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "linebank-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  assert.equal(workflowStartUrlForTask(task.workflowId), LOGIN_URL);
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    credentials: {
      linebank_user_id: "synthetic-user-id",
      linebank_account: "synthetic-account",
      linebank_password: "synthetic-password",
    },
    accountFilters: [],
    currencyFilters: [],
  });

  const root = await mkdtemp(join(tmpdir(), "linebank-app-workflow-"));
  const previousDirectory = process.cwd();
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const committed: unknown[][] = [];
  let sourceReadBeforeCommit = true;
  const page = createPage({
    signedIn: false,
    onSourceRead() { sourceReadBeforeCommit &&= committed.length === 0; },
  });
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
      workflowPorts: {
        financialCommit,
        now: () => "2026-09-25T12:00:00.000Z",
        humanAssistance: {
          async request(contract) {
            assert.equal(contract.stageId, "linebank-login-verification");
            assert.equal(contract.targets[0]?.id, "sign-in-page");
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
    assert.equal(result.status, "completed");
    assert.equal(observedStartUrl, LOGIN_URL);
    assert.equal(page.credential("#nationalId"), "synthetic-user-id");
    assert.equal(page.credential("#userId"), "synthetic-account");
    assert.equal(page.credential("#pw"), "synthetic-password");
    assert.equal(sourceReadBeforeCommit, true);
    assert.equal(committed.length, 1);
    assert.equal(committed[0]?.length, 2);
    assert.equal((committed[0]?.[0] as { provider?: string }).provider, "linebank");
    assert.equal(run?.status, "completed");
    assert.equal(Object.hasOwn(run ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(run ?? {}, "logTail"), false);
    assert.ok(run?.events.some((event) => event.code === "human-assistance-requested"));
    assert.ok(run?.events.some((event) => event.code === "source-validation-completed"));
    assert.ok(run?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(root), [], "App dispatch writes no source, output, or log files");

    const malformedPage = createPage({ malformedTransactions: true });
    const malformedRunId = await createRun(provider);
    const malformed = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: malformedRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: () => ({ async withPage(runPage) { return runPage(malformedPage); } }),
    }, async () => {});
    assert.equal(malformed.status, "failed");
    assert.equal(committed.length, 1, "malformed LINE Bank response is rejected before commit");
    const malformedRun = await provider.automation.taskRunById(malformedRunId);
    assert.ok(malformedRun?.events.some((event) => event.code === "source-decoding-failed"));

    const incompletePage = createPage({ incompleteTransactions: true });
    const incompleteRunId = await createRun(provider);
    const incomplete = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: incompleteRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: () => ({ async withPage(runPage) { return runPage(incompletePage); } }),
    }, async () => {});
    assert.equal(incomplete.status, "failed");
    assert.equal(committed.length, 1, "incomplete LINE Bank pagination is rejected before commit");
    const incompleteRun = await provider.automation.taskRunById(incompleteRunId);
    assert.ok(incompleteRun?.events.some((event) => event.code === "source-validation-rejected"));

    let cancellationRequested = false;
    const cancellationPage = createPage({ signedIn: false });
    const cancellationRunId = await createRun(provider);
    const cancelled = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: cancellationRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      isCancellationRequested: () => cancellationRequested,
      workflowPorts: {
        financialCommit,
        humanAssistance: {
          async request(contract) {
            assert.equal(contract.stageId, "linebank-login-verification");
            cancellationRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 75));
            return "verified";
          },
        },
      },
      workflowBrowserPortFactory: () => ({ async withPage(runPage) { return runPage(cancellationPage); } }),
    }, async () => {});
    assert.equal(cancelled.status, "cancelled");
    assert.equal(committed.length, 1, "cancelled LINE Bank run does not commit");
    assert.deepEqual(await readdir(root), []);
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
