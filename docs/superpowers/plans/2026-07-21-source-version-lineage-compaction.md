# Canonical Source-Version Lineage and Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate exact CSV source versions, compact historical duplicate lineage, and make transaction visibility depend on any active supporting source version.

**Architecture:** Add one deterministic source-version key shared by migrations and the importer. Store one canonical source import plus summarized observations, attach each source version to canonical typed rows through lineage, and calculate visibility from one indexed active-support query followed by O(1) set membership. Preserve current immutable typed rows, data-issue cases, exclusions, and append-only audit events.

**Tech Stack:** TypeScript, Node.js `node:crypto`, SQLite via `better-sqlite3`, Drizzle schema declarations, SvelteKit server loaders, Node test runner and assert checks.

## Global Constraints

- Use synthetic, de-identified fixtures; do not commit production institutions, accounts, balances, file names, or identifiers.
- `source_version_key` is SHA-256 over an unambiguous stable encoding of `(bank, product, source_file_hash)`.
- Exact reimports update observation summary only; they do not parse rows or add source-import, typed-row, or lineage records.
- Importing an identical disabled version must not reactivate it.
- A transaction is visible when at least one supporting source version is active.
- Asset, liability, overview, spending, preview, exclusion, and restore must use the same support rule.
- No N+1 lineage queries: one indexed support query, then `Set.has()` for in-memory filtering.
- Historical compaction runs in one SQLite transaction and rolls back on every failed invariant.
- Preserve all data-issue cases, exclusions, reasons, timestamps, preview tokens, and events.
- Do not add dependencies, a normalized source-version table, a force-import UI, a background cleanup job, or automatic parser re-projection.

## File Map

- Create `src/ledger/source-version.ts`: deterministic source-version identity only.
- Create `src/ledger/source-version.check.ts`: identity determinism and namespace checks.
- Modify `src/ledger/db/schema.ts`: canonical source-version columns, constraints, and indexes.
- Modify `src/ledger/db/migrations.ts`: version 26 transactional backfill, compaction, and invariant checks.
- Modify `src/ledger/db/migrations.check.ts`: success, rollback, preservation, and idempotence coverage.
- Modify `src/ledger/import-downloads-csv.ts`: exact-version short circuit, observation summary, and keyed lineage writes.
- Modify `src/ledger/import-downloads-csv.check.ts`: exact, renamed, corrected, disabled, and rollback importer cases.
- Modify `src/lib/shared-ledger/server/accounts.ts`: use canonical `source_file_imports` rows in `LedgerQueryData`.
- Modify `src/lib/shared-ledger/server/mock-data.ts`: add synthetic canonical source metadata required by the new type.
- Modify `src/lib/overview/server/daily-history.check.ts`: add canonical source fields to local fixtures.
- Modify `src/lib/data-issues/server/ledger-visibility.ts`: one active-support query and support-key filtering helpers.
- Modify `src/lib/data-issues/server/ledger-visibility.check.ts`: indexed plan, one-query, and active-lineage tests.
- Modify `src/lib/data-issues/server/store.ts`: source-version candidate, preview, exclusion, and restore semantics.
- Modify `src/lib/data-issues/server/store.check.ts`: two-account corrected-source and multi-case behavior.
- Modify `src/lib/assets/server/load-assets.ts`: load canonical source imports and active support.
- Modify `src/lib/liabilities/server/load-liabilities.ts`: load canonical source imports and active support.
- Modify `src/lib/overview/server/load-overview.ts`: load canonical source imports and active support.
- Modify `src/lib/spending/server/store.ts`: replace physical-owner predicate with indexed active-lineage `EXISTS`.
- Modify `src/lib/spending/server/store.check.ts`: spending visibility and query-plan regression checks.

---

### Task 1: Deterministic source-version identity

**Files:**
- Create: `src/ledger/source-version.ts`
- Create: `src/ledger/source-version.check.ts`

**Interfaces:**
- Consumes: `bank`, `product`, and the existing SHA-256 `sourceFileHash` strings.
- Produces: `sourceVersionKey(bank: string, product: string, sourceFileHash: string): string` for Tasks 2 and 3.

- [ ] **Step 1: Write the failing identity check**

```ts
import assert from "node:assert/strict";
import { sourceVersionKey } from "./source-version.ts";

const first = sourceVersionKey("fictional-bank", "loan-statements", "file-hash-a");
assert.match(first, /^[a-f0-9]{64}$/);
assert.equal(first, sourceVersionKey("fictional-bank", "loan-statements", "file-hash-a"));
assert.notEqual(first, sourceVersionKey("fictional-bank", "loan-statements", "file-hash-b"));
assert.notEqual(first, sourceVersionKey("fictional-bank", "card-statements", "file-hash-a"));
assert.notEqual(first, sourceVersionKey("other-bank", "loan-statements", "file-hash-a"));
assert.notEqual(
  sourceVersionKey("a|b", "c", "d"),
  sourceVersionKey("a", "b|c", "d"),
);
```

- [ ] **Step 2: Run the check and verify the missing module failure**

Run: `node --no-warnings --experimental-strip-types --test src/ledger/source-version.check.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `source-version.ts`.

- [ ] **Step 3: Implement the smallest shared identity helper**

```ts
import { createHash } from "node:crypto";

export function sourceVersionKey(bank: string, product: string, sourceFileHash: string) {
  return createHash("sha256")
    .update(JSON.stringify([bank, product, sourceFileHash]))
    .digest("hex");
}
```

- [ ] **Step 4: Run the focused check**

Run: `node --no-warnings --experimental-strip-types --test src/ledger/source-version.check.ts`

Expected: PASS.

- [ ] **Step 5: Commit the identity helper**

```bash
git add src/ledger/source-version.ts src/ledger/source-version.check.ts
git commit -m "feat: add canonical source version identity"
```

---

### Task 2: Transactional schema migration and historical compaction

**Files:**
- Modify: `src/ledger/db/schema.ts`
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/db/migrations.check.ts`

**Interfaces:**
- Consumes: `sourceVersionKey()` from Task 1 and existing `TYPED_STATEMENT_TABLES`.
- Produces: migration version 26; canonical `source_file_imports`, `source_row_lineage`, and `disabled_import_sources` schemas used by every later task.

- [ ] **Step 1: Add a failing successful-compaction fixture**

Extend `src/ledger/db/migrations.check.ts` with a temporary version-25 database containing two source imports with the same `(bank, product, source_file_hash)`, duplicate lineage pointing to the same statement row, one active exclusion, one case, and one event. After `migrateLedgerDb(db)`, assert:

```ts
const imports = db.prepare(`SELECT source_version_key, first_seen_at, last_seen_at,
  observation_count FROM source_file_imports`).all().map((row) => ({ ...row }));
assert.equal(imports.length, 1);
assert.equal(imports[0]?.first_seen_at, "2026-01-01T00:00:00.000Z");
assert.equal(imports[0]?.last_seen_at, "2026-01-02T00:00:00.000Z");
assert.equal(imports[0]?.observation_count, 2);
assert.equal((db.prepare("SELECT COUNT(*) count FROM source_row_lineage").get() as { count: number }).count, 1);
assert.equal((db.prepare("SELECT COUNT(*) count FROM data_issues").get() as { count: number }).count, 1);
assert.equal((db.prepare("SELECT COUNT(*) count FROM data_issue_events").get() as { count: number }).count, 1);
assert.equal((db.prepare("SELECT COUNT(*) count FROM disabled_import_sources").get() as { count: number }).count, 1);
assert.equal((db.prepare("SELECT balance_after FROM loan_transactions WHERE statement_row_id = 'synthetic-row'").get() as { balance_after: number }).balance_after, 63_900);
```

Also call `migrateLedgerDb(db)` a second time and assert the same counts and observation total.

- [ ] **Step 2: Add failing rollback fixtures**

Create one database where identical lineage groups point to two statement IDs and one database containing a typed statement row with no lineage. Snapshot `schema_migrations` and table counts, call `migrateLedgerDb`, and assert:

```ts
assert.throws(() => migrateLedgerDb(ambiguousDb), /SOURCE_VERSION_LINEAGE_AMBIGUOUS/);
assert.equal(appliedVersion(ambiguousDb, 26), false);
assert.deepEqual(tableCounts(ambiguousDb), countsBeforeAmbiguousMigration);

assert.throws(() => migrateLedgerDb(orphanDb), /SOURCE_VERSION_LINEAGE_ORPHAN/);
assert.equal(appliedVersion(orphanDb, 26), false);
assert.deepEqual(tableCounts(orphanDb), countsBeforeOrphanMigration);
```

- [ ] **Step 3: Run the migration check and verify it fails**

Run: `node --no-warnings --experimental-strip-types --test src/ledger/db/migrations.check.ts`

Expected: FAIL because migration 26 and the new columns do not exist.

- [ ] **Step 4: Update the Drizzle schema declarations**

Add these fields and indexes in `src/ledger/db/schema.ts`:

```ts
sourceVersionKey: text("source_version_key").notNull(),
firstSeenAt: text("first_seen_at").notNull(),
lastSeenAt: text("last_seen_at").notNull(),
observationCount: integer("observation_count").notNull().default(1),
```

Declare `uniqueIndex("uq_source_file_imports_version").on(table.sourceVersionKey)`. Add `sourceVersionKey` to lineage and use a unique index over `(sourceVersionKey, sourceRowIndex, projectionTable)` plus `index("source_row_lineage_active_support_idx").on(table.projectionTable, table.statementRowId, table.sourceVersionKey)`. Add `sourceVersionKey` to exclusions, replace `uq_disabled_import_source_scope` with `uniqueIndex("uq_disabled_import_source_case_version").on(table.dataIssueId, table.sourceVersionKey)`, and add `index("disabled_import_sources_version_state_idx").on(table.sourceVersionKey, table.state)`.

- [ ] **Step 5: Implement migration 26 as one migration transaction**

Add `canonicalizeSourceVersions(db)` to `src/ledger/db/migrations.ts` and register:

```ts
{
  version: 26,
  name: "canonical_source_versions",
  up: canonicalizeSourceVersions,
}
```

The function must perform these concrete operations inside the transaction already owned by `migrateLedgerDb`:

1. Read historical source imports ordered by `imported_at, source_file_id, import_run_id` and compute `sourceVersionKey(bank, product, source_file_hash)`.
2. Build a `Map<sourceVersionKey, CanonicalSource>` with the earliest row as canonical, minimum/maximum times, and summed observations.
3. Create `source_file_imports_v26` with the final schema and insert one canonical row per map entry.
4. Build a legacy-scope-to-version map and validate that every lineage and exclusion scope resolves.
5. Group lineage by `(sourceVersionKey, source_row_index, projection_table)`; throw `SOURCE_VERSION_LINEAGE_AMBIGUOUS` if a group has multiple `statement_row_id` values.
6. Create `source_row_lineage_v26` and insert one row per group using the earliest `created_at`; preserve `inserted` over `upserted` over `duplicate` only as display metadata because visibility ignores outcome.
7. Rebuild `disabled_import_sources_v26`, preserving every exclusion and adding the resolved version key. Use `(data_issue_id, source_version_key)` for idempotency so different cases can reference one version.
8. For every `TYPED_STATEMENT_TABLES` table, update legacy physical owner fields to the canonical source/import IDs through the scope map without changing statement IDs or business columns.
9. Verify every typed statement row has lineage by `(projection_table, statement_row_id)`; throw `SOURCE_VERSION_LINEAGE_ORPHAN` with table and count only.
10. Verify typed counts, issue/event/exclusion counts, observation totals, and first/last bounds.
11. Replace the three old tables, create final constraints/indexes, and leave `source_files` untouched as the path catalog.

Use prepared statements inside the existing transaction; do not open a second connection or issue `BEGIN` in this function.

- [ ] **Step 6: Run migration checks**

Run: `node --no-warnings --experimental-strip-types --test src/ledger/db/migrations.check.ts`

Expected: PASS, including success, rollback, preservation, and second-run assertions.

- [ ] **Step 7: Run typecheck for schema consumers**

Run: `npm run typecheck`

Expected: PASS after adding required fields to any schema-typed test fixtures reported by the compiler.

- [ ] **Step 8: Commit the migration**

```bash
git add src/ledger/db/schema.ts src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts
git commit -m "feat: compact canonical source version history"
```

---

### Task 3: Exact-file import short circuit and canonical lineage writes

**Files:**
- Modify: `src/ledger/import-downloads-csv.ts`
- Modify: `src/ledger/import-downloads-csv.check.ts`

**Interfaces:**
- Consumes: `sourceVersionKey()` and the version-26 schema from Tasks 1 and 2.
- Produces: one canonical source summary, one lineage observation per source row/projection, and exact-file skip accounting for Tasks 4 and 5.

- [ ] **Step 1: Replace the old duplicate-growth assertions with failing canonical assertions**

For the existing synthetic source-history fixture, import identical bytes twice and assert:

```ts
assert.deepEqual(db.prepare(`SELECT observation_count, first_seen_at <= last_seen_at AS ordered
  FROM source_file_imports`).all().map((row) => ({ ...row })), [
  { observation_count: 2, ordered: 1 },
]);
assert.equal((db.prepare("SELECT COUNT(*) count FROM source_row_lineage").get() as { count: number }).count, 1);
assert.equal(secondResult.importedCsvFiles, 0);
assert.equal(secondResult.skippedCsvFiles, 1);
```

Copy the same bytes to a different synthetic file name and assert source import and lineage counts stay unchanged while `observation_count` becomes 3.

- [ ] **Step 2: Add failing corrected-version and disabled-version importer checks**

Import version A with one valid and one wrong synthetic transaction, disable A, then import version B with changed bytes containing only the valid transaction. Assert:

```ts
assert.equal(count("source_file_imports"), 2);
assert.equal(count("account_transactions"), 2);
assert.equal(lineageCountFor(validStatementRowId), 2);
assert.equal(lineageCountFor(wrongStatementRowId), 1);
assert.equal(activeVersionCountFor(validStatementRowId), 1);
assert.equal(activeVersionCountFor(wrongStatementRowId), 0);
```

Import version A again and assert its observation count increments but the active exclusion and all row counts remain unchanged.

- [ ] **Step 3: Run the importer check and verify canonical assertions fail**

Run: `node --no-warnings --experimental-strip-types --test src/ledger/import-downloads-csv.check.ts`

Expected: FAIL because identical files still create source-import and lineage rows.

- [ ] **Step 4: Add source-version identity to importer records**

After context inference and file hashing, compute:

```ts
const versionKey = sourceVersionKey(context.bank, context.product, sourceFileHash);
```

Add `sourceVersionKey: versionKey` to `sourceFileRecord`. Change `sourceFileRecordFromBatch()` and `insertSourceFileImport()` to write `source_version_key`, `first_seen_at`, `last_seen_at`, and `observation_count`.

- [ ] **Step 5: Short-circuit known exact versions before CSV parsing**

Immediately after computing the version key, query the indexed canonical table. For an existing row, queue only:

```ts
exactObservations.push({ sourceVersionKey: versionKey, observedAt: startedAt });
skippedCsvFiles += 1;
fileSummaries.push({
  sourceFile,
  sourceRelativePath,
  bank: context.bank,
  product: context.product,
  rows: 0,
  status: "identical_source_version",
});
continue;
```

Do not call `parseCsvRows`, `sidecarMetadata`, or the per-row hashing loop on this path.

- [ ] **Step 6: Make transaction writes race-safe**

Inside the existing import transaction:

```ts
const observeVersion = db.prepare(`UPDATE source_file_imports
  SET last_seen_at = ?, observation_count = observation_count + 1
  WHERE source_version_key = ?`);

for (const observation of exactObservations) {
  if (observeVersion.run(observation.observedAt, observation.sourceVersionKey).changes !== 1) {
    throw new Error("SOURCE_VERSION_OBSERVATION_MISSING");
  }
}
```

For parsed new versions, insert the canonical source row with `ON CONFLICT(source_version_key) DO NOTHING`. If `changes === 0`, increment its observation summary, mark that file skipped, and exclude all queued statement rows for that version from projection. This is the only unique-conflict path converted to an exact observation. Let every other error reach the existing rollback and failed-run handling.

- [ ] **Step 7: Write source-version-keyed lineage**

Change `insertSourceRowLineage()` to insert:

```sql
INSERT INTO source_row_lineage (
  source_file_id, import_run_id, source_version_key, source_row_index,
  projection_table, statement_row_id, outcome, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source_version_key, source_row_index, projection_table) DO NOTHING
```

Resolve content-hash or statement-row conflicts exactly as today, then attach the new version's lineage to the canonical `statement_row_id`.

- [ ] **Step 8: Run importer and exchange-rate checks**

Run: `node --no-warnings --experimental-strip-types --test src/ledger/import-downloads-csv.check.ts src/ledger/import-exchange-rates.check.ts`

Expected: PASS.

- [ ] **Step 9: Commit importer behavior**

```bash
git add src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "fix: deduplicate exact source version imports"
```

---

### Task 4: One-query active-support visibility and page integration

**Files:**
- Modify: `src/lib/shared-ledger/server/accounts.ts`
- Modify: `src/lib/shared-ledger/server/mock-data.ts`
- Modify: `src/lib/overview/server/daily-history.check.ts`
- Modify: `src/lib/data-issues/server/ledger-visibility.ts`
- Modify: `src/lib/data-issues/server/ledger-visibility.check.ts`
- Modify: `src/lib/assets/server/load-assets.ts`
- Modify: `src/lib/liabilities/server/load-liabilities.ts`
- Modify: `src/lib/overview/server/load-overview.ts`
- Modify: `src/lib/spending/server/store.ts`
- Modify: `src/lib/spending/server/store.check.ts`

**Interfaces:**
- Consumes: canonical version and lineage tables from Task 2.
- Produces: `ActiveLedgerSupport`, `loadActiveLedgerSupport()`, `applyLedgerVisibility()`, and lineage-aware `activeImportSql()` for Task 5.

- [ ] **Step 1: Write failing active-lineage and one-query checks**

In `ledger-visibility.check.ts`, seed one typed statement with two lineage rows: version A disabled and version B active. Assert the row remains visible. Then disable B and assert it is hidden.

Instrument a minimal database wrapper and assert one prepared support query:

```ts
let prepareCount = 0;
const countedDb = {
  prepare(sql: string) {
    prepareCount += 1;
    return realDb.prepare(sql);
  },
} as LedgerDatabase;
const support = loadActiveLedgerSupport(countedDb);
assert.equal(prepareCount, 1);
assert.equal(support.statementKeys.has("loan_transactions|synthetic-valid"), true);
```

Use `EXPLAIN QUERY PLAN` on the support query and assert its detail contains both `source_row_lineage_active_support_idx` and `disabled_import_sources_version_state_idx`.

- [ ] **Step 2: Add failing spending active-lineage coverage**

In `store.check.ts`, attach an account transaction to disabled version A and active version B. Assert `loadSpendingTransactions()` includes it, then disable B and assert exclusion. Add `EXPLAIN QUERY PLAN` for `activeImportSql("account_transactions")` and assert indexed lineage lookup.

- [ ] **Step 3: Run focused checks and verify physical-owner behavior fails**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/ledger-visibility.check.ts src/lib/spending/server/store.check.ts`

Expected: FAIL because visibility still checks only typed-row owner scope.

- [ ] **Step 4: Define support keys and load them in one SQL statement**

In `ledger-visibility.ts`, define:

```ts
export type ActiveLedgerSupport = {
  statementKeys: ReadonlySet<string>;
  sourceVersionKeys: ReadonlySet<string>;
};

export const statementSupportKey = (table: string, statementRowId: string) =>
  `${table}|${statementRowId}`;

export function loadActiveLedgerSupport(
  db: LedgerDatabase,
  additionallyDisabled: ReadonlySet<string> = new Set(),
): ActiveLedgerSupport;
```

Use one `UNION ALL` query returning `kind` and `support_key`: active lineage statement keys in the first branch and active canonical source-version keys in the second. Parameterize additional disabled keys with a temporary in-query `VALUES` CTE; an empty set uses a CTE that returns no rows. Both branches reject a version if an active exclusion exists or it is in `additionallyDisabled`.

- [ ] **Step 5: Filter each ledger collection by its projection table**

Replace physical `ImportScope` filtering in `applyLedgerVisibility()` with a fixed mapping:

```ts
const PROJECTIONS = {
  accountTransactions: "account_transactions",
  foreignCurrencyTransactions: "foreign_currency_transactions",
  creditCardStatementLines: "credit_card_statement_lines",
  loanTransactions: "loan_transactions",
  fundHoldings: "fund_holdings",
  fundBuyTransactions: "fund_buy_transactions",
  fundRedemptionTransactions: "fund_redemption_transactions",
  fundCashDividends: "fund_cash_dividends",
  fundConversionTransactions: "fund_conversion_transactions",
  brokerageHoldings: "brokerage_holdings",
  brokerageTradeTransactions: "brokerage_trade_transactions",
} as const;
```

For each collection, retain rows whose `statementSupportKey(table, row.statementRowId)` is present. Filter canonical `sourceFiles` by `sourceVersionKeys`. Preserve the existing credit-card capture completeness calculation after statement-line filtering. Maicoin rows remain unchanged because they do not use CSV lineage.

- [ ] **Step 6: Use canonical source imports in `LedgerQueryData`**

In `accounts.ts`, infer `SourceFile` from `sourceFileImports` instead of `sourceFiles`. Update synthetic mock and daily-history fixtures with `sourceVersionKey`, `firstSeenAt`, `lastSeenAt`, and `observationCount`. Do not change account math.

- [ ] **Step 7: Integrate the one support load into page loaders**

In assets, liabilities, and overview:

```ts
const sourceFiles = await db.select().from(schema.sourceFileImports).all();
const support = loadActiveLedgerSupport(sqlite);
const visibleData = applyLedgerVisibility(data, support);
```

Remove `loadActiveImportScopes` imports. Keep one support query per page load and pass the same result through all account, history, chart, and unavailable-account calculations.

- [ ] **Step 8: Replace spending physical-owner SQL**

Make `activeImportSql(alias)` return the exact indexed lineage-support predicate:

```sql
EXISTS (
  SELECT 1 FROM source_row_lineage AS lineage
  WHERE lineage.projection_table = '<validated alias>'
    AND lineage.statement_row_id = <alias>.statement_row_id
    AND NOT EXISTS (
      SELECT 1 FROM disabled_import_sources AS disabled
      WHERE disabled.source_version_key = lineage.source_version_key
        AND disabled.state = 'active'
    )
)
```

Continue validating aliases against the existing safe identifier regex.

- [ ] **Step 9: Run visibility, spending, shared-ledger, and history checks**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/ledger-visibility.check.ts src/lib/spending/server/store.check.ts src/lib/shared-ledger/server/accounts.check.ts src/lib/shared-ledger/server/mock-data.check.ts src/lib/overview/server/daily-history.check.ts`

Expected: PASS, including query-plan and one-query assertions.

- [ ] **Step 10: Commit shared visibility**

```bash
git add src/lib/shared-ledger/server/accounts.ts src/lib/shared-ledger/server/mock-data.ts src/lib/overview/server/daily-history.check.ts src/lib/data-issues/server/ledger-visibility.ts src/lib/data-issues/server/ledger-visibility.check.ts src/lib/assets/server/load-assets.ts src/lib/liabilities/server/load-liabilities.ts src/lib/overview/server/load-overview.ts src/lib/spending/server/store.ts src/lib/spending/server/store.check.ts
git commit -m "fix: resolve ledger visibility from active lineage"
```

---

### Task 5: Data-issue preview, exclusion, and restore by source version

**Files:**
- Modify: `src/lib/data-issues/server/store.ts`
- Modify: `src/lib/data-issues/server/store.check.ts`

**Interfaces:**
- Consumes: `loadActiveLedgerSupport(db, additionallyDisabled)` and `applyLedgerVisibility(data, support)` from Task 4.
- Produces: candidate, preview, confirm-exclusion, and restore behavior consistent with every page.

- [ ] **Step 1: Write the failing two-account corrected-source scenario**

Seed de-identified source version A supporting a valid transaction for account X and a wrong transaction for account Y. Disable A through a case, then seed corrected version B supporting only X's canonical typed row. Assert:

```ts
const detail = store.loadDataIssue(issueId);
assert.equal(detail.status, "resolved");

const support = loadActiveLedgerSupport(db);
const visible = applyLedgerVisibility(loadSyntheticLedgerData(db), support);
assert.equal(hasStatement(visible, validStatementRowId), true);
assert.equal(hasStatement(visible, wrongStatementRowId), false);
```

Create a second case for the same version A and assert both exclusion rows remain present. Restore one case and assert A remains disabled while the other exclusion is active.

- [ ] **Step 2: Add failing preview-count and event-preservation assertions**

Preview exclusion of B and assert `excludedRows` counts typed statements that lose their last active support, `duplicateRows` counts source rows retained by another active version, affected account labels are stable, and preview/confirm events retain safe details. Confirm that importing or observing sources does not delete any event.

- [ ] **Step 3: Run the store check and verify scope-based calculations fail**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/store.check.ts`

Expected: FAIL because candidate and preview logic still uses physical owners and owner-based duplicate checks.

- [ ] **Step 4: Resolve UI source IDs to one canonical version key**

Keep the renderer DTO `{ sourceFileId, importRunId }` for compatibility. Expand `SourceImportRow` with `source_version_key` and make `sourceImport()` return the canonical row. Every backend operation must immediately use `source.source_version_key` for lineage, support, and exclusion queries.

- [ ] **Step 5: Replace physical source-row queries with lineage support queries**

Implement these exact internal helpers:

```ts
function lineageRowsForVersion(db: LedgerDatabase, sourceVersionKey: string): LineageRow[];
function statementSupportForVersion(db: LedgerDatabase, sourceVersionKey: string): ReadonlySet<string>;
function accountIdsForSourceVersion(
  db: LedgerDatabase,
  data: LedgerQueryData,
  sourceVersionKey: string,
): ReadonlySet<string>;
```

`statementSupportForVersion` runs one indexed query on `source_row_lineage`. `accountIdsForSourceVersion` passes that set through the existing ledger filtering and account builders; it does not query per statement.

- [ ] **Step 6: Calculate preview from before and after support sets**

For selected version key `V`:

```ts
const beforeSupport = loadActiveLedgerSupport(db);
const afterSupport = loadActiveLedgerSupport(db, new Set([V]));
const beforeData = applyLedgerVisibility(rawData, beforeSupport);
const afterData = applyLedgerVisibility(rawData, afterSupport);
```

Derive affected accounts by comparing these two models plus accounts supported by V. Count `excludedRows` as statement keys present before and absent after. Count retained duplicates as lineage source rows from V whose statement keys remain present after. Build the preview token from `sourceVersionKey`, sorted active exclusion IDs, affected account states, and the selected source summary's `last_seen_at`.

- [ ] **Step 7: Persist per-case source-version exclusions**

Change `upsertActiveExclusion()` to write `source_version_key` and use:

```sql
ON CONFLICT(data_issue_id, source_version_key) DO UPDATE SET
  source_file_id = excluded.source_file_id,
  import_run_id = excluded.import_run_id,
  reason = excluded.reason,
  state = 'active',
  disabled_at = excluded.disabled_at,
  restored_at = NULL,
  preview_token = excluded.preview_token
```

Queries that determine whether a version is disabled must use `EXISTS` over all `state = 'active'` exclusions for that key. Restore updates only the current case's exclusion; visibility changes only when no active exclusion for that version remains.

- [ ] **Step 8: Update candidates and unavailable-account fallback**

List canonical `source_file_imports` rows only. Candidate row counts and affected accounts come from source-version lineage. Replace legacy scope-based unavailable-account derivation with before/after active-support comparison using the exclusion's `source_version_key`. Preserve event-based affected-account IDs when present.

- [ ] **Step 9: Run data-issue and visibility checks**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/store.check.ts src/lib/data-issues/server/ledger-visibility.check.ts`

Expected: PASS, including the corrected-source, multi-case, preview-count, restore, and event assertions.

- [ ] **Step 10: Commit source-version data-issue behavior**

```bash
git add src/lib/data-issues/server/store.ts src/lib/data-issues/server/store.check.ts
git commit -m "fix: preview exclusions by canonical source version"
```

---

### Task 6: Cross-page regression and release verification

**Files:**
- Create: `src/lib/data-issues/server/active-lineage-pages.check.ts`

**Interfaces:**
- Consumes: all behavior from Tasks 1 through 5.
- Produces: de-identified end-to-end proof and a clean build-ready branch.

- [ ] **Step 1: Add a failing cross-page integration check before final implementation verification**

Create one temporary ledger with two source versions and two accounts. Version A is disabled; corrected version B supports only the valid canonical transaction. Call `loadAssets`, `loadLiabilities`, `loadOverview`, and the spending store. Assert the valid row is present everywhere it applies, the wrong row is absent, totals agree with visible account rows, and no real institution or account identifier appears in fixtures.

Use synthetic labels such as `Example Bank`, `asset-0420`, and `loan-1701`.

- [ ] **Step 2: Run the cross-page check**

Run: `node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/active-lineage-pages.check.ts src/lib/overview/server/load-overview-exchange-rates.check.ts`

Expected: PASS. If it fails, fix only the shared loader/support boundary responsible for the mismatch and rerun this command.

- [ ] **Step 3: Run all focused ledger and data-issue checks**

Run: `node --no-warnings --experimental-strip-types --test src/ledger/source-version.check.ts src/ledger/db/migrations.check.ts src/ledger/import-downloads-csv.check.ts src/ledger/import-exchange-rates.check.ts src/lib/data-issues/server/ledger-visibility.check.ts src/lib/data-issues/server/store.check.ts src/lib/data-issues/server/active-lineage-pages.check.ts src/lib/spending/server/store.check.ts`

Expected: PASS with zero failed tests and no uncaught database lock or unique-constraint errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`

Expected: exit code 0.

- [ ] **Step 5: Run static and build verification**

Run: `npm run typecheck && npm run build:renderer && npm run build:electron`

Expected: all three commands exit 0.

- [ ] **Step 6: Run privacy and secret checks**

Run: `npm run privacy-check && npm run secrets-check`

Expected: exit code 0 and no production account data or secrets reported.

- [ ] **Step 7: Inspect final migration query plans and working tree**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended Task 6 files are uncommitted.

- [ ] **Step 8: Commit integration coverage**

```bash
git add src/lib/data-issues/server/active-lineage-pages.check.ts
git commit -m "test: verify active lineage across ledger pages"
```

- [ ] **Step 9: Request final two-stage review**

Dispatch one spec-compliance reviewer against `docs/superpowers/specs/2026-07-21-source-version-lineage-compaction-design.md`, then one code-quality reviewer against all commits created by this plan. Resolve every blocking finding with a failing regression check, the smallest shared fix, rerun the affected focused command, and make one final review-fix commit.
