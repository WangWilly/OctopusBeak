import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  decodeSinopacJsonSource,
  readSinopacDepositSource,
  runSinopacProviderWorkflow,
  stageSinopacDeposit,
  type SinopacDepositSource,
  type SinopacJsonSourceResponse,
  type SinopacProviderWorkflowDependencies,
  type SinopacWorkflowInput,
} from "../../workflows/sinopac-statements.ts";
import { SourceTextIntegrityError, strictSourceText } from "./source-text.ts";
import { parseSinopacCurrentDepositBalanceSnapshot } from "../../workflows/sinopac-current-deposit-balances.ts";
import { PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND } from "../../ledger/pglite/workflow-client.ts";
import {
  applyCommitAttemptReport,
  commitAttemptsErrorCode,
  recordedFinancialCommitPort,
  type CommitAttempt,
  type CommitAttemptReport,
} from "./commit-attempt.ts";
import type { WorkflowContext, WorkflowFinancialCommitPort, WorkflowContextWith } from "./workflow-executor.ts";
import { ProductCollectionInterruptedError, type ProductCollectionHandle, type ProductStageRequest } from "./product-collection.ts";

const accountId = ["1410", "1800", "0822", "21"].join("");
const response: SinopacJsonSourceResponse = {
  url: "https://mma.sinopac.com/ws/bank/transdetail/ws_transdetailMerge.ashx?1790000000000",
  status: 200,
  method: "POST",
  contentType: "application/json; charset=utf-8",
};
const payload = [{
  Header: "SUCCESS",
  Message: "",
  SubInfo: [{
    DataText1: "2026/09/03 09:21",
    DataText2: "2026/09/03",
    DataText3: "Synthetic salary",
    DataText4: "100",
    DataText5: "900",
    DataText7: "",
    DataText8: "",
  }],
}];

const input: SinopacWorkflowInput = {
  credentials: {
    sinopac_user_id: "synthetic-user",
    sinopac_account: "synthetic-account",
    sinopac_password: "synthetic-password",
  },
  startDate: "20260903",
  endDate: "20260903",
  accountFilters: [],
  currencyFilters: [],
  statementTypes: ["deposit"],
  attachedPreviewProducts: [],
};

function pageFixture(options: { signedIn?: boolean } = {}) {
  let signedIn = options.signedIn ?? true;
  let captchaValue = "";
  const emitter = new EventEmitter();
  const makeLocator = (selector: string) => ({
    waitFor: async () => {
      if (selector.includes("user-logout") && !signedIn) throw new Error("synthetic logout link timeout");
    },
    isVisible: async () => signedIn && selector.includes("user-logout"),
    fill: async (value: string) => { if (selector.includes("sino_keyword3")) captchaValue = value; },
    focus: async () => undefined,
    inputValue: async () => captchaValue,
    click: async () => undefined,
    boundingBox: async () => ({ x: 1, y: 1, width: 100, height: 30 }),
    first() { return this; },
    nth() { return this; },
  });
  const page = {
    url: () => signedIn
      ? "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx"
      : "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx",
    locator: (selector: string) => makeLocator(selector),
    on: (event: string, handler: (...args: unknown[]) => void) => { emitter.on(event, handler); },
    off: (event: string, handler: (...args: unknown[]) => void) => { emitter.off(event, handler); },
    waitForLoadState: async () => undefined,
    goto: async () => undefined,
    enterCaptcha(value: string) { captchaValue = value; },
    setSignedIn(value: boolean) { signedIn = value; },
    isSignedIn: () => signedIn,
  } as unknown as Page & {
    setSignedIn(value: boolean): void;
    enterCaptcha(value: string): void;
    isSignedIn(): boolean;
  };
  return page;
}

function makeContext(options: Readonly<{
  page: Page;
  signal?: AbortSignal;
  financialCommit: WorkflowFinancialCommitPort;
  assistance?: WorkflowContext["verification"]["complete"];
  onEvent?: WorkflowContext["event"];
}>): WorkflowContextWith<"financialCommit"> {
  const signal = options.signal ?? new AbortController().signal;
  return {
    runId: "sinopac-test-run",
    signal,
    now: () => "2026-09-24T12:00:00.000+08:00",
    browser: { withPage: async (run) => await run(options.page) },
    text: strictSourceText,
    verification: {
      complete: options.assistance ?? (async () => undefined),
    },
    financialCommit: options.financialCommit,
    event: options.onEvent ?? (async () => undefined),
    signalEvent: async () => undefined,
  };
}

function financialCommitStub(calls: unknown[][]) : WorkflowFinancialCommitPort {
  return {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      calls.push(received);
      return {
        status: "completed",
        items: received.map((item) => ({
          itemKey: item.itemKey,
          provider: item.provider,
          product: item.product,
          status: "committed" as const,
          admissionSummaries: [],
          value: null,
          relationWarnings: [],
        })),
        diagnostics: [],
        committedCount: received.length,
        failedCount: 0,
      };
    },
  };
}

const account = {
  DataText: "Synthetic TWD account",
  DataValue: accountId,
  DisplayText: "TWD",
};

const salaryRow = {
  DataText1: "2026/09/03 09:21",
  DataText2: "2026/09/03",
  DataText3: "Synthetic salary",
  DataText4: "-100",
  DataText5: "900",
  DataText7: "",
  DataText8: "",
};

function fakeSource(overrides: Partial<SinopacDepositSource> = {}): SinopacDepositSource {
  return {
    listAccounts: async () => [account],
    queryTransactions: async () => ({ Header: "SUCCESS", SubInfo: [salaryRow] }),
    readCurrentBalances: async () => [],
    ...overrides,
  };
}

// The real read and build halves over a fake SinoPac source.
function depositFrom(source: SinopacDepositSource): SinopacProviderWorkflowDependencies {
  return {
    collectDeposit: async (_page, depositInput, context, product) => await stageSinopacDeposit(
      await readSinopacDepositSource(source, depositInput, context, product),
      depositInput,
      context,
      product,
      source.readCurrentBalances,
    ),
  };
}

test("SinoPac production execution exposes only the typed App provider path", async () => {
  const providerSource = await readFile(
    new URL("../../workflows/sinopac-statements.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    providerSource,
    /from\s+["']libretto["']|export\s+default\s+workflow\s*\(|librettoAuthenticate|LibrettoWorkflowContext/u,
  );
  assert.doesNotMatch(
    providerSource,
    /node:fs\/promises|writeStatementFiles|writeFile\(|csvPath|jsonPath|downloadsDir/u,
  );
  assert.doesNotMatch(
    providerSource,
    /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun|pglite-child-rpc-client/u,
  );
});

function productHandle(staged: ProductStageRequest[], codes: string[]): ProductCollectionHandle {
  return {
    stage: (...requests) => { staged.push(...requests); },
    reportActivity: async () => undefined,
    event: async (_stage, _outcome, code) => { codes.push(code); },
  };
}

function currentBalanceRow(observedAt: string) {
  return parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{
      SubInfo: [{
        AcctText: "Synthetic TWD account",
        AcctValue: accountId,
        AcctValueFormat: "###-###-#######-#",
        Curr: "TWD",
        CurText: "新台幣",
        AvailBalance: "900",
        AvailBalInt: null,
        MaxAvail: "900",
        OutStdLmt: "0",
        FixBalance: "0",
        NonTrxferFlg: "False",
        Category: "1001",
        DigiTalFg: "",
      }],
      Header: "SUCCESS",
      Message: "",
    }],
    response: {
      url: "https://mma.sinopac.com/ws/bank/bankbal/ws_bankbal.ashx",
      status: 200,
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "cache-control": "no-cache,no-store",
        date: "Thu, 24 Sep 2026 03:59:00 GMT",
      },
    },
    observedAt,
  });
}

test("the SinoPac read half lists accounts, then reads and admits each account's windows", async () => {
  const codes: string[] = [];
  const context = makeContext({ page: pageFixture(), financialCommit: financialCommitStub([]) });
  const queried: string[] = [];
  const snapshot = await readSinopacDepositSource(fakeSource({
    listAccounts: async () => [account, { DataText: "Synthetic USD account", DataValue: "002", DisplayText: "USD" }],
    queryTransactions: async (candidate, window, businessDate) => {
      queried.push(`${candidate.DataValue} ${window.startDate}-${window.endDate} ${businessDate}`);
      return { Header: "SUCCESS", SubInfo: [salaryRow] };
    },
  }), { ...input, currencyFilters: ["TWD"] }, context, productHandle([], codes));
  assert.deepEqual(queried, [`${accountId} 20260903-20260903 20260903`]);
  assert.equal(snapshot.observedAt, "2026-09-24T12:00:00.000+08:00");
  assert.deepEqual(snapshot.accounts.map((read) => [read.capture.product, read.rowCount, read.providerNoData]), [
    ["domestic-deposit", 1, false],
  ]);
  assert.deepEqual(codes, [
    "account-list-collection-started",
    "account-list-collected",
    "source-collection-started",
    "source-decoding-started",
    "source-decoding-completed",
    "account-window-collected",
    "source-validation-started",
    "source-validation-completed",
  ]);
});

test("the SinoPac read half reports an undecodable window before it fails", async () => {
  const codes: string[] = [];
  const context = makeContext({ page: pageFixture(), financialCommit: financialCommitStub([]) });
  await assert.rejects(readSinopacDepositSource(fakeSource({
    queryTransactions: async () => { throw new SourceTextIntegrityError("invalid-encoding"); },
  }), input, context, productHandle([], codes)), SourceTextIntegrityError);
  assert.equal(codes.at(-1), "source-decode-rejected");
});

test("a SinoPac snapshot of provider no-data stages source only and never reads current balances", async () => {
  const codes: string[] = [];
  const staged: ProductStageRequest[] = [];
  const context = makeContext({ page: pageFixture(), financialCommit: financialCommitStub([]) });
  const product = productHandle(staged, codes);
  const snapshot = await readSinopacDepositSource(fakeSource({
    queryTransactions: async () => ({ Header: "FAIL", Message: "查無資料", SubInfo: [] }),
  }), input, context, product);
  let balanceReads = 0;
  const counts = await stageSinopacDeposit(snapshot, input, context, product, async () => {
    balanceReads += 1;
    return [];
  });
  assert.equal(balanceReads, 0);
  assert.deepEqual(staged.map((item) => `${item.product}:${item.command.kind}`), [
    "domestic-deposit:financial.source.admit",
  ]);
  assert.deepEqual(counts, { accountCount: 1, rowCount: 0, skippedAccountCount: 1, sourceCaptureCount: 1 });
  assert.equal(codes.includes("current-balance-collection-started"), false);
});

test("a financial SinoPac snapshot reads current balances once and stages the matching account's balance", async () => {
  const codes: string[] = [];
  const staged: ProductStageRequest[] = [];
  const context = makeContext({ page: pageFixture(), financialCommit: financialCommitStub([]) });
  const product = productHandle(staged, codes);
  const snapshot = await readSinopacDepositSource(fakeSource(), input, context, product);
  codes.length = 0;
  const balanceReads: string[] = [];
  const counts = await stageSinopacDeposit(snapshot, input, context, product, async ({ observedAt }) => {
    balanceReads.push(observedAt);
    return currentBalanceRow(observedAt);
  });
  assert.deepEqual(balanceReads, [snapshot.observedAt]);
  assert.deepEqual(staged.map((item) => `${item.product}:${item.command.kind}`), [
    "domestic-deposit:financial.mixed.commit",
    `current-balance:${PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND}`,
  ]);
  assert.deepEqual(counts, { accountCount: 1, rowCount: 1, skippedAccountCount: 0, sourceCaptureCount: 1 });
  assert.deepEqual(codes, ["current-balance-collection-started", "current-balance-validation-completed"]);
});

test("a failed SinoPac current-balance read fails the build before anything is staged", async () => {
  const codes: string[] = [];
  const staged: ProductStageRequest[] = [];
  const context = makeContext({ page: pageFixture(), financialCommit: financialCommitStub([]) });
  const product = productHandle(staged, codes);
  const snapshot = await readSinopacDepositSource(fakeSource(), input, context, product);
  await assert.rejects(
    stageSinopacDeposit(snapshot, input, context, product, async () => { throw new Error("synthetic balance page failure"); }),
    /synthetic balance page failure/u,
  );
  assert.deepEqual(staged, []);
  assert.equal(codes.at(-1), "current-balance-source-rejected");
});

test("SinoPac source JSON is decoded strictly after terminal response checks", () => {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  assert.deepEqual(decodeSinopacJsonSource({
    bytes,
    response,
    text: strictSourceText,
    expectedPath: "/ws/bank/transdetail/ws_transdetailMerge.ashx",
  }), payload);

  assert.throws(() => decodeSinopacJsonSource({
    bytes: Uint8Array.of(0x7b, 0x22, 0x6e, 0x22, 0x3a, 0xc3, 0x28, 0x7d),
    response,
    text: strictSourceText,
    expectedPath: "/ws/bank/transdetail/ws_transdetailMerge.ashx",
  }), SourceTextIntegrityError);
  assert.throws(() => decodeSinopacJsonSource({
    bytes,
    response: { ...response, status: 503 },
    text: strictSourceText,
    expectedPath: "/ws/bank/transdetail/ws_transdetailMerge.ashx",
  }), /status/u);
  assert.throws(() => decodeSinopacJsonSource({
    bytes,
    response: { ...response, contentType: "text/html; charset=utf-8" },
    text: strictSourceText,
    expectedPath: "/ws/bank/transdetail/ws_transdetailMerge.ashx",
  }), /content type/u);
  assert.throws(() => decodeSinopacJsonSource({
    bytes,
    response: { ...response, url: "https://evil.example/ws/bank/transdetail/ws_transdetailMerge.ashx" },
    text: strictSourceText,
    expectedPath: "/ws/bank/transdetail/ws_transdetailMerge.ashx",
  }), /endpoint/u);
});

test("typed SinoPac workflow admits all source before one injected commit and creates no files", async () => {
  const originalCwd = process.cwd();
  const outputDir = await mkdtemp(join(tmpdir(), "sinopac-typed-workflow-"));
  const calls: unknown[][] = [];
  const events: Array<{ stage: string; code: string }> = [];
  const page = pageFixture();
  const context = makeContext({
    page,
    financialCommit: financialCommitStub(calls),
    onEvent: async (stage, _outcome, code) => { events.push({ stage, code }); },
  });
  try {
    process.chdir(outputDir);
    const output = await runSinopacProviderWorkflow(context, input, depositFrom(fakeSource()));

    assert.equal(output.status, "financial-admitted");
    assert.deepEqual(output.counts, {
      sourceCaptureCount: 1,
      rowCount: 1,
      itemCount: 1,
      committedCount: 1,
      accountCount: 1,
      skippedAccountCount: 0,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.length, 1);
    assert.equal(events.some((event) => event.code === "source-validation-completed"), true);
    assert.deepEqual(await readdir(outputDir, { recursive: true }), []);
  } finally {
    process.chdir(originalCwd);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("a failed SinoPac Canonical Financial Commit is classified as a commit failure", async () => {
  const reports: CommitAttemptReport[] = [];
  const failingCommit = recordedFinancialCommitPort({
    commit: {
      async execute(items) {
        return {
          status: "failed",
          items: items.map((item) => ({
            itemKey: item.itemKey, provider: item.provider, product: item.product,
            status: "failed" as const, failureKind: "item" as const, diagnostics: [],
          })),
          diagnostics: [],
          committedCount: 0,
          failedCount: items.length,
        };
      },
    },
    attempts: { record: async (report) => { reports.push(report); } },
    event: async () => undefined,
  });
  const context = makeContext({
    page: pageFixture(),
    financialCommit: failingCommit,
  });
  const error = await runSinopacProviderWorkflow(context, input, depositFrom(fakeSource())).then(() => null, (thrown: unknown) => thrown);

  assert.ok(error instanceof Error);
  assert.equal(
    commitAttemptsErrorCode(reports.reduce<readonly CommitAttempt[]>(applyCommitAttemptReport, [])),
    "canonical-commit-failed",
    "the settled failed attempt, not an event guess, explains the run",
  );
});

test("typed SinoPac workflow rejects incomplete source before Canonical Financial Commit", async () => {
  const calls: unknown[][] = [];
  const context = makeContext({ page: pageFixture(), financialCommit: financialCommitStub(calls) });
  await assert.rejects(
    runSinopacProviderWorkflow(context, input, depositFrom(fakeSource({
      queryTransactions: async () => ({ Header: "SUCCESS", SubInfo: [] }),
    }))),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "source-validation-failed");
      assert.match(String((error as Error & { cause?: unknown }).cause), /zero-result-authority-unproven/u);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("typed SinoPac CAPTCHA assistance uses the existing solve contract and accepts human entry", async () => {
  const calls: unknown[][] = [];
  const page = pageFixture({ signedIn: false });
  let assistanceCalls = 0;
  const context = makeContext({
    page,
    financialCommit: financialCommitStub(calls),
    assistance: async (stage) => {
      assistanceCalls += 1;
      assert.equal(stage.stageId, "sinopac-login-captcha");
      assert.equal(stage.expectedAnswerLength, 6);
      assert.equal(stage.solverConfidenceThreshold, 0.9);
      assert.deepEqual(stage.ocrAttemptPlan, [
        { imagePreprocessing: ["remove-interference-lines"] },
      ]);
      page.setSignedIn(true);
    },
  });

  const output = await runSinopacProviderWorkflow(context, input, depositFrom(fakeSource()));

  assert.equal(assistanceCalls, 1);
  assert.equal(calls.length, 1);
});

test("typed SinoPac cancellation while awaiting CAPTCHA assistance stops before source and commit", async () => {
  const controller = new AbortController();
  const calls: unknown[][] = [];
  let readAccountsCalls = 0;
  const context = makeContext({
    page: pageFixture({ signedIn: false }),
    signal: controller.signal,
    financialCommit: financialCommitStub(calls),
    assistance: () => new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    }),
  });
  const running = runSinopacProviderWorkflow(context, input, depositFrom(fakeSource({
    listAccounts: async () => { readAccountsCalls += 1; return [account]; },
  })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(running, /cancelled by test/u);
  assert.equal(readAccountsCalls, 0);
  assert.equal(calls.length, 0);
});
