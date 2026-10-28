# The ledger composes the financial pages and decides the Net position

Status: accepted

Keeps the Canonical query boundary of [ADR 0010](0010-canonical-financial-store-and-projection-boundary.md), the one-snapshot reads of [ADR 0018](0018-canonical-projection-runtime.md) and the worker-owned live views of [ADR 0030](0030-pglite-owned-live-financial-views.md).

## Context

The Overview, Assets and Liabilities pages were composed inside `electron/pglite-financial-registry.ts`. That module also routes every financial RPC. Its page code included exact sums, the summary metrics, held-currency rate selection and the preview merge. About a quarter of its recent commits were changes to how these pages look.

The Net position was computed twice:

- The registry produced exact per-currency amounts that included every preview account.
- The renderer's `readOverview` converted to TWD and returned null when any verified account lacked a rate.

The dashboard found the registry's metric by its English label, `"Net position"`, and used `convertedNet === null` to choose which figure to show. Each figure carried its own `includesPreview`, and the two disagreed in practice. A USD preview account with no USD rate counted as preview in one figure and was left out of the other.

## Decision

**`src/ledger/pglite/financial-pages.ts` composes the three pages.** It exposes `readOverviewPage`, `readAssetsPage` and `readLiabilitiesPage`. Each takes the reader whose transaction it reads in. The registry opens one transaction per page and dispatches to these functions. The canonical query, the preview merge and the held-currency rates are internal to the module.

**The ledger decides the Net position once.** The overview summary is keyed as `net`, `assets` and `liabilities`, not by English labels. The `net` metric is one of two shapes:

- `converted`: a single TWD total, used when every account converts at the valuation date.
- `native`: each currency's own exact amount.

Its `includesPreview` describes only the figure shown. The history chips' preview marker is separate. Conversion uses the renderer's own valuation rules from `twd-valuation.ts`, so the total, the chart and the allocation agree.

**Without history, the latest stored rates value the accounts.** The renderer used to fall back to the local date. The ledger has no clock, so it uses a date past every stored rate, which picks the same rates.

## Considered options

- **Keep both Net position figures and let the dashboard choose.** Rejected. The choice and its preview flag would still live apart from the figures they describe.
- **Show only native amounts.** Rejected. That is a product change this refactor does not make.
- **Use one `readFinancialPage(reader, page)` function.** Rejected. The three pages return different DTOs, so a page switch would need a union or overloads.
- **Share `addExact` for the summary sums.** Rejected. It normalizes the scale and would drop the decimals a source reported, so 1334.60 would become 1334.6.

## Consequences

- A change to how a page is composed touches only `src/ledger`. The pages can be checked against a PGlite reader without the worker.
- The dashboard and the Net position card render the `net` metric as given. A history chip that includes preview data still marks the card, but it no longer marks the side figure.
- The Assets and Liabilities live views now also depend on exchange rates, because their DTOs carry the rates that their TWD totals are converted with.
