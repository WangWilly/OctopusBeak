import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Page } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { withBoundProducts } from "../lib/automation/product-collection.fixtures.ts";
import type { CollectionPeriod } from "../lib/automation/collection-period.ts";
import { HNCB_SOURCE } from "../lib/automation/server/sources/hncb.ts";
import {
  hncbCurrentDepositBalanceTable,
  readHncbDepositSource,
  runHncbStatements,
  stageHncbDeposit,
  type HncbDepositSource,
  type HncbStatementDownload,
} from "./hncb-statements.ts";
import {
  hncbCurrentDepositDetailRow,
  hncbCurrentDepositDetailTable,
} from "./hncb-current-deposit-balances.fixtures.ts";
import {
  assertDepositCommitGolden,
  recordDepositCommit,
} from "./deposit-commit-golden.ts";

// hncbWorkflow signs in to a real HNCB page before it reaches
// runHncbStatements, so the goldens enter at runHncbStatements. Its deposit
// runner reads a fake source through the real read half, then stages through
// the real build half: source admission, financial admission, current
// balance, and the commit.
const NOW = Date.parse("2026-09-01T04:00:00.000Z");
const accountA = ["9000", "0000", "0011"].join("");
const accountB = ["9000", "0000", "0022"].join("");
const input = { accountFilters: [] };
/** The goldens record one August query, which a period ending on the run's date cannot express. */
const august: CollectionPeriod = {
  start: "2026-08-01",
  end: "2026-08-31",
  windows: [{ start: "2026-08-01", end: "2026-08-31" }],
};

type Statement = HncbStatementDownload;
type CurrentCells = readonly (readonly string[])[];

function row(date: string, time: string, outflow: string, inflow: string, balance: string, memo: string): string[] {
  return [date, time, date, "TWD", outflow, inflow, balance, memo, "", "", ""];
}

function statement(account: string, rows: string[][]): Statement {
  return {
    account: `${account.slice(0, 6)}-${account.slice(6)}`,
    accountId: account,
    queryPeriod: "2026/08/01-2026/08/31",
    currency: "TWD",
    rows,
    filename: "synthetic-hncb.xls",
    byteLength: 64 * rows.length,
    contentDigest: `sha256:synthetic-${account}`,
  };
}

const overviewResponse = {
  url: "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt&time_str=20260901115930",
  status: 200,
  method: "GET",
  headers: {
    date: "Tue, 01 Sep 2026 03:59:00 GMT",
    "cache-control": "no-store",
    "content-type": "text/html; charset=big5",
  },
};

/** One 帳戶總覽 row with the blank currency HNCB shows for some accounts. */
function overviewRow(accountNumber: string, amount: string): readonly string[] {
  return [accountNumber, "活存", "", amount, amount, amount, "-", "餘額", "明細", "轉帳", "其他"];
}

type Account = Readonly<{ value: string; label: string; statement: Statement | null }>;

function source(accounts: readonly Account[]): HncbDepositSource {
  return {
    accounts: async () => accounts.map(({ value, label }) => ({ value, label })),
    query: async (account) => {
      const { statement } = accounts.find((candidate) => candidate.value === account.value)!;
      return statement && { download: async () => statement };
    },
  };
}

async function record(
  name: string,
  accounts: readonly Account[],
  current: Readonly<{ detail?: CurrentCells; overview?: CurrentCells }> = {},
): Promise<Record<string, unknown>> {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    const recorder = recordDepositCommit();
    const context = withBoundProducts({
      signal: new AbortController().signal,
      now: () => new Date().toISOString(),
      text: strictSourceText,
      event: recorder.event,
      financialCommit: recorder.financialCommit,
    } as Pick<WorkflowContext, "signal" | "now" | "text" | "event"> as WorkflowContextWith<"financialCommit">, HNCB_SOURCE, {
      statementTypes: ["deposit"],
    });
    const output = await runHncbStatements({} as Page, input, context, {
      collectDeposit: async (_page, depositInput, depositContext, bound) => {
        const product = { ...bound, collectionPeriod: () => august };
        return await stageHncbDeposit(
          await readHncbDepositSource(source(accounts), depositInput, depositContext, product),
          product,
          hncbCurrentDepositBalanceTable(
            async () => ({
              view: "overview",
              evidence: { kind: "cells", rows: current.overview ?? [] },
              response: overviewResponse,
            }),
            async () => hncbCurrentDepositDetailTable(current.detail ?? []),
          ),
        );
      },
    });
    const recorded = { output, ...recorder.recorded() };
    await assertDepositCommitGolden(name, recorded);
    return recorded;
  } finally {
    mock.timers.reset();
  }
}

function commandKinds(recorded: Record<string, unknown>): string[] {
  const [execution] = recorded.executions as Array<{ items: Array<{ command: { kind: string } }> }>;
  return execution!.items.map((item) => item.command.kind);
}

const accountARows = [
  row("2026/08/03", "09:10:00", "", "5000", "15000", "SYNTHETIC SALARY"),
  row("2026/08/05", "14:20:00", "1200", "", "13800", "SYNTHETIC RENT"),
];
const accountBRows = [
  row("2026/08/07", "10:00:00", "300", "", "2700", "SYNTHETIC FEE"),
  row("2026/08/09", "16:45:00", "", "800", "3500", "SYNTHETIC REFUND"),
];

test("HNCB golden: two accounts with inflow and outflow rows and matched current balances", async () => {
  const recorded = await record(
    "hncb-two-accounts-flows",
    [
      { value: accountA, label: `HNCB ${accountA}`, statement: statement(accountA, accountARows) },
      { value: accountB, label: `HNCB ${accountB}`, statement: statement(accountB, accountBRows) },
    ],
    { detail: [hncbCurrentDepositDetailRow(accountA, "13800.00", "13800.00"), hncbCurrentDepositDetailRow(accountB, "3500.00", "3400.00")] },
  );
  assert.equal((recorded.output as { status: string }).status, "financial-admitted");
  assert.equal(commandKinds(recorded).length, 4);
});

test("HNCB golden: an account with no data commits beside an admitted account", async () => {
  const recorded = await record(
    "hncb-no-data-account",
    [
      { value: accountA, label: `HNCB ${accountA}`, statement: statement(accountA, accountARows) },
      { value: accountB, label: accountB, statement: null },
    ],
    { detail: [hncbCurrentDepositDetailRow(accountA, "13800.00", "13800.00")] },
  );
  assert.equal(commandKinds(recorded).length, 3);
});

test("HNCB golden: a shared-account label falls back to a source-only commit", async () => {
  const recorded = await record(
    "hncb-shared-account-source-only",
    [
      { value: accountA, label: `HNCB ${accountA}`, statement: statement(accountA, accountARows) },
      { value: accountB, label: `HNCB 共同帳戶 ${accountB}`, statement: statement(accountB, accountBRows) },
    ],
    { detail: [hncbCurrentDepositDetailRow(accountA, "13800.00", "13800.00")] },
  );
  assert.equal(commandKinds(recorded).length, 3);
});

test("HNCB golden: account-overview current balances matched to admitted accounts", async () => {
  const recorded = await record(
    "hncb-overview-current-balance",
    [
      { value: accountA, label: `HNCB ${accountA}`, statement: statement(accountA, accountARows) },
      { value: accountB, label: `HNCB ${accountB}`, statement: statement(accountB, accountBRows) },
    ],
    { overview: [overviewRow(accountA, "13800.00"), overviewRow(accountB, "3500.00")] },
  );
  assert.equal(commandKinds(recorded).length, 4);
});

test("HNCB golden: accounts with no data and current balances are financial-admitted, not source-only", async () => {
  const recorded = await record(
    "hncb-no-data-accounts-with-balances",
    [
      { value: accountA, label: accountA, statement: null },
      { value: accountB, label: accountB, statement: null },
    ],
    { detail: [hncbCurrentDepositDetailRow(accountA, "13800.00", "13800.00"), hncbCurrentDepositDetailRow(accountB, "3500.00", "3400.00")] },
  );
  assert.equal((recorded.output as { status: string }).status, "financial-admitted",
    "zero-record deposit captures and current balances are financial data (ADR 0064)");
  assert.deepEqual(commandKinds(recorded), [
    "financial.deposit.commit",
    "financial.deposit.commit",
    "financial.balance.capture",
    "financial.balance.capture",
  ]);
});
