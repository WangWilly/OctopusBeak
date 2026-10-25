import assert from "node:assert/strict";
import test from "node:test";
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
import { createTestPGlite } from "./baseline-test-template.ts";
import { creditCardCommandRequestFromCanonicalCapture } from "./credit-card-adapters.ts";
import {
  commitPGliteCanonicalCreditCardCapture,
  PGliteCanonicalCreditCardAdmissionError,
  type PGliteCanonicalCreditCardCaptureRequest,
} from "./credit-card.ts";
import { PGliteCanonicalSourceAdmissionError } from "./source-admission-validation.ts";
import { PGliteStore } from "./transaction.ts";

// An unbilled authorization the issuer cancels (a released hotel deposit, a
// voided order) leaves the complete unbilled listing without a billed
// successor. Its absence withdraws its source support; it is never recorded
// as cancelled, and it is restored if the issuer lists it again.

const managedSecret = "synthetic-esun-managed-secret";
const identity = deriveEsunCanonicalHumanAttestation(
  { esun_user_id: "user-id-vanished", esun_account: "account-vanished", esun_password: "secret" },
  managedSecret,
);
assert(identity);

const card = "4111-****-****-1234";
const otherCard = "4111-****-****-5678";
const row = (
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

const julyCoffee = row("2026/07/15", "Synthetic Coffee", "120", { status: "billed", period: "2026-07" });
const julyBooks = row("2026/07/20", "Synthetic Books", "380", { status: "billed", period: "2026-07" });
const augustHotelHold = row("2026/08/15", "Synthetic Hotel Deposit", "3000", { status: "unbilled" });
const augustTransitUnbilled = row("2026/08/15", "Synthetic Transit", "45", { status: "unbilled" });
const augustTransitBilled = row("2026/08/15", "SYNTHETIC TRANSIT TPE", "46", { status: "billed", period: "2026-08" });
const augustOtherCardBilled = row("2026/08/15", "Synthetic Parking", "60", { status: "billed", period: "2026-08" }, otherCard);
const augustOtherCardTaxi = row("2026/08/10", "Synthetic Taxi", "200", { status: "unbilled" }, otherCard);

const settled = (period: string, cycleStart: string, cycleEnd: string, dueDate: string, balance: string) => ({
  period, cycleStart, cycleEnd, issueDate: cycleEnd, dueDate, currency: "TWD", balance, minimumPayment: "10",
});
const settledPeriods = [
  settled("2026-07", "2026-07-01", "2026-07-31", "2026-08-20", "500"),
  settled("2026-08", "2026-08-01", "2026-08-31", "2026-09-20", "106"),
];

/** A complete thirteen-month E.SUN timeline queried on `endDate` (`YYYY/MM/DD`). */
function command(captureId: string, endDate: string, rows: readonly StatementRow[]): PGliteCanonicalCreditCardCaptureRequest {
  const [year, month] = endDate.split("/").map(Number) as [number, number];
  const months = Array.from({ length: 13 }, (_, index) =>
    new Date(Date.UTC(year, month - 1 - index, 1)).toISOString().slice(0, 7).replace("-", "/"));
  const capture: CaptureMetadata = {
    snapshotMode: "full",
    captureId,
    capturedAt: `${endDate.replaceAll("/", "-")}T07:00:00.000Z`,
    captureKinds: ["billed", "unbilled"],
    completenessEvidence: { bank: "esun", range: "default_one_year" },
  };
  const statementRows = rows.filter((entry) => entry.paymentStatus === "billed");
  const unbilledRows = rows.filter((entry) => entry.paymentStatus === "unbilled");
  const validated = buildEsunCanonicalCreditCardCapture({
    startDate: `${months[12]}/01`,
    endDate,
    identity: identity!,
    statementRows,
    unbilledRows,
    grid: {
      kind: "past-year-timeline",
      firstMonth: months[0]!,
      lastMonth: months[12]!,
      months,
      pageCount: 3,
      monthCount: 13,
      capturedRowCount: rows.length,
      terminal: true,
      terminalCursor: 4,
    },
    capture,
    instrumentFingerprintSecret: managedSecret,
    settledPeriods: settledPeriods.filter((period) => statementRows.some((entry) => entry.issuerStatementPeriod === period.period)),
  });
  assert(validated, "E.SUN capture builder accepted the fixture");
  return creditCardCommandRequestFromCanonicalCapture(
    esunCanonicalSpineCapture(validated),
    esunNeutralCreditCardCapture(validated),
  );
}

async function withStore(run: (store: PGliteStore) => Promise<void>): Promise<void> {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

async function current(store: PGliteStore): Promise<readonly string[]> {
  const rows = await store.query<{ description: string }>(`
    SELECT revision.description
    FROM current_transactions current
    JOIN transaction_revisions revision ON revision.revision_id = current.revision_id
    ORDER BY revision.description`);
  return rows.rows.map((entry) => entry.description);
}

async function transitions(store: PGliteStore, kind: "withdrawn" | "restored"): Promise<readonly string[]> {
  const rows = await store.query<{ description: string }>(`
    SELECT revision.description
    FROM assertion_transitions transition
    JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
    JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id
    WHERE transition.event_kind = $1
    ORDER BY revision.description`, [kind]);
  return rows.rows.map((entry) => entry.description);
}

async function relationCount(store: PGliteStore): Promise<number> {
  const rows = await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM canonical_credit_card_relations");
  return Number(rows.rows[0]?.count);
}

async function assertRejectedWithoutChange(
  store: PGliteStore,
  request: PGliteCanonicalCreditCardCaptureRequest,
  rejected: (error: unknown) => boolean,
): Promise<void> {
  const before = { current: await current(store), withdrawn: await transitions(store, "withdrawn") };
  await assert.rejects(commitPGliteCanonicalCreditCardCapture(store, request), rejected);
  assert.deepEqual({ current: await current(store), withdrawn: await transitions(store, "withdrawn") }, before);
}

const lostMember = (error: unknown) =>
  error instanceof PGliteCanonicalSourceAdmissionError && error.reason === "occurrence-conflict";

test("a cancelled unbilled authorization is withdrawn, not recorded as cancelled, and withdrawn once", async () => {
  await withStore(async (store) => {
    const first = await commitPGliteCanonicalCreditCardCapture(store, command("vanished-1", "2026/08/20", [julyCoffee, julyBooks, augustHotelHold]));
    assert.equal(first.withdrawnTransactionCount, 0);
    const second = await commitPGliteCanonicalCreditCardCapture(store, command("vanished-2", "2026/08/21", [julyCoffee, julyBooks]));
    assert.equal(second.withdrawnTransactionCount, 1);
    assert.deepEqual(await current(store), ["Synthetic Books", "Synthetic Coffee"]);
    assert.deepEqual(await transitions(store, "withdrawn"), ["Synthetic Hotel Deposit"]);
    assert.equal(await relationCount(store), 0, "a vanished authorization has no successor relation");
    const third = await commitPGliteCanonicalCreditCardCapture(store, command("vanished-3", "2026/08/22", [julyCoffee, julyBooks]));
    assert.equal(third.withdrawnTransactionCount, 0, "a withdrawn member is no longer expected");
    assert.deepEqual(await transitions(store, "withdrawn"), ["Synthetic Hotel Deposit"]);
  });
});

test("a withdrawn authorization the issuer lists again is restored", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("restore-1", "2026/08/20", [julyCoffee, augustHotelHold]));
    await commitPGliteCanonicalCreditCardCapture(store, command("restore-2", "2026/08/21", [julyCoffee]));
    assert.deepEqual(await current(store), ["Synthetic Coffee"]);
    await commitPGliteCanonicalCreditCardCapture(store, command("restore-3", "2026/08/22", [julyCoffee, augustHotelHold]));
    assert.deepEqual(await current(store), ["Synthetic Coffee", "Synthetic Hotel Deposit"]);
    assert.deepEqual(await transitions(store, "restored"), ["Synthetic Hotel Deposit"]);
    // Restored support is expected again, so a later absence withdraws it again.
    const fourth = await commitPGliteCanonicalCreditCardCapture(store, command("restore-4", "2026/08/23", [julyCoffee]));
    assert.equal(fourth.withdrawnTransactionCount, 1);
    assert.deepEqual(await current(store), ["Synthetic Coffee"]);
  });
});

test("a billed member that vanishes is still a lost member", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("billed-1", "2026/08/20", [julyCoffee, julyBooks]));
    await assertRejectedWithoutChange(store, command("billed-2", "2026/08/21", [julyBooks]), lostMember);
  });
});

test("an authorization whose card is absent from the capture is not withdrawn", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("card-1", "2026/08/20", [julyCoffee, augustOtherCardTaxi]));
    await assertRejectedWithoutChange(store, command("card-2", "2026/08/21", [julyCoffee]), lostMember);
  });
});

test("a new billed row on the same date is a candidate, so the absence is not inferred", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("candidate-1", "2026/08/20", [julyCoffee, augustHotelHold, augustOtherCardTaxi]));
    await assertRejectedWithoutChange(
      store,
      command("candidate-2", "2026/09/02", [julyCoffee, augustOtherCardTaxi, augustOtherCardBilled]),
      lostMember,
    );
  });
});

test("a purchase replaced by its billed successor cannot be listed as unbilled again", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("successor-1", "2026/08/20", [julyCoffee, augustTransitUnbilled]));
    await commitPGliteCanonicalCreditCardCapture(store, command("successor-2", "2026/09/02", [julyCoffee, augustTransitBilled]));
    assert.equal(await relationCount(store), 1);
    await assertRejectedWithoutChange(
      store,
      command("successor-3", "2026/09/03", [julyCoffee, augustTransitBilled, augustTransitUnbilled]),
      (error) => error instanceof PGliteCanonicalCreditCardAdmissionError && error.code === "revision-conflict",
    );
  });
});
