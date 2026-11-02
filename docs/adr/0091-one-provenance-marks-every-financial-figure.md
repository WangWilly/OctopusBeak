# One provenance marks every financial figure

Status: accepted

Refines the figure markers of [ADR 0069](0069-ledger-composes-financial-pages-and-decides-net-position.md), the preview marker of [ADR 0047](0047-preview-sources-outside-canonical-admission.md) and the manual marker of [ADR 0087](0087-manual-assets-live-outside-financial-accounts.md).

A figure that includes Preview Financial Data or Manual Assets carried two booleans, `includesPreview` and `includesManual`, and each place that produced a figure computed them on its own. They disagreed:

- **Change figures never carried the manual marker.** The Assets 30-day change, the Overview chips, today's change, the daily bars and the history rows counted only preview origins, so an ended Manual Asset that drove a change showed nothing.
- **Some figures dropped a marker they had computed.** The Overview asset allocation card never received its manual flag, the sidebar figure supported only preview, and the Assets stacked chart marked only preview series.
- **A marker came from a different computation than its figure.** The Overview liability allocation card read a server flag that ignores exchange rates, while its total left out an account without a rate, so a USD preview loan with no rate was marked but not counted.
- **The native Net position hid the preview marker** while showing the manual one.

**Every marked figure carries one required `provenance`.** `Provenance` (`src/lib/shared-ledger/provenance.ts`) records, for each origin (`preview` and `manual`), whether the figure counts data from it. It replaces both booleans on the summary metrics, both Net position shapes, history rows and every renderer figure built from them. A figure that forgets an origin, or a new origin nobody handles, is a type error. `incomplete` stays separate: it says an amount is unknown, not where data came from.

**A figure's provenance follows what that figure counts.** It is accumulated in the same loop that adds the amounts. An account left out for want of a rate, or with no amount, adds nothing to a current total. A change counts the origins of the accounts it compares, but an account at zero on both dates, such as one closed before the span, adds nothing to the change and marks nothing. An account first recorded inside the span is new coverage and does not mark it.

**The manual marker appears wherever the preview marker does**: totals, changes, chips, history rows, charts, allocation cards and the sidebar. A figure that shows only a total takes the total's provenance, not the provenance of a change shown elsewhere.

**The native Net position shows both markers** according to what its per-currency amounts include.

**One `OriginMarkers` component renders the markers** from a `provenance` prop, so every figure shows them the same way.

## Considered options

- **Keep the two booleans and fix each figure.** Rejected. Each fix would stay a separate computation that the next figure could forget.
- **Mark only current totals with the manual marker.** Rejected. A change caused by a Manual Asset would look like collected data.
- **Hide both markers on the native Net position.** Rejected. Its per-currency amounts can include either origin, and hiding the marker withholds that.

## Consequences

- A preview card with a zero or overpaid balance no longer marks the Liabilities total, because that total counts only positive balances. The Net position still counts it and still marks it.
- Adding an origin means adding it to `Provenance`; the compiler lists every figure that must handle it.
