import { RUN_EVENT_SIGNALS } from "./run-event.ts";
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
  WorkflowContextWith,
} from "./workflow-executor.ts";
import {
  decodeCathayApiSourceResponse,
  waitForCathayTrustedDeviceSignIn,
  type CathayDomesticFinancialCollection,
} from "../../workflows/cathay-statements.ts";
import type {
  CathayAppLoginDependencies,
  CathayCredentials,
} from "../../workflows/cathay-statements.ts";
import type { CathayForeignFinancialCollection } from "../../workflows/cathay-foreign-statements.ts";
import { ProductCollectionFatalError, ProductCollectionInterruptedError } from "./product-collection.ts";
import { parsePreviewWrite, type PreviewCreditCollection, type PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import { previewReceipt } from "../preview-sources/preview-source-harness.ts";
import {
  CATHAY_PREVIEW_RESPONSES,
  cathayCardTotals,
  fakeCathayAttachedPreviewPort,
} from "../../workflows/cathay-attached-preview.fixtures.ts";

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

function signInPage(state: { signedIn?: boolean; challenge?: boolean }) {
  const visible = (shown: boolean | undefined) => ({ isVisible: async () => shown === true });
  return {
    url: () => state.signedIn
      ? "https://www.cathaybk.com.tw/OnlineBanking/Home"
      : "https://www.cathaybk.com.tw/MyBank/",
    waitForTimeout: async () => undefined,
    getByText: () => ({ first: () => visible(state.signedIn) }),
    locator: () => ({
      filter: () => ({}),
      or: () => ({ first: () => visible(state.challenge) }),
    }),
  } as unknown as Page;
}

function recordEvents() {
  const events: string[] = [];
  return { events, event: async (code: string) => { events.push(code); } };
}

test("a Cathay run that meets an OTP challenge stops asking for device registration", async () => {
  const { events, event } = recordEvents();
  await assert.rejects(
    waitForCathayTrustedDeviceSignIn(signInPage({ challenge: true }), {
      signal: new AbortController().signal,
      event,
    }),
    (error: unknown) =>
      error instanceof ProductCollectionFatalError &&
      error.errorCode === "device-registration-required",
  );
  assert.deepEqual(events, ["device-registration-required"]);
});

test("a trusted Cathay device signs in without a code", async () => {
  const { events, event } = recordEvents();
  await waitForCathayTrustedDeviceSignIn(signInPage({ signedIn: true, challenge: true }), {
    signal: new AbortController().signal,
    event,
  });
  assert.deepEqual(events, []);
});

test("a Cathay sign-in that never settles fails verification", async () => {
  const { events, event } = recordEvents();
  await assert.rejects(
    waitForCathayTrustedDeviceSignIn(signInPage({}), {
      signal: new AbortController().signal,
      event,
    }, 0),
    (error: unknown) =>
      error instanceof ProductCollectionFatalError &&
      error.errorCode === "verification-failed",
  );
  assert.deepEqual(events, ["authentication-sign-in-unconfirmed"]);
});

test("cancellation wins over the Cathay device-registration outcome", async () => {
  const controller = new AbortController();
  controller.abort();
  const { events, event } = recordEvents();
  await assert.rejects(
    waitForCathayTrustedDeviceSignIn(signInPage({ challenge: true }), {
      signal: controller.signal,
      event,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
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
  const context: WorkflowContextWith<"financialCommit", "previewWrite"> = {
    runId: "cathay-test-run",
    signal: controller.signal,
    now: () => "2026-09-25T01:00:00.000Z",
    browser: {
      withPage: (run) => run({ on() {}, off() {} } as unknown as Page),
    },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    financialCommit,
    event: async (stage, _outcome, code) => {
      events.push({ stage, code });
    },
    signalEvent: async (signal) => {
      events.push({ stage: RUN_EVENT_SIGNALS[signal].stage, code: signal });
    },
  };
  return { context, controller, events, committed };
}

function collectionDependencies(
  override: Partial<{
    signIn: (
      page: Page,
      credentials: CathayCredentials,
      dependencies: CathayAppLoginDependencies,
    ) => Promise<{ usedExistingSession: boolean }>;
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
    signIn:
      override.signIn ??
      (async () => ({ usedExistingSession: true })),
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
    const output = await runCathayAllProviderWorkflow(
      harness.context,
      bothProductsInput,
      collectionDependencies(),
    );
    assert.deepEqual(output.counts, {
      sourceCaptureCount: 2,
      rowCount: 4,
      itemCount: 2,
      committedCount: 2,
      count: 2,
    });
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
      output.products!.map((product) => [product.typeId, product.status]),
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
    output.products!.map((product) => [
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
    output.products!.map((product) => [
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
    output.products!.map((product) => [product.typeId, product.status]),
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
    output.products!.map((product) => [product.typeId, product.status]),
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
    output.products!.map((product) => [
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
  assert.equal(output.counts.committedCount, 2);
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
    output.products!.map((product) => [product.typeId, product.status]),
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
    output.products!.map((product) => [product.typeId, product.status, product.errorCode]),
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

function attachedHarness() {
  const harness = contextHarness();
  const writes: PreviewWrite[] = [];
  const context: WorkflowContextWith<"financialCommit", "previewWrite"> = {
    ...harness.context,
    previewWrite: {
      async write(input) {
        writes.push(parsePreviewWrite(input));
        return previewReceipt(input);
      },
    },
  };
  return { ...harness, context, writes };
}

const outcomes = (products: readonly { typeId: string; status: string; skipReason?: string; errorCode?: string }[]) =>
  products.map((product) => [product.typeId, product.status, product.skipReason ?? product.errorCode]);

test("a Cathay run with only an attached product signs in and collects only that product", async () => {
  const harness = attachedHarness();
  const fake = fakeCathayAttachedPreviewPort();
  let signIns = 0;
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    { ...bothProductsInput, statementTypes: [], attachedPreviewProducts: ["credit_card"] },
    {
      ...collectionDependencies({ signIn: async () => { signIns += 1; return { usedExistingSession: true }; } }),
      collectDomestic: async () => { throw new Error("domestic must not run"); },
      collectForeign: async () => { throw new Error("foreign must not run"); },
      attachedPreviewPort: () => fake.port,
    },
  );
  assert.equal(signIns, 1);
  assert.equal(harness.committed.length, 0);
  assert.deepEqual(harness.writes.map((write) => [write.sourceId, write.product]), [["cathay", "credit_card"]]);
  const cards = harness.writes[0]!.collection as PreviewCreditCollection;
  assert.deepEqual(cards.accounts.map((account) => account.sourceAccountKey), ["card-portfolio:TWD"], "no USD account is written");
  assert.deepEqual(cards.accounts[0]!.statements.map((statement) => [statement.statementKey, statement.currency]), [
    ["2026-09", "TWD"],
    ["2026-09:USD", "USD"],
  ]);
  assert.equal(cathayCardTotals(cards).liabilities.incomplete, undefined, "the foreign bill leaves the totals complete");
  assert.ok(!fake.seen.includes("domesticOverview"));
  assert.deepEqual(outcomes(output.products!), [
    ["domestic", "skipped", "not_selected"],
    ["foreign_currency", "skipped", "not_selected"],
    ["credit_card", "success", undefined],
    ["time_deposit", "skipped", "not_selected"],
  ]);
  assert.deepEqual(output.counts, { sourceCaptureCount: 0, rowCount: 3, itemCount: 1, committedCount: 1, count: 0 });
  assert.equal(output.status, "completed", "a preview-only run admits no financial data");
});

test("a failing attached product leaves the verified and other attached outcomes intact", async () => {
  const harness = attachedHarness();
  const fake = fakeCathayAttachedPreviewPort({
    C_BILL_Q_RecentBillInfo: CATHAY_PREVIEW_RESPONSES.C_BILL_Q_RecentBillInfo.replace(`"unPaidAmount":1200`, `"unPaidAmount":"x"`),
  });
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    { ...bothProductsInput, statementTypes: ["domestic"], attachedPreviewProducts: ["credit_card", "time_deposit"] },
    { ...collectionDependencies(), attachedPreviewPort: () => fake.port },
  );
  assert.equal(harness.committed.length, 1);
  assert.deepEqual(harness.writes.map((write) => [write.sourceId, write.product]), [["cathay", "time_deposit"]]);
  assert.deepEqual(outcomes(output.products!), [
    ["domestic", "success", undefined],
    ["foreign_currency", "skipped", "not_selected"],
    ["credit_card", "failed", "source-validation-failed"],
    ["time_deposit", "success", undefined],
  ]);
  assert.equal(output.status, "partial");
});

test("an empty attached selection collects nothing and keeps the verified summary", async () => {
  const harness = attachedHarness();
  const output = await runCathayAllProviderWorkflow(
    harness.context,
    { ...bothProductsInput, statementTypes: ["domestic"], attachedPreviewProducts: [] },
    { ...collectionDependencies(), attachedPreviewPort: () => { throw new Error("attached port must not open"); } },
  );
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(outcomes(output.products!), [
    ["domestic", "success", undefined],
    ["foreign_currency", "skipped", "not_selected"],
  ]);
  assert.equal(output.status, "financial-admitted");
});

test("a Cathay run with neither verified nor attached products is invalid input", async () => {
  const harness = attachedHarness();
  await assert.rejects(
    runCathayAllProviderWorkflow(harness.context, { ...bothProductsInput, statementTypes: [], attachedPreviewProducts: [] }, collectionDependencies()),
    /input are invalid/u,
  );
  await assert.rejects(
    runCathayAllProviderWorkflow(harness.context, { ...bothProductsInput, statementTypes: [], attachedPreviewProducts: ["deposit"] }, collectionDependencies()),
    /input are invalid/u,
  );
});

test("a session lost during an attached product ends the run with the verified outcomes kept", async () => {
  const harness = attachedHarness();
  let sessionChecks = 0;
  const fake = fakeCathayAttachedPreviewPort({ cardStatus: null });
  await assert.rejects(
    runCathayAllProviderWorkflow(
      harness.context,
      { ...bothProductsInput, statementTypes: ["domestic"], attachedPreviewProducts: ["credit_card", "time_deposit"] },
      {
        ...collectionDependencies(),
        createSession: async () => {
          sessionChecks += 1;
          if (sessionChecks > 4) throw new Error("expired");
          return { jwtToken: "fixture-token", customerId: "fixture", idType: "fixture" };
        },
        attachedPreviewPort: () => fake.port,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "authentication-failed");
      assert.deepEqual(outcomes(error.summary.products), [
        ["domestic", "success", undefined],
        ["foreign_currency", "skipped", "not_selected"],
        ["credit_card", "failed", "source-collection-failed"],
        ["time_deposit", "skipped", "not_attempted"],
      ]);
      return true;
    },
  );
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.committed.length, 1);
});
