import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Frame, Page } from "playwright";
import { runHncbStatements, type HncbStatementsRunDependencies } from "./hncb-statements.ts";
import {
  assertDepositCommitGolden,
  recordDepositCommit,
} from "./deposit-commit-golden.ts";

// runHncbProviderWorkflow drives a real HNCB page before it reaches
// runHncbStatements, so the goldens enter at runHncbStatements: it owns source
// admission, financial admission, current balance, and the commit.
const NOW = Date.parse("2026-09-01T04:00:00.000Z");
const accountA = ["9000", "0000", "0011"].join("");
const accountB = ["9000", "0000", "0022"].join("");
const input = { startDate: "2026/08/01", endDate: "2026/08/31", accountFilters: [] };

type Statement = Awaited<ReturnType<NonNullable<HncbStatementsRunDependencies["downloadStatement"]>>>;
type CurrentRows = Awaited<ReturnType<NonNullable<HncbStatementsRunDependencies["readCurrentDepositBalances"]>>>;
type OverviewRows = Awaited<ReturnType<NonNullable<HncbStatementsRunDependencies["readCurrentDepositOverviewBalances"]>>>;

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

function currentRow(accountNumber: string, ledger: string, available: string): CurrentRows[number] {
  return {
    source: "hncb",
    accountNumber,
    currency: "TWD",
    currencySourceLexeme: "TWD",
    available: { coefficient: available.replace(".", ""), scale: 2, sourceLexeme: available },
    ledger: { coefficient: ledger.replace(".", ""), scale: 2, sourceLexeme: ledger },
    effectiveAt: "2026-09-01T03:59:00.000Z",
    providerHttpDate: "Tue, 01 Sep 2026 03:59:00 GMT",
    observedAt: "2026-09-01T11:59:30+08:00",
    sourceEvidence: {
      endpoint: "/netbank/servlet/TrxDispatcher",
      transaction: "com.lb.wibc.trx.EAccDDSummary",
      status: 200,
      cacheControl: "no-store",
      contractVersion: "hncb/current-deposit-balance-v1",
    },
  } as CurrentRows[number];
}

function overviewRow(accountNumber: string, amount: string): OverviewRows[number] {
  return {
    source: "hncb",
    accountNumber,
    currency: "",
    currencySourceLexeme: "",
    currencyResolution: "missing",
    available: { coefficient: amount.replace(".", ""), scale: 2, sourceLexeme: amount },
    ledger: { coefficient: amount.replace(".", ""), scale: 2, sourceLexeme: amount },
    effectiveAt: "2026-09-01T03:59:00.000Z",
    providerHttpDate: "Tue, 01 Sep 2026 03:59:00 GMT",
    observedAt: "2026-09-01T11:59:30+08:00",
    sourceEvidence: {
      endpoint: "/netbank/servlet/TrxDispatcher",
      transaction: "com.lb.wibc.trx.AcctInfoInq",
      status: 200,
      cacheControl: "no-store",
      contractVersion: "hncb/current-deposit-balance-overview-v1",
      url: "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt&time_str=20260901115930",
    },
  } as OverviewRows[number];
}

type Account = Readonly<{ value: string; label: string; statement: Statement | null }>;

async function record(
  name: string,
  accounts: readonly Account[],
  current: Readonly<{ detail?: CurrentRows; overview?: OverviewRows }> = {},
): Promise<Record<string, unknown>> {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    const recorder = recordDepositCommit();
    const output = await runHncbStatements({} as Page, input, {
      financialCommit: recorder.financialCommit,
      event: recorder.event,
      readAccountOptions: async () => accounts.map(({ value, label }) => ({ value, label })),
      queryAccount: async (_page, account) =>
        accounts.find((candidate) => candidate.value === account.value)!.statement
          ? ({ account: account.value } as unknown as Frame)
          : null,
      downloadStatement: async (_page, _fallback, frame) =>
        accounts.find((candidate) => candidate.value === (frame as unknown as { account: string }).account)!.statement!,
      readCurrentDepositBalances: async () => current.detail ?? [],
      readCurrentDepositOverviewBalances: async () => current.overview ?? [],
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
    { detail: [currentRow(accountA, "13800.00", "13800.00"), currentRow(accountB, "3500.00", "3400.00")] },
  );
  assert.equal((recorded.output as { status: string }).status, "financial-admitted");
  assert.equal(commandKinds(recorded).length, 4);
});

test("HNCB golden: an account with no data commits beside an admitted account", async () => {
  const recorded = await record("hncb-no-data-account", [
    { value: accountA, label: `HNCB ${accountA}`, statement: statement(accountA, accountARows) },
    { value: accountB, label: accountB, statement: null },
  ]);
  assert.equal(commandKinds(recorded).length, 2);
});

test("HNCB golden: a shared-account label falls back to a source-only commit", async () => {
  const recorded = await record("hncb-shared-account-source-only", [
    { value: accountA, label: `HNCB ${accountA}`, statement: statement(accountA, accountARows) },
    { value: accountB, label: `HNCB 共同帳戶 ${accountB}`, statement: statement(accountB, accountBRows) },
  ]);
  assert.equal(commandKinds(recorded).length, 2);
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
