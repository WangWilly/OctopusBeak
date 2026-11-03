# The ledger picks one valuation date

Status: accepted

Refines [ADR 0069](0069-ledger-composes-financial-pages-and-decides-net-position.md). Keeps [ADR 0091](0091-one-provenance-marks-every-financial-figure.md).

ADR 0069 decided the Net position in the ledger and left the Assets and Liabilities totals, shares and charts to the renderer, with both sides using the rules in `twd-valuation.ts`. Each side chose its own valuation date. The ledger used the latest stored rates when there was no history, and the renderer used the local date. ADR 0069 said both picked the same rates. They do not when a stored rate is dated after the local date, which happens when the system time zone is behind the rate source. Then the Net position was converted at the later rate and the side totals at the earlier one, and the Overview showed figures that did not add up.

**The ledger picks the valuation date once per page read** and returns it with the Overview, Assets and Liabilities pages. The Net position and every renderer figure on those pages are valued at that date. The date is the newest date in the daily history. With no history it is the person's local date, or the newest stored rate's date when that is later, which picks the same rates the ledger's old "latest stored rates" sentinel did. The page shows the date in its rate note, so it is always a real date.

**A verified account with an amount but no rate makes its side total incomplete.** The Net position already refused to show a converted total in that case. The Assets and Liabilities totals used to skip the account and show what was left as if it were complete. A Preview account without a rate stays listed as unconverted and does not make the total incomplete, as in the Net position.

**The Net position and the side totals still count different things, on purpose.** The Net position counts every signed value. The Assets total counts only categories whose sum is positive, so an overdrawn deposit account lowers the Net position but not the Assets total. The Liabilities total counts only positive balances, so an overpaid card raises the Net position but not the Liabilities total (ADR 0091). An allocation chart has no negative slices, and moving an overdrawn deposit to the Liabilities side would show one account on both sides.

## Considered options

- **Move the side totals, shares and charts into the ledger.** Rejected. It would not change any of the differences above, which come from what each figure counts, not where it is computed.
- **Count signed values in the side totals.** Rejected. The allocation charts would need negative slices.

## Consequences

- With no overdrawn deposit and no overpaid card, the Net position equals the Assets total minus the Liabilities total, and a check pins it.
- While the Assets total is incomplete, the Overview's debt ratio shows no value.
- `twd-valuation.ts` and the Financial page readers have their own checks.
