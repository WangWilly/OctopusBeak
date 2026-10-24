import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import type { PreviewCreditCollection, PreviewWrite } from "../ledger/pglite/preview-financial-data.ts";
import { parsePreviewCreditCollection } from "../ledger/pglite/preview-credit.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { ProductCollectionInterruptedError, interruptedProductCollectionFromOutput } from "../lib/automation/product-collection.ts";
import type { WorkflowContext, WorkflowFinancialCommitPort, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { previewReceipt } from "../lib/preview-sources/preview-source-harness.ts";
import { PreviewSourceFailure } from "../lib/preview-sources/source-kit.ts";
import type { PreviewResponseObservation } from "../lib/preview-sources/workflow.ts";
import {
  collectSinopacCreditCards,
  SINOCARD_ACCOUNTING_PATH,
  SINOCARD_AUTH_PATH,
  SINOCARD_LATEST_TX_PATH,
  SINOCARD_OUTSTANDING_PATH,
  SINOCARD_SSO_PATH,
  SINOPAC_CARD_SUMMARY_PATH,
  type SinopacCardTransport,
} from "./sinopac-credit-card.ts";
import { runSinopacProviderWorkflow } from "./sinopac-statements.ts";

const DATE_HEADER = "Thu, 24 Sep 2026 04:00:00 GMT";
const COLLECTED_AT = "2026-09-24T04:05:00.000Z";

type Bodies = Record<string, unknown>;

const bodies = (): Bodies => ({
  [SINOPAC_CARD_SUMMARY_PATH]: [{ Header: "SUCCESS", Message: null, CardTrans: "Y" }],
  [SINOCARD_SSO_PATH]: { ResultCode: "00", ResultMessage: "", Result: { ID: "SYNTHETIC-ID" } },
  [SINOCARD_AUTH_PATH]: { ResultCode: "00", ResultMessage: "", Result: {} },
  [SINOCARD_LATEST_TX_PATH]: {
    ResultCode: "00",
    Result: {
      Items: [
        { AuthDate: "2026/09/23", AuthTime: "12:30:00", CardNo: "************1234", Memo: "測試便利商店", AuthAmt: "120", AuthResult: "Y" },
      ],
    },
  },
  [SINOCARD_OUTSTANDING_PATH]: {
    ResultCode: "00",
    Result: {
      Detail: [
        { CurrencyCode: "000", CardLast4: "5678", TXDATE: "2026/09/22", DEDATE: "2026/09/24", MEMO: "測試電費", AMT: "1,500" },
        { CurrencyCode: "000", CardLast4: "5678", TXDATE: "2026/09/20", DEDATE: "2026/09/24", MEMO: "現金回饋", AMT: "-88" },
        { CurrencyCode: "392", CardLast4: "5678", TXDATE: "2026/09/01", DEDATE: "2026/09/02", MEMO: "測試消費", AMT: "100" },
        { CurrencyCode: "840", CardLast4: "5678", TXDATE: "2026/09/05", DEDATE: "2026/09/07", MEMO: "測試海外", AMT: "12.50" },
      ],
      SubTotal: [
        { CurrencyCode: "000", SubTotalAmt: "1,412", Count: 2 },
        { CurrencyCode: "392", SubTotalAmt: "100", Count: 1 },
        { CurrencyCode: "840", SubTotalAmt: "12.50", Count: 1 },
      ],
    },
  },
  [SINOCARD_ACCOUNTING_PATH]: {
    ResultCode: "00",
    Result: {
      BaseData: { STMTDATE: "20260723", DUEDATE: "20260807" },
      BillAmounts: [
        { CurrencyCode: "000", CURRBAL: "2,000", DUEAMT: "500", TotalPaymentAmt: "-" },
        { CurrencyCode: "392", CURRBAL: "-137", TotalPaymentAmt: "0" },
      ],
    },
  },
});

function fakeTransport(source: Bodies) {
  const calls: Array<{ path: string; content?: unknown; userId?: string | null }> = [];
  const answer = (path: string) => {
    if (!(path in source)) throw new Error(`Unrouted fake request: ${path}`);
    const body = source[path];
    return { endpoint: path, status: 200, date: DATE_HEADER, text: typeof body === "string" ? body : JSON.stringify(body) };
  };
  const transport: SinopacCardTransport = {
    mma: async (path) => { calls.push({ path }); return answer(path); },
    sinoCard: async (path, content, userId) => { calls.push({ path, content, userId }); return answer(path); },
  };
  return { transport, calls };
}

async function collect(source: Bodies = bodies()) {
  const observations: PreviewResponseObservation[] = [];
  const { transport, calls } = fakeTransport(source);
  const result = await collectSinopacCreditCards({ transport, collectedAt: COLLECTED_AT, observe: (item) => observations.push(item) });
  return { result, observations, calls };
}

async function written(source: Bodies = bodies()): Promise<PreviewCreditCollection> {
  const { result } = await collect(source);
  assert.ok(!("absent" in result), "a collection, not an absence");
  return parsePreviewCreditCollection(result);
}

async function failure(source: Bodies): Promise<PreviewSourceFailure["reason"]> {
  try {
    await written(source);
  } catch (error) {
    assert.ok(error instanceof PreviewSourceFailure, `expected a typed failure, got ${String(error)}`);
    return error.reason;
  }
  return assert.fail("the collection was written");
}

function edit(mutate: (source: any) => void): Bodies {
  const source = bodies();
  mutate(source);
  return source;
}

test("SinoPac cards write one account per currency with exact statement-minus-paid-plus-unbilled balances", async () => {
  const collection = await written();
  assert.deepEqual(collection.accounts.map((account) => account.sourceAccountKey), ["card:TWD", "card:JPY", "card:USD"]);
  const [twd, jpy, usd] = collection.accounts;

  assert.deepEqual(twd!.balances, [{
    amount: "3412",
    currency: "TWD",
    observedAt: { at: "2026-09-24T04:00:00.000Z", source: "reported" },
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "2000", paidAmount: "0", unbilledAmount: "1412" },
  }]);
  assert.equal(jpy!.balances[0]!.amount, "-37", "a negative bill stays negative");
  assert.deepEqual(jpy!.balances[0]!.basis, { kind: "statement-minus-paid-plus-unbilled", statementAmount: "-137", paidAmount: "0", unbilledAmount: "100" });
  assert.deepEqual(usd!.balances, [], "an unbilled-only currency has no bill operands, so its used credit stays unknown");

  assert.deepEqual(twd!.statements, [{
    statementKey: "2026-07-23",
    cycleStart: "2026-06-24",
    cycleEnd: "2026-07-23",
    closingDate: "2026-07-23",
    dueDate: "2026-08-07",
    amount: "2000",
    currency: "TWD",
    minimumPayment: "500",
    billingPeriod: "2026-07",
    paidAmount: "0",
    paid: false,
    noPaymentNeeded: false,
  }]);
  assert.equal(jpy!.statements[0]!.noPaymentNeeded, true);
  assert.equal(jpy!.statements[0]!.paid, null);

  assert.deepEqual(twd!.cards.map((card) => [card.sourceCardKey, card.cardMask]), [["1234", "****1234"], ["5678", "****5678"]]);
  assert.deepEqual(twd!.purchases.map((row) => [row.posting.status, row.amount, row.direction, row.sourceCardKey, row.consumedAt.value]), [
    ["pending", "120", "unknown", "1234", "2026-09-23T12:30:00"],
    ["posted", "1500", "outflow", "5678", "2026-09-22"],
    ["posted", "88", "inflow", "5678", "2026-09-20"],
  ]);
  assert.deepEqual(twd!.purchases[1]!.posting, { status: "posted", billing: "unbilled", postingDate: "2026-09-24" });
  assert.equal(usd!.purchases[0]!.amount, "12.50");
});

test("SinoPac card collection observes every response and signs in to SinoCard with the SSO customer id", async () => {
  const { observations, calls } = await collect();
  assert.deepEqual(observations.map((item) => item.endpoint), [
    SINOPAC_CARD_SUMMARY_PATH, SINOCARD_SSO_PATH, SINOCARD_AUTH_PATH,
    SINOCARD_LATEST_TX_PATH, SINOCARD_OUTSTANDING_PATH, SINOCARD_ACCOUNTING_PATH,
  ]);
  assert.equal(calls[1]!.userId, null);
  assert.ok(calls.slice(2).every((call) => call.userId === "SYNTHETIC-ID"));
});

test("SinoPac card row keys stay stable across collections and count identical rows", async () => {
  const twice = edit((source) => {
    const detail = source[SINOCARD_OUTSTANDING_PATH].Result.Detail;
    detail.push({ ...detail[0] });
    source[SINOCARD_OUTSTANDING_PATH].Result.SubTotal[0] = { CurrencyCode: "000", SubTotalAmt: "2,912", Count: 3 };
  });
  const first = (await written(twice)).accounts[0]!.purchases.map((row) => row.sourceRowKey);
  const second = (await written(twice)).accounts[0]!.purchases.map((row) => row.sourceRowKey);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
  assert.ok(first.some((key) => key.endsWith("#2")));
});

test("SinoPac posted purchases fall back to unknown direction unless both signs and no zero are present", async () => {
  const oneSign = await written(edit((source) => {
    source[SINOCARD_OUTSTANDING_PATH].Result.Detail[1].AMT = "88";
    source[SINOCARD_OUTSTANDING_PATH].Result.SubTotal[0].SubTotalAmt = "1588";
  }));
  assert.ok(oneSign.accounts.flatMap((account) => account.purchases).every((row) => row.direction === "unknown"));

  const withZero = await written(edit((source) => {
    source[SINOCARD_OUTSTANDING_PATH].Result.Detail.push({ CurrencyCode: "000", CardLast4: "5678", TXDATE: "2026/09/21", MEMO: "調整", AMT: "0" });
    source[SINOCARD_OUTSTANDING_PATH].Result.SubTotal[0].Count = 3;
  }));
  const twd = withZero.accounts[0]!.purchases;
  assert.ok(twd.every((row) => row.direction === "unknown"));
  assert.deepEqual(twd.filter((row) => row.posting.status === "posted").map((row) => row.amount), ["1500", "-88"]);
});

test("SinoPac card collection fails before write on a missing currency", async () => {
  assert.equal(await failure(edit((source) => { delete source[SINOCARD_OUTSTANDING_PATH].Result.Detail[2].CurrencyCode; })), "missing-currency");
  assert.equal(await failure(edit((source) => { source[SINOCARD_ACCOUNTING_PATH].Result.BillAmounts[1].CurrencyCode = "999"; })), "missing-currency");
});

test("SinoPac card collection fails before write on a malformed amount", async () => {
  assert.equal(await failure(edit((source) => { source[SINOCARD_OUTSTANDING_PATH].Result.Detail[0].AMT = "1,5x0"; })), "malformed-amount");
  assert.equal(await failure(edit((source) => { source[SINOCARD_LATEST_TX_PATH].Result.Items[0].AuthAmt = ""; })), "malformed-amount");
});

test("SinoPac card collection fails before write on a missing balance operand", async () => {
  assert.equal(await failure(edit((source) => { delete source[SINOCARD_ACCOUNTING_PATH].Result.BillAmounts[0].TotalPaymentAmt; })), "malformed-amount");
  assert.equal(await failure(edit((source) => { delete source[SINOCARD_ACCOUNTING_PATH].Result.BillAmounts[0].CURRBAL; })), "malformed-amount");
  assert.equal(await failure(edit((source) => { source[SINOCARD_OUTSTANDING_PATH].Result.SubTotal[1].SubTotalAmt = "n/a"; })), "malformed-amount");
});

test("SinoPac card collection fails before write on an incomplete list", async () => {
  assert.equal(await failure(edit((source) => { source[SINOCARD_OUTSTANDING_PATH].Result.SubTotal[0].Count = 3; })), "incomplete-data");
  assert.equal(await failure(edit((source) => { source[SINOCARD_OUTSTANDING_PATH].Result.SubTotal.splice(1, 1); })), "incomplete-data");
  assert.equal(await failure(edit((source) => { delete source[SINOCARD_LATEST_TX_PATH].Result.Items; })), "unexpected-response");
  assert.equal(await failure(edit((source) => { delete source[SINOCARD_OUTSTANDING_PATH].Result.SubTotal; })), "unexpected-response");
});

test("SinoPac reports not_held only on an explicit no-card message", async () => {
  const noCardSummary = await collect(edit((source) => {
    source[SINOPAC_CARD_SUMMARY_PATH] = [{ Header: "FAIL", Message: "您目前沒有本行信用卡。" }];
  }));
  assert.deepEqual(noCardSummary.result, { absent: "not_held" });
  assert.equal(noCardSummary.calls.length, 1, "no SinoCard request after the no-card summary");

  assert.deepEqual((await collect(edit((source) => {
    source[SINOCARD_LATEST_TX_PATH] = { ResultCode: "99", ResultMessage: "沒有有效卡" };
  }))).result, { absent: "not_held" });

  assert.deepEqual((await collect(edit((source) => {
    source[SINOCARD_LATEST_TX_PATH].Result.Items = [];
    source[SINOCARD_OUTSTANDING_PATH].Result = { Detail: [], SubTotal: [] };
    source[SINOCARD_ACCOUNTING_PATH].Result.BillAmounts = [];
  }))).result, { absent: "no_data" }, "a card holder with no activity is no_data, not not_held");

  assert.equal(await failure(edit((source) => { source[SINOPAC_CARD_SUMMARY_PATH] = [{ Header: "EXCEPTION", Message: "系統忙線中，請稍後再試" }]; })), "unexpected-response");
  assert.equal(await failure(edit((source) => { source[SINOCARD_LATEST_TX_PATH] = { ResultCode: "99", ResultMessage: "查無資料" }; })), "unexpected-response");
});

test("SinoPac card collection treats a signed-out MMA session as a session loss", async () => {
  assert.equal(await failure(edit((source) => {
    source[SINOPAC_CARD_SUMMARY_PATH] = [{ SubInfo: null, Header: "TIMEOUT", Message: "您尚未登入網銀" }];
  })), "session-conflict");
});

test("SinoPac card collection refuses an authorization that was not approved", async () => {
  assert.equal(await failure(edit((source) => { source[SINOCARD_LATEST_TX_PATH].Result.Items[0].AuthResult = "N"; })), "unexpected-response");
});

test("SinoPac card statements are not written when the due date is only a status text", async () => {
  const collection = await written(edit((source) => { source[SINOCARD_ACCOUNTING_PATH].Result.BaseData.DUEDATE = "自動扣繳"; }));
  assert.deepEqual(collection.accounts[0]!.statements, []);
  assert.equal(collection.accounts[0]!.balances[0]!.amount, "3412");
});

const accountId = ["1410", "1800", "0822", "21"].join("");

function signedInPage(): Page {
  return {
    url: () => "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx",
    locator: (selector: string) => ({ isVisible: async () => selector.includes("user-logout"), waitFor: async () => undefined, first() { return this; } }),
  } as unknown as Page;
}

function workflowContext(writes: PreviewWrite[], commits: unknown[][]): WorkflowContextWith<"financialCommit", "previewWrite"> {
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      commits.push(received);
      return {
        status: "completed",
        items: received.map((item) => ({
          itemKey: item.itemKey, provider: item.provider, product: item.product, status: "committed" as const,
          admissionSummaries: [], value: null, relationWarnings: [],
        })),
        diagnostics: [], committedCount: received.length, failedCount: 0,
      };
    },
  };
  return {
    runId: "sinopac-card-check",
    signal: new AbortController().signal,
    now: () => COLLECTED_AT,
    browser: { withPage: async (run) => await run(signedInPage()) },
    text: strictSourceText,
    humanAssistance: { request: async () => "entered" },
    financialCommit,
    previewWrite: {
      async write(input) {
        if (input.product === "credit_card") parsePreviewCreditCollection(input.collection);
        writes.push(input);
        return previewReceipt(input);
      },
    },
    event: async () => undefined,
    signalEvent: async () => undefined,
  };
}

const workflowInput = (selection: Readonly<{ statementTypes: string[]; attachedPreviewProducts: string[] }>) => ({
  credentials: { sinopac_user_id: "synthetic-user", sinopac_account: "synthetic-account", sinopac_password: "synthetic-password" },
  startDate: "20260903",
  endDate: "20260903",
  ...selection,
});

const verifiedOverrides = {
  readAccounts: async () => [{ DataText: "Synthetic TWD account", DataValue: accountId, DisplayText: "TWD" }],
  queryTransactions: async () => ({
    Header: "SUCCESS",
    SubInfo: [{ DataText1: "2026/09/03 09:21", DataText2: "2026/09/03", DataText3: "Synthetic salary", DataText4: "-100", DataText5: "900", DataText7: "", DataText8: "" }],
  }),
  readCurrentDepositBalances: async () => [],
};

test("the SinoPac workflow writes attached cards only through the preview port, after its verified commit", async () => {
  const writes: PreviewWrite[] = [];
  const commits: unknown[][] = [];
  const { transport } = fakeTransport(bodies());
  const output = await runSinopacProviderWorkflow(
    workflowContext(writes, commits),
    workflowInput({ statementTypes: ["deposit"], attachedPreviewProducts: ["credit_card"] }),
    { ...verifiedOverrides, cardTransport: transport },
  );
  assert.equal(output.status, "financial-admitted");
  assert.equal(commits.length, 1);
  assert.ok(commits[0]!.every((item) => (item as { provider: string }).provider === "sinopac"));
  assert.deepEqual(writes.map((write) => [write.sourceId, write.institution, write.product]), [["sinopac", "sinopac", "credit_card"]]);
  assert.deepEqual(output.products, [
    { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
    { typeId: "credit_card", status: "success", itemCount: 3, committedCount: 3 },
  ]);
  const lateCancellation = interruptedProductCollectionFromOutput(output)!;
  assert.equal(lateCancellation.summary.sourceCaptureCount, 1);
  assert.equal(lateCancellation.summary.itemCount, 4);
  assert.equal(lateCancellation.summary.committedCount, 4);
  assert.deepEqual(lateCancellation.summary, output.productCollectionSummary);
});

test("a failing attached card product leaves the verified SinoPac result intact", async () => {
  const writes: PreviewWrite[] = [];
  const commits: unknown[][] = [];
  const { transport } = fakeTransport(edit((source) => { source[SINOCARD_OUTSTANDING_PATH].Result.Detail[0].AMT = "bad"; }));
  const output = await runSinopacProviderWorkflow(
    workflowContext(writes, commits),
    workflowInput({ statementTypes: ["deposit"], attachedPreviewProducts: ["credit_card"] }),
    { ...verifiedOverrides, cardTransport: transport },
  );
  assert.equal(output.status, "partial");
  assert.equal(output.rowCount, 1);
  assert.equal(commits.length, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(output.products, [
    { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
    { typeId: "credit_card", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-validation-failed" },
  ]);
});

test("an attached-only SinoPac selection signs in, commits nothing canonical, and collects the cards", async () => {
  const writes: PreviewWrite[] = [];
  const commits: unknown[][] = [];
  const { transport } = fakeTransport(bodies());
  const output = await runSinopacProviderWorkflow(
    workflowContext(writes, commits),
    workflowInput({ statementTypes: [], attachedPreviewProducts: ["credit_card"] }),
    { cardTransport: transport },
  );
  assert.deepEqual(commits, []);
  assert.equal(writes.length, 1);
  assert.equal(output.status, "completed");
  assert.equal(output.products?.[0]?.skipReason, "not_selected");
  assert.equal(output.products?.[1]?.status, "success");

  const { transport: failing } = fakeTransport(edit((source) => { source[SINOCARD_OUTSTANDING_PATH].Result.Detail[0].AMT = "bad"; }));
  await assert.rejects(runSinopacProviderWorkflow(
    workflowContext([], []),
    workflowInput({ statementTypes: [], attachedPreviewProducts: ["credit_card"] }),
    { cardTransport: failing },
  ), PreviewSourceFailure);
});

test("the SinoPac workflow collects no attached product when none is selected", async () => {
  const writes: PreviewWrite[] = [];
  const commits: unknown[][] = [];
  const { transport, calls } = fakeTransport(bodies());
  const output = await runSinopacProviderWorkflow(
    workflowContext(writes, commits),
    workflowInput({ statementTypes: ["deposit"], attachedPreviewProducts: [] }),
    { ...verifiedOverrides, cardTransport: transport },
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(output.products, [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }]);
});

test("a session loss during the attached card product ends the SinoPac run after the verified commit", async () => {
  const commits: unknown[][] = [];
  const { transport } = fakeTransport(edit((source) => {
    source[SINOPAC_CARD_SUMMARY_PATH] = [{ SubInfo: null, Header: "TIMEOUT", Message: "您尚未登入網銀" }];
  }));
  await assert.rejects(runSinopacProviderWorkflow(
    workflowContext([], commits),
    workflowInput({ statementTypes: ["deposit"], attachedPreviewProducts: ["credit_card"] }),
    { ...verifiedOverrides, cardTransport: transport },
  ), (error) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "authentication-failed");
    assert.equal(error.summary.sourceCaptureCount, 1);
    assert.equal(error.summary.rowCount, 1);
    assert.equal(error.summary.itemCount, 1);
    assert.equal(error.summary.committedCount, 1);
    assert.equal(error.summary.status, "partial");
    assert.deepEqual(error.summary.products[0], { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 });
    return true;
  });
  assert.equal(commits.length, 1);
});

for (const timing of ["after verified commit", "after attached write"] as const) {
  test(`SinoPac cancellation ${timing} preserves all completed writes`, async () => {
    const controller = new AbortController();
    const writes: PreviewWrite[] = [];
    const commits: unknown[][] = [];
    const base = workflowContext(writes, commits);
    const context: WorkflowContextWith<"financialCommit", "previewWrite"> = {
      ...base,
      signal: controller.signal,
      financialCommit: {
        async execute(items, options) {
          const result = await base.financialCommit!.execute(items, options);
          if (timing === "after verified commit") controller.abort();
          return result;
        },
      },
      previewWrite: {
        async write(input) {
          const receipt = await base.previewWrite!.write(input);
          if (timing === "after attached write") controller.abort();
          return receipt;
        },
      },
    };
    const { transport, calls } = fakeTransport(bodies());
    await assert.rejects(runSinopacProviderWorkflow(
      context,
      workflowInput({ statementTypes: ["deposit"], attachedPreviewProducts: ["credit_card"] }),
      { ...verifiedOverrides, cardTransport: transport },
    ), (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "cancelled");
      assert.equal(error.summary.sourceCaptureCount, 1);
      assert.equal(error.summary.committedCount, timing === "after verified commit" ? 1 : 4);
      assert.equal(error.summary.products[0]?.status, "success");
      assert.deepEqual(
        error.summary.products.map((product) => [product.typeId, product.status]),
        timing === "after verified commit"
          ? [["deposit", "success"]]
          : [["deposit", "success"], ["credit_card", "success"]],
        "a cancellation before the attached products reports only the verified outcome",
      );
      return true;
    });
    assert.equal(commits.length, 1);
    assert.equal(writes.length, timing === "after verified commit" ? 0 : 1);
    if (timing === "after verified commit") assert.deepEqual(calls, []);
  });
}

test("a refused SinoPac verified commit names the run collection-scope-changed and skips the attached cards", async () => {
  const writes: PreviewWrite[] = [];
  const context: WorkflowContextWith<"financialCommit", "previewWrite"> = {
    ...workflowContext(writes, []),
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
  const { transport, calls } = fakeTransport(bodies());
  await assert.rejects(runSinopacProviderWorkflow(
    context,
    workflowInput({ statementTypes: ["deposit"], attachedPreviewProducts: ["credit_card"] }),
    { ...verifiedOverrides, cardTransport: transport },
  ), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "collection-scope-changed");
    assert.deepEqual(error.summary.products, [
      { typeId: "deposit", status: "failed", itemCount: 1, committedCount: 0, errorCode: "collection-scope-changed" },
    ]);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
});

test("a recoverable SinoPac verified failure still collects the attached cards", async () => {
  const writes: PreviewWrite[] = [];
  const commits: unknown[][] = [];
  const { transport } = fakeTransport(bodies());
  const output = await runSinopacProviderWorkflow(
    workflowContext(writes, commits),
    workflowInput({ statementTypes: ["deposit"], attachedPreviewProducts: ["credit_card"] }),
    {
      ...verifiedOverrides,
      queryTransactions: async () => ({ Header: "SUCCESS", SubInfo: [] }),
      cardTransport: transport,
    },
  );
  assert.deepEqual(commits, []);
  assert.deepEqual(writes.map((write) => write.product), ["credit_card"]);
  assert.equal(output.status, "partial");
  assert.equal(output.rowCount, 0);
  assert.deepEqual(output.products, [
    { typeId: "deposit", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-validation-failed" },
    { typeId: "credit_card", status: "success", itemCount: 3, committedCount: 3 },
  ]);
});
