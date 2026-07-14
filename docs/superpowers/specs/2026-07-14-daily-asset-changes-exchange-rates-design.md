# Daily Asset Changes Exchange Rates Design

## Goal

Add cached daily and historical foreign-exchange rates, then pilot single-currency display in the Overview page's **Daily asset changes** section. The pilot converts only Net assets, Daily change, Assets, and Liabilities. Existing summaries, account details, transactions, and the Assets and Liabilities pages keep their current native-currency display.

## Decisions

- Use the free, keyless Frankfurter v2 API directly from Node with the built-in `fetch` API.
- Refresh rates after the normal daily CSV import, without making rate availability a condition for import success.
- Cache rates in the local ledger SQLite database and keep using the last successful data while offline.
- Convert each historical snapshot with the rate from that date, or the nearest earlier available business day.
- Offer TWD plus currencies present in the snapshot history as display-currency choices.
- Store the pilot's selected display currency in renderer `localStorage`.
- Do not use a Libretto browser workflow, add a scheduler, add a second rate provider, or add a dependency.

## Architecture

### Rate synchronization

A Node exchange-rate module owns fetching, response validation, normalization, and persistence. The existing CSV import command calls it as a best-effort post-import step. A failure is logged but does not change a successful import result.

The synchronizer reads the currencies and date range represented by the ledger's snapshot history. On its first successful run it fetches the missing historical range; later runs request only missing dates and the latest available rates. A newly observed currency is backfilled over the snapshot range on the next run.

Frankfurter is queried with TWD as the base and only the required quote currencies. Returned values are inverted and stored as TWD per one unit of source currency. TWD is treated as a constant rate of `1` and does not require an API row.

### SQLite storage

Add an `exchange_rates` table to the existing ledger migrations:

| Column | Purpose |
| --- | --- |
| `rate_date` | Provider's effective `YYYY-MM-DD` date |
| `currency` | ISO 4217 source currency code |
| `twd_per_unit` | TWD value of one source-currency unit |
| `source` | Stable provider identifier, `frankfurter-v2` |
| `fetched_at` | UTC timestamp for operational diagnosis |

The primary key is `(rate_date, currency)`. A validated response is upserted in one SQLite transaction so reruns are idempotent and partial responses cannot replace a complete cache.

### Overview data

Only the Overview loader reads exchange rates for this pilot. It returns the existing native-currency daily-history buckets plus the rate rows needed for those dates and currencies. Other page DTOs and account-detail DTOs remain unchanged.

The renderer converts buckets locally so changing the selector does not reload ledger data or make a network request.

## Conversion Rules

All stored rates use TWD as the common intermediate:

```text
display value = source amount × source TWD-per-unit ÷ display-currency TWD-per-unit
```

For each history point, both source and display rates must use the latest rate whose `rate_date` is less than or equal to the snapshot date. Future rates must never be used. TWD always resolves to `1` for the snapshot date.

All entries in a currency bucket are converted and summed before formatting. Existing display precision rules remain in effect: TWD and JPY use no fractional digits; other currencies use two.

## User Interface

Place a **Display currency** selector in the header of the Overview page's **Daily asset changes** panel. Its choices are TWD plus the distinct, known currencies present in that panel's history, using the existing currency order where available.

The selection is persisted in `localStorage`. If the saved currency is no longer available, the selector falls back to TWD.

Changing the selector updates only these history values:

- Net assets
- Daily change
- Assets
- Liabilities

Account changes, Positions, the Overview summary strip, account rows, dialogs, and all other pages keep their current behavior. Helper text beside the selector shows the newest cached rate date. Each converted row uses and exposes its own effective rate date rather than reusing the newest rate.

## Failure Handling

- Apply a short request timeout.
- Validate the external response with the already-installed Zod dependency.
- Reject non-success HTTP responses, non-finite or non-positive rates, malformed dates, and missing requested currencies.
- Do not write any part of an invalid response.
- Do not delete previously cached rows when a refresh fails.
- Record the failure in the automation log while preserving CSV import success.
- If a history row lacks any rate required for conversion, show its existing native-currency bucket and a missing-rate indication instead of an estimated aggregate.

## Verification

Use the existing Node test runner and the smallest focused checks that cover the new branches:

1. Cross-currency conversion through TWD produces the expected result.
2. A weekend or holiday snapshot selects the nearest earlier rate, never a future rate.
3. An invalid API response leaves existing database rows unchanged.
4. A synchronization failure does not make a successful CSV import fail.
5. Selecting another currency updates the four Daily asset changes values and leaves other Overview content unchanged.

Run the repository's canonical test and typecheck commands after implementation.

## Acceptance Criteria

- A normal daily import attempts one best-effort rate synchronization.
- Historical rates are cached locally for every supported currency and snapshot date needed by Daily asset changes.
- The pilot remains usable offline with the last successful cache.
- Daily asset changes can be displayed in TWD or a currency present in its history.
- Each row uses its own date or the nearest earlier available business-day rate.
- Missing rates never produce a misleading converted total.
- No display behavior outside Daily asset changes changes in this pilot.

## Deferred Scope

Applying display-currency conversion to the Overview summary strip, account details, or the Assets and Liabilities pages is deferred until the pilot is validated. Multiple providers, user-selectable providers, background scheduling, and a Libretto exchange-rate workflow are also out of scope.
