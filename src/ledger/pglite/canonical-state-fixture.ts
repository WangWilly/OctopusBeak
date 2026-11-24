/**
 * Canonical state as the reuse and compaction checks compare it: every table
 * and what readers derive from the record copies, with generated ids named
 * by what they mean, so two stores built the same way compare equal.
 */
import { createHash } from "node:crypto";
import { listPGliteExpectedOccurrences } from "./canonical-source-store.ts";
import { captureSourceRecordIdsSql } from "./capture-manifest.ts";
import type { PGliteStore } from "./transaction.ts";

/** Tables that hold the record copies themselves; `canonicalState` compares what readers derive from them instead. */
export const RECORD_COPY_TABLES = new Set([
  "source_records",
  "source_record_scopes",
  "source_record_provenance",
  "assertion_provenance",
  "capture_source_record_manifests",
]);

/**
 * Columns no two runs agree on: a Canonical Reset stamps its commit with the
 * wall clock, and the others are digests over generated ids.
 */
const UNSTABLE_COLUMNS = new Set(["recorded_at_utc_us", "event_digest", "resolution_key", "relation_key"]);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 16);

/**
 * Every table as sorted rows, with each generated id replaced by a name built
 * from what the row means, so two runs of one scenario compare equal. A Source
 * Record is named by its content, not by the capture that stores it. Each
 * `extra` query returns one `row` per entry, named the same way.
 */
export async function canonicalState(
  store: PGliteStore,
  extra: Readonly<Record<string, string>> = {},
): Promise<Record<string, readonly string[]>> {
  const names = new Map<string, string>();
  const name = async (sql: string) => {
    for (const row of (await store.query<{ id: string; name: string }>(sql)).rows) names.set(row.id, row.name);
  };
  const named = (alias: string) => `encode(${alias}, 'hex') AS id`;
  await name(`SELECT ${named("commit_id")}, 'commit#' || commit_sequence AS name FROM canonical_commits`);
  await name(`SELECT ${named("capture_id")}, 'capture:' || capture_key AS name FROM source_captures`);
  await name(`SELECT ${named("scope.scope_id")}, 'scope:' || capture.capture_key AS name
                FROM capture_scopes scope JOIN source_captures capture ON capture.capture_id = scope.capture_id`);
  await name(`SELECT ${named("source_connection_id")}, 'connection:' || integration_namespace AS name FROM source_connections`);
  await name(`SELECT ${named("identity_epoch_id")}, 'epoch:' || epoch_key AS name FROM identity_epochs`);
  await name(`SELECT ${named("source_subject_id")}, 'subject:' || stream || '/' || record_kind AS name FROM source_subjects`);
  await name(`SELECT ${named("account_id")}, 'account:' || stream || '/' || source_account_key AS name FROM financial_accounts`);
  await name(`SELECT ${named("transaction_id")}, 'transaction:' || source_sequence AS name FROM financial_transactions`);
  await name(`SELECT ${named("revision.revision_id")}, 'revision:' || financial.source_sequence || '#' || revision.revision_number AS name
                FROM transaction_revisions revision
                JOIN financial_transactions financial ON financial.transaction_id = revision.transaction_id`);
  await name(`SELECT ${named("assertion.assertion_id")},
                     'assertion:' || assertion.origin || '/' || assertion.field_name || '/'
                       || COALESCE(financial.source_sequence, '') || '#' || COALESCE(revision.revision_number::text, '')
                       || '/' || COALESCE(assertion.value_text, '') AS name
                FROM assertions assertion
                LEFT JOIN financial_transactions financial ON financial.transaction_id = assertion.transaction_id
                LEFT JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id`);
  await name(`SELECT ${named("coverage.coverage_id")},
                     'coverage:' || capture.capture_key || '/' || coverage.scope_key || '/' || coverage.scope_start AS name
                FROM source_occurrence_group_coverages coverage
                JOIN source_captures capture ON capture.capture_id = coverage.capture_id`);
  await name(`SELECT ${named("observation_id")}, 'balance:' || observation_key || '/' || balance_kind AS name FROM balance_observations`);
  const records = await store.query<{ id: string; occurrence_key: string; content: Record<string, unknown> }>(
    `SELECT ${named("source_record_id")}, occurrence_key,
            to_jsonb(record) - 'source_record_id' - 'capture_id' - 'commit_id' AS content
       FROM source_records record`,
  );
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") {
      const id = /^\\x([0-9a-f]{32})$/u.exec(value)?.[1];
      if (id !== undefined) return names.get(id) ?? "<generated id>";
      // Ids also appear as UUID text inside JSON a row stores as a string.
      return value.replace(
        /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gu,
        (uuid) => names.get(uuid.replaceAll("-", "")) ?? "<generated id>",
      );
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !UNSTABLE_COLUMNS.has(key))
        .map(([key, nested]) => [key, normalize(nested)]));
    return value;
  };
  for (const record of records.rows)
    names.set(record.id, `record:${record.occurrence_key}/${digest(normalize(record.content))}`);
  const rows = async (sql: string, params: readonly unknown[] = []) =>
    (await store.query<{ row: unknown }>(sql, [...params])).rows.map(({ row }) => JSON.stringify(normalize(row))).sort();

  const state: Record<string, readonly string[]> = {};
  const tables = await store.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  for (const { name: table } of tables.rows)
    if (!RECORD_COPY_TABLES.has(table)) state[table] = await rows(`SELECT to_jsonb(entry) AS row FROM "${table}" entry`);

  state["distinct source records"] = [...new Set(records.rows.map((record) => names.get(record.id)!))].sort();
  // What a capture saw: the records it owns or reused, each with the account its scope row names.
  state["capture members"] = await rows(
    `SELECT jsonb_build_object('capture', capture.capture_id, 'record', member.source_record_id,
                               'account', record_scope.account_id) AS row
       FROM source_captures capture
       JOIN LATERAL (${captureSourceRecordIdsSql("capture.capture_id")}) member ON TRUE
       JOIN source_record_scopes record_scope ON record_scope.source_record_id = member.source_record_id`,
  );
  // The assertions a capture saw, which withdrawal by omission reads (ADR 0008).
  state["capture sightings"] = [...new Set(await rows(
    `SELECT jsonb_build_object('capture', capture.capture_id, 'assertion', provenance.assertion_id) AS row
       FROM source_captures capture
       JOIN LATERAL (${captureSourceRecordIdsSql("capture.capture_id")}) member ON TRUE
       JOIN assertion_provenance provenance ON provenance.source_record_id = member.source_record_id`,
  ))];
  state["assertion sources"] = [...new Set(await rows(
    `SELECT to_jsonb(provenance) - 'commit_id' AS row FROM assertion_provenance provenance`,
  ))];
  const coverages = await store.query<{
    subject: string;
    record_kind: string;
    scope_key: string;
    contract_version: string;
    bucket_inventory_json: string;
  }>(
    `SELECT DISTINCT encode(source_subject_id, 'hex') AS subject, record_kind, scope_key, contract_version, bucket_inventory_json
       FROM source_occurrence_group_coverages WHERE bucket_inventory_json IS NOT NULL`,
  );
  const expected: string[] = [];
  for (const coverage of coverages.rows) {
    const bucketKeys = JSON.parse(coverage.bucket_inventory_json) as string[];
    const occurrences = await store.transaction((transaction) => listPGliteExpectedOccurrences(
      transaction,
      Uint8Array.from(Buffer.from(coverage.subject, "hex")),
      coverage.record_kind,
      { scopeKey: coverage.scope_key, contractVersion: coverage.contract_version, bucketKeys },
    ));
    for (const occurrence of occurrences)
      expected.push(JSON.stringify({
        ...occurrence,
        coverage: [names.get(coverage.subject), coverage.contract_version, bucketKeys],
        sourceRecordId: names.get(occurrence.sourceRecordId.replaceAll("-", "")),
        transactionId: occurrence.transactionId && names.get(occurrence.transactionId.replaceAll("-", "")),
      }));
  }
  state["expected occurrences"] = expected.sort();
  for (const [key, sql] of Object.entries(extra)) state[key] = await rows(sql);
  return state;
}
