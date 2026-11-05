import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { withBoundProducts } from "../lib/automation/product-collection.fixtures.ts";
import { LINEBANK_SOURCE } from "../lib/automation/server/sources/linebank.ts";
import { runVerifiedEntry } from "../lib/automation/server/verified-entry.ts";
import { assertDepositCommitGolden, recordDepositCommit, withCountedUuids } from "./deposit-commit-golden.ts";
import {
  linebankEpochMillisecondsFromSourceDateTime,
  lineBankWorkflow,
  type LineBankAccount,
  type LineBankTransactionRow,
  type LineBankTransactionsResponse,
} from "./linebank-statements.ts";

const accountA: LineBankAccount = {
  acctNbr: ["9990", "0000", "0001"].join(""),
  arrId: "arr-golden-a",
  acctNick: "Synthetic main",
  pdNm: "LINE Bank account",
  currCd: "TWD",
};
const accountB: LineBankAccount = {
  acctNbr: ["9990", "0000", "0002"].join(""),
  arrId: "arr-golden-b",
  acctNick: "Synthetic savings",
  pdNm: "LINE Bank account",
  currCd: "TWD",
};

const input = {
  credentials: {
    linebank_user_id: "synthetic-user-id",
    linebank_account: "synthetic-account",
    linebank_password: "synthetic-password",
  },
  accountFilters: [],
  currencyFilters: [],
  statementTypes: ["deposit"],
};

const headers = {
  date: "Fri, 25 Sep 2026 11:59:00 GMT",
  "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
  "content-type": "application/json;charset=UTF-8",
};

type Holding = Readonly<{
  account: LineBankAccount;
  /** The JSON token for wdrwAvblAmt, written into the body verbatim. */
  available: string;
  rows: readonly LineBankTransactionRow[];
}>;

function row(sequence: string, date: string, time: string, direction: "1" | "2", amount: string, balance: string, memo: string): LineBankTransactionRow {
  return {
    txSeqNbr: sequence,
    crrnDpstNthCnt: 1,
    txDt: date,
    txTm: time,
    txDtm: linebankEpochMillisecondsFromSourceDateTime(date, time),
    dpstWdrwDsCd: direction,
    txAmt: amount,
    afTxBal: balance,
    bizTxFuncTpNm: memo,
    cncdTxYn: "N",
    cnclTxYn: "N",
  };
}

function source(account: LineBankAccount, opnDtm: number) {
  return {
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
    opnDtm,
    jntMbrListCnt: 0,
    totJntAcctMbrCnt: 0,
    rcntTxfrListCnt: 0,
  };
}

function transactions(holding: Holding, opnDtm: number): LineBankTransactionsResponse {
  return {
    code: "200",
    content: {
      ...source(holding.account, opnDtm),
      pageNbr: 1,
      pageCnt: 1000,
      totTxCnt: holding.rows.length,
      txCnt: holding.rows.length,
      txLst: [...holding.rows],
    },
  };
}

function accountListBody(holdings: readonly Holding[]): string {
  const tokens = holdings.map((holding, index) => [`"available-${index}"`, holding.available] as const);
  const body = JSON.stringify({
    code: "200",
    message: "success",
    content: {
      dpstAcctList: holdings.map((holding, index) => ({ ...holding.account, wdrwAvblAmt: `available-${index}` })),
    },
  });
  return tokens.reduce((text, [placeholder, token]) => text.replace(placeholder, token), body);
}

function signedInPage(holdings: readonly Holding[]): Page {
  const locator = (selector: string) => ({
    first() { return this; },
    last() { return this; },
    nth() { return this; },
    filter() { return this; },
    async count() { return selector === "#account-dropdown" ? 1 : 0; },
    async isVisible() { return selector === "#account-dropdown" || selector === "body"; },
    async waitFor() { return undefined; },
    async click() { return undefined; },
  });
  const noNotice = {
    async count() { return 0; },
    nth() { return noNotice; },
    async isVisible() { return false; },
    async waitFor() { return undefined; },
  };
  return {
    url: () => "https://accessibility.linebank.com.tw/transaction",
    locator,
    getByRole: (role: string) => role === "alertdialog" ? noNotice : locator(role),
    on: () => undefined,
    off: () => undefined,
    async goto() { return undefined; },
    async waitForURL() { return undefined; },
    async evaluate(_expression: unknown, argument: { path: string; body?: { acctNbr?: string } }) {
      const isAccountList = argument.path.includes("/v1/account/common/payables");
      let body: string;
      if (isAccountList) {
        body = accountListBody(holdings);
      } else {
        const index = holdings.findIndex((holding) => holding.account.acctNbr === argument.body?.acctNbr);
        assert.ok(index >= 0, "transaction query names a listed account");
        body = JSON.stringify(transactions(holdings[index]!, 1_700_000_000_000 + index));
      }
      return {
        bodyBytes: [...new TextEncoder().encode(body)],
        url: isAccountList
          ? "https://accessibility.linebank.com.tw/v1/account/common/payables?featureTypeCode=01"
          : "https://accessibility.linebank.com.tw/v1/account/history/transactions",
        status: 200,
        method: isAccountList ? "GET" : "POST",
        headers,
      };
    },
  } as unknown as Page;
}


type RunOptions = Readonly<{
  now?: () => string;
  /** Called on each transaction-history request, after the account list was read. */
  onTransactionQuery?: () => void;
}>;

async function run(holdings: readonly Holding[], options: RunOptions = {}) {
  return withCountedUuids(() => runWithCountedUuids(holdings, options));
}

async function runWithCountedUuids(holdings: readonly Holding[], options: RunOptions) {
  const recorder = recordDepositCommit();
  const page = signedInPage(holdings);
  const evaluate = page.evaluate.bind(page) as (expression: unknown, argument: { path: string }) => Promise<unknown>;
  Object.assign(page, {
    evaluate: async (expression: unknown, argument: { path: string }) => {
      if (!argument.path.includes("/v1/account/common/payables")) options.onTransactionQuery?.();
      return await evaluate(expression, argument);
    },
  });
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "run-linebank-golden",
    signal: new AbortController().signal,
    now: options.now ?? (() => "2026-09-25T12:00:00.000Z"),
    browser: { withPage: async (body) => body(page) },
    text: strictSourceText,
    verification: {
      async complete() {
        throw new Error("A signed-in synthetic session needs no assistance.");
      },
    },
    financialCommit: recorder.financialCommit,
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
  const output = await runVerifiedEntry(LINEBANK_SOURCE, lineBankWorkflow, withBoundProducts(context, LINEBANK_SOURCE, input), input);
  return { output, recorded: recorder.recorded() };
}

test("LINE Bank two accounts with inflow and outflow rows and matched current balances", async () => {
  const result = await run([
    {
      account: accountA,
      available: `"5,000.00"`,
      rows: [
        row("101", "20260703", "090807", "1", "1234.00", "5678.00", "Synthetic salary"),
        row("102", "20260715", "130000", "2", "678.00", "5000.00", "Synthetic rent"),
      ],
    },
    {
      account: accountB,
      available: "750.50",
      rows: [row("201", "20260820", "080000", "2", "300.00", "750.50", "Synthetic card payment")],
    },
  ]);
  assert.equal(result.output.status, "financial-admitted");
  await assertDepositCommitGolden("linebank-two-accounts-inflow-outflow-balances", result.recorded);
});

test("LINE Bank account with no transactions commits beside a financial account", async () => {
  const result = await run([
    {
      account: accountA,
      available: `"5600"`,
      rows: [row("101", "20260809", "112233", "1", "78.00", "5600.00", "Synthetic transfer")],
    },
    { account: accountB, available: "0", rows: [] },
  ]);
  assert.equal(result.output.status, "financial-admitted");
  await assertDepositCommitGolden("linebank-no-data-account", result.recorded);
});

test("LINE Bank balances carry the time the account list was read, not the time they stage", async () => {
  let now = "2026-09-25T12:00:00.000Z";
  const result = await run([
    { account: accountA, available: `"5600"`, rows: [row("101", "20260809", "112233", "1", "78.00", "5600.00", "Synthetic transfer")] },
  ], {
    now: () => now,
    onTransactionQuery: () => {
      now = "2026-09-25T13:00:00.000Z";
    },
  });
  assert.equal(result.output.status, "financial-admitted");
  const recorded = JSON.stringify(result.recorded);
  assert.match(recorded, /"observedAt":"2026-09-25T20:00:00\+08:00"/u);
  assert.doesNotMatch(recorded, /2026-09-25T21:00:00\+08:00/u);
});
