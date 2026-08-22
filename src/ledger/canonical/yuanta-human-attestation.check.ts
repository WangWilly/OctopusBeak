import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION,
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
  ensureYuantaHumanAttestationEvents,
  getYuantaHumanAttestedV1Manifest,
  getYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestationDurablyActive,
  isYuantaHumanAttestationV2DurablyActive,
  isYuantaHumanAttestedV1Active,
  isYuantaHumanAttestedV1Manifest,
  isYuantaHumanAttestedV2Manifest,
  latestYuantaHumanAttestationEvent,
  recordInitialYuantaHumanAttestationIfMissing,
  restoreYuantaHumanAttestedV1,
  restoreYuantaHumanAttestedV2,
  revokeYuantaHumanAttestedV1,
  revokeYuantaHumanAttestedV2,
  yuantaHumanAttestedIdentityEpochKey,
  yuantaHumanAttestedV2IdentityEpochKey,
  recordInitialYuantaHumanAttestationV2IfMissing,
  latestYuantaHumanAttestationEventV2,
} from "./yuanta-human-attestation.ts";

assert.equal(
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
);
assert.equal(
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
);
assert.equal(YUANTA_HUMAN_ATTESTED_V1_MANIFEST.providerGuaranteed, false);
assert.equal(
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST.attestedBy,
  "user-confirmed-yuanta-observed-human-attested-2026-08-21",
);
assert.match(
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST.provenance.attestationContractFingerprint,
  /^sha256:/,
);
assert.equal(
  "sourceCaptureFingerprint" in YUANTA_HUMAN_ATTESTED_V1_MANIFEST.provenance,
  false,
);
assert.equal(
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST.authority,
  "personal-authenticated-session",
);
assert.equal(Object.isFrozen(YUANTA_HUMAN_ATTESTED_V1_MANIFEST), true);
assert.equal(
  Object.isFrozen(YUANTA_HUMAN_ATTESTED_V1_MANIFEST.semantics),
  true,
);
assert.equal(
  isYuantaHumanAttestedV1Manifest(
    structuredClone(YUANTA_HUMAN_ATTESTED_V1_MANIFEST),
  ),
  false,
);

const epoch = yuantaHumanAttestedIdentityEpochKey();
assert.match(epoch, /^sha256:[A-Za-z0-9_-]+$/);
assert.equal(
  epoch,
  yuantaHumanAttestedIdentityEpochKey({
    ...YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
    attestedAt: "2099-12-31",
  } as never),
);

const db = new DatabaseSync(":memory:");
try {
  ensureYuantaHumanAttestationEvents(db);
  recordInitialYuantaHumanAttestationIfMissing(db, "2026-08-21T12:00:00.000Z");
  recordInitialYuantaHumanAttestationIfMissing(db, "2026-08-21T12:00:01.000Z");
  assert.equal(isYuantaHumanAttestationDurablyActive(db), true);
  assert.equal(latestYuantaHumanAttestationEvent(db)?.sequence, 1);
  assert.equal(
    latestYuantaHumanAttestationEvent(db)?.reason,
    "user-confirmed-yuanta-observed-human-attested-2026-08-21",
  );

  revokeYuantaHumanAttestedV1("2026-08-22T12:00:00.000Z", "test revoke", db);
  assert.equal(isYuantaHumanAttestedV1Active(), false);
  assert.equal(isYuantaHumanAttestationDurablyActive(db), false);
  assert.equal(latestYuantaHumanAttestationEvent(db)?.sequence, 2);

  assert.throws(
    () =>
      recordInitialYuantaHumanAttestationIfMissing(
        db,
        "2026-08-23T00:00:00.000Z",
      ),
    /revoked/i,
  );
  restoreYuantaHumanAttestedV1(
    "2026-08-24T12:00:00.000Z",
    "restored for test",
    db,
  );
  assert.equal(isYuantaHumanAttestedV1Active(), true);
  assert.equal(isYuantaHumanAttestationDurablyActive(db), true);
  assert.equal(latestYuantaHumanAttestationEvent(db)?.sequence, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM yuanta_attestation_events").get()
      ?.count,
    3,
  );

  // A durable revocation may be observed by a fresh process whose in-memory
  // manifest still starts active. It must fail closed, then allow an explicit
  // durable restoration to append the next attested event.
  const reopenedRevocation = new DatabaseSync(":memory:");
  try {
    recordInitialYuantaHumanAttestationIfMissing(
      reopenedRevocation,
      "2026-08-21T13:00:00.000Z",
    );
    revokeYuantaHumanAttestedV1(
      "2026-08-22T13:00:00.000Z",
      "reopen revoke",
      reopenedRevocation,
    );
    restoreYuantaHumanAttestedV1("2026-08-23T13:00:00.000Z", "in-memory reset");
    assert.equal(
      isYuantaHumanAttestationDurablyActive(reopenedRevocation),
      false,
    );
    assert.equal(
      latestYuantaHumanAttestationEvent(reopenedRevocation)?.eventKind,
      "revoked",
    );
    restoreYuantaHumanAttestedV1(
      "2026-08-24T13:00:00.000Z",
      "durable restoration",
      reopenedRevocation,
    );
    assert.equal(
      isYuantaHumanAttestationDurablyActive(reopenedRevocation),
      true,
    );
  } finally {
    reopenedRevocation.close();
  }
} finally {
  db.close();
}

assert.equal(
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE,
);
assert.equal(
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION,
);
assert.equal(YUANTA_HUMAN_ATTESTED_V2_MANIFEST.providerGuaranteed, false);
assert.notEqual(
  yuantaHumanAttestedV2IdentityEpochKey(YUANTA_HUMAN_ATTESTED_V2_MANIFEST),
  yuantaHumanAttestedIdentityEpochKey(YUANTA_HUMAN_ATTESTED_V1_MANIFEST),
);
assert.equal(
  isYuantaHumanAttestedV2Manifest(
    structuredClone(YUANTA_HUMAN_ATTESTED_V2_MANIFEST),
  ),
  false,
);

const v2Db = new DatabaseSync(":memory:");
try {
  recordInitialYuantaHumanAttestationV2IfMissing(
    v2Db,
    "2026-08-21T12:00:00.000Z",
  );
  assert.equal(isYuantaHumanAttestationV2DurablyActive(v2Db), true);
  assert.equal(latestYuantaHumanAttestationEventV2(v2Db)?.sequence, 1);
  revokeYuantaHumanAttestedV2(
    "2026-08-22T12:00:00.000Z",
    "zero-sentinel contract test revoke",
    v2Db,
  );
  assert.equal(isYuantaHumanAttestationV2DurablyActive(v2Db), false);
  restoreYuantaHumanAttestedV2(
    "2026-08-23T12:00:00.000Z",
    "zero-sentinel contract test restore",
    v2Db,
  );
  assert.equal(isYuantaHumanAttestationV2DurablyActive(v2Db), true);
  assert.equal(latestYuantaHumanAttestationEventV2(v2Db)?.sequence, 3);
} finally {
  v2Db.close();
}
