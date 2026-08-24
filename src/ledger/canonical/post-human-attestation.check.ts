import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  POST_HUMAN_ATTESTED_V1_MANIFEST,
  getPostHumanAttestedV1Manifest,
  isPostHumanAttestationDurablyActive,
  isPostHumanAttestedV1Manifest,
  latestPostHumanAttestationEvent,
  postHumanAttestedIdentityEpochKey,
  recordInitialPostHumanAttestationIfMissing,
  restorePostHumanAttestedV1,
  revokePostHumanAttestedV1,
} from "./post-human-attestation.ts";

assert.equal(POST_HUMAN_ATTESTED_V1_MANIFEST.providerGuaranteed, false);
assert.equal(
  POST_HUMAN_ATTESTED_V1_MANIFEST.semantics.zeroResult,
  "unproven-reject",
);
assert.match(postHumanAttestedIdentityEpochKey(), /^sha256:/);
assert.equal(
  isPostHumanAttestedV1Manifest(getPostHumanAttestedV1Manifest()),
  true,
);
assert.equal(
  isPostHumanAttestedV1Manifest({ ...getPostHumanAttestedV1Manifest() }),
  false,
);

const directory = await mkdtemp(join(tmpdir(), "post-attestation-check-"));
try {
  const path = join(directory, "canonical.sqlite");
  const db = new DatabaseSync(path);
  recordInitialPostHumanAttestationIfMissing(db, "2026-08-24T10:08:26+08:00");
  assert.equal(isPostHumanAttestationDurablyActive(db), true);
  assert.equal(latestPostHumanAttestationEvent(db)?.sequence, 1);
  revokePostHumanAttestedV1(
    "2026-08-24T10:09:00+08:00",
    "synthetic-revocation-check",
    db,
  );
  assert.equal(isPostHumanAttestationDurablyActive(db), false);
  db.close();

  const reopened = new DatabaseSync(path);
  assert.equal(latestPostHumanAttestationEvent(reopened)?.eventKind, "revoked");
  restorePostHumanAttestedV1(
    "2026-08-24T10:10:00+08:00",
    "synthetic-restoration-check",
    reopened,
  );
  assert.equal(isPostHumanAttestationDurablyActive(reopened), true);
  assert.equal(latestPostHumanAttestationEvent(reopened)?.sequence, 3);
  reopened.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}
