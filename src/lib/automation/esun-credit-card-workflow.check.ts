import { RUN_EVENT_SIGNALS } from "./run-event.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Page, Response } from "playwright";
import type { WorkflowContext, WorkflowContextWith } from "./workflow-executor.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import type { WorkflowRunResult } from "./workflow-run-result.ts";
import { strictSourceText } from "./source-text.ts";
import { runEsunCreditCardProviderWorkflow } from "../../workflows/esun-credit-card-statements.ts";
import { ESUN_SOURCE } from "./server/sources/esun.ts";
import { withBoundProducts } from "./product-collection.fixtures.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "./server/config-files.ts";
import type { PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import type { EsunPortalReply } from "../preview-sources/esun-portal.ts";

const timelineEndpoint = "/GW/creditLastYear/getFilterResult";
const summaryEndpoint = "/GW/creditBill/getSummaryResult";

function monthAtOffset(now: Date, offset: number): { year: string; month: string; day: string } {
  const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const day = Math.min(now.getDate(), new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(day).padStart(2, "0"),
  };
}

function jsonResponse(value: unknown, url: string): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return byteResponse(bytes, url);
}

function byteResponse(bytes: Uint8Array, url: string): Response {
  return {
    status: () => 200,
    url: () => url,
    request: () => ({ method: () => "POST" }),
    body: async () => Buffer.from(bytes),
    headers: () => ({}),
  } as unknown as Response;
}

function timelineValue(now: Date, monthCount = 13, cursor = 4): unknown {
  return {
    body: {
      rtnCode: "S",
      cursor,
      transList: Array.from({ length: monthCount }, (_, offset) => {
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

function issuerSummary(period: string): unknown {
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

function createPage(options: {
  timelineBytes?: Uint8Array;
  monthCount?: number;
  cursor?: number;
  portal?: (path: string, requestBody: Readonly<Record<string, unknown>>) => EsunPortalReply;
} = {}): Page {
  const now = new Date(2026, 8, 25);
  const newestPeriod = monthAtOffset(now, 1);
  const oldestPeriod = monthAtOffset(now, 2);
  const periods = [
    `${newestPeriod.year}/${newestPeriod.month}`,
    `${oldestPeriod.year}/${oldestPeriod.month}`,
  ];
  const responses = [
    options.timelineBytes
      ? byteResponse(options.timelineBytes, timelineEndpoint)
      : jsonResponse(timelineValue(now, options.monthCount, options.cursor), timelineEndpoint),
    jsonResponse(issuerSummary(periods[1]!), summaryEndpoint),
    jsonResponse(issuerSummary(periods[0]!), summaryEndpoint),
  ];
  const inputValues = new Map<string, string>();
  const makeLocator = (selector: string) => ({
    waitFor: async () => undefined,
    click: async () => undefined,
    fill: async (value: string) => { inputValues.set(selector, value); },
    inputValue: async () => inputValues.get(selector) ?? "",
    isVisible: async () => true,
    allTextContents: async () => selector === ".info-scrollable li" ? periods : [],
    first() { return this; },
    last() { return this; },
    nth() { return this; },
    evaluate: async () => undefined,
    boundingBox: async () => ({ x: 1, y: 1, width: 640, height: 480 }),
  });
  const popup = {
    waitForURL: async () => undefined,
    waitForResponse: async (predicate: (response: Response) => boolean) => {
      const index = responses.findIndex((response) => predicate(response));
      if (index < 0) throw new Error("Unexpected E.SUN response waiter.");
      return responses.splice(index, 1)[0]!;
    },
    locator: (selector: string) => makeLocator(selector),
    getByText: () => ({ click: async () => undefined, isVisible: async () => true }),
    close: async () => undefined,
  };
  const page = {
    url: () => "https://ebank.esunbank.com.tw/index.jsp",
    getByText: () => ({
      isVisible: async () => true,
      waitFor: async () => undefined,
      click: async () => undefined,
    }),
    waitForEvent: async () => popup,
    waitForResponse: async (predicate: (response: Response) => boolean) => {
      const response = {
        url: () => "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
        status: () => 204,
      } as unknown as Response;
      if (predicate(response)) return response;
      throw new Error("Optional current-credit response not present.");
    },
    locator: (selector: string) => makeLocator(selector),
    getByRole: (_role: string, options: { name?: string } = {}) => ({
      click: async () => undefined,
      isVisible: async () => options.name !== "確定登入",
    }),
    goto: async () => undefined,
    on: () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async (_inPage: unknown, call: { path: string; requestBody: Readonly<Record<string, unknown>> }) => {
      if (!options.portal) throw new Error("The E.SUN portal was called without an attached product.");
      return options.portal(call.path, call.requestBody);
    },
  };
  return page as unknown as Page;
}

/** Runs E.SUN as the executor does: the Product collection run bound to ESUN_SOURCE and this input. */
function runEsun(context: WorkflowContextWith<"financialCommit", "previewWrite">, input: unknown) {
  return runEsunCreditCardProviderWorkflow(withBoundProducts(context, ESUN_SOURCE, input), input);
}

function createContext(page: Page) {
  const events: Array<{ stage: string; code: string; counts?: unknown }> = [];
  const committed: unknown[][] = [];
  const previewWrites: PreviewWrite[] = [];
  let withPageCount = 0;
  let assistanceCount = 0;
  const context: WorkflowContextWith<"financialCommit", "previewWrite"> = {
    runId: "run-esun-check",
    signal: new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: {
      async withPage(run) {
        withPageCount += 1;
        return run(page);
      },
    },
    text: strictSourceText,
    verification: {
      async complete() {
        assistanceCount += 1;
      },
    },
    previewWrite: {
      async write(input) {
        previewWrites.push(input);
        const accounts = input.product === "deposit" ? input.collection.accounts.length : 0;
        return { accounts, balances: accounts, transactions: 0, purchases: 0, statements: 0, closedAccounts: [] } as never;
      },
    },
    financialCommit: {
      async execute(items) {
        const materialized: unknown[] = [];
        for await (const item of items) materialized.push(item);
        committed.push(materialized);
        // The port, not the workflow, reports the commit stage; mark where it ran.
        events.push({ stage: "commit", code: "commit-port-called" });
        return {
          status: "completed",
          items: materialized.map((item) => ({ ...(item as object), status: "committed" })),
          diagnostics: [],
          committedCount: materialized.length,
          failedCount: 0,
        } as never;
      },
    },
    async event(stage, outcome, code, counts) {
      events.push({ stage, code, counts });
    },
    async signalEvent(signal) {
      events.push({ stage: RUN_EVENT_SIGNALS[signal].stage, code: signal, counts: undefined });
    },
  };
  return {
    context,
    events,
    committed,
    previewWrites,
    get withPageCount() { return withPageCount; },
    get assistanceCount() { return assistanceCount; },
  };
}

test("E.SUN typed workflow commits a complete in-memory source through the injected port", async () => {
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = "synthetic-esun-managed-secret";
  try {
    for (const monthCount of [12, 13]) {
      const harness = createContext(createPage({ monthCount }));
      const output = await runEsun(harness.context, {
        managedIdentitySecret: "synthetic-esun-managed-secret",
        credentials: {
          esun_user_id: "synthetic-user",
          esun_account: "synthetic-account",
          esun_password: "synthetic-password",
        },
        statementTypes: ["credit_card"],
      });

      assert.equal(harness.committed.length, 1);
      assert.equal(harness.committed[0]?.length, 1);
      assert.equal((harness.committed[0]?.[0] as { provider?: string }).provider, "esun");
      assert.equal(output.status, "financial-admitted");
      assert.equal(output.counts.canonicalCaptureCount, 1);
      assert.equal(output.counts.sourceCaptureCount, 1, "E.SUN reports its one Source Capture (ADR 0064)");
      assert.equal(output.counts.count, monthCount);
      assert.deepEqual(harness.events.find(({ code }) => code === "source-validation-completed")?.counts,
        { completed: 1, total: 1 }, "the run closes validation with that capture");
      assert.equal("files" in (output as object), false);
      assert.deepEqual(
        harness.events.map(({ stage, code }) => [stage, code]),
        [
          ["preparation", "input-validated"],
          ["authentication", "authentication-started"],
          ["authentication", "authentication-completed"],
          ["collection", "credit-card-collection-started"],
          ["collection", "collection-started"],
          ["decoding", "source-decoding-started"],
          ["collection", "timeline-collected"],
          ["collection", "bill-summaries-collected"],
          ["decoding", "source-decoding-completed"],
          ["validation", "source-validation-started"],
          ["collection", "credit-card-collection-completed"],
          ["decoding", "credit-card-source-decoding-completed"],
          ["validation", "credit-card-source-validation-completed"],
          ["commit", "commit-port-called"],
          ["validation", "source-validation-completed"],
        ],
      );
    }
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
  }
});

test("E.SUN typed workflow rejects malformed text and incomplete timelines before commit", async () => {
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = "synthetic-esun-managed-secret";
  try {
    for (const page of [
      createPage({ timelineBytes: new Uint8Array([0xc3, 0x28]) }),
      createPage({ monthCount: 11 }),
      createPage({ cursor: 3 }),
    ]) {
      const harness = createContext(page);
      await assert.rejects(
        runEsun(harness.context, {
          managedIdentitySecret: "synthetic-esun-managed-secret",
          credentials: {
            esun_user_id: "synthetic-user",
            esun_account: "synthetic-account",
            esun_password: "synthetic-password",
          },
          statementTypes: ["credit_card"],
        }),
      );
      assert.equal(harness.committed.length, 0);
    }
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
  }
});

test("E.SUN typed workflow honors cancellation before opening a page or committing", async () => {
  const harness = createContext(createPage());
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const context = { ...harness.context, signal: controller.signal };
  await assert.rejects(
    runEsun(context, {
      managedIdentitySecret: "synthetic-esun-managed-secret",
      credentials: {
        esun_user_id: "synthetic-user",
        esun_account: "synthetic-account",
        esun_password: "synthetic-password",
      },
      statementTypes: ["credit_card"],
    }),
    /cancelled/u,
  );
  assert.equal(harness.withPageCount, 0);
  assert.equal(harness.committed.length, 0);
});

const DEPOSIT_INIT = "mib-ctw-portal/ctw01/ctw01002/home/init";
const portalOk = (resultBody: unknown): EsunPortalReply =>
  ({ kind: "json", httpStatus: 200, text: JSON.stringify({ resultCode: "0000", resultBody }), date: null });
const portalNotHeld = (description: string): EsunPortalReply =>
  ({ kind: "json", httpStatus: 200, text: JSON.stringify({ resultCode: "S001", resultDescription: description }), date: null });

function depositPortal(overrides: Readonly<Record<string, EsunPortalReply>> = {}) {
  const calls: string[] = [];
  const portal = (path: string): EsunPortalReply => {
    calls.push(path.split("/").pop()!);
    const override = overrides[path.split("/").pop()!];
    if (override) return override;
    if (path === DEPOSIT_INIT) return portalOk({});
    if (path.endsWith("preQueryTWTransactionDetail")) return portalOk({
      demandDeptAcc: "SYN-TW-0001",
      twAccountList: [{ accountNo: "SYN-TW-0001" }],
      twCurrInfo: { realBalance: "500.00" },
    });
    if (path.endsWith("queryTWTransactionDetail")) return portalOk({
      queryDeptTxDtlResult: { detailListData: [{ detailInfo: [{ txDate: "2026/09/20", amount: "50", debitCredit: "DR" }] }] },
    });
    if (path.endsWith("preQueryFRTransactionDetail")) return portalNotHeld("查無外幣帳號，或您尚未開立外幣帳戶");
    throw new Error(`unexpected portal path ${path}`);
  };
  return { portal, calls };
}

const workflowInput = (extra: Readonly<Record<string, unknown>> = {}) => ({
  managedIdentitySecret: "synthetic-esun-managed-secret",
  credentials: {
    esun_user_id: "synthetic-user",
    esun_account: "synthetic-account",
    esun_password: "synthetic-password",
  },
  statementTypes: ["credit_card"],
  ...extra,
});

async function withManagedSecret<T>(run: () => Promise<T>): Promise<T> {
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = "synthetic-esun-managed-secret";
  try {
    return await run();
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
  }
}

const outcomes = (output: Pick<WorkflowRunResult, "products">) => (output.products ?? []).map(({ typeId, status, errorCode, skipReason }) =>
  [typeId, status, errorCode ?? skipReason ?? null]);

test("the attached deposit writes Preview Financial Data for the E.SUN group after the card commits", () => withManagedSecret(async () => {
  const deposit = depositPortal();
  const harness = createContext(createPage({ portal: deposit.portal }));
  const output = await runEsun(harness.context, workflowInput({ attachedPreviewProducts: ["deposit"] }));

  assert.equal(harness.committed.length, 1, "the card still commits canonically");
  assert.deepEqual(harness.committed.flat().map((item) => (item as { product?: string }).product), ["credit-card"]);
  assert.deepEqual(harness.previewWrites.map(({ sourceId, institution, product }) => [sourceId, institution, product]), [["esun", "esun", "deposit"]]);
  const [write] = harness.previewWrites;
  assert.ok(write?.product === "deposit");
  assert.deepEqual(write.collection.accounts.map(({ sourceAccountKey, balances, transactions }) =>
    [sourceAccountKey, balances[0]!.amount, transactions.map(({ amount, direction }) => [amount, direction])]), [
    ["SYN-TW-0001:TWD", "500.00", [["50", "outflow"]]],
  ]);
  assert.deepEqual(outcomes(output), [["credit_card", "success", null], ["deposit", "success", null]]);
  assert.equal(output.status, "financial-admitted");
  assert.deepEqual(deposit.calls, ["init", "preQueryTWTransactionDetail", "queryTWTransactionDetail", "init", "preQueryFRTransactionDetail"]);
  const eventCodes = harness.events.map(({ code }) => code);
  assert.ok(eventCodes.indexOf("commit-port-called") < eventCodes.indexOf("deposit-collection-started"));
}));

test("a failing attached deposit leaves the card committed and reported", () => withManagedSecret(async () => {
  const deposit = depositPortal({ queryTWTransactionDetail: { kind: "json", httpStatus: 200, text: "{\"resultCode\":\"E999\"}", date: null } });
  const harness = createContext(createPage({ portal: deposit.portal }));
  const output = await runEsun(harness.context, workflowInput({ attachedPreviewProducts: ["deposit"] }));

  assert.equal(harness.committed.length, 1);
  assert.equal(harness.previewWrites.length, 0, "a failed product writes nothing");
  assert.deepEqual(outcomes(output), [["credit_card", "success", null], ["deposit", "failed", "source-validation-failed"]]);
  assert.equal(output.status, "partial");
  assert.equal(output.counts.canonicalCaptureCount, 1);
}));

test("an attached-only selection signs in, skips the card, and writes the deposit", () => withManagedSecret(async () => {
  const deposit = depositPortal();
  const harness = createContext(createPage({ portal: deposit.portal }));
  const output = await runEsun(harness.context, workflowInput({ statementTypes: [], attachedPreviewProducts: ["deposit"] }));

  assert.equal(harness.committed.length, 0, "no canonical commit without the card");
  assert.equal(harness.previewWrites.length, 1);
  assert.deepEqual(outcomes(output), [["credit_card", "skipped", "not_selected"], ["deposit", "success", null]]);
  assert.equal(output.counts.canonicalCaptureCount, 0);
  assert.equal(harness.events.some(({ code }) => code === "timeline-collected"), false);
}));

test("an attached-only run fails with the deposit's own error and reports a stated absence as not_held", () => withManagedSecret(async () => {
  const failing = createContext(createPage({ portal: depositPortal({ preQueryTWTransactionDetail: portalNotHeld("系統維護中") }).portal }));
  await assert.rejects(
    runEsun(failing.context, workflowInput({ statementTypes: [], attachedPreviewProducts: ["deposit"] })),
    (error: unknown) => (error as { reason?: string }).reason === "unexpected-response",
  );

  const absent = createContext(createPage({ portal: depositPortal({ preQueryTWTransactionDetail: portalNotHeld("查無臺幣帳號，或您尚未開立臺幣帳戶") }).portal }));
  const output = await runEsun(absent.context, workflowInput({ statementTypes: [], attachedPreviewProducts: ["deposit"] }));
  assert.deepEqual(outcomes(output), [["credit_card", "skipped", "not_selected"], ["deposit", "not_held", null]]);
  assert.equal(absent.previewWrites.length, 0, "not_held writes no account and no zero balance");

  const nothing = createContext(createPage());
  await assert.rejects(
    runEsun(nothing.context, workflowInput({ statementTypes: [], attachedPreviewProducts: [] })),
    (error: unknown) => (error as { errorCode?: string }).errorCode === "collection-scope-changed",
  );
  assert.equal(nothing.withPageCount, 0);
}));

test("no attached selection never touches the deposit portal", () => withManagedSecret(async () => {
  const harness = createContext(createPage());
  const output = await runEsun(harness.context, workflowInput({ attachedPreviewProducts: [] }));
  assert.equal(harness.previewWrites.length, 0);
  assert.deepEqual(outcomes(output), [["credit_card", "success", null]]);
}));

test("a card failure reports the card failed with its classified code beside the written deposit", () => withManagedSecret(async () => {
  const cases: ReadonlyArray<[string, Parameters<typeof createPage>[0], string]> = [
    ["incomplete timeline", { monthCount: 11 }, "source-collection-failed"],
    ["malformed text", { timelineBytes: new Uint8Array([0xc3, 0x28]) }, "source-integrity-failed"],
  ];
  for (const [name, page, errorCode] of cases) {
    const harness = createContext(createPage({ ...page, portal: depositPortal().portal }));
    const output = await runEsun(harness.context, workflowInput({ attachedPreviewProducts: ["deposit"] }));
    assert.equal(harness.committed.length, 0, name);
    assert.equal(harness.previewWrites.length, 1, name);
    assert.deepEqual(outcomes(output), [["credit_card", "failed", errorCode], ["deposit", "success", null]], name);
    assert.equal(output.status, "partial", name);
    assert.equal(output.counts.canonicalCaptureCount, 0, name);
  }
}));

const cardFailure = (error: unknown) => {
  assert.ok(error instanceof ProductCollectionInterruptedError);
  assert.equal(error.errorCode, "source-collection-failed");
  assert.match(String((error as Error & { cause?: unknown }).cause), /timeline did not reach a complete/u);
  return true;
};

test("a card failure with no deposit data fails the run with the card's own error", () => withManagedSecret(async () => {
  const failedDeposit = createContext(createPage({
    monthCount: 11,
    portal: depositPortal({ queryTWTransactionDetail: { kind: "json", httpStatus: 200, text: "{\"resultCode\":\"E999\"}", date: null } }).portal,
  }));
  await assert.rejects(
    runEsun(failedDeposit.context, workflowInput({ attachedPreviewProducts: ["deposit"] })),
    cardFailure,
  );
  assert.equal(failedDeposit.previewWrites.length, 0);

  const cardOnly = createContext(createPage({ monthCount: 11, portal: depositPortal().portal }));
  await assert.rejects(
    runEsun(cardOnly.context, workflowInput({ attachedPreviewProducts: [] })),
    cardFailure,
  );
  assert.equal(cardOnly.previewWrites.length, 0);
}));

test("a refused E.SUN card commit names the run collection-scope-changed and skips the attached deposit", () => withManagedSecret(async () => {
  const deposit = depositPortal();
  const harness = createContext(createPage({ portal: deposit.portal }));
  const context: WorkflowContextWith<"financialCommit", "previewWrite"> = {
    ...harness.context,
    financialCommit: {
      async execute(items) {
        const received = [];
        for await (const item of items) received.push(item);
        return {
          status: "failed",
          items: received.map((item) => ({
            itemKey: item.itemKey, provider: item.provider, product: item.product,
            status: "failed" as const, failureKind: "refused" as const, diagnostics: [],
          })),
          diagnostics: [], committedCount: 0, failedCount: received.length,
        };
      },
    },
  };
  await assert.rejects(
    runEsun(context, workflowInput({ attachedPreviewProducts: ["deposit"] })),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "collection-scope-changed");
      assert.deepEqual(outcomes({ products: error.summary.products }), [["credit_card", "failed", "collection-scope-changed"]]);
      return true;
    },
  );
  assert.deepEqual(deposit.calls, []);
  assert.equal(harness.previewWrites.length, 0);
}));
