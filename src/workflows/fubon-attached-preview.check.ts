import assert from "node:assert/strict";
import test, { after } from "node:test";
import { chromium, type Page } from "playwright";
import { parsePreviewWrite, type PreviewDepositCollection, type PreviewWrite } from "../ledger/pglite/preview-financial-data.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { withBoundProducts } from "../lib/automation/product-collection.fixtures.ts";
import { FUBON_SOURCE } from "../lib/automation/server/sources/fubon.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { previewReceipt } from "../lib/preview-sources/preview-source-harness.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { PreviewSourceFailure } from "../lib/preview-sources/source-kit.ts";
import { collectFubonForeignCurrency, type FubonAttachedPreviewPort } from "./fubon-attached-preview.ts";
import { runFubonAllStatementsWorkflow } from "./fubon-all-statements.ts";
import { playwrightFubonAttachedPreviewPort } from "./fubon-attached-preview-page.ts";
import {
  BALANCE_ROWS,
  balancePage,
  FUBON_BALANCE_PATH,
  FUBON_FX_DATE,
  FUBON_FX_NOW,
  FUBON_QUERY_PATH,
  homePage,
  QUERY_OPTIONS,
  queryPage,
  resultGrid,
  USD_NO,
  USD_ROWS,
  type BalanceRow,
  type QueryOption,
} from "./fubon-attached-preview.fixtures.ts";
import { FUBON_EBANK_ENTRY_URL } from "./fubon-ebank-site.ts";

const browser = await chromium.launch({ headless: true });
after(() => browser.close());

const ORIGIN = new URL(FUBON_EBANK_ENTRY_URL).origin;
const html = (body: string, headers: Record<string, string> = {}) => ({ contentType: "text/html; charset=utf-8", body, headers });

type Site = Readonly<{
  balances?: readonly BalanceRow[];
  options?: readonly QueryOption[];
  result?: (option: string, range: string) => string;
}>;

/** A signed-in frameset whose txnFrame serves 我的存款 and the CDSQU001 query, with every query post recorded. */
async function signedInPage(site: Site = {}): Promise<{ page: Page; posted: Array<{ option: string; range: string }> }> {
  const page = await browser.newPage();
  const posted: Array<{ option: string; range: string }> = [];
  const options = site.options ?? QUERY_OPTIONS;
  const result = site.result ?? ((option: string, range: string) =>
    resultGrid(option.includes(USD_NO) && range === "180" ? USD_ROWS : []));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === FUBON_QUERY_PATH && request.method() === "POST") {
      const body = new URLSearchParams(request.postData() ?? "");
      const option = body.get("form1:comboAccount") ?? "";
      const range = body.get("form1:rdoGroup3") ?? "";
      posted.push({ option, range });
      return await route.fulfill(html(queryPage(options, option, result(option, range))));
    }
    switch (pathname) {
      case "/B2C/common/Index.faces":
        return await route.fulfill(html(`<iframe name="frame1" src="/B2C/header.faces"></iframe><iframe name="txnFrame" src="/B2C/home.faces"></iframe>`));
      case "/B2C/home.faces":
        return await route.fulfill(html(homePage()));
      case FUBON_BALANCE_PATH:
        return await route.fulfill(html(balancePage(site.balances), { "cache-control": "no-store, no-cache", date: FUBON_FX_DATE }));
      case FUBON_QUERY_PATH:
        return await route.fulfill(html(queryPage(options, "", "")));
      default:
        return await route.fulfill(html(`<p>${pathname}</p>`));
    }
  });
  await page.goto(FUBON_EBANK_ENTRY_URL, { waitUntil: "load" });
  return { page, posted };
}

async function collect(site: Site = {}) {
  const { page, posted } = await signedInPage(site);
  try {
    const port = playwrightFubonAttachedPreviewPort(page, { signal: new AbortController().signal, text: strictSourceText, now: () => FUBON_FX_NOW });
    return { result: await collectFubonForeignCurrency(port, FUBON_FX_NOW), posted };
  } finally {
    await page.close();
  }
}

async function rejectsWith(site: Site, pattern: RegExp, reason?: PreviewSourceFailure["reason"]) {
  const { page } = await signedInPage(site);
  try {
    const port = playwrightFubonAttachedPreviewPort(page, { signal: new AbortController().signal, text: strictSourceText, now: () => FUBON_FX_NOW });
    await assert.rejects(collectFubonForeignCurrency(port, FUBON_FX_NOW), (error: unknown) =>
      pattern.test(String(error)) && (reason === undefined || (error instanceof PreviewSourceFailure && error.reason === reason)));
  } finally {
    await page.close();
  }
}

test("the USD demand row of 我的存款 becomes a foreign-currency account with its query rows in USD", async () => {
  const { result, posted } = await collect();
  assert.ok(!("absent" in result));
  const parsed = parsePreviewWrite({ sourceId: "fubon", institution: "fubon", product: "foreign_currency", collection: result });
  const collection = parsed.collection as PreviewDepositCollection;
  assert.deepEqual(collection.accounts.map(({ sourceAccountKey, displayLabel, currency }) => ({ sourceAccountKey, displayLabel, currency })), [
    { sourceAccountKey: `${USD_NO}:USD`, displayLabel: "台北富邦外幣活存 1098 (USD)", currency: "USD" },
  ], "the TWD row and the foreign time deposit are left out; the label shows only the last four digits");
  const [usd] = collection.accounts;
  const asOf = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  assert.deepEqual(usd!.balances, [
    { kind: "current", amount: "1300.00", currency: "USD", observedAt: asOf },
    { kind: "available", amount: "1250.00", currency: "USD", observedAt: asOf },
  ]);
  assert.deepEqual(usd!.transactions.map(({ amount, currency, direction, postedAt, description }) => ({ amount, currency, direction, postedAt, description })), [
    { amount: "1000.00", currency: "USD", direction: "inflow", postedAt: { precision: "second", value: "2026-10-02T09:10:11" }, description: "國外匯入" },
    { amount: "200.00", currency: "USD", direction: "outflow", postedAt: { precision: "second", value: "2026-10-05T10:00:00" }, description: "換匯 備註" },
  ], "the direction comes from the 支出 and 存入 columns, and the amounts keep the account's currency");
  assert.deepEqual(posted, [
    { option: QUERY_OPTIONS[1]!.value, range: "180" },
    { option: QUERY_OPTIONS[1]!.value, range: "180_365" },
  ], "only the USD option is queried, over the verified deposit product's two ranges");
});

test("no foreign demand row is not_held, and the query page is never opened", async () => {
  const { result, posted } = await collect({ balances: BALANCE_ROWS.filter((row) => row[4] === "臺幣") });
  assert.deepEqual(result, { absent: "not_held" });
  assert.deepEqual(posted, []);
});

test("a missing USD option, unknown columns, or rows that do not show the USD balance fail the product", async () => {
  await rejectsWith({ options: QUERY_OPTIONS.slice(0, 1) }, /no USD option for the account ending 1098/u, "incomplete-data");
  await rejectsWith({ result: () => resultGrid(USD_ROWS, ["日期", "時間", "說明", "提出", "存入", "餘額", "備註"]) }, /missing the result table/u);
  await rejectsWith(
    { result: (_option, range) => resultGrid(range === "180" ? [["2026/10/05", "10:00:00", "轉帳", "", "1", "5,000", ""]] : []) },
    /does not show its USD balance/u,
    "unexpected-response",
  );
  await rejectsWith(
    { result: (_option, range) => resultGrid(range === "180" ? [["2026/10/05", "10:00:00", "轉帳", "1", "2", "1,300.00", ""]] : []) },
    /exactly one nonzero/u,
    "unexpected-response",
  );
});

type RunContext = WorkflowContextWith<"financialCommit" | "accountIdentity", "previewWrite">;

function workflowHarness() {
  const committed: PGliteWorkflowRunItem[][] = [];
  const writes: PreviewWrite[] = [];
  const context: RunContext = {
    runId: "fubon-attached-check",
    signal: new AbortController().signal,
    now: () => FUBON_FX_NOW,
    browser: { withPage: async (run) => run({ context: () => ({ clearCookies: async () => undefined }) } as unknown as Page) },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    accountIdentity: { continuity: async () => ({ status: "unseen" }) },
    financialCommit: {
      execute: async (items: Iterable<PGliteWorkflowRunItem>) => {
        const batch = [...items];
        committed.push(batch);
        return {
          status: "completed" as const,
          items: batch.map((entry) => ({
            itemKey: entry.itemKey, provider: entry.provider, product: entry.product, status: "committed" as const,
            admissionSummaries: [], value: null, relationWarnings: [],
          })),
          diagnostics: [], committedCount: batch.length, failedCount: 0,
        };
      },
    },
    previewWrite: {
      async write(input) {
        writes.push(parsePreviewWrite(input));
        return previewReceipt(input);
      },
    },
    event: async () => undefined,
    signalEvent: async () => undefined,
  };
  return { context, committed, writes };
}

const workflowInput = (statementTypes: readonly string[], attachedPreviewProducts: readonly string[]) => ({
  managedIdentitySecret: "synthetic-managed-secret",
  statementTypes,
  attachedPreviewProducts,
  credentials: { fubon_user_id: "synthetic-id", fubon_account: "synthetic-code", fubon_password: "synthetic-password" },
});

const foreignPort = (calls: string[], fail = false): FubonAttachedPreviewPort => ({
  async balances() {
    calls.push("fx-balances");
    if (fail) throw new Error("the 我的存款 table did not load");
    return [];
  },
  async accountOptions() { throw new Error("no foreign row, so no query"); },
  async statement() { throw new Error("no foreign row, so no query"); },
});

async function runWorkflow(input: ReturnType<typeof workflowInput>, port: FubonAttachedPreviewPort, calls: string[]) {
  const harness = workflowHarness();
  const output = await runFubonAllStatementsWorkflow(withBoundProducts(harness.context, FUBON_SOURCE, input), input, {
    authenticate: async () => {
      calls.push("signed-in");
      return { assertSession: async () => { calls.push("session-checked"); } } as never;
    },
    startSessionKeepAlive: () => () => undefined,
    signOut: async () => { calls.push("signed-out"); },
    collectDeposit: async (_page, _input, _context, product) => {
      calls.push("deposit");
      product.stage({ product: "deposit", itemKey: "deposit-1", command: { kind: "financial.deposit.commit", request: {} } as never });
      return { sourceCaptureCount: 1, rowCount: 1 };
    },
    collectCreditCard: async () => { throw new Error("card must not run"); },
    collectLoan: async () => { throw new Error("loan must not run"); },
    attachedPreviewPort: () => port,
  });
  return { ...harness, output };
}

const outcomes = (products: readonly { typeId: string; status: string; skipReason?: string; errorCode?: string }[] | undefined) =>
  products?.map((product) => [product.typeId, product.status, product.skipReason ?? product.errorCode]);

test("a failing foreign-currency product leaves the verified deposit committed and runs after it", async () => {
  const calls: string[] = [];
  const { output, committed, writes } = await runWorkflow(workflowInput(["deposit"], ["foreign_currency"]), foreignPort(calls, true), calls);
  assert.deepEqual(outcomes(output.products), [
    ["deposit", "success", undefined],
    ["credit_card", "skipped", "not_selected"],
    ["loan", "skipped", "not_selected"],
    ["foreign_currency", "failed", "source-collection-failed"],
  ]);
  assert.equal(output.status, "partial");
  assert.equal(committed.length, 1, "the deposit commit stands");
  assert.deepEqual(writes, []);
  assert.ok(calls.indexOf("deposit") < calls.indexOf("fx-balances"), "the attached product runs after the verified products");
  assert.equal(calls.at(-1), "signed-out");
});

test("an attached-only selection signs in and collects only foreign currency; an empty selection collects none", async () => {
  const calls: string[] = [];
  const { output, committed } = await runWorkflow(workflowInput([], ["foreign_currency"]), foreignPort(calls), calls);
  assert.deepEqual(outcomes(output.products), [
    ["deposit", "skipped", "not_selected"],
    ["credit_card", "skipped", "not_selected"],
    ["loan", "skipped", "not_selected"],
    ["foreign_currency", "not_held", undefined],
  ]);
  assert.equal(committed.length, 0);
  assert.ok(!calls.includes("deposit"));
  const none: string[] = [];
  const verifiedOnly = await runWorkflow(workflowInput(["deposit"], []), foreignPort(none), none);
  assert.deepEqual(outcomes(verifiedOnly.output.products), [
    ["deposit", "success", undefined], ["credit_card", "skipped", "not_selected"], ["loan", "skipped", "not_selected"],
  ]);
  assert.ok(!none.includes("fx-balances"), "no attached product is collected without a selection");
  await assert.rejects(runWorkflow(workflowInput([], []), foreignPort([]), []), /missing or invalid/u, "an input with no product is refused");
});
