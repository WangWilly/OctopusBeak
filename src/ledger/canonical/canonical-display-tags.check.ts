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
import { CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION } from "./transaction-taxonomy.ts";

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

test("grouped roles keep member taxonomy and bind automatic displays to the selected member", async () => {
  const state = await fixture();
  try {
    const evidence = {
      kind: "description",
      sourceRecordId: state.sourceRecordId,
      sourceValue: "Synthetic Cathay deposit description",
      contractVersion: CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
    } as const;
    await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/grouped-member-role",
      declaredSubjects: [{ transactionId: state.transactionId, fields: ["kind", "counterparty_role"] }],
      outputs: [
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
          participations: [
            {
              participationKey: "merchant-1",
              role: "merchant",
              observedName: "Merchant",
              counterparty: {
                producerNamespace: "grouped-test",
                producerEntityKey: "merchant-1",
                displayName: "Merchant",
              },
            },
            {
              participationKey: "marketplace-1",
              role: "marketplace",
              observedName: "Marketplace",
              counterparty: {
                producerNamespace: "grouped-test",
                producerEntityKey: "marketplace-1",
                displayName: "Marketplace",
              },
            },
            {
              participationKey: "institution-1",
              role: "financial_institution",
              observedName: "Cathay Bank",
              counterparty: {
                producerNamespace: "grouped-test",
                producerEntityKey: "institution-1",
                displayName: "Cathay Bank",
              },
            },
          ],
        },
      ],
    });
    const db = openCanonicalDatabase(state.directory, { readOnly: true });
    try {
      const members = db.prepare(`
        SELECT participation.role_code, typed.taxonomy_code
          FROM counterparty_participations participation
          JOIN counterparty_participation_taxonomy_values typed
            ON typed.participation_id = participation.participation_id
         WHERE participation.transaction_id = ?
         ORDER BY participation.participation_key
      `).all(Buffer.from(state.transactionId.replaceAll("-", ""), "hex")) as Array<Record<string, unknown>>;
      assert.deepEqual(members.map((row) => [row.role_code, row.taxonomy_code]), [
        ["financial_institution", "financial_institution"],
        ["marketplace", "marketplace"],
        ["merchant", "merchant"],
      ]);
    } finally {
      db.close();
    }
    const grouped = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.deepEqual(grouped.counterparties.map((row) => row.taxonomyCode), ["merchant", "marketplace", "financial_institution"]);
    assert.equal(grouped.display.status, "fallback");

    await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/grouped-member-display",
      declaredSubjects: [{ transactionId: state.transactionId, fields: ["counterparty_display"] }],
      outputs: [{
        transactionId: state.transactionId,
        field: "counterparty_display",
        origin: "derived",
        value: "Selected merchant",
        participationKey: "merchant-1",
        counterparty: {
          producerNamespace: "grouped-test",
          producerEntityKey: "merchant-1",
        },
        confidenceBasisPoints: 9_000,
        evidence,
      }],
    });
    const selectedResult = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] });
    const selected = selectedResult.transactions[0]!;
    assert.equal(selected.display.status, "supported");
    if (selected.display.status !== "supported") throw new Error("Expected selected member display.");
    assert.equal(selected.display.value, "Selected merchant");
    assert.equal(selected.display.participationKey, "merchant-1");
    assert.equal(selected.display.referenceId, selected.counterparties[0]?.referenceId);

    await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/grouped-member-kind-change",
      declaredSubjects: [{ transactionId: state.transactionId, fields: ["kind"] }],
      outputs: [{
        transactionId: state.transactionId,
        field: "kind",
        origin: "derived",
        value: "transfer.internal",
        confidenceBasisPoints: 9_000,
        evidence,
      }],
    });
    const transfer = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.deepEqual(transfer.counterparties.map((row) => row.taxonomyCode), ["financial_institution", "merchant", "marketplace"]);
    assert.equal(transfer.display.status, "fallback");

    const beforeMismatch = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).knowledgePoint;
    await assert.rejects(
      commitCanonicalAutomaticEnrichmentRun(state.directory, {
        sourceConnectionKey: state.sourceConnectionKey,
        stream: "domestic-deposit",
        ruleLineage: "test/grouped-member-mismatch",
        declaredSubjects: [{ transactionId: state.transactionId, fields: ["counterparty_display"] }],
        outputs: [{
          transactionId: state.transactionId,
          field: "counterparty_display",
          origin: "derived",
          value: "Wrong member",
          participationKey: "merchant-1",
          counterparty: {
            producerNamespace: "grouped-test",
            producerEntityKey: "marketplace-1",
          },
          confidenceBasisPoints: 9_000,
          evidence,
        }],
      }),
      /participation binding/u,
    );
    assert.equal(createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).knowledgePoint, beforeMismatch);
    await createCanonicalProjectionRuntime(state.directory).rebuild();
    const rebuilt = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.equal(rebuilt.display.status, "fallback");
    if (rebuilt.display.status !== "fallback") throw new Error("Expected source fallback after Kind selection changed.");
    assert.match(rebuilt.display.value, /^Synthetic Cathay .+ description$/u);
    assert.deepEqual(rebuilt.counterparties, transfer.counterparties);
  } finally {
    await dispose(state.directory);
  }
});

test("versioned grouped contracts preserve source and derived role permutations", async () => {
  const state = await fixture();
  try {
    // The source-store fixture has a deliberately small retained payload. Add
    // the explicit source role field in this isolated fixture to exercise the
    // source grouped contract without changing the published source parser.
    const sourceDb = openCanonicalDatabase(state.directory);
    try {
      const row = sourceDb.prepare(
        "SELECT payload_json FROM source_records WHERE source_record_id = ?",
      ).get(Buffer.from(state.sourceRecordId.replaceAll("-", ""), "hex")) as { payload_json?: unknown };
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      payload.counterparty_role = "marketplace";
      sourceDb.prepare(
        "UPDATE source_records SET payload_json = ? WHERE source_record_id = ?",
      ).run(
        JSON.stringify(payload),
        Buffer.from(state.sourceRecordId.replaceAll("-", ""), "hex"),
      );
    } finally {
      sourceDb.close();
    }

    const source = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/grouped-source-contract",
      declaredSubjects: [{ transactionId: state.transactionId, fields: ["counterparty_role"] }],
      outputs: [{
        transactionId: state.transactionId,
        field: "counterparty_role",
        origin: "source",
        value: "marketplace",
        evidence: {
          kind: "explicit-source-field",
          sourceRecordId: state.sourceRecordId,
          sourceField: "counterparty_role",
          sourceValue: "marketplace",
          contractVersion: CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
        },
        participations: [
          {
            participationKey: "marketplace-source",
            role: "marketplace",
            observedName: "Marketplace source",
            counterparty: {
              producerNamespace: "source-marketplace",
              producerEntityKey: "marketplace-1",
            },
          },
          {
            participationKey: "merchant-source",
            role: "merchant",
            observedName: "Merchant source",
            counterparty: {
              producerNamespace: "source-merchant",
              producerEntityKey: "merchant-1",
            },
          },
        ],
      }],
    });
    const sourceCurrent = createCanonicalEnrichmentQuery(state.directory).current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.deepEqual(sourceCurrent.counterparties.map((row) => row.taxonomyCode), ["merchant", "marketplace"]);
    assert.equal(sourceCurrent.counterparties.every((row) => row.origin === "source"), true);
    const reopenedAfterSource = openCanonicalDatabase(state.directory, { readOnly: true });
    reopenedAfterSource.close();

    const derived = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/grouped-derived-contract",
      declaredSubjects: [{ transactionId: state.transactionId, fields: ["kind", "counterparty_role"] }],
      outputs: [
        {
          transactionId: state.transactionId,
          field: "kind",
          origin: "derived",
          value: "transfer.internal",
          confidenceBasisPoints: 9_000,
          evidence: {
            kind: "description",
            sourceRecordId: state.sourceRecordId,
            sourceValue: "Synthetic Cathay deposit description",
            contractVersion: "cathay/domestic-deposit/v1",
          },
        },
        {
          transactionId: state.transactionId,
          field: "counterparty_role",
          origin: "derived",
          value: "financial_institution",
          confidenceBasisPoints: 9_000,
          evidence: {
            kind: "description",
            sourceRecordId: state.sourceRecordId,
            sourceValue: "Synthetic Cathay deposit description",
            contractVersion: CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
          },
          // The first role is deliberately changed. Selection follows the
          // bounded Kind policy and therefore remains deterministic for the
          // same admitted member set.
          participations: [
            {
              participationKey: "institution-derived",
              role: "financial_institution",
              observedName: "Institution derived",
              counterparty: {
                producerNamespace: "derived-institution",
                producerEntityKey: "institution-1",
              },
            },
            {
              participationKey: "marketplace-derived",
              role: "marketplace",
              observedName: "Marketplace derived",
              counterparty: {
                producerNamespace: "derived-marketplace",
                producerEntityKey: "marketplace-1",
              },
            },
            {
              participationKey: "merchant-derived",
              role: "merchant",
              observedName: "Merchant derived",
              counterparty: {
                producerNamespace: "derived-merchant",
                producerEntityKey: "merchant-1",
              },
            },
          ],
        },
      ],
    });
    const query = createCanonicalEnrichmentQuery(state.directory);
    const current = query.current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.deepEqual(current.counterparties.map((row) => row.taxonomyCode), [
      "financial_institution", "merchant", "marketplace",
    ]);
    assert.equal(current.counterparties.every((row) => row.origin === "derived"), true);
    const historicalSource = query.historical({
      transactionIds: [state.transactionId],
      financialAt: "2026-12-31",
      knowledgeAt: source.commitSequence,
    }).transactions[0]!;
    assert.deepEqual(historicalSource.counterparties.map((row) => row.taxonomyCode), ["merchant", "marketplace"]);
    assert.equal(historicalSource.counterparties.every((row) => row.origin === "source"), true);
    const lineage = query.lineage({ transactionIds: [state.transactionId], financialAt: "2026-12-31", knowledgeAt: derived.commitSequence });
    const roleLineage = lineage.lineage?.filter((entry) => entry.field === "counterparty_role") ?? [];
    assert.deepEqual(roleLineage.map((entry) => entry.origin), ["source", "derived"]);
    assert.equal(roleLineage.every((entry) => Array.isArray(entry.participations) && entry.participations.length >= 2), true);

    const permutation = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/grouped-derived-permutation",
      declaredSubjects: [{ transactionId: state.transactionId, fields: ["counterparty_role"] }],
      outputs: [{
        transactionId: state.transactionId,
        field: "counterparty_role",
        origin: "derived",
        value: "merchant",
        confidenceBasisPoints: 9_000,
        evidence: {
          kind: "description",
          sourceRecordId: state.sourceRecordId,
          sourceValue: "Synthetic Cathay deposit description",
          contractVersion: CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
        },
        // The same supported members are reordered.  The transfer Kind policy
        // still selects the same role set deterministically.
        participations: [
          { participationKey: "merchant-derived", role: "merchant" },
          { participationKey: "institution-derived", role: "financial_institution" },
          { participationKey: "marketplace-derived", role: "marketplace" },
        ],
      }],
    });
    assert.ok(permutation.commitSequence > derived.commitSequence);
    const reordered = query.current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.deepEqual(reordered.counterparties.map((row) => row.taxonomyCode), current.counterparties.map((row) => row.taxonomyCode));

    const beforeRejected = query.current({ transactionIds: [state.transactionId] }).knowledgePoint;
    await assert.rejects(
      commitCanonicalAutomaticEnrichmentRun(state.directory, {
        sourceConnectionKey: state.sourceConnectionKey,
        stream: "domestic-deposit",
        ruleLineage: "test/grouped-unsupported-member",
        declaredSubjects: [{ transactionId: state.transactionId, fields: ["counterparty_role"] }],
        outputs: [{
          transactionId: state.transactionId,
          field: "counterparty_role",
          origin: "derived",
          value: "merchant",
          confidenceBasisPoints: 9_000,
          evidence: {
            kind: "description",
            sourceRecordId: state.sourceRecordId,
            sourceValue: "Synthetic Cathay deposit description",
            contractVersion: CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
          },
          participations: [
            { participationKey: "merchant-unsupported", role: "merchant" },
            { participationKey: "government-unsupported", role: "government" },
          ],
        }],
      }),
      /undeclared|versioned group contract/u,
    );
    assert.equal(query.current({ transactionIds: [state.transactionId] }).knowledgePoint, beforeRejected);
    await assert.rejects(
      commitCanonicalAutomaticEnrichmentRun(state.directory, {
        sourceConnectionKey: state.sourceConnectionKey,
        stream: "domestic-deposit",
        ruleLineage: "test/grouped-missing-contract",
        declaredSubjects: [{ transactionId: state.transactionId, fields: ["counterparty_role"] }],
        outputs: [{
          transactionId: state.transactionId,
          field: "counterparty_role",
          origin: "derived",
          value: "merchant",
          confidenceBasisPoints: 9_000,
          evidence: {
            kind: "description",
            sourceRecordId: state.sourceRecordId,
            sourceValue: "Synthetic Cathay deposit description",
            contractVersion: "cathay/domestic-deposit/v1",
          },
          participations: [
            { participationKey: "merchant-missing", role: "merchant" },
            { participationKey: "marketplace-missing", role: "marketplace" },
          ],
        }],
      }),
      /undeclared|versioned group contract/u,
    );
    assert.equal(query.current({ transactionIds: [state.transactionId] }).knowledgePoint, beforeRejected);
    await createCanonicalProjectionRuntime(state.directory).rebuild();
    const rebuilt = query.current({ transactionIds: [state.transactionId] }).transactions[0]!;
    assert.deepEqual(rebuilt.counterparties.map((row) => row.taxonomyCode), current.counterparties.map((row) => row.taxonomyCode));
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
