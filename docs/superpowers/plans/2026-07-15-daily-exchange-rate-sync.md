# Daily Exchange-Rate Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CSV-import-triggered exchange-rate fetching with an independent, configurable daily automation job, add a shared system timezone, and preserve source-local bank transaction times as UTC instants without changing their original fields.

**Architecture:** Electron owns a single daily scheduler and launches the existing automation runner. A small explicit requirement-provider list tells the FX job the earliest date and currencies its consumers need. Settings and timestamps cross the existing preload/IPC boundary; UTC remains the storage format, while one shared renderer formatter handles presentation. Bank source timezones are explicit metadata used only when deriving UTC instants at import/backfill time.

**Tech Stack:** TypeScript, Node.js test runner, Electron IPC/preload, Svelte 5, SQLite/Drizzle, Zod, `Intl.DateTimeFormat`, existing Frankfurter v2 client.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-15-exchange-rate-daily-sync-design.md` exactly.
- Keep the implementation dependency-free; use `Intl.DateTimeFormat` and existing SQLite/automation utilities.
- Persist UTC ISO 8601 timestamps. Never rewrite stored data when `SYSTEM_TIMEZONE` changes.
- Keep date-only financial values date-only. Do not invent midnight for rows without `transaction_time`.
- Keep original `transaction_date` and `transaction_time` columns for audit.
- Current bank source timezone is `Asia/Taipei`; future sources must opt in explicitly.
- Do not make FX failure block App startup or cached Overview rendering.
- Do not touch the unrelated user-owned plan `docs/superpowers/plans/2026-07-14-daily-asset-changes-exchange-rates.md`.
- Run the focused test after each red/green step and commit after each task.

---

## Task 1: Add shared timezone primitives and validated settings

**Files:**
- Create: `src/lib/time/timezone.ts`
- Create: `src/lib/time/timezone.check.ts`
- Create: `src/lib/settings/system-settings.ts`
- Create: `src/lib/settings/system-settings.check.ts`
- Modify: `src/lib/automation/server/business-day.ts`
- Modify: `src/lib/automation/server/business-day.check.ts`
- Modify: `src/lib/automation/server/settings.ts`
- Modify: `src/lib/automation/server/tasks.ts`
- Modify: `src/lib/automation/server/config-files.check.ts`

- [ ] **Step 1: Write failing timezone primitive tests**

Add cases that prove validation, UTC-to-zone formatting, and DST-safe local-to-UTC conversion:

```ts
assert.equal(isIanaTimezone("Asia/Taipei"), true);
assert.equal(isIanaTimezone("not/a-zone"), false);
assert.equal(zonedDateTimeToUtc("2026-07-15", "12:34:56", "Asia/Taipei"), "2026-07-15T04:34:56.000Z");
assert.equal(zonedDateTimeToUtc("2026-03-08", "03:30:00", "America/New_York"), "2026-03-08T07:30:00.000Z");
assert.equal(formatUtcDateTime("2026-07-15T04:34:56.000Z", "Asia/Taipei", "zh-TW"), "2026/07/15 12:34:56");
assert.equal(formatUtcDateTime("2026-07-15", "Asia/Taipei", "zh-TW"), "2026-07-15");
```

The last assertion is the date-only guard: the shared formatter returns a `YYYY-MM-DD` input unchanged.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/time/timezone.check.ts src/lib/automation/server/business-day.check.ts
```

Expected: failure because `src/lib/time/timezone.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal shared primitives**

Export these exact APIs from `src/lib/time/timezone.ts`:

```ts
export const DEFAULT_SYSTEM_TIMEZONE = "Asia/Taipei";
export function isIanaTimezone(value: string): boolean;
export function zonedDateTimeToUtc(date: string, time: string, timeZone: string): string;
export function formatUtcDateTime(value: string | null | undefined, timeZone: string, locale: string): string;
```

Move/reuse the existing `Intl.DateTimeFormat(...).formatToParts()` offset calculation from `business-day.ts`; have business-day calculations call the shared helper instead of keeping a second implementation. Reject nonexistent/ambiguous malformed input rather than silently using the OS timezone.

- [ ] **Step 4: Write failing setting normalization tests**

Test these exact contracts in `system-settings.check.ts`:

```ts
assert.deepEqual(systemSettings({}), {
  systemTimezone: "Asia/Taipei",
  exchangeRateUpdateTime: "06:00",
});
assert.equal(systemSettings({ AUTOMATION_BUSINESS_TIMEZONE: "Asia/Tokyo" }).systemTimezone, "Asia/Tokyo");
assert.throws(() => validateSystemSettings({ systemTimezone: "Mars/Base", exchangeRateUpdateTime: "06:00" }));
assert.throws(() => validateSystemSettings({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "6:00" }));
assert.throws(() => validateSystemSettings({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "24:00" }));
```

- [ ] **Step 5: Implement settings accessors and persistence allow-list**

Export:

```ts
export type SystemSettingsDto = {
  systemTimezone: string;
  exchangeRateUpdateTime: string;
};
export function systemSettings(settings?: AutomationSettingsFile): SystemSettingsDto;
export function validateSystemSettings(input: SystemSettingsDto): SystemSettingsDto;
```

Read `SYSTEM_TIMEZONE`, falling back to legacy `AUTOMATION_BUSINESS_TIMEZONE`, then `Asia/Taipei`. Read `EXCHANGE_RATE_UPDATE_TIME`, defaulting to `06:00`. Add both new keys to `AUTOMATION_NON_SECRET_KEYS`. Change `automationBusinessTimezone()` to consume `systemSettings(settings).systemTimezone` so business-day and scheduler behavior share one setting. New saves must write `SYSTEM_TIMEZONE`, not the legacy key.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/time/timezone.check.ts src/lib/settings/system-settings.check.ts src/lib/automation/server/business-day.check.ts src/lib/automation/server/config-files.check.ts
```

Expected: all pass.

```bash
git add src/lib/time/timezone.ts src/lib/time/timezone.check.ts src/lib/settings/system-settings.ts src/lib/settings/system-settings.check.ts src/lib/automation/server/business-day.ts src/lib/automation/server/business-day.check.ts src/lib/automation/server/settings.ts src/lib/automation/server/tasks.ts src/lib/automation/server/config-files.check.ts
git commit -m "feat: add shared system timezone settings"
```

## Task 2: Expose system settings through Electron and Settings UI

**Files:**
- Modify: `src/lib/desktop/api.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc.ts`
- Create: `src/lib/settings/system-timezone-store.ts`
- Create: `src/lib/settings/system-timezone-store.check.ts`
- Modify: `src/lib/settings/SettingsPage.svelte`
- Modify: `src/routes/+page.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Modify: `electron/ipc.check.ts`

- [ ] **Step 1: Write failing API and store tests**

Extend IPC contract tests to require `settings:load` and `settings:save`, and add a store test proving the default is `Asia/Taipei` and `applySystemSettings()` changes the renderer value.

The desktop API contract is:

```ts
settings: {
  load(): Promise<SystemSettingsDto>;
  save(input: SystemSettingsDto): Promise<SystemSettingsDto>;
};
```

- [ ] **Step 2: Confirm RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test electron/ipc.check.ts src/lib/settings/system-timezone-store.check.ts
```

Expected: missing settings channels/store failures.

- [ ] **Step 3: Implement server/preload/API wiring**

Add `settings:load` and `settings:save` to `octopusBeakApiChannels`, `OctopusBeakApi`, preload, and IPC. The save handler must:

1. validate with `validateSystemSettings()`;
2. merge `SYSTEM_TIMEZONE` and `EXCHANGE_RATE_UPDATE_TIME` into `settings.json` while retaining automation enabled flags;
3. return the normalized DTO;
4. invoke a callback supplied to `registerOctopusBeakIpc({ onSystemSettingsChanged })` so Task 7 can reschedule without importing Electron scheduler code into settings modules.

Keep the callback optional so existing IPC tests remain small.

- [ ] **Step 4: Implement renderer initialization and UI**

Create a writable `systemTimezone` store plus `applySystemSettings(dto)`. In `src/routes/+page.svelte`, load settings before the first route data load:

```ts
onMount(() => {
  void window.octopusBeak.settings.load().then((value) => {
    applySystemSettings(value);
    normalizeRoute();
  });
  addEventListener("hashchange", normalizeRoute);
  return () => removeEventListener("hashchange", normalizeRoute);
});
```

Show a loading state until initialization completes, so route timestamps never briefly render in the wrong timezone. In `SettingsPage.svelte`, add:

- an IANA timezone `<select>` with at least `Asia/Taipei`, `Asia/Tokyo`, `America/New_York`, `Europe/London`, and `UTC`;
- `<input type="time" step="60">` for the update time;
- one Save button with pending/success/error feedback;
- Traditional Chinese and English strings in `i18n.ts`.

On save, call `settings.save()`, then `applySystemSettings()` with the returned DTO.

- [ ] **Step 5: Run focused checks and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test electron/ipc.check.ts src/lib/settings/system-timezone-store.check.ts
npm run typecheck
```

Expected: tests and typecheck pass.

```bash
git add src/lib/desktop/api.ts electron/preload.ts electron/ipc.ts electron/ipc.check.ts src/lib/settings/system-timezone-store.ts src/lib/settings/system-timezone-store.check.ts src/lib/settings/SettingsPage.svelte src/routes/+page.svelte src/lib/i18n/i18n.ts
git commit -m "feat: configure timezone and exchange rate schedule"
```

## Task 3: Derive and backfill UTC bank transaction instants

**Files:**
- Create: `src/ledger/source-timezones.ts`
- Create: `src/ledger/source-timezones.check.ts`
- Modify: `src/ledger/source-csv-parsers.ts`
- Modify: `src/ledger/source-csv-parsers.check.ts`
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/db/migrations.check.ts`
- Modify: `src/ledger/db/schema.ts`
- Modify: `src/lib/shared-ledger/types.ts`
- Modify: `src/lib/shared-ledger/server/accounts.ts`
- Modify: `src/lib/shared-ledger/server/accounts.check.ts`

- [ ] **Step 1: Write failing source-timezone tests**

Use one table-driven test covering every current source:

```ts
for (const bank of ["cathay", "ctbc", "fubon", "hncb", "linebank", "post", "sinopac", "yuanta"]) {
  assert.equal(sourceTimezone(bank), "Asia/Taipei");
}
assert.equal(sourceTimezone("future-bank"), null);
assert.equal(sourceTransactionAtUtc("ctbc", "2026-07-15", "12:02:03"), "2026-07-15T04:02:03.000Z");
assert.equal(sourceTransactionAtUtc("ctbc", "2026-07-15", null), null);
```

Use the actual normalized bank identifiers already stored by each parser; do not introduce aliases that are absent from imported rows.

- [ ] **Step 2: Confirm RED, then implement explicit metadata**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/source-timezones.check.ts
```

Expected: missing module failure.

Implement:

```ts
export function sourceTimezone(bank: string, product?: string | null): string | null;
export function sourceTransactionAtUtc(bank: string, date: string | null, time: string | null, product?: string | null): string | null;
```

Return `null` unless both fields and explicit source metadata exist.

- [ ] **Step 3: Write failing parser and migration tests**

Add parser assertions that domestic and foreign-currency rows contain `transactionAtUtc` while retaining the exact source date/time. Add migration version 22 expectations:

```ts
assert.equal(row.transaction_date, "2026-07-15");
assert.equal(row.transaction_time, "12:02:03");
assert.equal(row.transaction_at_utc, "2026-07-15T04:02:03.000Z");
```

Also cover a date-only row (`transaction_at_utc IS NULL`) and an unknown bank (`NULL`, no OS timezone inference).

- [ ] **Step 4: Implement schema, import, and backfill**

Add nullable `transaction_at_utc TEXT` to `account_transactions` and `foreign_currency_transactions` through migration version 22, plus matching Drizzle fields. The migration must query existing `bank`, `product`, `transaction_date`, and `transaction_time` values, compute via `sourceTransactionAtUtc()`, and update only rows with a derivable instant. Keep the transaction inside the existing migration framework.

Have `source-csv-parsers.ts` populate the new field at parse/import time. Do not alter original date/time values.

- [ ] **Step 5: Carry the instant into transaction DTOs**

Add `occurredAtUtc: string | null` to `TransactionRowDto`. Set it in `bankTransactionDto()` and `foreignTransactionDto()`; set `null` for DTO builders whose sources do not provide an instant. Keep rendering unchanged until Task 8 switches the modal to the shared formatter.

- [ ] **Step 6: Run focused checks and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/source-timezones.check.ts src/ledger/source-csv-parsers.check.ts src/ledger/db/migrations.check.ts src/lib/shared-ledger/server/accounts.check.ts
npm run typecheck
```

Expected: all pass.

```bash
git add src/ledger/source-timezones.ts src/ledger/source-timezones.check.ts src/ledger/source-csv-parsers.ts src/ledger/source-csv-parsers.check.ts src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts src/ledger/db/schema.ts src/lib/shared-ledger/types.ts src/lib/shared-ledger/server/accounts.ts src/lib/shared-ledger/server/accounts.check.ts
git commit -m "feat: preserve bank transaction UTC instants"
```

## Task 4: Separate FX requirements from synchronization and CSV import

**Files:**
- Create: `src/ledger/exchange-rate-requirements.ts`
- Create: `src/ledger/exchange-rate-requirements.check.ts`
- Modify: `src/ledger/exchange-rates.ts`
- Modify: `src/ledger/exchange-rates.check.ts`
- Modify: `src/ledger/import-downloads-csv.ts`
- Modify: `src/ledger/import-exchange-rates.check.ts`

- [ ] **Step 1: Write failing requirement aggregation tests**

Use the public contracts:

```ts
export type ExchangeRateRequirement = {
  component: string;
  requiredFrom: string | null;
  currencies: string[];
};
export type ExchangeRateRequest = {
  requiredFrom: string | null;
  currencies: string[];
};
```

Assert that requirements dated `2026-07-10` and `2026-01-03` aggregate to `2026-01-03`, currencies become sorted unique `['JPY', 'USD']`, and `TWD`/`UNKNOWN` are removed. Assert an empty provider result becomes `{ requiredFrom: null, currencies: [] }`.

- [ ] **Step 2: Confirm RED, then implement the explicit provider list**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/exchange-rate-requirements.check.ts
```

Expected: missing module failure.

Implement `overviewDailyAssetChangesRequirement(ledgerDir)` by calling the existing `loadOverview(ledgerDir)`, taking the earliest `dailyHistory[].date`, and reusing `requiredExchangeRateCurrencies()`. Export one explicit provider array and `loadExchangeRateRequest(ledgerDir)`; do not add runtime registration.

- [ ] **Step 3: Refactor synchronizer tests first**

Change tests to call:

```ts
await syncExchangeRates(ledgerDir, {
  requiredFrom: "2026-01-03",
  currencies: ["USD"],
}, { fetchImpl, now });
```

Add explicit no-fetch assertions for no currencies and complete cache coverage. Preserve tests proving invalid/missing API rows leave existing cache unchanged.

- [ ] **Step 4: Implement request-based synchronization**

Change `syncExchangeRates()` to accept `ExchangeRateRequest`, normalize/sort its currencies, compare cached coverage against `requiredFrom`, and request only the missing range. It must return successful `written: 0` without opening the network when no foreign currency is required or cache already covers through `to`.

- [ ] **Step 5: Remove the CSV import trigger and lock it with a regression test**

Delete the post-import `loadOverview()`/`syncExchangeRates()` block and its `exchange-rate-sync-warning`. Rewrite `import-exchange-rates.check.ts` so a successful CSV import installs a `fetch` spy that throws if called and asserts its call count is zero.

- [ ] **Step 6: Run focused checks and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/exchange-rate-requirements.check.ts src/ledger/exchange-rates.check.ts src/ledger/import-exchange-rates.check.ts
```

Expected: all pass.

```bash
git add src/ledger/exchange-rate-requirements.ts src/ledger/exchange-rate-requirements.check.ts src/ledger/exchange-rates.ts src/ledger/exchange-rates.check.ts src/ledger/import-downloads-csv.ts src/ledger/import-exchange-rates.check.ts
git commit -m "refactor: separate exchange rate synchronization"
```

## Task 5: Add the standalone FX command and fixed audit log

**Files:**
- Create: `src/ledger/exchange-rate-audit-log.ts`
- Create: `src/ledger/exchange-rate-audit-log.check.ts`
- Create: `src/ledger/sync-exchange-rates.ts`
- Create: `src/ledger/sync-exchange-rates.check.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing append-only audit tests**

Define the record union with these exact discriminants:

```ts
type ExchangeRateAuditRecord = {
  scheduledAtUtc: string | null;
  startedAtUtc: string;
  finishedAtUtc: string;
  requiredFrom: string | null;
  currencies: string[];
  written?: number;
  status: "success" | "failed";
  error?: string;
};
```

Test success, no-op (`written: 0`), and failure append exactly one parseable JSON line each to `data/automation/logs/exchange-rates.log`. Assert ISO timestamps end in `Z` and a second call appends rather than replaces.

- [ ] **Step 2: Confirm RED, then implement safe append**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/exchange-rate-audit-log.check.ts
```

Expected: missing module failure.

Implement `appendExchangeRateAuditRecord(path, record)` with `mkdirSync(dirname(path), { recursive: true })` and `appendFileSync(..., JSON.stringify(record) + "\n")`. The function may throw; the command handles that warning separately.

- [ ] **Step 3: Write failing command orchestration tests**

Export a dependency-injected `runExchangeRateSyncCommand(options)` so tests can supply `loadRequest`, `sync`, `appendAudit`, `now`, and `stderr`. Cover:

- success and no-op exit normally and append success;
- sync failure appends failed and rethrows so the automation task fails;
- audit append failure writes `exchange-rate-audit-log-warning:` to stderr but does not change a sync success into failure;
- `--scheduled-at-utc 2026-07-14T22:00:00.000Z` is recorded, while no flag records `null`.

- [ ] **Step 4: Implement CLI and package script**

The CLI loads the aggregated requirement before entering sync, retains that context for failure logs, and uses UTC `new Date().toISOString()` for timing. Add:

```json
"run:exchange-rates": "node --no-warnings --experimental-strip-types src/ledger/sync-exchange-rates.ts"
```

Reject an invalid scheduled-at value rather than writing a misleading timestamp.

- [ ] **Step 5: Run focused checks and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/exchange-rate-audit-log.check.ts src/ledger/sync-exchange-rates.check.ts
npm run check:package-lock
```

Expected: all pass; package lock remains consistent because no dependency changed.

```bash
git add src/ledger/exchange-rate-audit-log.ts src/ledger/exchange-rate-audit-log.check.ts src/ledger/sync-exchange-rates.ts src/ledger/sync-exchange-rates.check.ts package.json
git commit -m "feat: add exchange rate sync command and audit log"
```

## Task 6: Register FX as a normal automation task with schedule context

**Files:**
- Modify: `src/lib/automation/server/tasks.ts`
- Modify: `src/lib/automation/server/tasks.check.ts`
- Modify: `src/lib/automation/server/runner.ts`
- Modify: `src/lib/automation/server/runner.check.ts`
- Modify: `src/lib/automation/server/store.ts`
- Modify: `src/lib/automation/server/store.check.ts`
- Modify: `src/lib/i18n/i18n.ts`

- [ ] **Step 1: Write failing task and store tests**

Assert `taskById("exchange-rates")` is an enabled `sync` task with no credentials and command `node --no-warnings --experimental-strip-types src/ledger/sync-exchange-rates.ts`. Add a store test for:

```ts
hasSuccessfulTaskRunSince(db, "exchange-rates", "2026-07-14T22:00:00.000Z")
```

Only `status = 'completed'` with `finished_at >= occurrence` returns true; running, failed, cancelled, or earlier completion returns false.

- [ ] **Step 2: Confirm RED, then implement task/store pieces**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/automation/server/tasks.check.ts src/lib/automation/server/store.check.ts
```

Expected: missing task/query failures.

Add the task without a credential group so `enabledAutomationTasks()` always includes it. Add English and Traditional Chinese labels.

- [ ] **Step 3: Write a failing runner schedule-context test**

Extend the runner start options:

```ts
type StartAutomationTaskOptions = {
  scheduledAtUtc?: string;
};
```

Test that `startAutomationTask("exchange-rates", ledgerDir, { scheduledAtUtc: "2026-07-14T22:00:00.000Z" })` appends `--scheduled-at-utc 2026-07-14T22:00:00.000Z` to this command only; a manual start and every other task remain unchanged.

- [ ] **Step 4: Implement the narrow runner option**

Pass `scheduledAtUtc` into `runAutomationTask()` and append the two CLI arguments only after resolving the `exchange-rates` command. Validate the ISO value before spawning. Do not add generic arbitrary environment or argument injection. Keep the existing per-run filename pattern such as `exchange-rates-1784077946362-1.log` and normal cancellation/history behavior.

- [ ] **Step 5: Run focused checks and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/automation/server/tasks.check.ts src/lib/automation/server/store.check.ts src/lib/automation/server/runner.check.ts
```

Expected: all pass.

```bash
git add src/lib/automation/server/tasks.ts src/lib/automation/server/tasks.check.ts src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts src/lib/automation/server/store.ts src/lib/automation/server/store.check.ts src/lib/i18n/i18n.ts
git commit -m "feat: register exchange rate automation task"
```

## Task 7: Add the Electron daily scheduler and startup catch-up

**Files:**
- Create: `electron/exchange-rate-scheduler.ts`
- Create: `electron/exchange-rate-scheduler.check.ts`
- Modify: `electron/main.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/ipc.check.ts`

- [ ] **Step 1: Write failing pure occurrence tests**

Export:

```ts
export function exchangeRateSchedule(now: Date, settings: SystemSettingsDto): {
  latestOccurrenceUtc: string;
  nextOccurrenceUtc: string;
};
```

Cover before/after 06:00 Asia/Taipei and a DST boundary in `America/New_York`. Assert occurrences remain local 06:00 even when the UTC offset changes.

- [ ] **Step 2: Write failing scheduler behavior tests**

Construct the scheduler with injected `now`, `setTimer`, `clearTimer`, `readSettings`, `hasSuccessSince`, `isTaskActive`, `startTask`, and `reportError`. Test:

1. startup due with no success starts once with `scheduledAtUtc`;
2. success after occurrence suppresses startup catch-up;
3. failure does not satisfy the next startup;
4. active task suppresses duplicate start;
5. App left open fires at the next occurrence once;
6. `reschedule()` clears the prior timer and recomputes in the new timezone/time;
7. thrown lookup/start errors are reported and do not crash or double-start.

- [ ] **Step 3: Confirm RED, then implement one-timer scheduler**

Run:

```bash
node --no-warnings --experimental-strip-types --test electron/exchange-rate-scheduler.check.ts
```

Expected: missing module failure.

Implement a factory returning `{ start(), reschedule(), stop() }`. Startup performs the due check once, then always arms the next occurrence. A timer-fired failure waits until the next daily occurrence; there is no intraday retry loop.

- [ ] **Step 4: Wire Electron lifecycle and settings changes**

In `electron/main.ts`, after the ledger migration/recovery and IPC registration:

- create the scheduler using `hasSuccessfulTaskRunSince()`, `activeAutomationTaskIds().includes("exchange-rates")`, and `startAutomationTask("exchange-rates", ledgerDir, { scheduledAtUtc })`;
- call `start()` without awaiting the FX network job;
- pass `scheduler.reschedule` to `registerOctopusBeakIpc()`;
- call `scheduler.stop()` during `before-quit` alongside session shutdown.

Catch and log scheduler errors (`exchange-rate-scheduler-error`) so App startup continues.

- [ ] **Step 5: Run focused checks and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test electron/exchange-rate-scheduler.check.ts electron/ipc.check.ts
npm run typecheck
```

Expected: all pass.

```bash
git add electron/exchange-rate-scheduler.ts electron/exchange-rate-scheduler.check.ts electron/main.ts electron/ipc.ts electron/ipc.check.ts
git commit -m "feat: schedule daily exchange rate updates"
```

## Task 8: Convert structured UI timestamps with the shared timezone

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/lib/overview/components/snapshot-chart-data.ts`
- Modify: `src/lib/overview/components/snapshot-chart-data.check.ts`
- Modify: `src/lib/overview/components/DailyHistoryTable.svelte`
- Modify: `src/lib/shared-accounts/components/TransactionModal.svelte`

- [ ] **Step 1: Write failing presentation tests**

Extend snapshot chart tests so a UTC `pointAt` is formatted in the supplied system timezone and a date-only history label remains unchanged. The pure formatter already has timezone tests from Task 1; component changes should delegate to it rather than duplicate date logic.

- [ ] **Step 2: Replace direct slicing and local-time assumptions**

In `AutomationDashboard.svelte`, replace `value?.slice(0, 19).replace("T", " ")` with `formatUtcDateTime(value, $systemTimezone, $locale)` for task rows and run history. Apply the same shared formatter to structured `pointAt` values in Overview and the `occurredAtUtc` transaction value. Keep third-party plain-text log contents unchanged.

Pass timezone/locale explicitly into pure chart-data functions so tests are deterministic and the module does not depend on a Svelte store.

- [ ] **Step 3: Run focused checks and commit**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/time/timezone.check.ts src/lib/overview/components/snapshot-chart-data.check.ts src/lib/shared-ledger/server/accounts.check.ts
npm run typecheck
```

Expected: all pass.

```bash
git add src/lib/automation/AutomationDashboard.svelte src/lib/overview/components/snapshot-chart-data.ts src/lib/overview/components/snapshot-chart-data.check.ts src/lib/overview/components/DailyHistoryTable.svelte src/lib/shared-accounts/components/TransactionModal.svelte
git commit -m "feat: display structured timestamps in system timezone"
```

## Task 9: Full regression and desktop smoke verification

**Files:**
- Modify only if a verification failure exposes a defect in the files already listed above.

- [ ] **Step 1: Run all automated verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run check:package-lock
npm run privacy-check
```

Expected: every command exits 0.

- [ ] **Step 2: Scan for forbidden remnants and accidental placeholders**

Run:

```bash
rg -n "exchange-rate-sync-warning|syncExchangeRates\(outputDir, dailyHistory\)|TO[D]O|T[B]D|PLACEHOLD[E]R" src electron docs/superpowers/plans/2026-07-15-daily-exchange-rate-sync.md
```

Expected: no old CSV-trigger strings and no new placeholder markers. Existing unrelated project debt markers, if any, must be reviewed rather than mass-edited.

- [ ] **Step 3: Run the desktop smoke test**

Run:

```bash
npm run desktop:dev:mock
```

Verify:

- Settings loads `Asia/Taipei` and `06:00`, saves changes, and displays validation errors without losing prior values.
- Automation lists the exchange-rate task and a manual run creates both the normal per-run log and the fixed `data/automation/logs/exchange-rates.log`.
- A failed network request leaves cached Overview data usable and shows a failed automation run.
- Automation/run-history/transaction structured timestamps change display when `SYSTEM_TIMEZONE` changes, while date-only values and raw log text do not.
- Relaunching with no success after the latest occurrence starts one catch-up run; relaunching after a success does not duplicate it.

Stop Electron cleanly when finished and confirm no automation child/session remains.

- [ ] **Step 4: Review the diff against the design and commit any verification-only fix**

Run:

```bash
git diff --check
git status --short
git log --oneline --max-count=10
```

Expected: no whitespace errors; only intentional feature files are changed; the unrelated 2026-07-14 plan remains untracked and unstaged.

If smoke verification required a code correction, rerun the affected focused test plus the full commands above, stage only the exact corrected feature and test paths named in the applicable task, then commit them with `git commit -m "fix: complete exchange rate scheduler verification"`. Never use a broad `git add .`.
