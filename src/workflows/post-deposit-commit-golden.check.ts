import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { ProductCollectionInterruptedError } from "../lib/automation/product-collection.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { assertDepositCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";
import type { PostCurrentDepositBalanceRow } from "./post-current-deposit-balances.ts";
import {
  parsePostStatementResponse,
  runPostProviderWorkflow,
  stagePostDeposit,
  type PostQueriedStatement,
  type PostRawStatementRow,
} from "./post-statements.ts";

const accountA = "99990000000001";
const accountB = "99990000000002";
const fixedNow = "2026-09-25T12:00:00.000Z";

const input = {
  credentials: {
    post_user_id: "synthetic-user-id",
    post_account: "synthetic-user-account",
    post_password: "synthetic-password",
  },
  statementTypes: ["deposit"],
};

function signedInPage(): Page {
  return {
    on: () => undefined,
    off: () => undefined,
    goto: async () => undefined,
    locator: (selector: string) => ({
      first() { return this; },
      isVisible: async () => selector === "a.btn_td_orange_dtl:visible",
    }),
    url: () => "https://ipost.post.gov.tw/pst/home.html",
  } as unknown as Page;
}

function raw(date: string, time: string, memo: string, flag: "+" | "-", amount: string, balance: string): PostRawStatementRow {
  return { PRS_DATE: date, TX_TIME: time, MEM: memo, ATTACH_COMMENT: "synthetic note", TX_AMT: amount, BAL_AMT: balance, DR_FLG: flag };
}

function statement(accountId: string, items: PostRawStatementRow[] | undefined): PostQueriedStatement {
  const screen = {
    header: { EndBracket: false, OutputType: "Screen" },
    body: items === undefined ? {} : { host_rs_1: { ITEM: items } },
  };
  const end = { header: { EndBracket: false, OutputType: "EndBracket" }, body: { result: "success" } };
  return parsePostStatementResponse({
    bytes: new TextEncoder().encode(JSON.stringify([screen, end])),
    response: {
      url: "https://ipost.post.gov.tw/pst/EsoafDispatcher",
      status: 200,
      method: "POST",
      contentType: "application/json; charset=UTF-8",
      requestPostData: JSON.stringify({
        header: { TxnCode: "EB100200", BizCode: "inquire" },
        body: { _USER_ID: accountId, DATE: "20260301", END_DATE: "20260924" },
      }),
    },
    text: strictSourceText,
  });
}

function currentBalance(accountId: string, coefficient: string): PostCurrentDepositBalanceRow {
  return {
    source: "post",
    stream: "domestic-deposit",
    accountNumber: accountId,
    sourceAccountKey: accountId,
    currency: "TWD",
    ledger: { coefficient, scale: 0, sourceLexeme: coefficient },
    effectiveAt: "2026-09-25T11:59:00.000Z",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    effectiveTimeSourceValue: "Fri, 25 Sep 2026 11:59:00 GMT",
    providerHttpDate: "Fri, 25 Sep 2026 11:59:00 GMT",
    observedAt: "2026-09-25T20:00:00+08:00",
    sourceEvidence: {
      endpoint: "/pst/EsoafDispatcher",
      status: 200,
      contentType: "application/json; charset=UTF-8",
      cacheControl: "no-store",
      txnCode: "EB100103",
      bizCode: "getOverViewById",
      pageCount: 50,
      contractVersion: "post/current-deposit-balance-v1",
    },
  };
}

async function run(
  t: test.TestContext,
  statements: PostQueriedStatement[],
  balances: readonly PostCurrentDepositBalanceRow[],
) {
  // The Post capture ID embeds Date.now(); pin it so the golden is stable.
  t.mock.method(Date, "now", () => Date.parse(fixedNow));
  const recorder = recordDepositCommit();
  let balanceReads = 0;
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "run-post-golden",
    signal: new AbortController().signal,
    now: () => fixedNow,
    browser: { withPage: async (body) => body(signedInPage()) },
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
  let error: string | null = null;
  let errorCode: string | null = null;
  const output = await runPostProviderWorkflow(context, input, {
    collectDeposit: async (_page, parsedInput, runContext, product) => await stagePostDeposit(
      { observedAt: "2026-09-25T20:00:00+08:00", statements },
      parsedInput,
      runContext,
      product,
      async () => {
        balanceReads += 1;
        return balances;
      },
    ),
  }).catch((caught: unknown) => {
    // The golden keeps the collector's own rejection, which the run carries as its cause.
    const original = caught instanceof ProductCollectionInterruptedError ? caught.cause : caught;
    if (caught instanceof ProductCollectionInterruptedError) errorCode = caught.errorCode;
    error = original instanceof Error ? original.message : String(original);
    return null;
  });
  return { output, error, errorCode, balanceReads, recorded: recorder.recorded() };
}

test("Post two accounts with inflow and outflow rows and matched current balances", async (t) => {
  const result = await run(t, [
    statement(accountA, [
      raw("20260803", "090807", "Synthetic salary", "+", "1,234", "5,678"),
      raw("20260815", "130000", "Synthetic rent", "-", "800", "4,878"),
    ]),
    statement(accountB, [
      raw("20260720", "080000", "Synthetic card payment", "-", "300", "700"),
      raw("20260921", "183045", "Synthetic refund", "+", "50", "750"),
    ]),
  ], [currentBalance(accountA, "4878"), currentBalance(accountB, "750")]);
  assert.equal(result.error, null);
  assert.equal(result.output?.status, "financial-admitted");
  assert.equal(result.balanceReads, 1);
  await assertDepositCommitGolden("post-two-accounts-inflow-outflow-balances", result.recorded);
});

test("Post current balance rows cover only some admitted accounts", async (t) => {
  const result = await run(t, [
    statement(accountA, [raw("20260803", "090807", "Synthetic salary", "+", "1,234", "5,678")]),
    statement(accountB, [raw("20260720", "080000", "Synthetic card payment", "-", "300", "700")]),
  ], [currentBalance(accountB, "700")]);
  assert.equal(result.error, null);
  assert.equal(result.output?.status, "financial-admitted");
  await assertDepositCommitGolden("post-partial-current-balances", result.recorded);
});

test("Post empty capture is rejected at source admission, not committed source-only", async (t) => {
  const result = await run(t, [
    statement(accountA, [raw("20260803", "090807", "Synthetic salary", "+", "1,234", "5,678")]),
    statement(accountB, undefined),
  ], [currentBalance(accountA, "5678")]);
  assert.match(result.error ?? "", /source admission blocked/u);
  assert.equal(result.errorCode, "source-collection-failed");
  await assertDepositCommitGolden("post-empty-capture-rejected", { error: result.error, ...result.recorded });
});

test("Post unknown-direction row is rejected because row-direction-unknown never arrives alone", async (t) => {
  const known = statement(accountA, [raw("20260803", "090807", "Synthetic salary", "+", "1,234", "5,678")]);
  const unknown: PostQueriedStatement = {
    ...statement(accountB, [raw("20260720", "080000", "Synthetic adjustment", "+", "1", "700")]),
  };
  unknown.rows = unknown.rows.map((row) => ({
    ...row,
    directionFlag: "unknown",
    values: row.values.map((value, index) => index === 5 ? "" : value),
  }));
  const result = await run(t, [known, unknown], [currentBalance(accountA, "5678")]);
  assert.match(result.error ?? "", /financial admission failed: .*row-direction-unknown/u);
  assert.equal(result.errorCode, "source-collection-failed");
  await assertDepositCommitGolden("post-unknown-direction-rejected", { error: result.error, ...result.recorded });
});
