import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import {
  ctbcDetailRowsToStatementRows,
  ctbcResponseShape,
  runCtbcProviderWorkflow,
  type CtbcCollectedStatements,
  type CtbcDetailRow,
  type CtbcObservedAccountCapture,
  type CtbcObservedRangeResponse,
} from "./ctbc-statements.ts";
import { assertDepositCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";

const accountA = "999900000001";
const accountB = "999900000002";
const ranges = [
  { startDate: "2026/07/01", endDate: "2026/07/31" },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
] as const;

const input = {
  credentials: {
    ctbc_user_id: "synthetic-user",
    ctbc_account: "synthetic-account",
    ctbc_password: "synthetic-password",
  },
};

function signedInPage(): Page {
  return {
    on: () => undefined,
    off: () => undefined,
    locator: (selector: string) => ({
      isVisible: async () => selector === "#btnHeaderLogout",
    }),
  } as unknown as Page;
}

function detail(date: string, time: string, memo: string, outflow: string, inflow: string, balance: string): CtbcDetailRow {
  const dashed = date.replaceAll("/", "-");
  return {
    actDtFull: date,
    trnDtFull: date,
    actDtTm: `${dashed}-${time.replaceAll(":", ".")}.000000`,
    sortActDtTm: `${date.replaceAll("/", " ")} ${time} 000`,
    memo1: memo,
    memo2: "synthetic note",
    dbAmtDisplay: outflow,
    crAmtDisplay: inflow,
    balanceAmt: balance,
  };
}

function rangeResponse(rangeOrdinal: number, body: { code: "0000"; rsData: { detailList: CtbcDetailRow[]; nextKey: string } } | { code: "9201"; rsData: null }): CtbcObservedRangeResponse {
  const range = ranges[rangeOrdinal]!;
  return {
    rangeOrdinal,
    startDate: range.startDate,
    endDate: range.endDate,
    code: body.code,
    nextKey: null,
    terminal: true,
    rows: ctbcDetailRowsToStatementRows(body.rsData?.detailList ?? []),
    responseShape: ctbcResponseShape(body),
  };
}

function account(accountId: string, perRange: readonly (CtbcDetailRow[] | "no-data")[]): CtbcObservedAccountCapture {
  return {
    accountId,
    queryPeriods: ranges.map((range) => `${range.startDate}~${range.endDate}`),
    expectedRangeCount: ranges.length,
    responses: perRange.map((rows, rangeOrdinal) => rangeResponse(
      rangeOrdinal,
      rows === "no-data"
        ? { code: "9201", rsData: null }
        : { code: "0000", rsData: { detailList: rows, nextKey: "" } },
    )),
  };
}

function collected(captures: CtbcObservedAccountCapture[]): CtbcCollectedStatements {
  return {
    output: {
      count: captures.length,
      rowCount: captures.reduce((sum, capture) => sum + capture.responses.reduce((rows, response) => rows + response.rows.length, 0), 0),
    },
    captures,
  };
}

function currentBalance(accountId: string, coefficient: string) {
  return {
    source: "ctbc",
    stream: "domestic-deposit",
    accountNumber: accountId,
    sourceAccountKey: accountId,
    currency: "TWD",
    ledger: { coefficient, scale: 0, sourceLexeme: Number(coefficient).toLocaleString("en-US") },
    providerFields: {
      accountId,
      digiSvType: "",
      acctType: "01",
      accountNickName: "",
      openDt: "20200101",
      isRelaC: "N",
    },
    effectiveAt: "2026-09-25T11:59:00.000Z",
    providerServerTime: Date.parse("2026-09-25T11:59:00.000Z"),
    providerDataTime: "2026/09/25 19:59:00",
    providerHttpDate: "Fri, 25 Sep 2026 11:59:00 GMT",
    observedAt: "2026-09-25T20:00:00+08:00",
    sourceEvidence: {
      endpoint: "/IB/api/adapters/IB_Adapter/resource/ebmwResource",
      requestResource: "/twrbc-deposit/qu001/010",
      status: 200,
      cacheControl: "no-cache, no-store, must-revalidate",
      contractVersion: "ctbc/current-deposit-balance-v1",
    },
  } as const;
}

async function run(
  captures: CtbcObservedAccountCapture[],
  balances: readonly ReturnType<typeof currentBalance>[],
) {
  const recorder = recordDepositCommit();
  let balanceReads = 0;
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "run-ctbc-golden",
    signal: new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: { withPage: async (body) => body(signedInPage()) },
    text: strictSourceText,
    humanAssistance: {
      async request() {
        throw new Error("A signed-in synthetic session needs no assistance.");
      },
    },
    financialCommit: recorder.financialCommit,
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
  const output = await runCtbcProviderWorkflow(context, input, {
    collectStatements: async () => collected(captures),
    readCurrentDepositBalances: async () => {
      balanceReads += 1;
      return balances;
    },
  });
  return { output, balanceReads, recorded: recorder.recorded() };
}

test("CTBC two accounts with inflow and outflow rows and matched current balances", async () => {
  const result = await run([
    account(accountA, [
      [
        detail("2026/07/03", "09:08:07", "Synthetic salary", "0", "1,234", "5,678"),
        detail("2026/07/15", "13:00:00", "Synthetic rent", "800", "0", "4,878"),
      ],
      [detail("2026/08/02", "10:11:12", "Synthetic transfer", "0", "122", "5,000")],
    ]),
    account(accountB, [
      [detail("2026/07/20", "08:00:00", "Synthetic card payment", "300", "0", "700")],
      [detail("2026/08/21", "18:30:45", "Synthetic refund", "0", "50", "750")],
    ]),
  ], [currentBalance(accountA, "5000"), currentBalance(accountB, "750")]);
  assert.equal(result.output.status, "financial-admitted");
  assert.equal(result.balanceReads, 1);
  await assertDepositCommitGolden("ctbc-two-accounts-inflow-outflow-balances", result.recorded);
});

test("CTBC account with an empty capture commits source-only beside a financial account", async () => {
  const result = await run([
    account(accountA, [
      [detail("2026/07/03", "09:08:07", "Synthetic salary", "0", "1,234", "5,678")],
      [detail("2026/08/09", "11:22:33", "Synthetic utility", "78", "0", "5,600")],
    ]),
    account(accountB, [[], "no-data"]),
  ], [currentBalance(accountA, "5600")]);
  assert.equal(result.output.status, "financial-admitted");
  await assertDepositCommitGolden("ctbc-empty-account-source-only", result.recorded);
});

test("CTBC capture with only empty accounts commits source-only and skips current balance", async () => {
  const result = await run([
    account(accountA, [[], []]),
    account(accountB, ["no-data", "no-data"]),
  ], [currentBalance(accountA, "1")]);
  assert.equal(result.output.status, "source-only");
  assert.equal(result.balanceReads, 0);
  await assertDepositCommitGolden("ctbc-all-empty-source-only", result.recorded);
});
