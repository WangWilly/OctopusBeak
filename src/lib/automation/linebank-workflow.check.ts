import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { workflowDefinitionForTask } from "./server/app-workflow-registry.ts";
import { strictSourceText } from "./source-text.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import { assertStoppedRun, STOPPED_COMMITS, stoppedCommitPort } from "./single-product-run.fixtures.ts";
import type {
  WorkflowContext,
  WorkflowContextWith,
  WorkflowHumanAssistancePort,
} from "./workflow-executor.ts";
import { signalRunEvent, type WorkflowRunEvent } from "./run-event.ts";
import { createWorkflowExecutor } from "./workflow-executor.ts";
import {
  linebankEpochMillisecondsFromSourceDateTime,
  runLineBankProviderWorkflow,
  type LineBankAccount,
  type LineBankTransactionsResponse,
} from "../../workflows/linebank-statements.ts";

const linebankStatementsWorkflow = workflowDefinitionForTask("linebank-statements")!;

const account: LineBankAccount = {
  acctNbr: "123456789012",
  arrId: "arr-main",
  acctNick: "Main account",
  pdNm: "LINE Bank account",
  currCd: "TWD",
};

const source = {
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

function transactionResponse(options: {
  pageNbr: number;
  incomplete?: boolean;
}): LineBankTransactionsResponse {
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
      ...source,
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
  signInAfterPolls?: number;
  onPoll?: () => void;
  notice?: boolean;
} = {}): Page & { setSignedIn(value: boolean): void; noticeOpen(): boolean } {
  let signedIn = options.signedIn ?? true;
  let polls = 0;
  let noticeOpen = options.notice ?? false;
  let currentUrl = signedIn
    ? "https://accessibility.linebank.com.tw/transaction"
    : "https://accessibility.linebank.com.tw/login";
  const accountBody = JSON.stringify({
    code: "200",
    message: "success",
    content: {
      dpstAcctList: [{ ...account, wdrwAvblAmt: "900.00" }],
    },
  });
  const headers = {
    date: "Wed, 09 Sep 2026 02:09:43 GMT",
    "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
    "content-type": "application/json;charset=UTF-8",
  };
  const fakeLocator = (selector: string) => ({
    first() { return this; },
    last() { return this; },
    nth() { return this; },
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
    async fill() { return undefined; },
    async click() { return undefined; },
    async textContent() { return "2026/09"; },
    async boundingBox() { return { x: 1, y: 1, width: 640, height: 480 }; },
  });
  const noticeButton = {
    async count() { return 1; },
    nth() { return noticeButton; },
    async isVisible() { return true; },
    async click() { noticeOpen = false; },
  };
  const notice = {
    async count() { return noticeOpen ? 1 : 0; },
    nth() { return notice; },
    async isVisible() { return noticeOpen; },
    getByRole: () => noticeButton,
    async waitFor() { return undefined; },
  };
  // The sign-in step checks for the approved alertdialog once per poll.
  const poll = () => {
    polls += 1;
    options.onPoll?.();
    if (options.signInAfterPolls !== undefined && polls >= options.signInAfterPolls) {
      signedIn = true;
      currentUrl = "https://accessibility.linebank.com.tw/transaction";
    }
  };
  const page = {
    url: () => currentUrl,
    locator: fakeLocator,
    getByRole: (role: string, options?: { name?: string }) => {
      if (role !== "alertdialog") return fakeLocator(`role:${options?.name ?? ""}`);
      poll();
      return notice;
    },
    on: () => undefined,
    off: () => undefined,
    async goto(url: string) {
      currentUrl = url;
    },
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
      const bytes = isAccount || !options.malformedTransactions
        ? [...new TextEncoder().encode(body)]
        : [0xc3, 0x28];
      return {
        bodyBytes: bytes,
        url: isAccount
          ? "https://accessibility.linebank.com.tw/v1/account/common/payables?featureTypeCode=01"
          : "https://accessibility.linebank.com.tw/v1/account/history/transactions",
        status: 200,
        method: isAccount ? "GET" : "POST",
        headers,
      };
    },
    setSignedIn(value: boolean) {
      signedIn = value;
      currentUrl = value
        ? "https://accessibility.linebank.com.tw/transaction"
        : "https://accessibility.linebank.com.tw/login";
    },
    noticeOpen: () => noticeOpen,
  };
  return page as unknown as Page & { setSignedIn(value: boolean): void; noticeOpen(): boolean };
}

function createContext(options: {
  page?: Page & { setSignedIn?(value: boolean): void };
  signal?: AbortSignal;
  onAssistance?: () => void;
} = {}) {
  const events: WorkflowRunEvent[] = [];
  const commits: unknown[][] = [];
  const assistance: string[] = [];
  const assist = (stageId: string) => {
    assistance.push(stageId);
    options.onAssistance?.();
  };
  const humanAssistance: WorkflowHumanAssistancePort = {
    async request(contract) {
      assist(contract.stageId);
      return "verified";
    },
  };
  let commitStarted = false;
  const selectedPage = options.page ?? createPage({
    onSourceRead() {
      assert.equal(commitStarted, false, "all provider sources are collected before commit");
    },
  });
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "linebank-typed-check",
    signal: options.signal ?? new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: {
      async withPage(run) {
        return run(selectedPage);
      },
    },
    text: strictSourceText,
    verification: {
      async complete(stage) {
        assist(stage.stageId);
      },
    },
    financialCommit: {
      async execute(items) {
        commitStarted = true;
        const received = [];
        for await (const item of items) received.push(item);
        commits.push(received);
        return {
          status: "completed",
          items: received.map((item) => ({ ...(item as object), status: "committed" })),
          diagnostics: [],
          committedCount: received.length,
          failedCount: 0,
        } as never;
      },
    },
    async event(stage, outcome, code, counts) {
      events.push({
        runId: "linebank-typed-check",
        stage,
        outcome,
        code,
        occurredAt: "2026-09-25T12:00:00.000Z",
        ...counts,
      });
    },
    async signalEvent(signal) {
      events.push(signalRunEvent(signal, { runId: "linebank-typed-check", occurredAt: "2026-09-25T12:00:00.000Z" }));
    },
  };
  return { context, humanAssistance, events, commits, assistance, page: selectedPage };
}

const input = {
  credentials: {
    linebank_user_id: "synthetic-user-id",
    linebank_account: "synthetic-account",
    linebank_password: "synthetic-password",
  },
  startDate: "20260910",
  endDate: "20260910",
  accountFilters: [],
  currencyFilters: [],
};

test("LINE Bank typed workflow admits complete in-memory sources through the injected commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linebank-typed-workflow-"));
  const previousDirectory = process.cwd();
  try {
    process.chdir(directory);
    const harness = createContext();
    const result = await runLineBankProviderWorkflow(harness.context, input);

    assert.deepEqual(result, {
      status: "financial-admitted",
      counts: {
        sourceCaptureCount: 1, rowCount: 1, itemCount: 2, committedCount: 2,
        accountCount: 1, statementRowCount: 1, financialItemCount: 2,
      },
      products: [{ typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 }],
    });
    assert.equal(harness.commits.length, 1);
    assert.equal(harness.commits[0]?.length, 2);
    assert.deepEqual(await readdir(directory), []);
    assert.ok(harness.events.some((event) => event.code === "deposit-source-validation-completed"));
    const stages = new Set([
      "preparation", "authentication", "collection", "decoding",
      "validation", "commit", "finalization",
    ]);
    assert.ok(harness.events.every((event) => stages.has(event.stage)));
  } finally {
    process.chdir(previousDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("LINE Bank closes an approved alertdialog on an already signed-in page before it collects", async () => {
  const page = createPage({ notice: true });
  const harness = createContext({ page });
  const result = await runLineBankProviderWorkflow(harness.context, input);
  assert.equal(result.status, "financial-admitted");
  assert.equal(page.noticeOpen(), false);
});

test("LINE Bank rejects malformed and incomplete sources before any commit", async () => {
  const malformed = createContext({ page: createPage({ malformedTransactions: true }) });
  await assert.rejects(runLineBankProviderWorkflow(malformed.context, input), (error: unknown) =>
    error instanceof ProductCollectionInterruptedError && error.errorCode === "source-integrity-failed");
  assert.equal(malformed.commits.length, 0);
  assert.ok(malformed.events.some((event) => event.code === "source-decoding-failed"));

  const incomplete = createContext({ page: createPage({ incompleteTransactions: true }) });
  await assert.rejects(runLineBankProviderWorkflow(incomplete.context, input), (error: unknown) =>
    error instanceof ProductCollectionInterruptedError && error.errorCode === "source-validation-failed");
  assert.equal(incomplete.commits.length, 0);
  assert.ok(incomplete.events.some((event) => event.code === "source-validation-rejected"));
});

for (const { stop, errorCode } of STOPPED_COMMITS) {
  test(`LINE Bank names a ${stop} commit ${errorCode}`, async () => {
    const harness = createContext();
    await assert.rejects(
      runLineBankProviderWorkflow({ ...harness.context, financialCommit: stoppedCommitPort(stop) }, input),
      assertStoppedRun("deposit", 2, errorCode),
    );
  });
}

test("LINE Bank waits for delayed automatic sign-in without human fallback and honors cancellation", async () => {
  const page = createPage({ signedIn: false, signInAfterPolls: 4 });
  const automatic = createContext({
    page,
    onAssistance: () => page.setSignedIn?.(true),
  });
  const result = await runLineBankProviderWorkflow(automatic.context, input);
  assert.equal(result.status, "financial-admitted");
  assert.deepEqual(automatic.assistance, []);
  assert.ok(!automatic.events.some((event) => event.code === "human-assistance-requested"));

  const controller = new AbortController();
  const cancelledPage = createPage({ signedIn: false, onPoll: () => controller.abort(new Error("cancelled by test")) });
  const cancelled = createContext({
    page: cancelledPage,
    signal: controller.signal,
    onAssistance: () => controller.abort(new Error("cancelled by test")),
  });
  const cancelledEvents: WorkflowRunEvent[] = [];
  const executor = createWorkflowExecutor([linebankStatementsWorkflow], {
    browser: cancelled.context.browser,
    text: cancelled.context.text,
    humanAssistance: cancelled.humanAssistance,
    financialCommit: cancelled.context.financialCommit,
    commitAttempts: { record: async () => undefined },
    events: { async append(event) { cancelledEvents.push(event); } },
    now: cancelled.context.now,
  });
  await assert.rejects(
    executor.run("linebank-statements", "linebank-cancel-check", input, controller.signal),
  );
  assert.equal(cancelled.commits.length, 0);
  assert.ok(cancelledEvents.some((event) => event.code === "run-cancelled"));
});


test("LINE Bank ends an unfinished login at its deadline without requesting human assistance", async (t) => {
  let elapsed = 0;
  t.mock.method(Date, "now", () => elapsed);
  const pending = createContext({
    page: createPage({ signedIn: false, onPoll: () => { elapsed += 30_000; } }),
  });
  await assert.rejects(
    runLineBankProviderWorkflow(pending.context, input),
    /Sign-in did not settle within 120000 ms/u,
  );
  assert.equal(elapsed, 120_000);
  assert.deepEqual(pending.assistance, []);
  assert.equal(pending.commits.length, 0);
});
