# Credit Card Snapshot Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the ledger before Electron renders, capture complete Esun result sets, separate credit-card transaction identity from balance snapshots, and repair legacy partial daily history.

**Architecture:** Startup performs the existing writable ledger migration before window creation. Esun capture validates and merges every DataGrid page before marking sidecar metadata full. Migrations 14-15 add snapshot aggregates, backfill only defensible same-day full captures, and deduplicate transaction entities by a shared semantic key; daily history reads snapshots rather than treating source files as balances.

**Tech Stack:** TypeScript, Electron, Playwright/Libretto workflow APIs, Node.js `node:sqlite`, SQLite migrations, assert-based `.check.ts` scripts.

## Global Constraints

- Daily credit-card history means the last successful complete snapshot for each card and calendar day.
- Partial captures never overwrite or become complete snapshots.
- Transaction identity excludes `statement_period`, query dates, source path, and import time.
- Retain the earliest semantic duplicate by `imported_at`, `source_relative_path`, `source_row_index`, then `statement_row_id`.
- Personal-invoice upserts and non-credit-card `content_hash` uniqueness remain unchanged.
- Startup migration failure prevents main-window creation and uses the existing startup-error path.
- No dependency, generic snapshot framework, compatibility service, or new UI.

---

### Task 1: Run Ledger Migrations Before Electron Window Creation

**Files:**
- Create: `electron/startup-ledger.ts`
- Create: `electron/startup-ledger.check.ts`
- Modify: `electron/main.ts:124-139`

**Interfaces:**
- Produces: `migrateLedgerBeforeWindow(ledgerDir?: string): void`.
- Consumes: `process.env.OCTOPUSBEAK_LEDGER_DIR` when supplied; otherwise existing default ledger directory resolution.

- [ ] **Step 1: Write a failing startup migration check**

Create a temporary version-13 ledger, remove migration 14 when it exists in later tasks, then assert a dependency-injected open/close sequence runs before a fake window callback:

```ts
const events: string[] = [];
migrateLedgerBeforeWindow(undefined, {
  open: () => ({ close: () => events.push("close") }),
  beforeOpen: () => events.push("open"),
});
events.push("window");
assert.deepEqual(events, ["open", "close", "window"]);
```

Add a throwing `open` case and assert the error propagates without adding `window`.

- [ ] **Step 2: Run the check and verify RED**

```bash
node --no-warnings --experimental-strip-types electron/startup-ledger.check.ts
```

Expected: FAIL because `startup-ledger.ts` does not exist.

- [ ] **Step 3: Implement the focused startup helper**

```ts
import { openLedgerDatabase } from "../src/ledger/db/client.ts";

export function migrateLedgerBeforeWindow(
  ledgerDir = process.env.OCTOPUSBEAK_LEDGER_DIR,
  seams = {
    beforeOpen: () => {},
    open: (dir?: string) => openLedgerDatabase(dir),
  },
) {
  seams.beforeOpen();
  const db = seams.open(ledgerDir);
  db.close();
}
```

Call `migrateLedgerBeforeWindow()` in `start()` after desktop env/chdir setup and before IPC registration/window creation. Do not catch locally; `app.whenReady().then(start).catch(showStartupError)` already owns startup failures.

- [ ] **Step 4: Verify startup behavior and build**

```bash
node --no-warnings --experimental-strip-types electron/startup-ledger.check.ts
npm run build:electron
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/startup-ledger.ts electron/startup-ledger.check.ts
git commit -m "fix: migrate ledger before app startup"
```

---

### Task 2: Define Shared Credit-Card Semantic Identity and Snapshot Schema

**Files:**
- Create: `src/ledger/credit-card-identity.ts`
- Create: `src/ledger/credit-card-identity.check.ts`
- Modify: `src/ledger/db/schema.ts`
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/db/migrations.check.ts`

**Interfaces:**
- Produces: `creditCardSemanticKey(input: CreditCardSemanticIdentity): string`.
- Produces: migration 14 `credit_card_snapshots`.
- Produces: table `credit_card_snapshots` and indexes `uq_credit_card_snapshots_source_card_type`, `idx_credit_card_snapshots_card_day`.

- [ ] **Step 1: Add failing semantic-key checks**

Assert equal keys when only statement period/source/import time differ, and unequal keys when card, amount, date, description, currency, statement type, installment action, or payment status differs.

```ts
assert.equal(
  creditCardSemanticKey({ ...base, statementPeriod: "2025/06/27 ~ 2026/06/27" }),
  creditCardSemanticKey({ ...base, statementPeriod: "2025/07/12 ~ 2026/07/12" }),
);
assert.notEqual(
  creditCardSemanticKey(base),
  creditCardSemanticKey({ ...base, twdAmount: 101 }),
);
```

- [ ] **Step 2: Verify RED**

```bash
node --no-warnings --experimental-strip-types src/ledger/credit-card-identity.check.ts
```

- [ ] **Step 3: Implement the semantic key**

Use existing `stableStringify` + `hashBytes`, normalize card identity to last four digits, trim text, and normalize nullish values to empty strings. Include the required `ponytail:` ceiling comment immediately above the key material.

- [ ] **Step 4: Add failing migration-14 schema checks**

Expect migration versions `1..14`, the columns from the design, a unique source/card/type index, a card/day lookup index, and rejection of duplicate `(source_file_id, card_key, statement_type)`.

- [ ] **Step 5: Add migration 14 and current Drizzle schema**

Create the table exactly as specified in the design. Add `CHECK(transaction_count >= 0)` and `CHECK(statement_type IN ('billed','unbilled'))`. Also add a nullable `semantic_key TEXT` column to `credit_card_statement_lines`; it remains nullable until migration 15 backfills legacy rows. Reflect both changes in the current Drizzle schema.

- [ ] **Step 6: Verify GREEN**

```bash
node --no-warnings --experimental-strip-types src/ledger/credit-card-identity.check.ts
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/ledger/credit-card-identity.ts src/ledger/credit-card-identity.check.ts \
  src/ledger/db/schema.ts src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts
git commit -m "feat: add credit card snapshot schema"
```

---

### Task 3: Capture and Validate Every Esun DataGrid Page

**Files:**
- Modify: `src/workflows/esun-credit-card-statements.ts:278-394`
- Create: `src/workflows/esun-credit-card-statements.check.ts`

**Interfaces:**
- Produces: exported pure `mergeEsunStatementPages(pages, expectedTotal): StatementRow[]`.
- Produces: sidecar metadata `snapshotMode`, `snapshotCapturedAt`, `cardRowCounts`.
- Consumes: `creditCardSemanticKey` from Task 2.

- [ ] **Step 1: Freeze the live DataGrid pagination contract**

Use the Libretto workflow's existing authenticated Esun session to inspect the statement frame after query. Record in the task report the exact next-page locator, disabled/last-page signal, total-count text, and page-change signal. Save a sanitized DOM fragment as `.superpowers/sdd/esun-grid-pagination-fixture.html`; do not commit account data or credentials.

- [ ] **Step 2: Write failing pure merge/completeness checks**

Create two sanitized pages where one boundary row overlaps. Assert merged count equals the declared total and overlap appears once. Assert mismatched totals and a page sequence without a proven terminal state throw `Incomplete Esun credit-card statement capture`.

- [ ] **Step 3: Implement pure page merging**

Use `creditCardSemanticKey`; preserve first occurrence order. Return rows only when `uniqueRows.length === expectedTotal`.

- [ ] **Step 4: Implement browser pagination using the frozen contract**

Read the current page, record its row signature, click the exact next-page control from Step 1, and wait until the signature changes. Stop only on the frozen disabled/last-page signal. Reject a repeated signature while next remains enabled. Keep a hard ceiling of 100 pages with:

```ts
// ponytail: bank UI guard; raise only if Esun exposes more than 100 pages.
```

- [ ] **Step 5: Emit full-snapshot metadata only after validation**

`writeStatementFile` receives `snapshotCapturedAt` once per workflow run and writes `snapshotMode: "full"` plus `cardRowCounts`. Empty billed/unbilled groups remain valid full snapshots with count zero.

- [ ] **Step 6: Verify**

```bash
node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/workflows/esun-credit-card-statements.ts \
  src/workflows/esun-credit-card-statements.check.ts
git commit -m "fix: capture complete Esun card snapshots"
```

---

### Task 4: Import Full Snapshot Aggregates

**Files:**
- Modify: `src/ledger/import-downloads-csv.ts`
- Modify: `src/ledger/import-downloads-csv.check.ts`

**Interfaces:**
- Consumes: sidecar `snapshotMode: "full"`, `snapshotCapturedAt`, `cardRowCounts`.
- Produces: one `credit_card_snapshots` row per card/type/source file.
- Preserves: ordinary transaction insert outcome counts and personal-invoice upserts.

- [ ] **Step 1: Add failing full/legacy sidecar import checks**

Import a credit-card CSV with two cards and a full sidecar. Assert per-card count/total/currency/captured time and source ID. Import the same CSV with no `snapshotMode`; assert no snapshot row. Add a malformed full sidecar missing `snapshotCapturedAt`; assert the import fails and rolls back both transactions and snapshots.

- [ ] **Step 2: Verify RED**

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
```

- [ ] **Step 3: Validate snapshot sidecar fields at the trust boundary**

Add a small local Zod schema for full snapshot metadata. Do not generalize all sidecars. Only `snapshotMode === "full"` activates strict snapshot validation.

- [ ] **Step 4: Insert aggregates in the existing import transaction**

Group parsed `credit_card_statement_lines` by card last four + statement type + currency, sum `twd_amount`, count semantic transactions, and insert snapshots after typed rows but before run/event records. Derive `as_of_date` from `snapshotCapturedAt.slice(0, 10)`.

Write `semantic_key` on every newly imported credit-card statement row using Task 2's shared helper. Continue writing no semantic key for other typed tables.

- [ ] **Step 5: Verify GREEN**

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "feat: import complete card snapshots"
```

---

### Task 5: Backfill Legacy Snapshots and Deduplicate Card Transactions

**Files:**
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/db/migrations.check.ts`

**Interfaces:**
- Consumes: Task 2 `creditCardSemanticKey`; migration code imports and calls the shared helper rather than duplicating key construction.
- Produces: migration 15 `backfilled_credit_card_snapshots`.
- Preserves: migration 12 non-card unique indexes and personal-invoice behavior.

- [ ] **Step 1: Add failing migration fixtures**

Seed same-day source groups matching the observed 8397 shapes: an earlier 9-row set plus a later 2-row proper subset on 6/30, and an earlier 12-row set plus a later 1-row subset on 7/3. Add an equal-set later capture and a superset later capture. Assert subsets produce no snapshot, latest equal/superset does, and semantic duplicates retain the earliest statement row.

- [ ] **Step 2: Verify RED**

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

- [ ] **Step 3: Implement migration 15 transactionally**

Read legacy credit-card rows grouped by `source_file_id`, card, type, and import day. Build semantic-key sets in TypeScript inside the migration. A later proper subset is ineligible; equal/superset is eligible. Insert the latest eligible same-day snapshot, then delete later semantic duplicate rows using the canonical ordering.

Do not infer subset relationships across dates. Migration 15 backfills every null `semantic_key` with the shared helper, drops `uq_credit_card_statement_lines_content_hash`, performs semantic cleanup, makes no attempt to rebuild the table solely to add `NOT NULL`, and creates `uq_credit_card_statement_lines_semantic_key` on the now fully populated column. Add a check proving no null semantic keys remain.

- [ ] **Step 4: Verify GREEN and rollback behavior**

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
npm run typecheck
```

Expected: versions `1..15`; known partials excluded; a forced invalid snapshot insert rolls back migration 15.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts
git commit -m "feat: backfill credit card snapshots"
```

---

### Task 6: Read Snapshot-Based Daily Credit-Card History

**Files:**
- Modify: `src/lib/overview/server/load-overview.ts`
- Modify: `src/lib/liabilities/server/load-liabilities.ts`
- Modify: `src/lib/shared-ledger/server/accounts.ts`
- Modify: `src/lib/shared-ledger/server/mock-data.ts`
- Modify: `src/lib/shared-ledger/server/accounts.check.ts`
- Modify: `src/lib/overview/server/daily-history.ts`
- Modify: `src/lib/overview/server/daily-history.check.ts`

**Interfaces:**
- Consumes: `credit_card_snapshots` rows.
- Produces: latest complete per-card/day liabilities for daily history.
- Preserves: transaction list construction from semantic-deduplicated statement rows.

- [ ] **Step 1: Add failing daily-history checks**

Create snapshots for one card with two same-day complete captures and one next-day capture. Assert the later same-day complete total is used. Add transaction source rows with misleading later partial totals and assert they do not affect history. Encode the legacy 8397 expected corrections: 6/30 must not be 160 and 7/3 must not be 142.

- [ ] **Step 2: Verify RED**

```bash
node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts
```

- [ ] **Step 3: Load and map snapshot rows**

Add snapshots to `LedgerQueryData`, empty fixtures, mock data, `loadOverview`, and `loadLiabilities`. For current positions select the latest snapshot per card/type and join the latest transaction row only for display label/provenance; the amount comes from the snapshot. For daily history select latest `captured_at` within each `as_of_date`.

- [ ] **Step 4: Remove transaction-source snapshot inference**

Delete `creditCardSnapshotKey`, `creditCardSnapshotSortKey`, and the source-file-based credit-card balance selection where snapshots now supply totals. Keep semantic transaction mapping for transaction lists.

- [ ] **Step 5: Verify**

```bash
node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts
node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared-ledger/server src/lib/overview/server/daily-history.ts \
  src/lib/overview/server/daily-history.check.ts
git commit -m "fix: build card history from complete snapshots"
```

---

### Task 7: Full Verification and Electron CDP Review

**Files:**
- No product files expected.

- [ ] **Step 1: Run all focused checks**

```bash
node --no-warnings --experimental-strip-types electron/startup-ledger.check.ts
node --no-warnings --experimental-strip-types src/ledger/credit-card-identity.check.ts
node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts
node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 2: Verify startup migration against a copied legacy ledger**

Copy the user's ledger to a temporary directory, remove versions 14-15 and their new objects from the copy, start Electron against the copy, and assert versions 14-15 exist before the overview IPC returns. Never mutate the user's original ledger during verification.

- [ ] **Step 3: Verify live liabilities through CDP**

Confirm the 8397 daily table no longer contains TWD 160 on 6/30 or TWD 142 on 7/3, current totals match the production model, reload is stable, and no migration/snapshot errors appear in renderer or main-process output.

- [ ] **Step 4: Final scope check**

```bash
git status --short
git log -8 --oneline
```

Expected: only planned commits/files; no credential, bank DOM fixture, copied ledger, or user data is tracked.
