import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { assertDepositCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";
import type { FubonAllWorkflowDependencies } from "./fubon-all-statements.ts";
import {
  FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  type FubonCurrentDepositBalanceRow,
} from "./fubon-current-deposit-balances.ts";
import type {
  FubonDepositAccountOptionEvidence,
  FubonDepositStatementPageEvidence,
  FubonParsedDepositStatement,
  FubonStatementsRunDependencies,
} from "./fubon-statements.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { runFubonAllStatementsWorkflow } = await import("./fubon-all-statements.ts");
const { deriveFubonDomesticDepositAccountNumberEvidence, runFubonStatements } = await import("./fubon-statements.ts");

const NOW = "2026-09-25T00:00:00.000Z";
const QUERY_RANGE = { startDate: "2026/08/26", endDate: "2026/09/25" };

type Cells = [date: string, time: string, memo: string, outflow: string, inflow: string, balance: string, note: string];
type DepositStubs = Pick<
  FubonStatementsRunDependencies,
  "readDepositAccountOptions" | "fetchDepositStatement" | "readCurrentDepositBalances"
> & Partial<Pick<FubonStatementsRunDependencies, "accountIdentityContinuity">>;

function option(value: string, label: string, branchName: string): FubonDepositAccountOptionEvidence {
  const accountNumber = deriveFubonDomesticDepositAccountNumberEvidence({ value, label });
  return { value, label, branchName, ...(accountNumber ? { accountNumber } : {}) };
}

function pages(
  account: FubonDepositAccountOptionEvidence,
  rows: readonly Cells[],
): FubonDepositStatementPageEvidence[] {
  const common = { queryRange: QUERY_RANGE, selectedAccount: account, providerPageSize: 10 };
  return [
    {
      ...common,
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: false,
      nextPage: "2",
      pageFieldName: "resultGrid:dataGridCurrentPage",
      rows: rows.map((cells, rowOrdinal) => ({ rowOrdinal, cells })),
      zeroObservation: rows.length > 0 ? "non-empty-page" : "empty-page",
    },
    {
      ...common,
      pageOrdinal: 1,
      responseSequence: 2,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      rows: [],
      zeroObservation: "empty-page",
    },
  ];
}

function statement(
  account: FubonDepositAccountOptionEvidence,
  statementPages: FubonParsedDepositStatement["pages"],
): FubonParsedDepositStatement {
  return {
    account: account.label,
    accountId: account.value,
    queryPeriod: `${QUERY_RANGE.startDate}~${QUERY_RANGE.endDate}`,
    branchName: account.branchName,
    rows: statementPages.flatMap((page) => page.rows.map((row) => [...row.cells])),
    pages: statementPages,
    accountOption: account,
  };
}

function balance(
  accountNumber: string,
  branchName: string,
  instant: string,
  available: string,
  currency: "TWD" | "USD" = "TWD",
): FubonCurrentDepositBalanceRow {
  return {
    source: "fubon",
    accountNumber,
    accountNickname: "synthetic",
    depositType: currency === "TWD" ? "活期" : "外幣活存",
    branchName,
    currency,
    currencySourceLexeme: currency === "TWD" ? "台幣" : "美金",
    instantBalance: { coefficient: instant, scale: 2, sourceLexeme: (Number(instant) / 100).toFixed(2) },
    availableBalance: { coefficient: available, scale: 2, sourceLexeme: (Number(available) / 100).toFixed(2) },
    effectiveAt: "2026-09-24T16:00:00.000Z",
    providerHttpDate: "Thu, 24 Sep 2026 16:00:00 GMT",
    observedAt: NOW,
    sourceEvidence: {
      endpoint: FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
      status: 200,
      cacheControl: "no-store, no-cache",
      contractVersion: FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    },
  };
}

// Expand each item's relation thunk so the golden pins the relation commands
// rather than the helper's "[function]" placeholder. The thunks ignore the
// commit value, so the stub commit's null stands in for it.
function expandRelationCommands(
  items: readonly PGliteWorkflowRunItem[],
): readonly PGliteWorkflowRunItem[] {
  return items.map((item) => (item.relationCommands
    ? { ...item, relationCommands: item.relationCommands(null) }
    : item) as PGliteWorkflowRunItem);
}

function workflowContext(recorder: ReturnType<typeof recordDepositCommit>): WorkflowContextWith<"financialCommit" | "accountIdentity"> {
  return {
    runId: "fubon-deposit-golden",
    signal: new AbortController().signal,
    now: () => NOW,
    browser: {
      withPage: async <T>(run: (page: Page) => Promise<T>) =>
        run({ context: () => ({ clearCookies: async () => undefined }) } as unknown as Page),
    },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    accountIdentity: { continuity: async () => ({ status: "unseen" }) },
    financialCommit: {
      execute: (items, options) => recorder.financialCommit.execute(expandRelationCommands(items), options),
    },
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
}

async function runGolden(name: string, stubs: DepositStubs, dateRanges: readonly string[] = ["30"]): Promise<void> {
  const recorder = recordDepositCommit();
  const collectDeposit: NonNullable<FubonAllWorkflowDependencies["collectDeposit"]> = (
    page, input, context, identity, items, reportActivity,
  ) => runFubonStatements(page, input, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    accountIdentityContinuity: async () => ({ status: "unseen" }),
    reportActivity,
    openTransactionDetailForAccountIndex: async () => "****0000",
    selectDepositAccount: async () => undefined,
    ...stubs,
  });
  const result = await runFubonAllStatementsWorkflow(workflowContext(recorder), {
    managedIdentitySecret: "synthetic-fubon-golden-secret",
    statementTypes: ["deposit"],
    credentials: {
      fubon_user_id: "SYNTHETIC-FUBON-USER",
      fubon_account: "SYNTHETIC-FUBON-LOGIN",
      fubon_password: "synthetic-password",
    },
    statements: { dateRanges, downloadFormat: "EXCEL" },
  }, {
    authenticate: async () => undefined,
    assertSession: async () => undefined,
    signOut: async () => undefined,
    startSessionKeepAlive: () => () => undefined,
    collectDeposit,
  });
  await assertDepositCommitGolden(name, relativeCaptureClock({ result, ...recorder.recorded() }));
}

const CAPTURE_CLOCK = /(?<=fubon-(?:financial|source)-)\d{13}(?=-)/gu;

// Capture ids embed a Date.now() counter that the workflow module keeps across
// runs, so rebase it on the scenario's first id to stay order-independent.
function relativeCaptureClock(value: unknown): unknown {
  const json = JSON.stringify(value);
  const stamps = (json.match(CAPTURE_CLOCK) ?? []).map(Number);
  const base = Math.min(...stamps);
  return JSON.parse(json.replace(CAPTURE_CLOCK, (stamp) => `t+${Number(stamp) - base}`));
}

const primaryNumber = "99900000000101";
const secondNumber = "99900000000202";
const relationAccount = "99911122233344";

const primary = option(primaryNumber, `${primaryNumber} (012)`, "012");
const second = option(secondNumber, `${secondNumber} (013)`, "013");
const compositeTwd = option(`222-00${secondNumber}-TWD-03`, `${secondNumber} (013)`, "013");
const usdCoded = option(`999-00${secondNumber}-USD-02`, `${secondNumber} (013)`, "013");
const jpyCoded = option(`999-00${secondNumber}-JPY-02`, `${secondNumber} (013)`, "013");
const unnumbered = option("SYNTHETIC-FUBON-TWD-A", "SYNTHETIC-FUBON-TWD-A (014)", "014");

const primaryStatement = statement(primary, pages(primary, [
  ["2026/09/01", "08:00:00", "SYNTHETIC SALARY", "", "1,000.00", "1,000.00", "SYNTHETIC NOTE"],
  ["2026/09/03", "09:10:11", "放款繳款", "250.00", "", "750.00", `${relationAccount}測試分行`],
  ["2026/09/05", "10:20:30", "SYNTHETIC TRANSFER OUT", "100.00", "", "650.00", ""],
]));
const secondRows: Cells[] = [
  ["2026/09/10", "11:00:00", "SYNTHETIC TRANSFER IN", "", "300.00", "300.00", ""],
  ["2026/09/12", "12:00:00", "SYNTHETIC CARD PAYMENT", "250.00", "", "50.00", ""],
];

function stubs(statements: ReadonlyMap<string, FubonParsedDepositStatement>, rows: FubonCurrentDepositBalanceRow[]): DepositStubs {
  return {
    readDepositAccountOptions: async () => [...statements.values()].map((entry) => entry.accountOption),
    fetchDepositStatement: async (_page, _range, account) => statements.get(account.value)!,
    readCurrentDepositBalances: async () => rows,
  };
}

const primaryBalance = balance(primaryNumber, "012", "65000", "60000");
const secondBalance = balance(secondNumber, "013", "5000", "5000");

test("two numbered accounts with inflow and outflow rows and matched current balances", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-two-accounts", stubs(new Map([
    [primary.value, primaryStatement],
    [second.value, statement(second, pages(second, secondRows))],
  ]), [primaryBalance, secondBalance]));
});

test("an account whose range has no records still commits and anchors its balance", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const noRecordPages: FubonParsedDepositStatement["pages"] = [{
    pageOrdinal: 0,
    responseSequence: 1,
    terminal: true,
    nextPage: null,
    pageFieldName: null,
    paginationEvidence: "terminal-no-next",
    queryRange: QUERY_RANGE,
    selectedAccount: second,
    rows: [],
    zeroObservation: "empty-page",
    responseMetadata: {
      fieldNames: [],
      fields: [],
      candidateProviderKeyNames: [],
      candidateProviderKeyDigests: [],
      statusFieldNames: ["provider-no-data-message"],
      correctionFieldNames: [],
      transactionTimeFieldNames: [],
      accountScopeFieldNames: [],
      pagination: [],
    },
  }];
  await runGolden("fubon-no-data-account", stubs(new Map([
    [primary.value, primaryStatement],
    [second.value, statement(second, noRecordPages)],
  ]), [primaryBalance, secondBalance]));
});

test("a JPY-coded account falls back to source-only evidence on an unproven currency", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-source-only-currency-unproven", stubs(new Map([
    [primary.value, primaryStatement],
    [jpyCoded.value, statement(jpyCoded, pages(jpyCoded, secondRows))],
  ]), [primaryBalance, secondBalance]));
});

test("an incomplete terminal page is preserved as source-only evidence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const incompletePages: FubonDepositStatementPageEvidence[] = [{
    pageOrdinal: 0,
    responseSequence: 1,
    terminal: true,
    nextPage: null,
    pageFieldName: null,
    queryRange: QUERY_RANGE,
    selectedAccount: unnumbered,
    providerPageSize: 1,
    rows: [{ rowOrdinal: 0, cells: ["2026/09/02", "09:10:11", "SYNTHETIC INCOMPLETE", "", "100.00", "100.00", ""] }],
    zeroObservation: "non-empty-page",
  }];
  await runGolden("fubon-source-only-incomplete-pagination", stubs(new Map([
    [primary.value, primaryStatement],
    [unnumbered.value, statement(unnumbered, incompletePages)],
  ]), [primaryBalance]));
});

test("a composite TWD account option admits with V2 account-number evidence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-composite-twd-account", stubs(new Map([
    [primary.value, primaryStatement],
    [compositeTwd.value, statement(compositeTwd, pages(compositeTwd, secondRows))],
  ]), [primaryBalance, secondBalance]));
});

test("a USD-coded composite account that reconciles to its TWD balance admits with V3 evidence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-usd-coded-reconciled", stubs(new Map([
    [primary.value, primaryStatement],
    [usdCoded.value, statement(usdCoded, pages(usdCoded, secondRows))],
  ]), [primaryBalance, secondBalance, balance(secondNumber, "013", "864213", "864213", "USD")]));
});

test("a USD-coded composite account that does not reconcile stays source-only", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-usd-coded-mismatch", stubs(new Map([
    [primary.value, primaryStatement],
    [usdCoded.value, statement(usdCoded, pages(usdCoded, secondRows))],
  ]), [primaryBalance, balance(secondNumber, "013", "4999", "4999"), balance(secondNumber, "013", "864213", "864213", "USD")]));
});

test("an account continued from an earlier identity commits under its prior source account key", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-continued-identity", {
    ...stubs(new Map([
      [primary.value, primaryStatement],
      [second.value, statement(second, pages(second, secondRows))],
    ]), [primaryBalance, secondBalance]),
    accountIdentityContinuity: async ({ identifier }) => identifier.value === secondNumber
      ? { status: "continued", sourceAccountKey: "sha256:synthetic-prior-fubon-account" }
      : { status: "unseen" },
  });
});

test("an account matching several earlier identities is excluded to source-only evidence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("fubon-ambiguous-identity", {
    ...stubs(new Map([
      [primary.value, primaryStatement],
      [second.value, statement(second, pages(second, secondRows))],
    ]), [primaryBalance, secondBalance]),
    accountIdentityContinuity: async ({ identifier }) => identifier.value === secondNumber
      ? { status: "ambiguous", accountCount: 2 }
      : { status: "unseen" },
  });
});
