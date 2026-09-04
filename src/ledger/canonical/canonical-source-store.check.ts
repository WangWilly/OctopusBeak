import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  admitCanonicalSourceEvidence,
  type CanonicalSourceEvidence,
  type CanonicalValidatedSourceEvidence,
} from "./canonical-source-evidence.ts";
import {
  CANONICAL_SOURCE_SCHEMA_VERSION,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  commitCanonicalSourceEvidence,
  createCanonicalFinancialQuery,
  createCanonicalSourceStore,
  createCathayCanonicalFinancialQuery,
  createCanonicalSchemaLifecyclePlan,
  isKnownRetiredFubonV18Fingerprint,
  isRetiredFubonV18RecoveryEligible,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
  openCanonicalDatabase,
  validateCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCapture,
} from "./canonical-financial-deposit-writer.ts";
import { ensureCanonicalCreditCardSchema } from "./canonical-credit-card-persistence.ts";
import { CanonicalSchemaLifecycle } from "./canonical-schema-lifecycle.ts";
import { ensureFubonCreditCardSchema } from "./fubon-credit-card.ts";
import {
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  commitCanonicalLoanCapture,
  createCanonicalLoanStore,
} from "./loan-financial.ts";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  queryCanonicalInvestmentCurrent,
  queryCanonicalInvestmentHistorical,
  queryCanonicalInvestmentLineage,
} from "./investment-financial.ts";
import {
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
} from "./investment-funding-relations.ts";
import { buildYuantaInvestmentCapture } from "./yuanta-investment-adapters.ts";
import {
  admitHncbDomesticDepositCaptureEvidence,
  admitHncbDomesticDepositFinancialCapture,
  commitCanonicalHncbDomesticDepositCapture,
  HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  getHncbHumanAttestedV1Manifest,
} from "./hncb-domestic-deposit.ts";
import {
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
} from "./yuanta-credit-card-human-attestation.ts";

function markSyntheticFixtureAsSchemaV20(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us)
      VALUES (19, 19), (20, 20);
    PRAGMA user_version = 20;
  `);
  db.close();
}

async function seedRetiredFubonV18BridgeFixture(
  mutate?: (db: DatabaseSync) => void,
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "canonical-retired-fubon-v18-"));
  const path = join(directory, "canonical.sqlite");
  const current = createCanonicalSourceStore(path);
  current.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM canonical_contract_purge_commits;
      DELETE FROM canonical_contract_purges;
      DELETE FROM source_authority_routes;
      DELETE FROM identity_epochs;
      DELETE FROM source_connections;
      DELETE FROM canonical_commits;
    `);
    const commitId = (sequence: number): Buffer => {
      const id = Buffer.alloc(16);
      id.writeUInt32BE(sequence, 12);
      return id;
    };
    const insertCommit = db.prepare(
      `INSERT INTO canonical_commits(
         commit_id, commit_sequence, recorded_at_utc_us,
         authority_route, commit_kind
       ) VALUES (?, ?, ?, 'fubon/domestic-deposit/capture-evidence-v2', 'source_capture')`,
    );
    for (let sequence = 1; sequence <= 554; sequence += 1)
      insertCommit.run(commitId(sequence), sequence, sequence);
    const connectionId = Buffer.alloc(16, 0xa1);
    const epochId = Buffer.alloc(16, 0xb2);
    db.prepare(
      `INSERT INTO source_connections(
         source_connection_id, integration_namespace, source_connection_key,
         created_commit_id
       ) VALUES (?, 'fubon', 'sha256:test-connection', ?)`,
    ).run(connectionId, commitId(1));
    db.prepare(
      `INSERT INTO identity_epochs(
         identity_epoch_id, source_connection_id, epoch_key, created_commit_id
       ) VALUES (?, ?, 'sha256:test-epoch', ?)`,
    ).run(epochId, connectionId, commitId(1));
    db.prepare(
      `INSERT INTO source_authority_routes(
         authority_route, integration_namespace, stream, contract_version,
         created_commit_id
       ) VALUES (
         'fubon/domestic-deposit/capture-evidence-v2', 'fubon',
         'domestic-deposit', 'capture-evidence-v2', ?
       )`,
    ).run(commitId(1));
    const insertAudit = db.prepare(
      `INSERT INTO canonical_contract_purges(
         purge_id, schema_version, reason, scope_json, deleted_row_count,
         deleted_table_counts_json, closure_fingerprint, applied_at_utc_us
       ) VALUES (?, ?, 'legacy fixture', ?, ?, ?, ?, 1)`,
    );
    insertAudit.run(
      "source-connection-identity/v1:fubon-yuanta:v11",
      11,
      '{"integrationNamespaces":["fubon","yuanta"],"streams":["domestic-deposit","loan","credit-card"]}',
      2738,
      '{"capture_scope_pages":552,"capture_scopes":552,"source_captures":552,"source_record_provenance":360,"source_record_scopes":360,"source_records":360,"source_subjects":2}',
      "sha256:SvIOUIbQfNeK3aiCShS7Ud0-VircMq3_DqqN_stPLv4",
    );
    insertAudit.run(
      "credit-card-source-connection/v1:fubon-yuanta:v12",
      12,
      '{"integrationNamespaces":["fubon","yuanta"],"streams":["credit-card"]}',
      0,
      "{}",
      "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
    insertAudit.run(
      "fubon-domestic-deposit/observed-composite-v1:v14",
      14,
      '{"integrationNamespaces":["fubon"],"streams":["domestic-deposit"]}',
      12,
      '{"capture_scope_pages":2,"capture_scopes":2,"source_captures":2,"source_record_provenance":1,"source_record_scopes":1,"source_records":1,"source_route_bindings":1,"source_subjects":2}',
      "sha256:XjDlPT6fZDphLkGjSZ4cp2yDBRSDrn2zxR0ak4ouHmo",
    );
    insertAudit.run(
      "yuanta-trade-investment/market-evidence-v2:v17",
      17,
      '{"integrationNamespaces":["yuanta-trade"],"streams":["investment"]}',
      0,
      "{}",
      "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
    const insertBridge = db.prepare(
      `INSERT INTO canonical_contract_purge_commits(purge_id, commit_id)
       VALUES ('fubon-domestic-deposit/observed-composite-v1:v14', ?)`,
    );
    for (const sequence of [1, 553, 554]) insertBridge.run(commitId(sequence));
    db.exec("DELETE FROM schema_migrations WHERE version > 18; PRAGMA user_version = 18");
    mutate?.(db);
    db.exec("COMMIT; PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK; PRAGMA foreign_keys = ON");
    db.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  db.close();
  return { directory, path };
}

test("production schema registry declares every published version transition", () => {
  const plan = createCanonicalSchemaLifecyclePlan();
  const steps = plan.migrations.transitions;
  assert.deepEqual(
    steps.map(({ id, fromVersion, toVersion }) => ({ id, fromVersion, toVersion })),
    [
      { id: "canonical/fresh-v1-baseline/v1", fromVersion: 0, toVersion: 1 },
      ...Array.from({ length: 19 }, (_, index) => ({
        id: `canonical/v${index + 1}-v${index + 2}/v1`,
        fromVersion: index + 1,
        toVersion: index + 2,
      })),
    ],
  );
  assert.equal(steps[0]!.toVersion, 1);
  for (let index = 1; index < steps.length; index += 1)
    assert.equal(steps[index - 1]!.toVersion, steps[index]!.fromVersion);
  assert.ok(Object.isFrozen(steps));
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(steps))
      .digest("hex"),
    "7722e07e06668adb6574ce78cb07ee2de254b0ceef58d43152b0756d3bc3291d",
    "published migration ids and version ordering are immutable during the architecture refactor",
  );
  assert.deepEqual(
    (plan.currentVersionMigrations ?? []).map(({ id }) => id),
    [
      "canonical/capture-scope-schema/v1",
      "canonical/financial-revision-schema/v1",
      "canonical/time-observation-schema/v1",
      "canonical/account-currency-schema/v1",
      "canonical/fubon-credit-card-extension-compatibility/v1",
    ],
  );
  assert.deepEqual(
    (plan.repairs ?? []).map(({ id }) => id),
    [
      "canonical/foreign-currency-conversion-schema/v1",
      "canonical/credit-card-extension/v1",
      "canonical/fubon-credit-card-extension/v1",
      "canonical/attestation/cathay-events/v1",
      "canonical/attestation/ctbc-events/v1",
      "canonical/attestation/esun-credit-card-events/v1",
      "canonical/attestation/fubon-credit-card-events/v1",
      "canonical/attestation/fubon-events/v1",
      "canonical/attestation/hncb-events/v1",
      "canonical/attestation/post-events/v1",
      "canonical/attestation/sinopac-events/v1",
      "canonical/attestation/yuanta-credit-card-events/v1",
      "canonical/attestation/yuanta-events/v1",
    ],
  );
});

test("retired Fubon recovery policy accepts only exact writable pending-v20 state", () => {
  const exact = isKnownRetiredFubonV18Fingerprint(
    "sha256:xtfHsf19a3fRiBwnnMBExh__84CGy_uB-YYg6JIpOO8",
    "sha256:3DV_wKjstIx_mccTUv_98FtfrIO4FofujO5wsdK8x8g",
  );
  assert.equal(exact, true, "the immutable production fingerprints are exact");
  assert.equal(
    isRetiredFubonV18RecoveryEligible({
      schemaVersion: 20,
      readOnly: false,
      exactKnownState: exact,
    }),
    true,
    "an exact pending v20 writable reopen remains recoverable",
  );
  assert.equal(
    isRetiredFubonV18RecoveryEligible({
      schemaVersion: 20,
      readOnly: true,
      exactKnownState: exact,
    }),
    false,
    "the same exact pending v20 state is rejected read-only",
  );
  assert.equal(
    isKnownRetiredFubonV18Fingerprint(
      "sha256:xtfHsf19a3fRiBwnnMBExh__84CGy_uB-YYg6JIpOOA",
      "sha256:3DV_wKjstIx_mccTUv_98FtfrIO4FofujO5wsdK8x8g",
    ),
    false,
    "a one-character commit-fingerprint near-match is rejected",
  );
  assert.equal(
    isRetiredFubonV18RecoveryEligible({
      schemaVersion: 20,
      readOnly: false,
      exactKnownState: false,
    }),
    false,
    "a pending v20 near-match cannot enter recovery",
  );
});

test("the exact retired Fubon v18 store restores only its omitted purge bridges", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-retired-fubon-v18-real-"));
  const path = join(directory, "canonical.sqlite");
  try {
    try {
      await copyFile(join(process.cwd(), "data", "ledger", "canonical.sqlite"), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      t.skip("real retired v18 canonical fixture is unavailable");
      return;
    }
    const before = new DatabaseSync(path, { readOnly: true });
    const fixtureVersion = Number(
      before.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (fixtureVersion !== 18) {
      before.close();
      t.skip("real retired v18 canonical fixture has already been upgraded");
      return;
    }
    const commitDigestBefore = createHash("sha256")
      .update(
        JSON.stringify(
          before
            .prepare(
              `SELECT commit_sequence, hex(commit_id) AS commit_id,
                      recorded_at_utc_us, authority_route, commit_kind
                 FROM canonical_commits ORDER BY commit_sequence`,
            )
            .all(),
        ),
      )
      .digest("hex");
    before.close();

    // Simulate a process stopping after the lifecycle commits v20 but before
    // the source-store's independent domain data transition begins.
    const schemaOnly = CanonicalSchemaLifecycle.open(
      path,
      createCanonicalSchemaLifecyclePlan(),
      { busyTimeoutMs: 30_000 },
    );
    assert.equal(schemaOnly.openedFromVersion, 18);
    schemaOnly.close();
    const pending = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      Number(pending.prepare("PRAGMA user_version").get()?.user_version),
      20,
    );
    assert.equal(
      Number(
        pending
          .prepare("SELECT COUNT(*) AS count FROM canonical_contract_purge_commits")
          .get()?.count,
      ),
      3,
    );
    pending.close();
    assert.throws(
      () => openCanonicalDatabase(directory, { readOnly: true }),
      /durable source provenance evidence/i,
      "the exact pending v20 store remains fail-closed for read-only access",
    );

    // The next ordinary writable open must re-recognize the exact pending
    // state at v20 and finish the bridge instead of becoming unrecoverable.
    const repaired = openCanonicalDatabase(directory);
    assert.equal(
      Number(repaired.prepare("PRAGMA user_version").get()?.user_version),
      20,
    );
    assert.deepEqual(
      repaired
        .prepare(
          `SELECT purge.purge_id, COUNT(*) AS count,
                  MIN(commit_row.commit_sequence) AS minimum,
                  MAX(commit_row.commit_sequence) AS maximum
             FROM canonical_contract_purge_commits purge
             JOIN canonical_commits commit_row
               ON commit_row.commit_id = purge.commit_id
            GROUP BY purge.purge_id ORDER BY purge.purge_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          purge_id: "fubon-domestic-deposit/observed-composite-v1:v14",
          count: 3,
          minimum: 1,
          maximum: 554,
        },
        {
          purge_id: "source-connection-identity/v1:fubon-yuanta:v11",
          count: 551,
          minimum: 2,
          maximum: 552,
        },
      ],
    );
    const commitDigestAfter = createHash("sha256")
      .update(
        JSON.stringify(
          repaired
            .prepare(
              `SELECT commit_sequence, hex(commit_id) AS commit_id,
                      recorded_at_utc_us, authority_route, commit_kind
                 FROM canonical_commits ORDER BY commit_sequence`,
            )
            .all(),
        ),
      )
      .digest("hex");
    assert.equal(commitDigestAfter, commitDigestBefore);
    for (const table of [
      "source_captures",
      "source_records",
      "financial_accounts",
      "financial_transactions",
      "transaction_revisions",
      "projection_generations",
      "projection_generation_provenance",
    ])
      assert.equal(
        Number(
          repaired.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
        ),
        0,
      );
    repaired.close();

    const second = openCanonicalDatabase(directory);
    assert.equal(
      Number(
        second
          .prepare(
            `SELECT COUNT(*) AS count
               FROM canonical_contract_purge_commits
              WHERE purge_id = 'source-connection-identity/v1:fubon-yuanta:v11'`,
          )
          .get()?.count,
      ),
      551,
    );
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the retired Fubon v18 bridge rejects every near-match and read-only open", async (t) => {
  const cases: Array<readonly [string, (db: DatabaseSync) => void]> = [
    [
      "authority route",
      (db) =>
        db.prepare("UPDATE canonical_commits SET authority_route = 'altered' WHERE commit_sequence = 2").run(),
    ],
    [
      "commit count",
      (db) => db.prepare("DELETE FROM canonical_commits WHERE commit_sequence = 552").run(),
    ],
    [
      "purge audit",
      (db) =>
        db
          .prepare(
            `UPDATE canonical_contract_purges SET deleted_row_count = 2737
              WHERE purge_id = 'source-connection-identity/v1:fubon-yuanta:v11'`,
          )
          .run(),
    ],
    [
      "live source data",
      (db) =>
        db
          .prepare(
            `INSERT INTO source_subjects(
               source_subject_id, source_connection_id, identity_epoch_id,
               stream, record_kind, subject_digest, created_commit_id
             ) SELECT zeroblob(16), source_connection_id,
                      (SELECT identity_epoch_id FROM identity_epochs LIMIT 1),
                      'domestic-deposit', 'deposit-transaction',
                      'sha256:unexpected-live-subject', created_commit_id
                 FROM source_connections LIMIT 1`,
          )
          .run(),
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async () => {
      const { directory } = await seedRetiredFubonV18BridgeFixture(mutate);
      try {
        assert.throws(
          () => openCanonicalDatabase(directory),
          /fingerprint is not recognized|durable source provenance evidence/i,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

  await t.test("read-only", async () => {
    const { directory } = await seedRetiredFubonV18BridgeFixture();
    try {
      markSyntheticFixtureAsSchemaV20(join(directory, "canonical.sqlite"));
      assert.throws(
        () => openCanonicalDatabase(directory, { readOnly: true }),
        /durable source provenance evidence/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("writable pending-v20 near-match", async () => {
    const { directory } = await seedRetiredFubonV18BridgeFixture();
    try {
      markSyntheticFixtureAsSchemaV20(join(directory, "canonical.sqlite"));
      assert.throws(
        () => openCanonicalDatabase(directory),
        /durable source provenance evidence/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a current schema retries a contract data transition whose durable audit is absent", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-pending-transition-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    const initial = createCanonicalSourceStore(path);
    initial.close();

    // Model a crash after the schema transaction committed but before the
    // independent contract-purge transaction committed: user_version is
    // current while the durable completion evidence is absent.
    const interrupted = new DatabaseSync(path);
    interrupted.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'fubon-domestic-deposit/observed-composite-v1:v14';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'fubon-domestic-deposit/observed-composite-v1:v14';
      PRAGMA foreign_keys = ON;
    `);
    assert.equal(
      Number(interrupted.prepare("PRAGMA user_version").get()?.user_version),
      CANONICAL_SOURCE_SCHEMA_VERSION,
    );
    interrupted.close();

    const recovered = createCanonicalSourceStore(path);
    try {
      assert.equal(
        Number(
          recovered.db
            .prepare(
              `SELECT COUNT(*) AS count FROM canonical_contract_purges
                WHERE purge_id = 'fubon-domestic-deposit/observed-composite-v1:v14'`,
            )
            .get()?.count,
        ),
        1,
      );
    } finally {
      recovered.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only open fails closed when the v19 source occurrence purge audit is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-read-only-v19-audit-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const initial = createCanonicalSourceStore(path);
    initial.close();
    const interrupted = new DatabaseSync(path);
    interrupted.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      PRAGMA foreign_keys = ON;
    `);
    interrupted.close();
    assert.throws(
      () => openCanonicalDatabase(directory, { readOnly: true }),
      /yuanta-trade-investment\/source-occurrence-content-v3:v19|contract purge audit is missing/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public source-store validation requires the shared v19 V3 purge audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-validator-v19-audit-"));
  const path = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(path);
  try {
    const interrupted = new DatabaseSync(path);
    interrupted.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      PRAGMA foreign_keys = ON;
    `);
    interrupted.close();
    assert.throws(
      () => validateCanonicalSourceStore(store),
      /yuanta-trade-investment\/source-occurrence-content-v3:v19|contract purge audit is missing/i,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical source entry points reject structural stores without lifecycle brand", () => {
  const legitimate = createCanonicalSourceStore(":memory:");
  const forged = {
    db: legitimate.db,
    databasePath: legitimate.databasePath,
    commitClock: legitimate.commitClock,
    close() {},
  } as CanonicalSourceStore;
  try {
    assert.throws(
      () => validateCanonicalSourceStore(forged),
      /lifecycle-created and validated/u,
    );
    assert.throws(
      () => queryCanonicalSourceCurrent(forged),
      /lifecycle-created and validated/u,
    );
    assert.throws(
      () =>
        commitCanonicalSourceEvidence(
          forged,
          admitCanonicalSourceEvidence(evidence("forged-source-store")),
        ),
      /lifecycle-created and validated/u,
    );
  } finally {
    legitimate.close();
  }
});

const token = (letter: string) => `sha256:${letter.repeat(64)}`;

const fubonCreditCardFinancialCapture = (
  version: "v1" | "v2",
  captureId: string,
): CanonicalFinancialDepositCapture => {
  const route = `fubon/credit-card/human-attested-${version}`;
  const sourceDate = "2026-08-01";
  const occurrenceKey = token(version === "v1" ? "g" : "h");
  return {
    captureId,
    authorityRoute: route,
    contractVersion: route,
    identity: {
      integrationNamespace: "fubon",
      sourceConnectionKey: token(version === "v1" ? "i" : "j"),
      identityEpochKey: token(version === "v1" ? "k" : "l"),
      stream: "credit-card",
      recordKind: "fubon-credit-card-transaction",
      subjectDigest: token(version === "v1" ? "m" : "n"),
      accountNo: `fubon-${version}-portfolio`,
      accountType: "credit",
      currency: "TWD",
    },
    observedAt: "2026-08-26T00:00:00.000Z",
    scope: {
      startDate: sourceDate,
      endDate: sourceDate,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "six-billed-periods-plus-unbilled-terminal-grids",
      completenessRuleVersion: route,
      absenceAuthority: null,
      contractFingerprint: token(version === "v1" ? "o" : "p"),
      preflightFingerprint: token(version === "v1" ? "q" : "r"),
      pageCount: 7,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: route,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: route,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: route,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "defaulted_local_midnight",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: Array.from({ length: 7 }, (_, pageOrdinal) => ({
      pageOrdinal,
      responseCode: "200",
      terminal: true,
      rowCount: pageOrdinal === 0 ? 1 : 0,
      responseDigest: token(version === "v1" ? "s" : "t"),
      proofKind: "source-declared-terminal-grid",
      contractFingerprint: token(version === "v1" ? "o" : "p"),
      preflightFingerprint: token(version === "v1" ? "q" : "r"),
      metadataJson: JSON.stringify({ pageOrdinal }),
    })),
    records: [
      {
        occurrenceKey,
        collisionKey: token(version === "v1" ? "u" : "v"),
        providerKey: "human-attested:no-provider-key",
        humanAttestedOccurrenceKey: occurrenceKey,
        contentHash: token(version === "v1" ? "w" : "x"),
        sequenceLexeme: "observed-source-order:0",
        compactJson: JSON.stringify({
          occurrenceKey,
          amount: { coefficient: "100", scale: 0 },
          currency: "TWD",
          direction: "outflow",
          balanceAfter: null,
        }),
        amount: { coefficient: "100", scale: 0 },
        balanceAfter: null,
        currency: "TWD",
        direction: "outflow",
        sourceTime: {
          localDate: sourceDate,
          localTime: "00:00:00",
          timeZone: "Asia/Taipei",
          epochMilliseconds: Date.parse(`${sourceDate}T00:00:00+08:00`),
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        effectiveOn: sourceDate,
        transactionDateTimeLocal: `${sourceDate}T00:00:00`,
        description: "historical-only Fubon fixture",
      },
    ],
  };
};

/** A privacy-safe cross-version fixture: both routes share the durable Yuanta
 * source-connection lineage, while their versioned subject/account and
 * transaction identities remain distinct. */
const yuantaCreditCardFinancialCapture = (
  version: "v1" | "v2",
  captureId: string,
): CanonicalFinancialDepositCapture => {
  const route = `yuanta/credit-card/human-attested-${version}`;
  const base = fubonCreditCardFinancialCapture(version, captureId);
  const opaque = (label: string, ordinal: number): `sha256:${string}` =>
    `sha256:${createHash("sha256")
      .update(`yuanta-query-${label}:${ordinal}`)
      .digest("base64url")}`;
  const records = Array.from({ length: 31 }, (_, ordinal) => {
    const sourceDate = "2026-08-01";
    const occurrenceKey = opaque("occurrence", ordinal);
    return {
      ...base.records[0]!,
      occurrenceKey,
      collisionKey: opaque("collision", ordinal),
      humanAttestedOccurrenceKey: occurrenceKey,
      contentHash: opaque("content", ordinal),
      sequenceLexeme: `observed-source-order:${ordinal}`,
      compactJson: JSON.stringify({ ordinal, source: "yuanta-query-fixture" }),
      sourceTime: {
        ...base.records[0]!.sourceTime,
        localDate: sourceDate,
        epochMilliseconds: Date.parse(`${sourceDate}T00:00:00+08:00`),
      },
      effectiveOn: sourceDate,
      transactionDateTimeLocal: `${sourceDate}T00:00:00`,
      description: "historical/current Yuanta route-precedence fixture",
    };
  });
  return {
    ...base,
    authorityRoute: route,
    contractVersion: route,
    identity: {
      ...base.identity,
      integrationNamespace: "yuanta",
      sourceConnectionKey: token("y"),
      identityEpochKey: token("z"),
      recordKind: "yuanta-credit-card-transaction",
      subjectDigest: opaque("subject", version === "v1" ? 1 : 2),
      accountNo: `yuanta-query-${version}-portfolio`,
    },
    scope: {
      ...base.scope,
      completenessBasis:
        version === "v1"
          ? "six-billed-months-plus-unbilled-terminal-no-pager"
          : "six-billed-months-plus-unbilled-terminal-no-pager-plus-settled-summary-cycles",
      completenessRuleVersion: route,
    },
    semantics: {
      ...base.semantics,
      postingRuleVersion: route,
      semanticRuleVersion: route,
      effectiveTimeRuleVersion: route,
    },
    pages: base.pages.map((page, pageOrdinal) => ({
      ...page,
      rowCount: pageOrdinal === 0 ? records.length : 0,
      contractFingerprint: base.scope.contractFingerprint,
      preflightFingerprint: base.scope.preflightFingerprint,
      proofKind: "no-pager-terminal-grid" as const,
    })),
    records,
  };
};

type CardSentinelScope = {
  captureId: Uint8Array;
  accountId: Uint8Array;
  sourceRecordId: Uint8Array;
  transactionId: Uint8Array;
  revisionId: Uint8Array;
};

function cardSentinelScope(
  db: DatabaseSync,
  captureKey: string,
): CardSentinelScope {
  const row = db
    .prepare(
      `SELECT capture.capture_id AS captureId,
              scope.account_id AS accountId,
              record.source_record_id AS sourceRecordId,
              transaction_row.transaction_id AS transactionId,
              revision.revision_id AS revisionId
         FROM source_captures capture
         JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
         JOIN source_records record ON record.capture_id = capture.capture_id
         JOIN transaction_revisions revision
           ON revision.source_record_id = record.source_record_id
         JOIN financial_transactions transaction_row
           ON transaction_row.transaction_id = revision.transaction_id
        WHERE capture.capture_key = ?
        LIMIT 1`,
    )
    .get(captureKey) as CardSentinelScope | undefined;
  if (!row) throw new Error(`Card sentinel scope is missing: ${captureKey}`);
  return row;
}

function seedFubonCardExtensionSentinel(
  db: DatabaseSync,
  captureKey: string,
  marker: number,
): void {
  ensureFubonCreditCardSchema(db);
  const scope = cardSentinelScope(db, captureKey);
  const instrumentId = Buffer.alloc(16, marker);
  db.prepare(
    `INSERT INTO fubon_credit_instrument_details(
       instrument_id, account_id, instrument_key, card_mask, role, lifecycle
     ) VALUES (?, ?, ?, '****1234', 'primary', 'active')`,
  ).run(instrumentId, scope.accountId, `fubon-sentinel-${marker}`);
  db.prepare(
    `INSERT INTO fubon_credit_account_identity_details(
       account_id, identity_method, pan_fingerprint, pan_last4,
       pan_fingerprint_key_version
     ) VALUES (?, 'human-attested', NULL, NULL, NULL)`,
  ).run(scope.accountId);
  db.prepare(
    `INSERT INTO fubon_credit_transaction_details(
       transaction_id, revision_id, source_record_id, capture_id,
       instrument_id, billing_status, statement_key
     ) VALUES (?, ?, ?, ?, ?, 'unbilled', NULL)`,
  ).run(
    scope.transactionId,
    scope.revisionId,
    scope.sourceRecordId,
    scope.captureId,
    instrumentId,
  );
}

function seedYuantaCardExtensionSentinel(
  db: DatabaseSync,
  captureKey: string,
  marker: number,
): void {
  ensureCanonicalCreditCardSchema(db);
  const scope = cardSentinelScope(db, captureKey);
  const instrumentId = Buffer.alloc(16, marker);
  const lifecycleEventId = Buffer.alloc(16, marker + 1);
  db.prepare(
    `INSERT INTO canonical_credit_card_account_identities(
       integration_namespace, account_id, opaque_identity_key,
       identity_method, created_capture_id
     ) VALUES ('yuanta', ?, ?, 'human-attested', ?)`,
  ).run(scope.accountId, `yuanta-sentinel-${marker}`, scope.captureId);
  db.prepare(
    `INSERT INTO canonical_credit_card_instruments(
       instrument_id, integration_namespace, account_id, instrument_key,
       card_mask, role, lifecycle
     ) VALUES (?, 'yuanta', ?, ?, '****5678', 'primary', 'active')`,
  ).run(instrumentId, scope.accountId, `yuanta-sentinel-${marker}`);
  db.prepare(
    `INSERT INTO canonical_credit_card_instrument_evidence(
       instrument_id, integration_namespace, account_id, capture_id,
       source_record_id
     ) VALUES (?, 'yuanta', ?, ?, ?)`,
  ).run(instrumentId, scope.accountId, scope.captureId, scope.sourceRecordId);
  db.prepare(
    `INSERT INTO canonical_credit_card_transaction_details(
       integration_namespace, account_id, transaction_id, revision_id,
       source_record_id, capture_id, instrument_id, billing_status,
       statement_key
     ) VALUES ('yuanta', ?, ?, ?, ?, ?, ?, 'unbilled', NULL)`,
  ).run(
    scope.accountId,
    scope.transactionId,
    scope.revisionId,
    scope.sourceRecordId,
    scope.captureId,
    instrumentId,
  );
  db.prepare(
    `INSERT INTO canonical_credit_card_transaction_lifecycle(
       lifecycle_event_id, integration_namespace, account_id,
       transaction_id, revision_id, source_record_id, capture_id,
       instrument_id, billing_status, statement_key
     ) VALUES (?, 'yuanta', ?, ?, ?, ?, ?, ?, 'unbilled', NULL)`,
  ).run(
    lifecycleEventId,
    scope.accountId,
    scope.transactionId,
    scope.revisionId,
    scope.sourceRecordId,
    scope.captureId,
    instrumentId,
  );
}

const evidence = (captureId: string): CanonicalSourceEvidence => ({
  captureId,
  integrationNamespace: "synthetic",
  sourceConnectionKey: token("a"),
  identityEpoch: token("b"),
  stream: "domestic-deposit",
  recordKind: "source-record",
  routeKey: "synthetic/domestic-deposit/v8",
  contractVersion: "synthetic-v8",
  subjectDigest: token("c"),
  observedAt: "2026-08-19T00:00:00.000Z",
  scope: {
    startDate: "20260101",
    endDate: "20260102",
    kind: "point-in-time",
    completeness: "single-page",
    ruleVersion: "synthetic-completeness-v1",
  },
  pages: [
    {
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: 1,
      terminal: true,
      metadata: { pageCount: 1, totalCount: 1 },
    },
  ],
  records: [
    {
      occurrenceKey: token("d"),
      collisionKey: token("7"),
      providerKey: token("e"),
      contentHash: token("f"),
      compact: {
        sourceSequence: "1",
        directionCode: "1",
        amount: { coefficient: "100", scale: 0 },
      },
    },
  ],
});

const lineageRequest = {
  integrationNamespace: "synthetic",
  sourceConnectionKey: token("a"),
  identityEpoch: token("b"),
  stream: "domestic-deposit",
  recordKind: "source-record",
  subjectDigest: token("c"),
  occurrenceKey: token("d"),
} as const;

function namespaceFinancialSnapshot(db: DatabaseSync, namespace: string) {
  const select = (sql: string) => db.prepare(sql).all(namespace);
  return {
    connections: select(
      `SELECT hex(source_connection_id) AS id, source_connection_key
         FROM source_connections WHERE integration_namespace = ? ORDER BY id`,
    ),
    epochs: select(
      `SELECT hex(epoch.identity_epoch_id) AS id,
              hex(epoch.source_connection_id) AS connection_id, epoch.epoch_key
         FROM identity_epochs epoch
         JOIN source_connections connection
           ON connection.source_connection_id = epoch.source_connection_id
        WHERE connection.integration_namespace = ? ORDER BY id`,
    ),
    captures: select(
      `SELECT hex(capture.capture_id) AS id, capture.stream,
              capture.capture_key, capture.observed_at
         FROM source_captures capture
         JOIN source_connections connection
           ON connection.source_connection_id = capture.source_connection_id
        WHERE connection.integration_namespace = ? ORDER BY id`,
    ),
    subjects: select(
      `SELECT hex(subject.source_subject_id) AS id, subject.stream,
              subject.record_kind, subject.subject_digest
         FROM source_subjects subject
         JOIN source_connections connection
           ON connection.source_connection_id = subject.source_connection_id
        WHERE connection.integration_namespace = ? ORDER BY id`,
    ),
    routeBindings: select(
      `SELECT binding.authority_route,
              hex(binding.source_connection_id) AS connection_id,
              hex(binding.created_commit_id) AS commit_id
         FROM source_route_bindings binding
         JOIN source_connections connection
           ON connection.source_connection_id = binding.source_connection_id
        WHERE connection.integration_namespace = ?
        ORDER BY binding.authority_route, connection_id`,
    ),
    records: select(
      `SELECT hex(record.source_record_id) AS id, record.record_kind,
              record.occurrence_key, record.content_hash
         FROM source_records record
         JOIN source_captures capture ON capture.capture_id = record.capture_id
         JOIN source_connections connection
           ON connection.source_connection_id = capture.source_connection_id
        WHERE connection.integration_namespace = ? ORDER BY id`,
    ),
    accounts: select(
      `SELECT hex(account.account_id) AS id, account.stream,
              account.account_no, account.account_type
         FROM financial_accounts account
         JOIN source_connections connection
           ON connection.source_connection_id = account.source_connection_id
        WHERE connection.integration_namespace = ? ORDER BY id`,
    ),
    transactions: select(
      `SELECT hex(transaction_row.transaction_id) AS id,
              transaction_row.source_sequence
         FROM financial_transactions transaction_row
         JOIN financial_accounts account
           ON account.account_id = transaction_row.account_id
         JOIN source_connections connection
           ON connection.source_connection_id = account.source_connection_id
        WHERE connection.integration_namespace = ? ORDER BY id`,
    ),
  };
}

test("v10 to v12 adds a missing repayment-note date contract payload before validation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v10-missing-note-payload-"),
  );
  try {
    const path = join(directory, "canonical.sqlite");
    const current = createCanonicalSourceStore(path);
    current.close();

    // Reconstruct the exact shape of a real v10 database that predates the
    // additive payload column while retaining the rest of the v10 schema.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE institution_repayment_note_evidence
        DROP COLUMN date_contract_json;
      DROP TABLE canonical_contract_purge_commits;
      DROP TABLE canonical_contract_purges;
      DELETE FROM schema_migrations WHERE version = 11;
      PRAGMA user_version = 10;
    `);
    legacy.close();

    const migrated = openCanonicalDatabase(directory);
    try {
      assert.equal(
        Number(
          (
            migrated.prepare("PRAGMA user_version").get() as {
              user_version?: number;
            }
          ).user_version,
        ),
        CANONICAL_SOURCE_SCHEMA_VERSION,
      );
      assert.ok(
        migrated
          .prepare(
            "SELECT 1 FROM pragma_table_info('institution_repayment_note_evidence') WHERE name = 'date_contract_json'",
          )
          .get(),
      );
      assert.equal(
        Number(
          (
            migrated
              .prepare(
                "SELECT COUNT(*) AS count FROM canonical_contract_purges",
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        5,
      );
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
      // `openCanonicalDatabase` has already passed lifecycle validation. The
      // source-store validator intentionally accepts only a real source-store
      // wrapper, not a structural object assembled around this database.
    } finally {
      migrated.close();
    }

    const reopened = openCanonicalDatabase(directory);
    try {
      assert.equal(
        Number(
          (
            reopened.prepare("PRAGMA user_version").get() as {
              user_version?: number;
            }
          ).user_version,
        ),
        CANONICAL_SOURCE_SCHEMA_VERSION,
      );
      assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current schema rejects a non-contiguous, missing, or extra migration ledger entry", async () => {
  const cases = [
    ["missing-interior", "DELETE FROM schema_migrations WHERE version = 19", /migration metadata/i],
    ["missing-first-published", "DELETE FROM schema_migrations WHERE version = 7", /migration metadata/i],
    ["extra", "INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (21, 0)", /migration metadata/i],
  ] as const;
  for (const [label, mutation, expected] of cases) {
    const directory = await mkdtemp(
      join(tmpdir(), `canonical-source-ledger-continuity-${label}-`),
    );
    try {
      const path = join(directory, "canonical.sqlite");
      const initial = createCanonicalSourceStore(path);
      initial.close();
      const raw = new DatabaseSync(path);
      raw.exec(mutation);
      raw.close();
      assert.throws(() => openCanonicalDatabase(directory), expected, label);
      const unchanged = new DatabaseSync(path);
      try {
        assert.equal(
          Number(
            (unchanged.prepare("PRAGMA user_version").get() as { user_version?: number })
              .user_version,
          ),
          CANONICAL_SOURCE_SCHEMA_VERSION,
          label,
        );
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("v10 to v11 rolls back the additive payload when a later schema check fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v10-migration-rollback-"),
  );
  try {
    const path = join(directory, "canonical.sqlite");
    const current = createCanonicalSourceStore(path);
    current.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE institution_repayment_note_evidence
        DROP COLUMN date_contract_json;
      ALTER TABLE transaction_relations
        DROP COLUMN from_identity_epoch_id;
      DROP TABLE canonical_contract_purge_commits;
      DROP TABLE canonical_contract_purges;
      DELETE FROM schema_migrations WHERE version = 11;
      PRAGMA user_version = 10;
    `);
    legacy.close();

    assert.throws(
      () => openCanonicalDatabase(directory),
      /Canonical schema v10 relation column from_identity_epoch_id is missing/,
    );

    const afterFailure = new DatabaseSync(path);
    try {
      assert.equal(
        Number(
          (
            afterFailure.prepare("PRAGMA user_version").get() as {
              user_version?: number;
            }
          ).user_version,
        ),
        10,
      );
      assert.equal(
        afterFailure
          .prepare(
            "SELECT 1 FROM pragma_table_info('institution_repayment_note_evidence') WHERE name = 'date_contract_json'",
          )
          .get(),
        undefined,
      );
      assert.equal(
        afterFailure
          .prepare(
            "SELECT 1 FROM pragma_table_info('transaction_relations') WHERE name = 'from_identity_epoch_id'",
          )
          .get(),
        undefined,
      );
      assert.equal(
        Number(
          (
            afterFailure.prepare("PRAGMA foreign_keys").get() as {
              foreign_keys?: number;
            }
          ).foreign_keys,
        ),
        1,
      );
      assert.equal(
        afterFailure
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_contract_purges'",
          )
          .get(),
        undefined,
      );
    } finally {
      afterFailure.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v10 to v11 precisely purges legacy Fubon/Yuanta product identity scopes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v11-identity-purge-"),
  );
  try {
    const path = join(directory, "canonical.sqlite");
    await commitCathayDomesticDeposit(
      directory,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );

    const legacy = createCanonicalLoanStore(path);
    await commitCanonicalLoanCapture(
      legacy,
      admitCanonicalLoanCapture(structuredClone(LOAN_CONTRACT_FIXTURES.fubon)),
    );
    await commitCanonicalLoanCapture(
      legacy,
      admitCanonicalLoanCapture(structuredClone(LOAN_CONTRACT_FIXTURES.yuanta)),
    );
    await commitCanonicalFinancialDepositCapture(
      legacy.sourceStore,
      admitCanonicalFinancialDepositCapture(
        fubonCreditCardFinancialCapture("v2", "legacy-fubon-card"),
      ),
    );
    await commitCanonicalFinancialDepositCapture(
      legacy.sourceStore,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v2", "legacy-yuanta-card"),
      ),
    );
    const investmentConnectionKey = token("v");
    const investmentCapture = admitCanonicalInvestmentCapture(
      buildYuantaInvestmentCapture({
        sourceId: "yuanta-trade",
        captureId: "legacy-yuanta-investment",
        sourceConnectionKey: investmentConnectionKey,
        identityEpochKey: token("w"),
        accountKey: token("x"),
        reportingCurrency: "TWD",
        observedAt: "2026-08-31T12:00:00.000Z",
        sourceEffectiveOn: "2026-08-30",
        holdings: [
          {
            sourceRecordKey: token("y"),
            producerSecurityId: "SANITIZED-SECURITY",
            currency: "TWD",
            effectiveOn: "2026-08-30",
            quantity: { coefficient: "1", scale: 0 },
          },
        ],
        transactions: [],
      }),
    );
    await commitCanonicalInvestmentCapture(
      legacy.sourceStore,
      investmentCapture,
    );
    const investmentMeasurementKey =
      investmentCapture.holdings[0]!.measurementKey;
    const fubonLoanRow = legacy.db
      .prepare(
        `SELECT connection.source_connection_id, account.identity_epoch_id,
                transaction_row.transaction_id, revision.source_record_id,
                revision.capture_id, revision.commit_id
           FROM financial_transactions transaction_row
           JOIN financial_accounts account ON account.account_id = transaction_row.account_id
           JOIN source_connections connection
             ON connection.source_connection_id = account.source_connection_id
           JOIN transaction_revisions revision
             ON revision.transaction_id = transaction_row.transaction_id
          WHERE connection.integration_namespace = 'fubon'
            AND account.stream = 'loan' LIMIT 1`,
      )
      .get() as {
      source_connection_id: Uint8Array;
      identity_epoch_id: Uint8Array;
      transaction_id: Uint8Array;
      source_record_id: Uint8Array;
      capture_id: Uint8Array;
      commit_id: Uint8Array;
    };
    const generationId = Number(
      (
        legacy.db
          .prepare(
            "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
          )
          .get() as { generation_id?: number }
      ).generation_id,
    );
    const resolutionId = Buffer.alloc(16, 201);
    const groupId = Buffer.alloc(16, 202);
    const eventId = Buffer.alloc(16, 203);
    const accountEvidenceId = Buffer.alloc(16, 204);
    legacy.db
      .prepare(
        `INSERT INTO loan_repayment_resolution_runs(
           resolution_id, resolution_key, source_connection_id,
           resolver_version, coverage_state, outcome, reason, observed_at,
           commit_id
         ) VALUES (?, 'legacy-resolution', ?, 'resolver-v1', 'complete',
                   'changed', NULL, '2026-08-31T00:00:00.000Z', ?)`,
      )
      .run(
        resolutionId,
        fubonLoanRow.source_connection_id,
        fubonLoanRow.commit_id,
      );
    legacy.db
      .prepare(
        `INSERT INTO loan_repayment_settlement_groups(
           settlement_group_id, source_connection_id, group_key,
           resolver_version, created_commit_id
         ) VALUES (?, ?, 'legacy-group', 'resolver-v1', ?)`,
      )
      .run(groupId, fubonLoanRow.source_connection_id, fubonLoanRow.commit_id);
    legacy.db
      .prepare(
        `INSERT INTO loan_repayment_settlement_group_members(
           settlement_group_id, transaction_id, member_kind,
           source_record_id, capture_id, commit_id
         ) VALUES (?, ?, 'loan_payment', ?, ?, ?)`,
      )
      .run(
        groupId,
        fubonLoanRow.transaction_id,
        fubonLoanRow.source_record_id,
        fubonLoanRow.capture_id,
        fubonLoanRow.commit_id,
      );
    legacy.db
      .prepare(
        `INSERT INTO loan_repayment_relation_events(
           event_id, resolution_id, settlement_group_id, event_kind,
           support_kind, support_key, evidence_json, commit_id
         ) VALUES (?, ?, ?, 'observed', 'verified-repayment-destination',
                   'legacy-support', '{}', ?)`,
      )
      .run(eventId, resolutionId, groupId, fubonLoanRow.commit_id);
    legacy.db
      .prepare(
        `INSERT INTO current_loan_repayment_settlement_groups(
           generation_id, settlement_group_id, projection_commit_id
         ) VALUES (?, ?, ?)`,
      )
      .run(generationId, groupId, fubonLoanRow.commit_id);
    legacy.db
      .prepare(
        `INSERT INTO transaction_counterparty_account_evidence(
           evidence_id, transaction_id, source_record_id, capture_id,
           source_connection_id, identity_epoch_id, source_value,
           normalized_value, value_digest, role, purpose, scope,
           evidence_kind, source_field, contract_version, created_commit_id
         ) VALUES (?, ?, ?, ?, ?, ?, '1234567890', '1234567890',
                   'sha256:legacy-account', 'beneficiary', 'loan_repayment',
                   'loan_contract', 'transaction-counterparty-account',
                   'beneficiary-account', 'legacy-contract', ?)`,
      )
      .run(
        accountEvidenceId,
        fubonLoanRow.transaction_id,
        fubonLoanRow.source_record_id,
        fubonLoanRow.capture_id,
        fubonLoanRow.source_connection_id,
        fubonLoanRow.identity_epoch_id,
        fubonLoanRow.commit_id,
      );
    const preservedFubonRoute =
      "fubon/foreign-deposit/source-connection-v11-preserved-test";
    legacy.db
      .prepare(
        `INSERT INTO source_authority_routes(
           authority_route, integration_namespace, stream, contract_version,
           created_commit_id
         ) VALUES (?, 'fubon', 'foreign-deposit', 'preserved-contract', ?)`,
      )
      .run(preservedFubonRoute, fubonLoanRow.commit_id);
    legacy.db
      .prepare(
        `INSERT INTO source_route_bindings(
           authority_route, source_connection_id, created_commit_id
         ) VALUES (?, ?, ?)`,
      )
      .run(
        preservedFubonRoute,
        fubonLoanRow.source_connection_id,
        fubonLoanRow.commit_id,
      );
    legacy.db
      .prepare(
        `INSERT INTO counterparty_account_evidence_support(
           evidence_id, source_record_id, capture_id, commit_id
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        accountEvidenceId,
        fubonLoanRow.source_record_id,
        fubonLoanRow.capture_id,
        fubonLoanRow.commit_id,
      );
    const nonCanonicalSentinels = new DatabaseSync(path);
    nonCanonicalSentinels.exec(`
      CREATE TABLE local_credentials_sentinel(name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE automation_settings_sentinel(name TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO local_credentials_sentinel VALUES ('bank-login', 'preserved-outside-canonical-contract');
      INSERT INTO automation_settings_sentinel VALUES ('schedule', 'preserved');
    `);
    nonCanonicalSentinels.close();
    const cathayBefore = namespaceFinancialSnapshot(legacy.db, "cathay");
    const legacyConnectionCount = Number(
      (
        legacy.db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_connections WHERE integration_namespace IN ('fubon','yuanta')",
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    assert.ok(legacyConnectionCount > 0);
    const affectedRouteBindingCount = Number(
      (
        legacy.db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM source_route_bindings binding
               JOIN source_authority_routes route
                 ON route.authority_route = binding.authority_route
               JOIN source_connections connection
                 ON connection.source_connection_id = binding.source_connection_id
              WHERE connection.integration_namespace IN ('fubon','yuanta','yuanta-fund','yuanta-trade')
                AND route.stream IN ('domestic-deposit','loan','credit-card','investment','investment-margin')`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    assert.ok(affectedRouteBindingCount > 0);
    assert.ok(
      Number(
        (
          legacy.db
            .prepare(
              `SELECT COUNT(*) AS count FROM financial_accounts account
                 JOIN source_connections connection
                   ON connection.source_connection_id = account.source_connection_id
                WHERE connection.integration_namespace IN ('fubon','yuanta')
                  AND account.stream IN ('domestic-deposit','loan','credit-card')`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ) >= 6,
    );
    legacy.close();

    const downgrade = new DatabaseSync(path);
    downgrade.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits;
      DELETE FROM canonical_contract_purges;
      DELETE FROM schema_migrations WHERE version > 10;
      PRAGMA user_version = 10;
      PRAGMA foreign_keys = ON;
    `);
    downgrade.close();

    const migrated = createCanonicalSourceStore(path);
    assert.equal(
      queryCanonicalInvestmentCurrent(migrated, investmentConnectionKey)
        .holdings.length,
      0,
    );
    assert.equal(
      queryCanonicalInvestmentHistorical(migrated, investmentConnectionKey, {
        financialAt: "9999-12-31",
        knowledgeAt: Number(
          (migrated.db.prepare("SELECT COALESCE(MAX(commit_sequence),0) AS value FROM canonical_commits").get() as { value?: number }).value ?? 0,
        ),
      })
        .holdings.length,
      0,
    );
    assert.equal(
      queryCanonicalInvestmentLineage(
        migrated,
        investmentConnectionKey,
        investmentMeasurementKey,
      ).holdings.length,
      0,
    );
    assert.equal(
      Number(
        (
          migrated.db
            .prepare(
              "SELECT COUNT(*) AS count FROM investment_holding_observations",
            )
            .get() as { count: number }
        ).count,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          migrated.db
            .prepare(
              `SELECT COUNT(*) AS count FROM source_captures capture
                 JOIN source_connections connection
                   ON connection.source_connection_id = capture.source_connection_id
                WHERE connection.integration_namespace IN ('fubon','yuanta')
                  AND capture.stream IN ('domestic-deposit','loan','credit-card')`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      0,
    );
    for (const table of ["financial_accounts", "source_subjects"] as const) {
      assert.equal(
        Number(
          (
            migrated.db
              .prepare(
                `SELECT COUNT(*) AS count FROM ${table} scoped
                   JOIN source_connections connection
                     ON connection.source_connection_id = scoped.source_connection_id
                  WHERE connection.integration_namespace IN ('fubon','yuanta')
                    AND scoped.stream IN ('domestic-deposit','loan','credit-card')`,
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        0,
        `${table} target scope removed`,
      );
    }
    assert.equal(
      Number(
        (
          migrated.db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM source_route_bindings binding
                 JOIN source_authority_routes route
                   ON route.authority_route = binding.authority_route
                 JOIN source_connections connection
                   ON connection.source_connection_id = binding.source_connection_id
                WHERE connection.integration_namespace IN ('fubon','yuanta')
                  AND route.stream IN ('domestic-deposit','loan','credit-card')`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      0,
      "affected provider/product route bindings are removed",
    );
    assert.equal(
      Number(
        (
          migrated.db
            .prepare(
              `SELECT COUNT(*) AS count FROM source_route_bindings
                WHERE authority_route = ?`,
            )
            .get(preservedFubonRoute) as { count?: number }
        ).count ?? 0,
      ),
      1,
      "an unrelated route on the same connection is preserved",
    );
    for (const table of [
      "transaction_relations",
      "transaction_relation_provenance",
      "loan_repayment_settlement_groups",
      "loan_repayment_settlement_group_members",
      "current_loan_repayment_settlement_groups",
      "current_loan_relations",
      "transaction_counterparty_account_evidence",
      "counterparty_account_evidence_support",
      "loan_repayment_resolution_runs",
      "loan_repayment_relation_events",
    ]) {
      assert.equal(
        Number(
          (
            migrated.db
              .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
              .get() as {
              count?: number;
            }
          ).count ?? 0,
        ),
        0,
        `${table} has no legacy relation closure`,
      );
    }
    assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(
      namespaceFinancialSnapshot(migrated.db, "cathay"),
      cathayBefore,
    );
    assert.deepEqual(
      migrated.db
        .prepare("SELECT * FROM local_credentials_sentinel")
        .all()
        .map((row) => ({ ...row })),
      [
        {
          name: "bank-login",
          value: "preserved-outside-canonical-contract",
        },
      ],
    );
    assert.deepEqual(
      migrated.db
        .prepare("SELECT * FROM automation_settings_sentinel")
        .all()
        .map((row) => ({ ...row })),
      [{ name: "schedule", value: "preserved" }],
    );
    const audit = migrated.db
      .prepare(
        "SELECT deleted_row_count, deleted_table_counts_json, scope_json, closure_fingerprint FROM canonical_contract_purges WHERE purge_id = ?",
      )
      .get("source-connection-identity/v1:fubon-yuanta:v11") as {
      deleted_row_count?: number;
      deleted_table_counts_json?: string;
      scope_json?: string;
      closure_fingerprint?: string;
    };
    assert.ok(Number(audit.deleted_row_count) > 0);
    assert.equal(
      JSON.parse(String(audit.deleted_table_counts_json)).source_route_bindings,
      affectedRouteBindingCount,
      "route binding deletion is represented in the immutable purge audit",
    );
    assert.deepEqual(JSON.parse(String(audit.scope_json)), {
      integrationNamespaces: ["fubon", "yuanta", "yuanta-fund", "yuanta-trade"],
      streams: [
        "domestic-deposit",
        "loan",
        "credit-card",
        "investment",
        "investment-margin",
      ],
    });
    assert.match(String(audit.closure_fingerprint), /^sha256:/);

    // Orphan connection rows are deliberately retained: they carry no
    // financial/source subject selector and let a corrected deterministic key
    // be reused without a UNIQUE collision during recollection.
    assert.equal(
      Number(
        (
          migrated.db
            .prepare(
              "SELECT COUNT(*) AS count FROM source_connections WHERE integration_namespace IN ('fubon','yuanta')",
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      legacyConnectionCount,
    );
    assert.equal(
      queryCanonicalSourceCurrent(migrated).records.some(
        (record) =>
          record.identity.integrationNamespace === "fubon" ||
          record.identity.integrationNamespace === "yuanta",
      ),
      false,
    );

    const correctedConnectionKey =
      LOAN_CONTRACT_FIXTURES.fubon.identity.sourceConnectionKey;
    const corrected = admitCanonicalSourceEvidence({
      ...evidence("post-v11-fubon-recollection"),
      integrationNamespace: "fubon",
      sourceConnectionKey: correctedConnectionKey,
      identityEpoch: token("9"),
      stream: "domestic-deposit",
      recordKind: "fubon-post-v11-recollection",
      routeKey: "fubon/domestic-deposit/source-connection-v1-test",
      contractVersion: "fubon/domestic-deposit/source-connection-v1-test",
      subjectDigest: token("8"),
      records: [
        {
          ...evidence("post-v11-fubon-recollection").records[0]!,
          occurrenceKey: token("6"),
          providerKey: token("5"),
          contentHash: token("4"),
        },
      ],
    });
    await commitCanonicalSourceEvidence(migrated, corrected);
    assert.equal(
      queryCanonicalSourceCurrent(migrated).records.filter(
        (record) => record.identity.integrationNamespace === "fubon",
      ).length,
      1,
    );
    migrated.close();

    const reopened = createCanonicalSourceStore(path);
    assert.equal(
      queryCanonicalSourceCurrent(reopened).records.filter(
        (record) => record.identity.integrationNamespace === "fubon",
      ).length,
      1,
      "v11 recollection survives reopen",
    );
    assert.equal(
      Number(
        (
          reopened.db
            .prepare(
              "SELECT COUNT(*) AS count FROM canonical_contract_purges WHERE purge_id = ?",
            )
            .get("source-connection-identity/v1:fubon-yuanta:v11") as {
            count?: number;
          }
        ).count ?? 0,
      ),
      1,
      "reopen does not repeat the migration",
    );
    assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
    validateCanonicalSourceStore(reopened);
    reopened.close();

  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration purges legacy card scopes and only the v1 Fubon deposit occurrence scope", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v12-credit-card-purge-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    await commitCathayDomesticDeposit(
      directory,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );
    const legacy = createCanonicalSourceStore(path);
    await commitCanonicalFinancialDepositCapture(
      legacy,
      admitCanonicalFinancialDepositCapture(
        fubonCreditCardFinancialCapture("v2", "v12-legacy-fubon-card"),
      ),
    );
    await commitCanonicalFinancialDepositCapture(
      legacy,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v2", "v12-legacy-yuanta-card"),
      ),
    );

    // Both sibling captures deliberately reuse the same provider connection
    // key as the legacy card capture. The v12 scope must remove only the
    // credit-card children and leave these source-only records available.
    const preservedFubon = {
      ...evidence("v12-preserved-fubon-deposit"),
      integrationNamespace: "fubon",
      sourceConnectionKey: token("j"),
      identityEpoch: token("1"),
      stream: "domestic-deposit",
      recordKind: "fubon-preserved-domestic-deposit",
      routeKey: "fubon/domestic-deposit/preserved-v12-test",
      subjectDigest: token("2"),
    };
    const preservedYuanta = {
      ...evidence("v12-preserved-yuanta-deposit"),
      integrationNamespace: "yuanta",
      sourceConnectionKey: token("y"),
      identityEpoch: token("3"),
      stream: "domestic-deposit",
      recordKind: "yuanta-preserved-domestic-deposit",
      routeKey: "yuanta/domestic-deposit/preserved-v12-test",
      subjectDigest: token("4"),
    };
    await commitCanonicalSourceEvidence(
      legacy,
      admitCanonicalSourceEvidence(preservedFubon),
    );
    await commitCanonicalSourceEvidence(
      legacy,
      admitCanonicalSourceEvidence(preservedYuanta),
    );

    // Include provider extension rows as well as the shared canonical rows so
    // the migration proves the exact dependent closure, not just its roots.
    seedFubonCardExtensionSentinel(legacy.db, "v12-legacy-fubon-card", 41);
    seedYuantaCardExtensionSentinel(legacy.db, "v12-legacy-yuanta-card", 42);
    const connectionCount = Number(
      (
        legacy.db
          .prepare(
            `SELECT COUNT(*) AS count FROM source_connections
              WHERE integration_namespace IN ('fubon', 'yuanta')`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    const preservedCaptureKeys = [
      "v12-preserved-fubon-deposit",
      "v12-preserved-yuanta-deposit",
    ];
    const preservedBefore = legacy.db
      .prepare(
        `SELECT capture_key, stream, integration_namespace
           FROM source_captures capture
           JOIN source_connections connection
             ON connection.source_connection_id = capture.source_connection_id
          WHERE capture.capture_key IN (?, ?)
          ORDER BY capture_key`,
      )
      .all(...preservedCaptureKeys) as Array<Record<string, unknown>>;
    assert.equal(preservedBefore.length, 2);
    legacy.close();

    // Model the exact historical v11 boundary: v11 already completed its
    // source-connection purge, then a card recollection happened under the
    // wrapped product key. Its audit table still has the old v11-only CHECK.
    const historical = new DatabaseSync(path);
    historical.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'credit-card-source-connection/v1:fubon-yuanta:v12';
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'fubon-domestic-deposit/observed-composite-v1:v14';
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/market-evidence-v2:v17';
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'credit-card-source-connection/v1:fubon-yuanta:v12';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'fubon-domestic-deposit/observed-composite-v1:v14';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/market-evidence-v2:v17';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM schema_migrations WHERE version >= 12;
      ALTER TABLE canonical_contract_purge_commits
        RENAME TO canonical_contract_purge_commits_v12;
      ALTER TABLE canonical_contract_purges
        RENAME TO canonical_contract_purges_v12;
      CREATE TABLE canonical_contract_purges (
        purge_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 11),
        reason TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
        deleted_table_counts_json TEXT NOT NULL,
        closure_fingerprint TEXT NOT NULL,
        applied_at_utc_us INTEGER NOT NULL
      );
      INSERT INTO canonical_contract_purges(
        purge_id, schema_version, reason, scope_json, deleted_row_count,
        deleted_table_counts_json, closure_fingerprint, applied_at_utc_us
      )
      SELECT purge_id, schema_version, reason, scope_json, deleted_row_count,
             deleted_table_counts_json, closure_fingerprint, applied_at_utc_us
        FROM canonical_contract_purges_v12;
      CREATE TABLE canonical_contract_purge_commits (
        purge_id TEXT NOT NULL REFERENCES canonical_contract_purges(purge_id),
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        PRIMARY KEY(purge_id, commit_id)
      );
      INSERT INTO canonical_contract_purge_commits(purge_id, commit_id)
        SELECT purge_id, commit_id FROM canonical_contract_purge_commits_v12;
      DROP TABLE canonical_contract_purge_commits_v12;
      DROP TABLE canonical_contract_purges_v12;
      PRAGMA user_version = 11;
      PRAGMA foreign_keys = ON;
    `);
    historical.close();

    const migrated = openCanonicalDatabase(directory);
    let migratedClosed = false;
    try {
      assert.equal(
        Number(
          (
            migrated.prepare("PRAGMA user_version").get() as {
              user_version?: number;
            }
          ).user_version,
        ),
        CANONICAL_SOURCE_SCHEMA_VERSION,
      );
      assert.equal(
        Number(
          (
            migrated
              .prepare(
                `SELECT COUNT(*) AS count FROM source_captures capture
                   JOIN source_connections connection
                     ON connection.source_connection_id = capture.source_connection_id
                  WHERE connection.integration_namespace IN ('fubon', 'yuanta')
                    AND capture.stream = 'credit-card'`,
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        0,
      );
      assert.deepEqual(
        migrated
          .prepare(
            `SELECT capture_key, stream, integration_namespace
               FROM source_captures capture
               JOIN source_connections connection
                 ON connection.source_connection_id = capture.source_connection_id
              WHERE capture.capture_key IN (?, ?)
              ORDER BY capture_key`,
          )
          .all(...preservedCaptureKeys),
        preservedBefore.filter((row) => row.integration_namespace === "yuanta"),
      );
      assert.equal(
        Number(
          (
            migrated
              .prepare(
                `SELECT COUNT(*) AS count FROM source_connections
                  WHERE integration_namespace IN ('fubon', 'yuanta')`,
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        connectionCount,
        "shared Source Connection parents remain available",
      );
      for (const table of [
        "fubon_credit_instrument_details",
        "fubon_credit_account_identity_details",
        "fubon_credit_transaction_details",
        "canonical_credit_card_account_identities",
        "canonical_credit_card_instruments",
        "canonical_credit_card_instrument_evidence",
        "canonical_credit_card_transaction_details",
        "canonical_credit_card_transaction_lifecycle",
      ])
        assert.equal(
          Number(
            (
              migrated
                .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
                .get() as {
                count?: number;
              }
            ).count ?? 0,
          ),
          0,
          `${table} card closure is removed`,
        );
      assert.equal(
        Number(
          (
            migrated
              .prepare(
                `SELECT COUNT(*) AS count FROM canonical_contract_purges
                  WHERE purge_id = 'credit-card-source-connection/v1:fubon-yuanta:v12'`,
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
      );
      const audit = migrated
        .prepare(
          `SELECT schema_version, deleted_row_count,
                  deleted_table_counts_json, scope_json, closure_fingerprint
             FROM canonical_contract_purges
            WHERE purge_id = 'credit-card-source-connection/v1:fubon-yuanta:v12'`,
        )
        .get() as {
        schema_version?: number;
        deleted_row_count?: number;
        deleted_table_counts_json?: string;
        scope_json?: string;
        closure_fingerprint?: string;
      };
      assert.equal(audit.schema_version, 12);
      assert.ok(Number(audit.deleted_row_count) > 0);
      const deletedCounts = JSON.parse(String(audit.deleted_table_counts_json));
      assert.ok(Number(deletedCounts.fubon_credit_instrument_details) > 0);
      const fubonDepositAudit = migrated
        .prepare(
          `SELECT schema_version, scope_json, closure_fingerprint
             FROM canonical_contract_purges
            WHERE purge_id = 'fubon-domestic-deposit/observed-composite-v1:v14'`,
        )
        .get() as {
        schema_version?: number;
        scope_json?: string;
        closure_fingerprint?: string;
      };
      assert.equal(fubonDepositAudit.schema_version, 14);
      assert.deepEqual(JSON.parse(String(fubonDepositAudit.scope_json)), {
        integrationNamespaces: ["fubon"],
        streams: ["domestic-deposit"],
      });
      assert.match(
        String(fubonDepositAudit.closure_fingerprint),
        /^sha256:[A-Za-z0-9_-]+$/u,
      );
      assert.ok(Number(deletedCounts.canonical_credit_card_instruments) > 0);
      assert.deepEqual(JSON.parse(String(audit.scope_json)), {
        integrationNamespaces: ["fubon", "yuanta"],
        streams: ["credit-card"],
      });
      assert.match(String(audit.closure_fingerprint), /^sha256:/);
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);

      // A corrected recollection can reuse the retained connection parent and
      // remains durable across the v12 reopen boundary.
      migrated.close();
      migratedClosed = true;
      const recollected = createCanonicalSourceStore(path);
      await commitCanonicalFinancialDepositCapture(
        recollected,
        admitCanonicalFinancialDepositCapture(
          fubonCreditCardFinancialCapture("v2", "v12-new-fubon-card"),
        ),
      );
      assert.equal(
        recollected.db
          .prepare(
            `SELECT source_connection.source_connection_key
               FROM source_captures capture
               JOIN source_connections source_connection
                 ON source_connection.source_connection_id = capture.source_connection_id
              WHERE capture.capture_key = ?`,
          )
          .get("v12-new-fubon-card")?.source_connection_key,
        token("j"),
      );
      recollected.close();
    } finally {
      if (!migratedClosed) migrated.close();
    }

    const reopened = openCanonicalDatabase(directory);
    try {
      assert.equal(
        Number(
          (
            reopened.prepare("PRAGMA user_version").get() as {
              user_version?: number;
            }
          ).user_version,
        ),
        CANONICAL_SOURCE_SCHEMA_VERSION,
      );
      assert.equal(
        Number(
          (
            reopened
              .prepare(
                `SELECT COUNT(*) AS count FROM source_captures
                  WHERE capture_key = 'v12-new-fubon-card'`,
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
      );
      assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
      // The read-only lifecycle handle above is the validated database seam;
      // source-store validation is covered with createCanonicalSourceStore.
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v11 to v12 rolls back the credit-card purge when canonical schema validation fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v12-credit-card-rollback-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    const legacy = createCanonicalSourceStore(path);
    await commitCanonicalFinancialDepositCapture(
      legacy,
      admitCanonicalFinancialDepositCapture(
        fubonCreditCardFinancialCapture("v2", "v12-rollback-fubon-card"),
      ),
    );
    seedFubonCardExtensionSentinel(legacy.db, "v12-rollback-fubon-card", 51);
    legacy.close();

    const historical = new DatabaseSync(path);
    historical.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'credit-card-source-connection/v1:fubon-yuanta:v12';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'credit-card-source-connection/v1:fubon-yuanta:v12';
      DELETE FROM schema_migrations WHERE version = 12;
      ALTER TABLE transaction_relations DROP COLUMN from_identity_epoch_id;
      PRAGMA user_version = 11;
      PRAGMA foreign_keys = ON;
    `);
    historical.close();

    assert.throws(
      () => openCanonicalDatabase(directory),
      /Canonical schema v10 relation column from_identity_epoch_id is missing/,
    );

    const afterFailure = new DatabaseSync(path);
    try {
      assert.equal(
        Number(
          (
            afterFailure.prepare("PRAGMA user_version").get() as {
              user_version?: number;
            }
          ).user_version,
        ),
        11,
      );
      assert.equal(
        Number(
          (
            afterFailure
              .prepare(
                `SELECT COUNT(*) AS count FROM source_captures
                   WHERE capture_key = 'v12-rollback-fubon-card'`,
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            afterFailure
              .prepare(
                "SELECT COUNT(*) AS count FROM fubon_credit_instrument_details",
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            afterFailure
              .prepare(
                `SELECT COUNT(*) AS count FROM canonical_contract_purges
                  WHERE purge_id = 'credit-card-source-connection/v1:fubon-yuanta:v12'`,
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            afterFailure.prepare("PRAGMA foreign_keys").get() as {
              foreign_keys?: number;
            }
          ).foreign_keys,
        ),
        1,
      );
    } finally {
      afterFailure.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v16 to v17 purges only legacy Yuanta trade investment scope and allows live recollection", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v17-yuanta-trade-purge-"),
  );
  const path = join(directory, "canonical.sqlite");
  const tradeConnectionKey = token("v17-yuanta-trade-connection");
  const tradeEpochKey = token("v17-yuanta-trade-epoch");
  const tradeAccountKey = token("v17-yuanta-trade-account");
  const tradeHoldingRecordKey = token("v17-yuanta-trade-holding");
  const tradeRecordKey = token("v17-yuanta-trade-record");
  const tradeCapture = buildYuantaInvestmentCapture({
    sourceId: "yuanta-trade",
    captureId: "legacy-yuanta-trade",
    sourceConnectionKey: tradeConnectionKey,
    identityEpochKey: tradeEpochKey,
    accountKey: tradeAccountKey,
    reportingCurrency: "TWD",
    observedAt: "2026-08-31T12:00:00.000Z",
    sourceEffectiveOn: "2026-08-30",
    holdings: [
      {
        sourceRecordKey: tradeHoldingRecordKey,
        producerSecurityId: "NYSE:NET",
        securityName: "CLOUD NETWORK",
        ticker: "NET",
        currency: "USD",
        effectiveOn: "2026-08-30",
        quantity: { coefficient: "1", scale: 0 },
      },
    ],
    transactions: [
      {
        sourceRecordKey: tradeRecordKey,
        producerSecurityId: "NYSE:NET",
        securityName: "CLOUD NETWORK",
        ticker: "NET",
        currency: "USD",
        effectiveOn: "2026-08-30",
        action: "buy",
        quantity: { coefficient: "1", scale: 0 },
        cashEffect: { coefficient: "10000", scale: 2, currency: "USD" },
      },
    ],
  });
  const fundCapture = buildYuantaInvestmentCapture({
    sourceId: "yuanta-fund",
    captureId: "preserved-yuanta-fund",
    sourceConnectionKey: token("v17-yuanta-fund-connection"),
    identityEpochKey: token("v17-yuanta-fund-epoch"),
    accountKey: token("v17-yuanta-fund-account"),
    reportingCurrency: "TWD",
    observedAt: "2026-08-31T12:00:00.000Z",
    sourceEffectiveOn: "2026-08-30",
    holdings: [
      {
        sourceRecordKey: token("v17-yuanta-fund-holding"),
        producerSecurityId: "FUND-001",
        currency: "TWD",
        effectiveOn: "2026-08-30",
        quantity: { coefficient: "10", scale: 0 },
      },
    ],
    transactions: [],
  });
  try {
    await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const legacy = createCanonicalSourceStore(path);
    await commitCanonicalInvestmentCapture(
      legacy,
      admitCanonicalInvestmentCapture(tradeCapture),
    );
    await commitCanonicalInvestmentCapture(
      legacy,
      admitCanonicalInvestmentCapture(fundCapture),
    );
    const legacyMarketV1FundingEvidence = {
      kind: "source-settlement-contract",
      sourceRecordKey: tradeRecordKey,
      sourceLinkageKey: token("v16-yuanta-legacy-linkage"),
      linkageContractVersion:
        YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
      settlementMarketContractVersion: "yuanta/foreign-settlement/market-v1",
      settlementModel: "account-currency-date-net",
      contractVersion: "yuanta/foreign-settlement/human-attested-v1",
    } as const;
    // This is a controlled historical fixture: v1 had no source MarketNo,
    // so it cannot be constructed through today's stricter admission API.
    const legacyFundingEvidenceJson = JSON.stringify(
      legacyMarketV1FundingEvidence,
    );
    legacy.db
      .prepare(
        `UPDATE investment_transactions
            SET funding_evidence_json=?
          WHERE capture_id=(SELECT capture_id FROM source_captures WHERE capture_key=?)`,
      )
      .run(legacyFundingEvidenceJson, "legacy-yuanta-trade");
    const legacySourceRows = legacy.db
      .prepare(
        `SELECT source_record_id AS sourceRecordId, payload_json AS payloadJson
           FROM source_records
          WHERE capture_id=(SELECT capture_id FROM source_captures WHERE capture_key=?)`,
      )
      .all("legacy-yuanta-trade") as Array<{
      sourceRecordId: Uint8Array;
      payloadJson: string;
    }>;
    let legacyTransactionPayloadCount = 0;
    for (const row of legacySourceRows) {
      const payload = JSON.parse(row.payloadJson) as {
        kind?: string;
        fundingEvidence?: unknown;
      };
      if (payload.kind !== "investment-transaction") continue;
      payload.fundingEvidence = legacyMarketV1FundingEvidence;
      legacy.db
        .prepare(
          "UPDATE source_records SET payload_json=? WHERE source_record_id=?",
        )
        .run(JSON.stringify(payload), row.sourceRecordId);
      legacyTransactionPayloadCount += 1;
    }
    assert.equal(legacyTransactionPayloadCount, 1);
    assert.deepEqual(
      JSON.parse(
        (
          legacy.db
            .prepare(
              `SELECT funding_evidence_json AS fundingEvidenceJson
                 FROM investment_transactions
                WHERE capture_id=(SELECT capture_id FROM source_captures WHERE capture_key=?)`,
            )
            .get("legacy-yuanta-trade") as { fundingEvidenceJson: string }
        ).fundingEvidenceJson,
      ),
      legacyMarketV1FundingEvidence,
    );
    assert.deepEqual(
      JSON.parse(
        (
          legacy.db
            .prepare(
              `SELECT payload_json AS payloadJson
                 FROM source_records
                WHERE capture_id=(SELECT capture_id FROM source_captures WHERE capture_key=?)
                  AND json_extract(payload_json, '$.kind')='investment-transaction'`,
            )
            .get("legacy-yuanta-trade") as { payloadJson: string }
        ).payloadJson,
      ).fundingEvidence,
      legacyMarketV1FundingEvidence,
    );
    const countCaptures = (db: DatabaseSync, namespace: string, stream: string) =>
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM source_captures capture
                 JOIN source_connections connection
                   ON connection.source_connection_id = capture.source_connection_id
                WHERE connection.integration_namespace = ?
                  AND capture.stream = ?`,
            )
            .get(namespace, stream) as { count?: number }
        ).count ?? 0,
      );
    const cathayCaptureCount = countCaptures(
      legacy.db,
      "cathay",
      "domestic-deposit",
    );
    assert.equal(countCaptures(legacy.db, "yuanta-trade", "investment"), 1);
    assert.equal(countCaptures(legacy.db, "yuanta-fund", "investment"), 1);
    assert.ok(cathayCaptureCount > 0);
    legacy.close();

    // Reconstruct a v16 database before the market-v2 migration existed.
    const historical = new DatabaseSync(path);
    historical.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/market-evidence-v2:v17';
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/market-evidence-v2:v17';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM schema_migrations WHERE version > 16;
      DELETE FROM schema_migrations WHERE version = 17;
      ALTER TABLE canonical_contract_purge_commits
        RENAME TO canonical_contract_purge_commits_v16;
      ALTER TABLE canonical_contract_purges
        RENAME TO canonical_contract_purges_v16;
      CREATE TABLE canonical_contract_purges (
        purge_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version IN (11, 12, 14)),
        reason TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
        deleted_table_counts_json TEXT NOT NULL,
        closure_fingerprint TEXT NOT NULL,
        applied_at_utc_us INTEGER NOT NULL
      );
      INSERT INTO canonical_contract_purges
        SELECT * FROM canonical_contract_purges_v16;
      CREATE TABLE canonical_contract_purge_commits (
        purge_id TEXT NOT NULL REFERENCES canonical_contract_purges(purge_id),
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        PRIMARY KEY(purge_id, commit_id)
      );
      INSERT INTO canonical_contract_purge_commits
        SELECT * FROM canonical_contract_purge_commits_v16;
      DROP TABLE canonical_contract_purge_commits_v16;
      DROP TABLE canonical_contract_purges_v16;
      PRAGMA user_version = 16;
      PRAGMA foreign_keys = ON;
    `);
    historical.close();

    const migrated = createCanonicalSourceStore(path);
    assert.equal(
      Number(
        (migrated.db.prepare("PRAGMA user_version").get() as { user_version?: number })
          .user_version,
      ),
      20,
    );
    assert.equal(countCaptures(migrated.db, "yuanta-trade", "investment"), 0);
    assert.equal(
      Number(
        (
          migrated.db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM investment_transactions transaction_row
                 JOIN source_connections connection
                   ON connection.source_connection_id = (
                     SELECT account.source_connection_id
                       FROM investment_accounts account
                      WHERE account.account_id = transaction_row.account_id
                   )
                WHERE connection.integration_namespace = 'yuanta-trade'`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          migrated.db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM source_captures capture
                 JOIN source_connections connection
                   ON connection.source_connection_id = capture.source_connection_id
                WHERE connection.integration_namespace = 'yuanta-fund'
                  AND capture.stream = 'investment'`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    assert.equal(
      countCaptures(migrated.db, "cathay", "domestic-deposit"),
      cathayCaptureCount,
    );
    const audit = migrated.db
      .prepare(
        `SELECT deleted_row_count, scope_json, closure_fingerprint
           FROM canonical_contract_purges
          WHERE purge_id = 'yuanta-trade-investment/market-evidence-v2:v17'`,
      )
      .get() as {
      deleted_row_count?: number;
      scope_json?: string;
      closure_fingerprint?: string;
    };
    assert.ok(Number(audit.deleted_row_count) > 0);
    assert.deepEqual(JSON.parse(String(audit.scope_json)), {
      integrationNamespaces: ["yuanta-trade"],
      streams: ["investment"],
    });
    assert.match(String(audit.closure_fingerprint), /^sha256:/);
    const liveCapture = buildYuantaInvestmentCapture({
        sourceId: "yuanta-trade",
        captureId: "legacy-yuanta-trade",
        sourceConnectionKey: tradeConnectionKey,
        identityEpochKey: tradeEpochKey,
        accountKey: tradeAccountKey,
        reportingCurrency: "TWD",
        observedAt: "2026-08-31T12:00:00.000Z",
        sourceEffectiveOn: "2026-08-30",
        holdings: tradeCapture.holdings.map((holding) => ({
          sourceRecordKey: holding.sourceRecordKey,
          producerSecurityId: "NYSE:NET",
          securityName: "CLOUD NETWORK",
          ticker: "NET",
          currency: "USD",
          effectiveOn: "2026-08-30",
          quantity: { coefficient: "1", scale: 0 },
        })),
        transactions: [
          {
            sourceRecordKey: tradeRecordKey,
            producerSecurityId: "NYSE:NET",
            securityName: "CLOUD NETWORK",
            ticker: "NET",
            currency: "USD",
            effectiveOn: "2026-08-30",
            action: "buy" as const,
            quantity: { coefficient: "1", scale: 0 },
            cashEffect: { coefficient: "10000", scale: 2, currency: "USD" },
            fundingEvidence: {
              kind: "source-settlement-contract" as const,
              sourceRecordKey: tradeRecordKey,
              sourceLinkageKey: token("v17-yuanta-live-linkage"),
              linkageContractVersion:
                YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
              sourceMarketCode: "52" as const,
              settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
              settlementMarketContractVersion:
                YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
              settlementModel: "account-currency-date-net" as const,
              contractVersion:
                "yuanta/foreign-settlement/human-attested-v1" as const,
            },
          },
        ],
    });
    await commitCanonicalInvestmentCapture(
      migrated,
      admitCanonicalInvestmentCapture(liveCapture),
    );
    const retained = queryCanonicalSourceCurrent(migrated).records.find(
      (record) => record.compact.kind === "investment-transaction",
    );
    assert.equal(
      (retained?.compact.fundingEvidence as { sourceMarketCode?: string })
        ?.sourceMarketCode,
      "52",
    );
    assert.equal(
      (retained?.compact.fundingEvidence as {
        settlementMarketContractVersion?: string;
      })?.settlementMarketContractVersion,
      YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
    );
    migrated.close();

    const reopened = createCanonicalSourceStore(path);
    assert.equal(
      Number(
        (
          reopened.db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM source_captures capture
                 JOIN source_connections connection
                   ON connection.source_connection_id = capture.source_connection_id
                WHERE connection.integration_namespace = 'yuanta-trade'
                  AND capture.stream = 'investment'`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          reopened.db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM canonical_contract_purges
                WHERE purge_id = 'yuanta-trade-investment/market-evidence-v2:v17'`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
    validateCanonicalSourceStore(reopened);
    reopened.close();

    // The production boundary: a v18 database contains a live trade capture
    // written before source-content-v3. Upgrade must remove just that scope.
    const v18 = new DatabaseSync(path);
    v18.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM schema_migrations WHERE version > 18;
      PRAGMA user_version = 18;
      PRAGMA foreign_keys = ON;
    `);
    v18.close();
    const v19 = createCanonicalSourceStore(path);
    assert.equal(countCaptures(v19.db, "yuanta-trade", "investment"), 0);
    assert.equal(countCaptures(v19.db, "yuanta-fund", "investment"), 1);
    const v19Audit = v19.db
      .prepare(
        `SELECT schema_version, deleted_row_count, scope_json, closure_fingerprint
           FROM canonical_contract_purges
          WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19'`,
      )
      .get() as {
      schema_version?: number;
      deleted_row_count?: number;
      scope_json?: string;
      closure_fingerprint?: string;
    };
    assert.equal(Number(v19Audit.schema_version), 19);
    assert.ok(Number(v19Audit.deleted_row_count) > 0);
    assert.deepEqual(JSON.parse(String(v19Audit.scope_json)), {
      integrationNamespaces: ["yuanta-trade"],
      streams: ["investment"],
    });
    assert.match(String(v19Audit.closure_fingerprint), /^sha256:/);
    assert.deepEqual(v19.db.prepare("PRAGMA foreign_key_check").all(), []);
    validateCanonicalSourceStore(v19);
    v19.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const directory = await mkdtemp(join(tmpdir(), "canonical-source-v8-"));
try {
  const path = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(path);
  validateCanonicalSourceStore(store);
  assert.equal(
    Number(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        }
      ).user_version,
    ),
    CANONICAL_SOURCE_SCHEMA_VERSION,
  );
  await assert.rejects(
    () =>
      commitCanonicalSourceEvidence(
        store,
        evidence(
          "capture-unbranded",
        ) as unknown as CanonicalValidatedSourceEvidence,
      ),
    /runtime|validated|admission/i,
  );

  const first = await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(evidence("capture-1")),
  );
  assert.equal(first.status, "durable-source-evidence");
  const repeat = await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(evidence("capture-2")),
  );
  assert.equal(repeat.status, "durable-source-evidence");
  const current = queryCanonicalSourceCurrent(store);
  assert.equal(current.records.length, 1);
  assert.equal(current.observations.length, 2);
  assert.deepEqual(
    current.observations.map((observation) => observation.captureId),
    ["capture-1", "capture-2"],
  );
  const historical = queryCanonicalSourceHistorical(store, { knowledgeAt: 2 });
  assert.equal(historical.observations.length, 2);
  assert.throws(
    () => queryCanonicalSourceHistorical(store, { effectiveAt: "20260101" }),
    /effective|financial/i,
  );
  const lineage = queryCanonicalSourceLineage(store, lineageRequest);
  assert.equal(lineage.observations.length, 2);
  assert.equal(lineage.provenance.length, 2);
  assert.equal(JSON.stringify(current).includes("rawResponse"), false);
  assert.equal(JSON.stringify(current).includes("headers"), false);
  for (const table of [
    "financial_accounts",
    "financial_transactions",
    "transaction_revisions",
    "assertions",
    "source_sync_states",
    "current_transactions",
  ]) {
    assert.equal(
      (
        store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
          value?: number;
        }
      ).value,
      0,
      `${table} remains untouched by source-only evidence`,
    );
  }
  assert.equal(
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS value FROM sqlite_master WHERE name LIKE 'canonical_source_%'",
        )
        .get() as { value?: number }
    ).value,
    0,
  );

  await assert.rejects(
    () =>
      commitCanonicalSourceEvidence(
        store,
        admitCanonicalSourceEvidence({
          ...evidence("capture-conflict"),
          records: [
            {
              ...evidence("capture-conflict").records[0]!,
              providerKey: token("9"),
            },
          ],
        }),
      ),
    /conflict|overwrite/i,
  );
  assert.equal(queryCanonicalSourceCurrent(store).observations.length, 2);
  await assert.rejects(
    () =>
      commitCanonicalSourceEvidence(
        store,
        admitCanonicalSourceEvidence({
          ...evidence("capture-collision"),
          records: [
            {
              ...evidence("capture-collision").records[0]!,
              occurrenceKey: token("8"),
            },
          ],
        }),
      ),
    /collision|conflict|overwrite/i,
  );
  assert.equal(queryCanonicalSourceCurrent(store).observations.length, 2);
  store.close();

  const reopened = createCanonicalSourceStore(path);
  assert.equal(queryCanonicalSourceCurrent(reopened).observations.length, 2);
  reopened.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

const localSecondDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-cathay-local-second-"),
);
try {
  const localSecondRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse
    .replace('"startDate":"2025-08-17"', '"startDate":"2025-08-17T00:00:00"')
    .replace('"endDate":"2026-08-17"', '"endDate":"2026-08-17T23:59:59"')
    .replace(
      '"accountDate":"2026-07-01"',
      '"accountDate":"2026-07-01T00:00:01"',
    )
    .replace(
      '"accountDate":"2026-07-02"',
      '"accountDate":"2026-07-02T12:34:56"',
    )
    .replace(
      '"accountDate":"2026-07-03"',
      '"accountDate":"2026-07-03T23:59:59"',
    );
  const committed = await commitCathayDomesticDeposit(localSecondDirectory, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    rawResponse: localSecondRaw,
  });
  const query = createCathayCanonicalFinancialQuery(localSecondDirectory);
  const current = await query.current({ kind: "current" });
  assert.equal(current.transactions.length, 3);
  assert.deepEqual(
    current.transactions.map((transaction) => transaction.effectiveOn).sort(),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  const historical = await query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(committed.commitSequence),
    },
  });
  assert.deepEqual(
    historical.transactions
      .map((transaction) => transaction.effectiveOn)
      .sort(),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  const lineage = await query.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: current.transactions[0]!.id },
  });
  assert.equal(lineage.entries.length, 1);
  assert.equal(lineage.entries[0]?.revision.effectiveOn, "2026-07-01");
  const reopened = await createCathayCanonicalFinancialQuery(
    localSecondDirectory,
  ).current({ kind: "current" });
  assert.deepEqual(
    reopened.transactions.map((transaction) => transaction.effectiveOn).sort(),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  const db = openCanonicalDatabase(localSecondDirectory, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT response_digest FROM capture_scope_pages").get()
        ?.response_digest,
      createHash("sha256").update(localSecondRaw, "utf8").digest("hex"),
    );
    const sourcePayload = String(
      db
        .prepare(
          "SELECT payload_json FROM source_records ORDER BY sequence_lexeme LIMIT 1",
        )
        .get()?.payload_json,
    );
    assert.match(sourcePayload, /2026-07-01T00:00:01/);
    assert.doesNotMatch(sourcePayload, /private-account-date/);
    const revisionRows = (
      db
        .prepare(
          "SELECT effective_on, transaction_date_time_local FROM transaction_revisions ORDER BY effective_on",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      effective_on: row.effective_on,
      transaction_date_time_local: row.transaction_date_time_local,
    }));
    assert.deepEqual(revisionRows, [
      {
        effective_on: "2026-07-01",
        transaction_date_time_local: "2026-07-01T09:00:00",
      },
      {
        effective_on: "2026-07-02",
        transaction_date_time_local: "2026-07-02T10:15:30",
      },
      {
        effective_on: "2026-07-03",
        transaction_date_time_local: "2026-07-03T11:45:00",
      },
    ]);
  } finally {
    db.close();
  }
} finally {
  await rm(localSecondDirectory, { recursive: true, force: true });
}

for (const [label, startDateValue] of [
  ["local-second-prefix-mismatch", "2025-08-18T00:00:00"],
  ["datetime-minute", "2025-08-17T00:00"],
  ["datetime-invalid-hour", "2025-08-17T24:00:00"],
  ["datetime-invalid-minute", "2025-08-17T23:60:00"],
  ["datetime-invalid-second", "2025-08-17T23:59:60"],
  ["datetime-fractional", "2025-08-17T00:00:00.000+08:00"],
  ["datetime-z", "2025-08-17T00:00:00Z"],
  ["datetime-offset", "2025-08-17T00:00:00+08:00"],
  ["datetime-space", "2025-08-17 00:00:00"],
  ["datetime-garbage", "2025-08-17Tgarbage"],
  ["datetime-short", "2025-08-17T00"],
  ["invalid-calendar", "2025-02-30T00:00:00+08:00"],
  ["compact", "20250817"],
  ["slash", "2025/08/17"],
  ["other", "private-date-shape"],
] as const) {
  const rejectedDirectory = await mkdtemp(
    join(tmpdir(), `canonical-source-cathay-datetime-${label}-`),
  );
  try {
    const rejectedStore = createCanonicalSourceStore(
      join(rejectedDirectory, "canonical.sqlite"),
    );
    rejectedStore.close();
    const rejectedRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
      '"startDate":"2025-08-17"',
      `"startDate":"${startDateValue}"`,
    );
    assert.throws(
      () =>
        commitCathayDomesticDeposit(rejectedDirectory, {
          ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
          rawResponse: rejectedRaw,
        }),
      /response date scope|YYYY-MM-DD|valid calendar date/i,
    );
    const rejectedDb = openCanonicalDatabase(rejectedDirectory, {
      readOnly: true,
    });
    try {
      assert.equal(
        rejectedDb
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get()?.count,
        0,
      );
      assert.equal(
        rejectedDb
          .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
          .get()?.count,
        0,
      );
    } finally {
      rejectedDb.close();
    }
  } finally {
    await rm(rejectedDirectory, { recursive: true, force: true });
  }
}

for (const [label, accountDateValue] of [
  ["account-datetime-invalid-hour", "2026-07-01T24:00:00"],
  ["account-datetime-invalid-minute", "2026-07-01T23:60:00"],
  ["account-datetime-invalid-second", "2026-07-01T23:59:60"],
  ["account-datetime-malformed", "2026-07-01Tgarbage"],
  ["account-datetime-minute", "2026-07-01T00:00"],
  ["account-datetime-fractional", "2026-07-01T00:00:00.000"],
  ["account-datetime-z", "2026-07-01T00:00:00Z"],
  ["account-datetime-offset", "2026-07-01T00:00:00+08:00"],
  ["account-datetime-space", "2026-07-01 00:00:00"],
  ["account-datetime-invalid-calendar", "2026-02-30T00:00:00"],
  ["account-invalid-calendar", "2026-02-30"],
  ["account-compact", "20260701"],
  ["account-slash", "2026/07/01"],
] as const) {
  const rejectedDirectory = await mkdtemp(
    join(tmpdir(), `canonical-source-cathay-account-date-${label}-`),
  );
  try {
    const rejectedStore = createCanonicalSourceStore(
      join(rejectedDirectory, "canonical.sqlite"),
    );
    rejectedStore.close();
    const rejectedRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
      '"accountDate":"2026-07-01"',
      `"accountDate":"${accountDateValue}"`,
    );
    assert.throws(
      () =>
        commitCathayDomesticDeposit(rejectedDirectory, {
          ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
          rawResponse: rejectedRaw,
        }),
      /accountDate|YYYY-MM-DD|valid calendar date/i,
    );
    const rejectedDb = openCanonicalDatabase(rejectedDirectory, {
      readOnly: true,
    });
    try {
      for (const table of [
        "canonical_commits",
        "source_captures",
        "financial_transactions",
        "transaction_revisions",
      ]) {
        assert.equal(
          rejectedDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count,
          0,
          `${table} remains empty after rejected accountDate`,
        );
      }
    } finally {
      rejectedDb.close();
    }
  } finally {
    await rm(rejectedDirectory, { recursive: true, force: true });
  }
}

const fenceDirectory = await mkdtemp(join(tmpdir(), "canonical-source-fence-"));
try {
  let clock = 2_000_000;
  const path = join(fenceDirectory, "canonical.sqlite");
  const store = createCanonicalSourceStore(path, {
    commitClock: () => clock--,
  });
  await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(evidence("fence-base")),
  );
  for (const [captureId, overrides] of [
    ["fence-connection", { sourceConnectionKey: token("1") }],
    ["fence-epoch", { identityEpoch: token("2") }],
    ["fence-subject", { subjectDigest: token("3") }],
  ] as const) {
    await commitCanonicalSourceEvidence(
      store,
      admitCanonicalSourceEvidence({
        ...evidence(captureId),
        ...overrides,
        records: [
          {
            ...evidence(captureId).records[0]!,
            providerKey: token(captureId.at(-1) ?? "4"),
            contentHash: token(captureId.at(-2) ?? "5"),
          },
        ],
      }),
    );
  }
  assert.equal(queryCanonicalSourceCurrent(store).records.length, 4);
  assert.equal(
    queryCanonicalSourceLineage(store, lineageRequest).observations.length,
    1,
  );
  const knowledgeRows = store.db
    .prepare(
      "SELECT recorded_at_utc_us FROM canonical_commits ORDER BY commit_sequence",
    )
    .all() as Array<{ recorded_at_utc_us?: number }>;
  assert.deepEqual(
    knowledgeRows.map((row) => Number(row.recorded_at_utc_us)),
    [2_000_000, 2_000_001, 2_000_002, 2_000_003],
  );
  assert.equal(
    queryCanonicalSourceHistorical(store, { knowledgeAt: 2 }).observations
      .length,
    2,
  );
  assert.equal(
    (
      store.db
        .prepare(
          "SELECT observed_at FROM source_captures ORDER BY rowid LIMIT 1",
        )
        .get() as { observed_at?: string }
    ).observed_at,
    "2026-08-19T00:00:00.000Z",
  );
  assert.equal(
    (
      store.db
        .prepare("SELECT DISTINCT scope_kind FROM capture_scopes")
        .get() as { scope_kind?: string }
    ).scope_kind,
    "point-in-time",
  );
  // A second lifecycle owner for the same path is intentionally rejected.
  // This raw read adapter models an already-open SQLite reader without
  // claiming the canonical schema lifecycle lease.
  const snapshotReaderDb = new DatabaseSync(path);
  const snapshotReader = {
    db: snapshotReaderDb,
    databasePath: path,
    commitClock: () => 0,
    close() {
      snapshotReaderDb.close();
    },
  };
  snapshotReader.db.exec("BEGIN");
  assert.equal(
    (
      snapshotReader.db
        .prepare("SELECT COUNT(*) AS count FROM source_records")
        .get() as { count?: number }
    ).count,
    4,
  );
  await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence({
      ...evidence("fence-snapshot"),
      subjectDigest: token("4"),
    }),
  );
  assert.equal(
    (
      snapshotReader.db
        .prepare("SELECT COUNT(*) AS count FROM source_records")
        .get() as { count?: number }
    ).count,
    4,
  );
  snapshotReader.db.exec("COMMIT");
  // This is an explicitly isolated raw read adapter used only to verify the
  // SQLite snapshot. Production source-query entry points reject it because
  // it has no lifecycle-owned source-store brand.
  assert.equal(
    (
      snapshotReader.db
        .prepare("SELECT COUNT(*) AS count FROM source_records")
        .get() as { count?: number }
    ).count,
    5,
  );
  snapshotReader.close();
  store.close();

  const readOnly = openCanonicalDatabase(fenceDirectory, { readOnly: true });
  readOnly.close();
  const financial = createCathayCanonicalFinancialQuery(fenceDirectory);
  const current = await financial.current({ kind: "current" });
  assert.deepEqual(current.accounts, []);
  assert.deepEqual(current.transactions, []);
  assert.equal(current.commitSequence, 0);
  const historical = await financial.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-08-19",
      knowledgeAt: "4",
    },
  });
  assert.deepEqual(historical.transactions, []);
  const corruptProjection = new DatabaseSync(path);
  const sourceOnlyCommit = corruptProjection
    .prepare(
      "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1",
    )
    .get() as { commit_id?: unknown };
  corruptProjection
    .prepare(
      "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?)",
    )
    .run(sourceOnlyCommit.commit_id as Uint8Array);
  corruptProjection.close();
  assert.throws(
    () => openCanonicalDatabase(fenceDirectory, { readOnly: true }),
    /source-only|financial projection/i,
  );
} finally {
  await rm(fenceDirectory, { recursive: true, force: true });
}

const v7Directory = await mkdtemp(join(tmpdir(), "canonical-source-v7-"));
try {
  const path = join(v7Directory, "canonical.sqlite");
  assert.throws(
    () =>
      openCanonicalDatabase(v7Directory, {
        injectMigrationFailure: "v7-v8-after-source-copy",
      }),
    /Injected v7-v8 migration failure/,
  );
  const legacy = new DatabaseSync(path);
  assert.equal(
    Number(
      (legacy.prepare("PRAGMA user_version").get() as { user_version?: number })
        .user_version,
    ),
    0,
  );
  assert.equal(
    legacy
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_captures'",
      )
      .get()?.["1"],
    undefined,
  );
  assert.equal(
    legacy
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_subjects'",
      )
      .get(),
    undefined,
  );
  legacy.close();
  const migrated = createCanonicalSourceStore(path);
  assert.equal(
    Number(
      (
        migrated.db.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        }
      ).user_version,
    ),
    CANONICAL_SOURCE_SCHEMA_VERSION,
  );
  const migratedRevisionSchema = String(
    (
      migrated.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(
    migratedRevisionSchema,
    /CHECK\(posting_origin IN .*synthetic_%/,
    "v7 retry should widen transaction revision schema",
  );
  assert.match(migratedRevisionSchema, /CHECK\(posting_basis IN .*synthetic_%/);
  assert.match(
    migratedRevisionSchema,
    /CHECK\(posting_rule_version IN .*synthetic-%/,
  );
  assert.match(migratedRevisionSchema, /esun\/credit-card\/human-attested-v1/);
  assert.match(
    migratedRevisionSchema,
    /yuanta\/credit-card\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v2/,
  );
  assert.match(
    migratedRevisionSchema,
    /hncb\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /sinopac\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /CHECK\(semantic_rule_version IN .*synthetic-%/,
  );
  assert.match(
    migratedRevisionSchema,
    /CHECK\(effective_time_rule_version IN .*synthetic-%/,
  );
  assert.match(
    migratedRevisionSchema,
    /effective_time_basis TEXT NOT NULL CHECK\(effective_time_basis IN \('accounting','transaction-time','source-reported'\)\)/,
  );
  validateCanonicalSourceStore(migrated);
  migrated.close();
} finally {
  await rm(v7Directory, { recursive: true, force: true });
}

const closedRevisionDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-closed-revision-v8-"),
);
try {
  const path = join(closedRevisionDirectory, "canonical.sqlite");
  await commitCathayDomesticDeposit(
    closedRevisionDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const legacy = new DatabaseSync(path);
  const currentRevisionSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const currentObservationSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const closedObservationSchema = currentObservationSchema.replace(
    "CHECK(time_precision IN ('date','minute','second'))",
    "CHECK(time_precision IN ('date','second'))",
  );
  assert.notEqual(closedObservationSchema, currentObservationSchema);
  const closedRevisionSchema = currentRevisionSchema
    .replace(
      "CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%')",
      "CHECK(posting_origin = 'provider_booked_history')",
    )
    .replace(
      "CHECK(posting_basis IN ('query-status-success-with-accounting-date','human-attested-formally-posted','statement-posted-history') OR posting_basis LIKE 'synthetic_%')",
      "CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    )
    .replace(
      "CHECK(posting_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR posting_rule_version LIKE 'synthetic-%' OR posting_rule_version LIKE 'foreign-currency/%' OR posting_rule_version LIKE 'fubon/credit-card/%' OR posting_rule_version LIKE 'fubon/loan/%' OR posting_rule_version LIKE 'yuanta/loan/%' OR posting_rule_version LIKE 'esun/credit-card/%' OR posting_rule_version LIKE '%/investment/%')",
      "CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      "CHECK(semantic_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR semantic_rule_version LIKE 'synthetic-%' OR semantic_rule_version LIKE 'foreign-currency/%' OR semantic_rule_version LIKE 'fubon/credit-card/%' OR semantic_rule_version LIKE 'fubon/loan/%' OR semantic_rule_version LIKE 'yuanta/loan/%' OR semantic_rule_version LIKE 'esun/credit-card/%' OR semantic_rule_version LIKE '%/investment/%')",
      "CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      "CHECK(effective_time_basis IN ('accounting','transaction-time','source-reported'))",
      "CHECK(effective_time_basis = 'accounting')",
    )
    .replace(
      "CHECK(effective_time_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR effective_time_rule_version LIKE 'synthetic-%' OR effective_time_rule_version LIKE 'foreign-currency/%' OR effective_time_rule_version LIKE 'fubon/credit-card/%' OR effective_time_rule_version LIKE 'fubon/loan/%' OR effective_time_rule_version LIKE 'yuanta/loan/%' OR effective_time_rule_version LIKE 'esun/credit-card/%' OR effective_time_rule_version LIKE '%/investment/%')",
      "CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    );
  assert.notEqual(closedRevisionSchema, currentRevisionSchema);
  assert.doesNotMatch(
    closedRevisionSchema,
    /hncb\/domestic-deposit\/human-attested-v1/,
  );
  const beforeRevisionCount = Number(
    (
      legacy
        .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
        .get() as { count?: number }
    ).count ?? 0,
  );
  const beforeObservationCount = Number(
    (
      legacy
        .prepare("SELECT COUNT(*) AS count FROM transaction_time_observations")
        .get() as { count?: number }
    ).count ?? 0,
  );
  const sourceAssertionsView = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(sourceAssertionsView, /CREATE VIEW source_assertions/);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(
    "DROP VIEW IF EXISTS source_assertions; DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; CREATE TABLE transaction_revisions_backup AS SELECT * FROM transaction_revisions; DROP TABLE transaction_revisions;",
  );
  legacy.exec(closedRevisionSchema);
  legacy.exec(
    "INSERT INTO transaction_revisions SELECT * FROM transaction_revisions_backup; DROP TABLE transaction_revisions_backup;",
  );
  legacy.exec(
    "CREATE TABLE transaction_time_observations_backup AS SELECT * FROM transaction_time_observations; DROP TABLE transaction_time_observations;",
  );
  legacy.exec(closedObservationSchema);
  legacy.exec(
    "INSERT INTO transaction_time_observations SELECT * FROM transaction_time_observations_backup; DROP TABLE transaction_time_observations_backup;",
  );
  legacy.exec(sourceAssertionsView);
  legacy.close();

  const migratedClosed = createCanonicalSourceStore(path);
  const widenedRevisionSchema = String(
    (
      migratedClosed.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(widenedRevisionSchema, /CHECK\(posting_origin IN .*synthetic_%/);
  assert.match(widenedRevisionSchema, /CHECK\(posting_basis IN .*synthetic_%/);
  assert.match(
    widenedRevisionSchema,
    /CHECK\(posting_rule_version IN .*synthetic-%/,
  );
  assert.match(widenedRevisionSchema, /esun\/credit-card\/human-attested-v1/);
  assert.match(widenedRevisionSchema, /yuanta\/credit-card\/human-attested-v1/);
  assert.match(
    widenedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    widenedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v2/,
  );
  assert.match(
    widenedRevisionSchema,
    /hncb\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    widenedRevisionSchema,
    /CHECK\(semantic_rule_version IN .*synthetic-%/,
  );
  assert.equal(
    Number(
      (
        migratedClosed.db
          .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
          .get() as { count?: number }
      ).count ?? 0,
    ),
    beforeRevisionCount,
  );
  const widenedObservationSchema = String(
    (
      migratedClosed.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(
    widenedObservationSchema,
    /time_precision TEXT NOT NULL CHECK\(time_precision IN \('date','minute','second'\)\)/,
  );
  assert.equal(
    Number(
      (
        migratedClosed.db
          .prepare(
            "SELECT COUNT(*) AS count FROM transaction_time_observations",
          )
          .get() as { count?: number }
      ).count ?? 0,
    ),
    beforeObservationCount,
  );
  migratedClosed.close();
  const widenedQuery = await createCathayCanonicalFinancialQuery(
    closedRevisionDirectory,
  ).current({ kind: "current" });
  assert.equal(widenedQuery.transactions.length, beforeRevisionCount);
} finally {
  await rm(closedRevisionDirectory, { recursive: true, force: true });
}

const partialDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-partial-v8-"),
);
try {
  const path = join(partialDirectory, "canonical.sqlite");
  const complete = createCanonicalSourceStore(path);
  const partialDb = new DatabaseSync(path);
  partialDb.exec("DROP TABLE source_record_provenance");
  partialDb.close();
  complete.close();
  assert.throws(
    () => createCanonicalSourceStore(path),
    /v8.*source_record_provenance|source_record_provenance.*missing/i,
  );
} finally {
  await rm(partialDirectory, { recursive: true, force: true });
}

test("v8 to v9 rebuilds the source assertion compatibility view", async () => {
  for (const defect of ["missing", "malformed"] as const) {
    const directory = await mkdtemp(
      join(tmpdir(), `canonical-source-v8-compat-${defect}-`),
    );
    try {
      const path = join(directory, "canonical.sqlite");
      await commitCathayDomesticDeposit(
        directory,
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      );
      const seeded = new DatabaseSync(path);
      const beforeSourceAssertionCount = Number(
        (
          seeded
            .prepare("SELECT COUNT(*) AS count FROM source_assertions")
            .get() as { count?: number }
        ).count ?? 0,
      );
      seeded.close();

      const legacy = new DatabaseSync(path);
      legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec("DROP VIEW source_assertions");
      if (defect === "malformed")
        legacy.exec(
          "CREATE VIEW source_assertions AS SELECT assertion_id, transaction_id, revision_id, created_commit_id AS commit_id FROM assertions",
        );
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        DELETE FROM canonical_contract_purge_commits;
        DELETE FROM canonical_contract_purges;
        DELETE FROM schema_migrations WHERE version > 8;
        PRAGMA user_version = 8;
        PRAGMA foreign_keys = ON;
      `);
      legacy.close();

      const migrated = createCanonicalSourceStore(path);
      const sourceAssertionsView = String(
        (
          migrated.db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
            )
            .get() as { sql?: unknown } | undefined
        )?.sql ?? "",
      );
      assert.match(sourceAssertionsView, /revision\.source_record_id/i);
      assert.equal(
        (
          migrated.db
            .prepare("SELECT COUNT(*) AS count FROM source_assertions")
            .get() as { count?: number }
        ).count,
        beforeSourceAssertionCount,
      );
      validateCanonicalSourceStore(migrated);
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("v9 reopen recovers an interrupted financial revision widening", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v9-revision-staging-"),
  );
  try {
    const path = join(directory, "canonical.sqlite");
    await commitCathayDomesticDeposit(
      directory,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );
    const legacy = new DatabaseSync(path);
    const currentRevisionSchema = String(
      (
        legacy
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
          )
          .get() as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    const interruptedFinalSchema = currentRevisionSchema.replace(
      "CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%')",
      "CHECK(posting_origin = 'provider_booked_history')",
    );
    assert.notEqual(interruptedFinalSchema, currentRevisionSchema);
    const sourceAssertionsView = String(
      (
        legacy
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
          )
          .get() as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    const beforeRevisionCount = Number(
      (
        legacy
          .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
          .get() as { count?: number }
      ).count ?? 0,
    );
    assert.equal(
      Number(
        (
          legacy.prepare("PRAGMA user_version").get() as {
            user_version?: number;
          }
        ).user_version,
      ),
      CANONICAL_SOURCE_SCHEMA_VERSION,
    );
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(
      "DROP VIEW IF EXISTS source_assertions; DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; CREATE TABLE transaction_revisions_backup AS SELECT * FROM transaction_revisions; DROP TABLE transaction_revisions;",
    );
    legacy.exec(interruptedFinalSchema);
    legacy.exec(
      "INSERT INTO transaction_revisions SELECT * FROM transaction_revisions_backup; DROP TABLE transaction_revisions_backup;",
    );
    const interruptedStagingSchema = currentRevisionSchema.replace(
      /CREATE TABLE ["']?transaction_revisions["']?/,
      "CREATE TABLE transaction_revisions_widened",
    );
    assert.notEqual(interruptedStagingSchema, currentRevisionSchema);
    legacy.exec(interruptedStagingSchema);
    legacy.exec(
      "INSERT INTO transaction_revisions_widened SELECT * FROM transaction_revisions",
    );
    legacy.exec(sourceAssertionsView);
    assert.equal(
      legacy
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('transaction_revisions', 'transaction_revisions_widened')",
        )
        .get()?.count,
      2,
    );
    legacy.close();

    assert.throws(
      () => openCanonicalDatabase(directory, { readOnly: true }),
      /staging.*writable recovery|widening staging/i,
    );
    const recovered = createCanonicalSourceStore(path);
    const recoveredRevisionSchema = String(
      (
        recovered.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
          )
          .get() as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    assert.match(
      recoveredRevisionSchema,
      /CHECK\(posting_origin IN .*synthetic_%/,
      "v9 staging recovery should widen transaction revision schema",
    );
    assert.equal(
      recovered.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions_widened'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      Number(
        (
          recovered.db
            .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      beforeRevisionCount,
    );
    validateCanonicalSourceStore(recovered);
    recovered.close();

    const staleStaging = new DatabaseSync(path);
    const canonicalSchemaAfterRecovery = String(
      (
        staleStaging
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
          )
          .get() as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    staleStaging.exec(
      canonicalSchemaAfterRecovery.replace(
        /CREATE TABLE ["']?transaction_revisions["']?/,
        "CREATE TABLE transaction_revisions_widened",
      ),
    );
    staleStaging.exec(
      "INSERT INTO transaction_revisions_widened SELECT * FROM transaction_revisions",
    );
    staleStaging.close();

    const reopened = createCanonicalSourceStore(path);
    assert.equal(
      reopened.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions_widened'",
        )
        .get(),
      undefined,
    );
    validateCanonicalSourceStore(reopened);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v9 reopen rejects divergent financial revision widening staging", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-v9-revision-ambiguous-"),
  );
  try {
    const path = join(directory, "canonical.sqlite");
    await commitCathayDomesticDeposit(
      directory,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );
    const legacy = new DatabaseSync(path);
    const currentRevisionSchema = String(
      (
        legacy
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
          )
          .get() as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    const interruptedFinalSchema = currentRevisionSchema.replace(
      "CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%')",
      "CHECK(posting_origin = 'provider_booked_history')",
    );
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(
      "DROP VIEW IF EXISTS source_assertions; DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; CREATE TABLE transaction_revisions_backup AS SELECT * FROM transaction_revisions; DROP TABLE transaction_revisions;",
    );
    legacy.exec(interruptedFinalSchema);
    legacy.exec(
      "INSERT INTO transaction_revisions SELECT * FROM transaction_revisions_backup; DROP TABLE transaction_revisions_backup;",
    );
    legacy.exec(
      currentRevisionSchema.replace(
        /CREATE TABLE ["']?transaction_revisions["']?/,
        "CREATE TABLE transaction_revisions_widened",
      ),
    );
    legacy.exec(
      "INSERT INTO transaction_revisions_widened SELECT * FROM transaction_revisions",
    );
    legacy.exec(
      "UPDATE transaction_revisions_widened SET description = 'divergent staging row' WHERE revision_id = (SELECT revision_id FROM transaction_revisions LIMIT 1)",
    );
    const finalCountBefore = Number(
      (
        legacy
          .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
          .get() as { count?: number }
      ).count ?? 0,
    );
    const stagingCountBefore = Number(
      (
        legacy
          .prepare(
            "SELECT COUNT(*) AS count FROM transaction_revisions_widened",
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    legacy.close();

    assert.throws(
      () => createCanonicalSourceStore(path),
      /ambiguous|divergent|discard or merge/i,
    );
    const rejected = new DatabaseSync(path);
    assert.equal(
      Number(
        (
          rejected
            .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      finalCountBefore,
    );
    assert.equal(
      Number(
        (
          rejected
            .prepare(
              "SELECT COUNT(*) AS count FROM transaction_revisions_widened",
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      stagingCountBefore,
    );
    rejected.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source assertion compatibility views enforce origin and provenance semantics", async () => {
  for (const defect of ["wrong-origin", "missing-provenance"] as const) {
    const directory = await mkdtemp(
      join(tmpdir(), `canonical-source-v8-compat-${defect}-`),
    );
    try {
      const path = join(directory, "canonical.sqlite");
      await commitCathayDomesticDeposit(
        directory,
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      );
      const legacy = new DatabaseSync(path);
      const revision = legacy
        .prepare(
          "SELECT revision_id, transaction_id, source_record_id, commit_id FROM transaction_revisions LIMIT 1",
        )
        .get() as {
        revision_id?: Uint8Array;
        transaction_id?: Uint8Array;
        source_record_id?: Uint8Array;
        commit_id?: Uint8Array;
      };
      const commitId = revision.commit_id;
      const transactionId = revision.transaction_id;
      const revisionId = revision.revision_id;
      assert.ok(commitId && transactionId && revisionId);
      const beforeAssertionCount = Number(
        (
          legacy.prepare("SELECT COUNT(*) AS count FROM assertions").get() as {
            count?: number;
          }
        ).count ?? 0,
      );
      const beforeSourceAssertionCount = Number(
        (
          legacy
            .prepare("SELECT COUNT(*) AS count FROM source_assertions")
            .get() as { count?: number }
        ).count ?? 0,
      );
      const sourceAssertion = legacy
        .prepare(
          "SELECT assertion_id, transaction_id, revision_id, source_record_id, commit_id FROM source_assertions LIMIT 1",
        )
        .get() as {
        assertion_id?: Uint8Array;
        transaction_id?: Uint8Array;
        revision_id?: Uint8Array;
        source_record_id?: Uint8Array;
        commit_id?: Uint8Array;
      };
      assert.ok(
        sourceAssertion.assertion_id &&
          sourceAssertion.transaction_id &&
          sourceAssertion.revision_id &&
          sourceAssertion.source_record_id &&
          sourceAssertion.commit_id,
      );
      const sourceAssertionId = sourceAssertion.assertion_id;
      assert.ok(sourceAssertionId);
      const extraAssertionId = createHash("sha256")
        .update(`${defect}:extra`)
        .digest()
        .subarray(0, 16);
      const fabricatedAssertionId = createHash("sha256")
        .update(`${defect}:fabricated`)
        .digest()
        .subarray(0, 16);
      if (defect === "wrong-origin") {
        legacy
          .prepare(
            `INSERT INTO assertions(
              assertion_id, transaction_id, field_name, target_kind, origin,
              producer_id, rule_lineage, revision_id, value_text, created_commit_id
            ) VALUES (?, ?, 'display_name', 'transaction', 'derived', ?, ?, NULL, ?, ?)`,
          )
          .run(
            extraAssertionId,
            transactionId,
            "test/derived",
            "test/derived/v1",
            "not-source",
            commitId,
          );
        legacy.exec(`
          DROP VIEW source_assertions;
          CREATE VIEW source_assertions AS
            SELECT assertion.assertion_id, assertion.transaction_id,
              revision.revision_id, revision.source_record_id,
              assertion.created_commit_id AS commit_id
            FROM assertions assertion
            JOIN transaction_revisions revision
              ON revision.transaction_id = assertion.transaction_id
            UNION ALL
            SELECT X'${fabricatedAssertionId.toString("hex")}', revision.transaction_id,
              revision.revision_id, revision.source_record_id, revision.commit_id
            FROM transaction_revisions revision LIMIT 1;
        `);
      } else {
        legacy.exec(`
          DROP VIEW source_assertions;
            CREATE VIEW source_assertions AS
            SELECT assertion.assertion_id, assertion.transaction_id,
              revision.revision_id, revision.source_record_id,
              assertion.created_commit_id AS commit_id
            FROM assertions assertion
            JOIN transaction_revisions revision
              ON revision.revision_id = assertion.revision_id
            WHERE assertion.origin = 'source'
            UNION ALL
            SELECT assertion.assertion_id, assertion.transaction_id,
              revision.revision_id, NULL AS source_record_id,
              assertion.created_commit_id AS commit_id
            FROM assertions assertion
            JOIN transaction_revisions revision
              ON revision.revision_id = assertion.revision_id
            WHERE assertion.assertion_id = X'${Buffer.from(sourceAssertionId).toString("hex")}';
        `);
      }
      assert.equal(
        Number(
          (
            legacy
              .prepare("SELECT COUNT(*) AS count FROM assertions")
              .get() as {
              count?: number;
            }
          ).count ?? 0,
        ),
        defect === "wrong-origin"
          ? beforeAssertionCount + 1
          : beforeAssertionCount,
      );
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        DELETE FROM canonical_contract_purge_commits;
        DELETE FROM canonical_contract_purges;
        DELETE FROM schema_migrations WHERE version > 8;
        PRAGMA user_version = 8;
        PRAGMA foreign_keys = ON;
      `);
      legacy.close();

      const migrated = createCanonicalSourceStore(path);
      const sourceAssertionsView = String(
        (
          migrated.db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
            )
            .get() as { sql?: unknown } | undefined
        )?.sql ?? "",
      );
      assert.match(sourceAssertionsView, /assertion\.origin\s*=\s*'source'/i);
      assert.match(
        sourceAssertionsView,
        /provenance\.source_record_id\s+IS\s+NOT\s+NULL/i,
      );
      assert.equal(
        Number(
          (
            migrated.db
              .prepare("SELECT COUNT(*) AS count FROM source_assertions")
              .get() as { count?: number }
          ).count ?? 0,
        ),
        beforeSourceAssertionCount,
      );
      assert.equal(
        migrated.db
          .prepare("SELECT 1 FROM assertions WHERE assertion_id = ?")
          .get(fabricatedAssertionId),
        undefined,
      );
      assert.equal(
        Number(
          (
            migrated.db
              .prepare("SELECT COUNT(*) AS count FROM assertions")
              .get() as {
              count?: number;
            }
          ).count ?? 0,
        ),
        defect === "wrong-origin"
          ? beforeAssertionCount + 1
          : beforeAssertionCount,
      );
      assert.equal(
        migrated.db
          .prepare("SELECT 1 FROM source_assertions WHERE assertion_id = ?")
          .get(extraAssertionId),
        undefined,
      );
      validateCanonicalSourceStore(migrated);
      migrated.close();

      const reopened = createCanonicalSourceStore(path);
      validateCanonicalSourceStore(reopened);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

const closedScopeDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-closed-scope-v8-"),
);
try {
  const path = join(closedScopeDirectory, "canonical.sqlite");
  await commitCathayDomesticDeposit(
    closedScopeDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const legacy = new DatabaseSync(path);
  const currentScopeSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_scopes'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const closedScopeSchema = currentScopeSchema.replace(
    "CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data'))",
    "CHECK(absence_authority IN ('comparable-complete-range'))",
  );
  assert.notEqual(closedScopeSchema, currentScopeSchema);
  const scopeIndexes = (
    legacy
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'capture_scopes' AND sql IS NOT NULL",
      )
      .all() as Array<{ sql?: unknown }>
  )
    .map((row) => String(row.sql ?? ""))
    .filter(Boolean);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(
    "CREATE TABLE capture_scopes_backup AS SELECT * FROM capture_scopes; DROP TABLE capture_scopes;",
  );
  legacy.exec(closedScopeSchema);
  legacy.exec(
    "INSERT INTO capture_scopes SELECT * FROM capture_scopes_backup; DROP TABLE capture_scopes_backup;",
  );
  for (const index of scopeIndexes) legacy.exec(index);
  legacy.close();

  const migratedScope = createCanonicalSourceStore(path);
  const migratedScopeSchema = String(
    (
      migratedScope.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_scopes'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(migratedScopeSchema, /provider-explicit-no-data/);
  assert.equal(
    (
      migratedScope.db
        .prepare("SELECT COUNT(*) AS count FROM capture_scopes")
        .get() as { count?: number }
    ).count,
    1,
  );
  validateCanonicalSourceStore(migratedScope);
  migratedScope.close();
} finally {
  await rm(closedScopeDirectory, { recursive: true, force: true });
}

test("fresh source migration failure leaves the original unversioned database intact", async () => {
  const orphanDirectory = await mkdtemp(
    join(tmpdir(), "canonical-source-orphan-"),
  );
  try {
    const path = join(orphanDirectory, "canonical.sqlite");
    assert.throws(
      () =>
        openCanonicalDatabase(orphanDirectory, {
          injectMigrationFailure: "v7-v8-after-source-copy",
        }),
      /Injected v7-v8 migration failure/,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        Number(
          (
            unchanged.prepare("PRAGMA user_version").get() as {
              user_version?: number;
            }
          ).user_version,
        ),
        0,
      );
      assert.equal(
        unchanged
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_records'",
          )
          .get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(orphanDirectory, { recursive: true, force: true });
  }
});

const mixedDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-mixed-v8-"),
);
try {
  await commitCathayDomesticDeposit(
    mixedDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const before = await createCathayCanonicalFinancialQuery(
    mixedDirectory,
  ).current({
    kind: "current",
  });
  const path = join(mixedDirectory, "canonical.sqlite");
  const mixed = createCanonicalSourceStore(path);
  await commitCanonicalSourceEvidence(
    mixed,
    admitCanonicalSourceEvidence(evidence("capture-mixed-source-only")),
  );
  mixed.close();
  const reopened = createCanonicalSourceStore(path);
  assert.equal(queryCanonicalSourceCurrent(reopened).observations.length, 1);
  reopened.close();
  const after = await createCathayCanonicalFinancialQuery(
    mixedDirectory,
  ).current({
    kind: "current",
  });
  assert.equal(after.transactions.length, before.transactions.length);
  assert.equal(after.commitSequence, before.commitSequence);
} finally {
  await rm(mixedDirectory, { recursive: true, force: true });
}

const mixedMigrationDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-mixed-migration-v8-"),
);
try {
  const path = join(mixedMigrationDirectory, "canonical.sqlite");
  await commitCathayDomesticDeposit(
    mixedMigrationDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const hncbCaptureInput = {
    evidenceVersion: "capture-evidence-v1" as const,
    source: "hncb" as const,
    product: "domestic-deposit" as const,
    providerGuaranteed: false as const,
    observedAt: "2026-08-20T12:00:00.000+08:00",
    account: {
      value: "SYNTHETIC-HNCB-MIGRATION-001",
      label: "SYNTHETIC HNCB MIGRATION ACCOUNT",
    },
    queryRange: { startDate: "2026/08/01", endDate: "2026/08/20" },
    downloads: [
      {
        filename: "hncb-migration.xls",
        byteLength: 100,
        contentDigest: token("h") as `sha256:${string}`,
        columnNames: HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows: [
          {
            rowOrdinal: 0,
            values: [
              "2026/08/02",
              "09:10:11",
              "2026/08/03",
              "TWD",
              "100",
              "",
              "900",
              "MIGRATION DESCRIPTION",
              "",
              "",
              "MIGRATION REFERENCE",
            ],
          },
        ],
        terminal: true,
      },
    ],
    provenance: {
      source: "hncb-ebank-domestic-deposit-html-workbook" as const,
      encoding: "big5" as const,
      responseBodyRetained: false as const,
      semantics: "unresolved" as const,
      accountSelector: "select#acct1" as const,
      queryFormSelector: 'form[name="form1"]' as const,
      downloadSelector: 'input[name="excel_download"]' as const,
    },
  };
  const structural = admitHncbDomesticDepositCaptureEvidence(hncbCaptureInput);
  assert.equal(structural.status, "admissible");
  assert.ok(structural.capture);
  const financialInput = {
    capture: structural.capture,
    captureId: "hncb-migration-financial-capture",
    humanAttestation: getHncbHumanAttestedV1Manifest(),
  };
  assert.equal(
    admitHncbDomesticDepositFinancialCapture(financialInput).status,
    "admitted",
  );
  const mixed = createCanonicalSourceStore(path);
  const cathayRevisionCount = Number(
    (
      mixed.db
        .prepare(
          "SELECT COUNT(*) AS value FROM transaction_revisions WHERE posting_rule_version = 'cathay/domestic-deposit/v1'",
        )
        .get() as { value?: number }
    ).value ?? 0,
  );
  assert.ok(cathayRevisionCount > 0);
  await commitCanonicalHncbDomesticDepositCapture(
    {
      db: mixed.db,
      databasePath: mixed.databasePath,
      commitClock: () => mixed.commitClock(),
    },
    financialInput,
  );
  const beforeMigrationRows = Number(
    (
      mixed.db
        .prepare("SELECT COUNT(*) AS value FROM transaction_revisions")
        .get() as { value?: number }
    ).value ?? 0,
  );
  assert.equal(beforeMigrationRows, cathayRevisionCount + 1);
  mixed.close();

  const legacy = new DatabaseSync(path);
  const currentRevisionSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const closedRevisionSchema = currentRevisionSchema
    .replace(
      /CHECK\(posting_origin IN \([^)]*\) OR posting_origin LIKE 'synthetic_%'\)/,
      "CHECK(posting_origin = 'provider_booked_history')",
    )
    .replace(
      /CHECK\(posting_basis IN \([^)]*\) OR posting_basis LIKE 'synthetic_%'\)/,
      "CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    )
    .replace(
      /CHECK\(posting_rule_version IN \([^)]*\) OR posting_rule_version LIKE 'synthetic-%'\)/,
      "CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      /CHECK\(semantic_rule_version IN \([^)]*\) OR semantic_rule_version LIKE 'synthetic-%'\)/,
      "CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      "CHECK(effective_time_basis IN ('accounting','transaction-time','source-reported'))",
      "CHECK(effective_time_basis = 'accounting')",
    )
    .replace(
      /CHECK\(effective_time_rule_version IN \([^)]*\) OR effective_time_rule_version LIKE 'synthetic-%'\)/,
      "CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    );
  assert.notEqual(closedRevisionSchema, currentRevisionSchema);
  const sourceAssertionsView = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(
    "DROP VIEW IF EXISTS source_assertions; DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; CREATE TABLE transaction_revisions_backup AS SELECT * FROM transaction_revisions; DROP TABLE transaction_revisions;",
  );
  legacy.exec(closedRevisionSchema);
  // This fixture represents an older closed allowlist with rows written by
  // both providers before the current migration widened the HNCB route.
  legacy.exec("PRAGMA ignore_check_constraints = ON");
  legacy.exec(
    "INSERT INTO transaction_revisions SELECT * FROM transaction_revisions_backup; DROP TABLE transaction_revisions_backup;",
  );
  legacy.exec("PRAGMA ignore_check_constraints = OFF");
  legacy.exec(sourceAssertionsView);
  legacy.close();

  const migrated = createCanonicalSourceStore(path);
  try {
    const widenedRevisionSchema = String(
      (
        migrated.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
          )
          .get() as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    assert.match(
      widenedRevisionSchema,
      /hncb\/domestic-deposit\/human-attested-v1/,
    );
    assert.equal(
      (
        migrated.db
          .prepare("SELECT COUNT(*) AS value FROM transaction_revisions")
          .get() as { value?: number }
      ).value,
      beforeMigrationRows,
    );
    assert.equal(
      (
        migrated.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      beforeMigrationRows,
    );
    assert.equal(
      (
        migrated.db
          .prepare("SELECT COUNT(*) AS value FROM current_transactions")
          .get() as { value?: number }
      ).value,
      beforeMigrationRows,
    );
    const routeCounts = migrated.db
      .prepare(
        "SELECT posting_rule_version AS route, COUNT(*) AS value FROM transaction_revisions GROUP BY posting_rule_version ORDER BY route",
      )
      .all() as Array<{ route?: string; value?: number }>;
    assert.deepEqual(
      routeCounts.map(({ route, value }) => ({ route, value })),
      [
        { route: "cathay/domestic-deposit/v1", value: cathayRevisionCount },
        { route: "hncb/domestic-deposit/human-attested-v1", value: 1 },
      ],
    );
    validateCanonicalSourceStore(migrated);
  } finally {
    migrated.close();
  }
} finally {
  await rm(mixedMigrationDirectory, { recursive: true, force: true });
}

const fubonQueryDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-fubon-query-v2-"),
);
try {
  const store = createCanonicalSourceStore(
    join(fubonQueryDirectory, "canonical.sqlite"),
  );
  const v1Commit = await commitCanonicalFinancialDepositCapture(
    store,
    admitCanonicalFinancialDepositCapture(
      fubonCreditCardFinancialCapture("v1", "fubon-historical-v1"),
    ),
  );
  const v2Commit = await commitCanonicalFinancialDepositCapture(
    store,
    admitCanonicalFinancialDepositCapture(
      fubonCreditCardFinancialCapture("v2", "fubon-current-v2"),
    ),
  );
  store.close();

  const v1Query = createCanonicalFinancialQuery(fubonQueryDirectory, {
    integrationNamespace: "fubon",
    postingRuleVersion: "fubon/credit-card/human-attested-v1",
  });
  const v1Current = await v1Query.current({ kind: "current" });
  assert.deepEqual(v1Current.accounts, []);
  assert.deepEqual(
    v1Current.transactions,
    [],
    "superseded Fubon v1 rows cannot enter a current projection query",
  );
  const v1Historical = await v1Query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(v1Commit.commitSequence),
    },
  });
  assert.equal(v1Historical.transactions.length, 1);
  assert.equal(
    v1Historical.transactions[0]?.postingRuleVersion,
    "fubon/credit-card/human-attested-v1",
  );

  const v2Query = createCanonicalFinancialQuery(fubonQueryDirectory, {
    integrationNamespace: "fubon",
    postingRuleVersion: "fubon/credit-card/human-attested-v2",
  });
  const v2Current = await v2Query.current({ kind: "current" });
  assert.equal(v2Current.accounts.length, 1);
  assert.equal(v2Current.transactions.length, 1);
  assert.equal(
    v2Current.transactions[0]?.postingRuleVersion,
    "fubon/credit-card/human-attested-v2",
  );
  const v2Historical = await v2Query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(v2Commit.commitSequence),
    },
  });
  assert.equal(v2Historical.transactions.length, 1);
  assert.equal(
    v2Historical.transactions[0]?.postingRuleVersion,
    "fubon/credit-card/human-attested-v2",
  );

  assert.throws(
    () =>
      createCanonicalFinancialQuery(fubonQueryDirectory, {
        integrationNamespace: "other",
        postingRuleVersion: "fubon/credit-card/human-attested-v2",
      }),
    /unknown|mixed/i,
  );
  assert.throws(
    () =>
      createCanonicalFinancialQuery(fubonQueryDirectory, {
        integrationNamespace: "fubon",
        postingRuleVersion: "fubon/credit-card/human-attested-v3",
      }),
    /unknown|mixed/i,
  );
} finally {
  await rm(fubonQueryDirectory, { recursive: true, force: true });
}

test("Yuanta v2 wins the current view without deleting v1 history", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-yuanta-query-v2-precedence-"),
  );
  try {
    const store = createCanonicalSourceStore(
      join(directory, "canonical.sqlite"),
    );
    const v1Commit = await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v1", "yuanta-query-v1"),
      ),
    );
    const v2Commit = await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v2", "yuanta-query-v2"),
      ),
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) AS value FROM financial_transactions WHERE account_id IN (SELECT account_id FROM financial_accounts WHERE stream = 'credit-card')",
            )
            .get() as { value?: number }
        ).value,
      ),
      62,
    );
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 62);
    assert.equal(
      queryCanonicalSourceHistorical(store, {
        knowledgeAt: v2Commit.commitSequence,
      }).observations.length,
      62,
    );
    store.close();

    const v1Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
    });
    const v2Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
    });
    assert.equal(
      (await v1Query.current({ kind: "current" })).transactions.length,
      0,
      "a complete v2 capture supersedes v1 only in the current view",
    );
    assert.equal(
      (await v2Query.current({ kind: "current" })).transactions.length,
      31,
    );
    assert.equal(
      (
        await v1Query.historical({
          kind: "historical",
          cutoff: {
            kind: "both",
            financialAt: "2026-12-31",
            knowledgeAt: String(v1Commit.commitSequence),
          },
        })
      ).transactions.length,
      31,
      "v1 remains available through its historical route",
    );
    assert.equal(
      (
        await v2Query.historical({
          kind: "historical",
          cutoff: {
            kind: "both",
            financialAt: "2026-12-31",
            knowledgeAt: String(v2Commit.commitSequence),
          },
        })
      ).transactions.length,
      31,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Yuanta v1 current rows remain visible when a v2 scope is incomplete", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-yuanta-query-v2-invalid-"),
  );
  try {
    const store = createCanonicalSourceStore(
      join(directory, "canonical.sqlite"),
    );
    await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v1", "yuanta-invalid-v1"),
      ),
    );
    await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v2", "yuanta-invalid-v2"),
      ),
    );
    store.db
      .prepare(
        `UPDATE capture_scopes
       SET terminal = 0
       WHERE capture_id = (
         SELECT capture_id FROM source_captures
         WHERE capture_key = ?
       )`,
      )
      .run("yuanta-invalid-v2");
    store.close();

    const v1Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
    });
    const v2Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
    });
    assert.equal(
      (await v1Query.current({ kind: "current" })).transactions.length,
      31,
      "incomplete v2 cannot hide v1 authority",
    );
    assert.equal(
      (await v2Query.current({ kind: "current" })).transactions.length,
      0,
      "incomplete v2 is not current authority",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a v19 investment schema gains crypto account, security, and cost fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canonical-investment-v20-"));
  const path = join(dir, "canonical.sqlite");
  try {
    const current = createCanonicalSourceStore(path);
    current.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE investment_accounts DROP COLUMN account_subtype;
      ALTER TABLE investment_securities DROP COLUMN security_type;
      ALTER TABLE investment_holding_observations DROP COLUMN cost_coefficient;
      ALTER TABLE investment_holding_observations DROP COLUMN cost_scale;
      ALTER TABLE investment_holding_observations DROP COLUMN cost_currency;
      DELETE FROM schema_migrations WHERE version = 20;
      PRAGMA user_version = 19;
      PRAGMA foreign_keys = ON;
    `);
    legacy.close();

    const migrated = createCanonicalSourceStore(path);
    try {
      assert.equal(
        Number(
          (migrated.db.prepare("PRAGMA user_version").get() as { user_version?: number })
            .user_version,
        ),
        20,
      );
      const columns = (table: string) =>
        migrated.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => String((row as { name?: unknown }).name));
      assert.ok(columns("investment_accounts").includes("account_subtype"));
      assert.ok(columns("investment_securities").includes("security_type"));
      assert.ok(columns("investment_holding_observations").includes("cost_coefficient"));
      assert.ok(columns("investment_holding_observations").includes("cost_scale"));
      assert.ok(columns("investment_holding_observations").includes("cost_currency"));
      assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a genuine v15 investment schema migrates through v20 before crypto validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canonical-investment-v15-to-v20-"));
  const path = join(dir, "canonical.sqlite");
  try {
    const current = createCanonicalSourceStore(path);
    current.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM canonical_contract_purge_commits
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      DELETE FROM canonical_contract_purges
       WHERE purge_id = 'yuanta-trade-investment/source-occurrence-content-v3:v19';
      ALTER TABLE investment_accounts DROP COLUMN account_subtype;
      ALTER TABLE investment_securities DROP COLUMN security_type;
      ALTER TABLE investment_holding_observations DROP COLUMN cost_coefficient;
      ALTER TABLE investment_holding_observations DROP COLUMN cost_scale;
      ALTER TABLE investment_holding_observations DROP COLUMN cost_currency;
      DELETE FROM schema_migrations WHERE version > 15;
      PRAGMA user_version = 15;
      PRAGMA foreign_keys = ON;
    `);
    legacy.close();

    const migrated = createCanonicalSourceStore(path);
    try {
      assert.equal(
        Number(
          (migrated.db.prepare("PRAGMA user_version").get() as { user_version?: number })
            .user_version,
        ),
        20,
      );
      assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
      for (const [table, columns] of [
        ["investment_accounts", ["account_subtype"]],
        ["investment_securities", ["security_type"]],
        [
          "investment_holding_observations",
          ["cost_coefficient", "cost_scale", "cost_currency"],
        ],
      ] as const) {
        const actual = migrated.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => String((row as { name?: unknown }).name));
        for (const column of columns) assert.ok(actual.includes(column));
      }
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
