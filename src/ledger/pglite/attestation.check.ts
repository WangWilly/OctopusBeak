import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  assertPGliteHumanAttestationActive,
  assertPGliteHumanAttestationIfRequired,
  assertPGliteHumanAttestationManifest,
  assertPGliteHumanAttestationRoute,
  getPGliteHumanAttestationStatus,
  PGLITE_HUMAN_ATTESTATION_MANIFESTS,
  PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY,
  readPGliteHumanAttestationChain,
  recordInitialPGliteHumanAttestationIfMissing,
  revokePGliteHumanAttestationInTransaction,
  restorePGliteHumanAttestationInTransaction,
  type PGliteHumanAttestationRouteMetadata,
  PGliteHumanAttestationError,
} from "./attestation.ts";
import {
  PGLITE_ATTESTATION_SQL,
  PGLITE_ATTESTATION_TABLES,
} from "./attestation-sql.ts";
import { PGliteStore } from "./transaction.ts";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import {
  CTBC_HUMAN_ATTESTED_V1_MANIFEST,
} from "../canonical/ctbc-human-attestation-contract.ts";
import {
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST,
  esunCreditCardHumanAttestedManifestFingerprint,
} from "../canonical/esun-credit-card-human-attestation-contract.ts";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  fubonCreditCardHumanAttestedManifestFingerprint,
} from "../canonical/fubon-credit-card-human-attestation-contract.ts";
import {
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
} from "../canonical/fubon-human-attestation-contract.ts";
import {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
} from "../canonical/hncb-human-attestation-contract.ts";
import {
  POST_HUMAN_ATTESTED_V1_MANIFEST,
} from "../canonical/post-human-attestation-contract.ts";
import {
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
} from "../canonical/sinopac-human-attestation-contract.ts";
import {
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  yuantaCreditCardHumanAttestedV2ManifestFingerprint,
} from "../canonical/yuanta-credit-card-human-attestation-contract.ts";
import {
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
} from "../canonical/yuanta-human-attestation-contract.ts";

const fubon: PGliteHumanAttestationRouteMetadata = {
  authorityRoute: "fubon/domestic-deposit/human-attested-v1",
};
const ctbc: PGliteHumanAttestationRouteMetadata = {
  authorityRoute: "ctbc/domestic-deposit/human-attested-v1",
};

async function fixture(directory?: string): Promise<{
  database: PGlite;
  store: PGliteStore;
}> {
  const database = await PGlite.create(directory);
  const store = new PGliteStore(database);
  await database.transaction(async (transaction) => {
    await transaction.exec(PGLITE_ATTESTATION_SQL);
  });
  // Initialization is intentionally idempotent.  A baseline cutover can
  // replay the reviewed SQL without changing existing event rows.
  await database.transaction(async (transaction) => {
    await transaction.exec(PGLITE_ATTESTATION_SQL);
  });
  return { database, store };
}

test("PGlite human-attestation registry covers every active contract and table", () => {
  assert.equal(PGLITE_HUMAN_ATTESTATION_MANIFESTS.length, 9);
  assert.equal(Object.keys(PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY).length, 9);
  assert.equal(PGLITE_ATTESTATION_TABLES.length, 9);
  assert.equal(
    new Set(PGLITE_HUMAN_ATTESTATION_MANIFESTS.map((entry) => entry.tableName)).size,
    PGLITE_ATTESTATION_TABLES.length,
  );
  const currentRoutes = new Set([
    "ctbc/domestic-deposit/human-attested-v1",
    "esun/credit-card/human-attested-v4",
    "fubon/credit-card/human-attested-v2",
    "fubon/domestic-deposit/human-attested-v1",
    "hncb/domestic-deposit/human-attested-v1",
    "post/domestic-deposit/human-attested-v1",
    "sinopac/domestic-deposit/human-attested-v1",
    "yuanta/credit-card/human-attested-v2",
    "yuanta/domestic-deposit/human-attested-v2",
  ]);
  for (const entry of PGLITE_HUMAN_ATTESTATION_MANIFESTS) {
    assert.equal(entry.providerGuaranteed, false);
    assert.match(entry.manifestFingerprint, /^sha256:/u);
    assert.equal(entry.current, currentRoutes.has(entry.authorityRoute));
    assert.equal(
      assertPGliteHumanAttestationRoute({ authorityRoute: entry.authorityRoute }),
      entry,
    );
    assert.equal(
      assertPGliteHumanAttestationManifest({
        authorityRoute: entry.authorityRoute,
        attestationId: entry.attestationId,
        evidenceVersion: entry.evidenceVersion,
        manifestFingerprint: entry.manifestFingerprint,
        // A child may send this field, but it is never used as authority.
        status: "active",
      }),
      entry,
    );
  }
});

test("reviewed PGlite baseline accepts the attestation extension for active E.SUN", async () => {
  const database = await createBaselinePGlite();
  try {
    await database.exec(PGLITE_ATTESTATION_SQL);
    const tables = await database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE '%attestation_events' ORDER BY table_name",
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [...PGLITE_ATTESTATION_TABLES].sort(),
    );
    const esun: PGliteHumanAttestationRouteMetadata = {
      authorityRoute: "esun/credit-card/human-attested-v4",
    };
    const store = new PGliteStore(database);
    await store.transaction((transaction) =>
      recordInitialPGliteHumanAttestationIfMissing(
        transaction,
        esun,
        "2026-09-22T10:00:00.000Z",
      ),
    );
    await store.transaction((transaction) =>
      revokePGliteHumanAttestationInTransaction(transaction, {
        ...esun,
        at: "2026-09-22T11:00:00.000Z",
        reason: "baseline compatibility revoke",
      }),
    );
    const restored = await store.transaction((transaction) =>
      restorePGliteHumanAttestationInTransaction(transaction, {
        ...esun,
        at: "2026-09-22T12:00:00.000Z",
        reason: "baseline compatibility restore",
      }),
    );
    assert.equal(restored.eventKind, "restored");
    assert.equal(restored.sequence, 3);
  } finally {
    await database.close();
  }
});

test("PGlite worker registry stays aligned with canonical pure contract metadata", () => {
  const local = (authorityRoute: string) => {
    const value = PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY[authorityRoute];
    assert.ok(value, `missing worker contract ${authorityRoute}`);
    return value;
  };
  const fingerprintFromManifest = (value: {
    provenance: {
      sourceCaptureFingerprint?: string;
      attestationContractFingerprint?: string;
    };
  }): string =>
    value.provenance.sourceCaptureFingerprint ??
    value.provenance.attestationContractFingerprint ??
    "";
  const pairs = [
    [CTBC_HUMAN_ATTESTED_V1_MANIFEST, "ctbc/domestic-deposit/human-attested-v1", fingerprintFromManifest(CTBC_HUMAN_ATTESTED_V1_MANIFEST)],
    [FUBON_HUMAN_ATTESTED_V1_MANIFEST, "fubon/domestic-deposit/human-attested-v1", fingerprintFromManifest(FUBON_HUMAN_ATTESTED_V1_MANIFEST)],
    [HNCB_HUMAN_ATTESTED_V1_MANIFEST, "hncb/domestic-deposit/human-attested-v1", fingerprintFromManifest(HNCB_HUMAN_ATTESTED_V1_MANIFEST)],
    [POST_HUMAN_ATTESTED_V1_MANIFEST, "post/domestic-deposit/human-attested-v1", fingerprintFromManifest(POST_HUMAN_ATTESTED_V1_MANIFEST)],
    [SINOPAC_HUMAN_ATTESTED_V1_MANIFEST, "sinopac/domestic-deposit/human-attested-v1", fingerprintFromManifest(SINOPAC_HUMAN_ATTESTED_V1_MANIFEST)],
    [YUANTA_HUMAN_ATTESTED_V2_MANIFEST, "yuanta/domestic-deposit/human-attested-v2", fingerprintFromManifest(YUANTA_HUMAN_ATTESTED_V2_MANIFEST)],
    [FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST, "fubon/credit-card/human-attested-v2", fubonCreditCardHumanAttestedManifestFingerprint(FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST)],
    [ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST, "esun/credit-card/human-attested-v4", esunCreditCardHumanAttestedManifestFingerprint()],
    [YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST, "yuanta/credit-card/human-attested-v2", yuantaCreditCardHumanAttestedV2ManifestFingerprint()],
  ] as const;
  for (const [canonical, route, fingerprint] of pairs) {
    const worker = local(route);
    assert.equal(worker.attestationId, canonical.attestationId);
    assert.equal(worker.evidenceVersion, canonical.evidenceVersion);
    assert.equal(worker.authorityRoute, canonical.authorityRoute);
    assert.equal(worker.attestedAt, canonical.attestedAt);
    assert.equal(worker.attestedBy, canonical.attestedBy);
    assert.equal(worker.manifestFingerprint, fingerprint);
  }
});

test("PGlite human-attestation admits, revokes, validates, and remains append-only", async () => {
  const { store } = await fixture();
  try {
    const initial = await store.transaction((transaction) =>
      recordInitialPGliteHumanAttestationIfMissing(transaction, fubon, "2026-09-22T10:00:00.000Z"),
    );
    assert.equal(initial.sequence, 1);
    assert.equal(initial.eventKind, "attested");
    assert.equal(
      (await store.transaction((transaction) => getPGliteHumanAttestationStatus(transaction, fubon))).status,
      "active",
    );
    const revoked = await store.transaction((transaction) =>
      revokePGliteHumanAttestationInTransaction(transaction, {
        ...fubon,
        at: "2026-09-22T11:00:00.000Z",
        reason: "contract evidence was withdrawn",
      }),
    );
    assert.equal(revoked.sequence, 2);
    assert.equal(revoked.manifestStatus, "revoked");
    assert.equal(
      (await store.transaction((transaction) => getPGliteHumanAttestationStatus(transaction, fubon))).status,
      "revoked",
    );
    await assert.rejects(
      store.transaction((transaction) => assertPGliteHumanAttestationActive(transaction, fubon)),
      (error: unknown) =>
        error instanceof PGliteHumanAttestationError && error.code === "inactive",
    );
    // A second revoke is idempotent and cannot append a duplicate event.
    const repeated = await store.transaction((transaction) =>
      revokePGliteHumanAttestationInTransaction(transaction, {
        ...fubon,
        at: "2026-09-23T11:00:00.000Z",
        reason: "repeat request",
      }),
    );
    assert.equal(repeated.sequence, 2);
    assert.equal(
      (await store.transaction((transaction) => readPGliteHumanAttestationChain(transaction, fubon))).length,
      2,
    );
    await assert.rejects(
      store.query("UPDATE fubon_attestation_events SET reason = 'tampered'"),
      /append-only/u,
    );
    await assert.rejects(
      store.query("DELETE FROM fubon_attestation_events"),
      /append-only/u,
    );
  } finally {
    await store.close();
  }
});

test("every provider-specific attestation table supports the same durable initial/revoke admission boundary", async () => {
  const { store } = await fixture();
  try {
    for (const [index, contract] of PGLITE_HUMAN_ATTESTATION_MANIFESTS.entries()) {
      const metadata = { authorityRoute: contract.authorityRoute };
      const initial = await store.transaction((transaction) =>
        recordInitialPGliteHumanAttestationIfMissing(
          transaction,
          metadata,
          `2026-09-22T${String(index % 10).padStart(2, "0")}:00:00.000Z`,
        ),
      );
      assert.equal(initial.attestationId, contract.attestationId);
      const revoked = await store.transaction((transaction) =>
        revokePGliteHumanAttestationInTransaction(transaction, {
          ...metadata,
          at: `2026-09-23T${String(index % 10).padStart(2, "0")}:00:00.000Z`,
          reason: `provider ${contract.provider} revoke`,
        }),
      );
      assert.equal(revoked.manifestStatus, "revoked");
      assert.equal(revoked.sequence, 2);
      if (contract.restoreEventKind) {
        const restored = await store.transaction((transaction) =>
          restorePGliteHumanAttestationInTransaction(transaction, {
            ...metadata,
            at: `2026-09-24T${String(index % 10).padStart(2, "0")}:00:00.000Z`,
            reason: `provider ${contract.provider} restore`,
          }),
        );
        assert.equal(restored.eventKind, contract.restoreEventKind);
        assert.equal(restored.manifestStatus, "active");
        assert.equal(restored.sequence, 3);
      } else {
        await assert.rejects(
          store.transaction((transaction) =>
            restorePGliteHumanAttestationInTransaction(transaction, {
              ...metadata,
              at: "2026-09-24T00:00:00.000Z",
              reason: `provider ${contract.provider} unsupported restore`,
            }),
          ),
          /cannot be restored/u,
        );
      }
    }
  } finally {
    await store.close();
  }
});

test("PGlite human-attestation rejects forged metadata and malformed durable chains", async () => {
  const { store } = await fixture();
  try {
    const known = PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY[fubon.authorityRoute];
    assert.ok(known);
    assert.throws(
      () => assertPGliteHumanAttestationRoute({
        authorityRoute: fubon.authorityRoute,
        evidenceVersion: "human-attested-v9",
      }),
      /evidence version/u,
    );
    assert.throws(
      () => assertPGliteHumanAttestationRoute({
        authorityRoute: fubon.authorityRoute,
        manifestFingerprint: "sha256:forged",
      }),
      /fingerprint/u,
    );
    await store.transaction((transaction) =>
      recordInitialPGliteHumanAttestationIfMissing(transaction, fubon, "2026-09-22T10:00:00.000Z"),
    );
    const insert = (values: readonly unknown[]) =>
      store.query(
        `INSERT INTO fubon_attestation_events(
          event_id, attestation_id, evidence_version, event_kind, manifest_status,
          event_at, reason, manifest_fingerprint, event_sequence
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values,
      );
    const id = (byte: number): Uint8Array => Uint8Array.from(new Array(16).fill(byte));
    await assert.rejects(
      insert([
        id(2), known.attestationId, known.evidenceVersion, "attested", "active",
        "2026-09-22T10:01:00.000Z", "duplicate sequence", known.manifestFingerprint, 1,
      ]),
      /duplicate key|append-only/iu,
    );
    await insert([
      id(3), known.attestationId, known.evidenceVersion, "attested", "active",
      "2026-09-22T10:01:00.000Z", "duplicate attestation", known.manifestFingerprint, 2,
    ]);
    await assert.rejects(
      store.transaction((transaction) => readPGliteHumanAttestationChain(transaction, fubon)),
      /event chain|transition/u,
    );
    // A separate provider table proves the same chain validator is route
    // aware, rather than relying on one global in-memory status flag.
    await store.transaction((transaction) =>
      recordInitialPGliteHumanAttestationIfMissing(transaction, ctbc, "2026-09-22T10:00:00.000Z"),
    );
    assert.equal(
      (await store.transaction((transaction) => getPGliteHumanAttestationStatus(transaction, ctbc))).status,
      "active",
    );
    await assert.rejects(
      store.transaction((transaction) =>
        revokePGliteHumanAttestationInTransaction(transaction, {
          ...ctbc,
          at: "2026-09-22T09:59:59.000Z",
          reason: "late revocation",
        }),
      ),
      /monotonic/u,
    );
    await store.query(
      `INSERT INTO ctbc_attestation_events(
        event_id, attestation_id, evidence_version, event_kind, manifest_status,
        event_at, reason, manifest_fingerprint, event_sequence
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        Uint8Array.from(new Array(16).fill(7)),
        PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY[ctbc.authorityRoute]!.attestationId,
        PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY[ctbc.authorityRoute]!.evidenceVersion,
        "revoked",
        "revoked",
        "2026-09-22T09:00:00.000Z",
        "reordered event",
        PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY[ctbc.authorityRoute]!.manifestFingerprint,
        2,
      ],
    );
    await assert.rejects(
      store.transaction((transaction) => readPGliteHumanAttestationChain(transaction, ctbc)),
      /monotonic/u,
    );
  } finally {
    await store.close();
  }
});

test("source-only routes bypass the attestation gate while unknown required routes fail closed", async () => {
  const { store } = await fixture();
  try {
    const sourceOnly = await store.transaction((transaction) =>
      assertPGliteHumanAttestationIfRequired(transaction, {
        authorityRoute: "cathay/domestic-deposit/v1",
      }),
    );
    assert.equal(sourceOnly, null);
    await assert.rejects(
      store.transaction((transaction) =>
        assertPGliteHumanAttestationIfRequired(transaction, {
          authorityRoute: "future/domestic-deposit/human-attested-v1",
          required: true,
        }),
      ),
      /not registered locally/u,
    );
  } finally {
    await store.close();
  }
});

test("PGlite human-attestation initial event rolls back with a failed financial transaction", async () => {
  const { store } = await fixture();
  try {
    await assert.rejects(
      store.transaction(async (transaction) => {
        await recordInitialPGliteHumanAttestationIfMissing(transaction, fubon, "2026-09-22T10:00:00.000Z");
        await transaction.query("CREATE TEMP TABLE attestation_financial_probe(id integer primary key)");
        await transaction.query("INSERT INTO attestation_financial_probe(id) VALUES (1)");
        throw new Error("financial command failed");
      }),
      /financial command failed/u,
    );
    const status = await store.transaction((transaction) =>
      getPGliteHumanAttestationStatus(transaction, fubon),
    );
    assert.equal(status.status, "uninitialized");
  } finally {
    await store.close();
  }
});

test("PGlite human-attestation revocation survives close and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pglite-attestation-check-"));
  const first = await fixture(directory);
  await first.store.transaction((transaction) =>
    recordInitialPGliteHumanAttestationIfMissing(transaction, fubon, "2026-09-22T10:00:00.000Z"),
  );
  await first.store.transaction((transaction) =>
    revokePGliteHumanAttestationInTransaction(transaction, {
      ...fubon,
      at: "2026-09-22T11:00:00.000Z",
      reason: "durable revocation check",
    }),
  );
  await first.store.close();

  const reopened = await fixture(directory);
  try {
    await assert.rejects(
      reopened.store.transaction((transaction) =>
        assertPGliteHumanAttestationActive(transaction, fubon),
      ),
      /financial admission is blocked/u,
    );
    const status = await reopened.store.transaction((transaction) =>
      getPGliteHumanAttestationStatus(transaction, fubon),
    );
    assert.equal(status.status, "revoked");
    assert.equal(status.sequence, 2);
  } finally {
    await reopened.store.close();
  }
});
