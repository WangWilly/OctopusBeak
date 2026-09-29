import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  decodeSinopacJsonSource,
  runSinopacProviderWorkflow,
  type SinopacJsonSourceResponse,
  type SinopacWorkflowInput,
} from "../../workflows/sinopac-statements.ts";
import { SinopacCaptchaRejectedError } from "./sinopac-captcha.ts";
import { SourceTextIntegrityError, strictSourceText } from "./source-text.ts";
import type { WorkflowContext, WorkflowFinancialCommitPort } from "./workflow-executor.ts";

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
};

function pageFixture(options: { signedIn?: boolean; submitDialog?: boolean; dialogMessage?: string; dismissalFails?: boolean } = {}) {
  let signedIn = options.signedIn ?? true;
  let captchaValue = "";
  const emitter = new EventEmitter();
  const makeLocator = (selector: string) => ({
    waitFor: async () => undefined,
    isVisible: async () => signedIn && selector.includes("user-logout"),
    fill: async (value: string) => { if (selector.includes("sino_keyword3")) captchaValue = value; },
    focus: async () => undefined,
    inputValue: async () => captchaValue,
    click: async () => {
      if (options.submitDialog && selector === 'input[alt="登入"]') {
        emitter.emit("dialog", {
          type: () => "alert",
          message: () => options.dialogMessage ?? "驗證碼失效或輸入錯誤，請重新輸入。",
          dismiss: async () => { if (options.dismissalFails) throw new Error("closed dialog"); },
        });
      }
    },
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
    waitForURL: async (_url: unknown, options?: { signal?: AbortSignal }) => {
      if (!options?.signal) { signedIn = true; return; }
      if (options.signal.aborted) throw new Error("navigation aborted");
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("navigation aborted")), { once: true });
      });
    },
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
  assistance?: WorkflowContext["humanAssistance"]["request"];
  onEvent?: WorkflowContext["event"];
}>): WorkflowContext {
  const signal = options.signal ?? new AbortController().signal;
  return {
    runId: "sinopac-test-run",
    signal,
    now: () => "2026-09-24T12:00:00.000+08:00",
    browser: { withPage: async (run) => await run(options.page) },
    text: strictSourceText,
    humanAssistance: {
      request: options.assistance ?? (async () => "entered"),
    },
    financialCommit: options.financialCommit,
    event: options.onEvent ?? (async () => undefined),
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

test("SinoPac production execution exposes only the typed App provider path", async () => {
  const providerSource = await readFile(
    new URL("../../workflows/sinopac-statements.ts", import.meta.url),
    "utf8",
  );
  assert.match(providerSource, /runSinopacProviderWorkflow/u);
  assert.match(providerSource, /financialCommit!?\.execute/u);
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
    onEvent: async (stage, code) => { events.push({ stage, code }); },
  });
  try {
    process.chdir(outputDir);
    const output = await runSinopacProviderWorkflow(context, input, {
      readAccounts: async () => [account],
      queryTransactions: async () => ({
        Header: "SUCCESS",
        SubInfo: [{
          DataText1: "2026/09/03 09:21",
          DataText2: "2026/09/03",
          DataText3: "Synthetic salary",
          DataText4: "-100",
          DataText5: "900",
          DataText7: "",
          DataText8: "",
        }],
      }),
      readCurrentDepositBalances: async () => [],
    });

    assert.equal(output.status, "financial-admitted");
    assert.equal(output.rowCount, 1);
    assert.equal(output.usedExistingSession, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.length, 1);
    assert.equal(events.some((event) => event.stage === "commit" && event.code === "canonical-commit-completed"), true);
    assert.equal(events.some((event) => event.code === "source-validation-completed"), true);
    assert.deepEqual(await readdir(outputDir, { recursive: true }), []);
  } finally {
    process.chdir(originalCwd);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("typed SinoPac workflow rejects incomplete source before Canonical Financial Commit", async () => {
  const calls: unknown[][] = [];
  const context = makeContext({ page: pageFixture(), financialCommit: financialCommitStub(calls) });
  await assert.rejects(
    runSinopacProviderWorkflow(context, input, {
      readAccounts: async () => [account],
      queryTransactions: async () => ({ Header: "SUCCESS", SubInfo: [] }),
      readCurrentDepositBalances: async () => [],
    }),
    /zero-result-authority-unproven/u,
  );
  assert.equal(calls.length, 0);
});

test("typed SinoPac CAPTCHA assistance uses the existing solve contract and accepts human entry", async () => {
  const calls: unknown[][] = [];
  const page = pageFixture({ signedIn: false });
  const stages: Array<{ stage: string; code: string }> = [];
  let assistanceCalls = 0;
  const context = makeContext({
    page,
    financialCommit: financialCommitStub(calls),
    assistance: async (contract) => {
      assistanceCalls += 1;
      assert.equal(contract.stageId, "sinopac-login-captcha");
      assert.equal(contract.expectedAnswerLength, 6);
      assert.equal(contract.solverConfidenceThreshold, 0.9);
      assert.deepEqual(contract.ocrAttemptPlan, [
        { imagePreprocessing: ["remove-interference-lines"] },
      ]);
      page.setSignedIn(true);
      return "entered";
    },
    onEvent: async (stage, code) => { stages.push({ stage, code }); },
  });

  const output = await runSinopacProviderWorkflow(context, input, {
    readAccounts: async () => [account],
    queryTransactions: async () => ({ Header: "SUCCESS", SubInfo: [{
      DataText1: "2026/09/03 09:21",
      DataText2: "2026/09/03",
      DataText3: "Synthetic salary",
      DataText4: "-100",
      DataText5: "900",
      DataText7: "",
      DataText8: "",
    }] }),
    readCurrentDepositBalances: async () => [],
  });

  assert.equal(output.usedExistingSession, false);
  assert.equal(assistanceCalls, 1);
  assert.equal(stages.some((event) => event.code === "human-assistance-requested"), true);
  assert.equal(stages.some((event) => event.code === "human-assistance-completed"), true);
  assert.equal(calls.length, 1);
});

test("typed SinoPac login owns and dismisses post-submit dialogs instead of hanging on App host", async () => {
  const calls: unknown[][] = [];
  const page = pageFixture({ signedIn: false, submitDialog: true });
  let accountReads = 0;
  const events: Array<{ stage: string; code: string }> = [];
  const context = makeContext({
    page,
    financialCommit: financialCommitStub(calls),
    onEvent: async (stage, code) => { events.push({ stage, code }); },
    assistance: async () => {
      page.enterCaptcha("123456");
      return "entered";
    },
  });
  await assert.rejects(
    runSinopacProviderWorkflow(context, input, {
      readAccounts: async () => { accountReads += 1; return [account]; },
      queryTransactions: async () => ({ Header: "SUCCESS", SubInfo: [] }),
      readCurrentDepositBalances: async () => [],
    }),
    SinopacCaptchaRejectedError,
  );
  assert.equal(accountReads, 0);
  assert.equal(calls.length, 0);
  assert.equal(events.some((event) => event.code === "captcha-rejected"), true);
});

test("typed SinoPac cancellation while awaiting CAPTCHA assistance stops before source and commit", async () => {
  const controller = new AbortController();
  const calls: unknown[][] = [];
  let readAccountsCalls = 0;
  let rejectAssistance!: (error: Error) => void;
  const assistance = new Promise<never>((_resolve, reject) => { rejectAssistance = reject; });
  const context = makeContext({
    page: pageFixture({ signedIn: false }),
    signal: controller.signal,
    financialCommit: financialCommitStub(calls),
    assistance: async () => await assistance,
  });
  const running = runSinopacProviderWorkflow(context, input, {
    readAccounts: async () => { readAccountsCalls += 1; return [account]; },
    queryTransactions: async () => ({ Header: "SUCCESS", SubInfo: [] }),
    readCurrentDepositBalances: async () => [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("cancelled by test"));
  rejectAssistance(new Error("late assistance response"));
  await assert.rejects(running, /cancelled by test/u);
  assert.equal(readAccountsCalls, 0);
  assert.equal(calls.length, 0);
});

test("SinoPac unknown dialogs and failed dismissals cannot produce a retryable rejection", async () => {
  for (const options of [{ dialogMessage: "帳號已被鎖定" }, { dismissalFails: true }]) {
    const page = pageFixture({ signedIn: false, submitDialog: true, ...options });
    const calls: unknown[][] = [];
    const context = makeContext({
      page,
      financialCommit: financialCommitStub(calls),
      assistance: async () => { page.enterCaptcha("123456"); return "entered"; },
    });
    await assert.rejects(runSinopacProviderWorkflow(context, input), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof SinopacCaptchaRejectedError, false);
      return true;
    });
    assert.equal(calls.length, 0);
  }
});
