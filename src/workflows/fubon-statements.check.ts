import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2 } from "../ledger/canonical/fubon-domestic-deposit.ts";
import { queryCanonicalSourceCurrent } from "../ledger/canonical/canonical-source-store.ts";
import {
  buildFubonLoanPaymentAccountEvidence,
  readFubonDepositAccountOptions,
  runFubonStatements,
  type FubonDepositStatementEvidence,
  type FubonParsedDepositStatement,
} from "./fubon-statements.ts";
import {
  deriveFubonSourceConnectionKey,
  fubonStableLoginScope,
} from "./fubon-source-connection.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";

const depositTestScope = fubonStableLoginScope({
  fubon_user_id: "FUBON-DEPOSIT-TEST-USER",
  fubon_account: "FUBON-DEPOSIT-TEST-ACCOUNT",
})!;
const depositTestIdentity = {
  sourceConnectionScope: depositTestScope,
  sourceConnectionKey: deriveFubonSourceConnectionKey({
    fubon_user_id: "FUBON-DEPOSIT-TEST-USER",
    fubon_account: "FUBON-DEPOSIT-TEST-ACCOUNT",
  })!,
};

const source = await readFile(
  new URL("./fubon-statements.ts", import.meta.url),
  "utf8",
);
assert.match(source, /completeFubonHumanLogin/);
assert.doesNotMatch(source, /#btnLogin2/);
assert.doesNotMatch(source, /stageId: "fubon-login-captcha"/);
assert.doesNotMatch(source, /async function waitForSignedInState/);

const loginEntry = source.slice(
  source.indexOf("async function openLoginForm"),
  source.indexOf("function depositRows"),
);
assert.match(loginEntry, /openFubonLoginForm\(page\)/);
assert.doesNotMatch(
  loginEntry,
  /#menu_CDS|menu_CDS0102|task_CBOQU003|landingFrame\.goto|txnFrame\.goto/,
);
assert.match(
  source,
  /resolveLoanRepaymentRelations|resolveRelations/u,
  "a successful complete deposit capture must trigger the independent relation resolver",
);
assert.match(
  source,
  /fubon-deposit-relation-resolution-failed/u,
  "relation resolution failures must not withdraw a committed capture",
);
assert.doesNotMatch(
  source,
  /loanPaymentMatchCandidates|matchLoanPaymentsToDepositOutflows/u,
  "deposit workflow must not retain the obsolete date+amount matcher",
);
const depositCommitMarker = source.indexOf(
  "await commitCanonicalFubonDomesticDepositCapture(",
);
const depositResolverMarker = source.indexOf(
  "await resolveLoanRelationsAfterCapture(financialWriter",
);
assert.ok(
  depositCommitMarker >= 0 && depositResolverMarker > depositCommitMarker,
  "deposit relation resolution must happen after the canonical capture commit",
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
        { rowOrdinal: 2, cells: ["2026/08/17", "09:02:00", "放款繳款", "1.00", "", "98.00", "******7890"] },
        { rowOrdinal: 3, cells: ["2026/08/18", "09:03:00", "放款繳款", "7,603.00", "", "90.00", `${relationAccount}123456`] },
        { rowOrdinal: 4, cells: ["2026/08/18", "09:04:00", "放款繳款", "1.00", "", "89.00", `${relationAccount}12345`] },
        { rowOrdinal: 5, cells: ["2026/08/18", "09:05:00", "放款繳款", "1.00", "", "88.00", `${relationAccount}abc`] },
        { rowOrdinal: 6, cells: ["2026/08/18", "09:06:00", "放款繳款", "1.00", "", "87.00", `${relationAccount}foo bar`] },
        { rowOrdinal: 7, cells: ["2026/08/18", "09:07:00", "放款繳款", "1.00", "", "86.00", `${relationAccount} branch`] },
        { rowOrdinal: 8, cells: ["2026/08/18", "09:08:00", "放款繳款", "1.00", "", "85.00", relationAccount] },
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
assert.equal(relationEvidence.length, 2);
assert.equal(relationEvidence[0]!.accountValue, relationAccount);
assert.equal(relationEvidence[0]!.sourceRecordKey, "sha256:synthetic-row-0");
assert.equal(relationEvidence[1]!.accountValue, relationAccount);
assert.equal(relationEvidence[1]!.sourceRecordKey, "sha256:synthetic-row-3");
assert.equal(relationEvidence[0]!.role, "beneficiary");
assert.equal(relationEvidence[0]!.scope, "loan_contract");
assert.equal(relationEvidence[0]!.sourceField, "附註");
await assert.rejects(
  () =>
    runFubonStatements(
      {} as never,
      { dateRanges: ["30"], downloadFormat: "EXCEL" },
    ),
  /stable caller-supplied Source Connection scope and key/u,
);

const ledgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-source-workflow-"),
);
try {
  const fixture = FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2;
  const stableLogin = {
    fubon_user_id: "FUBON-USER-001",
    fubon_account: "FUBON-LOGIN-001",
  };
  const stableSourceConnectionScope = fubonStableLoginScope(stableLogin);
  const stableSourceConnectionKey = deriveFubonSourceConnectionKey(stableLogin);
  assert.ok(stableSourceConnectionScope);
  assert.ok(stableSourceConnectionKey);
  const statement: FubonParsedDepositStatement = {
    account: fixture.account.label,
    accountId: fixture.account.value,
    queryPeriod: "synthetic",
    branchName: fixture.account.branchName,
    rows: fixture.pages.flatMap((page) =>
      page.rows.map((row) => [...row.cells]),
    ),
    pages: fixture.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) => ({
        ...row,
        cells: [...row.cells] as typeof row.cells,
      })),
    })),
    accountOption: fixture.account,
  };
  const output = await runFubonStatements(
    {} as never,
    {
      dateRanges: ["30"],
      downloadFormat: "EXCEL",
    },
    {
      canonicalLedgerDir: ledgerDir,
      canonicalFinancialLedgerDir: ledgerDir,
      sourceConnectionScope: stableSourceConnectionScope,
      sourceConnectionKey: stableSourceConnectionKey,
      resolveLoanRepaymentRelations: async (store) => {
        assert.equal(
          store.db
            .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
            .get()?.count,
          1,
          "relation resolution must observe the committed deposit capture",
        );
        assert.equal(
          (
            store.db
              .prepare(
                "SELECT source_connection_key FROM source_connections WHERE integration_namespace = ?",
              )
              .get("fubon") as { source_connection_key?: string } | undefined
          )?.source_connection_key,
          stableSourceConnectionKey,
          "the workflow-supplied login identity must be persisted on the deposit connection",
        );
        throw new Error("synthetic relation resolver failure");
      },
      openTransactionDetailForAccountIndex: async () => "****0000",
      readDepositAccountOptions: async () => [fixture.account],
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async () => statement,
      writeDepositStatementFiles: async () => ({
        accountId: "****0000",
        account: "****0000",
        queryPeriods: ["synthetic"],
        branchName: fixture.account.branchName,
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
  assert.equal(output.count, 1);
  assert.equal(output.admissions[0]?.status, "financial-admitted");
  const sourceStorePath = join(ledgerDir, "canonical.sqlite");
  const { createCanonicalSourceStore } =
    await import("../ledger/canonical/canonical-source-store.ts");
  const store = createCanonicalSourceStore(sourceStorePath);
  try {
    const current = queryCanonicalSourceCurrent(store);
    assert.equal(current.status, "durable-source-evidence");
    assert.equal(current.records.length, 1);
    assert.equal(current.observations.length, 1);
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      1,
    );
    assert.equal(JSON.stringify(current).includes("SYNTHETIC DEPOSIT"), false);
  } finally {
    store.close();
  }
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}

// A source ledger override is not a financial opt-in. Evidence remains
// durable, while the financial transaction table stays empty.
const sourceOnlyLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-source-only-boundary-"),
);
try {
  const fixture = FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2;
  const statement: FubonParsedDepositStatement = {
    account: fixture.account.label,
    accountId: fixture.account.value,
    queryPeriod: "synthetic",
    branchName: fixture.account.branchName,
    rows: fixture.pages.flatMap((page) =>
      page.rows.map((row) => [...row.cells]),
    ),
    pages: fixture.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) => ({
        ...row,
        cells: [...row.cells] as typeof row.cells,
      })),
    })),
    accountOption: fixture.account,
  };
  const output = await runFubonStatements(
    {} as never,
    { dateRanges: ["30"], downloadFormat: "EXCEL" },
    {
      ...depositTestIdentity,
      canonicalLedgerDir: sourceOnlyLedgerDir,
      openTransactionDetailForAccountIndex: async () => "****0000",
      readDepositAccountOptions: async () => [fixture.account],
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async () => statement,
      writeDepositStatementFiles: async () => ({
        accountId: "****0000",
        account: "****0000",
        queryPeriods: ["synthetic"],
        branchName: fixture.account.branchName,
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
  assert.equal(output.admissions[0]?.status, "source-only");
  assert.equal(output.admissions[0]?.reason, "financial-ledger-not-configured");
  const sourceOnlyStore = (
    await import("../ledger/canonical/canonical-source-store.ts")
  ).createCanonicalSourceStore(join(sourceOnlyLedgerDir, "canonical.sqlite"));
  try {
    assert.equal(
      sourceOnlyStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      0,
    );
    assert.equal(
      queryCanonicalSourceCurrent(sourceOnlyStore).records.length,
      1,
    );
  } finally {
    sourceOnlyStore.close();
  }
} finally {
  await rm(sourceOnlyLedgerDir, { recursive: true, force: true });
}

// Malformed financial values are not a source-only downgrade: the workflow
// reports the admission error after preserving the independent source record.
const malformedLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-malformed-boundary-"),
);
try {
  const fixture = FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2;
  const malformedStatement: FubonParsedDepositStatement = {
    account: fixture.account.label,
    accountId: fixture.account.value,
    queryPeriod: "synthetic",
    branchName: fixture.account.branchName,
    rows: fixture.pages.flatMap((page) =>
      page.rows.map((row) => [...row.cells]),
    ),
    pages: fixture.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) => ({
        ...row,
        cells: [
          row.cells[0],
          row.cells[1],
          row.cells[2],
          "not-an-amount",
          row.cells[4],
          row.cells[5],
          row.cells[6],
        ] as typeof row.cells,
      })),
    })),
    accountOption: fixture.account,
  };
  await assert.rejects(
    () =>
      runFubonStatements(
        {} as never,
        { dateRanges: ["30"], downloadFormat: "EXCEL" },
        {
          ...depositTestIdentity,
          canonicalLedgerDir: malformedLedgerDir,
          canonicalFinancialLedgerDir: malformedLedgerDir,
          openTransactionDetailForAccountIndex: async () => "****0000",
          readDepositAccountOptions: async () => [fixture.account],
          selectDepositAccount: async () => undefined,
          fetchDepositStatement: async () => malformedStatement,
          writeDepositStatementFiles: async () => ({
            accountId: "****0000",
            account: "****0000",
            queryPeriods: ["synthetic"],
            branchName: fixture.account.branchName,
            baseName: "malformed",
            csvFilename: "malformed.csv",
            csvPath: "malformed.csv",
            csvBytes: 0,
            jsonFilename: "malformed.json",
            jsonPath: "malformed.json",
            jsonBytes: 0,
            rowCount: malformedStatement.rows.length,
          }),
        },
      ),
    /amount-invalid|amount-sign-invalid|financial admission failed/i,
  );
} finally {
  await rm(malformedLedgerDir, { recursive: true, force: true });
}

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

  constructor(items: FakeOption[]) {
    this.items = items;
  }

  async count(): Promise<number> {
    return this.items.length;
  }

  nth(index: number): FakeOption {
    return this.items[index]!;
  }
}

function fakeDepositPage(
  options: Array<{ value: string; label: string; failure?: Error }>,
) {
  const list = new FakeOptionList(
    options.map(
      (option) => new FakeOption(option.value, option.label, option.failure),
    ),
  );
  const select = {
    async count() {
      return 1;
    },
    locator() {
      return list;
    },
  };
  return {
    locator(selector: string) {
      return selector.endsWith(" option") ? list : select;
    },
    frames() {
      return [];
    },
    async waitForTimeout() {},
  } as never;
}

const absentAccountError = await assert.rejects(
  () => readFubonDepositAccountOptions(fakeDepositPage([])),
  (error: unknown) =>
    error instanceof StatementComponentAbsentError &&
    error.skipReason === "absent",
);
assert.equal(absentAccountError, undefined);

await assert.rejects(
  () =>
    readFubonDepositAccountOptions(
      fakeDepositPage([
        { value: "none", label: "請選擇帳戶" },
        { value: "", label: "" },
      ]),
    ),
  (error: unknown) =>
    error instanceof StatementComponentAbsentError &&
    error.skipReason === "absent",
);

const validPage = fakeDepositPage([
  { value: "SYNTHETIC-TWD-A", label: "SYNTHETIC-TWD-A (012)" },
  { value: "none", label: "請選擇帳戶" },
]);
assert.deepEqual(await readFubonDepositAccountOptions(validPage), [
  { value: "SYNTHETIC-TWD-A", label: "SYNTHETIC-TWD-A (012)" },
]);

const zeroStatement: FubonParsedDepositStatement = {
  account: "SYNTHETIC-TWD-A (012)",
  accountId: "SYNTHETIC-TWD-A",
  queryPeriod: "2026/01/01~2026/01/31",
  branchName: "012",
  rows: [],
  pages: [
    {
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      queryRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
      selectedAccount: {
        value: "SYNTHETIC-TWD-A",
        label: "SYNTHETIC-TWD-A (012)",
        branchName: "012",
      },
      providerPageSize: 10,
      rows: [],
      zeroObservation: "empty-page",
    },
  ],
  accountOption: {
    value: "SYNTHETIC-TWD-A",
    label: "SYNTHETIC-TWD-A (012)",
    branchName: "012",
  },
};
const zeroLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-zero-ledger-"),
);
const zeroOutput = await runFubonStatements(
  validPage,
  { dateRanges: ["1"], downloadFormat: "EXCEL" },
  {
    ...depositTestIdentity,
    canonicalLedgerDir: zeroLedgerDir,
    openTransactionDetailForAccountIndex: async () => "********9012",
    selectDepositAccount: async () => undefined,
    fetchDepositStatement: async () => zeroStatement,
    writeDepositStatementFiles: async () => ({
      accountId: "********9012",
      account: "********9012",
      queryPeriods: [zeroStatement.queryPeriod],
      branchName: zeroStatement.branchName,
      baseName: "zero",
      csvFilename: "zero.csv",
      csvPath: "zero.csv",
      csvBytes: 0,
      jsonFilename: "zero.json",
      jsonPath: "zero.json",
      jsonBytes: 0,
      rowCount: 0,
    }),
  },
);
assert.equal(zeroOutput.count, 1);
assert.equal(zeroOutput.downloads[0]?.rowCount, 0);
await rm(zeroLedgerDir, { recursive: true, force: true });

const incompleteStatement: FubonParsedDepositStatement = {
  ...zeroStatement,
  rows: [["2026/01/02", "09:10:11", "INCOMPLETE", "", "100", "100", ""]],
  pages: [
    {
      ...zeroStatement.pages[0]!,
      providerPageSize: 1,
      rows: [
        {
          rowOrdinal: 0,
          cells: ["2026/01/02", "09:10:11", "INCOMPLETE", "", "100", "100", ""],
        },
      ],
      zeroObservation: "non-empty-page",
    },
  ],
};
const incompleteLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-incomplete-scope-"),
);
try {
  const incompleteOutput = await runFubonStatements(
    validPage,
    { dateRanges: ["1"], downloadFormat: "EXCEL" },
    {
      ...depositTestIdentity,
      canonicalLedgerDir: incompleteLedgerDir,
      openTransactionDetailForAccountIndex: async () => "********9012",
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async () => incompleteStatement,
      writeDepositStatementFiles: async () => ({
        accountId: "********9012",
        account: "********9012",
        queryPeriods: [incompleteStatement.queryPeriod],
        branchName: incompleteStatement.branchName,
        baseName: "incomplete",
        csvFilename: "incomplete.csv",
        csvPath: "incomplete.csv",
        csvBytes: 0,
        jsonFilename: "incomplete.json",
        jsonPath: "incomplete.json",
        jsonBytes: 0,
        rowCount: incompleteStatement.rows.length,
      }),
    },
  );
  assert.equal(incompleteOutput.admissions[0]?.status, "source-only");
  assert.match(
    incompleteOutput.admissions[0]?.reason ?? "",
    /incomplete-scope/,
  );
} finally {
  await rm(incompleteLedgerDir, { recursive: true, force: true });
}

await assert.rejects(
  () =>
    readFubonDepositAccountOptions(
      fakeDepositPage([
        {
          value: "SYNTHETIC-TWD-A",
          label: "SYNTHETIC-TWD-A (012)",
          failure: new Error("unknown option read failure"),
        },
      ]),
    ),
  /unknown option read failure/,
);
