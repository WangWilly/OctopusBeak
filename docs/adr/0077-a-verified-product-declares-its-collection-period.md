# A Verified product declares its collection period

Status: accepted

Applies [ADR 0057](0057-verified-source-definition-owns-every-per-source-fact.md) and [ADR 0071](0071-product-collection-run-bound-to-its-verified-source.md). Follows the time rules of [ADR 0006](0006-canonical-transaction-money-currency-and-time.md). Leaves the Query buckets of [ADR 0062](0062-credit-card-query-inventory-and-user-triggered-reset.md) unchanged.

Eleven product collectors each decided which dates to query before a Source Capture. Each took "today" from a clock of its own choosing, moved it back by a look-back of its own, and kept its own copy of the date arithmetic: four copies of a clamped month subtraction, two unclamped ones, two of a YYYYMMDD formatter, and offset tables keyed by provider range codes. The look-backs differ by product, and nothing outside the workflow file said what they were:

| Source | Product | Look-back | Widest request |
| --- | --- | --- | --- |
| LINE Bank | deposit | 12 months inclusive | 12 months inclusive |
| SinoPac | deposit | 12 months inclusive | 1 month and 1 day |
| HNCB | deposit | 2 years and 1 day | one request |
| Fubon | deposit | 12 months and 1 day | 6 months and 1 day |
| Fubon | loan | 6 months and 1 day | one request |
| Cathay | domestic, foreign currency | 1 year and 1 day | one request |
| Yuanta | deposit, foreign currency | 3 months and 1 day | one request |
| Yuanta | loan | 12 months and 1 day | one request |
| Yuanta | fund | 365 days | one request |
| YuanTa Trade | securities | 91 days | one request |

The copies had drifted into bugs:

- **The wrong day.** SinoPac read the run's instant with UTC getters, so a run between 00:00 and 08:00 in Taipei ended its period a day early. LINE Bank, HNCB, Fubon deposit and loan, Cathay domestic and foreign, Yuanta loan and fund, and YuanTa Trade used the machine's local clock, so a machine outside Taipei queried a different day than the person's bank.
- **Unclamped months.** Cathay moved back with `setMonth` and `setFullYear`, so one month back from Mar 31 was Mar 3, and one year back from Feb 29 was Mar 1.
- **One run, several periods.** Cathay computed its range again for the request, the capture scope and admission, and Yuanta recomputed its FX scope per capture and its fund range twice. A run that crossed midnight disagreed with itself.
- **A day queried twice.** Fubon's "180" range began on the day its "180_365" range ended.
- **eInvoice** chose its months from the local clock but ended its recorded scope on a date passed separately.

Every date input that could override these (`startDate`, `endDate`, `dateRange`, `customDateRange`, `dateRanges`, `quickMonths`) was set only by checks; the registry never supplied one.

**A Verified product declares its Collection period, and the bound run computes it once.**

- **`src/lib/automation/collection-period.ts` is a pure module.** `collectionPeriod({ today, lookBack, maxWindow })` returns `{ start, end, windows }`: the period ending `today`, and its inclusive, disjoint requests, newest first, each no wider than `maxWindow`. A span is whole years and months, clamped to the end of a shorter month, then days, counting both ends: `{ months: 12 }` is twelve months inclusive and `{ months: 1, days: 1 }` is a month and one more day. `collectionWindows` splits an explicit range the same way, `periodSpans` tells whether a period is exactly a provider's quick-range option, and `taipeiToday(now)` gives the Asia/Taipei calendar date of an instant.
- **The declaration lives on `VerifiedProduct`.** `collectionPeriod: { lookBack, maxWindow? }` sits beside the product's stream, and the registry copies the declarations into the Product collection run's facts as it copies the provider and product ids. Each value preserves the product's look-back and request width from before this decision.
- **The product handle hands it out.** `product.collectionPeriod()` returns the period for the product's declaration and the run's Taipei date. The bound run reads the date from `context.now()` once, when a product first asks, and keeps each product's period, so every call in a run agrees. A product with no declaration fails the run with `workflow-failed`.
- **Workflows keep only provider formatting.** They map the period to the provider's request: ROC years, slashes, YYYYMMDD, Cathay's period option, Fubon's "180" and "180_365" codes, Fubon's and Yuanta's quick links, or entered dates when no quick link fits.

"Today" is the Asia/Taipei date because every current source states its dates in Taipei (ADR 0006 and the Transaction date observation in `CONTEXT.md`): the bank's "last three months" ends on the bank's date, not the machine's.

## Considered options

- **Pass the period in the run input or the Task run plan.** Rejected. ADR 0071 keeps per-source facts out of the run input, and a period computed when the plan resolves would go stale while the run waits in its queue or retries.
- **Give every source one look-back.** Deferred. How far back each product looks is a product decision; this change keeps each product's current look-back so it changes no capture.
- **A day-count look-back for everything.** Rejected. Banks count months and clamp at month ends, and SinoPac's one-month request is a calendar month.

## Consequences

- The fixed bugs above change what a run queries: SinoPac and the local-time sources now end on the Taipei date, Cathay clamps at month ends, and Fubon's older range ends the day before the newer begins. No other window changes.
- The date inputs listed above are gone from the workflow input schemas. Checks that set them now set the run's clock or hand the product a period. CTBC keeps its own provider-supplied ranges.
- Credit-card Query buckets are untouched: a Collection period chooses what to query before a capture, and a Query bucket records what a capture queried.
- E.SUN's date arithmetic is not migrated here.
