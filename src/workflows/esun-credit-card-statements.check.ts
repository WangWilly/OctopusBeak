import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { ProductCollectionInterruptedError } from "../lib/automation/product-collection.ts";
import { withBoundProducts } from "../lib/automation/product-collection.fixtures.ts";
import { ESUN_SOURCE } from "../lib/automation/server/sources/esun.ts";
import { PreviewSourceFailure } from "../lib/preview-sources/source-kit.ts";
import { PGlite } from "@electric-sql/pglite";
import {
  buildEsunCanonicalCreditCardCapture,
  runEsunCreditCardProviderWorkflow,
  classifyEsunPostLoginPage,
  buildEsunSettledPeriodsFromIssuerSummaries,
  attachEsunIssuerStatementPeriods,
  deriveEsunProjectedInstrumentIdentity,
  esunIssuerSummaryFromLabelRows,
  esunIssuerSummaryFromText,
  type CaptureMetadata,
  deriveEsunCanonicalHumanAttestation,
  type GridState,
  type StatementRow,
  isEsunCompleteGrid,
  parseEsunCurrentCreditCardUsedCreditHtml,
  esunCurrentUsedCreditFromSummaryResponse,
  ESUN_CREDIT_CARD_IDENTITY_EPOCH,
  esunCreditCurrentSnapshotCapture,
  rowsFromTimelineResponse,
  esunTimelineQueryDates,
  issuerSummaryFromBillResponse,
} from "./esun-credit-card-statements.ts";
import {
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_ROUTE,
} from "../ledger/canonical/esun-credit-card-human-attestation-contract.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import {
  esunCanonicalSpineCapture,
  esunNeutralCreditCardCapture,
} from "../ledger/canonical/esun-credit-card-admission.ts";
import { creditCardBalanceCommandRequest, creditCardCommandRequestFromCanonicalCapture } from "../ledger/pglite/credit-card-adapters.ts";
import { createTestPGlite } from "../ledger/pglite/baseline-test-template.ts";
import { commitPGliteCanonicalCreditCardBalanceCapture, commitPGliteCanonicalCreditCardCapture } from "../ledger/pglite/credit-card.ts";
import { PGliteStore } from "../ledger/pglite/transaction.ts";

const workflowSource = await readFile(
  new URL("./esun-credit-card-statements.ts", import.meta.url),
  "utf8",
);
assert.match(workflowSource, /esun-credit-card-admission\.ts/);
assert.match(workflowSource, /credit-card-current-balance-admission\.ts/);
assert.match(workflowSource, /export async function runEsunCreditCardProviderWorkflow/);
assert.doesNotMatch(workflowSource, /from "libretto"/);
assert.doesNotMatch(workflowSource, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/);
assert.doesNotMatch(workflowSource, /node:fs\/promises|downloads\/esun-credit-card-statements|writeStatementFile/);
assert.doesNotMatch(workflowSource, /tableFileSchema|type TableFile|files: z\.array/);
assert.doesNotMatch(workflowSource, /export default workflow\(/);
assert.doesNotMatch(workflowSource, /from "\.\.\/ledger\/db\/client\.ts"/);
assert.doesNotMatch(workflowSource, /from "\.\.\/ledger\/canonical\/esun-credit-card\.ts"/);
assert.doesNotMatch(workflowSource, /from "\.\.\/ledger\/canonical\/credit-card-current-balance-writer\.ts"/);
assert.doesNotMatch(
  workflowSource,
  /canonicalFinancialLedgerDir|canonicalSourceLedgerDir|createCanonicalSourceStore|canonicalDatabaseWriterKey|DatabaseSync/,
);

assert.deepEqual(
  rowsFromTimelineResponse({ body: {
    rtnCode: "S", cursor: 1, transList: [{
      year: "2026", month: "09", transDetailList: [{
        merchantName: "Sample shop", paymentCurrency: "TWD", paymentAmount: 123,
        transCurrency: "USD", transAmount: 4, cardNo: "4323-XXXX-XXXX-8397",
        statusName: "未入帳", transMonthDay: "0921",
      }],
    }],
  } }).rows.map((row) => [row.consumeDate, row.paymentStatus, row.foreignCurrency, row.twdAmount]),
  [["2026/09/21", "unbilled", "USD", "123"]],
);
assert.throws(() => rowsFromTimelineResponse({ body: {
  rtnCode: "S", cursor: 1, transList: [{
    year: "2026", month: "09", transDetailList: [{
      merchantName: "Sample shop", paymentCurrency: "TWD", paymentAmount: 123,
      transCurrency: "TWD", transAmount: 123, cardNo: "4323-XXXX-XXXX-8397",
      statusName: "未知", transMonthDay: "0921",
    }],
  }],
} }));
assert.deepEqual(issuerSummaryFromBillResponse({ body: {
  rtnCode: "S", billInfo: {
    billDate: "20260915", paymentDueDate: "20261001",
    billTotalInfoList: [{ billTotalCurrency: "TWD", billTotalAmount: 11210 }],
    minimumPaymentInfoList: [{ minimumPaymentCurrency: "TWD", minimumPaymentAmount: 4183 }],
  },
} }), {
  cycleEnd: "2026/09/15", dueDate: "2026/10/01",
  balance: "11210", minimumPayment: "4183", currency: "TWD",
});

assert.equal(
  isEsunCompleteGrid({
    currentPage: "1",
    currentPageSize: String(2_147_483_647),
  }),
  true,
);
assert.equal(
  isEsunCompleteGrid({
    currentPage: "2",
    currentPageSize: String(2_147_483_647),
  }),
  false,
);
assert.equal(
  isEsunCompleteGrid({ currentPage: "1", currentPageSize: "100" }),
  false,
);

const credentials = {
  esun_user_id: " user-id-001 ",
  esun_account: " account-009 ",
  esun_password: "password-must-not-escape",
};
const managedSecret = "synthetic-esun-managed-secret";

assert.deepEqual(
  parseEsunCurrentCreditCardUsedCreditHtml(`
    <table class="decoy"><tr><td>信用狀態</td><td>已用額度</td><td>可用餘額</td></tr><tr><td>歸戶</td><td>999</td><td>1</td></tr></table>
    <p>查詢時間：2026/09/09 10:22:05</p>
    <table id="fcm01006:grid_DataGridBody">
      <tr><td>信用狀態</td><td>已用額度</td><td>可用餘額</td></tr>
      <tr><td>正卡</td><td>1,000</td><td>9,000</td></tr>
      <tr><td>歸戶</td><td>12,345</td><td>87,655</td></tr>
      <tr><td>指定額度</td><td>8,000</td><td></td></tr>
    </table>
  `),
  {
    usedCredit: "12345",
    available: "87655",
    sourceField: "已用額度",
    queryTime: "2026/09/09 10:22:05",
  },
);
assert.throws(
  () =>
    parseEsunCurrentCreditCardUsedCreditHtml(`
      <p>查詢時間：2026/09/09 10:22:05</p>
      <table id="fcm01006:grid_DataGridBody"><tr><td>信用狀態</td><td>已用額度</td><td>可用餘額</td></tr><tr><td>歸戶</td><td>1</td><td>2</td></tr></table>
      <table id="fcm01006:grid_DataGridBody"><tr><td>信用狀態</td><td>已用額度</td><td>可用餘額</td></tr><tr><td>歸戶</td><td>3</td><td>4</td></tr></table>
    `),
  /ambiguous/u,
);

const redesignedCurrentCredit = esunCurrentUsedCreditFromSummaryResponse({
  resultCode: "0000",
  resultTime: "2026-09-24 15:21:22",
  resultBody: {
    hasCreditCard: true,
    usedCreditLimit: "46,989",
    availableCreditLimit: "53,011",
  },
}, {
  endpoint: "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
  httpDate: "Thu, 24 Sep 2026 07:21:22 GMT",
});
assert(redesignedCurrentCredit);
assert.equal(redesignedCurrentCredit.usedCredit, "46989");
assert.equal(redesignedCurrentCredit.queryTime, "2026-09-24 15:21:22");

const identity = deriveEsunCanonicalHumanAttestation(
  credentials,
  managedSecret,
);
assert(identity);
assert.deepEqual(
  identity,
  deriveEsunCanonicalHumanAttestation(
    {
      esun_user_id: " USER-ID-001 ",
      esun_account: "ACCOUNT-009",
      esun_password: "rotated-password",
    },
    ` ${managedSecret} `,
  ),
  "normalized E.SUN login scope and the managed secret must be deterministic",
);

assert.deepEqual(
  esunIssuerSummaryFromLabelRows([
    ["帳款結帳日", "115/07/31", "繳款截止日", "115/08/20"],
    ["本期應繳總金額", "NT$ 2,000"],
    ["本期最低應繳金額", "200"],
  ]),
  {
    cycleEnd: "115/07/31",
    dueDate: "115/08/20",
    balance: "2000",
    minimumPayment: "200",
    currency: "TWD",
  },
);
assert.deepEqual(
  esunIssuerSummaryFromLabelRows([
    ["繳款截止日", "帳款結帳日"],
    ["115/08/20", "115/07/31"],
    ["本期應繳總金額", "本期最低應繳金額"],
    ["2,000", "200"],
  ]),
  {
    cycleEnd: "115/07/31",
    dueDate: "115/08/20",
    balance: "2000",
    minimumPayment: "200",
    currency: "TWD",
  },
);
assert.deepEqual(
  esunIssuerSummaryFromText(
    "帳款結帳日\n115/07/31\n繳款截止日：115/08/20\n本期應繳總金額 NT$ 2,000\n本期最低應繳金額 200",
  ),
  {
    cycleEnd: "115/07/31",
    dueDate: "115/08/20",
    balance: "2000",
    minimumPayment: "200",
    currency: "TWD",
  },
);
assert.equal(
  identity.identityEpochKey,
  ESUN_CREDIT_CARD_IDENTITY_EPOCH,
);
assert.notEqual(
  identity.sourceConnectionKey,
  deriveEsunCanonicalHumanAttestation(
    { esun_user_id: "other-user", esun_account: "account-009" },
    managedSecret,
  )?.sourceConnectionKey,
);
assert.notEqual(
  identity.humanAttestedAccountKey,
  deriveEsunCanonicalHumanAttestation(credentials, "different-managed-secret")
    ?.humanAttestedAccountKey,
);
assert.equal(
  deriveEsunCanonicalHumanAttestation(
    { esun_user_id: "user-id-001" },
    managedSecret,
  ),
  undefined,
);
assert.equal(deriveEsunCanonicalHumanAttestation(credentials, " "), undefined);
const serializedIdentity = JSON.stringify(identity);
assert.doesNotMatch(
  serializedIdentity,
  /user-id-001|account-009|password-must-not-escape|synthetic-esun-managed-secret/iu,
  "derived E.SUN identity must never expose login values or the managed secret",
);

const projected = deriveEsunProjectedInstrumentIdentity(
  "1234-****-****-5678",
  identity,
  managedSecret,
);
assert(projected);
assert.equal(projected.cardMask, "****5678");
assert.match(projected.instrumentKey, /^esun_instrument_[A-Za-z0-9_-]+$/u);
assert.deepEqual(
  projected,
  deriveEsunProjectedInstrumentIdentity(
    "1234 **** **** 5678",
    identity,
    managedSecret,
  ),
);
assert.notEqual(
  projected.instrumentKey,
  deriveEsunProjectedInstrumentIdentity(
    "9876-****-****-5678",
    identity,
    managedSecret,
  )?.instrumentKey,
  "same last four with a different first four must be a different instrument",
);
assert.equal(
  deriveEsunProjectedInstrumentIdentity("****5678", identity, managedSecret),
  undefined,
);
assert.equal(
  deriveEsunProjectedInstrumentIdentity(
    "1234-5678-9012-3456",
    identity,
    managedSecret,
  ),
  undefined,
);

assert.deepEqual(
  buildEsunSettledPeriodsFromIssuerSummaries([
    {
      cycleEnd: "115/06/30",
      dueDate: "115/07/20",
      balance: "1,000",
      minimumPayment: "100",
    },
    {
      cycleEnd: "115/07/31",
      dueDate: "115/08/20",
      balance: "2,000",
      minimumPayment: "200",
    },
  ]),
  [{
    period: "2026-07",
    cycleStart: "2026-07-01",
    cycleEnd: "2026-07-31",
    issueDate: "2026-07-31",
    dueDate: "2026-08-20",
    currency: "TWD",
    balance: "2000",
    minimumPayment: "200",
  }],
);

const billedRow: StatementRow = {
  issuerStatementPeriod: "2026-07",
  cardNumber: "4111-****-****-1234",
  consumeDate: "2026/07/15",
  description: "Synthetic Coffee",
  foreignCurrency: "USD",
  foreignAmount: "10.00",
  paymentCurrency: "TWD",
  twdAmount: "123.45",
  paymentStatus: "billed",
  sourcePaymentStatus: "已入帳",
};
const unbilledRow: StatementRow = {
  issuerStatementPeriod: "2026-08",
  cardNumber: "4111-****-****-1234",
  consumeDate: "2026/08/15",
  description: "Synthetic Transit",
  foreignCurrency: "",
  foreignAmount: "",
  paymentCurrency: "TWD",
  twdAmount: "-45.67",
  paymentStatus: "unbilled",
  sourcePaymentStatus: "未入帳",
};
const completeGrid: GridState = {
  currentPage: "1",
  currentPageSize: String(2_147_483_647),
};
const completeCapture: CaptureMetadata = {
  snapshotMode: "full",
  captureId: "capture-esun-check",
  capturedAt: "2026-08-26T00:00:00.000Z",
  captureKinds: ["billed", "unbilled"],
  completenessEvidence: {
    bank: "esun",
    range: "default_one_year",
    grid: completeGrid,
  },
};
const settledPeriods = [
  {
    period: "2026-07",
    cycleStart: "2026-07-01",
    cycleEnd: "2026-07-31",
    issueDate: "2026-07-31",
    dueDate: "2026-08-20",
    currency: "TWD",
    balance: "123.45",
    minimumPayment: "12.34",
  },
];
const rowsWithIssuerPeriods = attachEsunIssuerStatementPeriods(
  [
    { ...billedRow, issuerStatementPeriod: undefined },
    { ...unbilledRow, issuerStatementPeriod: undefined },
  ],
  settledPeriods,
);
assert.equal(rowsWithIssuerPeriods[0]?.issuerStatementPeriod, "2026-07");
assert.equal(rowsWithIssuerPeriods[1]?.issuerStatementPeriod, undefined);
const canonicalCapture = buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: completeGrid,
  capture: completeCapture,
  instrumentFingerprintSecret: managedSecret,
  settledPeriods,
});
assert(canonicalCapture);
const statementAmountRevision = buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: completeGrid,
  capture: { ...completeCapture, captureId: "capture-esun-statement-amount-check" },
  instrumentFingerprintSecret: managedSecret,
  settledPeriods: [{ ...settledPeriods[0]!, balance: "124.45" }],
});
assert(statementAmountRevision);
assert.notEqual(
  canonicalCapture.statements[0]?.revisionKey,
  statementAmountRevision.statements[0]?.revisionKey,
  "a changed issuer statement amount must create a new immutable statement revision",
);
const memberEvidenceRevision = buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [{ ...billedRow, issuerStatementPeriod: "2026-06" }],
  unbilledRows: [unbilledRow],
  grid: completeGrid,
  capture: { ...completeCapture, captureId: "capture-esun-member-evidence-check" },
  instrumentFingerprintSecret: managedSecret,
  settledPeriods,
});
assert(memberEvidenceRevision);
assert.equal(
  canonicalCapture.transactions[0]?.sourceKey,
  memberEvidenceRevision.transactions[0]?.sourceKey,
  "issuer billing metadata must not change transaction occurrence identity",
);
assert.notEqual(
  canonicalCapture.statements[0]?.revisionKey,
  memberEvidenceRevision.statements[0]?.revisionKey,
  "member evidence changes must create a new immutable statement revision",
);
const timelineGrid = {
  kind: "past-year-timeline" as const,
  firstMonth: "2026/08",
  lastMonth: "2025/08",
  months: Array.from({ length: 13 }, (_, index) =>
    new Date(Date.UTC(2026, 7 - index, 1)).toISOString().slice(0, 7).replace("-", "/")),
  pageCount: 3,
  monthCount: 13,
  capturedRowCount: 2,
  terminal: true as const,
  terminalCursor: 4 as const,
};
const timelineCapture = buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: timelineGrid,
  capture: completeCapture,
  instrumentFingerprintSecret: managedSecret,
  settledPeriods,
});
assert(timelineCapture);
const twelveMonthGrid = {
  ...timelineGrid,
  lastMonth: "2025/09",
  months: timelineGrid.months.slice(0, 12),
  monthCount: 12,
};
assert(buildEsunCanonicalCreditCardCapture({
  startDate: "2025/09/01",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: twelveMonthGrid,
  capture: completeCapture,
  instrumentFingerprintSecret: managedSecret,
  settledPeriods,
}));
for (const grid of [
  { ...twelveMonthGrid, terminalCursor: 3 as 4 },
  { ...twelveMonthGrid, months: twelveMonthGrid.months.slice(0, 11) },
  { ...twelveMonthGrid, lastMonth: "2025/10", monthCount: 11, months: twelveMonthGrid.months.slice(0, 11) },
]) {
  let result;
  try {
    result = buildEsunCanonicalCreditCardCapture({
      startDate: "2025/09/01",
      endDate: "2026/08/26",
      identity,
      statementRows: [billedRow],
      unbilledRows: [unbilledRow],
      grid,
      capture: completeCapture,
      instrumentFingerprintSecret: managedSecret,
      settledPeriods,
    });
  } catch (error) {
    assert.match(String(error), /E\.SUN/u);
    continue;
  }
  assert.equal(result, undefined);
}
const currentCreditCapture = esunCreditCurrentSnapshotCapture(timelineCapture, redesignedCurrentCredit);
assert.equal(currentCreditCapture.authorityRoute, "esun/credit-card/current-used-credit-v2");
assert.equal(currentCreditCapture.observations[0]?.time.effectiveAt, "2026-09-24T07:21:22.000Z");
assert.throws(
  () => esunCreditCurrentSnapshotCapture(timelineCapture, {
    ...redesignedCurrentCredit,
    httpDate: "Thu, 24 Sep 2026 07:22:22 GMT",
  }),
  /resultTime and HTTP Date differ/u,
);
assert.equal(timelineCapture.scope.completeness.grid.kind, "past-year-timeline");
const timelineSpine = esunCanonicalSpineCapture(timelineCapture);
assert.equal(timelineSpine.authorityRoute, ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_ROUTE);
assert.equal(timelineSpine.pages[0]?.proofKind, "bounded-one-year-timeline");
assert.equal(
  timelineSpine.scope.completenessBasis,
  "bank-last-year-timeline-current-month-through-twelve-or-thirteen-contiguous-months-terminal-cursor-four-card-counts",
);
const timelineCommand = creditCardCommandRequestFromCanonicalCapture(
  timelineSpine,
  esunNeutralCreditCardCapture(timelineCapture),
);
assert.equal(timelineCommand.capture.routeKey, ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_ROUTE);
test("E.SUN v4 timeline capture commits to a fresh PGlite database", async () => {
  const database = await createTestPGlite("ledger");
  const store = new PGliteStore(database);
  try {
    const result = await commitPGliteCanonicalCreditCardCapture(store, timelineCommand);
    assert.equal(result.transactionCount, 2);
    assert.equal(result.statementCount, 1);
    const repeatCapture = buildEsunCanonicalCreditCardCapture({
      startDate: "2025/08/26",
      endDate: "2026/08/26",
      identity,
      statementRows: [billedRow],
      unbilledRows: [unbilledRow],
      grid: timelineGrid,
      capture: { ...completeCapture, captureId: "capture-esun-repeat-check" },
      instrumentFingerprintSecret: managedSecret,
      settledPeriods,
    });
    assert(repeatCapture);
    const repeatCommand = creditCardCommandRequestFromCanonicalCapture(
      esunCanonicalSpineCapture(repeatCapture),
      esunNeutralCreditCardCapture(repeatCapture),
    );
    const repeated = await commitPGliteCanonicalCreditCardCapture(store, repeatCommand);
    assert.equal(repeated.statementCount, 1);
    const balanceResult = await commitPGliteCanonicalCreditCardBalanceCapture(
      store,
      creditCardBalanceCommandRequest(currentCreditCapture, timelineCommand.identity),
    );
    assert.equal(balanceResult.balanceRevisionCreated, true);
  } finally {
    await store.close();
  }
});

test("E.SUN duplicate slots survive a complete billing move and reject same-capture overlap", async () => {
  const database = await createTestPGlite("ledger");
  const store = new PGliteStore(database);
  const duplicateBilled: StatementRow = {
    ...billedRow,
    issuerStatementPeriod: "2026-07",
  };
  const duplicateUnbilled: StatementRow = {
    ...billedRow,
    issuerStatementPeriod: undefined,
    paymentStatus: "unbilled",
    sourcePaymentStatus: "未入帳",
  };
  const buildDuplicateCommand = (
    captureId: string,
    statementRows: readonly StatementRow[],
    unbilledRows: readonly StatementRow[],
  ) => {
    const rows = [...statementRows, ...unbilledRows];
    const capture = buildEsunCanonicalCreditCardCapture({
      startDate: "2025/08/26",
      endDate: "2026/08/26",
      identity,
      statementRows,
      unbilledRows,
      grid: { ...timelineGrid, capturedRowCount: rows.length },
      capture: { ...completeCapture, captureId },
      instrumentFingerprintSecret: managedSecret,
      settledPeriods,
    });
    assert(capture);
    return creditCardCommandRequestFromCanonicalCapture(
      esunCanonicalSpineCapture(capture),
      esunNeutralCreditCardCapture(capture),
    );
  };
  try {
    await commitPGliteCanonicalCreditCardCapture(
      store,
      buildDuplicateCommand("esun-duplicates-unbilled", [], [duplicateUnbilled, duplicateUnbilled]),
    );
    assert.throws(
      () => buildDuplicateCommand("esun-duplicates-split", [duplicateBilled], [duplicateUnbilled]),
      /ambiguous identical economic transaction/u,
    );
    assert.equal(Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count), 1);
    await commitPGliteCanonicalCreditCardCapture(
      store,
      buildDuplicateCommand("esun-duplicates-billed", [duplicateBilled, duplicateBilled], []),
    );

    const counts = await store.query<{ transactions: number; revisions: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM financial_transactions) AS transactions,
        (SELECT COUNT(*)::int FROM transaction_revisions) AS revisions`);
    assert.deepEqual(counts.rows[0], { transactions: 2, revisions: 2 });
    const latest = await store.query<{ billing_status: string; group_ordinal: number | string }>(`
      SELECT DISTINCT ON (lifecycle.transaction_id)
        lifecycle.billing_status,
        source_record.occurrence_group_ordinal AS group_ordinal
      FROM canonical_credit_card_transaction_lifecycle lifecycle
      JOIN source_records source_record
        ON source_record.source_record_id = lifecycle.source_record_id
      JOIN source_captures source_capture
        ON source_capture.capture_id = lifecycle.capture_id
      JOIN canonical_commits commit_row
        ON commit_row.commit_id = source_capture.commit_id
      WHERE lifecycle.integration_namespace = 'esun'
      ORDER BY lifecycle.transaction_id, commit_row.commit_sequence DESC,
        lifecycle.lifecycle_event_id DESC`);
    assert.deepEqual(
      latest.rows.map((row) => ({
        billingStatus: row.billing_status,
        ordinal: Number(row.group_ordinal),
      })).sort((left, right) => left.ordinal - right.ordinal),
      [
        { billingStatus: "billed", ordinal: 1 },
        { billingStatus: "billed", ordinal: 2 },
      ],
    );
  } finally {
    await store.close();
  }
});
assert.throws(() => buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: { ...timelineGrid, monthCount: 12 },
  capture: completeCapture,
  instrumentFingerprintSecret: managedSecret,
  settledPeriods,
}), /complete past-year timeline coverage/u);
assert.equal(canonicalCapture.transactions.length, 2);
assert.equal(canonicalCapture.instruments.length, 1);
assert.equal(canonicalCapture.instruments[0]?.cardMask, "****1234");
assert.equal(canonicalCapture.statements.length, 1);
assert.equal(canonicalCapture.statements[0]?.transactionSourceKeys.length, 1);
assert.equal(
  canonicalCapture.scope.completeness.settledSummaryEvidencePresent,
  true,
);
assert.deepEqual(
  canonicalCapture.transactions.map((transaction) => ({
    consumeDate: transaction.consumeDate,
    bookedCurrency: transaction.bookedCurrency,
    billingStatus: transaction.billingStatus,
    direction: transaction.direction,
  })),
  [
    {
      consumeDate: "2026-07-15",
      bookedCurrency: "TWD",
      billingStatus: "billed",
      direction: "outflow",
    },
    {
      consumeDate: "2026-08-15",
      bookedCurrency: "TWD",
      billingStatus: "unbilled",
      direction: "inflow",
    },
  ],
);
assert.deepEqual(
  canonicalCapture.transactions.map((transaction) => ({
    direction: transaction.direction,
    bookedAmount: transaction.bookedAmount,
    bookedCurrency: transaction.bookedCurrency,
    signedAmount: transaction.signedAmount,
    postingStatus: transaction.postingStatus,
    billingStatus: transaction.billingStatus,
  })),
  [
    {
      direction: "outflow",
      bookedAmount: { coefficient: "12345", scale: 2 },
      bookedCurrency: "TWD",
      signedAmount: "123.45",
      postingStatus: "posted",
      billingStatus: "billed",
    },
    {
      direction: "inflow",
      bookedAmount: { coefficient: "4567", scale: 2 },
      bookedCurrency: "TWD",
      signedAmount: "-45.67",
      postingStatus: "posted",
      billingStatus: "unbilled",
    },
  ],
);
assert.doesNotMatch(
  JSON.stringify(canonicalCapture),
  /4111|user-id-001|account-009|synthetic-esun-managed-secret/iu,
  "canonical E.SUN capture must retain only safe card keys and opaque identity",
);

test("rolling query range does not become a transaction statement period", () => {
  const billedGridRow = { ...billedRow, issuerStatementPeriod: undefined };
  const unbilledGridRow = { ...unbilledRow, issuerStatementPeriod: undefined };
  const first = buildEsunCanonicalCreditCardCapture({
    startDate: "2025/08/26",
    endDate: "2026/08/26",
    identity,
    statementRows: [billedGridRow],
    unbilledRows: [unbilledGridRow],
    grid: completeGrid,
    capture: completeCapture,
    instrumentFingerprintSecret: managedSecret,
  });
  const second = buildEsunCanonicalCreditCardCapture({
    startDate: "2025/08/27",
    endDate: "2026/08/27",
    identity,
    statementRows: [billedGridRow],
    unbilledRows: [unbilledGridRow],
    grid: completeGrid,
    capture: {
      ...completeCapture,
      captureId: "capture-esun-rolling-query",
    },
    instrumentFingerprintSecret: managedSecret,
  });
  assert(first);
  assert(second);
  assert.deepEqual(
    first.transactions.map((transaction) => transaction.statementPeriod),
    [undefined, undefined],
  );
  assert.deepEqual(
    first.transactions.map((transaction) => transaction.sourceKey),
    second.transactions.map((transaction) => transaction.sourceKey),
  );
});

const noSettledEvidence = buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: completeGrid,
  capture: completeCapture,
  instrumentFingerprintSecret: managedSecret,
});
assert(noSettledEvidence);
assert.equal(
  noSettledEvidence.statements.length,
  0,
  "query range alone must not be promoted to a settled statement",
);
assert.equal(
  noSettledEvidence.scope.completeness.settledSummaryEvidencePresent,
  false,
);

const partialCapture: CaptureMetadata = {
  snapshotMode: "partial",
  completenessEvidence: { bank: "esun", reason: "date_range_override" },
};
assert.equal(
  buildEsunCanonicalCreditCardCapture({
    startDate: "2026/01/01",
    endDate: "2026/06/30",
    identity,
    statementRows: [billedRow],
    unbilledRows: [unbilledRow],
    grid: completeGrid,
    capture: partialCapture,
    instrumentFingerprintSecret: managedSecret,
  }),
  undefined,
  "partial E.SUN captures must remain source-only",
);
assert.equal(
  buildEsunCanonicalCreditCardCapture({
    startDate: "2025/08/26",
    endDate: "2026/08/26",
    identity,
    statementRows: [billedRow],
    unbilledRows: [unbilledRow],
    grid: { currentPage: "1", currentPageSize: "100" },
    capture: completeCapture,
    instrumentFingerprintSecret: managedSecret,
  }),
  undefined,
  "a non-terminal maximum-page grid must remain source-only",
);
assert.throws(
  () =>
    buildEsunCanonicalCreditCardCapture({
      startDate: "2025/08/26",
      endDate: "2026/08/26",
      identity,
      statementRows: [{ ...billedRow, cardNumber: "4111 1111 1111 1111" }],
      unbilledRows: [unbilledRow],
      grid: completeGrid,
      capture: completeCapture,
      instrumentFingerprintSecret: managedSecret,
    }),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /masked first-four and last-four card projection/u);
    assert.doesNotMatch(message, /4111111111111111/u);
    return true;
  },
  "raw E.SUN card numbers must be rejected without leaking the value",
);

const previousManagedSecret =
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
try {
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = managedSecret;
  assert.deepEqual(
    deriveEsunCanonicalHumanAttestation(credentials),
    identity,
    "the config alias must resolve the managed identity secret from the environment",
  );
} finally {
  if (previousManagedSecret === undefined) {
    delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  } else {
    process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] =
      previousManagedSecret;
  }
}

test("an unexpected E.SUN post-login page is classified by kind, never by its text", () => {
  assert.deepEqual(classifyEsunPostLoginPage("請輸入圖形驗證碼"), ["captcha"]);
  assert.deepEqual(classifyEsunPostLoginPage("我們已傳送簡訊動態密碼至您的手機"), ["otp"]);
  assert.deepEqual(classifyEsunPostLoginPage("偵測到新裝置登入，請完成綁定"), ["device"]);
  assert.deepEqual(classifyEsunPostLoginPage("您已重複登入"), ["duplicate-login"]);
  assert.deepEqual(classifyEsunPostLoginPage("您的密碼到期，請變更密碼"), ["password-change"]);
  assert.deepEqual(classifyEsunPostLoginPage("使用者代號或密碼輸入錯誤"), ["credentials-rejected"]);
  assert.deepEqual(classifyEsunPostLoginPage("帳號已鎖定"), ["locked"]);
  assert.deepEqual(classifyEsunPostLoginPage("請輸入簡訊 OTP，並完成裝置綁定"), ["otp", "device"]);
  assert.deepEqual(classifyEsunPostLoginPage("歡迎光臨"), ["unrecognized"]);
  for (const state of classifyEsunPostLoginPage("驗證碼 OTP 裝置 重複登入 變更密碼 密碼錯誤 鎖定")) {
    assert.match(`esun-post-login-${state}`, /^[a-z][a-z0-9-]{0,63}$/u);
  }
});

for (const scenario of ["unavailable portal", "cancellation while waiting for the portal"] as const) {
  test(`E.SUN attached-only run handles ${scenario}`, async () => {
    const controller = new AbortController();
    let portalRequests = 0;
    const page = {
      on: () => undefined,
      url: () => "https://ebank.esunbank.com.tw/index.jsp",
      getByText: () => ({ isVisible: async () => true }),
      waitForFunction: async () => {
        if (scenario === "cancellation while waiting for the portal") {
          controller.abort();
          throw new Error("synthetic portal cancellation");
        }
      },
      evaluate: async () => { portalRequests += 1; return { kind: "portal-session-missing" }; },
    } as unknown as Page;
    const context = {
      runId: "esun-result-check",
      signal: controller.signal,
      now: () => "2026-10-15T02:00:00.000Z",
      browser: { withPage: async (run: (page: Page) => Promise<unknown>) => run(page) },
      event: async () => undefined,
      previewWrite: { write: async () => { throw new Error("no incomplete product may write"); } },
    } as unknown as WorkflowContextWith<"financialCommit">;
    const input = {
      managedIdentitySecret: "synthetic-identity-secret",
      credentials: { esun_user_id: "synthetic-user", esun_account: "synthetic-account", esun_password: "synthetic-password" },
      statementTypes: [],
      attachedPreviewProducts: ["deposit"],
    };
    await assert.rejects(runEsunCreditCardProviderWorkflow(withBoundProducts(context, ESUN_SOURCE, input), input), (error: unknown) => {
      if (scenario === "unavailable portal") {
        assert.ok(error instanceof PreviewSourceFailure);
        assert.equal(error.reason, "unexpected-response", "keep the sole product's existing failure classification");
        return true;
      }
      assert.ok(error instanceof ProductCollectionInterruptedError, String(error));
      assert.equal(error.errorCode, "cancelled");
      assert.deepEqual(error.summary.products.map((p) => [p.typeId, p.status, p.skipReason]), [
        ["credit_card", "skipped", "not_selected"],
        ["deposit", "skipped", "not_attempted"],
      ]);
      assert.equal(error.summary.committedCount, 0);
      return true;
    });
    assert.equal(portalRequests, scenario === "unavailable portal" ? 1 : 0);
  });
}

test("the timeline queries from today in Taipei back to its anniversary, clamped on a leap day", () => {
  for (const [now, startDate, endDate] of [
    ["2028-02-29T04:00:00.000Z", "2027/02/28", "2028/02/29"],
    ["2028-02-28T16:30:00.000Z", "2027/02/28", "2028/02/29"],
    ["2024-02-29T04:00:00.000Z", "2023/02/28", "2024/02/29"],
    ["2028-03-01T04:00:00.000Z", "2027/03/01", "2028/03/01"],
    ["2026-10-25T04:00:00.000Z", "2025/10/25", "2026/10/25"],
  ] as const) {
    assert.deepEqual(esunTimelineQueryDates(now), { startDate, endDate }, now);
  }
});
