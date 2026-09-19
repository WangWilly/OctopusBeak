import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
} from "./canonical-source-store.ts";
import {
  evaluateCanonicalReadiness,
  formatCanonicalReadinessDiagnostics,
} from "./advertised-source-readiness.ts";
import {
  createCanonicalReadinessLedgerFixture,
  recollectCanonicalReadinessLedger,
} from "./advertised-source-readiness-fixture.ts";
import {
  FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2,
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositFinancialCapture,
} from "./fubon-domestic-deposit.ts";
import {
  restoreCathayHumanAttestedV1,
  revokeCathayHumanAttestedV1,
} from "./cathay-human-attestation.ts";

// An empty canonical store fails closed. The static contract diagnostics are
// retained and explicitly marked as ledger evidence rather than being replaced
// by a readiness flag.
const emptyDirectory = await mkdtemp(join(tmpdir(), "canonical-readiness-empty-"));
try {
  const emptyStore = createCanonicalSourceStore(emptyDirectory);
  try {
    const emptyGate = evaluateCanonicalReadiness({
      mode: "ledger",
      db: emptyStore.db,
    });
    assert.equal(emptyGate.status, "blocked");
    assert.equal(emptyGate.releaseReady, false);
    assert.equal(emptyGate.effectiveInventory.length, 21);
    assert.ok(
      emptyGate.diagnostics.some(
        (diagnostic) =>
          diagnostic.sourceId === "fubon" &&
          diagnostic.blocker === "account-identity-unproven" &&
          diagnostic.evidenceMode === "from-ledger",
      ),
    );
    assert.match(
      formatCanonicalReadinessDiagnostics(emptyGate),
      /evidence: from-ledger/,
    );
  } finally {
    emptyStore.close();
  }
} finally {
  await rm(emptyDirectory, { recursive: true, force: true });
}

// Missing semantic and attestation evidence remains an admission diagnostic;
// this is intentionally exercised before the ledger-backed release fixture.
const structural = admitFubonDomesticDepositCaptureEvidence(
  FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2,
);
assert.equal(structural.status, "admissible");
assert.ok(structural.capture);
const missingFinancialEvidence = admitFubonDomesticDepositFinancialCapture({
  capture: structural.capture,
  captureId: "readiness-missing-evidence",
});
assert.equal(missingFinancialEvidence.status, "blocked");
assert.ok(missingFinancialEvidence.diagnostics.includes("financial-semantics-missing"));
assert.ok(missingFinancialEvidence.diagnostics.includes("human-attestation-missing"));

const fixture = await createCanonicalReadinessLedgerFixture();
let cathayRevoked = false;
try {
  const initialTransactions = Number(
    (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get() as { count?: number }
    ).count ?? 0,
  );
  assert.ok(initialTransactions > 0);
  const initialCaptures = Number(
    (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM source_captures")
        .get() as { count?: number }
    ).count ?? 0,
  );
  assert.ok(initialCaptures > 0);

  const initialGate = evaluateCanonicalReadiness({
    mode: "ledger",
    db: fixture.store.db,
  });
  assert.equal(initialGate.status, "release-ready");
  assert.equal(initialGate.releaseReady, true);
  assert.equal(initialGate.effectiveInventory.length, 21);
  assert.deepEqual(initialGate.diagnostics, []);

  // Every source has already crossed its typed admission and commit seam. The
  // canonical-only query sees durable records, while no legacy ledger is part
  // of this temporary release fixture.
  const current = queryCanonicalSourceCurrent(fixture.store);
  assert.ok(current.records.length > 0);
  assert.ok(
    Number(
      (
        fixture.store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'legacy_ledger'",
          )
          .get() as { count?: number }
      ).count ?? 0,
    ) === 0,
  );

  // A new capture id models a repeated recollection. Occurrence identity keeps
  // Financial Transactions stable while source provenance grows append-only.
  await recollectCanonicalReadinessLedger(fixture, "repeat");
  const repeatedTransactions = Number(
    (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get() as { count?: number }
    ).count ?? 0,
  );
  assert.equal(repeatedTransactions, initialTransactions);
  const repeatedCaptures = Number(
    (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM source_captures")
        .get() as { count?: number }
    ).count ?? 0,
  );
  assert.ok(repeatedCaptures > initialCaptures);
  const repeatedGate = evaluateCanonicalReadiness({
    mode: "ledger",
    db: fixture.store.db,
  });
  assert.equal(repeatedGate.status, "release-ready");
  assert.deepEqual(repeatedGate.diagnostics, []);

  // The attestation chain is part of readiness evidence. Revoking it makes
  // the exact source fail closed, and restoration returns the gate to ready.
  revokeCathayHumanAttestedV1(
    "2026-09-14T10:00:00.000Z",
    "readiness diagnostic fixture",
    fixture.store.db,
  );
  cathayRevoked = true;
  const revokedGate = evaluateCanonicalReadiness({
    mode: "ledger",
    db: fixture.store.db,
  });
  assert.equal(revokedGate.status, "blocked");
  assert.ok(
    revokedGate.diagnostics.some(
      (diagnostic) =>
        diagnostic.sourceId === "cathay" &&
        diagnostic.blocker === "live-validation-pending" &&
        diagnostic.evidenceMode === "from-ledger",
    ),
  );
  restoreCathayHumanAttestedV1(
    "2026-09-14T10:01:00.000Z",
    "readiness diagnostic fixture restored",
    fixture.store.db,
  );
  cathayRevoked = false;
  const restoredGate = evaluateCanonicalReadiness({
    mode: "ledger",
    db: fixture.store.db,
  });
  assert.equal(restoredGate.status, "release-ready");
  assert.deepEqual(restoredGate.diagnostics, []);
} finally {
  if (cathayRevoked) {
    restoreCathayHumanAttestedV1(
      "2026-09-14T10:01:00.000Z",
      "readiness diagnostic fixture cleanup",
      fixture.store.db,
    );
  }
  await fixture.close();
}
