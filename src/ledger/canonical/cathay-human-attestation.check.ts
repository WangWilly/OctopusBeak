import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  commitCathayDomesticDepositSync,
  openCanonicalDatabase,
} from "./cathay-domestic-deposit.ts";
import {
  CATHAY_HUMAN_ATTESTED_V1_MANIFEST,
  ensureCathayHumanAttestationEvents,
  getCathayHumanAttestedV1Manifest,
  isCathayHumanAttestationDurablyActive,
  latestCathayHumanAttestationEvent,
  recordCathayHumanAttestationEvent,
  recordInitialCathayHumanAttestationIfMissing,
  restoreCathayHumanAttestedV1,
  revokeCathayHumanAttestedV1,
} from "./cathay-human-attestation.ts";
import { buildCathayDomesticDepositReadinessFromLedger } from "./advertised-domestic-deposit-readiness.ts";

const syncInput = (sourceConnectionId: string) => ({
  sourceConnectionId,
  identityEpoch: "cathay-domestic-deposit-observed-human-attested-v1",
  authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
  observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
  syncState: { cursor: null },
  pages: [
    {
      accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
      currency: "TWD" as const,
      scope: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope,
      pageOrdinal: 0,
      requestPageToken: null,
      nextPageToken: null,
      rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
      contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      preflightFingerprint: "cathay/domestic-deposit/v1",
      absenceAuthority: "comparable-complete-range" as const,
    },
  ],
});

assert.equal(
  getCathayHumanAttestedV1Manifest(),
  CATHAY_HUMAN_ATTESTED_V1_MANIFEST,
);
assert.equal(CATHAY_HUMAN_ATTESTED_V1_MANIFEST.providerGuaranteed, false);
assert.equal(CATHAY_HUMAN_ATTESTED_V1_MANIFEST.currency, "TWD");
assert.equal(
  CATHAY_HUMAN_ATTESTED_V1_MANIFEST.authority,
  "personal-owned-accounts",
);

const ledgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "cathay-human-attested-v1-"),
);
try {
  await commitCathayDomesticDepositSync(
    ledgerDir,
    syncInput("cathay-human-attested-source"),
  );

  let db = openCanonicalDatabase(ledgerDir);
  try {
    const before = buildCathayDomesticDepositReadinessFromLedger(db);
    assert.equal(before.capability, "canonical-synthetic");
    assert.deepEqual(before.blockers, ["live-validation-pending"]);
    assert.equal(isCathayHumanAttestationDurablyActive(db), false);

    ensureCathayHumanAttestationEvents(db);
    assert.throws(
      () =>
        recordCathayHumanAttestationEvent(db!, {
          attestationId: CATHAY_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
          evidenceVersion: CATHAY_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
          eventKind: "attested",
          manifestStatus: "active",
          eventAt: "2026-08-22T00:00:00.000Z",
          reason: "forged",
          manifestFingerprint: "sha256:forged",
          sequence: 1,
        }),
      /immutable|chain/i,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM cathay_attestation_events")
        .get()?.count,
      0,
    );

    recordInitialCathayHumanAttestationIfMissing(
      db,
      "2026-08-22T08:00:00+08:00",
    );
    recordInitialCathayHumanAttestationIfMissing(
      db,
      "2026-08-22T08:00:00+08:00",
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM cathay_attestation_events")
        .get()?.count,
      1,
    );
    const event = latestCathayHumanAttestationEvent(db);
    assert.equal(event?.eventKind, "attested");
    assert.equal(event?.manifestStatus, "active");
    assert.equal(event?.sequence, 1);
    assert.equal(
      event?.manifestFingerprint,
      CATHAY_HUMAN_ATTESTED_V1_MANIFEST.provenance.sourceCaptureFingerprint,
    );
    assert.equal(
      JSON.stringify(event).includes(
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
      ),
      false,
    );

    const ready = buildCathayDomesticDepositReadinessFromLedger(db);
    assert.equal(ready.capability, "canonical-human-attested");
    assert.equal(ready.liveValidation, "complete");
    assert.equal(ready.providerGuaranteed, false);
    assert.deepEqual(ready.semanticBlockers, []);
    assert.deepEqual(ready.blockers, []);
  } finally {
    db.close();
  }

  db = openCanonicalDatabase(ledgerDir);
  try {
    assert.equal(isCathayHumanAttestationDurablyActive(db), true);
    assert.equal(
      buildCathayDomesticDepositReadinessFromLedger(db).capability,
      "canonical-human-attested",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get()
        ?.count,
      3,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count,
      1,
    );

    revokeCathayHumanAttestedV1("2026-08-23T00:00:00.000Z", "test revoke", db);
    assert.equal(isCathayHumanAttestationDurablyActive(db), false);
    assert.equal(
      buildCathayDomesticDepositReadinessFromLedger(db).capability,
      "canonical-synthetic",
    );
    assert.deepEqual(
      buildCathayDomesticDepositReadinessFromLedger(db).blockers,
      ["live-validation-pending"],
    );

    restoreCathayHumanAttestedV1(
      "2026-08-24T00:00:00.000Z",
      "test restore",
      db,
    );
    assert.equal(isCathayHumanAttestationDurablyActive(db), true);
    assert.equal(latestCathayHumanAttestationEvent(db)?.sequence, 3);
  } finally {
    db.close();
  }
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}

const sourceOnlyDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "cathay-human-attested-source-only-"),
);
try {
  const db = openCanonicalDatabase(sourceOnlyDir);
  try {
    recordInitialCathayHumanAttestationIfMissing(
      db,
      "2026-08-22T08:00:00+08:00",
    );
    const readiness = buildCathayDomesticDepositReadinessFromLedger(db);
    assert.equal(readiness.capability, "canonical-synthetic");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get()
        ?.count,
      0,
    );
  } finally {
    db.close();
  }
} finally {
  await rm(sourceOnlyDir, { recursive: true, force: true });
}
