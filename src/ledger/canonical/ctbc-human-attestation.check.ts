import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CTBC_HUMAN_ATTESTED_V1_CONFIRMED,
  CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  isCtbcHumanAttestationDurablyActive,
  latestCtbcHumanAttestationEvent,
  recordInitialCtbcHumanAttestationIfMissing,
  restoreCtbcHumanAttestedV1,
  revokeCtbcHumanAttestedV1,
} from "./ctbc-human-attestation.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";

assert.equal(CTBC_HUMAN_ATTESTED_V1_CONFIRMED, true);
assert.equal(
  CTBC_HUMAN_ATTESTED_V1_MANIFEST.attestedBy,
  "user-confirmed-ctbc-observed-human-attested-2026-08-24",
);
assert.equal(
  CTBC_HUMAN_ATTESTED_V1_MANIFEST.provenance.kind,
  "user-confirmation",
);
assert.equal(CTBC_HUMAN_ATTESTED_V1_MANIFEST.providerGuaranteed, false);
assert.equal(
  CTBC_HUMAN_ATTESTED_V1_MANIFEST.authority,
  "personal-authenticated-session",
);
assert.match(
  CTBC_HUMAN_ATTESTED_V1_MANIFEST.provenance.attestationContractFingerprint,
  /^sha256:/,
);

const directory = await mkdtemp(join(tmpdir(), "ctbc-attestation-check-"));
try {
  const path = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(path);
  assert.equal(isCtbcHumanAttestationDurablyActive(store.db), false);
  recordInitialCtbcHumanAttestationIfMissing(
    store.db,
    "2026-08-24T10:00:00+08:00",
  );
  assert.equal(
    latestCtbcHumanAttestationEvent(store.db)?.eventKind,
    "attested",
  );
  store.close();
  const reopened = createCanonicalSourceStore(path);
  assert.equal(isCtbcHumanAttestationDurablyActive(reopened.db), true);
  revokeCtbcHumanAttestedV1(
    "2026-08-24T11:00:00+08:00",
    "test revoke",
    reopened.db,
  );
  assert.equal(isCtbcHumanAttestationDurablyActive(reopened.db), false);
  restoreCtbcHumanAttestedV1(
    "2026-08-24T12:00:00+08:00",
    "test restore",
    reopened.db,
  );
  assert.equal(isCtbcHumanAttestationDurablyActive(reopened.db), true);
  reopened.db
    .prepare(
      "UPDATE ctbc_attestation_events SET manifest_fingerprint = 'sha256:tampered' WHERE event_sequence = 1",
    )
    .run();
  assert.equal(isCtbcHumanAttestationDurablyActive(reopened.db), false);
  reopened.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}
