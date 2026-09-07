import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCanonicalSourceStore,
  openCanonicalDatabase,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
  resumeCanonicalDeletionScrub,
  submitCanonicalContractPurge,
} from "./canonical-source-store.ts";
import {
  applyCanonicalTransactionTag,
  createCanonicalTransactionTag,
} from "./canonical-enrichment.ts";
import { createCanonicalSourceCaptureAdmission } from "./canonical-source-capture-admission.ts";
import type { CanonicalSourceEvidence } from "./canonical-source-evidence.ts";
import { blob, idFromString, idToString } from "./canonical-schema-implementation.ts";

const token = (value: string): string => `sha256:${value}`;

function sourceEvidence(
  connection: string,
  capture = `capture-${connection}`,
): CanonicalSourceEvidence {
  return {
    captureId: capture,
    integrationNamespace: "fubon",
    sourceConnectionKey: token(connection),
    identityEpoch: token(`epoch-${connection}`),
    stream: "domestic-deposit",
    recordKind: "fubon-domestic-deposit",
    routeKey: "fubon/domestic-deposit/capture-evidence-v2",
    contractVersion: "capture-evidence-v2",
    subjectDigest: token(`subject-${connection}`),
    observedAt: "2026-01-01T00:00:00Z",
    scope: {
      startDate: "20260101",
      endDate: "20260101",
      kind: "bounded-range",
      completeness: "complete-range",
      ruleVersion: "fubon/domestic-deposit/v1",
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { page: 1 },
      },
    ],
    records: [
      {
        occurrenceKey: token(`occurrence-${connection}`),
        providerKey: token(`provider-${connection}`),
        contentHash: token(`content-${connection}`),
        sequenceLexeme: "1",
        compact: { source: connection },
      },
    ],
  };
}

async function withStore(
  callback: (path: string, store: ReturnType<typeof createCanonicalSourceStore>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-contract-purge-runtime-"),
  );
  const path = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(path);
  try {
    await callback(path, store);
  } finally {
    try {
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

test("source-scoped purge removes only its closure and disables recollection across restart", async () => {
  await withStore(async (path, store) => {
    const admission = createCanonicalSourceCaptureAdmission(store);
    const selected = sourceEvidence("selected");
    const retained = sourceEvidence("retained");
    await admission.admit(selected);
    await admission.admit(retained);
    const before = queryCanonicalSourceCurrent(store);
    assert.equal(before.records.length, 2);
    const selectedIdentity = {
      integrationNamespace: selected.integrationNamespace,
      sourceConnectionKey: selected.sourceConnectionKey,
      identityEpoch: selected.identityEpoch,
      stream: selected.stream,
      recordKind: selected.recordKind,
      subjectDigest: selected.subjectDigest,
      occurrenceKey: selected.records[0]!.occurrenceKey,
    };
    const historicalBefore = queryCanonicalSourceHistorical(store, {
      knowledgeAt: before.observations[0]!.commitSequence,
    });
    assert.equal(historicalBefore.records.length, 1);
    assert.equal(
      queryCanonicalSourceLineage(store, selectedIdentity).records.length,
      1,
    );

    const result = await submitCanonicalContractPurge(store, {
      scope: {
        integrationNamespace: selected.integrationNamespace,
        sourceConnectionKey: selected.sourceConnectionKey,
        productStream: selected.stream,
        identityEpochKey: selected.identityEpoch,
      },
      reason: "remove obsolete source contract",
    });
    assert.equal(result.scrub.status, "completed");
    assert.ok(result.deletedRowCount > 0);
    assert.match(result.closureFingerprint, /^sha256:/u);
    assert.deepEqual(
      queryCanonicalSourceCurrent(store).records.map(
        (record) => record.identity.sourceConnectionKey,
      ),
      [retained.sourceConnectionKey],
    );
    assert.equal(
      queryCanonicalSourceHistorical(store, {
        knowledgeAt: historicalBefore.knowledgeAt,
      }).records.length,
      0,
    );
    assert.equal(queryCanonicalSourceLineage(store, selectedIdentity).records.length, 0);
    const audit = store.db
      .prepare(
        "SELECT reason, scope_json, deleted_table_counts_json FROM canonical_runtime_contract_purges",
      )
      .get() as Record<string, unknown>;
    assert.equal(audit.reason, "remove obsolete source contract");
    assert.doesNotMatch(String(audit.scope_json), /payload|compact|content|amount/iu);
    assert.doesNotMatch(String(audit.deleted_table_counts_json), /compact|payload/iu);

    store.close();
    const reopened = createCanonicalSourceStore(path);
    try {
      const reopenedAdmission = createCanonicalSourceCaptureAdmission(reopened);
      assert.deepEqual(
        queryCanonicalSourceCurrent(reopened).records.map(
          (record) => record.identity.sourceConnectionKey,
        ),
        [retained.sourceConnectionKey],
      );
      await assert.rejects(
        () => reopenedAdmission.admit(sourceEvidence("selected", "recollection")),
        /purged.*disabled/iu,
      );
      const scrubPath = `${path}.deletion-scrub.json`;
      const scrubState = JSON.parse(readFileSync(scrubPath, "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      scrubState.entries.forEach((entry) => {
        entry.status = "pending";
        delete entry.completedAtUtcUs;
      });
      writeFileSync(scrubPath, `${JSON.stringify(scrubState)}\n`);
      const resumed = await resumeCanonicalDeletionScrub(path);
      assert.equal(resumed.status, "completed");
      assert.deepEqual(resumed.pendingPurgeIds, []);
    } finally {
      reopened.close();
    }
  });
});

test("purge failure rolls back closure deletion, projection switch, and disable marker", async () => {
  await withStore(async (path, store) => {
    const admission = createCanonicalSourceCaptureAdmission(store);
    const selected = sourceEvidence("atomic-selected");
    const retained = sourceEvidence("atomic-retained");
    await admission.admit(selected);
    await admission.admit(retained);
    const before = queryCanonicalSourceCurrent(store);
    const beforeCounts = {
      captures: Number(
        (store.db.prepare("SELECT COUNT(*) AS value FROM source_captures").get() as { value?: number }).value,
      ),
      records: Number(
        (store.db.prepare("SELECT COUNT(*) AS value FROM source_records").get() as { value?: number }).value,
      ),
      audits: Number(
        (store.db.prepare("SELECT COUNT(*) AS value FROM canonical_runtime_contract_purges").get() as { value?: number }).value,
      ),
    };
    await assert.rejects(
      () =>
        submitCanonicalContractPurge(store, {
          scope: {
            integrationNamespace: selected.integrationNamespace,
            sourceConnectionKey: selected.sourceConnectionKey,
            stream: selected.stream,
          },
          reason: "atomic failure probe",
          projection: { injectFailure: "pre-switch" },
        }),
      /Injected projection rebuild failure at pre-switch/iu,
    );
    assert.deepEqual(
      queryCanonicalSourceCurrent(store).records.map(
        (record) => record.identity.sourceConnectionKey,
      ),
      before.records.map((record) => record.identity.sourceConnectionKey),
    );
    assert.deepEqual(
      {
        captures: Number(
          (store.db.prepare("SELECT COUNT(*) AS value FROM source_captures").get() as { value?: number }).value,
        ),
        records: Number(
          (store.db.prepare("SELECT COUNT(*) AS value FROM source_records").get() as { value?: number }).value,
        ),
        audits: Number(
          (store.db.prepare("SELECT COUNT(*) AS value FROM canonical_runtime_contract_purges").get() as { value?: number }).value,
        ),
      },
      beforeCounts,
    );
    assert.equal(existsSync(`${path}.deletion-scrub.json`), false);
  });
});

test("source connection ID fences use the admitted deterministic identity", async () => {
  await withStore(async (_path, store) => {
    const admission = createCanonicalSourceCaptureAdmission(store);
    const selected = sourceEvidence("source-id-selected");
    const retained = sourceEvidence("source-id-retained");
    await admission.admit(selected);
    await admission.admit(retained);
    const row = store.db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
      )
      .get(selected.integrationNamespace, selected.sourceConnectionKey) as {
      source_connection_id?: Uint8Array;
    };
    assert.ok(row.source_connection_id);
    await submitCanonicalContractPurge(store, {
      scope: { sourceConnectionId: idToString(Buffer.from(row.source_connection_id)) },
      reason: "remove one source connection",
    });
    assert.deepEqual(
      queryCanonicalSourceCurrent(store).records.map(
        (record) => record.identity.sourceConnectionKey,
      ),
      [retained.sourceConnectionKey],
    );
    await assert.rejects(
      () => admission.admit(sourceEvidence("source-id-selected", "recollection")),
      /purged.*disabled/iu,
    );
  });
});

test("a busy WAL checkpoint leaves scrub pending and resumes after the reader releases", async () => {
  await withStore(async (path, store) => {
    const admission = createCanonicalSourceCaptureAdmission(store);
    const selected = sourceEvidence("busy-scrub-selected");
    await admission.admit(selected);
    const reader = new DatabaseSync(path);
    reader.exec("PRAGMA busy_timeout = 1; BEGIN");
    reader.prepare("SELECT COUNT(*) AS count FROM source_captures").get();
    try {
      const result = await submitCanonicalContractPurge(store, {
        scope: {
          integrationNamespace: selected.integrationNamespace,
          sourceConnectionKey: selected.sourceConnectionKey,
        },
        reason: "busy scrub probe",
      });
      assert.equal(result.scrub.status, "pending");
      assert.deepEqual(result.scrub.pendingPurgeIds, [result.purgeId]);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
    const resumed = await resumeCanonicalDeletionScrub(path);
    assert.equal(resumed.status, "completed");
    assert.deepEqual(resumed.pendingPurgeIds, []);
  });
});

test("purge removes owned transaction tag assertion links while retaining shared tags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-contract-purge-tags-"));
  const path = join(directory, "canonical.sqlite");
  try {
    await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const identity = (() => {
      const db = openCanonicalDatabase(directory, { readOnly: true });
      try {
        const row = db
          .prepare(`
            SELECT transaction_row.transaction_id,
                   connection.integration_namespace,
                   connection.source_connection_key,
                   account.stream
              FROM financial_transactions transaction_row
              JOIN financial_accounts account
                ON account.account_id = transaction_row.account_id
              JOIN source_connections connection
                ON connection.source_connection_id = account.source_connection_id
             ORDER BY transaction_row.source_sequence
             LIMIT 1
          `)
          .get() as Record<string, unknown>;
        return {
          transactionId: idToString(blob(row.transaction_id)),
          integrationNamespace: String(row.integration_namespace),
          sourceConnectionKey: String(row.source_connection_key),
          stream: String(row.stream),
        };
      } finally {
        db.close();
      }
    })();
    const tag = await createCanonicalTransactionTag(directory, {
      label: "Purge owned link",
      userId: "alice",
    });
    await applyCanonicalTransactionTag(directory, {
      tagId: tag.tagId,
      transactionId: identity.transactionId,
      userId: "alice",
    });
    const before = openCanonicalDatabase(directory, { readOnly: true });
    try {
      assert.equal(
        Number(
          (
            before
              .prepare(
                "SELECT COUNT(*) AS count FROM transaction_tag_assertion_values",
              )
              .get() as { count?: unknown }
          ).count ?? 0,
        ),
        1,
      );
    } finally {
      before.close();
    }

    const store = createCanonicalSourceStore(path);
    try {
      await submitCanonicalContractPurge(store, {
        scope: {
          integrationNamespace: identity.integrationNamespace,
          sourceConnectionKey: identity.sourceConnectionKey,
          stream: identity.stream,
        },
        reason: "remove obsolete source contract",
      });
      assert.equal(
        Number(
          (
            store.db
              .prepare(
                "SELECT COUNT(*) AS count FROM transaction_tag_assertion_values",
              )
              .get() as { count?: unknown }
          ).count ?? 0,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            store.db
              .prepare("SELECT COUNT(*) AS count FROM user_tags WHERE tag_id = ?")
              .get(idFromString(tag.tagId)) as { count?: unknown }
          ).count ?? 0,
        ),
        1,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
