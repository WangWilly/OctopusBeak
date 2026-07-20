# Persistent Data-Issue Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the renderer-only data-issue prototype with a persistent, reversible workflow that excludes one exact CSV import version from every ledger calculation without deleting imported rows.

**Architecture:** Add append-only source-version and case-event storage plus one reversible exclusion row keyed by `(source_file_id, import_run_id)`. Filter active ledger data at shared server boundaries, keep account identity for unavailable values, and expose diagnosis, preview, confirm, and restore through validated Electron IPC.

**Tech Stack:** TypeScript 5.9, Svelte 5 legacy syntax, Electron IPC/context bridge, Node `DatabaseSync`, Drizzle SQLite schema, Node built-in test runner, existing Lucide and app CSS tokens.

## Global Constraints

- Never delete or rewrite imported CSV rows.
- Exclusion scope is exactly one `(source_file_id, import_run_id)`.
- Identical reimports remain excluded; corrected content remains active.
- Accounts without replacement data show `無可用資料` and do not enter numeric aggregation.
- Restore is blocked after newer active account data exists.
- Every succeeded, blocked, and failed operation is persisted as an append-only event.
- Renderer input never includes SQL, table names, or physical row IDs.
- Fixtures, tests, screenshots, docs, and logs must use fictional institutions, masked accounts, and synthetic amounts.
- Add no dependency and keep the approved single-card UI and reduced-motion transition.

---

## File map

**Create**

- `src/lib/data-issues/types.ts` — persistent DTO and command contracts shared by renderer, preload, and main process.
- `src/lib/data-issues/server/ledger-visibility.ts` — exclusion-scope loading and shared row/capture filtering.
- `src/lib/data-issues/server/ledger-visibility.check.ts` — generic and credit-card visibility regression checks.
- `src/lib/data-issues/server/store.ts` — case persistence, diagnosis, preview, confirmation, event recording, and restore rules.
- `src/lib/data-issues/server/store.check.ts` — transaction, idempotency, stale-token, missing-data, and restore checks.
- `src/lib/data-issues/DataIssuesDashboard.svelte` — persistent list and case workflow.
- `src/lib/data-issues/data-issues-ui.check.ts` — static UI contract check.

**Modify**

- `src/ledger/db/schema.ts` — four persistent tables.
- `src/ledger/db/migrations.ts` — migration 24 and current source-version backfill.
- `src/ledger/db/migrations.check.ts` — schema and idempotent backfill assertions.
- `src/ledger/import-downloads-csv.ts` — append source versions in the import transaction.
- `src/ledger/import-downloads-csv.check.ts` — duplicate-only and corrected reimport checks.
- `src/lib/shared-ledger/types.ts` — unavailable account metadata.
- `src/lib/shared-ledger/server/accounts.ts` — preserve unavailable accounts outside aggregation.
- `src/lib/shared-ledger/server/accounts.check.ts` — unavailable-account aggregation check.
- `src/lib/overview/server/load-overview.ts` — apply shared visibility before models.
- `src/lib/assets/server/load-assets.ts` — apply shared visibility before models.
- `src/lib/liabilities/server/load-liabilities.ts` — apply shared visibility before models.
- `src/lib/spending/server/store.ts` — apply the same active-scope predicate to statement SQL.
- `src/lib/spending/server/store.check.ts` — spending exclusion regression.
- `src/lib/desktop/api.ts` — typed `dataIssues` API and channel allowlist.
- `src/lib/desktop/api.check.ts` — new channels and signatures.
- `electron/preload.ts` — context-bridge methods.
- `electron/preload.check.ts` — exposed method checks.
- `electron/ipc.ts` — validated main-process handlers.
- `electron/ipc.check.ts` — handler registration and delegation checks.
- `src/lib/data-issues/ReportDataIssueModal.svelte` — async persistent create and validation.
- `src/lib/liabilities/LiabilitiesDashboard.svelte` — remove session storage and navigate by case ID.
- `src/routes/+page.svelte` — load/render persistent data issues.
- `src/lib/i18n/i18n.ts` — production, unavailable, event, and error copy.

**Retire after replacement**

- `src/lib/data-issues/prototype-model.ts`
- `src/lib/data-issues/prototype-model.check.ts`
- `src/lib/data-issues/prototype-ui.check.ts`
- `src/lib/data-issues/DataIssuesPrototype.svelte`

---

### Task 1: Persistent schema and migration

**Files:**
- Modify: `src/ledger/db/schema.ts`
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/db/migrations.check.ts`

**Interfaces:**
- Produces Drizzle tables `sourceFileImports`, `dataIssues`, `disabledImportSources`, and `dataIssueEvents`.
- Preserves `sourceFiles` as the current-version compatibility table.

- [ ] **Step 1: Write the failing migration check**

Add a migration test that opens a version-23 fixture, inserts one `source_files` row, migrates, and asserts:

```ts
const expected = new Set([
  "source_file_imports",
  "data_issues",
  "disabled_import_sources",
  "data_issue_events",
]);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all().map((row) => String((row as { name: string }).name));
for (const table of expected) assert.ok(tables.includes(table), table);

assert.deepEqual(db.prepare(`
  SELECT source_file_id, import_run_id, source_file_hash
  FROM source_file_imports
`).all(), [{
  source_file_id: "source-a",
  import_run_id: "run-a",
  source_file_hash: "hash-a",
}]);
```

Also assert the status checks reject invalid values and a second `migrateLedgerDb(db)` does not duplicate the backfill.

- [ ] **Step 2: Run the focused check and confirm RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/db/migrations.check.ts
```

Expected: FAIL because the four tables do not exist.

- [ ] **Step 3: Add the Drizzle schema**

Add these exported tables, using existing `text`, `real`, `integer`, `primaryKey`, `uniqueIndex`, `index`, and `check` helpers:

```ts
export const sourceFileImports = sqliteTable("source_file_imports", {
  sourceFileId: text("source_file_id").notNull(),
  importRunId: text("import_run_id").notNull(),
  sourceRelativePath: text("source_relative_path").notNull(),
  sourceFileHash: text("source_file_hash").notNull(),
  sourceFileBytes: integer("source_file_bytes").notNull(),
  sourceFileModifiedAt: text("source_file_modified_at"),
  importedAt: text("imported_at").notNull(),
  bank: text("bank").notNull(),
  product: text("product").notNull(),
  rowCount: integer("row_count").notNull(),
  status: text("status").notNull(),
  recordJson: text("record_json").notNull(),
}, (table) => [primaryKey({ columns: [table.sourceFileId, table.importRunId] })]);

export const dataIssues = sqliteTable("data_issues", {
  dataIssueId: text("data_issue_id").primaryKey(),
  accountId: text("account_id").notNull(),
  accountLabel: text("account_label").notNull(),
  accountContextJson: text("account_context_json").notNull(),
  fieldKey: text("field_key").notNull(),
  reportedValue: real("reported_value").notNull(),
  currency: text("currency").notNull(),
  dataDate: text("data_date"),
  note: text("note").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [check("ck_data_issues_status", sql`${table.status} IN ('pending','investigating','resolved','restored')`)]);

export const disabledImportSources = sqliteTable("disabled_import_sources", {
  disabledImportSourceId: text("disabled_import_source_id").primaryKey(),
  dataIssueId: text("data_issue_id").notNull(),
  sourceFileId: text("source_file_id").notNull(),
  importRunId: text("import_run_id").notNull(),
  reason: text("reason").notNull(),
  state: text("state").notNull(),
  disabledAt: text("disabled_at").notNull(),
  restoredAt: text("restored_at"),
  previewToken: text("preview_token").notNull(),
}, (table) => [
  uniqueIndex("uq_disabled_import_source_scope").on(table.sourceFileId, table.importRunId),
  check("ck_disabled_import_sources_state", sql`${table.state} IN ('active','restored')`),
]);

export const dataIssueEvents = sqliteTable("data_issue_events", {
  dataIssueEventId: text("data_issue_event_id").primaryKey(),
  dataIssueId: text("data_issue_id").notNull(),
  eventType: text("event_type").notNull(),
  stage: text("stage").notNull(),
  outcome: text("outcome").notNull(),
  summary: text("summary").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_data_issue_events_case_time").on(table.dataIssueId, table.createdAt),
  check("ck_data_issue_events_outcome", sql`${table.outcome} IN ('succeeded','blocked','failed')`),
]);
```

- [ ] **Step 4: Add migration 24**

Create `createPersistentDataIssues(db)` with exact SQL matching the Drizzle schema, then backfill current source versions:

```sql
INSERT OR IGNORE INTO source_file_imports (
  source_file_id, import_run_id, source_relative_path, source_file_hash,
  source_file_bytes, source_file_modified_at, imported_at, bank, product,
  row_count, status, record_json
)
SELECT source_file_id, import_run_id, source_relative_path, source_file_hash,
  source_file_bytes, source_file_modified_at, imported_at, bank, product,
  row_count, status, record_json
FROM source_files;
```

Append `{ version: 24, name: "persistent_data_issues", up: createPersistentDataIssues }` to `migrations`.

- [ ] **Step 5: Run migration checks and confirm GREEN**

Run the Step 2 command. Expected: all migration checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/ledger/db/schema.ts src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts
git commit -m "feat: add persistent data issue schema"
```

---

### Task 2: Append source versions during import

**Files:**
- Modify: `src/ledger/import-downloads-csv.ts`
- Modify: `src/ledger/import-downloads-csv.check.ts`

**Interfaces:**
- Consumes `sourceFileRecordFromBatch(record)`.
- Produces one `source_file_imports` row for every processed CSV in the same transaction as typed rows.

- [ ] **Step 1: Write failing importer checks**

Add synthetic fixtures for `fictional-bank/statements/source.csv` and assert:

```ts
assert.equal(db.prepare(`
  SELECT COUNT(*) AS count FROM source_file_imports
  WHERE source_file_id = ?
`).get(sourceFileId)?.count, 2);
```

Run the same unchanged CSV twice and assert two distinct `import_run_id` values exist even when the second run imports zero typed rows. Then change one synthetic amount, import again, and assert the new typed row uses the third run ID.

- [ ] **Step 2: Run the focused check and confirm RED**

```bash
node --no-warnings --experimental-strip-types --test src/ledger/import-downloads-csv.check.ts
```

Expected: FAIL because `source_file_imports` only contains the migration backfill.

- [ ] **Step 3: Add the append helper**

```ts
function insertSourceFileImport(db: LedgerDatabase, record: Record<string, unknown>) {
  insertRecord(db, "source_file_imports", sourceFileRecordFromBatch(record));
}
```

Inside the existing import transaction, call `insertSourceFileImport` immediately before `insertSourceFile` for each source record. Do not catch uniqueness errors: `(source_file_id, import_run_id)` must be unique within a run.

- [ ] **Step 4: Run importer and migration checks**

```bash
node --no-warnings --experimental-strip-types --test src/ledger/import-downloads-csv.check.ts src/ledger/db/migrations.check.ts
```

Expected: both files pass, including duplicate-only and corrected-content cases.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "feat: retain every imported source version"
```

---

### Task 3: Shared ledger visibility and unavailable accounts

**Files:**
- Create: `src/lib/data-issues/server/ledger-visibility.ts`
- Create: `src/lib/data-issues/server/ledger-visibility.check.ts`
- Modify: `src/lib/shared-ledger/types.ts`
- Modify: `src/lib/shared-ledger/server/accounts.ts`
- Modify: `src/lib/shared-ledger/server/accounts.check.ts`
- Modify: `src/lib/overview/server/load-overview.ts`
- Modify: `src/lib/assets/server/load-assets.ts`
- Modify: `src/lib/liabilities/server/load-liabilities.ts`
- Modify: `src/lib/spending/server/store.ts`
- Modify: `src/lib/spending/server/store.check.ts`

**Interfaces:**
- Produces `ImportScope`, `loadActiveImportScopes(db)`, `applyLedgerVisibility(data, scopes)`, `accountIdsForImportScope(data, scope)`, `appendUnavailableAccounts(accounts, issues)`, and `activeImportSql(alias)`.
- All page calculations consume filtered `LedgerQueryData`.

- [ ] **Step 1: Write failing generic visibility checks**

Use only fictional rows:

```ts
const scopes = new Set(["source-a|run-a"]);
const filtered = applyLedgerVisibility({
  ...emptyLedgerQueryData(),
  loanTransactions: [excludedLoan, activeLoan],
  creditCardStatementLines: [excludedCardRow, activeCardRow],
  creditCardCaptureEntries: [excludedEntry, activeEntry],
  creditCardCaptures: [oldCapture, excludedCapture],
  creditCardSnapshots: [oldSnapshot, excludedSnapshot],
}, scopes);

assert.deepEqual(filtered.loanTransactions.map((row) => row.statementRowId), ["loan-active"]);
assert.deepEqual(latestVerifiedCreditCardSnapshots(filtered).map((row) => row.captureId), ["capture-old"]);
```

Add an account-model assertion:

```ts
const account = unavailableAccountFromIssue({
  dataIssueId: "issue-a",
  accountId: "loan-example-0420",
  accountLabel: "Example Bank loan ****0420",
  accountContext: {
    institution: "Example Bank",
    product: "loan-statements",
    group: "liability",
    kind: "loan",
    typeLabel: "Loan",
  },
});
assert.deepEqual(account.amountLines, []);
assert.equal(account.valueAvailability, "unavailable");
assert.deepEqual(totalsForAccounts([account]), { assets: {}, liabilities: {}, investments: {}, net: {} });
```

- [ ] **Step 2: Run checks and confirm RED**

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/ledger-visibility.check.ts src/lib/shared-ledger/server/accounts.check.ts
```

Expected: FAIL because the visibility module and availability fields do not exist.

- [ ] **Step 3: Implement the minimum shared filter**

```ts
export type ImportScope = `${string}|${string}`;

export function importScope(row: { sourceFileId: string; importRunId: string }): ImportScope {
  return `${row.sourceFileId}|${row.importRunId}`;
}

function completeCaptureIds(
  captures: LedgerQueryData["creditCardCaptures"],
  allEntries: LedgerQueryData["creditCardCaptureEntries"],
  activeEntries: LedgerQueryData["creditCardCaptureEntries"],
) {
  const captureById = new Map(captures.map((capture) => [capture.captureId, capture]));
  const expectedCards = new Map<string, Set<string>>();
  for (const entry of allEntries) {
    if (!captureById.has(entry.captureId)) continue;
    const cards = expectedCards.get(entry.captureId) ?? new Set<string>();
    cards.add(entry.cardKey);
    expectedCards.set(entry.captureId, cards);
  }
  const statementTypes = new Map<string, Set<string>>();
  for (const entry of activeEntries) {
    if (!captureById.has(entry.captureId)) continue;
    const key = `${entry.captureId}|${entry.cardKey}`;
    const types = statementTypes.get(key) ?? new Set<string>();
    types.add(entry.statementType);
    statementTypes.set(key, types);
  }
  return new Set([...expectedCards]
    .filter(([captureId, cards]) => [...cards].every((cardKey) => {
      const types = statementTypes.get(`${captureId}|${cardKey}`);
      return types?.has("billed") && types.has("unbilled");
    }))
    .map(([captureId]) => captureId));
}

export function applyLedgerVisibility(
  data: LedgerQueryData,
  disabled: ReadonlySet<ImportScope>,
): LedgerQueryData {
  const active = <T extends { sourceFileId: string; importRunId: string }>(rows: T[]) =>
    rows.filter((row) => !disabled.has(importScope(row)));
  const creditCardStatementLines = active(data.creditCardStatementLines);
  const activeCardRows = new Set(creditCardStatementLines.map((row) => row.statementRowId));
  const creditCardCaptureEntries = data.creditCardCaptureEntries
    .filter((entry) => activeCardRows.has(entry.statementRowId));
  const activeCaptureIds = completeCaptureIds(
    data.creditCardCaptures,
    data.creditCardCaptureEntries,
    creditCardCaptureEntries,
  );

  return {
    ...data,
    accountTransactions: active(data.accountTransactions),
    foreignCurrencyTransactions: active(data.foreignCurrencyTransactions),
    creditCardStatementLines,
    creditCardCaptureEntries,
    creditCardCaptures: data.creditCardCaptures.filter((row) => activeCaptureIds.has(row.captureId)),
    creditCardSnapshots: data.creditCardSnapshots.filter((row) => row.captureId === null || activeCaptureIds.has(row.captureId)),
    loanTransactions: active(data.loanTransactions),
    fundHoldings: active(data.fundHoldings),
    fundBuyTransactions: active(data.fundBuyTransactions),
    fundRedemptionTransactions: active(data.fundRedemptionTransactions),
    fundCashDividends: active(data.fundCashDividends),
    fundConversionTransactions: active(data.fundConversionTransactions),
    brokerageHoldings: active(data.brokerageHoldings),
    brokerageTradeTransactions: active(data.brokerageTradeTransactions),
    maicoinAccountSnapshots: data.maicoinAccountSnapshots,
    maicoinStatementRows: data.maicoinStatementRows,
  };
}
```

The helper above requires billed and unbilled evidence before retaining a capture, matching the existing capture completeness contract.

Add `valueAvailability: "available" | "unavailable"` and optional `dataIssueId` to `AccountRowDto`; existing built accounts use `available`. `unavailableAccountFromIssue` returns empty `amountLines`, and aggregators already ignore it because there is no numeric amount.

For diagnosis, add a scope-only selector and reuse existing account normalization:

```ts
export function accountIdsForImportScope(data: LedgerQueryData, scope: ImportScope) {
  const scoped = selectLedgerScopes(data, new Set([scope]));
  return new Set([
    ...buildAccountOverview(scoped).map((account) => account.id),
    ...Object.keys(buildTransactionsByAccount(scoped)),
  ]);
}
```

`selectLedgerScopes` mirrors `applyLedgerVisibility` but retains matching typed rows instead of excluding them; it applies the same capture completeness rule.

- [ ] **Step 4: Apply the filter at every loader boundary**

In overview/assets/liabilities, load active scopes with the existing SQLite handle, then replace:

```ts
const data: LedgerQueryData = { /* existing rows */ };
```

with:

```ts
const visibleData = applyLedgerVisibility(data, loadActiveImportScopes(sqlite));
const accounts = appendUnavailableAccounts(
  buildAccountOverview(visibleData),
  loadUnavailableAccountIssues(sqlite),
);
```

Pass `visibleData` to every transaction, position, and history builder.

For spending, use one parameter-free internal predicate:

```ts
export function activeImportSql(alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("Unsafe SQL alias");
  return `NOT EXISTS (
    SELECT 1 FROM disabled_import_sources AS disabled
    WHERE disabled.state = 'active'
      AND disabled.source_file_id = ${alias}.source_file_id
      AND disabled.import_run_id = ${alias}.import_run_id
  )`;
}
```

Add it to invoices, account transactions, and credit-card statement queries. Invoice items remain reachable only through an active invoice.

- [ ] **Step 5: Run focused and page checks**

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/ledger-visibility.check.ts src/lib/shared-ledger/server/accounts.check.ts src/lib/spending/server/store.check.ts
```

Expected: all focused checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/data-issues/server/ledger-visibility.ts src/lib/data-issues/server/ledger-visibility.check.ts src/lib/shared-ledger/types.ts src/lib/shared-ledger/server/accounts.ts src/lib/shared-ledger/server/accounts.check.ts src/lib/overview/server/load-overview.ts src/lib/assets/server/load-assets.ts src/lib/liabilities/server/load-liabilities.ts src/lib/spending/server/store.ts src/lib/spending/server/store.check.ts
git commit -m "feat: exclude disabled imports from ledger views"
```

---

### Task 4: Persistent data-issue service

**Files:**
- Create: `src/lib/data-issues/types.ts`
- Create: `src/lib/data-issues/server/store.ts`
- Create: `src/lib/data-issues/server/store.check.ts`

**Interfaces:**
- Produces `listDataIssues`, `createDataIssue`, `loadDataIssue`, `startDataIssueDiagnosis`, `previewDataIssueExclusion`, `confirmDataIssueExclusion`, `previewDataIssueRestore`, and `confirmDataIssueRestore`.
- Uses backend-generated IDs/timestamps and a stable SHA-256 preview token.

- [ ] **Step 1: Define DTOs and write failing service checks**

Define the public commands without physical row IDs:

```ts
export type DataIssueCreateInput = {
  account: Pick<AccountRowDto, "id" | "label" | "institution" | "product" | "group" | "kind" | "typeLabel" | "amountLines" | "lastUpdated">;
  fieldKey: "balance";
  note: string;
};

export type SourceVersionId = { sourceFileId: string; importRunId: string };

export type PreviewExclusionInput = {
  dataIssueId: string;
  sourceVersion: SourceVersionId;
};

export type ConfirmExclusionInput = {
  dataIssueId: string;
  sourceVersion: SourceVersionId;
  reason: string;
  acknowledged: true;
  previewToken: string;
};

export type ConfirmRestoreInput = {
  dataIssueId: string;
  previewToken: string;
};

export type DataIssueEventDto = {
  dataIssueEventId: string;
  eventType: string;
  stage: string;
  outcome: "succeeded" | "blocked" | "failed";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type SourceImportCandidateDto = SourceVersionId & {
  fileName: string;
  importedAt: string;
  csvRows: number;
  insertedRows: number;
  duplicateRows: number;
  affectedAccounts: number;
};

export type DataIssueListItemDto = {
  dataIssueId: string;
  accountLabel: string;
  status: "pending" | "investigating" | "resolved" | "restored";
  reportedValue: CurrencyAmountDto;
  createdAt: string;
  updatedAt: string;
};

export type DataIssueDetailDto = {
  dataIssueId: string;
  status: "pending" | "investigating" | "resolved" | "restored";
  account: DataIssueCreateInput["account"];
  fieldKey: "balance";
  reportedValue: CurrencyAmountDto;
  dataDate: string | null;
  note: string;
  candidates: SourceImportCandidateDto[];
  events: DataIssueEventDto[];
};

export type ExclusionPreviewDto = {
  sourceVersion: SourceVersionId;
  previewToken: string;
  csvRows: number;
  excludedRows: number;
  duplicateRows: number;
  affectedAccounts: Array<{
    accountId: string;
    before: { availability: "available" | "unavailable"; amounts: CurrencyAmountDto[] };
    after: { availability: "available" | "unavailable"; amounts: CurrencyAmountDto[] };
  }>;
};

export type RestorePreviewDto = {
  allowed: boolean;
  previewToken: string;
  blockedBy: Array<{ accountId: string; updatedAt: string }>;
  affectedAccounts: ExclusionPreviewDto["affectedAccounts"];
};
```

Write independent tests proving:

```ts
const created = createDataIssue(input, ledgerDir, clock);
assert.equal(created.status, "pending");
assert.equal(loadDataIssue(created.dataIssueId, ledgerDir).events.length, 1);

const preview = previewDataIssueExclusion({
  dataIssueId: created.dataIssueId,
  sourceVersion: { sourceFileId: "source-a", importRunId: "run-a" },
}, ledgerDir);
assert.equal(preview.excludedRows, 2);
assert.equal(preview.affectedAccounts[0]?.after.availability, "unavailable");

const resolved = confirmDataIssueExclusion({
  dataIssueId: created.dataIssueId,
  sourceVersion: preview.sourceVersion,
  reason: "Synthetic source mismatch",
  acknowledged: true,
  previewToken: preview.previewToken,
}, ledgerDir);
assert.equal(resolved.status, "resolved");
```

Add cases for stale token, double confirm, injected transaction failure rollback, persisted failed event, restore blocked by newer active data, and successful restore without newer data.

- [ ] **Step 2: Run the service check and confirm RED**

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/store.check.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement validation and event helpers**

```ts
const NOTE_LIMIT = 500;
const REASON_LIMIT = 300;

function requiredText(value: unknown, label: string, limit: number) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  if (value.length > limit) throw new Error(`${label} exceeds ${limit} characters`);
  return value.trim();
}

function appendEvent(db: LedgerDatabase, event: DataIssueEventInsert) {
  db.prepare(`INSERT INTO data_issue_events (
    data_issue_event_id, data_issue_id, event_type, stage, outcome,
    summary, details_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id, event.dataIssueId, event.type, event.stage, event.outcome,
      event.summary, JSON.stringify(event.details), event.createdAt);
}
```

Define the insert shape beside the helper:

```ts
type DataIssueEventInsert = {
  id: string;
  dataIssueId: string;
  type: string;
  stage: string;
  outcome: "succeeded" | "blocked" | "failed";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
};
```

Convert thrown errors to stable codes such as `DATA_ISSUE_NOT_FOUND`, `SOURCE_VERSION_NOT_FOUND`, `STALE_PREVIEW`, `RESTORE_NEWER_DATA`, and `LEDGER_WRITE_FAILED`. Strip absolute paths before persisting details.

- [ ] **Step 4: Implement candidate and preview calculation**

Use the `TYPED_STATEMENT_TABLES` whitelist. Query only backend-selected table names, group physical rows by `(source_file_id, import_run_id)`, and derive candidates from rows whose normalized account ID matches the case. Calculate preview twice from the same loaded dataset:

```ts
type PhysicalSourceRow = {
  table: TypedStatementTable;
  statementRowId: string;
  sourceFileId: string;
  importRunId: string;
  importedAt: string;
};

function physicalRowsForSource(db: LedgerDatabase, source: SourceVersionId) {
  return TYPED_STATEMENT_TABLES.flatMap((table) =>
    (db.prepare(`SELECT statement_row_id, source_file_id, import_run_id, imported_at
      FROM ${table} WHERE source_file_id = ? AND import_run_id = ?`)
      .all(source.sourceFileId, source.importRunId) as Array<{
        statement_row_id: string;
        source_file_id: string;
        import_run_id: string;
        imported_at: string;
      }>).map((row): PhysicalSourceRow => ({
        table,
        statementRowId: row.statement_row_id,
        sourceFileId: row.source_file_id,
        importRunId: row.import_run_id,
        importedAt: row.imported_at,
      })),
  );
}
```

`table` is safe here because every value comes from the constant `TYPED_STATEMENT_TABLES`, never renderer input. Candidates retain a source when `accountIdsForImportScope(rawData, importScope(source))` contains the reported account ID.

Calculate preview twice from the same loaded dataset:

```ts
const allPhysicalRows = physicalRowsForSource(db, sourceVersion);
const before = buildAccountOverview(visibleData);
const after = buildAccountOverview(applyLedgerVisibility(rawData, new Set([...activeScopes, selectedScope])));
const previewToken = hashBytes(stableStringify({
  dataIssueId,
  sourceVersion,
  activeScopes: [...activeScopes].sort(),
  affected: affectedAccounts,
  latestImport: allPhysicalRows.map((row) => row.importedAt).sort().at(-1) ?? "",
}));
```

Count physical inserted rows with `source_file_id` and `import_run_id`; obtain CSV row count from `source_file_imports`; `duplicateRows = max(0, row_count - physicalRows)`.

- [ ] **Step 5: Implement atomic confirm and conditional restore**

Confirmation must follow this exact transaction shape:

```ts
db.exec("BEGIN IMMEDIATE");
try {
  const fresh = previewExclusionWithDb(db, input.dataIssueId, input.sourceVersion);
  if (fresh.previewToken !== input.previewToken) throw dataIssueError("STALE_PREVIEW");
  upsertActiveExclusion(db, input, fresh);
  updateCaseStatus(db, input.dataIssueId, "resolved", now);
  appendEvent(db, succeededExclusionEvent(input, fresh, now));
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  recordFailureBestEffort(db, input.dataIssueId, "exclusion", error, now);
  throw error;
}
```

Repeated confirmation of the already-active scope returns the current case without adding a second exclusion. Restore preview compares each affected account's newest active import time to `disabled_at`; any newer value returns `allowed: false`. Confirm restore reruns that preview under `BEGIN IMMEDIATE` and only then updates state.

- [ ] **Step 6: Run the service and visibility checks**

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/server/store.check.ts src/lib/data-issues/server/ledger-visibility.check.ts
```

Expected: all service scenarios pass and failed mutations leave visible balances unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data-issues/types.ts src/lib/data-issues/server/store.ts src/lib/data-issues/server/store.check.ts
git commit -m "feat: persist data issue resolution workflow"
```

---

### Task 5: Typed desktop API and IPC

**Files:**
- Modify: `src/lib/desktop/api.ts`
- Modify: `src/lib/desktop/api.check.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/preload.check.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/ipc.check.ts`

**Interfaces:**
- Consumes all service functions from Task 4.
- Produces `window.octopusBeak.dataIssues` with no raw database parameters.

- [ ] **Step 1: Write failing API and IPC checks**

Assert the channel allowlist contains exactly:

```ts
const channels = [
  "dataIssues:list",
  "dataIssues:create",
  "dataIssues:load",
  "dataIssues:startDiagnosis",
  "dataIssues:previewExclusion",
  "dataIssues:confirmExclusion",
  "dataIssues:previewRestore",
  "dataIssues:confirmRestore",
];
for (const channel of channels) assert.ok(octopusBeakApiChannels.includes(channel));
```

Preload checks assert each method delegates to the matching channel. IPC checks invoke handlers with fictional payloads and assert they call the service once.

- [ ] **Step 2: Run checks and confirm RED**

```bash
node --no-warnings --experimental-strip-types --test src/lib/desktop/api.check.ts electron/preload.check.ts electron/ipc.check.ts
```

Expected: FAIL because the namespace and handlers are absent.

- [ ] **Step 3: Add the typed API**

```ts
dataIssues: {
  list(): Promise<DataIssueListItemDto[]>;
  create(input: DataIssueCreateInput): Promise<DataIssueDetailDto>;
  load(dataIssueId: string): Promise<DataIssueDetailDto>;
  startDiagnosis(dataIssueId: string): Promise<DataIssueDetailDto>;
  previewExclusion(input: PreviewExclusionInput): Promise<ExclusionPreviewDto>;
  confirmExclusion(input: ConfirmExclusionInput): Promise<DataIssueDetailDto>;
  previewRestore(dataIssueId: string): Promise<RestorePreviewDto>;
  confirmRestore(input: ConfirmRestoreInput): Promise<DataIssueDetailDto>;
};
```

Add one `ipcRenderer.invoke` method per operation in preload and one `ipcMain.handle` delegation per channel. Service validation remains authoritative; handlers type payloads but do not duplicate business logic.

- [ ] **Step 4: Run focused checks**

Run the Step 2 command. Expected: all API, preload, and IPC checks pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/desktop/api.ts src/lib/desktop/api.check.ts electron/preload.ts electron/preload.check.ts electron/ipc.ts electron/ipc.check.ts
git commit -m "feat: expose persistent data issue desktop API"
```

---

### Task 6: Replace the prototype with the persistent UI

**Files:**
- Create: `src/lib/data-issues/DataIssuesDashboard.svelte`
- Create: `src/lib/data-issues/data-issues-ui.check.ts`
- Modify: `src/lib/data-issues/ReportDataIssueModal.svelte`
- Modify: `src/lib/liabilities/LiabilitiesDashboard.svelte`
- Modify: `src/routes/+page.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Delete: `src/lib/data-issues/DataIssuesPrototype.svelte`
- Delete: `src/lib/data-issues/prototype-model.ts`
- Delete: `src/lib/data-issues/prototype-model.check.ts`
- Delete: `src/lib/data-issues/prototype-ui.check.ts`

**Interfaces:**
- Consumes `window.octopusBeak.dataIssues` from Task 5.
- Preserves the current single-card flow, `slide` transition, warning-icon entry, and reduced-motion behavior.

- [ ] **Step 1: Write the failing UI contract check**

Assert production wiring and removed prototype behavior:

```ts
assert.match(dashboard, /window\.octopusBeak\.dataIssues\.list\(\)/);
assert.match(dashboard, /window\.octopusBeak\.dataIssues\.previewExclusion/);
assert.match(dashboard, /window\.octopusBeak\.dataIssues\.confirmExclusion/);
assert.match(dashboard, /transition:slide/);
assert.match(dashboard, /class="stage-error"/);
assert.match(dashboard, /<summary>\{\$t\.dataIssues\.operationHistory\}<\/summary>/);
assert.doesNotMatch(dashboard, /prototype|sessionStorage|scenario/);
assert.doesNotMatch(dashboard, /class="error-history"|class="case-heading"/);
assert.match(route, /DataIssuesDashboard/);
```

The liabilities check must assert report submission awaits `dataIssues.create` and navigates to `#/data-issues/<id>`.

- [ ] **Step 2: Run UI checks and confirm RED**

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts
```

Expected: FAIL because the persistent dashboard does not exist.

- [ ] **Step 3: Make report creation persistent**

Change the modal callback to async and preserve input on failure:

```ts
export let onSubmit: (input: DataIssueCreateInput) => Promise<void>;
let submitting = false;
let errorMessage = "";

async function submit() {
  if (!account || submitting) return;
  submitting = true;
  errorMessage = "";
  try {
    await onSubmit({ account, fieldKey: "balance", note });
    note = "";
    close();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    submitting = false;
  }
}
```

In liabilities:

```ts
async function createReport(input: DataIssueCreateInput) {
  const issue = await window.octopusBeak.dataIssues.create(input);
  location.hash = `/data-issues/${issue.dataIssueId}`;
}
```

- [ ] **Step 4: Build the persistent dashboard**

Use route state `#/data-issues` for the list and `#/data-issues/<id>` for detail. Keep one component-local load state:

```ts
type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "list"; issues: DataIssueListItemDto[] }
  | { status: "detail"; issue: DataIssueDetailDto; preview: ExclusionPreviewDto | null };
```

The detail card renders report, source selection, preview, confirmation, inline `stage-error`, and bottom `操作紀錄`. Do not render the removed breadcrumb, status chip, or page-level error banner. Disable actions while awaiting IPC. Preserve reason, acknowledgement, and selected source after failures.

For unavailable accounts, render:

```svelte
{#if account.valueAvailability === "unavailable"}
  <span>{$t.accounts.noAvailableData}</span>
  {#if account.dataIssueId}
    <a href={`#/data-issues/${account.dataIssueId}`}>{$t.dataIssues.viewIssue}</a>
  {/if}
{/if}
```

- [ ] **Step 5: Replace routing and copy**

Replace `DataIssuesPrototype` with `DataIssuesDashboard` in `+page.svelte`. Parse the optional ID from the hash without adding a router dependency. Replace prototype copy with production statuses, inline-error labels, restore-blocked copy, operation history, and `無可用資料`.

- [ ] **Step 6: Run UI, type, and accessibility checks**

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts src/lib/desktop/api.check.ts
npm run typecheck
```

Expected: focused tests pass and Svelte reports 0 errors and 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data-issues src/lib/liabilities/LiabilitiesDashboard.svelte src/routes/+page.svelte src/lib/i18n/i18n.ts
git commit -m "feat: connect data issue resolution interface"
```

---

### Task 7: End-to-end persistence and failure regression

**Files:**
- Modify: `src/lib/data-issues/server/store.check.ts`
- Modify: `src/lib/data-issues/data-issues-ui.check.ts`
- Modify: `design-qa.md`

**Interfaces:**
- Verifies all tasks as one user journey; adds no new production abstraction.

- [ ] **Step 1: Add the de-identified integration fixture**

Use values such as institution `Example Bank`, masked account `****0420`, reported balance `81,250`, corrected balance `63,900`, and dates under `2025-01`. Assert:

```ts
assert.equal(before.amountLines[0]?.value, 81_250);
assert.equal(after.amountLines[0]?.value, 63_900);
assert.equal(reopened.status, "resolved");
assert.equal(reopened.events.at(-1)?.outcome, "succeeded");
```

Close and reopen the SQLite database between confirmation and the final assertions. Add a forced preview/write failure and assert the visible balance remains `81_250` while one failed event is persisted.

- [ ] **Step 2: Run the full automated suite**

```bash
npm test -- --test-reporter=dot
npm run typecheck
npm run build
```

Expected: zero failed tests, 0 type errors/warnings, and both renderer and Electron builds exit 0.

- [ ] **Step 3: Verify the Electron journey**

Using the existing Electron CDP workflow:

1. Open a fictional liability account.
2. Submit a report and verify it immediately appears as `待處理`.
3. Start diagnosis and select a source version.
4. Preview impact and verify affected/unavailable accounts.
5. Confirm exclusion and verify all dashboards update.
6. Restart the app and verify the case, event history, and balance persist.
7. Trigger a synthetic failure and verify the inline error plus persisted operation record.
8. Verify a newer active import disables restore with the update date shown.
9. Verify `prefers-reduced-motion` disables the slide duration.
10. Inspect Electron console for zero unexpected errors and confirm no horizontal overflow at the narrow viewport.

- [ ] **Step 4: Update visual QA**

Place the approved references and fresh initial/diagnosis/preview/error/narrow screenshots in one comparison input. Record typography, spacing, token, copy, interaction, console, and responsive findings in `design-qa.md`; end the document with exactly:

```text
final result: passed
```

- [ ] **Step 5: Run final diff checks and commit**

```bash
git diff --check
git status --short
git add src/lib/data-issues/server/store.check.ts src/lib/data-issues/data-issues-ui.check.ts design-qa.md
git commit -m "test: verify persistent data issue workflow"
```

Expected: only intentional files are staged, secret scanning passes, and the worktree is clean after commit.

---

## Final acceptance checklist

- [ ] A report is persisted as `pending` without session storage.
- [ ] Candidate sources come from backend lineage, not renderer guesses.
- [ ] One exact source version can be previewed and excluded atomically.
- [ ] Identical reimports remain excluded and corrected rows remain active.
- [ ] Every dashboard and spending query uses the same exclusion contract.
- [ ] Credit-card captures fall back to the latest complete active capture.
- [ ] Missing values render as `無可用資料` and never as zero.
- [ ] Stale previews, database failures, and restore blocks persist safe events without changing ledger visibility.
- [ ] Restore is impossible after newer active account data.
- [ ] No committed fixture or artifact contains the real incident identity or values.
- [ ] Full tests, typecheck, build, Electron interaction, console, narrow layout, and design QA pass.
