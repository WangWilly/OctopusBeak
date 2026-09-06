import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  openCanonicalDatabase,
} from "./canonical-source-store.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  applyCanonicalTransactionTag,
  archiveCanonicalTransactionTag,
  commitCanonicalCounterpartyDisplay,
  createCanonicalEnrichmentQuery,
  createCanonicalTransactionTag,
  normalizeCanonicalTagLabel,
  renameCanonicalTransactionTag,
  type CanonicalEnrichmentOutput,
} from "./canonical-enrichment.ts";
import { commitCanonicalAutomaticEnrichmentRun } from "./canonical-enrichment.ts";
import { blob, idToString, uuidV7 } from "./canonical-schema-implementation.ts";

type Fixture = Readonly<{
  directory: string;
  transactionId: string;
  sourceConnectionKey: string;
  sourceRecordId: string;
}>;

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "canonical-display-tags-"));
  await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const db = openCanonicalDatabase(directory, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT transaction_row.transaction_id, revision.source_record_id,
             connection.source_connection_key
        FROM financial_transactions transaction_row
        JOIN current_transactions current_row
          ON current_row.transaction_id = transaction_row.transaction_id
        JOIN transaction_revisions revision
          ON revision.revision_id = current_row.revision_id
        JOIN financial_accounts account
          ON account.account_id = transaction_row.account_id
        JOIN source_connections connection
          ON connection.source_connection_id = account.source_connection_id
       ORDER BY transaction_row.source_sequence
       LIMIT 1
    `).get() as Record<string, unknown>;
    return {
      directory,
      transactionId: idToString(blob(row.transaction_id)),
      sourceConnectionKey: String(row.source_connection_key),
      sourceRecordId: idToString(blob(row.source_record_id)),
    };
  } finally {
    db.close();
  }
}

async function dispose(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

function automaticOutputs(state: Fixture, displayName: string): CanonicalEnrichmentOutput[] {
  const evidence = {
    kind: "description",
    sourceRecordId: state.sourceRecordId,
    sourceValue: "Synthetic Cathay deposit description",
    contractVersion: "cathay/domestic-deposit/v1",
  } as const;
  return [
    {
      transactionId: state.transactionId,
      field: "kind",
      origin: "derived",
      value: "purchase",
      confidenceBasisPoints: 9_000,
      evidence,
    },
    {
      transactionId: state.transactionId,
      field: "counterparty_role",
      origin: "derived",
      value: "merchant",
      confidenceBasisPoints: 9_000,
      evidence,
      participations: [{
        participationKey: "merchant-1",
        role: "merchant",
        observedName: displayName,
        counterparty: {
          producerNamespace: "test",
          producerEntityKey: "merchant:001",
          displayName,
        },
      }],
    },
    {
      transactionId: state.transactionId,
      field: "counterparty_display",
      origin: "derived",
      value: displayName,
      confidenceBasisPoints: 9_000,
      evidence,
      counterparty: {
        producerNamespace: "test",
        producerEntityKey: "merchant:001",
        displayName,
      },
    },
  ] as CanonicalEnrichmentOutput[];
}

async function admitAutomatic(state: Fixture, displayName = "Cafe v1") {
  return commitCanonicalAutomaticEnrichmentRun(state.directory, {
    sourceConnectionKey: state.sourceConnectionKey,
    stream: "domestic-deposit",
    ruleLineage: "test/display-tags",
    declaredSubjects: [{
      transactionId: state.transactionId,
      fields: ["kind", "counterparty_role", "counterparty_display"],
    }],
    outputs: automaticOutputs(state, displayName),
  });
}

test("display precedence and reference names remain knowledge-time facts", async () => {
  const state = await fixture();
  try {
    const first = await admitAutomatic(state);
    const automatic = createCanonicalEnrichmentQuery(state.directory).current({
      transactionIds: [state.transactionId],
    }).transactions[0]!;
    assert.equal(automatic.display.status, "supported");
    if (automatic.display.status !== "supported") throw new Error("Expected automatic display.");
    assert.equal(automatic.display.value, "Cafe v1");
    assert.equal(automatic.display.origin, "derived");
    assert.equal(automatic.counterparties.length, 1);
    assert.equal(automatic.counterparties[0]?.referenceDisplayName, "Cafe v1");

    const alias = await commitCanonicalCounterpartyDisplay(state.directory, {
      transactionId: state.transactionId,
      action: "reference_alias",
      label: "My Cafe",
      producerNamespace: "test",
      producerEntityKey: "merchant:001",
      userId: "alice",
    });
    const aliasView = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(aliasView.display.status, "supported");
    if (aliasView.display.status !== "supported") throw new Error("Expected alias display.");
    assert.equal(aliasView.display.value, "My Cafe");
    assert.equal(aliasView.display.origin, "user");
    assert.equal(aliasView.display.displayKind, "reference_alias");

    const override = await commitCanonicalCounterpartyDisplay(state.directory, {
      transactionId: state.transactionId,
      action: "override",
      label: "Statement Cafe",
      userId: "alice",
    });
    const overrideView = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(overrideView.display.status, "supported");
    if (overrideView.display.status !== "supported") throw new Error("Expected override display.");
    assert.equal(overrideView.display.value, "Statement Cafe");
    assert.equal(overrideView.display.displayKind, "override");

    const cleared = await commitCanonicalCounterpartyDisplay(state.directory, {
      transactionId: state.transactionId,
      action: "clear",
      userId: "alice",
    });
    assert.equal(cleared.status, "committed");
    const aliasFallback = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(aliasFallback.display.status, "supported");
    if (aliasFallback.display.status !== "supported") throw new Error("Expected alias fallback.");
    assert.equal(aliasFallback.display.value, "My Cafe");
    await commitCanonicalCounterpartyDisplay(state.directory, {
      transactionId: state.transactionId,
      action: "clear",
      userId: "alice",
    });
    const fallback = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(fallback.display.status, "supported");
    if (fallback.display.status !== "supported") throw new Error("Expected automatic fallback.");
    assert.equal(fallback.display.value, "Cafe v1");

    const second = await admitAutomatic(state, "Cafe v2");
    const historical = createCanonicalEnrichmentQuery(state.directory).historical({
      transactionIds: [state.transactionId],
      financialAt: "2026-12-31",
      knowledgeAt: first.commitSequence,
    }).transactions[0]!;
    assert.equal(historical.counterparties[0]?.referenceDisplayName, "Cafe v1");
    const current = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(current.counterparties[0]?.referenceDisplayName, "Cafe v2");
    assert.ok(second.commitSequence > first.commitSequence);
    assert.ok(alias.commitSequence < override.commitSequence);
  } finally {
    await dispose(state.directory);
  }
});

test("tags use one stable identity, Unicode normalized uniqueness, and cutoff lifecycle", async () => {
  assert.equal(normalizeCanonicalTagLabel(" Straße "), "strasse");
  assert.equal(normalizeCanonicalTagLabel("ΟΣ"), normalizeCanonicalTagLabel("ος"));
  assert.equal(normalizeCanonicalTagLabel("Café"), normalizeCanonicalTagLabel("Cafe\u0301"));
  assert.equal(normalizeCanonicalTagLabel("ᾀ"), normalizeCanonicalTagLabel("ἀι"));
  const state = await fixture();
  try {
    const created = await createCanonicalTransactionTag(state.directory, {
      label: "Straße",
      userId: "alice",
    });
    await assert.rejects(
      createCanonicalTransactionTag(state.directory, { label: "STRASSE", userId: "alice" }),
      /already used/u,
    );
    const applied = await applyCanonicalTransactionTag(state.directory, {
      tagId: created.tagId,
      transactionId: state.transactionId,
      userId: "alice",
    });
    const appliedView = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(appliedView.tags.length, 1);
    assert.equal(appliedView.tags[0]?.tagId, created.tagId);
    const renamed = await renameCanonicalTransactionTag(state.directory, {
      tagId: created.tagId,
      label: "Café",
      userId: "alice",
    });
    assert.equal(renamed.tagId, created.tagId);
    assert.equal(renamed.normalizedLabel, "café");
    await assert.rejects(
      createCanonicalTransactionTag(state.directory, { label: "Cafe\u0301", userId: "alice" }),
      /already used/u,
    );
    const historicalLabelReuse = await createCanonicalTransactionTag(state.directory, {
      label: "Straße",
      userId: "alice",
    });
    assert.notEqual(historicalLabelReuse.tagId, created.tagId);
    const archived = await archiveCanonicalTransactionTag(state.directory, {
      tagId: created.tagId,
      userId: "alice",
    });
    assert.equal(archived.lifecycle, "archived");
    const archivedView = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(archivedView.tags.length, 0);
    await assert.rejects(
      applyCanonicalTransactionTag(state.directory, {
        tagId: created.tagId,
        transactionId: state.transactionId,
        userId: "alice",
      }),
      /Archived/u,
    );
    await assert.rejects(
      applyCanonicalTransactionTag(state.directory, {
        tagId: created.tagId,
        transactionId: state.transactionId,
        userId: "bob",
      }),
      /belongs to another user/u,
    );
    const historical = createCanonicalEnrichmentQuery(state.directory).historical({
      transactionIds: [state.transactionId],
      financialAt: "2026-12-31",
      knowledgeAt: applied.commitSequence,
    }).transactions[0]!;
    assert.equal(historical.tags.length, 1);
    assert.equal(historical.tags[0]?.label, "Straße");
    assert.ok(renamed.commitSequence < archived.commitSequence);
  } finally {
    await dispose(state.directory);
  }
});

test("tag values require a User Assertion and survive an atomic projection rebuild", async () => {
  const state = await fixture();
  try {
    await admitAutomatic(state);
    const created = await createCanonicalTransactionTag(state.directory, {
      label: "Rebuild me",
      userId: "alice",
    });
    await applyCanonicalTransactionTag(state.directory, {
      tagId: created.tagId,
      transactionId: state.transactionId,
      userId: "alice",
    });
    const before = createCanonicalEnrichmentQuery(state.directory).current({
      transactionIds: [state.transactionId],
    }).transactions[0]!;
    assert.equal(before.display.status, "supported");
    if (before.display.status !== "supported") throw new Error("Expected display before rebuild.");

    const db = openCanonicalDatabase(state.directory);
    try {
      const latestCommit = db.prepare(
        "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
      ).get() as { commit_id?: unknown };
      const derivedAssertionId = uuidV7();
      db.exec("BEGIN");
      db.prepare(`
        INSERT INTO assertions(
          assertion_id, transaction_id, field_name, target_kind, origin,
          producer_id, rule_lineage, revision_id, value_text, created_commit_id)
        VALUES (?, ?, 'note', 'transaction', 'derived', ?, 'test/non-user-tag', NULL, ?, ?)
      `).run(
        derivedAssertionId,
        Buffer.from(state.transactionId.replaceAll("-", ""), "hex"),
        "test-producer",
        created.tagId,
        latestCommit.commit_id as Uint8Array,
      );
      assert.throws(
        () => db.prepare(`
          INSERT INTO transaction_tag_assertion_values(
            assertion_id, transaction_id, tag_id, created_commit_id)
          VALUES (?, ?, ?, ?)
        `).run(
          derivedAssertionId,
          Buffer.from(state.transactionId.replaceAll("-", ""), "hex"),
          Buffer.from(created.tagId.replaceAll("-", ""), "hex"),
          latestCommit.commit_id as Uint8Array,
        ),
        /User Assertion/u,
      );
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }

    const runtime = createCanonicalProjectionRuntime(state.directory);
    await assert.rejects(
      runtime.rebuild({ injectFailure: "validation" }),
      /Injected projection rebuild failure/u,
    );
    const afterFailure = createCanonicalEnrichmentQuery(state.directory).current({
      transactionIds: [state.transactionId],
    }).transactions[0]!;
    assert.deepEqual(afterFailure.tags, before.tags);
    assert.equal(afterFailure.display.status, "supported");
    if (afterFailure.display.status !== "supported") throw new Error("Expected display after failed rebuild.");
    assert.equal(afterFailure.display.value, before.display.value);

    await runtime.rebuild();
    const afterRebuild = createCanonicalEnrichmentQuery(state.directory).current({
      transactionIds: [state.transactionId],
    }).transactions[0]!;
    assert.deepEqual(afterRebuild.tags, before.tags);
    assert.equal(afterRebuild.display.status, "supported");
    if (afterRebuild.display.status !== "supported") throw new Error("Expected display after rebuild.");
    assert.equal(afterRebuild.display.value, before.display.value);
    assert.deepEqual(afterRebuild.counterparties, before.counterparties);
  } finally {
    await dispose(state.directory);
  }
});
