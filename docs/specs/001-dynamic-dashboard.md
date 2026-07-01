# 001 Dynamic Dashboard

Status: Implemented MVP; historical spec retained
Date: 2026-06-25
Last updated: 2026-07-01
Target repo: `/Users/willywangkaa/.codex/worktrees/1ae6/libretto-playground`

## Purpose

Replace the legacy static dashboard with live SvelteKit dashboards backed by the existing SQLite ledger.

The MVP matched the legacy static dashboard scope, then split the user-facing app into `/overview`, `/assets`, and `/liabilities`. `/dashboard` now redirects to `/overview`.

## Current Flow

The current system works like this:

1. `src/workflows/*` downloads bank-provided account statements into `downloads/`.
2. `src/ledger/import-downloads-csv.ts` parses CSV files and writes typed statement rows into `data/ledger/ledger.sqlite`.
3. `/overview`, `/assets`, and `/liabilities` read `ledger.sqlite` through SvelteKit server load functions.
4. `/automation` can run the existing crawler/sync/import scripts and record task history in the same ledger.
5. New imports are visible by reloading the dashboard page.

## MVP Scope

Build SvelteKit dashboards that read `data/ledger/ledger.sqlite` directly and render the same dashboard concepts from the legacy static dashboard.

Included:

- Summary metrics:
  - Net position
  - Asset value
  - Liabilities
- Investments through the asset total and account groups
- Snapshot history / daily asset changes table
- Account lists with:
  - All / Assets / Liabilities / Investments filters
  - Account search
  - Value visibility toggle
- Account drilldown:
  - Transaction modal
  - Asset positions modal
- SQLite schema migration using the existing `schema_migrations` table
- Drizzle schema and typed queries for dashboard read paths

Explicitly excluded from this MVP:

- `CashflowPipeline`
- `SourceHealthPipeline`
- Separate `/sources` page
- Runtime dependency on the removed static financial model builder
- Drizzle Kit as the owner of existing ledger schema migrations
- Rewriting the statement download workflows
- Rewriting the CSV import pipeline unless needed to extract DB/migration helpers

## Target Architecture

The system should split into two paths: the existing write path and the new dashboard read path.

Write path:

```text
workflows
  -> downloads
  -> import-downloads-csv.ts
  -> migrateLedgerDb()
  -> data/ledger/ledger.sqlite
```

Read path:

```text
/overview/+page.server.ts
/assets/+page.server.ts
/liabilities/+page.server.ts
  -> src/ledger/db/client.ts
  -> Drizzle queries
  -> shared ledger account/history/summary builders
  -> page-specific DTOs
  -> Svelte dashboard components
```

The important rule is that the dashboard does not rebuild a single giant financial domain model. It builds small DTOs for the UI sections that already exist.

## Current Implementation

Current routes:

- `/` redirects to `/overview`.
- `/dashboard` redirects to `/overview`.
- `/overview` renders summary metrics, daily history, and all accounts.
- `/assets` renders non-liability accounts with positions, transactions, and account history.
- `/liabilities` renders credit card, loan, and other liability accounts with transactions and account history.
- `/automation` runs statement/sync/import tasks and tracks task history.

Current server composition:

```text
src/routes/overview/+page.server.ts
  -> src/lib/overview/server/load-overview.ts
  -> OverviewPageDto

src/routes/assets/+page.server.ts
  -> src/lib/assets/server/load-assets.ts
  -> AssetsPageDto

src/routes/liabilities/+page.server.ts
  -> src/lib/liabilities/server/load-liabilities.ts
  -> LiabilitiesPageDto
```

Shared account, position, transaction, history, summary, money, and shell code lives under `src/lib/shared-*`.

## Original Proposed File Tree

```text
/Users/willywangkaa/.codex/worktrees/1ae6/libretto-playground
├── drizzle.config.ts
├── data/
│   └── ledger/
│       └── ledger.sqlite
└── src/
    ├── workflows/                         # keep existing download workflows
    ├── ledger/
    │   ├── import-downloads-csv.ts         # keep existing importer behavior
    │   └── db/
    │       ├── client.ts                   # SQLite + Drizzle connection
    │       ├── schema.ts                   # Drizzle table definitions for ledger.sqlite
    │       └── migrations.ts               # SQL migrations using schema_migrations
    ├── lib/
    │   └── dashboard/
    │       ├── server/
    │       │   ├── summary.ts              # SummaryMetricsPipeline
    │       │   ├── daily-history.ts        # DailyHistoryPipeline
    │       │   ├── accounts.ts             # AccountOverviewPipeline
    │       │   ├── account-drilldown.ts    # AccountDrilldownPipeline
    │       │   └── load-dashboard.ts       # compose DashboardPageDto
    │       ├── types.ts                    # dashboard DTO types
    │       ├── money.ts                    # money/date display helpers
    │       └── components/
    │           ├── SummaryStrip.svelte
    │           ├── DailyHistoryTable.svelte
    │           ├── AccountList.svelte
    │           ├── TransactionModal.svelte
    │           ├── AssetModal.svelte
    │           └── ValueVisibilityToggle.svelte
    └── routes/
        ├── +layout.svelte
        └── dashboard/
            ├── +page.server.ts
            └── +page.svelte
```


## Dashboard DTOs

The implemented app uses page-specific DTOs instead of one all-purpose dashboard payload.

```ts
export type OverviewPageDto = {
  importedAt: string | null;
  summary: SummaryMetricDto[];
  dailyHistory: DailyHistoryRowDto[];
  accounts: AccountRowDto[];
};

export type AssetsPageDto = {
  accounts: AccountRowDto[];
  positionsByAccount: Record<string, AssetPositionDto[]>;
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};

export type LiabilitiesPageDto = {
  accounts: AccountRowDto[];
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};
```

These replace the old embedded static HTML payload shape:

```text
{ accounts, transactions, positions, snapshotHistory, firstAccountId }
```

## Builders

### Summary Metrics

Input: latest account balances and latest included positions.

Output: cards for net position, asset value, and liabilities.

This builder owns only dashboard-level totals. It does not classify every source row.

### Daily History

Input: imported statement dates, snapshot rows, latest account and position values per day.

Output: rows for the existing daily asset changes table:

- Date
- Net assets
- Daily change
- Assets
- Liabilities
- Account changes
- Positions

### Account Overview

Input: account balances, account metadata, investment/loan/card classifications needed for the current list.

Output: account rows used by `AccountList.svelte`:

- Account id
- Bank/product/source labels
- Group: `asset`, `liability`, or `investment`
- Display amount lines
- Transaction count
- Asset position count
- Last updated/imported metadata where available

### Account Drilldown

Input: selected account id.

Output:

- Transaction rows for `TransactionModal.svelte`
- Asset position rows for `AssetModal.svelte`

Sorting and filtering inside the modal can stay client-side for the MVP because the current static dashboard already behaves that way and the data size is local.

## Database Migration Strategy

DB migration is part of the MVP. The dynamic dashboard should not depend on a manually recreated SQLite file or on clearing `data/ledger/ledger.sqlite`.

Use one migration owner for `ledger.sqlite`:

```text
src/ledger/db/migrations.ts
```

The existing `schema_migrations` table stays as the migration ledger:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

### Migration Files

Add these files:

```text
src/ledger/db/
├── client.ts          # open ledger.sqlite and expose raw DB + Drizzle DB
├── migrations.ts      # migration list and migrateLedgerDb()
└── schema.ts          # Drizzle table definitions for typed reads
```

Optional CLI entrypoint:

```text
src/ledger/migrate-ledger-db.ts
```

The CLI is useful for explicit local runs:

```text
npm run run:migrate-ledger-db
```

### Migration Runner Contract

`migrateLedgerDb(db)` must:

1. Create `schema_migrations` if missing.
2. Read applied versions.
3. Run only missing migrations, ordered by ascending `version`.
4. Wrap each migration in `BEGIN` / `COMMIT`.
5. Roll back the current migration on failure.
6. Insert the migration version row only after the migration succeeds.
7. Be safe to call repeatedly.

Pseudo-code:

```ts
type LedgerMigration = {
  version: number;
  name: string;
  up: (db: LedgerDatabase) => void;
};

const migrations: LedgerMigration[] = [
  {
    version: 1,
    name: "typed_statement_schema",
    up: createTypedStatementSchema,
  },
  {
    version: 2,
    name: "dashboard_indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_account_transactions_account_date
        ON account_transactions(account_number, transaction_date);

        CREATE INDEX IF NOT EXISTS idx_brokerage_holdings_account_date
        ON brokerage_holdings(account_number, as_of_date);
      `);
    },
  },
];

export function migrateLedgerDb(db: LedgerDatabase) {
  ensureSchemaMigrationsTable(db);
  const applied = appliedMigrations(db);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.exec("BEGIN");
    try {
      migration.up(db);
      recordMigration(db, migration);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
```

### Call Sites

The importer must run migrations before writes:

```text
import-downloads-csv.ts
  -> openLedgerDatabase()
  -> migrateLedgerDb(db)
  -> insert source files and typed rows
```

The dashboard server may run migrations before reads:

```text
+page.server.ts
  -> openLedgerDrizzle()
  -> openLedgerDatabase()
  -> migrateLedgerDb(db)
  -> Drizzle queries
```

Calling migrations on read startup is acceptable because the runner is idempotent. If this feels too surprising later, keep reads strict and expose a separate `npm run run:migrate-ledger-db` command. For the MVP, idempotent startup migration is the smallest reliable path.

### Drizzle Role

Drizzle is used for typed reads, not as the owner of the existing ledger migration history.

Use Drizzle for:

- `schema.ts` table definitions
- dashboard query composition
- typed query results

Do not use Drizzle Kit for the existing `ledger.sqlite` schema in this MVP. Add Drizzle Kit only when the app owns new dashboard-only tables, such as manual account aliases or dashboard preferences.

### First Migration Boundary

Version `1` should preserve the current schema created by `import-downloads-csv.ts`.

That means the current inline schema setup should move into `migrations.ts`, not be duplicated.

Version `2` should add only dashboard read indexes needed for the MVP. Start with indexes that support account/date lookups. Do not add cache tables yet.

### Failure Behavior

If a migration fails:

- Roll back the current migration transaction.
- Do not write the `schema_migrations` version row.
- Stop the importer or dashboard startup.
- Surface the migration error directly.

Do not attempt partial recovery in the app layer. SQLite migrations should fail fast.

This avoids two migration systems fighting over one SQLite file.

## Routes

### `GET /overview`

Implemented by:

```text
src/routes/overview/+page.server.ts
src/routes/overview/+page.svelte
```

Server behavior:

1. Open `data/ledger/ledger.sqlite`.
2. Apply idempotent SQL migrations if necessary.
3. Run Drizzle queries.
4. Build `OverviewPageDto`.
5. Return DTO to Svelte.

Client behavior:

- Render summary strip.
- Render daily history table.
- Render account list.
- Keep value visibility client-side.

### `GET /assets`

Implemented by:

```text
src/routes/assets/+page.server.ts
src/routes/assets/+page.svelte
```

Server behavior:

1. Open `data/ledger/ledger.sqlite`.
2. Query non-liability accounts, positions, transactions, and daily history.
3. Build `AssetsPageDto`.

Client behavior:

- Render asset/investment accounts.
- Open transaction, position, and account-history modals without a full page reload.
- Keep account filtering and search client-side.

### `GET /liabilities`

Implemented by:

```text
src/routes/liabilities/+page.server.ts
src/routes/liabilities/+page.svelte
```

Server behavior:

1. Open `data/ledger/ledger.sqlite`.
2. Query liability accounts, transactions, and daily history.
3. Build `LiabilitiesPageDto`.

Client behavior:

- Render credit card, loan, and other liability accounts.
- Open transaction and account-history modals without a full page reload.
- Keep account filtering and search client-side.

### Redirects

`/` and `/dashboard` both redirect to `/overview`.

## Data Update Sequence

Import/update flow:

```text
User or cron
  -> run existing workflow
  -> statements written to downloads/
  -> run import-downloads-csv.ts
  -> migrateLedgerDb()
  -> insert normalized rows into ledger.sqlite
  -> record import_runs and schema_migrations
```

Dashboard load flow:

```text
Browser opens /overview, /assets, or /liabilities
  -> +page.server.ts
  -> db/client.ts opens ledger.sqlite
  -> Drizzle runs narrow queries
  -> shared account/history/summary builders build DTOs
  -> +page.svelte renders components
  -> filters/search/modals run client-side
```

## Original Implementation Phases

These phases are retained as historical context for the MVP build.

### Phase 1: Extract DB helpers

- Move SQLite open/migration logic out of `import-downloads-csv.ts` into `src/ledger/db/`.
- Move the current inline `createTypedStatementSchema()` SQL into migration version `1`.
- Add migration version `2` for dashboard read indexes.
- Add `migrateLedgerDb(db)` and call it from the importer before writes.
- Add a small migration CLI/script so migrations can be run without importing new CSV files.
- Keep importer behavior unchanged.
- Keep `schema_migrations` data compatible.

### Phase 2: Add SvelteKit and Drizzle read side

- Add SvelteKit app structure.
- Add Drizzle SQLite client and table definitions for only the tables needed by the dashboard.
- Do not convert all importer writes to Drizzle in this phase.

### Phase 3: Build Page DTOs

- Implement page-specific server loaders.
- Implement shared account, summary, daily-history, transaction, and position builders.
- Match the legacy static dashboard sections before adding anything else.

### Phase 4: Build Svelte components

- Implement `SummaryStrip.svelte`.
- Implement `DailyHistoryTable.svelte`.
- Implement `AccountList.svelte`.
- Implement `TransactionModal.svelte`.
- Implement `AssetModal.svelte`.
- Implement `ValueVisibilityToggle.svelte`.

### Phase 5: Remove static dashboard dependency

- Remove the static dashboard generator after the dynamic dashboard matches current behavior.
- Keep the dashboard runtime reading `ledger.sqlite` directly.

## Acceptance Criteria

The MVP is complete when:

- `/overview`, `/assets`, and `/liabilities` render from SQLite without a static rebuild step.
- `/dashboard` redirects to `/overview`.
- The visible content matches the legacy static dashboard scope.
- Summary cards show the same categories.
- Daily history rows are available from SQLite.
- `migrateLedgerDb()` creates or upgrades `ledger.sqlite` without clearing existing data.
- Migration versions are recorded in `schema_migrations`.
- Re-running migrations is a no-op when all versions are already applied.
- A failed migration rolls back and does not record its version.
- Account filter/search works.
- Transaction modal works.
- Asset modal works.
- New imports can be reflected by reloading the dashboard page without clearing/rebuilding static HTML.
- `CashflowPipeline` and `SourceHealthPipeline` are not present.
- The removed static financial model builder is not used by the SvelteKit dashboard runtime.

## Open Decisions

- `/` and `/dashboard` redirect to `/overview` after MVP parity.
- Imports are exposed through `/automation`; no separate `POST /api/import` button is needed yet.
- Whether account aliases/manual grouping deserve a new SQLite table after the MVP.
- Whether daily history should be computed live or cached after import if query time becomes noticeable.
