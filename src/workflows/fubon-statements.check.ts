import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
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
  createPGliteChildRpcServer,
  type PGliteChildProvider,
} from "../../electron/pglite-child-rpc.ts";
import { createPGliteViewWorkerClient } from "../../electron/pglite-view-worker-client.ts";

const source = await readFile(
  new URL("./fubon-statements.ts", import.meta.url),
  "utf8",
);
assert.match(source, /completeFubonHumanLogin/);
assert.doesNotMatch(source, /#btnLogin2/);
assert.doesNotMatch(source, /stageId: "fubon-login-captcha"/);
assert.doesNotMatch(source, /async function waitForSignedInState/);
assert.match(source, /executePGliteWorkflowRun\(/);
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
    },
    records: relationEvidenceCapture.pages[0]!.rows.map((row) => ({
      occurrenceKey: `sha256:synthetic-row-${row.rowOrdinal}`,
      compactJson: JSON.stringify({ pageOrdinal: 0, rowOrdinal: row.rowOrdinal }),
    })),
  },
);
assert.equal(relationEvidence.length, 1);
assert.equal(relationEvidence[0]!.accountValue, relationAccount);
assert.equal(relationEvidence[0]!.sourceRecordKey, "sha256:synthetic-row-0");
assert.equal(relationEvidence[0]!.role, "beneficiary");
assert.equal(relationEvidence[0]!.scope, "loan_contract");
assert.equal(relationEvidence[0]!.sourceField, "附註");
await assert.rejects(
  () => runFubonStatements({} as never, { dateRanges: ["30"], downloadFormat: "EXCEL" }),
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

const pgliteRunDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "fubon-pglite-workflow-"));
const pgliteWorker = createPGliteViewWorkerClient(new Worker(
  new URL("../../electron/pglite-view-worker.ts", import.meta.url),
  {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir: join(pgliteRunDir, "pglite") },
  },
));
const pgliteServer = createPGliteChildRpcServer({
  provider: {
    operational: pgliteWorker.operationalProvider,
    financial: pgliteWorker.financial.registry,
  } as PGliteChildProvider,
});
const previousEnvironment = Object.fromEntries(
  Object.keys(pgliteServer.env).map((key) => [key, process.env[key]]),
);
try {
  await pgliteServer.ready;
  Object.assign(process.env, pgliteServer.env);

  const fixture = FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2;
  const selectedAccount = accountOption;
  const statement: FubonParsedDepositStatement = {
    account: selectedAccount.label,
    accountId: selectedAccount.value,
    queryPeriod: "synthetic",
    branchName: selectedAccount.branchName,
    rows: fixture.pages.flatMap((page) => page.rows.map((row) => {
      const cells = [...row.cells];
      if (row.rowOrdinal === 0) {
        cells[2] = "放款繳款";
        cells[6] = relationAccount;
      }
      return cells;
    })),
    pages: fixture.pages.map((page) => ({
      ...page,
      selectedAccount,
      rows: page.rows.map((row) => {
        const cells = [...row.cells] as [string, string, string, string, string, string, string];
        if (row.rowOrdinal === 0) {
          cells[2] = "放款繳款";
          cells[6] = relationAccount;
        }
        return { ...row, cells };
      }),
    })),
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
  const output = await runFubonStatements(
    {} as never,
    { dateRanges: ["30"], downloadFormat: "EXCEL" },
    {
      sourceConnectionScope,
      sourceConnectionKey,
      readCurrentDepositBalances: async () => [currentBalanceRow],
      openTransactionDetailForAccountIndex: async () => "****0000",
      readDepositAccountOptions: async () => [selectedAccount],
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async () => statement,
      writeDepositStatementFiles: async () => ({
        accountId: "****0000",
        account: "****0000",
        queryPeriods: ["synthetic"],
        branchName: selectedAccount.branchName,
        baseName: "synthetic",
        csvFilename: "synthetic.csv",
        csvPath: "synthetic.csv",
        csvBytes: 0,
        jsonFilename: "synthetic.json",
        jsonPath: "synthetic.json",
        jsonBytes: 0,
        rowCount: statement.rows.length,
      }),
    },
  );
  assert.equal(output.admissions[0]?.status, "financial-admitted");
  const overview = await pgliteWorker.financial.registry.overviewCurrent();
  assert.equal(overview.accounts.length, 1);
  assert.equal(overview.accounts[0]?.transactionCount, 1);
  assert.equal(overview.accounts[0]?.valueAvailability, "available");

  const typedOutputDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "fubon-collect-only-"));
  const originalCwd = process.cwd();
  process.chdir(typedOutputDir);
  try {
    const deferredItems: PGliteWorkflowRunItem[] = [];
    const typedResult = await runFubonStatements(
      {} as never,
      { dateRanges: ["30"], downloadFormat: "EXCEL" },
      {
        sourceConnectionScope,
        sourceConnectionKey,
        readCurrentDepositBalances: async () => [currentBalanceRow],
        openTransactionDetailForAccountIndex: async () => "****0000",
        readDepositAccountOptions: async () => [selectedAccount],
        selectDepositAccount: async () => undefined,
        fetchDepositStatement: async () => statement,
        writeDepositStatementFiles: async () => {
          throw new Error("collect-only workflow attempted file output");
        },
        deferredCommitItems: deferredItems,
        collectOnly: true,
        sourceText: strictSourceText,
        signal: new AbortController().signal,
      },
    );
    assert.ok(typedResult.itemCount > 0);
    assert.equal(deferredItems.length, typedResult.itemCount);
    assert.deepEqual(await readdir(typedOutputDir), [], "collect-only path must not write CSV/JSON/log files");
  } finally {
    process.chdir(originalCwd);
    await rm(typedOutputDir, { recursive: true, force: true });
  }

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
  await assert.rejects(
    () => runFubonStatements(
      {} as never,
      { dateRanges: ["30"], downloadFormat: "EXCEL" },
      {
        sourceConnectionScope,
        sourceConnectionKey,
        readCurrentDepositBalances: async () => [],
        openTransactionDetailForAccountIndex: async () => "****0000",
        readDepositAccountOptions: async () => [selectedAccount],
        selectDepositAccount: async () => undefined,
        fetchDepositStatement: async () => malformedStatement,
        writeDepositStatementFiles: async () => ({
          accountId: "****0000", account: "****0000", queryPeriods: ["synthetic"],
          branchName: selectedAccount.branchName, baseName: "malformed",
          csvFilename: "malformed.csv", csvPath: "malformed.csv", csvBytes: 0,
          jsonFilename: "malformed.json", jsonPath: "malformed.json", jsonBytes: 0,
          rowCount: malformedStatement.rows.length,
        }),
      },
    ),
    /amount-invalid|amount-sign-invalid|financial admission failed/iu,
  );

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
  const incompleteOutput = await runFubonStatements(
    {} as never,
    { dateRanges: ["1"], downloadFormat: "EXCEL" },
    {
      sourceConnectionScope,
      sourceConnectionKey,
      readCurrentDepositBalances: async () => [],
      openTransactionDetailForAccountIndex: async () => "********9012",
      readDepositAccountOptions: async () => [incompleteAccount],
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async () => incompleteStatement,
      writeDepositStatementFiles: async () => ({
        accountId: "********9012", account: "********9012",
        queryPeriods: [incompleteStatement.queryPeriod],
        branchName: incompleteAccount.branchName, baseName: "incomplete",
        csvFilename: "incomplete.csv", csvPath: "incomplete.csv", csvBytes: 0,
        jsonFilename: "incomplete.json", jsonPath: "incomplete.json", jsonBytes: 0,
        rowCount: incompleteStatement.rows.length,
      }),
    },
  );
  assert.equal(incompleteOutput.admissions[0]?.status, "source-only");
  assert.match(incompleteOutput.admissions[0]?.reason ?? "", /incomplete-scope/u);
  assert.equal(
    (await pgliteWorker.financial.registry.overviewCurrent()).accounts[0]?.transactionCount,
    1,
    "source-only evidence is admitted without adding financial transactions",
  );

  const laterAccount = {
    value: "00987654321098",
    label: "00987654321098 (013)",
    branchName: "013",
  };
  await assert.rejects(
    () => runFubonStatements(
      {} as never,
      { dateRanges: ["30"], downloadFormat: "EXCEL" },
      {
        sourceConnectionScope,
        sourceConnectionKey,
        readCurrentDepositBalances: async () => [],
        openTransactionDetailForAccountIndex: async () => "****0000",
        readDepositAccountOptions: async () => [selectedAccount, laterAccount],
        selectDepositAccount: async () => undefined,
        fetchDepositStatement: async (_page, _range, account) => {
          if (account.value === laterAccount.value)
            throw new Error("synthetic later-account fetch failure");
          return statement;
        },
        writeDepositStatementFiles: async () => ({
          accountId: "****0000", account: "****0000", queryPeriods: ["synthetic"],
          branchName: selectedAccount.branchName, baseName: "rollback",
          csvFilename: "rollback.csv", csvPath: "rollback.csv", csvBytes: 0,
          jsonFilename: "rollback.json", jsonPath: "rollback.json", jsonBytes: 0,
          rowCount: statement.rows.length,
        }),
      },
    ),
    /later-account fetch failure/iu,
  );
  assert.equal(
    (await pgliteWorker.financial.registry.overviewCurrent()).accounts[0]?.transactionCount,
    1,
    "a failure while preparing a later account does not commit an earlier account",
  );
} finally {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await pgliteServer.close();
  await pgliteWorker.close();
  await rm(pgliteRunDir, { recursive: true, force: true });
}
