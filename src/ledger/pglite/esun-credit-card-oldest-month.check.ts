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
  type PGliteCanonicalCreditCardCaptureRequest,
} from "./credit-card.ts";
import { PGliteCanonicalSourceAdmissionError } from "./source-admission-validation.ts";
import { PGliteStore } from "./transaction.ts";

// E.SUN's past-year timeline returns its oldest month only from about one
// year before the query date, so a purchase in that month leaves the
// timeline on its anniversary while the month is still listed. From
// 2026-10-24 every E.SUN credit-card capture was rejected this way: the
// 2025-10-24 purchase aged out of a still-queried month and the continuity
// guard read its absence as a lost member.

const managedSecret = "synthetic-esun-managed-secret";
const identity = deriveEsunCanonicalHumanAttestation(
  { esun_user_id: "user-id-oldest", esun_account: "account-oldest", esun_password: "secret" },
  managedSecret,
);
assert(identity);

const billedRow = (consumeDate: string, description: string, twdAmount: string, period: string): StatementRow => ({
  issuerStatementPeriod: period,
  cardNumber: "4111-****-****-1234",
  consumeDate,
  description,
  foreignCurrency: "",
  foreignAmount: "",
  paymentCurrency: "TWD",
  twdAmount,
  paymentStatus: "billed",
  sourcePaymentStatus: "已入帳",
});

const settled = (period: string, cycleStart: string, cycleEnd: string, dueDate: string, balance: string) => ({
  period,
  cycleStart,
  cycleEnd,
  issueDate: cycleEnd,
  dueDate,
  currency: "TWD",
  balance,
  minimumPayment: "10",
});

const anniversaryPurchase = billedRow("2025/10/24", "Synthetic Anniversary Store", "300", "2025-10");
const julyPurchase = billedRow("2026/07/15", "Synthetic Coffee", "120", "2026-07");
const settledPeriods = [
  settled("2025-10", "2025-10-01", "2025-10-31", "2025-11-20", "300"),
  settled("2026-07", "2026-07-01", "2026-07-31", "2026-08-20", "120"),
];

/** A thirteen-month timeline queried on `endDate` (`YYYY/MM/DD`), as the workflow records it. */
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
  const validated = buildEsunCanonicalCreditCardCapture({
    startDate: `${months[12]}/01`,
    endDate,
    identity: identity!,
    statementRows: rows,
    unbilledRows: [],
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
    settledPeriods,
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

async function currentDescriptions(store: PGliteStore): Promise<readonly string[]> {
  const rows = await store.query<{ description: string }>(`
    SELECT revision.description
    FROM current_transactions current
    JOIN transaction_revisions revision ON revision.revision_id = current.revision_id
    ORDER BY revision.description`);
  return rows.rows.map((row) => row.description);
}

const rejectsAsLostMember = (error: unknown) =>
  error instanceof PGliteCanonicalSourceAdmissionError && error.reason === "occurrence-conflict";

test("a purchase that ages out of the oldest timeline month on a later day is not a lost member", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("esun-oldest-1023", "2026/10/23", [anniversaryPurchase, julyPurchase]));
    await commitPGliteCanonicalCreditCardCapture(store, command("esun-oldest-1024", "2026/10/24", [julyPurchase]));
    await commitPGliteCanonicalCreditCardCapture(store, command("esun-oldest-1025", "2026/10/25", [julyPurchase]));
    // Aging out is not withdrawal: the admitted purchase stays in the ledger.
    assert.deepEqual(await currentDescriptions(store), ["Synthetic Anniversary Store", "Synthetic Coffee"]);
  });
});

test("the same query day must still return every oldest-month purchase", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("esun-oldest-morning", "2026/10/23", [anniversaryPurchase, julyPurchase]));
    await assert.rejects(
      commitPGliteCanonicalCreditCardCapture(store, command("esun-oldest-evening", "2026/10/23", [julyPurchase])),
      rejectsAsLostMember,
    );
  });
});

test("a purchase missing from a complete month on a later day is still a lost member", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalCreditCardCapture(store, command("esun-complete-1023", "2026/10/23", [anniversaryPurchase, julyPurchase]));
    await assert.rejects(
      commitPGliteCanonicalCreditCardCapture(store, command("esun-complete-1024", "2026/10/24", [])),
      rejectsAsLostMember,
    );
  });
});
