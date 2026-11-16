# A card's interest and fees read from the issuer label and never pair

Status: accepted

A card outflow got Kind `purchase` from its direction alone, so the issuer's own interest and fee lines missed the `interest_and_fees` category (ADR 0141) and could be dedup candidates for a same-amount e-invoice. Issue #483 decides how such a line gets its Kind and how pairing treats it.

**The issuer's whole label decides the Kind.** `classifyCreditCardOutflowKind` reads a card outflow's description, normalized to NFKC and lowercased, without whitespace, and cut to its first `·` part. A bracketed reference before or after the label is removed: issuers put a card reference or the purchase amount there. The rest must equal one of the issuer's labels. Interest, such as 循環利息, 預借現金利息, 利息 or FINANCE CHARGE, gives `interest.charged`. A fee, such as 年費, 國外交易服務費 or 國外交易手續費, 預借現金手續費, 分期手續費, 滯納金, 違約金, a bare 手續費, ANNUAL FEE or LATE FEE, gives `fee.card`. A merchant whose name holds such a word, such as a shop's 會員年費, stays `purchase`. A foreign-transaction fee counts only as its own line, and a fee word inside a purchase line is never read. The producer stays `credit-card/direction-enrichment` v1 with evidence kind `bank-rule` and lineage `credit-card/direction/v1/outflow-description`. The two outputs are taxonomy compatibility additions with a seed step, and a new `kind-rederivation` entry re-derives existing rows.

**A card's interest or fee is never paired, but it stays a Spending purchase.** No invoice names a bank charge. `isInvoicelessCharge` in `card-charge.ts` covers a loan charge (ADR 0141) and a card charge. A card charge is an outflow, so it stays a Pairing entry, and Spending keeps counting it as a bank-only purchase. It is not offered as a candidate anywhere. The Pairing read that feeds deterministic candidates and manual ranking leaves it out in SQL. `evaluateSpendingMatchCandidates` skips it for possible duplicates. `queryCurrentTransactionById` returns nothing for it, so a direct pair or a candidate confirmation is rejected. Cash flow keeps it as an outflow by category.

**A link the person confirmed earlier still stands.** If a person paired such a row with an invoice before its Kind changed, that link is their decision. The purchase stays `linked`. Only new automatic candidates and new pairs are blocked. The person can still revoke the link.

## Considered options

- **Drop card charges from the Pairing entries projection.** Rejected. That projection is also Spending's source of bank-only purchases, so the row would leave Spending or need a separate path like the loan charges. Changing its PL/pgSQL function would also need a schema migration.
- **Revoke existing links to such rows.** Rejected. A confirmed link is a user decision, and the classifier is a heuristic.
- **Match a fee word anywhere in the description.** Rejected. Merchant names such as a membership 年費 or a utility 水費 would become card fees.

## Consequences

- A durable candidate recorded before this change still marks its records as possible duplicates until it is decided. None existed on the data this was measured on.
- `fee.bank` and deposit-side `interest.charged` outflows can still be candidates. They come from keyword rules that are weaker than an issuer's whole label.
