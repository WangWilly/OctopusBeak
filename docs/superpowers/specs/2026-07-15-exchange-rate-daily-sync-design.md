# Daily Exchange-Rate Sync Design

## Goal

Move exchange-rate synchronization out of CSV import and into an independent daily automation job. The job must use the earliest historical date required by all dependent components, cache successful rates, keep using the last successful cache after failures, and append every outcome to a fixed audit log.

The Settings page must expose a shared system timezone and the daily exchange-rate update time. Stored timestamps remain UTC; presentation converts them with the configured system timezone.

## Settings

- `SYSTEM_TIMEZONE`: IANA timezone, default `Asia/Taipei`.
- `EXCHANGE_RATE_UPDATE_TIME`: local `HH:mm`, default `06:00`.
- Existing `AUTOMATION_BUSINESS_TIMEZONE` remains a read fallback during migration. New saves use `SYSTEM_TIMEZONE`, and existing automation business-day calculations consume the shared system timezone.
- Invalid timezone or time values are rejected at the settings boundary.

The Settings UI provides a timezone selector and a native time input. Saving either value immediately recalculates the next exchange-rate run.

## Scheduling

Electron owns a single lightweight timer while the App is running. The scheduler computes the latest scheduled occurrence at or before `now` in `SYSTEM_TIMEZONE`.

- On App startup, run the job when no successful `exchange-rates` task exists at or after that occurrence.
- When the App stays open, arm a timer for the next occurrence and run once when it arrives.
- When the App was closed at the scheduled time, the next startup performs the missed run.
- A successful manual run after the latest occurrence satisfies that occurrence.
- A failed run does not satisfy it. The next App startup may retry; an open App waits for the next daily occurrence.
- If the task is already active, the scheduler does not start another copy.
- Settings changes cancel the old timer and recompute due state.

The scheduler calls the existing automation runner so task status, cancellation, run history, and per-run logs keep their current behavior. The task also appears in Automation and supports manual execution.

## Dependent Component Requirements

Each component that consumes exchange rates provides a small requirement function:

```ts
type ExchangeRateRequirement = {
  component: string;
  requiredFrom: string | null;
  currencies: string[];
};
```

The job maintains one explicit list of providers. This avoids runtime registration and makes future dependencies discoverable. Adding a dependent component only requires adding its provider to that list.

The aggregator:

- takes the earliest non-null `requiredFrom` date;
- unions and sorts currencies;
- removes `TWD` because it is the base currency;
- performs no API request when no foreign currencies are required.

The first provider is Overview's Daily asset changes. It uses the current Overview data calculation to supply its earliest history date and currencies. CSV import no longer invokes `loadOverview()` or `syncExchangeRates()` after completion.

## Synchronization and Cache

The independent job passes the aggregated `requiredFrom` and currencies to the exchange-rate synchronizer. The synchronizer compares them with cached dates and requests only the missing range from the existing Frankfurter source.

- Every historical point uses that date's rate or the nearest prior available business-day rate.
- Existing cached rates remain untouched when an API response is unavailable or invalid.
- A no-op caused by complete cache coverage is a successful run with `written: 0`.
- A run with no required foreign currency is also successful with `written: 0`.

## Logging

The automation runner continues to create its normal per-run file:

```text
data/automation/logs/exchange-rates-<timestamp>-1.log
```

The job additionally appends one JSON object per run to:

```text
data/automation/logs/exchange-rates.log
```

Success and no-op records contain:

- `scheduledAtUtc` (`null` for a manual run)
- `startedAtUtc`
- `finishedAtUtc`
- `status: "success"`
- `requiredFrom`
- `currencies`
- `written`

Failure records contain the same timing and requirement context plus `status: "failed"` and `error`.

All persisted log timestamps use UTC ISO 8601 values. The App converts structured timestamps only when displaying them with `SYSTEM_TIMEZONE`; changing the timezone never rewrites logs or database rows. Arbitrary timestamps embedded in third-party plain-text output are not parsed or modified.

Failure to append the audit log emits a warning in the standard per-run log but does not change the synchronization result. Log writes create the directory when missing and append rather than replace.

## Error Handling

- Synchronization failure marks the independent task failed, appends a failure audit record, and leaves cached rates available to the UI.
- A synchronization failure never blocks App startup or other automation tasks.
- Scheduler errors are reported without crashing Electron and do not create duplicate task runs.
- Existing Overview currency conversion continues to display the last successful rate and its data date.

## System-Timezone Presentation

Database timestamps continue to be written in UTC. A shared formatter converts application-rendered timestamps using `SYSTEM_TIMEZONE`, including transaction times, automation task times, run history, and structured log timestamps. Business-day boundaries and daily scheduler calculations use the same setting.

Date-only financial values remain date-only and are not shifted through UTC. Raw third-party log text remains unchanged.

### Source transaction time

Bank transaction feeds currently provide a local `transaction_date` and `transaction_time` without an offset. Each workflow must therefore declare a `sourceTimezone`; the importer must not infer it from the App setting or operating-system timezone.

All current Taiwanese bank sources declare `Asia/Taipei`:

- Cathay
- CTBC
- Fubon
- HNCB
- LINE Bank
- Post Office
- SinoPac
- Yuanta

Live Libretto observations confirmed UTC+8 directly for Cathay, CTBC, HNCB, LINE Bank, Post Office, SinoPac, and Yuanta. Fubon exposes timezone-free local timestamps whose observed login time aligns with Taiwan local time, so it uses the same institution timezone.

When both date and time exist, import derives and stores a UTC instant while retaining the original source date and time for audit. A database migration backfills that instant for existing rows from their known bank/product source timezone; it does not rewrite the original fields. Display converts the UTC instant with `SYSTEM_TIMEZONE`. A source row containing only a date remains date-only and does not receive an invented time. Future non-Taiwan workflows must explicitly declare their own source timezone.

## Verification

Automated checks cover:

1. Requirement aggregation chooses the earliest date, unions currencies, and excludes TWD.
2. Complete cache and no-currency cases return successful `written: 0` results without fetching.
3. Success, no-op, and failure each append one valid JSON line with UTC timestamps.
4. Invalid API responses preserve the prior cache and append a failed record.
5. Scheduler due checks handle App startup, an App left open, manual success, failure, duplicate prevention, timezone changes, and a daylight-saving timezone.
6. Settings reject invalid IANA zones and invalid `HH:mm` values and default to `Asia/Taipei` and `06:00`.
7. Shared presentation formatting converts UTC timestamps without changing date-only values.
8. Source-local transaction timestamps convert through the workflow's declared timezone, remain stable when the OS or system display timezone changes, and retain their original fields.
9. CSV import succeeds without triggering exchange-rate synchronization.

## Out of Scope

- Waking or launching the App through macOS when it is closed.
- Automatic intraday retry loops.
- Runtime plugin registration for requirement providers.
- Rewriting stored timestamps after a timezone change.
- Parsing arbitrary timestamps inside third-party plain-text logs.
