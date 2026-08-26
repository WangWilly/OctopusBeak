import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_LEGACY_V1_MANIFEST,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  ensureFubonCreditCardHumanAttestationEvents,
  fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint,
  fubonCreditCardHumanAttestedManifestFingerprint,
  getFubonCreditCardHumanAttestedV1Manifest,
  getFubonCreditCardHumanAttestedV2Manifest,
  isFubonCreditCardHumanAttestationDurablyActive,
  isFubonCreditCardHumanAttestedV1Active,
  isFubonCreditCardHumanAttestedV1Manifest,
  isFubonCreditCardHumanAttestedV2Active,
  isFubonCreditCardHumanAttestedV2Manifest,
  latestFubonCreditCardHumanAttestationLegacyV1Event,
  latestFubonCreditCardHumanAttestationEvent,
  recordInitialFubonCreditCardHumanAttestationIfMissing,
  restoreFubonCreditCardHumanAttestedV1,
  revokeFubonCreditCardHumanAttestedV1,
  isFubonCreditCardHumanAttestedAccountKey,
} from "./fubon-credit-card-human-attestation.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";

test("Fubon credit-card v1 compatibility and v2 manifests are immutable and non-provider-guaranteed", () => {
  const manifest = getFubonCreditCardHumanAttestedV1Manifest();
  assert.equal(manifest, FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST);
  assert.deepEqual(manifest, {
    attestationId: "fubon-credit-card-human-attested-v1",
    evidenceVersion: "fubon/credit-card/human-attested-v1",
    authorityRoute: "fubon/credit-card/human-attested-v1",
    status: "active",
    attestedAt: "2026-08-25T00:00:00.000Z",
    attestedBy: "human-confirmed-independent-primary-card-billing-accounts",
    provenance: {
      kind: "human-attestation",
      sourceCaptureFingerprint:
        "sha256:fubon-credit-card-live-repeat-evidence-v1",
      source: "Fubon redacted repeated billed-and-unbilled grid evidence",
    },
    authority: "human-attested-independent-primary-card-billing-account",
    accountType: "credit",
    accountSubtype: "credit_card",
    stream: "credit-card",
    currency: "TWD",
    providerGuaranteed: false,
    occurrenceProviderGuaranteed: false,
    semantics: {
      accountIdentity:
        "fubon-source-connection-identity-epoch-credit-human-attested-account-key",
      cards: "card-instruments-under-attested-account",
      posting: "posting-date-present-means-posted",
      billing: "billed-or-unbilled-independent-of-posting",
      transactionIdentity:
        "immutable-normalized-content-tuple-plus-contiguous-observed-occurrence-index",
      occurrenceOrdering:
        "complete-capture-observed-source-order-human-attested-not-provider-guaranteed",
      statements: "issuer-settled-cycle-summary-only",
      relations: "explicit-source-linkage-only",
      completeness:
        "six-billed-periods-plus-unbilled-unfiltered-terminal-grid-counts",
      withdrawal: "never-infer-from-missing-card-or-row",
    },
    revokedAt: null,
    revocationReason: null,
  });
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
  assert.equal(
    manifest.semantics.cards,
    "card-instruments-under-attested-account",
  );
  assert.equal(
    manifest.semantics.statements,
    "issuer-settled-cycle-summary-only",
  );
  assert.equal(manifest.providerGuaranteed, false);
  assert.equal(manifest.occurrenceProviderGuaranteed, false);
  assert.equal(
    manifest.semantics.transactionIdentity,
    "immutable-normalized-content-tuple-plus-contiguous-observed-occurrence-index",
  );
  assert.match(
    manifest.semantics.occurrenceOrdering,
    /complete-capture-observed-source-order-human-attested-not-provider-guaranteed/,
  );
  assert.match(manifest.provenance.sourceCaptureFingerprint, /^sha256:/);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(isFubonCreditCardHumanAttestedV1Manifest(manifest), true);
  assert.equal(isFubonCreditCardHumanAttestedV1Active(), true);

  const currentV2 = getFubonCreditCardHumanAttestedV2Manifest();
  assert.equal(currentV2, FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST);
  assert.equal(currentV2.attestationId, "fubon-credit-card-human-attested-v2");
  assert.equal(currentV2.evidenceVersion, "fubon/credit-card/human-attested-v2");
  assert.equal(currentV2.authorityRoute, "fubon/credit-card/human-attested-v2");
  assert.notEqual(
    currentV2.provenance.sourceCaptureFingerprint,
    manifest.provenance.sourceCaptureFingerprint,
    "v2 attestation evidence must not reuse the historical v1 fingerprint",
  );
  assert.match(
    currentV2.provenance.sourceCaptureFingerprint,
    /-v2$/u,
  );
  assert.equal(isFubonCreditCardHumanAttestedV2Manifest(currentV2), true);
  assert.equal(isFubonCreditCardHumanAttestedV2Active(), true);
  assert.equal(
    fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint(),
    "sha256:XqhyMo4ijyxMcjTnM8vgcBHDG-Pzn_omnM7DVWp5lLc",
  );
  assert.equal(
    fubonCreditCardHumanAttestedManifestFingerprint(
      FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
      { includeExpandedSemantics: false },
    ),
    fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint(),
  );
  assert.equal(
    fubonCreditCardHumanAttestedManifestFingerprint(currentV2),
    "sha256:ieTzCkwR2SP6gNT4ZNlF8gahKrpc8kYFKtwSTP-_PLY",
  );
  assert.notEqual(
    fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint(),
    fubonCreditCardHumanAttestedManifestFingerprint(currentV2),
  );
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

test("v2 attestation migration preserves the historical v1 row and is repeatable", () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    ensureFubonCreditCardHumanAttestationEvents(store.db);
    const legacy = FUBON_CREDIT_CARD_HUMAN_ATTESTED_LEGACY_V1_MANIFEST;
    const legacyFingerprint =
      fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint();
    store.db
      .prepare(
        `INSERT INTO fubon_credit_card_attestation_events(
          event_id, attestation_id, evidence_version, event_kind,
          manifest_status, event_at, reason, manifest_fingerprint,
          event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomBytes(16),
        legacy.attestationId,
        legacy.evidenceVersion,
        "attested",
        "active",
        legacy.attestedAt,
        "historical v1 fixture",
        legacyFingerprint,
        1,
      );
    const before = store.db
      .prepare(
        `SELECT event_id, attestation_id, evidence_version, event_kind,
                manifest_status, event_at, reason, manifest_fingerprint,
                event_sequence
         FROM fubon_credit_card_attestation_events
         WHERE attestation_id = ?`,
      )
      .get(legacy.attestationId);

    const historicalEvent = latestFubonCreditCardHumanAttestationLegacyV1Event(
      store.db,
    );
    assert.equal(historicalEvent?.attestationId, legacy.attestationId);
    assert.equal(historicalEvent?.evidenceVersion, legacy.evidenceVersion);
    assert.equal(historicalEvent?.manifestFingerprint, legacyFingerprint);
    store.db
      .prepare(
        `UPDATE fubon_credit_card_attestation_events
         SET manifest_fingerprint = ?
         WHERE attestation_id = ?`,
      )
      .run("sha256:mutated-v1-fingerprint", legacy.attestationId);
    assert.throws(
      () => latestFubonCreditCardHumanAttestationLegacyV1Event(store.db),
      /Fubon credit-card attestation event chain is invalid/u,
    );
    store.db
      .prepare(
        `UPDATE fubon_credit_card_attestation_events
         SET manifest_fingerprint = ?
         WHERE attestation_id = ?`,
      )
      .run(legacyFingerprint, legacy.attestationId);

    recordInitialFubonCreditCardHumanAttestationIfMissing(store.db);
    const after = store.db
      .prepare(
        `SELECT event_id, attestation_id, evidence_version, event_kind,
                manifest_status, event_at, reason, manifest_fingerprint,
                event_sequence
         FROM fubon_credit_card_attestation_events
         WHERE attestation_id = ?`,
      )
      .get(legacy.attestationId);
    assert.deepEqual(after, before, "historical v1 event must remain untouched");

    const v2 = latestFubonCreditCardHumanAttestationEvent(store.db);
    assert.deepEqual(
      v2 && {
        attestationId: v2.attestationId,
        evidenceVersion: v2.evidenceVersion,
        eventKind: v2.eventKind,
        sequence: v2.sequence,
        manifestFingerprint: v2.manifestFingerprint,
      },
      {
        attestationId: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
        evidenceVersion: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion,
        eventKind: "attested",
        sequence: 1,
        manifestFingerprint: fubonCreditCardHumanAttestedManifestFingerprint(
          FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
        ),
      },
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM fubon_credit_card_attestation_events")
        .get()?.count,
      2,
    );

    recordInitialFubonCreditCardHumanAttestationIfMissing(store.db);
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM fubon_credit_card_attestation_events")
        .get()?.count,
      2,
      "repeated v2 initialization must not append a second attested event",
    );
    assert.equal(isFubonCreditCardHumanAttestationDurablyActive(store.db), true);
  } finally {
    store.close();
  }
});

test("a historical v1 fingerprint is never accepted for a current v2 event", () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    recordInitialFubonCreditCardHumanAttestationIfMissing(store.db);
    store.db
      .prepare(
        `UPDATE fubon_credit_card_attestation_events
         SET manifest_fingerprint = ?
         WHERE attestation_id = ?`,
      )
      .run(
        fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint(),
        FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
      );
    assert.throws(
      () => latestFubonCreditCardHumanAttestationEvent(store.db),
      /Fubon credit-card attestation event chain is invalid/u,
    );
  } finally {
    store.close();
  }
});

console.log("fubon-credit-card-human-attestation.check passed");
