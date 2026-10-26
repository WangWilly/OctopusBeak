import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2 } from "../ledger/canonical/fubon-domestic-deposit.ts";
import {
  buildFubonLoanPaymentAccountEvidence,
  buildFubonCurrentDepositBalanceCapture,
  deriveFubonDomesticDepositAccountNumberEvidence,
  indexFubonCurrentDepositFinancialCaptures,
  parseFubonDepositPaginationSignal,
  readFubonDepositAccountOptions,
  runFubonStatements,
  stageFubonDeposit,
  type FubonDepositAccountOption,
  type FubonDepositProductContext,
  type FubonStatementsInput,
  type FubonDepositStatementEvidence,
  type FubonParsedDepositStatement,
} from "./fubon-statements.ts";
import {
  deriveFubonSourceConnectionKey,
  fubonStableLoginScope,
} from "./fubon-source-connection.ts";
import {
  FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  type FubonCurrentDepositBalanceRow,
} from "./fubon-current-deposit-balances.ts";
import { StatementComponentAbsentError, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type {
  AccountIdentityContinuity,
  AccountIdentityContinuityRequest,
} from "../ledger/pglite/account-identity-continuity.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";

const source = await readFile(
  new URL("./fubon-statements.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /fubonLogin\(|LibrettoWorkflowContext|workflow\(/u);
assert.doesNotMatch(source, /#btnLogin2/);
assert.doesNotMatch(source, /stageId: "fubon-login-captcha"/);
assert.doesNotMatch(source, /async function waitForSignedInState/);
assert.doesNotMatch(source, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun|writeFile\(|downloads[\\/]fubon/u);
assert.match(source, /PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND/);
assert.match(source, /PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND/);
assert.match(source, /PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND/);
assert.match(source, /PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND/);
assert.doesNotMatch(source, /pgliteWorkflowEnabled/);
assert.doesNotMatch(source, /executeCanonicalFinancialCommitRun/);

const resultTable = `<table id="resultGrid" class="tb1 queryResult"><tr>${[
  "帳務日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
].map((header) => `<th>${header}</th>`).join("")}</tr></table>`;
const exactTerminalPage = parseFubonDepositPaginationSignal(
  `<form id="form1"><input name="resultGrid:dataGridCurrentPageSize" value="48">${resultTable}</form>`,
  48,
);
assert.equal(exactTerminalPage.terminal, true);
assert.equal(exactTerminalPage.evidence, "terminal-no-next");
assert.equal(exactTerminalPage.paginationAmbiguous, undefined);
const unprovenTerminalPage = parseFubonDepositPaginationSignal(
  `<form id="form1"><input name="resultGrid:dataGridCurrentPageSize" value="48">${resultTable}</form>`,
  21,
);
assert.equal(unprovenTerminalPage.terminal, true);
assert.equal(unprovenTerminalPage.evidence, null);
assert.equal(unprovenTerminalPage.paginationAmbiguous, true);
assert.equal(unprovenTerminalPage.paginationAmbiguityReason, "terminal-proof-missing");

const accountNumber = ["0012", "3456", "7890", "12"].join("");
const rawAccountOption = {
  value: accountNumber,
  label: `${accountNumber} (012)`,
  branchName: "012",
};
const accountOption = {
  ...rawAccountOption,
  accountNumber: deriveFubonDomesticDepositAccountNumberEvidence(rawAccountOption)!,
};
const fubonCurrentCapture = buildFubonCurrentDepositBalanceCapture(
  {
    source: "fubon",
    accountNumber,
    accountNickname: "synthetic",
    depositType: "活期",
    branchName: "012",
    currency: "TWD",
    currencySourceLexeme: "台幣",
    instantBalance: { coefficient: "100", scale: 2, sourceLexeme: "100.00" },
    availableBalance: { coefficient: "90", scale: 2, sourceLexeme: "90.00" },
    effectiveAt: "2026-08-31T01:00:00.000Z",
    providerHttpDate: "Mon, 31 Aug 2026 01:00:00 GMT",
    observedAt: "2026-08-31T09:00:00+08:00",
    sourceEvidence: {
      endpoint: FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
      status: 200,
      cacheControl: "no-store, no-cache",
      contractVersion: FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    },
  },
  {
    identity: {
      sourceConnectionKey: "sha256:fubon-current-connection",
      identityEpochKey: "sha256:fubon-current-epoch",
      subjectDigest: "sha256:fubon-current-subject",
      accountNo: "sha256:fubon-current-account",
      sourceAccountKey: "sha256:fubon-current-account",
      accountNumber: { value: accountNumber },
    },
  },
);
assert.equal(fubonCurrentCapture.identity.sourceAccountKey, "sha256:fubon-current-account");
assert.deepEqual(
  fubonCurrentCapture.observations.map((observation) => observation.sourceField),
  ["即時餘額", "可用餘額"],
);
assert.equal(fubonCurrentCapture.records.length, 2);
const fubonExistingIdentity = {
  identity: {
    sourceConnectionKey: "sha256:fubon-current-connection",
    identityEpochKey: "sha256:fubon-current-epoch",
    subjectDigest: "sha256:fubon-current-subject",
    accountNo: "sha256:fubon-current-account",
    sourceAccountKey: "sha256:fubon-current-account",
    accountNumber: { value: accountNumber },
  },
};
assert.equal(
  indexFubonCurrentDepositFinancialCaptures([
    fubonExistingIdentity,
    fubonExistingIdentity,
  ]).size,
  1,
  "same account identity across date ranges is deduplicated",
);
assert.throws(
  () =>
    indexFubonCurrentDepositFinancialCaptures([
      fubonExistingIdentity,
      {
        identity: {
          ...fubonExistingIdentity.identity,
          sourceAccountKey: "sha256:other-account",
        },
      },
    ]),
  /ambiguous across financial captures/u,
);

const relationAccount = "01234567890123";
const relationEvidenceCapture: FubonDepositStatementEvidence = {
  evidenceVersion: "capture-evidence-v2",
  source: "fubon",
  observedAt: "2026-08-31T00:00:00.000Z",
  account: { value: "synthetic-deposit", label: "SYNTHETIC", branchName: "000" },
  queryRange: { startDate: "2026/03/01", endDate: "2026/08/31" },
  pages: [
    {
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      queryRange: { startDate: "2026/03/01", endDate: "2026/08/31" },
      selectedAccount: { value: "synthetic-deposit", label: "SYNTHETIC", branchName: "000" },
      rows: [
        { rowOrdinal: 0, cells: ["2026/08/17", "09:00:00", "放款繳款", "7,603.00", "", "100.00", `${relationAccount}測試分行`] },
        { rowOrdinal: 1, cells: ["2026/08/17", "09:01:00", "轉帳", "1.00", "", "99.00", relationAccount] },
      ],
      zeroObservation: "non-empty-page",
    },
  ],
  zeroObservation: "non-empty-range",
  providerRouteEvidence: { endpointPath: "/synthetic", contract: "synthetic", currency: "TWD" },
  provenance: { source: "fubon-ebank-domestic-deposit-form-postback", responseBodyRetained: false, semantics: "unresolved" },
};
const relationEvidence = buildFubonLoanPaymentAccountEvidence(
  relationEvidenceCapture,
  {
    captureId: "capture-synthetic",
    identity: {
      sourceConnectionKey: "sha256:synthetic-connection",
      identityEpochKey: "sha256:synthetic-deposit-epoch",
      accountNo: "sha256:synthetic-deposit-account",
    },
    records: relationEvidenceCapture.pages[0]!.rows.map((row) => ({
      occurrenceKey: `sha256:synthetic-row-${row.rowOrdinal}`,
      sequenceLexeme: `0:${row.rowOrdinal}`,
    })),
  },
);
assert.equal(relationEvidence.length, 1);
assert.equal(relationEvidence[0]!.accountValue, relationAccount);
assert.equal(relationEvidence[0]!.sourceRecordKey, "sha256:synthetic-row-0");
assert.equal(relationEvidence[0]!.accountKey, "sha256:synthetic-deposit-account");
assert.equal(relationEvidence[0]!.role, "beneficiary");
assert.equal(relationEvidence[0]!.scope, "loan_contract");
assert.equal(relationEvidence[0]!.sourceField, "附註");
await assert.rejects(
  () => runFubonStatements(
    {} as never,
    { dateRanges: ["30"], downloadFormat: "EXCEL" } as Parameters<typeof runFubonStatements>[1],
    {} as never,
    {} as never,
  ),
  /stable caller-supplied Source Connection scope and key/u,
);

class FakeOption {
  private readonly value: string;
  private readonly label: string;
  private readonly failure?: Error;

  constructor(value: string, label: string, failure?: Error) {
    this.value = value;
    this.label = label;
    this.failure = failure;
  }

  async getAttribute(name: string): Promise<string | null> {
    if (this.failure) throw this.failure;
    return name === "value" ? this.value : null;
  }

  async textContent(): Promise<string> {
    if (this.failure) throw this.failure;
    return this.label;
  }
}

class FakeOptionList {
  private readonly items: FakeOption[];
  constructor(items: FakeOption[]) { this.items = items; }
  async count() { return this.items.length; }
  nth(index: number) { return this.items[index]!; }
}

function fakeDepositPage(options: Array<{ value: string; label: string; failure?: Error }>) {
  const list = new FakeOptionList(options.map((option) => new FakeOption(option.value, option.label, option.failure)));
  const select = { async count() { return 1; }, locator() { return list; } };
  return {
    locator(selector: string) { return selector.endsWith(" option") ? list : select; },
    frames() { return []; },
    async waitForTimeout() {},
  } as never;
}

await assert.rejects(
  () => readFubonDepositAccountOptions(fakeDepositPage([])),
  (error: unknown) => error instanceof StatementComponentAbsentError && error.skipReason === "absent",
);
await assert.rejects(
  () => readFubonDepositAccountOptions(fakeDepositPage([
    { value: "none", label: "請選擇帳戶" },
    { value: "", label: "" },
  ])),
  (error: unknown) => error instanceof StatementComponentAbsentError && error.skipReason === "absent",
);
assert.deepEqual(
  await readFubonDepositAccountOptions(fakeDepositPage([
    { value: "SYNTHETIC-TWD-A", label: "SYNTHETIC-TWD-A (012)" },
    { value: "none", label: "請選擇帳戶" },
  ])),
  [{ value: "SYNTHETIC-TWD-A", label: "SYNTHETIC-TWD-A (012)" }],
);
await assert.rejects(
  () => readFubonDepositAccountOptions(fakeDepositPage([
    { value: "SYNTHETIC-TWD-A", label: "SYNTHETIC-TWD-A (012)", failure: new Error("unknown option read failure") },
  ])),
  /unknown option read failure/u,
);

const fixture = FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2;
const selectedAccount = accountOption;
const statementPages = fixture.pages.map((page) => {
  const rows = page.rows.map((row) => {
    const cells = [...row.cells] as [string, string, string, string, string, string, string];
    if (row.rowOrdinal === 0) {
      cells[2] = "放款繳款";
      cells[6] = relationAccount;
    }
    return { ...row, cells };
  });
  return {
    ...page,
    selectedAccount,
    rows: [
      ...rows,
      ...(page.pageOrdinal === 0 && rows[0]
        ? [{ ...rows[0], rowOrdinal: rows.length }]
        : []),
    ],
  };
});
const statement: FubonParsedDepositStatement = {
  account: selectedAccount.label,
  accountId: selectedAccount.value,
  queryPeriod: "synthetic",
  branchName: selectedAccount.branchName,
  rows: statementPages.flatMap((page) => page.rows.map((row) => [...row.cells])),
  pages: statementPages,
  accountOption: selectedAccount,
};
const stableLogin = {
  fubon_user_id: "FUBON-USER-001",
  fubon_account: "FUBON-LOGIN-001",
};
const sourceConnectionScope = fubonStableLoginScope(stableLogin)!;
const sourceConnectionKey = deriveFubonSourceConnectionKey(stableLogin)!;
const currentBalanceRow: FubonCurrentDepositBalanceRow = {
  source: "fubon",
  accountNumber,
  accountNickname: "synthetic",
  depositType: "活期",
  branchName: "012",
  currency: "TWD",
  currencySourceLexeme: "台幣",
  instantBalance: { coefficient: "10000", scale: 2, sourceLexeme: "100.00" },
  availableBalance: { coefficient: "9000", scale: 2, sourceLexeme: "90.00" },
  effectiveAt: "2026-01-31T12:00:00.000Z",
  providerHttpDate: "Sat, 31 Jan 2026 12:00:00 GMT",
  observedAt: "2026-01-31T12:00:00.000Z",
  sourceEvidence: {
    endpoint: FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
    status: 200,
    cacheControl: "no-store, no-cache",
    contractVersion: FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  },
};
const collectionInput = { dateRanges: ["30" as const], downloadFormat: "EXCEL" as const };

type DepositStatementFor = (
  dateRange: FubonStatementsInput["dateRanges"][number],
  account: FubonDepositAccountOption,
) => FubonParsedDepositStatement;

type DepositSource = Readonly<{
  stagedItems: ProductStageRequest[];
  accountIdentityContinuity: FubonDepositProductContext["accountIdentity"]["continuity"];
  accounts: readonly FubonDepositAccountOption[];
  statementFor: DepositStatementFor;
  currentRows: readonly FubonCurrentDepositBalanceRow[];
  signal?: AbortSignal;
  readCurrentBalances?: () => Promise<readonly FubonCurrentDepositBalanceRow[]>;
}>;

async function collectDeposit(
  input: FubonStatementsInput,
  { stagedItems, accountIdentityContinuity, accounts, statementFor, currentRows, signal, readCurrentBalances }: DepositSource,
) {
  const events: string[] = [];
  const summary = await stageFubonDeposit(
    {
      accounts: accounts.map((account) => ({
        account,
        statements: input.dateRanges.map((dateRange) => statementFor(dateRange, account)),
      })),
    },
    { ...input, sourceConnectionScope, sourceConnectionKey },
    {
      runId: "fubon-deposit-check",
      signal: signal ?? new AbortController().signal,
      now: () => "2026-01-31T12:00:00.000Z",
      browser: { withPage: async () => { throw new Error("the deposit check has no browser"); } },
      text: strictSourceText,
      verification: { complete: async () => undefined },
      accountIdentity: { continuity: accountIdentityContinuity },
      event: async () => undefined,
      signalEvent: async () => undefined,
    },
    {
      stage: (...requests) => { stagedItems.push(...requests); },
      reportActivity: async () => undefined,
      event: async (_stage, _outcome, code) => { events.push(code); },
    },
    readCurrentBalances ?? (async () => currentRows),
  );
  return { ...summary, events };
}

const exclusionEvents = (events: readonly string[], kind: "current-balance" | "statement") =>
  events.filter((code) => code.startsWith(`deposit-${kind}-excluded-`));

function collectorOverrides(
  stagedItems: ProductStageRequest[],
  statementFor: DepositStatementFor = () => statement,
): DepositSource {
  return {
    stagedItems,
    accountIdentityContinuity: async () => ({ status: "unseen" as const }),
    currentRows: [currentBalanceRow],
    accounts: [selectedAccount],
    statementFor,
  };
}

const typedOutputDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "fubon-collect-only-"));
const originalCwd = process.cwd();
process.chdir(typedOutputDir);
try {
  const deferredItems: ProductStageRequest[] = [];
  await collectDeposit(
    collectionInput,
    collectorOverrides(deferredItems),
  );
  assert.ok(deferredItems.length > 0);
  assert.ok(deferredItems.some((item) => item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND));
  assert.ok(deferredItems.some((item) => item.command.kind === PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND));
  const depositItem = deferredItems.find((item) =>
    item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  );
  assert.ok(depositItem && depositItem.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND);
  assert.deepEqual(
    depositItem.command.request.capture.records.map(
      (record) => record.occurrenceGroup?.ordinal,
    ),
    [1, 2],
    "identical Fubon rows retain two semantic occurrence slots",
  );
  assert.equal(depositItem.command.request.capture.occurrenceGroupCoverage?.length, 1);
  assert.deepEqual(await readdir(typedOutputDir), [], "Fubon collection must not create source, output, or log files");

  const cancellation = new AbortController();
  cancellation.abort();
  const cancelledItems: ProductStageRequest[] = [];
  await assert.rejects(
    collectDeposit(collectionInput, {
      ...collectorOverrides(cancelledItems),
      signal: cancellation.signal,
      readCurrentBalances: async () => assert.fail("a cancelled run must not open the current-balance page"),
    }),
    /abort/u,
  );
  assert.deepEqual(cancelledItems, [], "a cancelled run stages nothing");

  const usdHoldingRow: FubonCurrentDepositBalanceRow = {
    ...currentBalanceRow,
    depositType: "外幣活存",
    currency: "USD",
    currencySourceLexeme: "美金",
    instantBalance: { coefficient: "1234", scale: 2, sourceLexeme: "12.34" },
    availableBalance: { coefficient: "1234", scale: 2, sourceLexeme: "12.34" },
  };
  const usdHoldingItems: ProductStageRequest[] = [];
  await collectDeposit(
    collectionInput,
    {
      ...collectorOverrides(usdHoldingItems),
      currentRows: [currentBalanceRow, usdHoldingRow],
    },
  );
  const usdHoldingBalanceItems = usdHoldingItems.filter((item) =>
    item.command.kind === PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  );
  assert.equal(usdHoldingBalanceItems.length, 1, "a USD holding on the TWD account adds no second balance capture");
  const usdHoldingBalanceItem = usdHoldingBalanceItems[0]!;
  assert.ok(usdHoldingBalanceItem.command.kind === PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND);
  assert.equal(usdHoldingBalanceItem.command.request.account.currency, "TWD");
  assert.doesNotMatch(
    JSON.stringify(usdHoldingBalanceItem.command.request),
    /"currency":"USD"|美金|外幣活存|"coefficient":"1234"/u,
    "the USD holding must not leak into the TWD balance capture",
  );

  const secondAccountNumber = "00987654321098";
  const unlinkableAccount = {
    value: "SYNTHETIC-MULTI-B",
    label: `${secondAccountNumber} (013)`,
    branchName: "013",
  };
  assert.equal(deriveFubonDomesticDepositAccountNumberEvidence(unlinkableAccount), null);
  const statementFor = (account: typeof unlinkableAccount): FubonParsedDepositStatement => ({
    ...statement,
    account: account.label,
    accountId: account.value,
    branchName: account.branchName,
    pages: statement.pages.map((page) => ({ ...page, selectedAccount: account })),
    accountOption: account,
  });
  const secondTwdRow: FubonCurrentDepositBalanceRow = {
    ...currentBalanceRow,
    accountNumber: secondAccountNumber,
    branchName: "013",
    instantBalance: { coefficient: "5000", scale: 2, sourceLexeme: "50.00" },
    availableBalance: { coefficient: "5000", scale: 2, sourceLexeme: "50.00" },
  };
  const secondUsdRow: FubonCurrentDepositBalanceRow = {
    ...secondTwdRow,
    depositType: "外幣活存",
    currency: "USD",
    currencySourceLexeme: "美金",
  };
  const unlinkableItems: ProductStageRequest[] = [];
  const unlinkableResult = await collectDeposit(
    collectionInput,
    {
      ...collectorOverrides(unlinkableItems, (_range, account) =>
        account.value === unlinkableAccount.value ? statementFor(unlinkableAccount) : statement,
      ),
      accounts: [selectedAccount, unlinkableAccount],
      currentRows: [currentBalanceRow, secondTwdRow, secondUsdRow],
    },
  );
  const depositAccountKeys = (items: ProductStageRequest[]) =>
    items.flatMap((item) => item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND
      ? [[item.command.request.capture.identity.accountNumber?.value ?? null, item.command.request.capture.identity.sourceAccountKey] as const]
      : []);
  const balanceAccountKeys = (items: ProductStageRequest[]) =>
    items.flatMap((item) => item.command.kind === PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND
      ? [item.command.request.account.sourceAccountKey]
      : []);
  const unlinkableDeposits = depositAccountKeys(unlinkableItems);
  assert.deepEqual(
    unlinkableDeposits.map(([number]) => number).sort(),
    [accountNumber, null].sort(),
    "both accounts' statements admit when only the second lacks account-number evidence",
  );
  assert.deepEqual(
    balanceAccountKeys(unlinkableItems),
    unlinkableDeposits.flatMap(([number, key]) => (number === accountNumber ? [key] : [])),
    "only the unlinkable account's balance is excluded",
  );
  assert.deepEqual(unlinkableResult.events, [
    "deposit-current-balance-excluded-account-number-evidence-missing",
  ]);

  const depositIdentityFor = (items: ProductStageRequest[], number: string) =>
    items.flatMap((item) => {
      if (item.command.kind !== PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND) return [];
      const identity = item.command.request.capture.identity;
      if (identity.accountNumber?.value !== number) return [];
      return [{
        sourceConnectionKey: identity.sourceConnectionKey,
        identityEpochKey: identity.identityEpochKey,
        subjectDigest: identity.subjectDigest,
        accountNumber: identity.accountNumber,
      }];
    });

  const usdCodedOption = {
    value: `999-00${secondAccountNumber}-USD-02`,
    label: `${secondAccountNumber} (013)`,
  };
  const usdCodedAccount = {
    ...usdCodedOption,
    branchName: "013",
    accountNumber: deriveFubonDomesticDepositAccountNumberEvidence(usdCodedOption)!,
  };
  const secondUsdMarkedRow: FubonCurrentDepositBalanceRow = {
    ...secondUsdRow,
    instantBalance: { coefficient: "864213", scale: 2, sourceLexeme: "8642.13" },
    availableBalance: { coefficient: "864213", scale: 2, sourceLexeme: "8642.13" },
  };
  const withRunningBalance = (
    source: FubonParsedDepositStatement,
    balance: string,
    queryRange?: { startDate: string; endDate: string },
    rowDate?: string,
  ): FubonParsedDepositStatement => {
    const pages = source.pages.map((page) => ({
      ...page,
      ...(queryRange ? { queryRange } : {}),
      rows: page.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell, index) =>
          index === 5 ? balance : index === 0 && rowDate ? rowDate : cell,
        ) as [string, string, string, string, string, string, string],
      })),
    }));
    return { ...source, rows: pages.flatMap((page) => page.rows.map((row) => [...row.cells])), pages };
  };
  const olderRange = { startDate: "2025/07/01", endDate: "2025/12/31" };
  const olderStatementFor = (account: typeof unlinkableAccount) =>
    withRunningBalance(statementFor(account), "40.00", olderRange, "2025/08/01");
  const usdCodedNewest = (balance: string) => withRunningBalance(statementFor(usdCodedAccount), balance);
  const twoRangeInput = { dateRanges: ["30" as const, "180_365" as const], downloadFormat: "EXCEL" as const };
  const runUsdCoded = async (
    newestBalance: string,
    snapshotRows: readonly FubonCurrentDepositBalanceRow[],
    usdStatement: (range: string) => FubonParsedDepositStatement = (range) =>
      range === "30" ? usdCodedNewest(newestBalance) : olderStatementFor(usdCodedAccount),
  ) => {
    const items: ProductStageRequest[] = [];
    const result = await collectDeposit(
      twoRangeInput,
      {
        ...collectorOverrides(items, (range, account) =>
          account.value === usdCodedAccount.value
            ? usdStatement(range)
            : range === "30" ? statement : olderStatementFor(selectedAccount),
        ),
        accounts: [selectedAccount, usdCodedAccount],
        currentRows: snapshotRows,
      },
    );
    return { items, result };
  };
  const assertNoUsdSnapshotLeak = (items: ProductStageRequest[]) => {
    for (const item of items)
      assert.doesNotMatch(
        JSON.stringify(item.command),
        /"currency":"USD"|美金|外幣活存|"coefficient":"864213"|8642\.13/u,
        `the USD snapshot row must not reach a ${item.command.kind} command`,
      );
  };

  const { items: usdCodedItems, result: usdCodedResult } = await runUsdCoded(
    "50.00",
    [currentBalanceRow, secondTwdRow, secondUsdMarkedRow],
  );
  const usdCodedDeposits = depositAccountKeys(usdCodedItems);
  assert.deepEqual(
    [...new Set(usdCodedDeposits.map(([number]) => number))].sort(),
    [accountNumber, secondAccountNumber].sort(),
    "a USD-coded account whose newest running balance equals its TWD snapshot balance commits as TWD financial deposits",
  );
  assert.equal(
    usdCodedItems.some((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND),
    false,
    "no statement falls back to source-only evidence, including the older range whose running balance is stale",
  );
  assert.deepEqual(
    depositIdentityFor(usdCodedItems, secondAccountNumber).map((identity) => identity.accountNumber?.evidenceVersion),
    ["fubon/domestic-deposit/account-number-v3", "fubon/domestic-deposit/account-number-v3"],
    "both of the USD-coded account's ranges carry V3 account-number evidence",
  );
  assert.deepEqual(
    balanceAccountKeys(usdCodedItems).sort(),
    [...new Set(usdCodedDeposits.map(([, key]) => key))].sort(),
    "both accounts' TWD balances are captured",
  );
  assertNoUsdSnapshotLeak(usdCodedItems);
  assert.deepEqual(usdCodedResult.events, []);
  assert.deepEqual(
    [...new Set(depositIdentityFor(usdCodedItems, accountNumber).map((identity) => JSON.stringify(identity)))],
    depositIdentityFor(deferredItems, accountNumber).map((identity) => JSON.stringify(identity)),
    "the first account's identity does not churn when a second account joins",
  );
  assert.equal(depositIdentityFor(deferredItems, accountNumber).length, 1);

  const assertUsdCodedSourceOnly = (
    run: Awaited<ReturnType<typeof runUsdCoded>>,
    name: string,
  ) => {
    assert.deepEqual(
      [...new Set(depositAccountKeys(run.items).map(([number]) => number))],
      [accountNumber],
      `${name}: the USD-coded account stays out of financial admission`,
    );
    assert.equal(
      run.items.filter((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND).length,
      2,
      `${name}: both of the USD-coded account's ranges land as source-only evidence`,
    );
    assert.deepEqual(
      exclusionEvents(run.result.events, "statement"),
      ["deposit-statement-excluded-account-currency-unproven"],
      `${name}: the account is excluded once for unproven currency`,
    );
    assertNoUsdSnapshotLeak(run.items);
  };

  const mismatched = await runUsdCoded("49.99", [currentBalanceRow, secondTwdRow, secondUsdMarkedRow]);
  assertUsdCodedSourceOnly(mismatched, "a newest running balance that differs from the TWD snapshot");
  assert.deepEqual(exclusionEvents(mismatched.result.events, "current-balance"), [
    "deposit-current-balance-excluded-account-number-evidence-missing",
  ]);

  const secondUsdEqualRow: FubonCurrentDepositBalanceRow = {
    ...secondUsdMarkedRow,
    instantBalance: { coefficient: "50", scale: 0, sourceLexeme: "50" },
  };
  const matchesUsd = await runUsdCoded("50.00", [currentBalanceRow, secondTwdRow, secondUsdEqualRow]);
  assertUsdCodedSourceOnly(matchesUsd, "a TWD snapshot balance equal to the account's USD balance");
  assert.deepEqual(exclusionEvents(matchesUsd.result.events, "current-balance"), [
    "deposit-current-balance-excluded-account-number-evidence-missing",
  ]);

  const noTwdRow = await runUsdCoded("50.00", [currentBalanceRow, secondUsdMarkedRow]);
  assertUsdCodedSourceOnly(noTwdRow, "a snapshot without the account's TWD row");
  assert.deepEqual(exclusionEvents(noTwdRow.result.events, "current-balance"), []);

  const emptyUsdStatement = (range: string): FubonParsedDepositStatement => {
    const source = range === "30" ? statementFor(usdCodedAccount) : olderStatementFor(usdCodedAccount);
    const pages = source.pages.map((page) => ({ ...page, rows: [], zeroObservation: "empty-page" as const }));
    return { ...source, rows: [], pages };
  };
  const noRows = await runUsdCoded("50.00", [currentBalanceRow, secondTwdRow, secondUsdMarkedRow], emptyUsdStatement);
  assert.deepEqual(
    exclusionEvents(noRows.result.events, "statement"),
    ["deposit-statement-excluded-account-currency-unproven"],
    "a USD-coded account without statement rows cannot reconcile",
  );
  assert.equal(
    depositAccountKeys(noRows.items).some(([number]) => number === secondAccountNumber),
    false,
    "a USD-coded account without statement rows stays out of financial admission",
  );

  const continuedKey = `sha256:${"K".repeat(43)}`;
  const rewrittenOption = {
    value: `222-00${secondAccountNumber}-TWD-03`,
    label: `${secondAccountNumber} (013)`,
  };
  const rewrittenAccount = {
    ...rewrittenOption,
    branchName: "013",
    accountNumber: deriveFubonDomesticDepositAccountNumberEvidence(rewrittenOption)!,
  };
  const runWithContinuity = async (
    continuityByNumber: ReadonlyMap<string, AccountIdentityContinuity>,
    options: readonly (FubonDepositAccountOption & { branchName: string })[] = [selectedAccount, rewrittenAccount],
  ) => {
    const items: ProductStageRequest[] = [];
    const requests: AccountIdentityContinuityRequest[] = [];
    const result = await collectDeposit(
      twoRangeInput,
      {
        ...collectorOverrides(items, (range, selected) => {
          const account = options.find((option) => option.value === selected.value)!;
          if (account.value === selectedAccount.value) return range === "30" ? statement : olderStatementFor(selectedAccount);
          return range === "30" ? statementFor(account) : olderStatementFor(account);
        }),
        accountIdentityContinuity: async (request) => {
          requests.push(request);
          return continuityByNumber.get(request.identifier.value) ?? { status: "unseen" };
        },
        accounts: options,
        currentRows: [currentBalanceRow, secondTwdRow],
      },
    );
    return { items, requests, result };
  };
  const financialCapturesOf = (items: ProductStageRequest[]) =>
    items.flatMap((item) => item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND ? [item.command.request.capture] : []);

  const continuedRun = await runWithContinuity(new Map([[secondAccountNumber, { status: "continued", sourceAccountKey: continuedKey }]]));
  assert.deepEqual(
    depositIdentityFor(continuedRun.items, secondAccountNumber).map(({ subjectDigest }) => subjectDigest),
    [continuedKey, continuedKey],
    "both ranges of a rewritten option commit under the admitted account's key",
  );
  assert.deepEqual(
    depositAccountKeys(continuedRun.items).filter(([number]) => number === secondAccountNumber).map(([, key]) => key),
    [continuedKey, continuedKey],
  );
  assert.ok(balanceAccountKeys(continuedRun.items).includes(continuedKey), "the current balance links to the continued account");
  assert.doesNotThrow(() => indexFubonCurrentDepositFinancialCaptures(financialCapturesOf(continuedRun.items)));
  assert.deepEqual(continuedRun.result.events, []);
  assert.deepEqual(
    continuedRun.requests.map((request) => request.identifier.value).sort(),
    [accountNumber, secondAccountNumber].sort(),
    "one lookup per evidenced account number across both date ranges",
  );
  assert.deepEqual(
    continuedRun.requests.map(({ integrationNamespace, sourceConnectionKey: key, stream, identifier }) =>
      ({ integrationNamespace, key, stream, kind: identifier.kind })),
    continuedRun.requests.map(() => ({ integrationNamespace: "fubon", key: sourceConnectionKey, stream: "domestic-deposit", kind: "depository-account" })),
  );
  assert.equal(new Set(continuedRun.requests.map((request) => request.identityEpochKey)).size, 1);

  const ambiguousRun = await runWithContinuity(new Map([[secondAccountNumber, { status: "ambiguous", accountCount: 2 }]]));
  assert.deepEqual(
    ambiguousRun.result.events,
    ["deposit-statement-excluded-account-identity-ambiguous"],
    "an ambiguous account is excluded once",
  );
  assert.deepEqual(
    [...new Set(depositAccountKeys(ambiguousRun.items).map(([number]) => number))],
    [accountNumber],
    "the ambiguous account stays out of financial admission while the other account admits",
  );
  assert.equal(
    ambiguousRun.items.filter((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND).length,
    2,
    "both of the ambiguous account's ranges land as source-only evidence",
  );
  assert.deepEqual(
    balanceAccountKeys(ambiguousRun.items),
    [...new Set(depositAccountKeys(ambiguousRun.items).map(([, key]) => key))],
    "only the unambiguous account's balance is captured",
  );
  assert.doesNotMatch(JSON.stringify(ambiguousRun.result), new RegExp(secondAccountNumber), "the exclusion carries no account number");

  const unevidencedRun = await runWithContinuity(new Map(), [unlinkableAccount]);
  assert.deepEqual(unevidencedRun.requests, [], "an option without account-number evidence never reads continuity");
  assert.equal(depositAccountKeys(unevidencedRun.items).length, 2);

  const twdCodedSecondOption = { value: `999-00${secondAccountNumber}-TWD-02`, label: `${secondAccountNumber} (013)` };
  const twdCodedSecond = {
    ...twdCodedSecondOption,
    branchName: "013",
    accountNumber: deriveFubonDomesticDepositAccountNumberEvidence(twdCodedSecondOption)!,
  };
  const sameRunRewrite = await runWithContinuity(new Map(), [selectedAccount, twdCodedSecond, rewrittenAccount]);
  assert.deepEqual(
    [...new Set(depositAccountKeys(sameRunRewrite.items).filter(([number]) => number === secondAccountNumber).map(([, key]) => key))].length,
    1,
    "two options for one unseen account number in one run admit under one key",
  );
  assert.equal(sameRunRewrite.requests.filter((request) => request.identifier.value === secondAccountNumber).length, 1);

  const jpyCodedAccount = {
    value: `999-00${secondAccountNumber}-JPY-02`,
    label: `${secondAccountNumber} (013)`,
    branchName: "013",
  };
  const jpyCodedAmount = "777.77";
  const jpyCodedStatement = statementFor(jpyCodedAccount);
  const withJpyCodedAmounts = (cells: readonly string[]) =>
    cells.map((cell, index) => (index === 4 || index === 5 ? jpyCodedAmount : cell)) as [string, string, string, string, string, string, string];
  const jpyCodedPages = jpyCodedStatement.pages.map((page) => ({
    ...page,
    rows: page.rows.map((row) => ({ ...row, cells: withJpyCodedAmounts(row.cells) })),
  }));
  const jpyCodedItems: ProductStageRequest[] = [];
  const jpyCodedResult = await collectDeposit(
    collectionInput,
    {
      ...collectorOverrides(jpyCodedItems, (_range, account) =>
        account.value === jpyCodedAccount.value
          ? {
              ...jpyCodedStatement,
              rows: jpyCodedPages.flatMap((page) => page.rows.map((row) => [...row.cells])),
              pages: jpyCodedPages,
            }
          : statement,
      ),
      accounts: [selectedAccount, jpyCodedAccount],
      currentRows: [currentBalanceRow, secondTwdRow],
    },
  );
  const jpyCodedDeposits = depositAccountKeys(jpyCodedItems);
  assert.deepEqual(
    jpyCodedDeposits.map(([number]) => number),
    [accountNumber],
    "only the TWD-coded account's statements commit as financial deposits",
  );
  const jpyCodedSourceItems = jpyCodedItems.filter((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND);
  assert.equal(jpyCodedSourceItems.length, 1, "the JPY-coded account's statement lands as source-only evidence");
  const jpyCodedSource = jpyCodedSourceItems[0]!.command;
  assert.ok(jpyCodedSource.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND);
  assert.equal(
    jpyCodedSource.request.pages.reduce((count, page) => count + page.rowCount, 0),
    jpyCodedPages.reduce((count, page) => count + page.rows.length, 0),
    "the source-only evidence carries the JPY-coded account's rows",
  );
  const jpyCodedFinancialSubjects = jpyCodedItems.flatMap((item) =>
    item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND ? [item.command.request.capture.identity.subjectDigest] : [],
  );
  assert.equal(
    jpyCodedFinancialSubjects.includes(jpyCodedSource.request.subjectDigest),
    false,
    "the source-only evidence belongs to the JPY-coded account, not the TWD one",
  );
  for (const item of jpyCodedItems) {
    if (item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND) continue;
    assert.doesNotMatch(
      JSON.stringify(item.command),
      /777\.77|77777/u,
      `the JPY-coded account's amounts must not reach a ${item.command.kind} command`,
    );
  }
  assert.deepEqual(
    balanceAccountKeys(jpyCodedItems),
    jpyCodedDeposits.map(([, key]) => key),
    "only the TWD-coded account's balance is captured",
  );
  assert.deepEqual(jpyCodedResult.events, [
    "deposit-current-balance-excluded-account-number-evidence-missing",
    "deposit-statement-excluded-account-currency-unproven",
  ]);

  const noRecordAccount = {
    value: secondAccountNumber,
    label: `${secondAccountNumber} (013)`,
    branchName: "013",
    accountNumber: deriveFubonDomesticDepositAccountNumberEvidence({
      value: secondAccountNumber,
      label: `${secondAccountNumber} (013)`,
    })!,
  };
  const noRecordStatement: FubonParsedDepositStatement = {
    account: noRecordAccount.label,
    accountId: noRecordAccount.value,
    queryPeriod: statement.queryPeriod,
    branchName: noRecordAccount.branchName,
    rows: [],
    pages: [{
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      paginationEvidence: "terminal-no-next",
      queryRange: { ...statement.pages[0]!.queryRange },
      selectedAccount: noRecordAccount,
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
    }],
    accountOption: noRecordAccount,
  };
  const noRecordItems: ProductStageRequest[] = [];
  const noRecordResult = await collectDeposit(
    collectionInput,
    {
      ...collectorOverrides(noRecordItems, (_range, account) =>
        account.value === noRecordAccount.value ? noRecordStatement : statement,
      ),
      accounts: [selectedAccount, noRecordAccount],
      currentRows: [currentBalanceRow, secondTwdRow, secondUsdRow],
    },
  );
  assert.deepEqual(exclusionEvents(noRecordResult.events, "current-balance"), []);
  const noRecordDeposits = depositAccountKeys(noRecordItems);
  assert.deepEqual(
    noRecordDeposits.map(([number]) => number).sort(),
    [accountNumber, secondAccountNumber].sort(),
  );
  assert.deepEqual(
    balanceAccountKeys(noRecordItems).sort(),
    noRecordDeposits.map(([, key]) => key).sort(),
    "a no-record statement range still establishes the account for its balance",
  );

  const malformedStatement: FubonParsedDepositStatement = {
    ...statement,
    rows: statement.rows.map((row, index) =>
      index === 0 ? [...row.slice(0, 4), "not-an-amount", ...row.slice(5)] : [...row],
    ),
    pages: statement.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) => {
        const cells = [...row.cells] as [string, string, string, string, string, string, string];
        if (row.rowOrdinal === 0) cells[4] = "not-an-amount";
        return { ...row, cells };
      }),
    })),
  };
  const malformedItems: ProductStageRequest[] = [];
  await assert.rejects(
    () => collectDeposit(
      collectionInput,
      collectorOverrides(malformedItems, () => malformedStatement),
    ),
    /amount-invalid|amount-sign-invalid|financial admission failed/iu,
  );
  assert.deepEqual(malformedItems, [], "malformed amounts must be rejected before items reach the injected commit port");

  const incompleteAccount = {
    value: "SYNTHETIC-TWD-A",
    label: "SYNTHETIC-TWD-A (012)",
    branchName: "012",
  };
  const incompleteRow = ["2026/01/02", "09:10:11", "INCOMPLETE", "", "100", "100", ""] as const;
  const incompleteStatement: FubonParsedDepositStatement = {
    account: incompleteAccount.label,
    accountId: incompleteAccount.value,
    queryPeriod: "2026/01/01~2026/01/31",
    branchName: incompleteAccount.branchName,
    rows: [[...incompleteRow]],
    pages: [{
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      queryRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
      selectedAccount: incompleteAccount,
      providerPageSize: 1,
      rows: [{ rowOrdinal: 0, cells: [...incompleteRow] }],
      zeroObservation: "non-empty-page",
    }],
    accountOption: incompleteAccount,
  };
  const incompleteItems: ProductStageRequest[] = [];
  await collectDeposit(
    { dateRanges: ["1"], downloadFormat: "EXCEL" },
    {
      ...collectorOverrides(incompleteItems, () => incompleteStatement),
      accounts: [incompleteAccount],
      currentRows: [],
    },
  );
  assert.equal(incompleteItems.length, 1);
  assert.equal(incompleteItems[0]?.command.kind, PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND);
} finally {
  process.chdir(originalCwd);
  await rm(typedOutputDir, { recursive: true, force: true });
}
