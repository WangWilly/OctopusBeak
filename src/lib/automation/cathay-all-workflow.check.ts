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
import { strictSourceText, SourceTextIntegrityError } from "./source-text.ts";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "./workflow-executor.ts";
import {
  completeCathayEmailOtpForApp,
  decodeCathayApiSourceResponse,
  type CathayDomesticFinancialCollection,
  type CathayGmailOtpPort,
} from "../../workflows/cathay-statements.ts";
import type { CathayForeignFinancialCollection } from "../../workflows/cathay-foreign-statements.ts";

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
    isVisible: async () => true,
    click: async () => {
      sendClicks += 1;
    },
  };
  const confirm = {
    click: async () => {
      confirmClicks += 1;
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

test("Cathay App Gmail OTP auto-fill requests once and keeps manual assistance fallback", async () => {
  const automatic = otpPage();
  let retrieveCalls = 0;
  await completeCathayEmailOtpForApp(automatic.page, {
    otp: otpPort({
      retrieve: async () => {
        retrieveCalls += 1;
        return { status: "found", otp: "ABCD-123456" };
      },
    }),
    signal: new AbortController().signal,
    requestHumanAssistance: async () => {
      throw new Error(
        "Manual assistance should not be requested for a found OTP.",
      );
    },
  });
  assert.deepEqual(automatic.read(), {
    fieldValue: "123456",
    sendClicks: 1,
    confirmClicks: 1,
  });
  assert.equal(retrieveCalls, 1);

  const assisted = otpPage();
  const assistanceEvents: string[] = [];
  let assistanceStage = "";
  await completeCathayEmailOtpForApp(assisted.page, {
    otp: otpPort({
      retrieve: async () => ({ status: "fallback", reason: "no-candidate" }),
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
  assert.equal(assistanceStage, "cathay-login-email-otp");
  assert.deepEqual(assistanceEvents, [
    "authentication-otp-auto-retrieval-fallback",
    "authentication-human-assistance-requested",
  ]);
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

function contextHarness() {
  const controller = new AbortController();
  const events: Array<{ stage: string; code: string }> = [];
  const committed: unknown[][] = [];
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute(items) {
      const materialized = [...(items as Iterable<unknown>)];
      committed.push(materialized);
      return resultFor(materialized) as never;
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
    domestic: CathayDomesticFinancialCollection;
    foreign: CathayForeignFinancialCollection;
  }> = {},
) {
  return {
    otp: otpPort(),
    signIn: async () => ({ usedExistingSession: true }),
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
    collectCurrentBalanceItems: async () => [],
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

test("Cathay all workflow admits domestic and foreign sources before one injected commit with no artifacts", async () => {
  const previousCwd = process.cwd();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cathay-typed-"));
  process.chdir(temporaryDirectory);
  try {
    const harness = contextHarness();
    const output = await runCathayAllProviderWorkflow(
      harness.context,
      bothProductsInput,
      collectionDependencies(),
    );
    assert.deepEqual(output.statementTypes, ["domestic", "foreign"]);
    assert.equal(output.sourceCaptureCount, 2);
    assert.equal(harness.committed.length, 1);
    const statementItem = harness.committed[0]![0] as {
      command: { request: { steps: readonly { kind: string }[] } };
    };
    assert.deepEqual(
      statementItem.command.request.steps.map((step) => step.kind),
      ["financial", "deposit"],
    );
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

test("Cathay all workflow rejects an incomplete selected domestic set before any commit", async () => {
  const harness = contextHarness();
  await assert.rejects(
    runCathayAllProviderWorkflow(
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
    ),
    /domestic selected source set is incomplete/u,
  );
  assert.equal(harness.committed.length, 0);
});

test("Cathay foreign collector rejects a missing selected currency before group commit", async () => {
  const harness = contextHarness();
  const dependencies = collectionDependencies();
  await assert.rejects(
    runCathayAllProviderWorkflow(harness.context, bothProductsInput, {
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
    }),
    /omitted a selected account\/currency/u,
  );
  assert.equal(harness.committed.length, 0);
});

test("Cathay malformed source decoding rejects selected sources before commit", async () => {
  const harness = contextHarness();
  await assert.rejects(
    runCathayAllProviderWorkflow(harness.context, bothProductsInput, {
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
    }),
    SourceTextIntegrityError,
  );
  assert.equal(harness.committed.length, 0);
});

test("Cathay all workflow cancellation during collection stops before commit", async () => {
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
    /fixture cancellation/u,
  );
  assert.equal(harness.committed.length, 0);
});
