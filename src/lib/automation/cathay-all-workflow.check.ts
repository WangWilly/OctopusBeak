import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  validateCathayDomesticDepositSyncInputForPGlite,
} from "../../ledger/pglite/cathay-domestic-admission.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "../../ledger/pglite/cathay-domestic-adapter.ts";
import { CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "../../ledger/canonical/foreign-currency-deposit.fixtures.ts";
import type { PGliteWorkflowRunItem } from "../../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND } from "../../ledger/pglite/workflow-client.ts";
import { strictSourceText, SourceTextIntegrityError } from "./source-text.ts";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "./workflow-executor.ts";
import {
  completeCathayEmailOtpForApp,
  decodeCathayApiSourceResponse,
  waitForCathayAppSignedInState,
  type CathayDomesticFinancialCollection,
  type CathayGmailOtpPort,
} from "../../workflows/cathay-statements.ts";
import type {
  CathayAppLoginDependencies,
  CathayCredentials,
} from "../../workflows/cathay-statements.ts";
import type { CathayForeignFinancialCollection } from "../../workflows/cathay-foreign-statements.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(".js")) return nextResolve(specifier, context);
    const typescriptSpecifier = `${specifier.slice(0, -3)}.ts`;
    try {
      return nextResolve(typescriptSpecifier, context);
    } catch {
      return nextResolve(specifier, context);
    }
  },
});

const { runCathayAllProviderWorkflow } =
  await import("../../workflows/cathay-all-statements.ts");
const { collectCathayForeignFinancialCaptures } =
  await import("../../workflows/cathay-foreign-statements.ts");

const DOMESTIC_SYNC_FIXTURE = validateCathayDomesticDepositSyncInputForPGlite({
  sourceConnectionId: "synthetic-cathay-connection",
  identityEpoch: "cathay-domestic-deposit-v1",
  authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
  syncState: { cursor: null },
  observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
  pages: [
    {
      accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
      currency: "TWD",
      scope: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope,
      pageOrdinal: 0,
      requestPageToken: null,
      nextPageToken: null,
      rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
      contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      preflightFingerprint: "cathay/domestic-deposit/collection-v1",
      absenceAuthority: "comparable-complete-range",
    },
  ],
});
const DOMESTIC_REQUESTS = buildCathayDomesticFinancialRequestsForPGlite(
  DOMESTIC_SYNC_FIXTURE,
);

function otpPort(
  overrides: Partial<CathayGmailOtpPort> = {},
): CathayGmailOtpPort {
  return {
    ensureAccess: overrides.ensureAccess ?? (async () => ({ status: "ready" })),
    prepareRetrieval:
      overrides.prepareRetrieval ??
      (async () => ({
        status: "prepared",
        boundaryId: "fixture-boundary",
      })),
    retrieve:
      overrides.retrieve ??
      (async () => ({ status: "found", otp: "ABCD-123456" })),
  };
}

function otpPage() {
  let fieldValue = "";
  let sendClicks = 0;
  let confirmClicks = 0;
  let sendVisible = true;
  let sendError: unknown;
  let confirmError: unknown;
  const otpField = {
    isVisible: async () => true,
    waitFor: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
    focus: async () => undefined,
    boundingBox: async () => ({ x: 20, y: 30, width: 150, height: 40 }),
    fill: async (value: string) => {
      fieldValue = value;
    },
    inputValue: async () => fieldValue,
  };
  const link = { isVisible: async () => true, click: async () => undefined };
  const send = {
    isVisible: async () => sendVisible,
    click: async () => {
      sendClicks += 1;
      if (sendError) throw sendError;
    },
  };
  const confirm = {
    click: async () => {
      confirmClicks += 1;
      if (confirmError) throw confirmError;
    },
  };
  const page = {
    url: () => "https://www.cathaybk.com.tw/MyBank/",
    waitForTimeout: async () => undefined,
    locator(selector: string) {
      if (selector === "a") return { filter: () => ({ first: () => link }) };
      if (selector === "#OtpMailPassword") return otpField;
      if (selector === "#js-otp-email-send") return send;
      if (selector === "#btnConfirm") return confirm;
      throw new Error(`Unexpected OTP selector ${selector}`);
    },
  } as unknown as Page;
  return {
    page,
    otpField,
    read: () => ({ fieldValue, sendClicks, confirmClicks }),
    setFieldValue: (value: string) => {
      fieldValue = value;
    },
    setSendVisible: (value: boolean) => {
      sendVisible = value;
    },
    setSendError: (error: unknown) => {
      sendError = error;
    },
    setConfirmError: (error: unknown) => {
      confirmError = error;
    },
  };
}

test("Cathay typed source decoding rejects invalid UTF-8 and unexpected response metadata", () => {
  const metadata = {
    url: "https://www.cathaybk.com.tw/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
    status: 200,
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
  };
  assert.equal(
    decodeCathayApiSourceResponse(
      metadata,
      "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
      new TextEncoder().encode('{"success":true}'),
      strictSourceText,
    ),
    '{"success":true}',
  );
  assert.throws(
    () =>
      decodeCathayApiSourceResponse(
        metadata,
        "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
        Uint8Array.from([0xc3, 0x28]),
        strictSourceText,
      ),
    SourceTextIntegrityError,
  );
  assert.throws(
    () =>
      decodeCathayApiSourceResponse(
        { ...metadata, status: 302 },
        "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
        new TextEncoder().encode("{}"),
        strictSourceText,
      ),
    /status 302/u,
  );
  assert.throws(
    () =>
      decodeCathayApiSourceResponse(
        { ...metadata, headers: { "content-type": "text/html" } },
        "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
        new TextEncoder().encode("{}"),
        strictSourceText,
      ),
    /content type/u,
  );
});

test("Cathay App Gmail OTP defaults to solver and never falls back to manual assistance", async () => {
  for (const reason of [
    "disabled",
    "not-configured",
    "needs-authorization",
    "authorization-cancelled",
    "authorization-failed",
    "token-invalid",
  ] as const) {
    const unavailable = otpPage();
    let assistanceCalls = 0;
    const events: string[] = [];
    await assert.rejects(
      completeCathayEmailOtpForApp(unavailable.page, {
        otp: otpPort({
          ensureAccess: async () => ({ status: "fallback", reason }),
        }),
        signal: new AbortController().signal,
        event: async (code) => {
          events.push(code);
        },
        requestHumanAssistance: async () => {
          assistanceCalls += 1;
          return "entered";
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        "errorCode" in error &&
        error.errorCode === "verification-configuration-failed" &&
        "reason" in error &&
        error.reason === `gmail-${reason}`,
    );
    assert.equal(assistanceCalls, 0);
    assert.deepEqual(unavailable.read(), {
      fieldValue: "",
      sendClicks: 0,
      confirmClicks: 0,
    });
    assert.deepEqual(events, [`cathay-email-otp-gmail-${reason}`]);
  }

  const automatic = otpPage();
  let retrieveCalls = 0;
  const completion = await completeCathayEmailOtpForApp(automatic.page, {
    otp: otpPort({
      retrieve: async () => {
        retrieveCalls += 1;
        return { status: "found", otp: "ABCD-123456" };
      },
    }),
    signal: new AbortController().signal,
    requestHumanAssistance: async () => {
      throw new Error("Solver must not request manual assistance.");
    },
  });
  assert.deepEqual(automatic.read(), {
    fieldValue: "123456",
    sendClicks: 1,
    confirmClicks: 1,
  });
  assert.equal(retrieveCalls, 1);
  assert.equal(completion, "solver-submitted");
  const completionEvents: string[] = [];
  await assert.rejects(
    waitForCathayAppSignedInState(
      automatic.page,
      {
        otp: otpPort(),
        signal: new AbortController().signal,
        event: async (code) => {
          completionEvents.push(code);
        },
        requestHumanAssistance: async () => "entered",
      },
      0,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "errorCode" in error &&
      error.errorCode === "verification-failed" &&
      "reason" in error &&
      error.reason === "completion-unconfirmed",
  );
  assert.deepEqual(completionEvents, [
    "cathay-email-otp-completion-unconfirmed",
  ]);
});

test("Cathay App development human OTP skips Gmail retrieval and submits one assistance result", async () => {
  const assisted = otpPage();
  const assistanceEvents: string[] = [];
  let assistanceStage = "";
  const calls = { ensure: 0, prepare: 0, retrieve: 0 };
  const completion = await completeCathayEmailOtpForApp(assisted.page, {
    verificationActor: "human",
    otp: otpPort({
      ensureAccess: async () => {
        calls.ensure += 1;
        return { status: "ready" };
      },
      prepareRetrieval: async () => {
        calls.prepare += 1;
        return { status: "prepared", boundaryId: "fixture-boundary" };
      },
      retrieve: async () => {
        calls.retrieve += 1;
        return { status: "found", otp: "ABCD-123456" };
      },
    }),
    signal: new AbortController().signal,
    event: async (code) => {
      assistanceEvents.push(code);
    },
    requestHumanAssistance: async (contract) => {
      assistanceStage = contract.stageId;
      assisted.setFieldValue("654321");
      return "entered";
    },
  });
  assert.deepEqual(assisted.read(), {
    fieldValue: "654321",
    sendClicks: 1,
    confirmClicks: 1,
  });
  assert.deepEqual(calls, { ensure: 0, prepare: 0, retrieve: 0 });
  assert.equal(completion, "human-submitted");
  assert.equal(assistanceStage, "cathay-login-email-otp");
  assert.deepEqual(assistanceEvents, [
    "authentication-human-assistance-requested",
  ]);
});

test("Cathay solver stops on ambiguous or timed-out Gmail results without a manual retry", async () => {
  for (const reason of [
    "no-candidate",
    "ambiguous-candidate",
    "timeout",
  ] as const) {
    const fixture = otpPage();
    const events: string[] = [];
    let assistanceCalls = 0;
    let retrieveCalls = 0;
    await assert.rejects(
      completeCathayEmailOtpForApp(fixture.page, {
        otp: otpPort({
          retrieve: async () => {
            retrieveCalls += 1;
            return { status: "fallback", reason };
          },
        }),
        signal: new AbortController().signal,
        event: async (code) => {
          events.push(code);
        },
        requestHumanAssistance: async () => {
          assistanceCalls += 1;
          return "entered";
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        "errorCode" in error &&
        error.errorCode === "verification-failed" &&
        "reason" in error &&
        error.reason === `gmail-${reason}`,
    );
    assert.deepEqual(fixture.read(), {
      fieldValue: "",
      sendClicks: 1,
      confirmClicks: 0,
    });
    assert.equal(retrieveCalls, 1);
    assert.equal(assistanceCalls, 0);
    assert.deepEqual(events, [`cathay-email-otp-gmail-${reason}`]);
  }
});

test("Cathay solver stops before sending when Gmail retrieval cannot be prepared", async () => {
  const fixture = otpPage();
  let assistanceCalls = 0;
  await assert.rejects(
    completeCathayEmailOtpForApp(fixture.page, {
      otp: otpPort({
        prepareRetrieval: async () => ({
          status: "fallback",
          reason: "gmail-request-failed",
        }),
      }),
      signal: new AbortController().signal,
      requestHumanAssistance: async () => {
        assistanceCalls += 1;
        return "entered";
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "errorCode" in error &&
      error.errorCode === "verification-failed" &&
      "reason" in error &&
      error.reason === "gmail-request-failed",
  );
  assert.deepEqual(fixture.read(), {
    fieldValue: "",
    sendClicks: 0,
    confirmClicks: 0,
  });
  assert.equal(assistanceCalls, 0);
});

test("Cathay solver stops with a setup reason when the OTP send control is unsupported", async () => {
  const fixture = otpPage();
  fixture.setSendVisible(false);
  let ensureCalls = 0;
  let assistanceCalls = 0;
  await assert.rejects(
    completeCathayEmailOtpForApp(fixture.page, {
      otp: otpPort({
        ensureAccess: async () => {
          ensureCalls += 1;
          return { status: "ready" };
        },
      }),
      signal: new AbortController().signal,
      requestHumanAssistance: async () => {
        assistanceCalls += 1;
        return "entered";
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "errorCode" in error &&
      error.errorCode === "verification-configuration-failed" &&
      "reason" in error &&
      error.reason === "challenge-unavailable",
  );
  assert.equal(ensureCalls, 0);
  assert.equal(assistanceCalls, 0);
  assert.deepEqual(fixture.read(), {
    fieldValue: "",
    sendClicks: 0,
    confirmClicks: 0,
  });
});

test("Cathay solver treats uncertain send and submit as terminal and never repeats them", async () => {
  const sendUncertain = otpPage();
  sendUncertain.setSendError(new Error("synthetic send uncertainty"));
  let sendAssistanceCalls = 0;
  let sendRetrievalCalls = 0;
  await assert.rejects(
    completeCathayEmailOtpForApp(sendUncertain.page, {
      otp: otpPort({
        retrieve: async () => {
          sendRetrievalCalls += 1;
          return { status: "found", otp: "ABCD-123456" };
        },
      }),
      signal: new AbortController().signal,
      requestHumanAssistance: async () => {
        sendAssistanceCalls += 1;
        return "entered";
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "errorCode" in error &&
      error.errorCode === "verification-failed" &&
      "reason" in error &&
      error.reason === "send-uncertain",
  );
  assert.deepEqual(sendUncertain.read(), {
    fieldValue: "",
    sendClicks: 1,
    confirmClicks: 0,
  });
  assert.equal(sendRetrievalCalls, 0);
  assert.equal(sendAssistanceCalls, 0);

  const submitUncertain = otpPage();
  submitUncertain.setConfirmError(new Error("synthetic submit uncertainty"));
  let submitAssistanceCalls = 0;
  let submitRetrievalCalls = 0;
  await assert.rejects(
    completeCathayEmailOtpForApp(submitUncertain.page, {
      otp: otpPort({
        retrieve: async () => {
          submitRetrievalCalls += 1;
          return { status: "found", otp: "ABCD-123456" };
        },
      }),
      signal: new AbortController().signal,
      requestHumanAssistance: async () => {
        submitAssistanceCalls += 1;
        return "entered";
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "errorCode" in error &&
      error.errorCode === "verification-failed" &&
      "reason" in error &&
      error.reason === "submission-uncertain",
  );
  assert.deepEqual(submitUncertain.read(), {
    fieldValue: "123456",
    sendClicks: 1,
    confirmClicks: 1,
  });
  assert.equal(submitRetrievalCalls, 1);
  assert.equal(submitAssistanceCalls, 0);
});

test("Cathay solver abort wins over OTP failure classification", async () => {
  const fixture = otpPage();
  const controller = new AbortController();
  const events: string[] = [];
  controller.abort();
  await assert.rejects(
    completeCathayEmailOtpForApp(fixture.page, {
      otp: otpPort({
        ensureAccess: async () => ({ status: "fallback", reason: "disabled" }),
      }),
      signal: controller.signal,
      event: async (code) => {
        events.push(code);
      },
      requestHumanAssistance: async () => "entered",
    }),
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  assert.deepEqual(events, []);
});

function resultFor(items: readonly unknown[]) {
  return {
    status: "completed",
    items: items.map((item: any) => ({
      itemKey: item.itemKey,
      provider: item.provider,
      product: item.product,
      status: "committed",
      admissionSummaries: [],
      value: null,
      relationWarnings: [],
    })),
    diagnostics: [],
    committedCount: items.length,
    failedCount: 0,
  };
}

function contextHarness(
  makeResult: (items: readonly unknown[]) => unknown = resultFor,
) {
  const controller = new AbortController();
  const events: Array<{ stage: string; code: string }> = [];
  const committed: unknown[][] = [];
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute(items) {
      const materialized = [...(items as Iterable<unknown>)];
      committed.push(materialized);
      return makeResult(materialized) as never;
    },
  };
  const context: WorkflowContext = {
    runId: "cathay-test-run",
    signal: controller.signal,
    now: () => "2026-09-25T01:00:00.000Z",
    browser: {
      withPage: (run) => run({ on() {}, off() {} } as unknown as Page),
    },
    text: strictSourceText,
    humanAssistance: { request: async () => "entered" },
    financialCommit,
    event: async (stage, code) => {
      events.push({ stage, code });
    },
  };
  return { context, controller, events, committed };
}

function collectionDependencies(
  override: Partial<{
    signIn: (
      page: Page,
      credentials: CathayCredentials,
      trustDevice: boolean,
      dependencies: CathayAppLoginDependencies,
    ) => Promise<{ usedExistingSession: boolean }>;
    onLogin: (dependencies: CathayAppLoginDependencies) => void;
    domestic: CathayDomesticFinancialCollection;
    foreign: CathayForeignFinancialCollection;
    collectCurrentBalanceItems: (
      page: Page,
      domestic: CathayDomesticFinancialCollection | undefined,
      foreign: CathayForeignFinancialCollection | undefined,
      context: WorkflowContext,
    ) => Promise<readonly PGliteWorkflowRunItem[]>;
  }> = {},
) {
  return {
    otp: otpPort(),
    signIn:
      override.signIn ??
      (async (_page, _credentials, _trustDevice, dependencies) => {
        override.onLogin?.(dependencies);
        return { usedExistingSession: true };
      }),
    createSession: async () => ({
      jwtToken: "fixture-token",
      customerId: "fixture",
      idType: "fixture",
    }),
    collectDomestic: async () =>
      override.domestic ?? {
        requests: DOMESTIC_REQUESTS,
        accountNumbers: [CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo],
        captureCount: 1,
        rowCount: 3,
      },
    collectForeign: async () =>
      override.foreign ?? {
        captures: [CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1],
        selectedStatementCount: 1,
        rowCount: 1,
        accountKeys: [CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1.accountNo],
      },
    collectCurrentBalanceItems:
      override.collectCurrentBalanceItems ?? (async () => []),
  };
}

const bothProductsInput = {
  credentials: {
    cathay_user_id: "fixture-user",
    cathay_account: "fixture-account",
    cathay_password: "fixture-password",
  },
  statementTypes: ["domestic", "foreign_currency"],
  dateRange: "one_year",
};

test("Cathay all workflow collects and commits selected products independently with no artifacts", async () => {
  const previousCwd = process.cwd();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cathay-typed-"));
  process.chdir(temporaryDirectory);
  try {
    const harness = contextHarness();
    let verificationActor: CathayAppLoginDependencies["verificationActor"];
    const output = await runCathayAllProviderWorkflow(
      harness.context,
      bothProductsInput,
      collectionDependencies({
        onLogin: (dependencies) => {
          verificationActor = dependencies.verificationActor;
        },
      }),
    );
    assert.equal(verificationActor, "solver");
    assert.deepEqual(output.statementTypes, ["domestic", "foreign"]);
    assert.equal(output.sourceCaptureCount, 2);
    assert.equal(harness.committed.length, 2);
    const statementItem = harness.committed[0]![0] as {
      product: string;
      command: { request: { steps: readonly { kind: string }[] } };
    };
    assert.equal(statementItem.product, "domestic-statements");
    assert.deepEqual(
      statementItem.command.request.steps.map((step) => step.kind),
      ["financial"],
    );
    const foreignItem = harness.committed[1]![0] as {
      product: string;
      command: { request: { steps: readonly { kind: string }[] } };
    };
    assert.equal(foreignItem.product, "foreign-currency-statements");
    assert.deepEqual(
      foreignItem.command.request.steps.map((step) => step.kind),
      ["deposit"],
    );
    assert.deepEqual(
      output.products.map((product) => [product.typeId, product.status]),
      [
        ["domestic", "success"],
        ["foreign_currency", "success"],
      ],
    );
    assert.equal(output.status, "financial-admitted");
    assert.ok(
      harness.events.some(
        (event) => event.code === "all-source-admission-completed",
      ),
    );
    assert.ok(
      harness.events.some(
        (event) => event.code === "canonical-commit-completed",
      ),
    );
    assert.equal(existsSync(join(temporaryDirectory, "downloads")), false);
  } finally {
    process.chdir(previousCwd);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Cathay all workflow never invokes an unselected product collector", async () => {
  const harness = contextHarness();
  let foreignCalls = 0;
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    { ...bothProductsInput, statementTypes: ["domestic"] },
    {
      ...collectionDependencies(),
      collectForeign: async () => {
        foreignCalls += 1;
        throw new Error("Unselected foreign product must not run.");
      },
    },
  );

  assert.equal(foreignCalls, 0);
  assert.equal(harness.committed.length, 1);
  assert.deepEqual(
    output.products.map((product) => [
      product.typeId,
      product.status,
      product.skipReason,
    ]),
    [
      ["domestic", "success", undefined],
      ["foreign_currency", "skipped", "not_selected"],
    ],
  );
});

test("Cathay all workflow can collect foreign currency without domestic products", async () => {
  const harness = contextHarness();
  let domesticCalls = 0;
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    { ...bothProductsInput, statementTypes: ["foreign_currency"] },
    {
      ...collectionDependencies(),
      collectDomestic: async () => {
        domesticCalls += 1;
        throw new Error("Unselected domestic product must not run.");
      },
    },
  );

  assert.equal(domesticCalls, 0);
  assert.equal(harness.committed.length, 1);
  assert.deepEqual(
    output.products.map((product) => [
      product.typeId,
      product.status,
      product.skipReason,
    ]),
    [
      ["domestic", "skipped", "not_selected"],
      ["foreign_currency", "success", undefined],
    ],
  );
});

test("Cathay all workflow reports incomplete domestic collection without blocking foreign collection", async () => {
  const harness = contextHarness();
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    bothProductsInput,
    collectionDependencies({
      domestic: {
        requests: DOMESTIC_REQUESTS.slice(0, 0),
        accountNumbers: [CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo],
        captureCount: 1,
        rowCount: 0,
      },
    }),
  );
  assert.equal(output.status, "partial");
  assert.deepEqual(
    output.products.map((product) => [product.typeId, product.status]),
    [
      ["domestic", "failed"],
      ["foreign_currency", "success"],
    ],
  );
  assert.equal(harness.committed.length, 1);
  assert.equal(
    (harness.committed[0]![0] as { product: string }).product,
    "foreign-currency-statements",
  );
});

test("Cathay balance collection failure discards that product's staged statements and continues", async () => {
  const harness = contextHarness();
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    bothProductsInput,
    collectionDependencies({
      collectCurrentBalanceItems: async (_page, domestic, foreign) => {
        if (domestic) throw new Error("Domestic balance source failed.");
        assert.ok(foreign);
        return [];
      },
    }),
  );

  assert.equal(output.status, "partial");
  assert.deepEqual(
    output.products.map((product) => [product.typeId, product.status]),
    [
      ["domestic", "failed"],
      ["foreign_currency", "success"],
    ],
  );
  assert.equal(harness.committed.length, 1);
  assert.equal(
    (harness.committed[0]![0] as { product: string }).product,
    "foreign-currency-statements",
  );
});

test("Cathay balance admission failure keeps product receipts and does not block another product", async () => {
  const harness = contextHarness((items) => {
    const result = resultFor(items) as {
      status: string;
      items: Array<Record<string, unknown>>;
      diagnostics: readonly unknown[];
      committedCount: number;
      failedCount: number;
    };
    const failedIndex = items.findIndex(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "product" in item &&
        (item as { product?: unknown }).product === "domestic-current-balance",
    );
    if (failedIndex < 0) return result;
    return {
      ...result,
      status: "partially-completed",
      items: result.items.map((item, index) =>
        index === failedIndex
          ? { ...item, status: "failed", failureKind: "item" }
          : item,
      ),
      committedCount: result.items.length - 1,
      failedCount: 1,
    };
  });
  const balanceItem = {
    provider: "cathay",
    product: "domestic-current-balance",
    itemKey: "cathay-test-run:domestic:balance:0",
    command: {
      kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
      request: {},
    },
  } as unknown as PGliteWorkflowRunItem;
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    bothProductsInput,
    collectionDependencies({
      collectCurrentBalanceItems: async (_page, domestic) =>
        domestic ? [balanceItem] : [],
    }),
  );

  assert.equal(output.status, "partial");
  assert.deepEqual(
    output.products.map((product) => [
      product.typeId,
      product.status,
      product.committedCount,
      product.errorCode,
    ]),
    [
      ["domestic", "failed", 1, "canonical-commit-failed"],
      ["foreign_currency", "success", 1, undefined],
    ],
  );
  assert.equal(output.committedCount, 2);
  assert.equal(harness.committed.length, 2);
  assert.equal(harness.committed[0]!.length, 2);
});

test("Cathay foreign collector reports a missing selected currency without blocking domestic commit", async () => {
  const harness = contextHarness();
  const dependencies = collectionDependencies();
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    bothProductsInput,
    {
      ...dependencies,
      collectForeign: (page, input, session, source, observedAt) =>
        collectCathayForeignFinancialCaptures(
          page,
          input.dateRange,
          input.foreignAccountFilters ?? input.accountFilters,
          input.currencyFilters,
          session,
          {
            source,
            observedAt,
            preparePage: async () => undefined,
            client: {
              fetchForeignAccounts: async () => [
                {
                  account: "CATHAY-FOREIGN-FIXTURE",
                  currencyList: [
                    { currencyCode: "USD" },
                    { currencyCode: "JPY" },
                  ],
                },
              ],
              fetchTransferDetails: async () => [
                {
                  currencyCode: "USD",
                  transferInfos: [
                    {
                      sequenceNumber: "1",
                      transferDate: "2026-08-23",
                      debitCreditType: "C",
                      amount: "10.00",
                      balance: "110.00",
                      memo: "synthetic fixture",
                    },
                  ],
                },
              ],
            },
          },
        ),
    },
  );
  assert.equal(output.status, "partial");
  assert.deepEqual(
    output.products.map((product) => [product.typeId, product.status]),
    [
      ["domestic", "success"],
      ["foreign_currency", "failed"],
    ],
  );
  assert.equal(harness.committed.length, 1);
  assert.equal(
    (harness.committed[0]![0] as { product: string }).product,
    "domestic-statements",
  );
});

test("Cathay malformed source decoding is isolated to its product and keeps the summary free of source data", async () => {
  const harness = contextHarness();
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    bothProductsInput,
    {
      ...collectionDependencies(),
      collectDomestic: async (_page, _input, _session, source) => {
        source.text.decode(Uint8Array.from([0xff]), "utf-8");
        return {
          requests: DOMESTIC_REQUESTS,
          accountNumbers: [CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo],
          captureCount: 1,
          rowCount: 3,
        };
      },
    },
  );

  assert.equal(output.status, "partial");
  assert.deepEqual(
    output.products.map((product) => [product.typeId, product.status, product.errorCode]),
    [
      ["domestic", "failed", "source-integrity-failed"],
      ["foreign_currency", "success", undefined],
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(output.products),
    /fixture-password|fixture-user/u,
  );
  assert.equal(harness.committed.length, 1);
});

test("Cathay session health failure after collection stops before commit and skips later products", async () => {
  const harness = contextHarness();
  let sessionChecks = 0;
  await assert.rejects(
    runCathayAllProviderWorkflow(harness.context, bothProductsInput, {
      ...collectionDependencies(),
      createSession: async () => {
        sessionChecks += 1;
        if (sessionChecks === 3) throw new Error("expired session token");
        return {
          jwtToken: "fixture-token",
          customerId: "fixture",
          idType: "fixture",
        };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "authentication-failed");
      assert.deepEqual(
        error.summary.products.map((product) => [
          product.typeId,
          product.status,
          product.skipReason,
        ]),
        [
          ["domestic", "failed", undefined],
          ["foreign_currency", "skipped", "not_attempted"],
        ],
      );
      assert.doesNotMatch(JSON.stringify(error.summary), /expired session token/u);
      return true;
    },
  );

  assert.equal(sessionChecks, 4);
  assert.equal(harness.committed.length, 0);
});

test("Cathay all workflow cancellation stops later products and retains prior receipts in its summary", async () => {
  const harness = contextHarness();
  await assert.rejects(
    runCathayAllProviderWorkflow(harness.context, bothProductsInput, {
      ...collectionDependencies(),
      collectForeign: async () => {
        harness.controller.abort(new Error("fixture cancellation"));
        return {
          captures: [CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1],
          selectedStatementCount: 1,
          rowCount: 1,
          accountKeys: [CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1.accountNo],
        };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "cancelled");
      assert.deepEqual(
        error.summary.products.map((product) => [
          product.typeId,
          product.status,
          product.skipReason,
        ]),
        [
          ["domestic", "success", undefined],
          ["foreign_currency", "failed", undefined],
        ],
      );
      assert.equal(error.summary.committedCount, 1);
      return true;
    },
  );
  assert.equal(harness.committed.length, 1);
});
