# Purchase-basis spending and report-level deduplication

Status: accepted

Spending measures purchases rather than bank posting. Unmatched invoices contribute spending. Once reliable source evidence or explicit user confirmation establishes an invoice/payment pair, only the bank debit amount in its currency is recognized for that purchase; the earlier proposal to retain the invoice amount after pairing is withdrawn. The difference is not separately inferred as a fee or another purchase. A purchase in September remains September consumption when its bank posting arrives in October; pairing can revise its recognized amount without moving it to the posting month.

When a purchase or refund occurrence date is unavailable, the bank posting date may be used with an explicit 「以入帳日期代替」 label. Reliable occurrence evidence received later updates period membership; download and synchronization dates never substitute for financial dates.

Unconfirmed duplicate candidates both remain included. The records are labeled 「可能重複」 and the total 「含待確認項目」 until the relationship is resolved; similarity alone never suppresses an amount.

A source-proven purchase refund reduces spending in the refund occurrence month even when the original purchase cannot be found. A refund in October does not restate a September purchase. Invoice cancellation alone creates no negative refund: an explicitly withdrawn invoice ceases to support spending, while a surviving bank payment remains recognized. Overlapping evidence of the same refund is deduplicated one-to-one only through reliable source evidence or explicit user confirmation.

The first version supports only one invoice paired with one payment transaction. Reliable source evidence may establish a spending deduplication link automatically; date, amount, or merchant similarity alone may only suggest a candidate for explicit user confirmation. Confirmed links are traceable and revocable, and never merge canonical source identities or rewrite source financial amounts, dates, or status.

This introduces a narrowly scoped report-level exception to ADR 0008's exclusion of cross-source reconciliation and financial user corrections. It does not authorize user-confirmed source Transaction Relations, fuzzy canonical identity merging, or relaxed source admission. This ADR takes precedence over conflicting report-level restrictions in ADRs 0007, 0008, and 0011 and the canonical storage and enrichment specifications; their source identity, admission, and financial-fact constraints remain in force.

## Revision and revocation

A link follows the identities of the paired records rather than freezing their confirmation-time values. Legitimate source-supported revisions of the same transaction do not require renewed confirmation: recognition follows the latest valid bank amount and currency, while dates continue to follow the purchase-date policy above. A later bank posting-date revision does not override a known purchase date. Confirmation-time evidence and subsequent revisions remain traceable.

This continuity does not authorize carrying a link to a replacement identity or an unsupported, withdrawn source record. Revoking the link removes its deduplication effect; each surviving record is then evaluated independently under the recognition policy, without erasing the historical confirmation.

One-to-many and many-to-one matching are outside the first version. This decision does not require retaining the Data Issues page, which is scheduled for removal.
