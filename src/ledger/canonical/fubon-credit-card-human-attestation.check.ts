import assert from "node:assert/strict";
import test from "node:test";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  ensureFubonCreditCardHumanAttestationEvents,
  getFubonCreditCardHumanAttestedV1Manifest,
  isFubonCreditCardHumanAttestationDurablyActive,
  isFubonCreditCardHumanAttestedV1Active,
  isFubonCreditCardHumanAttestedV1Manifest,
  latestFubonCreditCardHumanAttestationEvent,
  recordInitialFubonCreditCardHumanAttestationIfMissing,
  restoreFubonCreditCardHumanAttestedV1,
  revokeFubonCreditCardHumanAttestedV1,
  isFubonCreditCardHumanAttestedAccountKey,
} from "./fubon-credit-card-human-attestation.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";

test("Fubon credit-card v1 manifest is immutable, source-scoped, and non-provider-guaranteed", () => {
  const manifest = getFubonCreditCardHumanAttestedV1Manifest();
  assert.equal(manifest, FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST);
  assert.equal(manifest.attestationId, "fubon-credit-card-human-attested-v1");
  assert.equal(manifest.evidenceVersion, "fubon/credit-card/human-attested-v1");
  assert.equal(manifest.authorityRoute, "fubon/credit-card/human-attested-v1");
  assert.equal(manifest.stream, "credit-card");
  assert.equal(manifest.accountType, "credit");
  assert.equal(manifest.accountSubtype, "credit_card");
  assert.equal(
    manifest.authority,
    "human-attested-independent-primary-card-billing-account",
  );
  assert.equal(manifest.providerGuaranteed, false);
  assert.equal(manifest.occurrenceProviderGuaranteed, false);
  assert.match(manifest.provenance.sourceCaptureFingerprint, /^sha256:/);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(isFubonCreditCardHumanAttestedV1Manifest(manifest), true);
  assert.equal(isFubonCreditCardHumanAttestedV1Active(), true);
});

test("human-attested account keys are opaque and never card-derived", () => {
  assert.equal(isFubonCreditCardHumanAttestedAccountKey("portfolio-a"), true);
  assert.equal(
    isFubonCreditCardHumanAttestedAccountKey("attested:primary-cardholder:a"),
    true,
  );
  for (const value of [
    "",
    "1234",
    "****1234",
    "123456******1234",
    "正卡末四碼1234",
    "visa-gold",
    "fubon-primary-card",
    "card-mask-1234",
  ])
    assert.equal(
      isFubonCreditCardHumanAttestedAccountKey(value),
      false,
      value,
    );
});

test("attestation events append attested, revoked, and restored states", () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    ensureFubonCreditCardHumanAttestationEvents(store.db);
    recordInitialFubonCreditCardHumanAttestationIfMissing(store.db);
    assert.equal(isFubonCreditCardHumanAttestationDurablyActive(store.db), true);
    assert.equal(
      latestFubonCreditCardHumanAttestationEvent(store.db)?.eventKind,
      "attested",
    );

    const revoked = revokeFubonCreditCardHumanAttestedV1(
      "2026-08-25T01:00:00.000Z",
      "synthetic test revocation",
      store.db,
    );
    assert.equal(revoked.status, "revoked");
    assert.equal(isFubonCreditCardHumanAttestationDurablyActive(store.db), false);
    assert.equal(
      latestFubonCreditCardHumanAttestationEvent(store.db)?.eventKind,
      "revoked",
    );

    const restored = restoreFubonCreditCardHumanAttestedV1(
      "2026-08-25T02:00:00.000Z",
      "synthetic test restoration",
      store.db,
    );
    assert.equal(restored.status, "active");
    assert.equal(isFubonCreditCardHumanAttestationDurablyActive(store.db), true);
    assert.deepEqual(
      (
        store.db
          .prepare(
            `SELECT event_kind, manifest_status, event_sequence
             FROM fubon_credit_card_attestation_events
             ORDER BY event_sequence`,
          )
          .all() as Array<{
          event_kind: string;
          manifest_status: string;
          event_sequence: number;
        }>
      ).map((row) => [row.event_kind, row.manifest_status, row.event_sequence]),
      [
        ["attested", "active", 1],
        ["revoked", "revoked", 2],
        ["restored", "active", 3],
      ],
    );
  } finally {
    store.close();
  }
});

console.log("fubon-credit-card-human-attestation.check passed");
