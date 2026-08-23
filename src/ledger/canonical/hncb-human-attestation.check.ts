import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  ensureHncbHumanAttestationEvents,
  getHncbHumanAttestedV1Manifest,
  isHncbHumanAttestationDurablyActive,
  latestHncbHumanAttestationEvent,
  recordInitialHncbHumanAttestationIfMissing,
  restoreHncbHumanAttestedV1,
  revokeHncbHumanAttestedV1,
} from "./hncb-human-attestation.ts";
import {
  createCanonicalSourceStore,
  canonicalSqlitePath,
} from "./canonical-source-store.ts";

assert.equal(HNCB_HUMAN_ATTESTED_V1_MANIFEST.providerGuaranteed, false);
assert.match(
  HNCB_HUMAN_ATTESTED_V1_MANIFEST.provenance.attestationContractFingerprint,
  /^sha256:/,
);
assert.equal(
  getHncbHumanAttestedV1Manifest().authorityRoute,
  "hncb/domestic-deposit/human-attested-v1",
);

const directory = await mkdtemp(join(tmpdir(), "hncb-attestation-v1-"));
try {
  const store = createCanonicalSourceStore(canonicalSqlitePath(directory));
  try {
    ensureHncbHumanAttestationEvents(store.db);
    assert.equal(isHncbHumanAttestationDurablyActive(store.db), false);
    recordInitialHncbHumanAttestationIfMissing(
      store.db,
      "2026-08-23T01:00:00.000+08:00",
    );
    store.close();
    const reopenedAfterAttestation = createCanonicalSourceStore(
      canonicalSqlitePath(directory),
    );
    assert.equal(
      isHncbHumanAttestationDurablyActive(reopenedAfterAttestation.db),
      true,
    );
    assert.equal(
      latestHncbHumanAttestationEvent(reopenedAfterAttestation.db)?.eventKind,
      "attested",
    );
    revokeHncbHumanAttestedV1(
      "2026-08-23T02:00:00.000+08:00",
      "test revocation",
      reopenedAfterAttestation.db,
    );
    reopenedAfterAttestation.close();
    const reopenedAfterRevocation = createCanonicalSourceStore(
      canonicalSqlitePath(directory),
    );
    assert.equal(
      isHncbHumanAttestationDurablyActive(reopenedAfterRevocation.db),
      false,
    );
    restoreHncbHumanAttestedV1(
      "2026-08-23T03:00:00.000+08:00",
      "test restoration",
      reopenedAfterRevocation.db,
    );
    reopenedAfterRevocation.close();
    const reopenedAfterRestore = createCanonicalSourceStore(
      canonicalSqlitePath(directory),
    );
    assert.equal(
      isHncbHumanAttestationDurablyActive(reopenedAfterRestore.db),
      true,
    );
    reopenedAfterRestore.db
      .prepare(
        "UPDATE hncb_attestation_events SET manifest_fingerprint = 'sha256:tampered' WHERE event_sequence = 1",
      )
      .run();
    assert.equal(
      isHncbHumanAttestationDurablyActive(reopenedAfterRestore.db),
      false,
    );
    reopenedAfterRestore.close();
  } finally {
    store.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
