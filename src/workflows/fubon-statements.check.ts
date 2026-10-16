import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2 } from "../ledger/canonical/fubon-domestic-deposit.ts";
import type { FubonDepositResultCurrencyEvidence } from "../ledger/canonical/fubon-domestic-deposit-admission.ts";
import {
  buildFubonLoanPaymentAccountEvidence,
  buildFubonCurrentDepositBalanceCapture,
  deriveFubonDomesticDepositAccountNumberEvidence,
  indexFubonCurrentDepositFinancialCaptures,
  parseFubonDepositPaginationSignal,
  readFubonDepositAccountOptions,
  runFubonStatements,
  type FubonStatementsRunDependencies,
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
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";

const source = await readFile(
  new URL("./fubon-statements.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /completeFubonHumanLogin|LibrettoWorkflowContext|workflow\(/u);
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
      currencyEvidence: { kind: "no-currency-tabs" },
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
    { dateRanges: ["30"], downloadFormat: "EXCEL" },
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

function collectorOverrides(
  deferredCommitItems: PGliteWorkflowRunItem[],
  fetchDepositStatement: NonNullable<FubonStatementsRunDependencies["fetchDepositStatement"]> = async () => statement,
) {
  return {
    sourceConnectionScope,
    sourceConnectionKey,
    deferredCommitItems,
    sourceText: strictSourceText,
    signal: new AbortController().signal,
    readCurrentDepositBalances: async () => [currentBalanceRow],
    openTransactionDetailForAccountIndex: async () => "****0000",
    readDepositAccountOptions: async () => [selectedAccount],
    selectDepositAccount: async () => undefined,
    fetchDepositStatement,
  };
}

const typedOutputDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "fubon-collect-only-"));
const originalCwd = process.cwd();
process.chdir(typedOutputDir);
try {
  const deferredItems: PGliteWorkflowRunItem[] = [];
  const result = await runFubonStatements(
    {} as never,
    collectionInput,
    collectorOverrides(deferredItems),
  );
  assert.ok(result.itemCount > 0);
  assert.equal(deferredItems.length, result.itemCount);
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

  const usdHoldingRow: FubonCurrentDepositBalanceRow = {
    ...currentBalanceRow,
    depositType: "外幣活存",
    currency: "USD",
    currencySourceLexeme: "美金",
    instantBalance: { coefficient: "1234", scale: 2, sourceLexeme: "12.34" },
    availableBalance: { coefficient: "1234", scale: 2, sourceLexeme: "12.34" },
  };
  const usdHoldingItems: PGliteWorkflowRunItem[] = [];
  await runFubonStatements(
    {} as never,
    collectionInput,
    {
      ...collectorOverrides(usdHoldingItems),
      readCurrentDepositBalances: async () => [currentBalanceRow, usdHoldingRow],
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
  const statementFor = (
    account: typeof unlinkableAccount,
    currencyEvidence?: FubonDepositResultCurrencyEvidence,
  ): FubonParsedDepositStatement => ({
    ...statement,
    account: account.label,
    accountId: account.value,
    branchName: account.branchName,
    pages: statement.pages.map((page) => ({
      ...page,
      selectedAccount: account,
      ...(currencyEvidence ? { currencyEvidence } : {}),
    })),
    accountOption: account,
  });
  const activeTwdTab: FubonDepositResultCurrencyEvidence = {
    kind: "active-tab",
    label: "臺幣活期存款",
    labels: ["臺幣活期存款", "外幣活期存款"],
  };
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
  const unlinkableItems: PGliteWorkflowRunItem[] = [];
  const unlinkableResult = await runFubonStatements(
    {} as never,
    collectionInput,
    {
      ...collectorOverrides(unlinkableItems, async (_page, _range, account) =>
        account.value === unlinkableAccount.value ? statementFor(unlinkableAccount) : statement,
      ),
      readDepositAccountOptions: async () => [selectedAccount, unlinkableAccount],
      readCurrentDepositBalances: async () => [currentBalanceRow, secondTwdRow, secondUsdRow],
    },
  );
  const depositAccountKeys = (items: PGliteWorkflowRunItem[]) =>
    items.flatMap((item) => item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND
      ? [[item.command.request.capture.identity.accountNumber?.value ?? null, item.command.request.capture.identity.sourceAccountKey] as const]
      : []);
  const balanceAccountKeys = (items: PGliteWorkflowRunItem[]) =>
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
  assert.equal(unlinkableResult.itemCount, unlinkableItems.length);
  assert.deepEqual(unlinkableResult.currentBalanceExclusions, [
    { reason: "account-number-evidence-missing", unlinkedStatementAccountShapes: ["AAAAAAAAA-AAAAA-A"] },
  ]);
  assert.deepEqual(unlinkableResult.statementExclusions, []);

  const depositIdentityFor = (items: PGliteWorkflowRunItem[], number: string) =>
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
  const usdCodedItems: PGliteWorkflowRunItem[] = [];
  const usdCodedResult = await runFubonStatements(
    {} as never,
    collectionInput,
    {
      ...collectorOverrides(usdCodedItems, async (_page, _range, account) =>
        account.value === usdCodedAccount.value ? statementFor(usdCodedAccount, activeTwdTab) : statement,
      ),
      readDepositAccountOptions: async () => [selectedAccount, usdCodedAccount],
      readCurrentDepositBalances: async () => [currentBalanceRow, secondTwdRow, secondUsdMarkedRow],
    },
  );
  const usdCodedDeposits = depositAccountKeys(usdCodedItems);
  assert.deepEqual(
    usdCodedDeposits.map(([number]) => number).sort(),
    [accountNumber, secondAccountNumber].sort(),
    "a USD-coded account whose pages show the 臺幣活期存款 tab active commits as TWD financial deposits",
  );
  assert.deepEqual(
    depositIdentityFor(usdCodedItems, secondAccountNumber).map((identity) => identity.accountNumber?.evidenceVersion),
    ["fubon/domestic-deposit/account-number-v3"],
    "the USD-coded account's number carries V3 evidence",
  );
  assert.deepEqual(
    balanceAccountKeys(usdCodedItems).sort(),
    usdCodedDeposits.map(([, key]) => key).sort(),
    "both accounts' TWD balances are captured",
  );
  assert.equal(
    usdCodedItems.some((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND),
    false,
    "no statement falls back to source-only evidence",
  );
  for (const item of usdCodedItems) {
    assert.doesNotMatch(
      JSON.stringify(item.command),
      /"currency":"USD"|美金|外幣活存|"coefficient":"864213"|8642\.13/u,
      `the USD snapshot row must not reach a ${item.command.kind} command`,
    );
  }
  assert.deepEqual(usdCodedResult.currentBalanceExclusions, []);
  assert.deepEqual(usdCodedResult.statementExclusions, []);
  assert.deepEqual(
    depositIdentityFor(usdCodedItems, accountNumber),
    depositIdentityFor(deferredItems, accountNumber),
    "the first account's identity does not churn when a second account joins",
  );
  assert.equal(depositIdentityFor(deferredItems, accountNumber).length, 1);

  const usdCodedShape = ["999", "9".repeat(16), "AAA", "99"].join("-");
  const usdUntabbedItems: PGliteWorkflowRunItem[] = [];
  const usdUntabbedResult = await runFubonStatements(
    {} as never,
    collectionInput,
    {
      ...collectorOverrides(usdUntabbedItems, async (_page, _range, account) =>
        account.value === usdCodedAccount.value ? statementFor(usdCodedAccount) : statement,
      ),
      readDepositAccountOptions: async () => [selectedAccount, usdCodedAccount],
      readCurrentDepositBalances: async () => [currentBalanceRow, secondTwdRow, secondUsdMarkedRow],
    },
  );
  assert.deepEqual(
    depositAccountKeys(usdUntabbedItems).map(([number]) => number),
    [accountNumber],
    "a USD-coded account whose pages show no currency tab stays out of financial admission",
  );
  assert.equal(
    usdUntabbedItems.filter((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND).length,
    1,
    "the untabbed USD-coded account's statement lands as source-only evidence",
  );
  assert.deepEqual(usdUntabbedResult.statementExclusions, [
    {
      reason: "account-currency-unproven",
      accountShape: usdCodedShape,
      currencyEvidenceByPage: statement.pages.map(() => ({ kind: "no-currency-tabs" })),
    },
  ]);
  for (const item of usdUntabbedItems) {
    assert.doesNotMatch(
      JSON.stringify(item.command),
      /"currency":"USD"|美金|外幣活存|"coefficient":"864213"|8642\.13/u,
      `the USD snapshot row must not reach a ${item.command.kind} command`,
    );
  }

  const jpyCodedAccount = {
    value: `999-00${secondAccountNumber}-JPY-02`,
    label: `${secondAccountNumber} (013)`,
    branchName: "013",
  };
  const jpyCodedAmount = "777.77";
  const jpyCodedShape = ["999", "9".repeat(16), "AAA", "99"].join("-");
  const jpyCodedStatement = statementFor(jpyCodedAccount);
  const withJpyCodedAmounts = (cells: readonly string[]) =>
    cells.map((cell, index) => (index === 4 || index === 5 ? jpyCodedAmount : cell)) as [string, string, string, string, string, string, string];
  const jpyCodedPages = jpyCodedStatement.pages.map((page) => ({
    ...page,
    rows: page.rows.map((row) => ({ ...row, cells: withJpyCodedAmounts(row.cells) })),
  }));
  const jpyCodedItems: PGliteWorkflowRunItem[] = [];
  const jpyCodedResult = await runFubonStatements(
    {} as never,
    collectionInput,
    {
      ...collectorOverrides(jpyCodedItems, async (_page, _range, account) =>
        account.value === jpyCodedAccount.value
          ? {
              ...jpyCodedStatement,
              rows: jpyCodedPages.flatMap((page) => page.rows.map((row) => [...row.cells])),
              pages: jpyCodedPages,
            }
          : statement,
      ),
      readDepositAccountOptions: async () => [selectedAccount, jpyCodedAccount],
      readCurrentDepositBalances: async () => [currentBalanceRow, secondTwdRow],
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
  assert.deepEqual(jpyCodedResult.currentBalanceExclusions, [
    { reason: "account-number-evidence-missing", unlinkedStatementAccountShapes: [jpyCodedShape] },
  ]);
  assert.deepEqual(jpyCodedResult.statementExclusions, [
    {
      reason: "account-currency-unproven",
      accountShape: jpyCodedShape,
      currencyEvidenceByPage: jpyCodedPages.map(() => ({ kind: "no-currency-tabs" })),
    },
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
      currencyEvidence: { kind: "no-currency-tabs" },
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
  const noRecordItems: PGliteWorkflowRunItem[] = [];
  const noRecordResult = await runFubonStatements(
    {} as never,
    collectionInput,
    {
      ...collectorOverrides(noRecordItems, async (_page, _range, account) =>
        account.value === noRecordAccount.value ? noRecordStatement : statement,
      ),
      readDepositAccountOptions: async () => [selectedAccount, noRecordAccount],
      readCurrentDepositBalances: async () => [currentBalanceRow, secondTwdRow, secondUsdRow],
    },
  );
  assert.deepEqual(noRecordResult.currentBalanceExclusions, []);
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
  const malformedItems: PGliteWorkflowRunItem[] = [];
  await assert.rejects(
    () => runFubonStatements(
      {} as never,
      collectionInput,
      collectorOverrides(malformedItems, async () => malformedStatement),
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
      currencyEvidence: { kind: "no-currency-tabs" },
    }],
    accountOption: incompleteAccount,
  };
  const incompleteItems: PGliteWorkflowRunItem[] = [];
  const incompleteResult = await runFubonStatements(
    {} as never,
    { dateRanges: ["1"], downloadFormat: "EXCEL" },
    {
      ...collectorOverrides(incompleteItems, async () => incompleteStatement),
      readDepositAccountOptions: async () => [incompleteAccount],
      readCurrentDepositBalances: async () => [],
    },
  );
  assert.equal(incompleteResult.itemCount, 1);
  assert.equal(incompleteItems[0]?.command.kind, PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND);

  const laterAccount = {
    value: "00987654321098",
    label: "00987654321098 (013)",
    branchName: "013",
  };
  const partialItems: PGliteWorkflowRunItem[] = [];
  await assert.rejects(
    () => runFubonStatements(
      {} as never,
      collectionInput,
      {
        ...collectorOverrides(partialItems, async (_page, _range, account) => {
          if (account.value === laterAccount.value)
            throw new Error("synthetic later-account fetch failure");
          return statement;
        }),
        readDepositAccountOptions: async () => [selectedAccount, laterAccount],
      },
    ),
    /later-account fetch failure/iu,
  );
  assert.deepEqual(partialItems, [], "a later source failure must not send earlier items to the commit port");
} finally {
  process.chdir(originalCwd);
  await rm(typedOutputDir, { recursive: true, force: true });
}
