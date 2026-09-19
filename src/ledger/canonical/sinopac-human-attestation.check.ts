import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  ensureSinopacHumanAttestationEvents,
  getSinopacHumanAttestedV1Manifest,
  isSinopacHumanAttestationDurablyActive,
  latestSinopacHumanAttestationEvent,
  recordInitialSinopacHumanAttestationIfMissing,
  restoreSinopacHumanAttestedV1,
  revokeSinopacHumanAttestedV1,
} from "./sinopac-human-attestation.ts";
import {
  createCanonicalSourceStore,
} from "./canonical-source-store.ts";
import { canonicalDatabaseWriterKey } from "./canonical-database.ts";

assert.equal(SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.providerGuaranteed, false);
assert.match(
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.provenance.attestationContractFingerprint,
  /^sha256:/,
);
assert.equal(
  getSinopacHumanAttestedV1Manifest().authorityRoute,
  "sinopac/domestic-deposit/human-attested-v1",
);

const directory = await mkdtemp(join(tmpdir(), "sinopac-attestation-v1-"));
try {
  const store = createCanonicalSourceStore(directory);
  try {
    ensureSinopacHumanAttestationEvents(store.db);
    assert.equal(isSinopacHumanAttestationDurablyActive(store.db), false);
    recordInitialSinopacHumanAttestationIfMissing(
      store.db,
      "2026-08-23T01:00:00.000+08:00",
    );
    store.close();
    const reopenedAfterAttestation = createCanonicalSourceStore(directory);
    assert.equal(
      isSinopacHumanAttestationDurablyActive(reopenedAfterAttestation.db),
      true,
    );
    assert.equal(
      latestSinopacHumanAttestationEvent(reopenedAfterAttestation.db)
        ?.eventKind,
      "attested",
    );
    revokeSinopacHumanAttestedV1(
      "2026-08-23T02:00:00.000+08:00",
      "test revocation",
      reopenedAfterAttestation.db,
    );
    reopenedAfterAttestation.close();
    const reopenedAfterRevocation = createCanonicalSourceStore(directory);
    assert.equal(
      isSinopacHumanAttestationDurablyActive(reopenedAfterRevocation.db),
      false,
    );
    restoreSinopacHumanAttestedV1(
      "2026-08-23T03:00:00.000+08:00",
      "test restoration",
      reopenedAfterRevocation.db,
    );
    reopenedAfterRevocation.close();
    const reopenedAfterRestore = createCanonicalSourceStore(directory);
    assert.equal(
      isSinopacHumanAttestationDurablyActive(reopenedAfterRestore.db),
      true,
    );
    reopenedAfterRestore.db
      .prepare(
        "UPDATE sinopac_attestation_events SET manifest_fingerprint = 'sha256:tampered' WHERE event_sequence = 1",
      )
      .run();
    assert.equal(
      isSinopacHumanAttestationDurablyActive(reopenedAfterRestore.db),
      false,
    );
    reopenedAfterRestore.close();
  } finally {
    store.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
