import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { registerHooks } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import type {
  LoanRepaymentRelationResolutionRequest,
  LoanRepaymentRelationResolutionResult,
} from "../ledger/canonical/loan-repayment-relations.ts";
import { queryCounterpartyAccountEvidence } from "../ledger/canonical/loan-repayment-relations.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { YUANTA_RELATION_EVIDENCE_FIXTURES_V1 } from "./yuanta-relation-evidence.fixtures.ts";

const stableConnectionScope = "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001";
const stableConnectionKey = deriveSourceConnectionIdentityKey(
  "yuanta",
  stableConnectionScope,
);
const stableConnectionIdentity = {
  sourceConnectionScope: stableConnectionScope,
  sourceConnectionKey: stableConnectionKey,
  observedAt: () => "2026-08-21T11:04:05+08:00",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  deriveYuantaDomesticDepositQueryRange,
  dismissYuantaBankNotice,
  readYuantaDepositAccountOptions,
  runYuantaStatements,
  statementRowsFromDownloadedCsv,
  yuantaLoanAccountEvidenceFromTransactionNote,
  yuantaObservedAt,
} = await import("./yuanta-statements.ts");

assert.deepEqual(
  yuantaLoanAccountEvidenceFromTransactionNote("0012345678901234", 7),
  {
    rowOrdinal: 7,
    accountValue: "0012345678901234",
    normalizedAccountValue: "12345678901234",
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "loan_contract",
    evidenceKind: "transaction-counterparty-account",
    sourceField: "備註",
    contractVersion: "yuanta/transaction-note-loan-account-leading-00/v1",
  },
);
for (const value of [
  "12345678901234",
  "001234567890123",
  "00123456789012345",
  "00******901234",
  "用途 0012345678901234",
]) {
  assert.equal(yuantaLoanAccountEvidenceFromTransactionNote(value, 0), null);
}

await assert.rejects(
  () =>
    runYuantaStatements(
      {} as never,
      {
        dateRange: "one_month",
        accountFilters: [],
        replaceActiveSession: true,
        telemetry: false,
      },
    ),
  /stable caller-supplied Source Connection scope and key/u,
);
const {
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
} = await import("../ledger/canonical/canonical-source-store.ts");
const { buildYuantaDomesticDepositReadinessFromLedger } =
  await import("../ledger/canonical/advertised-domestic-deposit-readiness.ts");
const { StatementComponentAbsentError } =
  await import("./run-selected-statements.ts");

class DelayedVisibilityLocator {
  private readonly visibleAt: number;
  private hidden = false;
  clicked = false;

  constructor(delayMs: number) {
    this.visibleAt = Date.now() + delayMs;
  }

  async isVisible(): Promise<boolean> {
    return !this.hidden && Date.now() >= this.visibleAt;
  }

  async waitFor(options: {
    state: "visible" | "hidden";
    timeout?: number;
  }): Promise<void> {
    const deadline = Date.now() + (options.timeout ?? 1_000);
    while (Date.now() < deadline) {
      const visible = await this.isVisible();
      if (visible === (options.state === "visible")) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for ${options.state}.`);
  }

  locator(selector: string): DelayedVisibilityLocator {
    assert.equal(selector, "#commonPopupLeftBtnImg");
    return this;
  }

  async click(): Promise<void> {
    this.clicked = true;
    this.hidden = true;
  }
}

const source = readFileSync(
  new URL("./yuanta-statements.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /import \{\s*authenticateYuantaBank as sharedAuthenticateYuantaBank,\s*dismissYuantaBankNotice,\s*yuantaSourceConnectionScope,\s*type YuantaCredentials,\s*\} from "\.\/yuanta-auth\.ts";/,
);
assert.match(source, /await sharedAuthenticateYuantaBank\(/);
assert.match(
  source,
  /export \{\s*dismissYuantaBankNotice,\s*type YuantaCredentials,\s*\} from "\.\/yuanta-auth\.ts";/,
);

const popup = new DelayedVisibilityLocator(20);
const dismissed = await dismissYuantaBankNotice(
  {
    locator(selector: string) {
      assert.equal(selector, "#commonPopup");
      return popup;
    },
  } as never,
  100,
);
assert.equal(dismissed, true);
assert.equal(popup.clicked, true);

const absentPopup = new DelayedVisibilityLocator(1_000);
const dismissedAbsentPopup = await dismissYuantaBankNotice(
  {
    locator(selector: string) {
      assert.equal(selector, "#commonPopup");
      return absentPopup;
    },
  } as never,
  10,
);
assert.equal(dismissedAbsentPopup, false);
assert.equal(absentPopup.clicked, false);

function accountOptionsPage(
  options: Array<{ value: string; label: string }>,
): never {
  const selectLocator = {
    first: () => ({
      waitFor: async ({ state }: { state: "attached" }) => {
        assert.equal(state, "attached");
      },
    }),
  };
  const optionLocator = {
    count: async () => options.length,
    nth: (index: number) => ({
      getAttribute: async (name: string) =>
        name === "value" ? (options[index]?.value ?? null) : null,
      textContent: async () => options[index]?.label ?? null,
    }),
  };
  return {
    frames: () => [],
    waitForTimeout: async () => {},
    locator: (selector: string) =>
      selector === "#acctno" ? selectLocator : optionLocator,
  } as never;
}

await assert.rejects(
  readYuantaDepositAccountOptions(
    accountOptionsPage([{ value: "", label: "請選擇帳戶" }]),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaDepositAccountOptions(
    accountOptionsPage([
      { value: "", label: "請選擇帳戶" },
      { value: "acct-1", label: "臺幣活期存款" },
      { value: "acct-2", label: "臺幣綜合存款" },
    ]),
    ["stale-account-selection"],
  ),
  [
    { value: "acct-1", label: "臺幣活期存款" },
    { value: "acct-2", label: "臺幣綜合存款" },
  ],
);

const observedAt = yuantaObservedAt(new Date("2026-08-21T03:04:05.000Z"));
assert.equal(observedAt, "2026-08-21T11:04:05+08:00");
const boundedRange = deriveYuantaDomesticDepositQueryRange(
  "one_week",
  observedAt,
);
assert.deepEqual(boundedRange, {
  dateRange: "one_week",
  startDate: "2026-08-15",
  endDate: "2026-08-21",
});
assert.deepEqual(
  deriveYuantaDomesticDepositQueryRange(
    "one_month",
    "2026-09-02T00:00:00+08:00",
  ),
  {
    dateRange: "one_month",
    startDate: "2026-08-02",
    endDate: "2026-09-02",
  },
);
assert.deepEqual(
  deriveYuantaDomesticDepositQueryRange(
    "three_months",
    "2026-09-02T00:00:00+08:00",
  ),
  {
    dateRange: "three_months",
    startDate: "2026-06-02",
    endDate: "2026-09-02",
  },
);
assert.equal(
  deriveYuantaDomesticDepositQueryRange(
    "one_month",
    "2026-03-31T00:00:00+08:00",
  ).startDate,
  "2026-02-28",
);

const csv = [
  '"帳號","帳務日期","交易日期","交易時間","交易說明","支出金額","存入金額","帳面餘額","票據號碼","備註"',
  '"123456","20260802","20260802","09:10:11","PRIVATE DESCRIPTION","","100","900","","PRIVATE NOTE"',
  '"帳號","帳務日期","交易日期","交易時間","交易說明","支出金額","存入金額","帳面餘額","票據號碼","備註"',
  '"123456","20260803","20260803","10:00:00","SECOND","50","","850","",""',
].join("\n");
const parsedRows = statementRowsFromDownloadedCsv(csv, "********3456");
assert.equal(parsedRows.length, 2);
assert.equal(parsedRows[0]?.sourceRowOrdinal, 0);
assert.equal(parsedRows[1]?.sourceRowOrdinal, 1);
assert.equal(parsedRows[0]?.accountLabel, "********3456");
assert.match(JSON.stringify(parsedRows), /PRIVATE DESCRIPTION|PRIVATE NOTE/);

const workflowAccount = {
  value: "YUANTA-ACCOUNT-001",
  label: "臺幣活期存款 YUANTA-ACCOUNT-001",
};
const workflowValues = [
  "臺幣活期存款",
  workflowAccount.value,
  "20260802",
  "20260802",
  "09:10:11",
  "CLEAN DEPOSIT",
  "",
  "100",
  "900",
  "",
  "",
];
const workflowDownload = {
  filename: "yuanta-synthetic.csv",
  rows: [
    {
      accountLabel: workflowAccount.label,
      values: workflowValues.slice(1),
      sortTime: Date.parse("2026-08-02T09:10:11+08:00"),
      sourceRowOrdinal: 0,
    },
  ],
  source: {
    filename: "yuanta-synthetic.csv",
    byteLength: 128,
    contentDigest: "sha256:yuanta-synthetic-content" as `sha256:${string}`,
    columnNames: [
      "帳戶名稱",
      "帳號",
      "帳務日期",
      "交易日期",
      "交易時間",
      "交易說明",
      "支出金額",
      "存入金額",
      "帳面餘額",
      "票據號碼",
      "備註",
    ],
    terminal: true,
    rows: [{ rowOrdinal: 0, values: workflowValues }],
  },
  counterpartyAccountEvidence: [
    YUANTA_RELATION_EVIDENCE_FIXTURES_V1.exactCounterpartyAccount,
  ],
};
const maskedWorkflowDownload = {
  ...workflowDownload,
  source: {
    ...workflowDownload.source,
    contentDigest: "sha256:yuanta-masked-content" as `sha256:${string}`,
  },
  counterpartyAccountEvidence: [
    YUANTA_RELATION_EVIDENCE_FIXTURES_V1.maskedCounterpartyAccount,
  ],
};
const secondWorkflowAccount = {
  value: "YUANTA-ACCOUNT-002",
  label: "臺幣活期存款 YUANTA-ACCOUNT-002",
};
const secondWorkflowValues = [...workflowValues];
secondWorkflowValues[0] = secondWorkflowAccount.label;
secondWorkflowValues[1] = secondWorkflowAccount.value;
const secondWorkflowDownload = {
  ...workflowDownload,
  rows: [
    {
      ...workflowDownload.rows[0]!,
      accountLabel: secondWorkflowAccount.label,
      values: secondWorkflowValues.slice(1),
    },
  ],
  source: {
    ...workflowDownload.source,
    contentDigest: "sha256:yuanta-synthetic-content-002" as `sha256:${string}`,
    rows: [{ rowOrdinal: 0, values: secondWorkflowValues }],
  },
};
const writeWorkflowFile = async () => ({
  baseName: "yuanta-synthetic",
  kind: "bank-transactions" as const,
  rowCount: 1,
  headers: ["帳戶名稱"],
  accounts: [workflowAccount.label],
  dateRange: "one_month" as const,
  csvFilename: "yuanta-synthetic.csv",
  jsonFilename: "yuanta-synthetic.json",
  csvPath: "yuanta-synthetic.csv",
  jsonPath: "yuanta-synthetic.json",
  csvBytes: 1,
  jsonBytes: 1,
});

const sourceOnlyDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-source-only-workflow-"),
);
try {
  const sourceOnlyOutput = await runYuantaStatements(
    {} as never,
    {
      dateRange: "one_month",
      accountFilters: [],
      replaceActiveSession: true,
      telemetry: true,
    },
    {
      ...stableConnectionIdentity,
      canonicalLedgerDir: sourceOnlyDir,
      readDepositAccountOptions: async () => [workflowAccount],
      queryAccount: async () => undefined,
      downloadStatementRows: async () => workflowDownload,
      writeBankTransactionsFile: writeWorkflowFile as never,
    },
  );
  assert.equal(sourceOnlyOutput.admissions[0]?.status, "source-only");
  assert.equal(
    sourceOnlyOutput.admissions[0]?.reason,
    "financial-ledger-not-configured",
  );
  assert.equal(sourceOnlyOutput.telemetry?.length, 1);
  const sourceOnlyStore = createCanonicalSourceStore(
    join(sourceOnlyDir, "canonical.sqlite"),
  );
  try {
    assert.equal(
      sourceOnlyStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      0,
    );
    const current = queryCanonicalSourceCurrent(sourceOnlyStore);
    assert.equal(current.records.length, 1);
    const sourceOnlyReadiness = buildYuantaDomesticDepositReadinessFromLedger(
      sourceOnlyStore.db,
    );
    assert.equal(sourceOnlyReadiness.capability, "preflight-only");
    assert.deepEqual(sourceOnlyReadiness.blockers.length > 0, true);
    assert.doesNotMatch(
      JSON.stringify(
        current.records.map(({ compact }) => ({
          amountShape: compact.amountShape,
          cellCount: compact.cellCount,
          evidenceVersion: compact.evidenceVersion,
          pageOrdinal: compact.pageOrdinal,
          rowOrdinal: compact.rowOrdinal,
          semanticStatus: compact.semanticStatus,
        })),
      ),
      /CLEAN DEPOSIT|900|YUANTA-ACCOUNT-001/,
    );
  } finally {
    sourceOnlyStore.close();
  }
} finally {
  await rm(sourceOnlyDir, { recursive: true, force: true });
}

const financialSourceDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-financial-source-workflow-"),
);
const financialLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-financial-ledger-workflow-"),
);
const relationRequests: LoanRepaymentRelationResolutionRequest[] = [];
const relationEvidenceCounts: number[] = [];
const resolveYuantaRelations = async (
  store: { db: DatabaseSync; databasePath?: string },
  request: LoanRepaymentRelationResolutionRequest,
): Promise<LoanRepaymentRelationResolutionResult> => {
  relationRequests.push(request);
  relationEvidenceCounts.push(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM transaction_counterparty_account_evidence",
          )
          .get() as { count?: number }
      ).count ?? 0,
    ),
  );
  return {
    status: "canonical-live",
    outcome: "no-admission",
    resolutionId: null,
    exactRelationIds: [],
    settlementGroupIds: [],
    reason: "no-evidence-backed-admission",
  };
};
try {
  const financialOutput = await runYuantaStatements(
    {} as never,
    {
      dateRange: "one_month",
      accountFilters: [],
      replaceActiveSession: true,
      telemetry: false,
    },
    {
      observedAt: stableConnectionIdentity.observedAt,
      canonicalLedgerDir: financialSourceDir,
      canonicalFinancialLedgerDir: financialLedgerDir,
      readDepositAccountOptions: async () => [workflowAccount],
      queryAccount: async () => undefined,
      downloadStatementRows: async () => workflowDownload,
      writeBankTransactionsFile: writeWorkflowFile as never,
      sourceConnectionScope: stableConnectionScope,
      sourceConnectionKey: stableConnectionKey,
      resolveRelations: resolveYuantaRelations,
    },
  );
  assert.equal(financialOutput.admissions[0]?.status, "financial-admitted");
  assert.equal(relationRequests.length, 1);
  assert.equal(relationRequests[0]?.integrationNamespace, "yuanta");
  assert.equal(relationRequests[0]?.sourceConnectionKey, stableConnectionKey);
  assert.deepEqual(relationRequests[0]?.requiredCoverage, { complete: true });
  assert.equal("explicitLinks" in relationRequests[0]!, false);
  assert.deepEqual(relationEvidenceCounts, [1]);
  assert.equal(financialOutput.relationResolution?.outcome, "no-admission");
  assert.equal(
    financialOutput.relationResolution?.reason,
    "no-evidence-backed-admission",
  );
  const financialStore = createCanonicalSourceStore(
    join(financialLedgerDir, "canonical.sqlite"),
  );
  try {
    assert.equal(
      financialStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      1,
    );
    assert.equal(
      financialStore.db
        .prepare("SELECT COUNT(*) AS count FROM source_captures")
        .get()?.count,
      1,
    );
    const evidence = queryCounterpartyAccountEvidence(financialStore);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.sourceValue, " 9988-7766 ");
    assert.equal(evidence[0]?.normalizedValue, "99887766");
    assert.equal(evidence[0]?.purpose, "loan_repayment");
    assert.equal(evidence[0]?.scope, "shared_collection");
    assert.equal(
      evidence[0]?.sourceField,
      "provider-detail-counterparty-account",
    );
    const financialCurrent = queryCanonicalSourceCurrent(financialStore);
    assert.equal(financialCurrent.records.length, 1);
    const financialHistorical = queryCanonicalSourceHistorical(financialStore);
    assert.equal(financialHistorical.records.length, 1);
    const financialObservation = financialCurrent.observations[0]!;
    const financialLineage = queryCanonicalSourceLineage(financialStore, {
      ...financialObservation.identity,
      occurrenceKey: financialObservation.occurrenceKey,
    });
    assert.equal(financialLineage.provenanceComplete, true);
    const readiness = buildYuantaDomesticDepositReadinessFromLedger(
      financialStore.db,
    );
    assert.equal(readiness.capability, "canonical-human-attested");
    assert.equal(readiness.liveValidation, "complete");
    assert.deepEqual(readiness.blockers, []);
    assert.equal(readiness.providerGuaranteed, false);
  } finally {
    financialStore.close();
  }
} finally {
  await rm(financialSourceDir, { recursive: true, force: true });
  await rm(financialLedgerDir, { recursive: true, force: true });
}

const maskedSourceDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-masked-source-workflow-"),
);
const maskedLedgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-masked-ledger-workflow-"),
);
try {
  await assert.rejects(
    () =>
      runYuantaStatements(
        {} as never,
        {
          dateRange: "one_month",
          accountFilters: [],
          replaceActiveSession: true,
          telemetry: false,
        },
        {
          ...stableConnectionIdentity,
          canonicalLedgerDir: maskedSourceDir,
          canonicalFinancialLedgerDir: maskedLedgerDir,
          readDepositAccountOptions: async () => [workflowAccount],
          queryAccount: async () => undefined,
          downloadStatementRows: async () => maskedWorkflowDownload,
          writeBankTransactionsFile: writeWorkflowFile as never,
        },
      ),
    /masked counterparty account/i,
  );
  const maskedStore = createCanonicalSourceStore(
    join(maskedLedgerDir, "canonical.sqlite"),
  );
  try {
    // Financial capture admission is append-only; rejecting masked evidence
    // must not silently admit an exact account or erase the capture.
    assert.equal(
      maskedStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      1,
    );
    assert.equal(queryCounterpartyAccountEvidence(maskedStore).length, 0);
  } finally {
    maskedStore.close();
  }
} finally {
  await rm(maskedSourceDir, { recursive: true, force: true });
  await rm(maskedLedgerDir, { recursive: true, force: true });
}

const multiAccountDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-multi-account-workflow-"),
);
try {
  const multiAccountOutput = await runYuantaStatements(
    {} as never,
    {
      dateRange: "one_month",
      accountFilters: [],
      replaceActiveSession: true,
      telemetry: false,
    },
    {
      ...stableConnectionIdentity,
      canonicalLedgerDir: multiAccountDir,
      readDepositAccountOptions: async () => [
        workflowAccount,
        secondWorkflowAccount,
      ],
      queryAccount: async () => undefined,
      downloadStatementRows: async (_page, account) =>
        account.value === secondWorkflowAccount.value
          ? secondWorkflowDownload
          : workflowDownload,
      writeBankTransactionsFile: writeWorkflowFile as never,
    },
  );
  assert.equal(multiAccountOutput.admissions.length, 2);
  const multiAccountStore = createCanonicalSourceStore(
    join(multiAccountDir, "canonical.sqlite"),
  );
  try {
    assert.equal(
      queryCanonicalSourceCurrent(multiAccountStore).records.length,
      2,
    );
    assert.equal(
      multiAccountStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      0,
    );
  } finally {
    multiAccountStore.close();
  }
} finally {
  await rm(multiAccountDir, { recursive: true, force: true });
}

const cancellationDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-cancellation-workflow-"),
);
try {
  const cancellationValues = [...workflowValues];
  cancellationValues[5] = "取消沖正";
  const cancellationDownload = {
    ...workflowDownload,
    rows: [
      {
        ...workflowDownload.rows[0]!,
        values: cancellationValues.slice(1),
      },
    ],
    source: {
      ...workflowDownload.source,
      contentDigest: "sha256:yuanta-cancellation-content" as `sha256:${string}`,
      rows: [{ rowOrdinal: 0, values: cancellationValues }],
    },
  };
  const originalLog = console.log;
  const amountTelemetry: Array<{
    rowCount: number;
    pairs: Record<string, number>;
  }> = [];
  console.log = ((label: unknown, payload: unknown) => {
    if (label === "yuanta-domestic-deposit-amount-classes")
      amountTelemetry.push(payload as (typeof amountTelemetry)[number]);
  }) as typeof console.log;
  await assert.rejects(
    () =>
      runYuantaStatements(
        {} as never,
        {
          dateRange: "one_month",
          accountFilters: [],
          replaceActiveSession: true,
          telemetry: true,
        },
        {
          ...stableConnectionIdentity,
          canonicalLedgerDir: cancellationDir,
          canonicalFinancialLedgerDir: cancellationDir,
          readDepositAccountOptions: async () => [workflowAccount],
          queryAccount: async () => undefined,
          downloadStatementRows: async () => cancellationDownload,
          writeBankTransactionsFile: writeWorkflowFile as never,
        },
      ),
    /cancellation-marker-unsupported|financial admission failed/i,
  );
  console.log = originalLog;
  assert.deepEqual(amountTelemetry, [
    { rowCount: 1, pairs: { "empty|valid-nonzero": 1 } },
  ]);
  assert.doesNotMatch(
    JSON.stringify(amountTelemetry),
    /YUANTA|CLEAN|取消|沖正/,
  );
  const cancellationStore = createCanonicalSourceStore(
    join(cancellationDir, "canonical.sqlite"),
  );
  try {
    assert.equal(
      cancellationStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      0,
    );
    assert.equal(
      queryCanonicalSourceCurrent(cancellationStore).records.length,
      1,
    );
  } finally {
    cancellationStore.close();
  }
} finally {
  await rm(cancellationDir, { recursive: true, force: true });
}

const emptyDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "yuanta-empty-workflow-"),
);
try {
  const emptyDownload = {
    ...workflowDownload,
    rows: [],
    source: {
      ...workflowDownload.source,
      contentDigest: "sha256:yuanta-empty-content" as `sha256:${string}`,
      rows: [],
    },
  };
  const emptyOutput = await runYuantaStatements(
    {} as never,
    {
      dateRange: "one_month",
      accountFilters: [],
      replaceActiveSession: true,
      telemetry: false,
    },
    {
      ...stableConnectionIdentity,
      canonicalLedgerDir: emptyDir,
      canonicalFinancialLedgerDir: emptyDir,
      readDepositAccountOptions: async () => [workflowAccount],
      queryAccount: async () => undefined,
      downloadStatementRows: async () => emptyDownload,
      writeBankTransactionsFile: writeWorkflowFile as never,
    },
  );
  assert.equal(emptyOutput.admissions[0]?.status, "source-only");
  assert.match(
    emptyOutput.admissions[0]?.reason ?? "",
    /zero-result-authority-unproven/,
  );
  const emptyStore = createCanonicalSourceStore(
    join(emptyDir, "canonical.sqlite"),
  );
  try {
    assert.equal(
      emptyStore.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      0,
    );
    assert.equal(
      emptyStore.db
        .prepare("SELECT COUNT(*) AS count FROM source_captures")
        .get()?.count,
      1,
    );
  } finally {
    emptyStore.close();
  }
} finally {
  await rm(emptyDir, { recursive: true, force: true });
}
