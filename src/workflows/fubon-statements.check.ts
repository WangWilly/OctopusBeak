import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2 } from "../ledger/canonical/fubon-domestic-deposit.ts";
import { queryCanonicalSourceCurrent } from "../ledger/canonical/canonical-source-store.ts";
import {
  buildFubonLoanPaymentAccountEvidence,
  buildFubonCurrentDepositBalanceCapture,
  indexFubonCurrentDepositFinancialCaptures,
  readFubonDepositAccountOptions,
  parseFubonDepositPaginationSignal,
  runFubonStatements,
  type FubonDepositStatementEvidence,
  type FubonParsedDepositStatement,
} from "./fubon-statements.ts";
import {
  deriveFubonSourceConnectionKey,
  fubonStableLoginScope,
} from "./fubon-source-connection.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";

const joinDigits = (...segments: string[]) => segments.join("");
const fubonCurrentAccountNumber = joinDigits("0012", "3456", "7890", "12");

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

const fubonCurrentCapture = buildFubonCurrentDepositBalanceCapture(
  {
    source: "fubon",
    accountNumber: fubonCurrentAccountNumber,
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
      endpoint: "/B2C/cboqu/cboqu003/CBOQU003_Home.faces",
      status: 200,
      cacheControl: "no-store, no-cache",
      contractVersion: "fubon/current-deposit-balance-v1",
    },
  },
  {
    identity: {
      sourceConnectionKey: "sha256:fubon-current-connection",
      identityEpochKey: "sha256:fubon-current-epoch",
      subjectDigest: "sha256:fubon-current-subject",
      accountNo: "sha256:fubon-current-account",
      sourceAccountKey: "sha256:fubon-current-account",
      accountNumber: { value: fubonCurrentAccountNumber },
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
    accountNumber: { value: fubonCurrentAccountNumber },
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
const depositCommitMarker = source.indexOf(
  "executeCanonicalFinancialCommitRun({",
);
const depositResolverMarker = source.indexOf(
  "resolveRelations: async ({ writer })",
);
assert.ok(
  depositCommitMarker >= 0 && depositResolverMarker >= 0,
  "deposit relation resolution must be owned by the execution item",
);

const relationAccount = joinDigits("0123", "4567", "8901", "23");
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
      sourceConnectionScope: stableSourceConnectionScope,
      sourceConnectionKey: stableSourceConnectionKey,
      readCurrentDepositBalances: async () => [],
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
  const store = createCanonicalSourceStore(ledgerDir);
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

  const rollbackLedgerDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "fubon-later-account-rollback-"),
  );
  try {
    const laterAccount = {
      ...fixture.account,
      value: "FUBON-ACCOUNT-002",
      label: "FUBON-ACCOUNT-002 (012)",
    };
    const statementFor = (
      account: typeof fixture.account,
    ): FubonParsedDepositStatement => ({
      ...statement,
      account: account.label,
      accountId: account.value,
      accountOption: account,
      pages: statement.pages.map((page) => ({
        ...page,
        selectedAccount: account,
      })),
    });
    await assert.rejects(
      () =>
        runFubonStatements(
          {} as never,
          { dateRanges: ["30"], downloadFormat: "EXCEL" },
          {
            canonicalLedgerDir: rollbackLedgerDir,
            sourceConnectionScope: stableSourceConnectionScope,
            sourceConnectionKey: stableSourceConnectionKey,
            readCurrentDepositBalances: async () => [],
            openTransactionDetailForAccountIndex: async () => "****0000",
            readDepositAccountOptions: async () => [fixture.account, laterAccount],
            selectDepositAccount: async () => undefined,
            fetchDepositStatement: async (_page, _range, account) => {
              if (account?.value === laterAccount.value)
                throw new Error("synthetic later-account fetch failure");
              return statementFor(fixture.account);
            },
            writeDepositStatementFiles: async () => ({
              accountId: "****0000",
              account: "****0000",
              queryPeriods: ["synthetic"],
              branchName: fixture.account.branchName,
              baseName: "rollback",
              csvFilename: "rollback.csv",
              csvPath: "rollback.csv",
              csvBytes: 0,
              jsonFilename: "rollback.json",
              jsonPath: "rollback.json",
              jsonBytes: 0,
              rowCount: statement.rows.length,
            }),
          },
        ),
      /later-account fetch failure/i,
    );
    const rollbackStore = createCanonicalSourceStore(rollbackLedgerDir);
    try {
      assert.equal(
        rollbackStore.db
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get()?.count,
        0,
      );
      assert.equal(
        rollbackStore.db
          .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
          .get()?.count,
        0,
      );
      assert.equal(
        rollbackStore.db
          .prepare("SELECT COUNT(*) AS count FROM source_sync_states")
          .get()?.count,
        0,
      );
    } finally {
      rollbackStore.close();
    }
  } finally {
    await rm(rollbackLedgerDir, { recursive: true, force: true });
  }

  const multiAccountLedgerDir = join(ledgerDir, "multi-account");
  const secondAccount = {
    ...fixture.account,
    value: "SYNTHETIC-FUBON-ACCOUNT-002",
    label: "SYNTHETIC FUBON ACCOUNT 002 (013)",
    branchName: "013",
  };
  const statementForAccount = (
    account: typeof fixture.account,
  ): FubonParsedDepositStatement => ({
    ...statement,
    account: account.label,
    accountId: account.value,
    branchName: account.branchName,
    accountOption: account,
    pages: statement.pages.map((page) => ({
      ...page,
      selectedAccount: account,
    })),
  });
  const runMultiAccount = () =>
    runFubonStatements(
      {} as never,
      { dateRanges: ["30"], downloadFormat: "EXCEL" },
      {
        canonicalLedgerDir: multiAccountLedgerDir,
        sourceConnectionScope: stableSourceConnectionScope,
        sourceConnectionKey: stableSourceConnectionKey,
        readCurrentDepositBalances: async () => [],
        openTransactionDetailForAccountIndex: async () => "****0000",
        readDepositAccountOptions: async () => [fixture.account, secondAccount],
        selectDepositAccount: async () => undefined,
        fetchDepositStatement: async (_page, _range, account) =>
          statementForAccount(account as typeof fixture.account),
        writeDepositStatementFiles: async (statements) => ({
          accountId: statements[0]!.accountId,
          account: statements[0]!.account,
          queryPeriods: statements.map((item) => item.queryPeriod),
          branchName: statements[0]!.branchName,
          baseName: `fubon-${statements[0]!.accountId}`,
          csvFilename: `fubon-${statements[0]!.accountId}.csv`,
          csvPath: `fubon-${statements[0]!.accountId}.csv`,
          csvBytes: 0,
          jsonFilename: `fubon-${statements[0]!.accountId}.json`,
          jsonPath: `fubon-${statements[0]!.accountId}.json`,
          jsonBytes: 0,
          rowCount: statements.reduce((count, item) => count + item.rows.length, 0),
        }),
      },
    );
  assert.equal((await runMultiAccount()).admissions.length, 2);
  assert.equal((await runMultiAccount()).admissions.length, 2);
  const multiAccountStore = createCanonicalSourceStore(multiAccountLedgerDir);
  try {
    assert.equal(
      multiAccountStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      2,
      "a successful Fubon multi-account batch commits both accounts and repeat runs stay idempotent",
    );
  } finally {
    multiAccountStore.close();
  }

} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}

// A single canonical ledger owns both source evidence and financial facts.
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
      readCurrentDepositBalances: async () => [],
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
  assert.equal(output.admissions[0]?.status, "financial-admitted");
  assert.equal(output.admissions[0]?.reason, null);
  const sourceOnlyStore = (
    await import("../ledger/canonical/canonical-source-store.ts")
  ).createCanonicalSourceStore(sourceOnlyLedgerDir);
  try {
    assert.equal(
      sourceOnlyStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      1,
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

// Every account in one run must retain every disjoint query range.  The
// provider has to be queried twice for Fubon's one-year view, but those
// captures must compose in the canonical projection instead of leaving each
// account with whichever half-range happened to be admitted last.
const multiRangeLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-multi-range-"),
);
try {
  const firstMultiRangeAccount = joinDigits("0012", "3456", "7890", "12");
  const secondMultiRangeAccount = joinDigits("0098", "7654", "3210", "98");
  const accounts = [
    { value: firstMultiRangeAccount, label: `${firstMultiRangeAccount} (012)` },
    { value: secondMultiRangeAccount, label: `${secondMultiRangeAccount} (012)` },
  ];
  const ranges: Record<
    "180" | "180_365",
    {
      startDate: string;
      endDate: string;
      rows: string[][];
      providerPageSize?: number;
      providerTotalCount?: number;
    }
  > = {
    "180": {
      startDate: "2026/03/13",
      endDate: "2026/09/13",
      rows: Array.from({ length: 48 }, (_, index) => [
        "2026/07/01",
        `09:${String(index).padStart(2, "0")}:00`,
        `NEW-RANGE-${index}`,
        "10.00",
        "",
        `${90 - index}.00`,
        "",
      ]),
      providerPageSize: 48,
    },
    "180_365": {
      startDate: "2025/09/13",
      endDate: "2026/03/13",
      rows: [
        // A provider status marker must remain source evidence, but it must
        // not poison the clean financial rows from this requested range.
        ["2026/02/01", "10:00:00", "沖正行動", "5.00", "", "65.00", ""],
        ["2026/01/01", "09:00:00", "OLD-RANGE", "20.00", "", "70.00", ""],
      ],
      providerPageSize: 10,
    },
  };
  const statementFor = (
    account: (typeof accounts)[number],
    rangeCode: keyof typeof ranges,
  ): FubonParsedDepositStatement => {
    const range = ranges[rangeCode];
    const accountOption = {
      value: account.value,
      label: account.label,
      branchName: "012",
    };
    return {
      account: account.label,
      accountId: account.value,
      queryPeriod: `${range.startDate}~${range.endDate}`,
      branchName: accountOption.branchName,
      rows: range.rows,
      pages: [
        {
          pageOrdinal: 0,
          responseSequence: 1,
          terminal: true,
          nextPage: null,
          pageFieldName: null,
          queryRange: {
            startDate: range.startDate,
            endDate: range.endDate,
          },
          selectedAccount: accountOption,
          ...(range.providerPageSize !== undefined
            ? { providerPageSize: range.providerPageSize }
            : {}),
          ...(range.providerTotalCount !== undefined
            ? { providerTotalCount: range.providerTotalCount }
            : {}),
          ...(rangeCode === "180"
            ? { paginationEvidence: "terminal-no-next" as const }
            : {}),
          rows: range.rows.map((row, rowOrdinal) => ({
            rowOrdinal,
            cells: [...row] as [string, string, string, string, string, string, string],
          })),
          zeroObservation: "non-empty-page",
        },
      ],
      accountOption,
    };
  };
  const multiRangeOutput = await runFubonStatements(
    {} as never,
    { dateRanges: ["180", "180_365"], downloadFormat: "EXCEL" },
    {
      ...depositTestIdentity,
      canonicalLedgerDir: multiRangeLedgerDir,
      openTransactionDetailForAccountIndex: async () => "****1098",
      readDepositAccountOptions: async () => accounts,
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async (_page, rangeCode, account) => {
        if (rangeCode !== "180" && rangeCode !== "180_365")
          throw new Error(`unexpected range ${rangeCode}`);
        return statementFor(
          accounts.find((candidate) => candidate.value === account.value)!,
          rangeCode,
        );
      },
      writeDepositStatementFiles: async (statements) => ({
        accountId: statements[0]!.accountId,
        account: statements[0]!.account,
        queryPeriods: statements.map((statement) => statement.queryPeriod),
        branchName: statements[0]!.branchName,
        baseName: "multi-range",
        csvFilename: "multi-range.csv",
        csvPath: "multi-range.csv",
        csvBytes: 0,
        jsonFilename: "multi-range.json",
        jsonPath: "multi-range.json",
        jsonBytes: 0,
        rowCount: statements.reduce((count, statement) => count + statement.rows.length, 0),
      }),
      readCurrentDepositBalances: async () => [],
      resolveLoanRepaymentRelations: async () => ({
        status: "canonical-live" as const,
        outcome: "no-admission" as const,
        resolutionId: null,
        exactRelationIds: [],
        settlementGroupIds: [],
      }),
    },
  );
  assert.deepEqual(
    multiRangeOutput.admissions.map((admission) => admission.status),
    ["financial-admitted", "financial-admitted"],
  );
  const { createCanonicalSourceStore } =
    await import("../ledger/canonical/canonical-source-store.ts");
  const multiRangeStore = createCanonicalSourceStore(multiRangeLedgerDir);
  try {
    const currentRows = multiRangeStore.db
      .prepare(
        `SELECT account.source_account_key AS accountKey, revision.effective_on AS effectiveOn
           FROM financial_accounts account
           JOIN financial_transactions transaction_row
             ON transaction_row.account_id = account.account_id
           JOIN current_transactions current_row
             ON current_row.transaction_id = transaction_row.transaction_id
           JOIN transaction_revisions revision
             ON revision.revision_id = current_row.revision_id
          WHERE account.stream = 'domestic-deposit'
          ORDER BY account.source_account_key, revision.effective_on`,
      )
      .all() as Array<{
      accountKey?: string;
      effectiveOn?: string;
    }>;
    const datesByAccount = new Map<string, string[]>();
    for (const row of currentRows) {
      const accountKey = row.accountKey;
      const effectiveOn = row.effectiveOn;
      if (!accountKey || !effectiveOn) continue;
      datesByAccount.set(accountKey, [
        ...(datesByAccount.get(accountKey) ?? []),
        effectiveOn,
      ]);
    }
    assert.equal(datesByAccount.size, 2);
    for (const dates of datesByAccount.values()) {
      assert.equal(
        dates.filter((date) => date === "2026-01-01").length,
        1,
      );
      assert.equal(
        dates.filter((date) => date === "2026-07-01").length,
        48,
      );
    }
  } finally {
    multiRangeStore.close();
  }
} finally {
  await rm(multiRangeLedgerDir, { recursive: true, force: true });
}

// Reproduce the four live Fubon shapes: two domestic accounts queried over
// the same two half-year ranges, with each response ending in a different
// row count. The 48-row page has an exact page-size/terminal proof; the
// shorter pages have no provider terminal proof but must still be treated as
// transport-terminal so their rows reach canonical admission.
const fourShapeLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-four-shape-")
);
try {
  const firstFourShapeAccount = joinDigits("0067", "0168", "0727", "38");
  const secondFourShapeAccount = joinDigits("8168", "0003", "3074", "30");
  const accounts = [
    { value: firstFourShapeAccount, label: `${firstFourShapeAccount} (012)` },
    { value: secondFourShapeAccount, label: `${secondFourShapeAccount} (012)` },
  ];
  const shapeRows = (
    account: (typeof accounts)[number],
    rangeCode: "180" | "180_365",
    count: number,
    statusRow: boolean,
  ): string[][] =>
    Array.from({ length: count }, (_, index) => {
      const date = rangeCode === "180" ? "2026/07/01" : "2026/01/01";
      const description =
        statusRow && index === 0
          ? "沖正行動"
          : `FOUR-SHAPE-${account.value}-${rangeCode}-${index}`;
      const note = statusRow && index === 0 ? "provider-status" : "";
      return [
        date,
        `${rangeCode === "180" ? "08" : "09"}:${String(index % 60).padStart(2, "0")}:00`,
        description,
        "10.00",
        "",
        `${10000 - index}.00`,
        note,
      ];
    });
  const shapes = new Map<string, {
    rangeCode: "180" | "180_365";
    startDate: string;
    endDate: string;
    count: number;
    statusRow: boolean;
    exactTerminal: boolean;
  }>([
    [`${firstFourShapeAccount}:180`, {
      rangeCode: "180",
      startDate: "2026/03/13",
      endDate: "2026/09/13",
      count: 21,
      statusRow: false,
      exactTerminal: false,
    }],
    [`${firstFourShapeAccount}:180_365`, {
      rangeCode: "180_365",
      startDate: "2025/09/13",
      endDate: "2026/03/13",
      count: 27,
      statusRow: true,
      exactTerminal: false,
    }],
    [`${secondFourShapeAccount}:180`, {
      rangeCode: "180",
      startDate: "2026/03/13",
      endDate: "2026/09/13",
      count: 48,
      statusRow: false,
      exactTerminal: true,
    }],
    [`${secondFourShapeAccount}:180_365`, {
      rangeCode: "180_365",
      startDate: "2025/09/13",
      endDate: "2026/03/13",
      count: 38,
      statusRow: true,
      exactTerminal: false,
    }],
  ]);
  const statementFor = (
    account: (typeof accounts)[number],
    rangeCode: "180" | "180_365",
  ): FubonParsedDepositStatement => {
    const shape = shapes.get(`${account.value}:${rangeCode}`);
    if (!shape) throw new Error("missing Fubon four-shape fixture");
    const accountOption = { ...account, branchName: "012" };
    const rows = shapeRows(account, rangeCode, shape.count, shape.statusRow);
    const pagination = parseFubonDepositPaginationSignal(
      `<form id="form1"><input name="resultGrid:dataGridCurrentPageSize" value="48"><table id="resultGrid" class="tb1 queryResult"><tr>${[
        "帳務日期",
        "交易時間",
        "摘要",
        "支出金額",
        "存入金額",
        "即時餘額",
        "附註",
      ].map((header) => `<th>${header}</th>`).join("")}</tr></table>${
        shape.exactTerminal ? "" : "<a>下一頁</a>"
      }</form>`,
      rows.length,
    );
    return {
      account: account.label,
      accountId: account.value,
      queryPeriod: `${shape.startDate}~${shape.endDate}`,
      branchName: "012",
      rows,
      pages: [{
        pageOrdinal: 0,
        responseSequence: 1,
        terminal: pagination.terminal,
        nextPage: pagination.nextPage,
        pageFieldName: pagination.pageFieldName,
        ...(pagination.evidence !== null
          ? { paginationEvidence: pagination.evidence }
          : {}),
        ...(pagination.paginationAmbiguous === true
          ? { paginationAmbiguous: true as const }
          : {}),
        ...(pagination.paginationAmbiguityReason !== undefined
          ? { paginationAmbiguityReason: pagination.paginationAmbiguityReason }
          : {}),
        queryRange: { startDate: shape.startDate, endDate: shape.endDate },
        selectedAccount: accountOption,
        providerPageSize: 48,
        rows: rows.map((row, rowOrdinal) => ({
          rowOrdinal,
          cells: [...row] as [string, string, string, string, string, string, string],
        })),
        zeroObservation: "non-empty-page",
      }],
      accountOption,
    };
  };
  const output = await runFubonStatements(
    {} as never,
    { dateRanges: ["180", "180_365"], downloadFormat: "EXCEL" },
    {
      ...depositTestIdentity,
      canonicalLedgerDir: fourShapeLedgerDir,
      openTransactionDetailForAccountIndex: async () => "****2738",
      readDepositAccountOptions: async () => accounts,
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async (_page, rangeCode, account) => {
        if (rangeCode !== "180" && rangeCode !== "180_365")
          throw new Error(`unexpected range ${rangeCode}`);
        return statementFor(account, rangeCode);
      },
      writeDepositStatementFiles: async (statements) => ({
        accountId: statements[0]!.accountId,
        account: statements[0]!.account,
        queryPeriods: statements.map((statement) => statement.queryPeriod),
        branchName: statements[0]!.branchName,
        baseName: "four-shape",
        csvFilename: "four-shape.csv",
        csvPath: "four-shape.csv",
        csvBytes: 0,
        jsonFilename: "four-shape.json",
        jsonPath: "four-shape.json",
        jsonBytes: 0,
        rowCount: statements.reduce(
          (count, statement) => count + statement.rows.length,
          0,
        ),
      }),
      readCurrentDepositBalances: async () => [],
      resolveLoanRepaymentRelations: async () => ({
        status: "canonical-live" as const,
        outcome: "no-admission" as const,
        resolutionId: null,
        exactRelationIds: [],
        settlementGroupIds: [],
      }),
    },
  );
  assert.deepEqual(
    output.admissions.map((admission) => admission.status),
    ["financial-admitted", "financial-admitted"],
  );
  const fourShapeStore = (
    await import("../ledger/canonical/canonical-source-store.ts")
  ).createCanonicalSourceStore(fourShapeLedgerDir);
  try {
    const rowsByAccount = fourShapeStore.db
      .prepare(
        `SELECT account.source_account_key AS accountKey,
                COUNT(*) AS rowCount
           FROM financial_accounts account
           JOIN financial_transactions transaction_row
             ON transaction_row.account_id = account.account_id
           JOIN current_transactions current_row
             ON current_row.transaction_id = transaction_row.transaction_id
          WHERE account.stream = 'domestic-deposit'
          GROUP BY account.source_account_key
          ORDER BY account.source_account_key`,
      )
      .all() as Array<{ accountKey?: string; rowCount?: number }>;
    assert.equal(rowsByAccount.length, 2);
    assert.deepEqual(
      rowsByAccount.map((row) => row.rowCount).sort((left, right) => left! - right!),
      [47, 85],
    );
  } finally {
    fourShapeStore.close();
  }
} finally {
  await rm(fourShapeLedgerDir, { recursive: true, force: true });
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
