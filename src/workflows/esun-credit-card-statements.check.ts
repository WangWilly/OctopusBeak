import assert from "node:assert/strict";
import {
  buildEsunCanonicalCreditCardCapture,
  type CaptureMetadata,
  deriveEsunCanonicalHumanAttestation,
  type GridState,
  type StatementRow,
  isEsunCompleteGrid,
} from "./esun-credit-card-statements.ts";
import { ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE } from "../ledger/canonical/esun-credit-card-human-attestation.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";

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
assert.equal(
  identity.identityEpochKey,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
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

const billedRow: StatementRow = {
  statementPeriod: "2026-07",
  cardNumber: "****1234",
  consumeDate: "2026/07/15",
  description: "Synthetic Coffee",
  foreignCurrency: "USD",
  foreignAmount: "10.00",
  paymentCurrency: "TWD",
  twdAmount: "-123.45",
  paymentStatus: "billed",
  sourcePaymentStatus: "已入帳",
};
const unbilledRow: StatementRow = {
  statementPeriod: "2026-08",
  cardNumber: "****1234",
  consumeDate: "2026/08/15",
  description: "Synthetic Transit",
  foreignCurrency: "",
  foreignAmount: "",
  paymentCurrency: "TWD",
  twdAmount: "45.67",
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
    issueDate: "2026-08-01",
    dueDate: "2026-08-20",
    currency: "TWD",
    balance: "123.45",
  },
];
const canonicalCapture = buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: completeGrid,
  capture: completeCapture,
  settledPeriods,
});
assert(canonicalCapture);
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
assert.doesNotMatch(
  JSON.stringify(canonicalCapture),
  /4111\*{8}1111|user-id-001|account-009|synthetic-esun-managed-secret/iu,
  "canonical E.SUN capture must retain only safe card keys and opaque identity",
);

const noSettledEvidence = buildEsunCanonicalCreditCardCapture({
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  identity,
  statementRows: [billedRow],
  unbilledRows: [unbilledRow],
  grid: completeGrid,
  capture: completeCapture,
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
    }),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /display-safe four-digit card key/u);
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
