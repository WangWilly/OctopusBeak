import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { dismissYuantaBankNotice } from "./yuanta-auth.ts";
import { YUANTA_RELATION_EVIDENCE_FIXTURES_V1 } from "./yuanta-relation-evidence.fixtures.ts";
import { deriveYuantaDomesticDepositAccountKey } from "../ledger/canonical/yuanta-deposit-account-key.ts";
import {
  YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  admitYuantaDomesticDepositCaptureEvidence,
  admitYuantaDomesticDepositFinancialCapture,
} from "../ledger/canonical/yuanta-domestic-deposit-admission.ts";
import { YUANTA_HUMAN_ATTESTED_V2_MANIFEST } from "../ledger/canonical/yuanta-human-attestation-contract.ts";
import { createAppWorkflowBrowserPort } from "../lib/automation/server/app-browser-host.ts";
import { financialFactsFromCapture } from "../ledger/pglite/deposit.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { yuantaCollectionContext, yuantaStagingHandle } from "./yuanta-collection.fixtures.ts";
import { collectionPeriod, taipeiToday, type CollectionSpan } from "../lib/automation/collection-period.ts";
import { YUANTA_SOURCE } from "../lib/automation/server/sources/yuanta.ts";
import { YUANTA_EBANK_ORIGIN, yuantaEbankSite } from "./yuanta-ebank-site.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";

const stableConnectionScope = "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001";
const stableConnectionKey = deriveSourceConnectionIdentityKey(
  "yuanta",
  stableConnectionScope,
);
const stableConnectionIdentity = {
  sourceConnectionScope: stableConnectionScope,
  sourceConnectionKey: stableConnectionKey,
};
/** Observed in Taipei as 2026-08-21T11:04:05+08:00. */
const checkContext = (signal?: AbortSignal) =>
  yuantaCollectionContext({ now: "2026-08-21T03:04:05.000Z", ...(signal ? { signal } : {}) });

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildYuantaCapture,
  waitForYuantaDepositQueryResult,
  deriveYuantaDomesticDepositAccountNumberEvidence,
  downloadYuantaStatementRows,
  readYuantaDepositAccountOptions,
  readYuantaDepositSource,
  runYuantaStatements,
  stageYuantaDeposit,
  statementRowsFromDownloadedCsv,
  yuantaLoanAccountEvidenceFromTransactionNote,
  yuantaDepositQueryRange,
  yuantaObservedAt,
} = await import("./yuanta-statements.ts");

const ONE_WEEK = { days: 7 };
const ONE_MONTH = { months: 1, days: 1 };
const THREE_MONTHS = { months: 3, days: 1 };
/** The deposit query for a quick span ending on the Taipei date of `observedAt`. */
const depositRange = (span: CollectionSpan, observedAt: string) =>
  yuantaDepositQueryRange(collectionPeriod({ today: taipeiToday(observedAt), lookBack: span }));

assert.deepEqual(
  deriveYuantaDomesticDepositAccountNumberEvidence({
    value: "0012345678901234",
    label: "臺幣活期存款 0012345678901234",
  }),
  {
    value: "0012345678901234",
    kind: "depository-account",
    evidenceVersion: "yuanta/domestic-deposit/account-number-v1",
    sourceField: "#acctno option.value",
  },
);
assert.equal(
  deriveYuantaDomesticDepositAccountNumberEvidence({
    value: "0012345678901234",
    label: "臺幣活期存款 ****1234",
  }),
  null,
);

const workflowNumberedCapture = buildYuantaCapture(
  {
    value: "0012345678901234",
    label: "臺幣活期存款 0012345678901234",
  },
  depositRange(ONE_MONTH, "2026-08-21T12:00:00+08:00"),
  "2026-08-21T12:00:00+08:00",
  {
    filename: "synthetic-yuanta.csv",
    rows: [],
    source: {
      filename: "synthetic-yuanta.csv",
      byteLength: 0,
      contentDigest: `sha256:${"a".repeat(64)}` as const,
      columnNames: [...YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES],
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "臺幣活期存款", "0012345678901234", "20260821", "20260821",
            "09:10:00", "薪資", "", "100", "1100", "", "",
          ],
        },
        {
          rowOrdinal: 1,
          values: [
            "臺幣活期存款", "0012345678901234", "20260821", "20260821",
            "09:10:00", "薪資", "", "100", "1100", "", "",
          ],
        },
      ],
      terminal: true,
    },
  },
);
assert.deepEqual(workflowNumberedCapture.account.accountNumber, {
  value: "0012345678901234",
  kind: "depository-account",
  evidenceVersion: "yuanta/domestic-deposit/account-number-v1",
  sourceField: "#acctno option.value",
});
const yuantaDuplicateEvidence = admitYuantaDomesticDepositCaptureEvidence(
  workflowNumberedCapture,
);
assert.equal(yuantaDuplicateEvidence.status, "admissible");
const yuantaDuplicateFinancial = admitYuantaDomesticDepositFinancialCapture({
  capture: yuantaDuplicateEvidence.capture!,
  captureId: "yuanta-domestic-duplicate-occurrence-check",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  sourceConnectionScope: stableConnectionScope,
  sourceConnectionKey: stableConnectionKey,
});
assert.equal(yuantaDuplicateFinancial.status, "admitted");
assert.deepEqual(
  yuantaDuplicateFinancial.capture!.records.map(
    (record) => record.occurrenceGroup?.ordinal,
  ),
  [1, 2],
  "identical Yuanta domestic rows retain two semantic occurrence slots",
);
assert.equal(yuantaDuplicateFinancial.capture!.occurrenceGroupCoverage?.length, 1);

// Sunday transactions are booked on the provider's next business day, after
// the range ends on Sunday. The provider, not a local calendar, names that day.
function admitYuantaRows(observedAt: string, rows: readonly string[][]) {
  const evidence = admitYuantaDomesticDepositCaptureEvidence(buildYuantaCapture(
    { value: "0012345678901234", label: "臺幣活期存款 0012345678901234" },
    depositRange(THREE_MONTHS, observedAt),
    observedAt,
    {
      filename: "synthetic-yuanta.csv",
      rows: [],
      source: {
        filename: "synthetic-yuanta.csv",
        byteLength: 0,
        contentDigest: `sha256:${"b".repeat(64)}` as const,
        columnNames: [...YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES],
        rows: rows.map((values, rowOrdinal) => ({ rowOrdinal, values: [...values] })),
        terminal: true,
      },
    },
  ));
  assert.equal(evidence.status, "admissible");
  return admitYuantaDomesticDepositFinancialCapture({
    capture: evidence.capture!,
    captureId: `yuanta-domestic-next-business-day-${observedAt}-${rows.length}`,
    humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
    sourceConnectionScope: stableConnectionScope,
    sourceConnectionKey: stableConnectionKey,
  });
}
function sundayRow(accountingDate: string, rowOrdinal: number): string[] {
  return [
    "臺幣活期存款", "0012345678901234", accountingDate, "20261011",
    `13:2${rowOrdinal}:00`, "轉帳", "", String(100 + rowOrdinal),
    String(1100 + rowOrdinal), "", "",
  ];
}
function admitSundayQueryRows(...accountingDates: string[]) {
  return admitYuantaRows("2026-10-11T16:00:00+08:00", accountingDates.map(sundayRow));
}
assert.deepEqual(
  admitSundayQueryRows("20261012").diagnostics,
  [],
  "a row booked on the next business day after the query range is admitted",
);
assert.deepEqual(
  admitSundayQueryRows("20261020", "20261020").diagnostics,
  [],
  "rows booked after a weekday holiday stretch are admitted",
);
assert.ok(
  admitSundayQueryRows("20261012", "20261013").diagnostics.includes("row-outside-query-range"),
  "rows booked on two different later days cannot share one next business day",
);
assert.ok(
  admitSundayQueryRows("20261026").diagnostics.includes("row-outside-query-range"),
  "a row booked beyond any holiday stretch stays outside the query range",
);

// Monday's sync covers the booked-ahead day inside its range and must
// recapture the Sunday row with the same identity.
{
  const sunday = admitSundayQueryRows("20261012").capture!;
  const monday = admitYuantaRows("2026-10-12T16:00:00+08:00", [
    sundayRow("20261012", 0),
    ["臺幣活期存款", "0012345678901234", "20261012", "20261012",
      "09:10:00", "薪資", "", "200", "1300", "", ""],
  ]).capture!;
  assert.equal(sunday.scope.endDate, "2026-10-12", "the Sunday capture covers the booked-ahead day");
  const original = sunday.records[0]!;
  const recaptured = monday.records.find(
    (record) => record.occurrenceKey === original.occurrenceKey,
  );
  assert.ok(recaptured, "Monday's sync recaptures the Sunday row");
  assert.equal(recaptured.contentHash, original.contentHash);
  assert.deepEqual(recaptured.occurrenceGroup, original.occurrenceGroup);
  assert.equal(
    financialFactsFromCapture(monday).find(
      (fact) => fact.sourceOccurrenceKey === original.occurrenceKey,
    )?.sourceSequence,
    financialFactsFromCapture(sunday)[0]?.sourceSequence,
    "financial identity remains stable across the two syncs",
  );
}

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
        accountFilters: [],
        sourceConnectionScope: stableConnectionScope,
        sourceConnectionKey: "invalid-source-connection-key",
      },
      checkContext(),
      yuantaStagingHandle([]),
    ),
  /stable caller-supplied Source Connection scope and key/u,
);
const { StatementComponentAbsentError } =
  await import("../lib/automation/product-collection.ts");

class LateNotice {
  clicked = false;
  private visible = false;
  private readonly changes: Array<() => void> = [];

  show(): void {
    this.set(true);
  }

  async isVisible(): Promise<boolean> {
    return this.visible;
  }

  async waitFor({ state, timeout = 1_000 }: { state: "visible" | "hidden"; timeout?: number }): Promise<void> {
    if (this.visible === (state === "visible")) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${state}.`)), timeout);
      this.changes.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  locator(selector: string): LateNotice {
    assert.equal(selector, "#commonPopupLeftBtnImg");
    return this;
  }

  async click(): Promise<void> {
    this.clicked = true;
    this.set(false);
  }

  private set(visible: boolean): void {
    this.visible = visible;
    for (const change of this.changes.splice(0)) change();
  }
}

const noticeFrame = (notice: LateNotice) => ({
  locator(selector: string) {
    assert.equal(selector, "#commonPopup");
    return notice;
  },
}) as never;

const source = readFileSync(
  new URL("./yuanta-statements.ts", import.meta.url),
  "utf8",
);

assert.doesNotMatch(source, /from ["']libretto["']/u, "the domestic provider must not register a Libretto production workflow");
assert.doesNotMatch(source, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/u, "the domestic provider must return items to the App commit port");
assert.doesNotMatch(source, /from ["']node:fs\/promises["']|writeBankTransactionsFile|downloads[\\/]yuanta-statements/u, "the domestic provider must not write statement source or output files");
assert.doesNotMatch(source, /console\.log\s*\(|export default/u, "the domestic provider must not write standalone logs or expose a legacy workflow entry");
assert.doesNotMatch(source, /from ["']\.\/yuanta-auth\.ts["']/u, "the collector must leave authentication to the App-owned parent");
assert.doesNotMatch(source, /waitForEvent\(["']download|\.createReadStream\(/u, "the App collector must not depend on Playwright download artifacts");

const lateNotice = new LateNotice();
const dismissingLateNotice = dismissYuantaBankNotice(noticeFrame(lateNotice), 100);
lateNotice.show();
assert.equal(await dismissingLateNotice, true);
assert.equal(lateNotice.clicked, true);

const absentNotice = new LateNotice();
assert.equal(await dismissYuantaBankNotice(noticeFrame(absentNotice), 10), false);
assert.equal(absentNotice.clicked, false);

const observedAt = yuantaObservedAt(new Date("2026-08-21T03:04:05.000Z"));
assert.equal(observedAt, "2026-08-21T11:04:05+08:00");
const boundedRange = depositRange(ONE_WEEK, observedAt);
assert.deepEqual(boundedRange, {
  dateRange: "one_week",
  startDate: "2026-08-15",
  endDate: "2026-08-21",
});
assert.deepEqual(
  depositRange(ONE_MONTH, "2026-09-02T00:00:00+08:00"),
  {
    dateRange: "one_month",
    startDate: "2026-08-02",
    endDate: "2026-09-02",
  },
);
assert.deepEqual(
  depositRange(THREE_MONTHS, "2026-09-02T00:00:00+08:00"),
  {
    dateRange: "three_months",
    startDate: "2026-06-02",
    endDate: "2026-09-02",
  },
);
assert.equal(
  depositRange(ONE_MONTH, "2026-03-31T00:00:00+08:00").startDate,
  "2026-02-28",
);
{
  const declaration = YUANTA_SOURCE.statementSelection!.products.find(({ id }) => id === "deposit")!.collectionPeriod!;
  // 16:30Z on May 30 is 00:30 on May 31 in Taipei; the declared period is the 三個月 link.
  assert.deepEqual(
    yuantaDepositQueryRange(collectionPeriod({ today: taipeiToday("2026-05-30T16:30:00.000Z"), ...declaration })),
    { dateRange: "three_months", startDate: "2026-02-28", endDate: "2026-05-31" },
  );
  assert.throws(
    () => yuantaDepositQueryRange(collectionPeriod({ today: "2026-05-31", lookBack: { months: 2, days: 1 } })),
    /No Yuanta quick range/,
  );
}

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
const workflowCurrentSourceAccountKey = deriveYuantaDomesticDepositAccountKey(
  workflowAccount.value,
);
const workflowCurrentBalanceRow = {
  source: "yuanta" as const,
  kind: "domestic" as const,
  stream: "domestic-deposit" as const,
  accountNumber: workflowAccount.value,
  sourceAccountKey: workflowCurrentSourceAccountKey,
  currency: "TWD",
  available: { coefficient: "800", scale: 2, sourceLexeme: "800.00" },
  ledger: { coefficient: "900", scale: 2, sourceLexeme: "900.00" },
  effectiveAt: "2026-08-21T01:00:00.000Z",
  providerHttpDate: "Fri, 21 Aug 2026 01:00:00 GMT",
  observedAt: "2026-08-21T09:00:00+08:00",
  sourceEvidence: {
    endpoint: "/nib/tx/finance_overview_for_summary" as const,
    method: "POST" as const,
    status: 200 as const,
    cacheControl: "no-store",
    contractVersion: "yuanta/current-deposit-balance-v1" as const,
  },
};
const nextDayAccountingWorkflowDownload = {
  ...workflowDownload,
  rows: [
    {
      ...workflowDownload.rows[0]!,
      values: [
        "YUANTA-ACCOUNT-001",
        "20260622",
        "20260619",
        "09:10:11",
        "CLEAN DEPOSIT",
        "",
        "100",
        "900",
        "",
        "",
      ],
    },
  ],
  source: {
    ...workflowDownload.source,
    contentDigest: "sha256:yuanta-accounting-date-range-content" as `sha256:${string}`,
    rows: [
      {
        rowOrdinal: 0,
        values: [
          "臺幣活期存款",
          "YUANTA-ACCOUNT-001",
          "20260622",
          "20260619",
          "09:10:11",
          "CLEAN DEPOSIT",
          "",
          "100",
          "900",
          "",
          "",
        ],
      },
    ],
  },
};
const transactionOutsideWorkflowDownload = {
  ...nextDayAccountingWorkflowDownload,
  rows: [
    {
      ...nextDayAccountingWorkflowDownload.rows[0]!,
      values: [
        "YUANTA-ACCOUNT-001",
        "20260619",
        "20260622",
        "09:10:11",
        "CLEAN DEPOSIT",
        "",
        "100",
        "900",
        "",
        "",
      ],
    },
  ],
  source: {
    ...nextDayAccountingWorkflowDownload.source,
    contentDigest: "sha256:yuanta-accounting-date-outside-content" as `sha256:${string}`,
    rows: [
      {
        rowOrdinal: 0,
        values: [
          "臺幣活期存款",
          "YUANTA-ACCOUNT-001",
          "20260619",
          "20260622",
          "09:10:11",
          "CLEAN DEPOSIT",
          "",
          "100",
          "900",
          "",
          "",
        ],
      },
    ],
  },
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
const typedOutputDir = await mkdtemp(join(tmpdir(), "yuanta-deposit-typed-"));
const originalCwd = process.cwd();
process.chdir(typedOutputDir);
try {
  const typedInput = { accountFilters: [], ...stableConnectionIdentity };
  const typedObservedAt = yuantaObservedAt(new Date("2026-08-21T03:04:05.000Z"));
  const deferredItems: PGliteWorkflowRunItem[] = [];
  const typedResult = await stageYuantaDeposit(
    {
      observedAt: typedObservedAt,
      queryRange: depositRange(ONE_MONTH, typedObservedAt),
      accounts: [{ account: workflowAccount, query: "download-ready", download: workflowDownload }],
    },
    typedInput,
    checkContext(),
    yuantaStagingHandle(deferredItems),
    async () => [workflowCurrentBalanceRow],
  );
  assert.equal(typedResult.sourceCaptureCount, 1);
  assert.equal(typedResult.rowCount, 1);
  assert.deepEqual(
    deferredItems.map((item) => item.product),
    ["domestic-deposit", "current-balance"],
    "the statement capture and its current balance are staged together",
  );
  assert.deepEqual(await readdir(typedOutputDir), []);

  const noDataItems: PGliteWorkflowRunItem[] = [];
  const noDataResult = await stageYuantaDeposit(
    {
      observedAt: typedObservedAt,
      queryRange: depositRange(THREE_MONTHS, typedObservedAt),
      accounts: [
        { account: workflowAccount, query: "provider-explicit-no-data" },
        { account: secondWorkflowAccount, query: "download-ready", download: secondWorkflowDownload },
      ],
    },
    { accountFilters: [], ...stableConnectionIdentity },
    checkContext(),
    yuantaStagingHandle(noDataItems),
    async () => [
      workflowCurrentBalanceRow,
      {
        ...workflowCurrentBalanceRow,
        accountNumber: secondWorkflowAccount.value,
        sourceAccountKey: deriveYuantaDomesticDepositAccountKey(secondWorkflowAccount.value),
      },
    ],
  );
  assert.equal(noDataResult.sourceCaptureCount, 2);
  assert.equal(noDataResult.rowCount, 1);
  assert.deepEqual(
    noDataItems.map((item) => item.product).sort(),
    ["current-balance", "current-balance", "domestic-deposit", "domestic-deposit"],
    "the empty account commits a zero-row statement capture and its current balance",
  );
  assert.ok(
    JSON.stringify(noDataItems).includes("provider-explicit-no-data"),
    "the zero-row capture must carry the provider's explicit no-data authority",
  );

  const canceledItems: PGliteWorkflowRunItem[] = [];
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    stageYuantaDeposit(
      {
        observedAt: typedObservedAt,
        queryRange: depositRange(ONE_MONTH, typedObservedAt),
        accounts: [{ account: workflowAccount, query: "download-ready", download: workflowDownload }],
      },
      typedInput,
      checkContext(cancellation.signal),
      yuantaStagingHandle(canceledItems),
      async () => assert.fail("a cancelled run must not open the current-balance page"),
    ),
    /abort/u,
  );
  assert.deepEqual(canceledItems, [], "cancellation must return no commit items");
} finally {
  process.chdir(originalCwd);
  await rm(typedOutputDir, { recursive: true, force: true });
}

const browserFixtureBytes = Buffer.from(
  "IrFiuLkiLCKxYrDIpOm0wSIsIqXmqfak6bTBIiwipeap9q7JtqEiLCKl5qn2u6Gp+iIsIqTkpViq98NCIiwipnOkSqr3w0IiLCKxYq2xvmzDQiIsIrK8vtq4ub1YIiwis8a1+SIKIllVQU5UQS1BQ0NPVU5ULTAwMSIsIjIwMjYwODAyIiwiMjAyNjA4MDIiLCIwOToxMDoxMSIsIkNMRUFOIERFUE9TSVQiLCIiLCIxMDAiLCI5MDAiLCIiLCIiCg==",
  "base64",
);
const streamedFixtureLimit = 25 * 1024 * 1024;
const streamedFixtureTotal = streamedFixtureLimit + 32 * 1024 * 1024;
let fixtureCookie: string | undefined;
type FixtureBodyMode =
  | "success"
  | "forbidden"
  | "invalid-big5"
  | "declared-oversize"
  | "streamed-oversize"
  | "redirect-cross-origin"
  | "redirect-same-origin"
  | "unsafe-filename"
  | "slow";
let fixtureHref: string | null = "/export.csv";
let fixtureJavaScriptExport = false;
let fixtureForeignJavaScriptExport = false;
let fixturePostCount = 0;
let fixtureBaseHref: string | null = null;
let fixtureBodyMode: FixtureBodyMode = "success";
let crossOriginRequestCount = 0;
let streamedFixtureBytes = 0;
let streamWasCanceledEarly = false;
let slowExportStarted = () => {};
const browserFixtureServer = createServer((request, response) => {
  if (request.url?.startsWith("/start")) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "yuanta-fixture-session=present; Path=/; SameSite=Lax",
    });
    const base = fixtureBaseHref === null
      ? ""
      : `<base href="${fixtureBaseHref.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;")}">`;
    const href = fixtureHref === null
      ? ""
      : ` href="${fixtureHref.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;")}"`;
    response.end(fixtureForeignJavaScriptExport
      ? '<form name="mform" method="post" action="/fxtransactiondetails"><input id="txntype" name="txntype" type="hidden" value="query"><input type="hidden" name="cid" value="synthetic-cid"></form><a class="order_2 m_color_check" href="javascript:void(0);" onclick="getDownload(\'csv\');">下載CSV檔</a>'
      : fixtureJavaScriptExport
      ? '<form name="jform" method="post" action="/transactiondetails"><input type="hidden" name="cid" value="synthetic-cid"></form><a class="order_2 m_color_check" href="javascript:void(0);" onclick="getDownload(\'csv\');">下載CSV檔</a>'
      : `${base}<a class="order_2 m_color_check"${href}>下載CSV檔</a>`);
    return;
  }
  if (request.url === "/transactiondetails?method=downloadcsv" && request.method === "POST") {
    fixturePostCount += 1;
    fixtureCookie = request.headers.cookie;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      assert.match(Buffer.concat(chunks).toString("utf8"), /cid=synthetic-cid/u);
      response.writeHead(200, { "content-type": "text/csv; charset=big5" });
      response.end(browserFixtureBytes);
    });
    return;
  }
  if (request.url === "/fxtransactiondetails" && request.method === "POST") {
    fixturePostCount += 1;
    fixtureCookie = request.headers.cookie;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      assert.match(Buffer.concat(chunks).toString("utf8"), /txntype=downloadcsv/u);
      response.writeHead(200, { "content-type": "text/csv; charset=big5" });
      response.end(browserFixtureBytes);
    });
    return;
  }
  if (request.url === "/export.csv" || request.url === "/export-final.csv") {
    fixtureCookie = request.headers.cookie;
    if (fixtureBodyMode === "forbidden") {
      response.writeHead(403, { "content-length": "0" });
      response.end();
      return;
    }
    if (fixtureBodyMode === "invalid-big5") {
      response.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="invalid.csv"',
        "content-length": "1",
      });
      response.end(Buffer.from([0x81]));
      return;
    }
    if (fixtureBodyMode === "declared-oversize") {
      response.writeHead(200, {
        "content-type": "text/csv",
        "content-length": String(25 * 1024 * 1024 + 1),
      });
      response.flushHeaders();
      return;
    }
    if (fixtureBodyMode === "streamed-oversize") {
      response.writeHead(200, { "content-type": "text/csv" });
      let finished = false;
      const sendChunk = () => {
        if (finished || response.destroyed) return;
        const length = Math.min(64 * 1024, streamedFixtureTotal - streamedFixtureBytes);
        if (length <= 0) {
          finished = true;
          response.end();
          return;
        }
        streamedFixtureBytes += length;
        const canContinue = response.write(Buffer.alloc(length, 0x41));
        if (streamedFixtureBytes >= streamedFixtureTotal) {
          finished = true;
          response.end();
        } else if (canContinue) {
          setTimeout(sendChunk, 8);
        } else {
          response.once("drain", () => setTimeout(sendChunk, 8));
        }
      };
      response.on("close", () => {
        finished = true;
        streamWasCanceledEarly = streamedFixtureBytes < streamedFixtureTotal;
      });
      sendChunk();
      return;
    }
    if (fixtureBodyMode === "slow") {
      slowExportStarted();
      response.writeHead(200, { "content-length": "100" });
      response.flushHeaders();
      const timer = setTimeout(() => response.end("x".repeat(100)), 5_000);
      response.on("close", () => clearTimeout(timer));
      return;
    }
    if (request.url === "/export.csv" && fixtureBodyMode === "redirect-cross-origin") {
      response.writeHead(302, { location: crossOriginFixtureUrl, "content-length": "0" });
      response.end();
      return;
    }
    if (request.url === "/export.csv" && fixtureBodyMode === "redirect-same-origin") {
      response.writeHead(302, { location: "/export-final.csv", "content-length": "0" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/csv; charset=big5",
      "content-disposition": fixtureBodyMode === "unsafe-filename"
        ? 'attachment; filename="../private.csv"'
        : 'attachment; filename="yuanta-fixture.csv"',
      "content-length": String(browserFixtureBytes.byteLength),
    });
    response.end(browserFixtureBytes);
    return;
  }
  response.writeHead(404, { "content-length": "0" });
  response.end();
});
const crossOriginFixtureServer = createServer((_request, response) => {
  crossOriginRequestCount += 1;
  response.writeHead(200, { "content-length": "0" });
  response.end();
});
await new Promise<void>((resolve, reject) => {
  crossOriginFixtureServer.once("error", reject);
  crossOriginFixtureServer.listen(0, "127.0.0.1", resolve);
});
const crossOriginFixtureAddress = crossOriginFixtureServer.address();
assert.ok(crossOriginFixtureAddress && typeof crossOriginFixtureAddress !== "string");
const crossOriginFixtureUrl = `http://127.0.0.1:${crossOriginFixtureAddress.port}/export.csv`;
await new Promise<void>((resolve, reject) => {
  browserFixtureServer.once("error", reject);
  browserFixtureServer.listen(0, "127.0.0.1", resolve);
});
const browserFixtureAddress = browserFixtureServer.address();
assert.ok(browserFixtureAddress && typeof browserFixtureAddress !== "string");
const browserFixtureBaseUrl = `http://127.0.0.1:${browserFixtureAddress.port}`;
const browserFixtureDirectory = await mkdtemp(
  join(tmpdir(), "yuanta-deposit-browser-fixture-"),
);
const browserFixtureOutputDirectory = await mkdtemp(
  join(tmpdir(), "yuanta-deposit-output-fixture-"),
);
const browserFixtureOriginalCwd = process.cwd();
process.chdir(browserFixtureOutputDirectory);
let observedBrowserDownload = false;
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const resultPage = await browser.newPage();
    const resultSite = (signal = new AbortController().signal) =>
      yuantaEbankSite(resultPage, { signal, text: strictSourceText });
    await resultPage.setContent(
      '<table><tr><th>交易日期</th><th>交易說明</th></tr><tr><td colspan="2">查無資料</td></tr></table>',
    );
    assert.equal(
      await waitForYuantaDepositQueryResult(resultSite(), 2_000),
      "provider-explicit-no-data",
      "the bank's 查無資料 result row is an explicit empty result, not a missing CSV",
    );
    await resultPage.setContent('<p>查無資料的說明</p><a class="order_2 m_color_check" href="/x.csv">下載CSV檔</a>');
    assert.equal(await waitForYuantaDepositQueryResult(resultSite(), 2_000), "download-ready");
    await resultPage.setContent("<p>查詢中</p>");
    await assert.rejects(
      waitForYuantaDepositQueryResult(resultSite(), 1_000),
      /CSV download link or a no-data result/u,
    );
    const pendingQuery = new AbortController();
    const cancelledWait = waitForYuantaDepositQueryResult(resultSite(pendingQuery.signal));
    pendingQuery.abort(new Error("query wait cancelled"));
    await assert.rejects(cancelledWait, /query wait cancelled/u, "a cancelled run stops inside the query wait");

    const accountSelector = (options: Array<{ value: string; label: string }>) =>
      `<select id="acctno">${options.map((option) => `<option value="${option.value}">${option.label}</option>`).join("")}</select>`;
    await resultPage.setContent(accountSelector([{ value: "", label: "請選擇帳戶" }]));
    await assert.rejects(
      readYuantaDepositAccountOptions(resultSite()),
      (error: unknown) => {
        assert.ok(error instanceof StatementComponentAbsentError);
        assert.equal(error.skipReason, "absent");
        return true;
      },
    );
    await resultPage.setContent(accountSelector([
      { value: "", label: "請選擇帳戶" },
      { value: "acct-1", label: "臺幣活期存款" },
      { value: "acct-2", label: "臺幣綜合存款" },
    ]));
    assert.deepEqual(
      await readYuantaDepositAccountOptions(resultSite(), ["stale-account-selection"]),
      [
        { value: "acct-1", label: "臺幣活期存款" },
        { value: "acct-2", label: "臺幣綜合存款" },
      ],
    );
    await resultPage.close();

    // The read half against a synthetic signed-in frameset: the site opens the
    // transaction-details route in fmain, picks the range, and queries each account.
    const SHELL_CID = "synthetic-deposit-cid";
    async function readThroughShell(
      options: Readonly<{ signal?: AbortSignal; holdQuery?: () => void }> = {},
    ) {
      const shellPage = await browser.newPage();
      const served: string[] = [];
      const queried: string[] = [];
      const items: PGliteWorkflowRunItem[] = [];
      const activities: string[] = [];
      const html = (body: string) => ({ contentType: "text/html; charset=utf-8", body });
      const form = (selected: string, result: string) => `<form name="jform" method="post" action="/nib/tx/transactiondetails">
        <input type="hidden" name="cid" value="${SHELL_CID}">
        <select id="acctno" name="acctno">
          <option value="">請選擇帳戶</option>
          ${[workflowAccount, { value: "YUANTA-ACCOUNT-002", label: "臺幣綜合存款 YUANTA-ACCOUNT-002" }]
            .map((account) => `<option value="${account.value}"${account.value === selected ? " selected" : ""}>${account.label}</option>`)
            .join("")}
        </select>
        <div id="duration"><a href="#" onclick="parent.picked = [...(parent.picked ?? []), this.textContent]; return false;">一週</a><a href="#" onclick="parent.picked = [...(parent.picked ?? []), this.textContent]; return false;">一個月</a></div>
        <button id="submitbutton" type="submit">查詢</button>
      </form>${result}`;
      try {
        await shellPage.route(`${YUANTA_EBANK_ORIGIN}/**`, async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          served.push(`${request.method()} ${url.pathname}${url.search}`);
          if (url.pathname === "/nib/shell.jsp") {
            return await route.fulfill(html(`<iframe name="fmenu" src="/nib/menu.jsp"></iframe><iframe name="fmain" src="/nib/tx/home?type=page&cid=${SHELL_CID}"></iframe>`));
          }
          if (url.pathname === "/nib/tx/transactiondetails" && request.method() === "POST") {
            const account = new URLSearchParams(request.postData() ?? "").get("acctno") ?? "";
            queried.push(account);
            if (options.holdQuery) {
              options.holdQuery();
              return;
            }
            return await route.fulfill(html(form(account, account === workflowAccount.value
              ? '<a class="order_2 m_color_check" href="/nib/tx/export.csv">下載CSV檔</a>'
              : '<table><tr><td colspan="2">查無資料</td></tr></table>')));
          }
          if (url.pathname === "/nib/tx/transactiondetails" && url.searchParams.get("cid") === SHELL_CID) {
            return await route.fulfill(html(form("", "")));
          }
          if (url.pathname === "/nib/tx/export.csv") {
            return await route.fulfill({
              contentType: "text/csv; charset=big5",
              headers: { "content-disposition": 'attachment; filename="yuanta-fixture.csv"' },
              body: browserFixtureBytes,
            });
          }
          return await route.fulfill(html(`<p>${url.pathname}</p>`));
        });
        await shellPage.goto(`${YUANTA_EBANK_ORIGIN}/nib/shell.jsp?cid=${SHELL_CID}`, { waitUntil: "load" });
        const snapshot = await readYuantaDepositSource(
          shellPage,
          { accountFilters: [], ...stableConnectionIdentity },
          checkContext(options.signal),
          yuantaStagingHandle(items, activities, collectionPeriod({ today: "2026-08-21", lookBack: ONE_MONTH })),
        );
        const picked = await shellPage.evaluate(() => (window as { picked?: string[] }).picked ?? []);
        return { snapshot, served, queried, items, activities, picked };
      } finally {
        await shellPage.close();
      }
    }

    const shellRead = await readThroughShell();
    assert.ok(
      shellRead.served.includes(`GET /nib/tx/transactiondetails?type=page&cid=${SHELL_CID}`),
      "the deposit page opens through the transaction-details route with the session's cid",
    );
    assert.deepEqual(shellRead.picked, ["一個月"], "the requested range is picked once on the opened page");
    assert.deepEqual(shellRead.queried, [workflowAccount.value, "YUANTA-ACCOUNT-002"], "every visible account is queried in order");
    assert.deepEqual(shellRead.activities, ["query", "download", "query"]);
    assert.equal(shellRead.snapshot.observedAt, "2026-08-21T11:04:05+08:00");
    assert.deepEqual(
      shellRead.snapshot.accounts.map((read) => [read.account.value, read.query]),
      [[workflowAccount.value, "download-ready"], ["YUANTA-ACCOUNT-002", "provider-explicit-no-data"]],
      "a CSV result and the bank's 查無資料 result are told apart per account",
    );
    const shellDownload = shellRead.snapshot.accounts[0];
    assert.ok(shellDownload?.query === "download-ready");
    assert.equal(shellDownload.download.filename, "yuanta-fixture.csv");
    assert.equal(shellDownload.download.rows.length, 1);
    assert.equal(shellDownload.download.source.byteLength, browserFixtureBytes.byteLength);
    assert.deepEqual(shellRead.items, [], "the read half stages nothing");

    const shellCancellation = new AbortController();
    const cancelledShellRead = readThroughShell({
      signal: shellCancellation.signal,
      holdQuery: () => shellCancellation.abort(new Error("deposit read cancelled")),
    });
    await assert.rejects(cancelledShellRead, /deposit read cancelled/u, "a run cancelled mid-query stops inside its wait");

    let runOrdinal = 0;
    async function collectFixture(
      controller = new AbortController(),
      items: PGliteWorkflowRunItem[] = [],
    ): Promise<{ result: Awaited<ReturnType<typeof stageYuantaDeposit>>; items: PGliteWorkflowRunItem[] }> {
      runOrdinal += 1;
      observedBrowserDownload = false;
      fixtureCookie = undefined;
      const signal = controller.signal;
      const browserPort = createAppWorkflowBrowserPort({
        taskId: "yuanta-domestic-fixture",
        taskRunId: `yuanta-domestic-run-${runOrdinal}`,
        userDataDirectory: browserFixtureDirectory,
        startUrl: `${browserFixtureBaseUrl}/start`,
        signal,
        launchPersistentContext: async () =>
          await browser.newContext({ acceptDownloads: false }),
      });
      const context = checkContext(signal);
      const result = await browserPort.withPage(async (page) => {
        page.on("download", () => { observedBrowserDownload = true; });
        const download = await downloadYuantaStatementRows(
          yuantaEbankSite(page, { signal, text: context.text }),
          workflowAccount,
        );
        return await stageYuantaDeposit(
          {
            observedAt: yuantaObservedAt(new Date(context.now())),
            queryRange: depositRange(ONE_MONTH, context.now()),
            accounts: [{ account: workflowAccount, query: "download-ready", download }],
          },
          { accountFilters: [], ...stableConnectionIdentity },
          context,
          yuantaStagingHandle(items),
          async () => [],
        );
      });
      return { result, items };
    }

    const success = await collectFixture();
    const result = success.result;
    const browserFixtureItems = success.items;
    assert.equal(result.sourceCaptureCount, 1);
    assert.ok(browserFixtureItems.length > 0);
    const typedCommandPayload = JSON.stringify(browserFixtureItems);
    const expectedFilenameDigest = createHash("sha256")
      .update("yuanta-filename-v1\0")
      .update("yuanta-fixture.csv")
      .digest("base64url");
    assert.ok(
      typedCommandPayload.includes(expectedFilenameDigest),
      "the selected safe response filename must contribute to source metadata",
    );
    assert.ok(
      typedCommandPayload.includes(
        createHash("sha256").update(browserFixtureBytes).digest("base64url"),
      ),
      "the raw export bytes must retain their content digest",
    );
    assert.equal(
      fixtureCookie,
      "yuanta-fixture-session=present",
      "the in-memory request must carry the authenticated same-origin cookie",
    );
    assert.equal(
      observedBrowserDownload,
      false,
      "App acceptDownloads:false collection must not trigger a browser download",
    );
    assert.deepEqual(await readdir(browserFixtureDirectory), ["data"]);
    assert.deepEqual(await readdir(join(browserFixtureDirectory, "data")), ["automation"]);
    assert.deepEqual(await readdir(join(browserFixtureDirectory, "data", "automation")), ["browser-state"]);
    assert.deepEqual(
      await readdir(join(browserFixtureDirectory, "data", "automation", "browser-state", "yuanta-domestic-fixture")),
      ["authentication"],
      "the export must remain in memory and not become a retained profile file",
    );
    assert.deepEqual(
      await readdir(join(browserFixtureDirectory, "data", "automation", "browser-state", "yuanta-domestic-fixture", "authentication")),
      [],
      "no cookie or export file is retained without a credential codec",
    );

    fixtureJavaScriptExport = true;
    const formExport = await collectFixture();
    assert.equal(formExport.result.sourceCaptureCount, 1);
    assert.equal(fixturePostCount, 1);
    assert.equal(fixtureCookie, "yuanta-fixture-session=present");
    assert.equal(observedBrowserDownload, false);
    fixtureJavaScriptExport = false;
    fixtureForeignJavaScriptExport = true;
    const foreignFormExport = await collectFixture();
    assert.equal(foreignFormExport.result.sourceCaptureCount, 1);
    assert.equal(fixturePostCount, 2);
    assert.equal(observedBrowserDownload, false);
    fixtureForeignJavaScriptExport = false;

    for (const testCase of [
      { href: null, mode: "success" as const, error: /no fetchable URL/u },
      { href: "javascript:void(0)", mode: "success" as const, error: /no fetchable URL/u },
      { href: crossOriginFixtureUrl, mode: "success" as const, error: /left the authenticated origin/u },
      {
        href: "/export.csv",
        base: `${new URL(crossOriginFixtureUrl).origin}/`,
        mode: "success" as const,
        error: /left the authenticated origin/u,
      },
      { href: "/export.csv", mode: "redirect-cross-origin" as const, error: /same-origin|Failed to fetch|redirect/u },
      { href: "/export.csv", mode: "forbidden" as const, error: /did not return a complete response/u },
      { href: "/export.csv", mode: "unsafe-filename" as const, error: /filename is unsafe/u },
      { href: "/export.csv", mode: "invalid-big5" as const, error: /Source text integrity failed/u },
      { href: "/export.csv", mode: "declared-oversize" as const, error: /in-memory size limit/u },
      { href: "/export.csv", mode: "streamed-oversize" as const, error: /in-memory size limit/u },
    ]) {
      fixtureHref = testCase.href;
      fixtureBaseHref = "base" in testCase ? testCase.base ?? null : null;
      fixtureBodyMode = testCase.mode;
      const rejectedItems: PGliteWorkflowRunItem[] = [];
      await assert.rejects(
        () => collectFixture(new AbortController(), rejectedItems),
        testCase.error,
      );
      assert.deepEqual(
        rejectedItems,
        [],
        `failed fixture ${testCase.mode} must not yield Canonical Financial Commit items`,
      );
    }
    assert.equal(
      crossOriginRequestCount,
      0,
      "a cross-origin target and a cross-origin redirect must not reach the target server",
    );
    assert.ok(
      streamedFixtureBytes > streamedFixtureLimit,
      "the streamed limit test must send bytes past the cap before the reader cancels",
    );
    assert.equal(
      streamWasCanceledEarly,
      true,
      "the browser response body reader must cancel before the oversized fixture finishes",
    );
    assert.ok(streamedFixtureBytes < streamedFixtureTotal);

    fixtureHref = "/export.csv";
    fixtureBaseHref = null;
    fixtureBodyMode = "redirect-same-origin";
    const redirectedSuccess = await collectFixture();
    assert.equal(redirectedSuccess.result.sourceCaptureCount, 1);
    assert.ok(redirectedSuccess.items.length > 0);
    assert.equal(fixtureCookie, "yuanta-fixture-session=present");
    assert.equal(observedBrowserDownload, false);

    fixtureHref = "/export.csv";
    fixtureBaseHref = null;
    fixtureBodyMode = "slow";
    const cancellation = new AbortController();
    const canceledItems: PGliteWorkflowRunItem[] = [];
    const exportStarted = new Promise<void>((resolve) => {
      slowExportStarted = resolve;
    });
    const pending = collectFixture(cancellation, canceledItems);
    await exportStarted;
    cancellation.abort(new Error("fixture run canceled"));
    await assert.rejects(pending, /fixture run canceled/u);
    assert.deepEqual(canceledItems, [], "canceled retrieval must return no Canonical Financial Commit items");
    assert.deepEqual(
      await readdir(browserFixtureOutputDirectory),
      [],
      "successful and rejected collection paths must leave no source, output, or log files",
    );
  } finally {
    await browser.close();
  }
} finally {
  process.chdir(browserFixtureOriginalCwd);
  await new Promise<void>((resolve, reject) => {
    browserFixtureServer.close((error) => error ? reject(error) : resolve());
  });
  await new Promise<void>((resolve, reject) => {
    crossOriginFixtureServer.close((error) => error ? reject(error) : resolve());
  });
  await rm(browserFixtureDirectory, { recursive: true, force: true });
  await rm(browserFixtureOutputDirectory, { recursive: true, force: true });
}
