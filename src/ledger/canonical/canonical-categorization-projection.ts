import type { DatabaseSync } from "node:sqlite";

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
       LEFT JOIN category_allocation_components component
         ON component.allocation_set_id = categorization.allocation_set_id
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
