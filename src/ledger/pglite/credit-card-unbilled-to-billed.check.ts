import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  buildEsunCanonicalCreditCardCapture,
  deriveEsunCanonicalHumanAttestation,
  type CaptureMetadata,
  type StatementRow,
} from "../../workflows/esun-credit-card-statements.ts";
import {
  esunCanonicalSpineCapture,
  esunNeutralCreditCardCapture,
} from "../canonical/esun-credit-card-admission.ts";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { creditCardCommandRequestFromCanonicalCapture } from "./credit-card-adapters.ts";
import {
  commitPGliteCanonicalCreditCardCapture,
  type PGliteCanonicalCreditCardCaptureRequest,
} from "./credit-card.ts";
import { PGliteCanonicalSourceAdmissionError } from "./source-admission-validation.ts";
import { PGliteStore } from "./transaction.ts";

// GitHub issue #186: a purchase whose merchant text or amount changes when it
// posts must end as one billed transaction, never an unbilled copy beside a
// billed copy. These checks drive the real E.SUN admission seam so the
// occurrence fingerprint, month buckets, and statement membership are the
// production ones.

const managedSecret = "synthetic-esun-managed-secret";
const derivedIdentity = deriveEsunCanonicalHumanAttestation(
  { esun_user_id: "user-id-186", esun_account: "account-186", esun_password: "secret" },
  managedSecret,
);
assert(derivedIdentity);
const identity = derivedIdentity;

const card = "4111-****-****-1234";
const otherCard = "4111-****-****-5678";
const purchaseRow = (
  consumeDate: string,
  description: string,
  twdAmount: string,
  billing: Readonly<{ status: "billed"; period: string } | { status: "unbilled" }>,
  cardNumber = card,
): StatementRow => ({
  issuerStatementPeriod: billing.status === "billed" ? billing.period : undefined,
  cardNumber,
  consumeDate,
  description,
  foreignCurrency: "",
  foreignAmount: "",
  paymentCurrency: "TWD",
  twdAmount,
  paymentStatus: billing.status,
  sourcePaymentStatus: billing.status === "billed" ? "已入帳" : "未入帳",
});

const julyCoffee = purchaseRow("2026/07/15", "Synthetic Coffee", "120", { status: "billed", period: "2026-07" });
const julyBooks = purchaseRow("2026/07/20", "Synthetic Books", "380", { status: "billed", period: "2026-07" });
const augustTransitUnbilled = purchaseRow("2026/08/15", "Synthetic Transit", "45", { status: "unbilled" });
// The same August purchase after posting: the issuer rewrote the merchant
// text and finalized the amount.
const augustTransitBilled = purchaseRow("2026/08/15", "SYNTHETIC TRANSIT TPE", "46", { status: "billed", period: "2026-08" });

const settledJuly = {
  period: "2026-07",
  cycleStart: "2026-07-01",
  cycleEnd: "2026-07-31",
  issueDate: "2026-07-31",
  dueDate: "2026-08-20",
  currency: "TWD",
  balance: "500",
  minimumPayment: "50",
};
const settledAugust = {
  period: "2026-08",
  cycleStart: "2026-08-01",
  cycleEnd: "2026-08-31",
  issueDate: "2026-08-31",
  dueDate: "2026-09-20",
  currency: "TWD",
  balance: "46",
  minimumPayment: "10",
};

/** Thirteen consecutive months ending at `endMonth` (`YYYY/MM`), newest first. */
function timelineGrid(endMonth: string, capturedRowCount: number) {
  const [year, month] = endMonth.split("/").map(Number) as [number, number];
  const months = Array.from({ length: 13 }, (_, index) =>
    new Date(Date.UTC(year, month - 1 - index, 1)).toISOString().slice(0, 7).replace("-", "/"));
  return {
    kind: "past-year-timeline" as const,
    firstMonth: months[0]!,
    lastMonth: months[12]!,
    months,
    pageCount: 3,
    monthCount: 13,
    capturedRowCount,
    terminal: true as const,
    terminalCursor: 4 as const,
  };
}

function command(
  captureId: string,
  window: Readonly<{ startDate: string; endDate: string; endMonth: string }>,
  statementRows: readonly StatementRow[],
  unbilledRows: readonly StatementRow[],
  settledPeriods: readonly (typeof settledJuly)[],
): PGliteCanonicalCreditCardCaptureRequest {
  const capture: CaptureMetadata = {
    snapshotMode: "full",
    captureId,
    capturedAt: `${window.endDate.replaceAll("/", "-")}T00:00:00.000Z`,
    captureKinds: ["billed", "unbilled"],
    completenessEvidence: { bank: "esun", range: "default_one_year" },
  };
  const validated = buildEsunCanonicalCreditCardCapture({
    startDate: window.startDate,
    endDate: window.endDate,
    identity,
    statementRows,
    unbilledRows,
    grid: timelineGrid(window.endMonth, statementRows.length + unbilledRows.length),
    capture,
    instrumentFingerprintSecret: managedSecret,
    settledPeriods,
  });
  assert(validated, "E.SUN capture builder accepted the fixture");
  return creditCardCommandRequestFromCanonicalCapture(
    esunCanonicalSpineCapture(validated),
    esunNeutralCreditCardCapture(validated),
  );
}

const augustWindow = { startDate: "2025/08/26", endDate: "2026/08/26", endMonth: "2026/08" };
const septemberWindow = { startDate: "2025/09/26", endDate: "2026/09/26", endMonth: "2026/09" };
const octoberWindow = { startDate: "2025/10/26", endDate: "2026/10/26", endMonth: "2026/10" };

type Ledger = Readonly<{
  current: number;
  billingStatuses: readonly string[];
  descriptions: readonly string[];
}>;

async function ledger(store: PGliteStore): Promise<Ledger> {
  const rows = await store.query<{ billing_status: string; description: string }>(`
    SELECT DISTINCT ON (current.transaction_id)
      lifecycle.billing_status,
      revision.description
    FROM current_transactions current
    JOIN transaction_revisions revision ON revision.revision_id = current.revision_id
    JOIN canonical_credit_card_transaction_lifecycle lifecycle
      ON lifecycle.transaction_id = current.transaction_id
    JOIN source_captures source_capture ON source_capture.capture_id = lifecycle.capture_id
    JOIN canonical_commits commit_row ON commit_row.commit_id = source_capture.commit_id
    ORDER BY current.transaction_id, commit_row.commit_sequence DESC, lifecycle.lifecycle_event_id DESC`);
  return {
    current: rows.rows.length,
    billingStatuses: rows.rows.map((row) => row.billing_status).sort(),
    descriptions: rows.rows.map((row) => row.description).sort(),
  };
}

const threeBilledPurchases: Ledger = {
  current: 3,
  billingStatuses: ["billed", "billed", "billed"],
  descriptions: ["SYNTHETIC TRANSIT TPE", "Synthetic Books", "Synthetic Coffee"],
};
const twoBilledOneUnbilled: Ledger = {
  current: 3,
  billingStatuses: ["billed", "billed", "unbilled"],
  descriptions: ["Synthetic Books", "Synthetic Coffee", "Synthetic Transit"],
};

type SupersessionEvidence = Readonly<{
  relations: readonly Readonly<{ kind: string; from: string; to: string }>[];
  withdrawn: readonly string[];
}>;

/** The proof the ledger keeps for an unbilled purchase replaced by its billed posting. */
async function supersessionEvidence(store: PGliteStore): Promise<SupersessionEvidence> {
  const relations = await store.query<{ kind: string; from: string; to: string }>(`
    SELECT relation.relation_kind AS kind,
      from_revision.description AS "from",
      to_revision.description AS "to"
    FROM canonical_credit_card_relations relation
    JOIN transaction_revisions from_revision ON from_revision.transaction_id = relation.from_transaction_id
    JOIN transaction_revisions to_revision ON to_revision.transaction_id = relation.to_transaction_id
    ORDER BY from_revision.description`);
  const withdrawn = await store.query<{ description: string }>(`
    SELECT revision.description
    FROM assertion_transitions transition
    JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
    JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id
    WHERE transition.event_kind = 'withdrawn'
    ORDER BY revision.description`);
  return {
    relations: relations.rows,
    withdrawn: withdrawn.rows.map((row) => row.description),
  };
}

const transitSuperseded: SupersessionEvidence = {
  relations: [{ kind: "unbilled_to_billed", from: "Synthetic Transit", to: "SYNTHETIC TRANSIT TPE" }],
  withdrawn: ["Synthetic Transit"],
};

/** The capture must be rejected as an occurrence conflict and leave every ledger table as it was. */
async function assertRejectedWithoutChange(
  store: PGliteStore,
  request: PGliteCanonicalCreditCardCaptureRequest,
): Promise<void> {
  const before = await ledger(store);
  const evidenceBefore = await supersessionEvidence(store);
  const captures = async () =>
    Number((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count);
  const capturesBefore = await captures();
  await assert.rejects(
    commitPGliteCanonicalCreditCardCapture(store, request),
    (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
      error.reason === "occurrence-conflict",
  );
  assert.deepEqual(await ledger(store), before);
  assert.deepEqual(await supersessionEvidence(store), evidenceBefore);
  assert.equal(await captures(), capturesBefore);
}

async function freshStore(): Promise<{ database: PGlite; store: PGliteStore }> {
  const database = await createBaselinePGlite();
  return { database, store: new PGliteStore(database) };
}

test("issue 186 scenario A: same window, a posted purchase with changed content becomes one billed transaction", async () => {
  const { store } = await freshStore();
  try {
    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-a-unbilled",
      augustWindow,
      [julyCoffee, julyBooks],
      [augustTransitUnbilled],
      [settledJuly],
    ));
    assert.deepEqual(await ledger(store), twoBilledOneUnbilled);
    assert.deepEqual(await supersessionEvidence(store), { relations: [], withdrawn: [] });

    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-a-billed",
      augustWindow,
      [julyCoffee, julyBooks, augustTransitBilled],
      [],
      [settledJuly, settledAugust],
    ));
    assert.deepEqual(await ledger(store), threeBilledPurchases);
    assert.deepEqual(await supersessionEvidence(store), transitSuperseded);

    // A later identical capture must not treat the withdrawn purchase as a
    // lost member again, and must not withdraw or relate anything twice.
    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-a-billed-replay",
      augustWindow,
      [julyCoffee, julyBooks, augustTransitBilled],
      [],
      [settledJuly, settledAugust],
    ));
    assert.deepEqual(await ledger(store), threeBilledPurchases);
    assert.deepEqual(await supersessionEvidence(store), transitSuperseded);
  } finally {
    await store.close();
  }
});

test("issue 186 scenario B: window rolled forward, a posted purchase with changed content is not stored twice", async () => {
  const { store } = await freshStore();
  try {
    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-b-unbilled",
      augustWindow,
      [julyCoffee, julyBooks],
      [augustTransitUnbilled],
      [settledJuly],
    ));

    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-b-billed",
      septemberWindow,
      [julyCoffee, julyBooks, augustTransitBilled],
      [],
      [settledJuly, settledAugust],
    ));
    assert.deepEqual(await ledger(store), threeBilledPurchases);
    assert.deepEqual(await supersessionEvidence(store), transitSuperseded);

    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-b-billed-rolled-again",
      octoberWindow,
      [julyCoffee, julyBooks, augustTransitBilled],
      [],
      [settledJuly, settledAugust],
    ));
    assert.deepEqual(await ledger(store), threeBilledPurchases);
    assert.deepEqual(await supersessionEvidence(store), transitSuperseded);
  } finally {
    await store.close();
  }
});

test("issue 186 negative: two changed unbilled rows on one card and date are ambiguous and store nothing", async () => {
  const { store } = await freshStore();
  const augustTaxiUnbilled = purchaseRow("2026/08/15", "Synthetic Taxi", "80", { status: "unbilled" });
  const augustTaxiBilled = purchaseRow("2026/08/15", "SYNTHETIC TAXI TPE", "81", { status: "billed", period: "2026-08" });
  try {
    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-ambiguous-unbilled",
      augustWindow,
      [julyCoffee],
      [augustTransitUnbilled, augustTaxiUnbilled],
      [settledJuly],
    ));
    assert.deepEqual(await ledger(store), {
      current: 3,
      billingStatuses: ["billed", "unbilled", "unbilled"],
      descriptions: ["Synthetic Coffee", "Synthetic Taxi", "Synthetic Transit"],
    });
    await assertRejectedWithoutChange(store, command(
      "esun-186-ambiguous-billed",
      septemberWindow,
      [julyCoffee, augustTransitBilled, augustTaxiBilled],
      [],
      [settledJuly, settledAugust],
    ));
  } finally {
    await store.close();
  }
});

test("issue 186 negative: a changed row posted on a different card does not replace the unbilled purchase", async () => {
  const { store } = await freshStore();
  const otherCardTransitBilled = purchaseRow("2026/08/15", "SYNTHETIC TRANSIT TPE", "46", { status: "billed", period: "2026-08" }, otherCard);
  try {
    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-other-card-unbilled",
      augustWindow,
      [julyCoffee, julyBooks],
      [augustTransitUnbilled],
      [settledJuly],
    ));
    assert.deepEqual(await ledger(store), twoBilledOneUnbilled);
    await assertRejectedWithoutChange(store, command(
      "esun-186-other-card-billed",
      septemberWindow,
      [julyCoffee, julyBooks, otherCardTransitBilled],
      [],
      [settledJuly, settledAugust],
    ));
  } finally {
    await store.close();
  }
});

test("issue 186 negative: a changed billed row outside every statement does not replace the unbilled purchase", async () => {
  const { store } = await freshStore();
  try {
    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-no-statement-unbilled",
      augustWindow,
      [julyCoffee, julyBooks],
      [augustTransitUnbilled],
      [settledJuly],
    ));
    assert.deepEqual(await ledger(store), twoBilledOneUnbilled);
    // The August period is not settled, so the posted row belongs to no statement.
    await assertRejectedWithoutChange(store, command(
      "esun-186-no-statement-billed",
      septemberWindow,
      [julyCoffee, julyBooks, augustTransitBilled],
      [],
      [settledJuly],
    ));
  } finally {
    await store.close();
  }
});

test("issue 186 negative: a posted row with the opposite direction does not replace the unbilled purchase", async () => {
  const { store } = await freshStore();
  const augustTransitRefundBilled = purchaseRow("2026/08/15", "SYNTHETIC TRANSIT TPE", "-46", { status: "billed", period: "2026-08" });
  try {
    await commitPGliteCanonicalCreditCardCapture(store, command(
      "esun-186-sign-flip-unbilled",
      augustWindow,
      [julyCoffee, julyBooks],
      [augustTransitUnbilled],
      [settledJuly],
    ));
    assert.deepEqual(await ledger(store), twoBilledOneUnbilled);
    await assertRejectedWithoutChange(store, command(
      "esun-186-sign-flip-billed",
      septemberWindow,
      [julyCoffee, julyBooks, augustTransitRefundBilled],
      [],
      [settledJuly, { ...settledAugust, balance: "0", minimumPayment: "0" }],
    ));
  } finally {
    await store.close();
  }
});
