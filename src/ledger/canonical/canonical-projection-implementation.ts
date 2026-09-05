import { DatabaseSync } from "node:sqlite";
import { withCanonicalWriterQueue } from "./canonical-runtime.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import {
  canonicalSqlitePath,
  uuidV7,
  blob,
  recordProjectionGenerationEvent,
  rejectStrayProjectionGenerations,
  validateGenerationTransactionIntegrity,
  validateGenerationFieldCompleteness,
  validateSelectedAssertionProvenance,
  validateGenerationExactAmounts,
  validateCanonicalAuthorityRoutes,
  validateGenerationFieldIntegrity,
  validateGenerationLifecycleCoordinates,
  validateUserAssertionProvenanceAuthority,
  validateProjectionGenerationProvenance,
  selectAssertionAsOf,
  type CanonicalId,
} from "./canonical-schema-implementation.ts";
import { openCanonicalDatabase } from "./canonical-database.ts";
import type {
  CanonicalProjectionRebuildFailureInjection,
  CanonicalProjectionRebuildOptions,
  CanonicalProjectionRebuildResult,
} from "./canonical-projection-contract.ts";

function parseRfc3339UtcMicros(value: string, label: string): number {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match)
    throw new Error(
      `${label} must be RFC3339 with an explicit UTC designator or numeric offset.`,
    );
  const civil = `${match[1]}T${match[2]}`;
  if ((match[3]?.length ?? 0) > 6)
    throw new Error(`${label} exceeds integer microsecond precision.`);
  const calendarShape = new Date(`${civil}Z`);
  if (Number.isNaN(calendarShape.getTime()) || calendarShape.toISOString().slice(0, 19) !== civil)
    throw new Error(`${label} must be a valid RFC3339 timestamp.`);
  if (match[4] !== "Z") {
    const [hours, minutes] = match[4].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59)
      throw new Error(`${label} has an invalid numeric offset.`);
  }
  const epochMilliseconds = Date.parse(`${civil}${match[4]}`);
  if (!Number.isSafeInteger(epochMilliseconds))
    throw new Error(`${label} is outside the supported instant range.`);
  const fractionMicros = BigInt((match[3] ?? "").slice(0, 6).padEnd(6, "0"));
  const micros = BigInt(epochMilliseconds) * 1000n + fractionMicros;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) || micros < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error(`${label} microseconds exceed the safe SQLite binding range.`);
  return Number(micros);
}

function recordedAtUtcUs(value: string): number {
  return parseRfc3339UtcMicros(value, "Canonical admission clock");
}

type HistoricalAssertionOrigin = "derived" | "user";
export type SelectedHistoricalField = {
  value: string;
  origin: HistoricalAssertionOrigin;
  commitSequence: number;
};

function selectHistoricalFieldByOrigin(
  db: DatabaseSync,
  transactionId: unknown,
  field: "display_name" | "note",
  knowledgeAt: number,
  origin: HistoricalAssertionOrigin,
): SelectedHistoricalField | undefined {
  const selected = selectAssertionAsOf(
    db,
    transactionId,
    field,
    knowledgeAt,
    origin,
  );
  return selected
    ? {
        value: selected.value_text,
        origin,
        commitSequence: selected.commitSequence,
      }
    : undefined;
}

function selectedHistoricalField(
  db: DatabaseSync,
  transactionId: unknown,
  field: "display_name" | "note",
  knowledgeAt: number,
): SelectedHistoricalField | undefined {
  return (
    selectHistoricalFieldByOrigin(
      db,
      transactionId,
      field,
      knowledgeAt,
      "user",
    ) ??
    selectHistoricalFieldByOrigin(
      db,
      transactionId,
      field,
      knowledgeAt,
      "derived",
    )
  );
}

export function addSelectedFields(
  db: DatabaseSync,
  row: Record<string, unknown>,
  knowledgeAt?: number,
  currentFields?: ReadonlyMap<string, SelectedHistoricalField>,
): Record<string, unknown> {
  const transactionKey = Buffer.from(
    row.transaction_id as Uint8Array,
  ).toString("hex");
  const display =
    knowledgeAt === undefined
      ? currentFields?.get(`${transactionKey}:display_name`)
      : selectedHistoricalField(
          db,
          row.transaction_id,
          "display_name",
          knowledgeAt,
        );
  const note =
    knowledgeAt === undefined
      ? currentFields?.get(`${transactionKey}:note`)
      : selectedHistoricalField(db, row.transaction_id, "note", knowledgeAt);
  return {
    ...row,
    selected_display_label: display?.value,
    selected_display_origin: display?.origin,
    selected_display_commit_sequence: display?.commitSequence,
    selected_note: note?.value,
    selected_note_origin: note?.origin,
    selected_note_commit_sequence: note?.commitSequence,
  };
}

function rebuildFailure(
  stage: CanonicalProjectionRebuildFailureInjection | undefined,
  expected: CanonicalProjectionRebuildFailureInjection[],
): void {
  if (stage !== undefined && expected.includes(stage))
    throw new Error(`Injected projection rebuild failure at ${stage}.`);
}

function rebuildCathayCanonicalProjectionOnce(
  ledgerDir: string,
  options: CanonicalProjectionRebuildOptions,
): CanonicalProjectionRebuildResult {
  const db = openCanonicalDatabase(ledgerDir, { runtime: options });
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    rejectStrayProjectionGenerations(db);
    const latest = db
      .prepare(
        "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
      )
      .get() as { max_sequence?: number };
    const currentKnowledgePoint = Number(latest.max_sequence ?? 0);
    const cutoff = options.cutoff?.commitSequence ?? currentKnowledgePoint;
    if (
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      cutoff > currentKnowledgePoint
    )
      throw new Error(
        "Projection rebuild cutoff must be a retained Canonical Knowledge Point.",
      );
    const active = db
      .prepare(
        "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
      )
      .get() as { generation_id?: number } | undefined;
    if (!active)
      throw new Error("Projection rebuild requires an active generation.");
    const previousGeneration = Number(active.generation_id);
    const generation =
      Number(
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(generation_id), 0) AS generation_id FROM projection_generations",
            )
            .get() as { generation_id?: number }
        ).generation_id ?? 0,
      ) + 1;
    const commitId = uuidV7();
    const commitSequence = currentKnowledgePoint + 1;
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, 'canonical/projection/v1', 'projection_rebuild')",
    ).run(
      commitId,
      commitSequence,
      recordedAtUtcUs((options.clock ?? (() => new Date().toISOString()))()),
    );
    db.prepare(
      `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id)
      VALUES (?, 'building', ?, 'canonical/projection/v1', ?)`,
    ).run(generation, cutoff, commitId);
    recordProjectionGenerationEvent(
      db,
      generation,
      "created",
      "rebuild",
      commitId,
    );
    rebuildFailure(options.injectFailure, [
      "creation",
      "after-generation-creation",
    ]);
    db.prepare(
      `INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id)
      SELECT ?, t.transaction_id, revision.revision_id, ?, revision.commit_id
      FROM financial_transactions t JOIN transaction_revisions revision ON revision.transaction_id = t.transaction_id
      JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
      JOIN assertions source_assertion ON source_assertion.revision_id = revision.revision_id AND source_assertion.origin = 'source'
      WHERE revision_commit.commit_sequence <= ?
        AND NOT EXISTS (SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
          WHERE newer.transaction_id = revision.transaction_id AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > revision_commit.commit_sequence)
        AND COALESCE((SELECT transition.event_kind FROM assertion_transitions transition JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
          WHERE transition.assertion_id = source_assertion.assertion_id AND transition_commit.commit_sequence <= ?
          ORDER BY transition_commit.commit_sequence DESC, transition.event_id DESC LIMIT 1), 'observed') <> 'withdrawn'`,
    ).run(generation, commitId, cutoff, cutoff, cutoff);
    db.prepare(
      `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
      SELECT generation_id, transaction_id, revision_id, projection_commit_id, 'rebuild'
      FROM projection_generation_transactions WHERE generation_id = ?`,
    ).run(generation);
    db.prepare(
      `INSERT INTO current_loan_accounts(
         generation_id, account_id, projection_commit_id, created_commit_id
       )
       SELECT ?, identity.account_id, ?, identity.created_commit_id
       FROM loan_account_identities identity
       JOIN canonical_commits created ON created.commit_id = identity.created_commit_id
       WHERE identity.account_type = 'loan' AND identity.stream = 'loan'
         AND created.commit_sequence <= ?`,
    ).run(generation, commitId, cutoff);
    db.prepare(
      `INSERT INTO current_loan_balance_observations(
         generation_id, account_id, balance_kind, observation_id, revision_id,
         projection_commit_id, revision_commit_id
       )
       SELECT ?, ranked.account_id, ranked.balance_kind, ranked.observation_id,
              ranked.revision_id, ?, ranked.commit_id
       FROM (
         SELECT observation.account_id, observation.balance_kind,
                observation.observation_id, revision.revision_id, revision.commit_id,
                ROW_NUMBER() OVER (
                  PARTITION BY observation.account_id, observation.balance_kind
                  ORDER BY revision.effective_at DESC,
                           revision_commit.commit_sequence DESC,
                           COALESCE(balance_fact.occurrence_index, -1) DESC,
                           balance_record.occurrence_key DESC,
                           observation.observation_key DESC,
                           hex(revision.revision_id) DESC
                ) AS rank
         FROM balance_observations observation
         JOIN balance_observation_revisions revision
           ON revision.observation_id = observation.observation_id
         JOIN canonical_commits revision_commit
           ON revision_commit.commit_id = revision.commit_id
         JOIN source_records balance_record
           ON balance_record.source_record_id = revision.source_record_id
         LEFT JOIN loan_transaction_facts balance_fact
           ON balance_fact.revision_id = (
             SELECT transaction_revision.revision_id
             FROM transaction_revisions transaction_revision
             WHERE transaction_revision.source_record_id = revision.source_record_id
             ORDER BY transaction_revision.revision_number DESC
             LIMIT 1
           )
         WHERE revision_commit.commit_sequence <= ?
       ) ranked WHERE ranked.rank = 1`,
    ).run(generation, commitId, cutoff);
    db.prepare(
      `INSERT INTO current_loan_relations(
         generation_id, relation_id, projection_commit_id, relation_commit_id
       )
       SELECT ?, relation.relation_id, ?, relation.commit_id
       FROM transaction_relations relation
       JOIN canonical_commits relation_commit
         ON relation_commit.commit_id = relation.commit_id
       WHERE relation_commit.commit_sequence <= ?
         AND COALESCE((
           SELECT lifecycle.event_kind
             FROM loan_repayment_relation_events lifecycle
             JOIN canonical_commits lifecycle_commit
               ON lifecycle_commit.commit_id = lifecycle.commit_id
            WHERE lifecycle.relation_id = relation.relation_id
              AND lifecycle_commit.commit_sequence <= ?
            ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC
            LIMIT 1
         ), 'observed') NOT IN ('withdrawn', 'superseded')`,
    ).run(generation, commitId, cutoff, cutoff);
    db.prepare(
      `INSERT INTO current_loan_repayment_settlement_groups(
         generation_id, settlement_group_id, projection_commit_id
       )
       SELECT ?, group_row.settlement_group_id, ?
       FROM loan_repayment_settlement_groups group_row
       JOIN canonical_commits created_commit
         ON created_commit.commit_id = group_row.created_commit_id
       WHERE created_commit.commit_sequence <= ?
         AND COALESCE((
           SELECT lifecycle.event_kind
             FROM loan_repayment_relation_events lifecycle
             JOIN canonical_commits lifecycle_commit
               ON lifecycle_commit.commit_id = lifecycle.commit_id
            WHERE lifecycle.settlement_group_id = group_row.settlement_group_id
              AND lifecycle_commit.commit_sequence <= ?
            ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC
            LIMIT 1
         ), 'observed') NOT IN ('withdrawn', 'superseded')`,
    ).run(generation, commitId, cutoff, cutoff);
    const insertField =
      db.prepare(`INSERT INTO projection_generation_transaction_fields(generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const generationTransactions = db
      .prepare(
        "SELECT transaction_id FROM projection_generation_transactions WHERE generation_id = ?",
      )
      .all(generation) as Array<Record<string, unknown>>;
    let fieldCount = 0;
    for (const transaction of generationTransactions) {
      for (const field of ["display_name", "note"] as const) {
        const selected =
          selectAssertionAsOf(
            db,
            blob(transaction.transaction_id),
            field,
            cutoff,
            "user",
          ) ??
          selectAssertionAsOf(
            db,
            blob(transaction.transaction_id),
            field,
            cutoff,
            "derived",
          );
        if (!selected) continue;
        const assertion = blob(selected.assertion_id);
        insertField.run(
          generation,
          blob(transaction.transaction_id),
          field,
          selected.value_text,
          selected.origin,
          selected.origin === "derived" ? assertion : null,
          selected.origin === "user" ? assertion : null,
          commitId,
        );
        fieldCount += 1;
      }
    }
    rebuildFailure(options.injectFailure, [
      "population",
      "after-generation-population",
    ]);
    const dangling = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM projection_generation_transactions projected
      LEFT JOIN financial_transactions transaction_row ON transaction_row.transaction_id = projected.transaction_id
      LEFT JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
      WHERE projected.generation_id = ? AND (transaction_row.transaction_id IS NULL OR revision.revision_id IS NULL OR revision.transaction_id <> projected.transaction_id)`,
          )
          .get(generation) as { count?: number }
      ).count ?? 0,
    );
    if (dangling !== 0)
      throw new Error(
        "Projection rebuild validation failed for references or exact arithmetic.",
      );
    validateGenerationTransactionIntegrity(db, generation, cutoff);
    validateGenerationFieldCompleteness(db, generation, cutoff);
    validateSelectedAssertionProvenance(db, generation, cutoff);
    validateGenerationExactAmounts(db, generation);
    validateCanonicalAuthorityRoutes(db, generation);
    validateGenerationFieldIntegrity(db, generation);
    validateGenerationLifecycleCoordinates(db, generation);
    validateUserAssertionProvenanceAuthority(db);
    const duplicate = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (SELECT transaction_id FROM projection_generation_transactions WHERE generation_id = ? GROUP BY transaction_id HAVING COUNT(*) <> 1)`,
          )
          .get(generation) as { count?: number }
      ).count ?? 0,
    );
    if (duplicate !== 0)
      throw new Error(
        "Projection rebuild validation found duplicate transaction authority.",
      );
    rebuildFailure(options.injectFailure, ["validation", "after-validation"]);
    db.prepare(
      "UPDATE projection_generations SET status = 'validated', validated_commit_id = ? WHERE generation_id = ?",
    ).run(commitId, generation);
    recordProjectionGenerationEvent(
      db,
      generation,
      "validated",
      "rebuild",
      commitId,
    );
    validateProjectionGenerationProvenance(db, generation);
    rebuildFailure(options.injectFailure, ["pre-switch"]);
    db.prepare(
      "UPDATE projection_generations SET status = 'retired' WHERE status = 'active'",
    ).run();
    db.prepare(
      "UPDATE projection_generations SET status = 'active', switched_commit_id = ? WHERE generation_id = ?",
    ).run(commitId, generation);
    recordProjectionGenerationEvent(
      db,
      generation,
      "switched",
      "rebuild",
      commitId,
    );
    db.prepare(
      "UPDATE active_projection_generation SET generation_id = ?, switched_commit_id = ? WHERE singleton_id = 1",
    ).run(generation, commitId);
    db.prepare("DELETE FROM current_transactions").run();
    db.prepare(
      `INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id)
      SELECT transaction_id, revision_id, ?, projection_commit_id, revision_commit_id FROM projection_generation_transactions WHERE generation_id = ?`,
    ).run(commitId, generation);
    db.prepare("DELETE FROM current_transaction_fields").run();
    db.prepare(
      `INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
      SELECT transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, ? FROM projection_generation_transaction_fields WHERE generation_id = ?`,
    ).run(commitId, generation);
    db.prepare(
      "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id",
    ).run(commitId);
    validateProjectionGenerationProvenance(db, generation);
    db.exec("COMMIT");
    inTransaction = false;
    return {
      status: "switched",
      previousGeneration,
      generation,
      cutoffCommitSequence: cutoff,
      commitSequence,
      transactionCount: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM projection_generation_transactions WHERE generation_id = ?",
            )
            .get(generation) as { count?: number }
        ).count ?? 0,
      ),
      fieldCount,
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function canonicalProjectionRuntimeRebuildInternal(
  ledgerDir: string,
  options: CanonicalProjectionRebuildOptions = {},
): Promise<CanonicalProjectionRebuildResult> {
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    () => rebuildCathayCanonicalProjectionOnce(ledgerDir, options),
    options,
  );
}

function syncActiveProjectionFromCompatibility(
  db: DatabaseSync,
  projectionCommitId: CanonicalId,
): void {
  let pointer = db
    .prepare(
      "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as { generation_id?: number } | undefined;
  const createdGeneration = !pointer;
  if (!pointer) {
    const commitSequence = Number(
      (
        db
          .prepare(
            "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?",
          )
          .get(projectionCommitId) as { commit_sequence?: number } | undefined
      )?.commit_sequence ?? 0,
    );
    db.prepare(
      `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id, switched_commit_id)
      VALUES (1, 'active', ?, 'canonical/projection/v1', ?, ?, ?)`,
    ).run(
      commitSequence,
      projectionCommitId,
      projectionCommitId,
      projectionCommitId,
    );
    db.prepare(
      "INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id) VALUES (1, 1, ?)",
    ).run(projectionCommitId);
    recordProjectionGenerationEvent(
      db,
      1,
      "created",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      1,
      "validated",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      1,
      "switched",
      "routine",
      projectionCommitId,
    );
    pointer = { generation_id: 1 };
  }
  const generationId = Number(pointer.generation_id);
  const generation = db
    .prepare(
      "SELECT status FROM projection_generations WHERE generation_id = ?",
    )
    .get(generationId) as { status?: string } | undefined;
  if (!generation || generation.status !== "active")
    throw new Error("Canonical active projection generation is not writable.");
  const generationState = db
    .prepare(
      "SELECT created_commit_id, switched_commit_id FROM projection_generations WHERE generation_id = ?",
    )
    .get(generationId) as
    { created_commit_id?: unknown; switched_commit_id?: unknown } | undefined;
  const initializesGeneration = !generationState?.switched_commit_id;
  if (initializesGeneration) {
    db.prepare(
      "UPDATE projection_generations SET created_commit_id = COALESCE(created_commit_id, ?), validated_commit_id = COALESCE(validated_commit_id, ?), switched_commit_id = ? WHERE generation_id = ?",
    ).run(
      projectionCommitId,
      projectionCommitId,
      projectionCommitId,
      generationId,
    );
    recordProjectionGenerationEvent(
      db,
      generationId,
      "created",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      generationId,
      "validated",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      generationId,
      "switched",
      "routine",
      projectionCommitId,
    );
    db.prepare(
      "UPDATE active_projection_generation SET switched_commit_id = ? WHERE singleton_id = 1",
    ).run(projectionCommitId);
  }
  db.prepare(
    "UPDATE projection_generations SET build_cutoff_commit_sequence = (SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?) WHERE generation_id = ?",
  ).run(projectionCommitId, generationId);
  db.prepare(
    "DELETE FROM projection_generation_transaction_fields WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    "DELETE FROM projection_generation_transaction_selection WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    "DELETE FROM projection_generation_transactions WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    `INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id)
    SELECT ?, transaction_id, revision_id, projection_commit_id, revision_commit_id FROM current_transactions`,
  ).run(generationId);
  db.prepare(
    `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
    SELECT ?, current_row.transaction_id, current_row.revision_id, current_row.projection_commit_id,
      CASE WHEN current_row.projection_commit_id = generation.switched_commit_id THEN 'rebuild' ELSE 'source_lifecycle' END
    FROM current_transactions current_row JOIN projection_generations generation ON generation.generation_id = ?`,
  ).run(generationId, generationId);
  db.prepare(
    `INSERT INTO projection_generation_transaction_fields(generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
    SELECT ?, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields`,
  ).run(generationId);
  if (!initializesGeneration && !createdGeneration)
    recordProjectionGenerationEvent(
      db,
      generationId,
      "knowledge",
      "routine",
      projectionCommitId,
    );
}

export function canonicalProjectionRuntimeSyncInternal(
  db: DatabaseSync,
  projectionCommitId: Uint8Array,
): void {
  assertValidatedCanonicalDatabase(db);
  syncActiveProjectionFromCompatibility(db, blob(projectionCommitId));
}
