# Canonical Source-Version Lineage and Compaction Design

Date: 2026-07-21
Status: Approved in conversation; awaiting written-spec review

## Goal

Stop identical CSV imports from continuously growing `source_file_imports` and `source_row_lineage`, while allowing a corrected CSV to restore valid transactions that were hidden because their original import version was disabled.

The change applies to every supported CSV importer and projection. It is not specific to one institution, product, account, or incident.

## Privacy requirement

Committed fixtures, tests, documentation, and logs use fictional institutions, masked account identifiers, and synthetic values. Production account names, balances, file names, and identifiers are not copied into source code.

## Problems being fixed

The current importer creates a new import-run identity for every processed file. An identical file downloaded again therefore creates another `source_file_imports` row and another set of lineage observations even when no typed transaction is inserted. This causes unbounded metadata growth.

Visibility also follows only the typed transaction's original `(source_file_id, import_run_id)` owner. If that owner is disabled, a later corrected import cannot reactivate an identical valid transaction through its own active lineage. The transaction remains hidden even though an active source version supports it.

## Confirmed semantics

- One logical source version is identified by exact file content within a product namespace.
- `source_version_key` is the SHA-256 digest of a stable encoding of `(bank, product, source_file_hash)`.
- File paths, download names, import-run IDs, and modification times do not affect source-version identity.
- Reprocessing the same source version updates observation summary metadata only. It does not create another source import, typed transaction, or lineage row.
- If any data-issue exclusion actively disables a source version, importing identical bytes does not bypass that exclusion.
- A corrected file has a different hash and therefore creates a different, initially active source version.
- A typed transaction is visible when at least one active source version supports it through lineage. Its original physical owner does not have special authority.
- When a corrected version contains a valid duplicate transaction, its active lineage makes that transaction visible again. A wrong transaction omitted from the corrected file has no new support and stays hidden.
- Multiple data-issue cases may reference the same source version. The version is disabled while at least one related exclusion has `state = 'active'`.
- Historical identical imports may be compacted, but their first seen time, last seen time, observation count, exclusions, data-issue cases, and audit events must remain recoverable.

These rules supersede the earlier prototype decisions that every duplicate-only import must append a source import and that visibility is determined only by a transaction's physical owner.

## Data model

### `source_file_imports`

Add:

- `source_version_key TEXT NOT NULL`
- `first_seen_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`
- `observation_count INTEGER NOT NULL DEFAULT 1 CHECK (observation_count >= 1)`

Add a unique index on `source_version_key`. One row becomes the canonical summary for one logical source version. Existing source metadata, canonical `source_file_id`, canonical `import_run_id`, original relative path, file hash, bank, product, row count, status, and record JSON remain available on that row.

An exact re-observation updates only `last_seen_at` and increments `observation_count`. It does not replace the canonical first-seen metadata.

### `source_row_lineage`

Add `source_version_key TEXT NOT NULL` and make logical uniqueness:

```text
(source_version_key, source_row_index, projection_table)
```

Each row points to the canonical typed statement row through the existing `statement_row_id`. For the same source version, row index, and projection, different statement-row targets are an invariant violation rather than a value to choose heuristically.

Add the lookup index:

```sql
CREATE INDEX source_row_lineage_active_support_idx
ON source_row_lineage(projection_table, statement_row_id, source_version_key);
```

### `disabled_import_sources`

Add `source_version_key TEXT NOT NULL`. Keep the existing exclusion record, case relationship, reason, state, timestamps, preview token, and legacy source/import identifiers for audit compatibility.

Add:

```sql
CREATE INDEX disabled_import_sources_version_state_idx
ON disabled_import_sources(source_version_key, state);
```

No separate normalized source-version table is added. The canonical `source_file_imports` row already supplies the needed metadata and avoids another join and lifecycle.

### `import_runs` and events

Keep one `import_runs` record per explicit import execution, including `同步全部`. When an identical source version is observed, the run records an exact-file skip reason and summary counters. It does not create duplicate lineage.

Existing append-only data-issue events remain unchanged. They continue to reference their cases and legacy import context; the related exclusion resolves the canonical source version.

## Import flow

For each CSV considered by one `同步全部` execution:

1. Infer and validate `bank` and `product` using the existing importer routing.
2. Read the file and compute the existing file hash.
3. Compute `source_version_key` from `(bank, product, source_file_hash)` using an unambiguous stable encoding.
4. Query `source_file_imports` by its unique source-version key.
5. If it exists, atomically increment `observation_count`, update `last_seen_at`, increment `skippedCsvFiles`, and record `identical_source_version` on the current import run. Do not parse or project the file again.
6. If it does not exist, run the existing parser and projection flow. Insert one canonical source import and one lineage row for each supported source row/projection.
7. When a typed transaction conflicts with an existing content or statement-row uniqueness rule, resolve the existing canonical typed row and attach the new source version's single lineage record to it.
8. Commit the source summary, typed rows, lineage, and import-run result together.

The database unique index is the concurrency backstop. If the insert of a new source-version key loses a race, the importer treats it as the same exact-file observation and performs the summary update. Other constraint errors and all parse or database errors remain failures; they are not converted into skips.

Each `同步全部` action attempts each discovered CSV once. There is no timer retry loop and no per-workday suppression. Repeating `同步全部` safely records another observation without duplicating source or lineage data.

## Active-support visibility

Visibility is based on lineage support:

```text
visible(transaction) = any supporting source version is not actively disabled
```

The indexed SQL form is:

```sql
WHERE EXISTS (
  SELECT 1
  FROM source_row_lineage AS lineage
  WHERE lineage.projection_table = :projection_table
    AND lineage.statement_row_id = transaction.statement_row_id
    AND NOT EXISTS (
      SELECT 1
      FROM disabled_import_sources AS disabled
      WHERE disabled.source_version_key = lineage.source_version_key
        AND disabled.state = 'active'
    )
)
```

SQLite may stop at the first active supporting lineage. No loader iterates all lineage or import rows for each transaction.

For the asset, liability, and overview paths that currently filter in memory, run one indexed query to load all supported `(projection_table, statement_row_id)` keys into a `Set`. Existing model loops then use `Set.has()` in O(1). The spending store applies the indexed `EXISTS` predicate in SQL. Data-issue preview and restore use the same active-support rule and load support mappings once per operation.

Every typed statement row participating in these projections must have at least one lineage row after migration. Missing lineage aborts migration; the application must not silently fall back to physical-owner visibility.

## Corrected-file behavior

Assume one disabled source version supported transactions for two accounts. One transaction was wrong; the other was correct but became hidden because the whole source version was excluded.

When a corrected CSV is imported:

- its changed bytes create a new active `source_version_key`;
- the valid transaction may resolve to the existing typed row and gains one active lineage from the corrected version;
- the valid transaction becomes visible again because it has active support;
- the wrong transaction, absent from the corrected CSV, receives no new lineage and remains hidden;
- no disabled source version is reactivated or mutated.

Importing the exact disabled file again only updates its observation summary and keeps all transactions supported solely by it hidden.

## Historical migration and compaction

Run schema backfill and compaction in one SQLite transaction. Any failed invariant rolls back the entire migration.

1. Compute `source_version_key` for every historical source import from its bank, product, and file hash.
2. Group imports by source-version key.
3. Select the earliest successfully imported row as the canonical source import. Stable tie-breaking uses existing immutable identifiers.
4. Set `first_seen_at` to the minimum observed import time, `last_seen_at` to the maximum, and `observation_count` to the number of summarized observations, including any already summarized count if the migration is rerun against partially upgraded test data.
5. Backfill every lineage row's source-version key through its source import.
6. Compact lineage to one row per `(source_version_key, source_row_index, projection_table)` and retain its canonical `statement_row_id`.
7. If rows in one compacted lineage group point to different statement-row IDs, abort. Do not guess which typed row is correct.
8. Redirect legacy typed-row owner fields, where required by existing foreign keys or diagnostics, to the canonical source/import identifiers without changing typed transaction content.
9. Backfill every exclusion's source-version key. Preserve every case, exclusion reason, state, timestamp, preview token, and append-only event.
10. Delete only duplicate source-import summaries and duplicate lineage rows that the canonical summary now represents.
11. Add the uniqueness constraints and active-support indexes after the data passes all checks.

### Migration invariants

Before commit, verify:

- every source lineage and exclusion resolves to exactly one source version;
- every supported typed statement row has lineage;
- compacted identical lineage never maps one file row/projection to multiple typed rows;
- typed statement-row counts and typed row content are unchanged;
- data-issue, exclusion, and event counts are unchanged;
- the sum of observation counts is conserved;
- first and last observation bounds are conserved;
- visibility results are unchanged except for the approved rule that any active exclusion disables all identical observations of that source version;
- running the migration again makes no further changes.

No production cleanup script performs ad hoc deletes. Tests exercise migration only against temporary ledger copies or fixtures; the production upgrade relies on transaction rollback.

## Atomicity and error handling

- A new-source import commits its canonical source row, typed projections, lineage, and run result atomically.
- An identical-source observation commits its summary increment and run result atomically.
- Only a unique conflict on `source_version_key` is handled as a concurrent identical observation. Other errors fail the import.
- Failed imports retain the existing safe import-run error reporting and do not leave partial source summaries or lineage.
- Migration failures include a stable invariant code and safe diagnostic counts. They do not expose credentials, cookies, or absolute local paths.
- Data-issue preview and exclusion continue to run against a consistent read or write transaction, respectively.

## Performance requirements

- Exact-file detection uses the unique `source_version_key` index.
- Active-support SQL uses the composite lineage index and exclusion version/state index.
- In-memory pages execute one active-support query per ledger load, followed only by `Set.has()` calls; no N+1 lineage queries are allowed.
- Importing an identical file does not parse CSV rows or execute per-row lineage writes.
- Historical compaction is a one-time transactional migration. It may scan the involved tables, but must group and update in SQL-sized batches or set-based statements rather than issuing one full-table query per row.
- Verification includes `EXPLAIN QUERY PLAN` assertions for the active-support query shapes and query-count checks for in-memory loaders.

## Testing and acceptance

Use synthetic, de-identified fixtures for all checks.

### Importer

- Importing identical bytes from the same path does not increase canonical source or lineage row counts.
- Importing identical bytes under a renamed path resolves the same source version.
- An exact observation increments `observation_count`, updates `last_seen_at`, preserves `first_seen_at`, and records the skip on the current import run.
- Importing an actively disabled identical version keeps it disabled.
- Concurrent creation of the same source-version key results in one canonical version and one summarized observation path.
- Non-version-key constraint failures still fail and roll back.

### Corrected source and visibility

- A corrected file with a new hash adds active lineage to a valid existing typed transaction.
- A wrong transaction absent from the corrected file remains unsupported by active sources and hidden.
- The two-account scenario produces consistent preview, balances, histories, totals, charts, and restore behavior.
- Asset, liability, overview, and spending paths produce the same active-support result.
- Multiple cases disabling the same source version keep it disabled until all active exclusions are restored under existing restore rules.

### Migration and compaction

- Exact historical source imports collapse to one canonical summary with conserved observation count and time bounds.
- Duplicate historical lineage collapses without changing typed transactions.
- Data-issue cases, exclusions, reasons, states, timestamps, and events are preserved.
- Ambiguous lineage-to-statement mappings abort and roll back without schema or data changes.
- Orphan typed statement rows abort and roll back.
- A second migration run is a no-op.

### Performance and regression

- `EXPLAIN QUERY PLAN` shows indexed lineage and exclusion lookups for the active-support predicate.
- In-memory ledger filtering performs one support query and O(1) set membership per transaction, with no N+1 queries.
- Identical-file import skips parsing and per-row writes.
- Existing importer, data-issue, account, spending, typecheck, renderer build, and Electron build checks pass.

## Scope boundaries

This change does not add a force-import control, a background cleanup job, a frontend source-version setting, or automatic parser re-projection. If parser logic changes and historical source bytes must be projected again, that is an explicit maintenance operation with separate versioning semantics.

The implementation should reuse the existing importer transaction, data-issue event model, and page loaders. It should not introduce a generic repository layer or a second source-version table.

## Rollout

1. Back up or copy the ledger using the existing application upgrade safety mechanism.
2. Run the transactional schema migration and compaction before normal ledger reads.
3. Abort application startup with a recoverable migration error if invariants fail; retain the untouched pre-migration database.
4. After success, use canonical source-version identity for all new imports and active-support visibility for all consumers.
5. Surface import and data-issue errors through the existing persisted operation records and interface.

