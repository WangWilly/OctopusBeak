import type { DatabaseSync } from "node:sqlite";

type ExactAmount = Readonly<{ coefficient: bigint; scale: number }>;

function exactAmount(
  coefficient: unknown,
  scale: unknown,
  label: string,
): ExactAmount {
  const coefficientText = String(coefficient ?? "");
  const scaleNumber = Number(scale);
  if (
    !/^(?:0|[1-9]\d*)$/u.test(coefficientText) ||
    !Number.isSafeInteger(scaleNumber) ||
    scaleNumber < 0 ||
    scaleNumber > 1_000
  )
    throw new Error(`Canonical categorization ${label} is not an exact amount.`);
  return { coefficient: BigInt(coefficientText), scale: scaleNumber };
}

function addExact(left: ExactAmount, right: ExactAmount): ExactAmount {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function equalExact(left: ExactAmount, right: ExactAmount): boolean {
  const scale = Math.max(left.scale, right.scale);
  return (
    left.coefficient * 10n ** BigInt(scale - left.scale) ===
    right.coefficient * 10n ** BigInt(scale - right.scale)
  );
}

function validateSelectedCategorizationAllocations(
  db: DatabaseSync,
  generationId: number,
  knowledgePoint: number,
): void {
  const selected = db
    .prepare(
      `WITH user_candidates AS (
         SELECT assertion.transaction_id, assertion.assertion_id,
                event_commit.commit_sequence, event.rowid AS event_rowid,
                ROW_NUMBER() OVER (
                  PARTITION BY assertion.transaction_id
                  ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
                ) AS candidate_rank,
                COUNT(*) OVER (PARTITION BY assertion.transaction_id) AS candidate_count
           FROM assertions assertion
           JOIN assertion_transitions event
             ON event.assertion_id = assertion.assertion_id
           JOIN canonical_commits event_commit
             ON event_commit.commit_id = event.commit_id
           JOIN projection_generation_transactions eligible
             ON eligible.generation_id = ?
            AND eligible.transaction_id = assertion.transaction_id
          WHERE assertion.field_name = 'category'
            AND assertion.origin = 'user'
            AND event_commit.commit_sequence <= ?
            AND event.event_kind NOT IN ('withdrawn', 'superseded')
            AND NOT EXISTS (
              SELECT 1
                FROM assertion_transitions newer_event
                JOIN canonical_commits newer_commit
                  ON newer_commit.commit_id = newer_event.commit_id
               WHERE newer_event.assertion_id = event.assertion_id
                 AND newer_commit.commit_sequence <= ?
                 AND (newer_commit.commit_sequence > event_commit.commit_sequence
                      OR (newer_commit.commit_sequence = event_commit.commit_sequence
                          AND newer_event.rowid > event.rowid))
            )
       ), selected AS (
         SELECT transaction_id, assertion_id
           FROM user_candidates
          WHERE candidate_rank = 1 AND candidate_count = 1
       )
       SELECT selected.transaction_id, selected.assertion_id,
              categorization.mode, categorization.allocation_set_id,
              revision.amount_coefficient, revision.amount_scale,
              revision.currency
         FROM selected
         JOIN transaction_categorization_values categorization
           ON categorization.assertion_id = selected.assertion_id
          AND categorization.transaction_id = selected.transaction_id
         JOIN projection_generation_transactions generation_tx
           ON generation_tx.generation_id = ?
          AND generation_tx.transaction_id = selected.transaction_id
         JOIN transaction_revisions revision
           ON revision.revision_id = generation_tx.revision_id
        WHERE categorization.mode = 'allocated'`,
    )
    .all(generationId, knowledgePoint, knowledgePoint, generationId) as Array<
    Record<string, unknown>
  >;
  const allocationSet = db.prepare(
    `SELECT allocation_set_id, assertion_id, transaction_id,
            booked_coefficient, booked_scale, booked_currency
       FROM category_allocation_sets
      WHERE allocation_set_id = ? AND assertion_id = ? AND transaction_id = ?`,
  );
  const components = db.prepare(
    `SELECT component_ordinal, category_code,
            amount_coefficient, amount_scale, amount_currency,
            booked_coefficient, booked_scale, booked_currency
       FROM category_allocation_components
      WHERE allocation_set_id = ?
      ORDER BY component_ordinal`,
  );
  for (const row of selected) {
    if (!(row.allocation_set_id instanceof Uint8Array))
      throw new Error("Canonical categorization allocation set is missing.");
    if (!(row.assertion_id instanceof Uint8Array) || !(row.transaction_id instanceof Uint8Array))
      throw new Error("Canonical categorization allocation identity is invalid.");
    const allocationSetId = row.allocation_set_id;
    const assertionId = row.assertion_id;
    const transactionId = row.transaction_id;
    const transactionAmount = exactAmount(
      row.amount_coefficient,
      row.amount_scale,
      "transaction amount",
    );
    const set = allocationSet.get(
      allocationSetId,
      assertionId,
      transactionId,
    ) as Record<string, unknown> | undefined;
    if (!set)
      throw new Error("Canonical categorization allocation ownership is invalid.");
    const setAmount = exactAmount(
      set.booked_coefficient,
      set.booked_scale,
      "allocation set amount",
    );
    if (
      String(set.booked_currency) !== String(row.currency) ||
      !equalExact(setAmount, transactionAmount)
    )
      throw new Error("Canonical categorization allocation set does not match the selected revision.");
    const rows = components.all(allocationSetId) as Array<Record<string, unknown>>;
    if (rows.length < 2)
      throw new Error("Canonical categorization allocation is incomplete.");
    const seen = new Set<string>();
    let total: ExactAmount = { coefficient: 0n, scale: 0 };
    for (const component of rows) {
      const categoryCode = String(component.category_code ?? "");
      if (!categoryCode || seen.has(categoryCode))
        throw new Error("Canonical categorization allocation has duplicate or missing targets.");
      seen.add(categoryCode);
      if (
        String(component.booked_currency) !== String(row.currency) ||
        component.component_ordinal === null ||
        component.component_ordinal === undefined
      )
        throw new Error("Canonical categorization allocation has incomplete booked facts.");
      const componentAmount = exactAmount(
        component.booked_coefficient,
        component.booked_scale,
        "allocation component",
      );
      // Validate the source amount as well; a malformed component must never
      // be rendered as a partial allocation merely because its booked fact is
      // arithmetically plausible.
      exactAmount(component.amount_coefficient, component.amount_scale, "allocation source amount");
      if (component.amount_currency === null || component.amount_currency === undefined)
        throw new Error("Canonical categorization allocation source currency is missing.");
      total = addExact(total, componentAmount);
    }
    if (!equalExact(total, transactionAmount))
      throw new Error("Canonical categorization allocation does not exactly reconcile.");
  }
}

type CategorizationGenerationRefresh = Readonly<{
  generationId: number;
  projectionCommitId: Uint8Array;
  knowledgePoint: number;
}>;

/**
 * Rebuild the Runtime-owned current categorization rows for one generation.
 * The immutable assertion and typed value tables remain the authority; this
 * table is a fully rebuildable selection cache bound to the generation's
 * selected financial revision.
 */
export function refreshCanonicalCategorizationGeneration(
  db: DatabaseSync,
  values: CategorizationGenerationRefresh,
): void {
  validateSelectedCategorizationAllocations(
    db,
    values.generationId,
    values.knowledgePoint,
  );
  db.prepare(
    "DELETE FROM projection_generation_transaction_categorizations WHERE generation_id = ?",
  ).run(values.generationId);
  db.prepare(
    `WITH user_candidates AS (
       SELECT assertion.transaction_id, assertion.assertion_id,
              event.commit_id AS projection_commit_id,
              event_commit.commit_sequence AS projection_commit_sequence,
              ROW_NUMBER() OVER (
                PARTITION BY assertion.transaction_id
                ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
              ) AS candidate_rank,
              COUNT(*) OVER (
                PARTITION BY assertion.transaction_id
              ) AS candidate_count
         FROM assertions assertion
         JOIN assertion_transitions event
           ON event.assertion_id = assertion.assertion_id
         JOIN canonical_commits event_commit
           ON event_commit.commit_id = event.commit_id
         JOIN projection_generation_transactions eligible
           ON eligible.generation_id = ?
          AND eligible.transaction_id = assertion.transaction_id
        WHERE assertion.field_name = 'category'
          AND assertion.origin = 'user'
          AND event_commit.commit_sequence <= ?
          AND event.event_kind NOT IN ('withdrawn', 'superseded')
          AND NOT EXISTS (
            SELECT 1
              FROM assertion_transitions newer_event
              JOIN canonical_commits newer_commit
                ON newer_commit.commit_id = newer_event.commit_id
             WHERE newer_event.assertion_id = event.assertion_id
               AND newer_commit.commit_sequence <= ?
               AND (newer_commit.commit_sequence > event_commit.commit_sequence
                    OR (newer_commit.commit_sequence = event_commit.commit_sequence
                        AND newer_event.rowid > event.rowid))
          )
     ), selected AS (
       SELECT transaction_id, assertion_id, projection_commit_id,
              projection_commit_sequence
         FROM user_candidates
        WHERE candidate_rank = 1 AND candidate_count = 1
     )
     INSERT INTO projection_generation_transaction_categorizations(
       generation_id, transaction_id, revision_id, assertion_id, mode,
       category_code, taxonomy_id, taxonomy_version, allocation_set_id,
       component_ordinal, amount_coefficient, amount_scale, amount_currency,
       booked_coefficient, booked_scale, booked_currency,
       conversion_evidence_kind, conversion_evidence_id,
       conversion_from_currency, conversion_to_currency,
       conversion_evidence_json, conversion_id, projection_commit_id
     )
     SELECT ?, selected.transaction_id, generation_tx.revision_id,
            selected.assertion_id, categorization.mode,
            CASE WHEN categorization.mode = 'single' THEN categorization.category_code
                 ELSE component.category_code END,
            categorization.taxonomy_id, categorization.taxonomy_version,
            categorization.allocation_set_id,
            CASE WHEN categorization.mode = 'single' THEN 0
                 ELSE component.component_ordinal END,
            component.amount_coefficient, component.amount_scale,
            component.amount_currency, component.booked_coefficient,
            component.booked_scale, component.booked_currency,
            component.conversion_evidence_kind, component.conversion_evidence_id,
            component.conversion_from_currency, component.conversion_to_currency,
            component.conversion_evidence_json, component.conversion_id,
            selected.projection_commit_id
       FROM selected
       JOIN projection_generation_transactions generation_tx
         ON generation_tx.generation_id = ?
        AND generation_tx.transaction_id = selected.transaction_id
       JOIN transaction_categorization_values categorization
         ON categorization.assertion_id = selected.assertion_id
        AND categorization.transaction_id = selected.transaction_id
       LEFT JOIN category_allocation_sets allocation_set
         ON allocation_set.allocation_set_id = categorization.allocation_set_id
        AND allocation_set.assertion_id = categorization.assertion_id
        AND allocation_set.transaction_id = categorization.transaction_id
       LEFT JOIN category_allocation_components component
         ON component.allocation_set_id = allocation_set.allocation_set_id
      WHERE categorization.mode = 'single'
         OR component.component_ordinal IS NOT NULL
      ORDER BY selected.transaction_id, component.component_ordinal`,
  ).run(
    values.generationId,
    values.knowledgePoint,
    values.knowledgePoint,
    values.generationId,
    values.generationId,
  );
}
