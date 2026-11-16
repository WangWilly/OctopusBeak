# A bank's label rules follow the account's Institution

Status: accepted

TDCC settlement deposits had no Transaction Kind route, so every row an Intermediary source reported sat in Cash flow's unresolved bucket (#477). Each such account keeps the Institution that maintains it, such as Fubon, and its rows carry that bank's own labels. The bank Kind classifier gated Fubon's and Yuanta's label rules on the integration namespace, so a Fubon row TDCC reported would miss them.

**`bank/deposit-kind-enrichment` v4 gains a `tdcc/domestic-deposit` route, and its institution-specific label rules key on the account's Institution.** The classifier input carries the `institutionKey` in place of the integration namespace. A direct Fubon or Yuanta row has the same Institution as before, so its Kind does not change. A TDCC row reads the rules of the bank that keeps the account; an Institution with no rules of its own reads the shared rules. Cathay's passbook-label producer stays on its own `cathay/domestic-deposit` route, so a Cathay account TDCC reports reads the shared rules.

## Considered options

- **Key the rules on the source and add `tdcc` beside each one.** Rejected. A Fubon rule would then apply to every bank TDCC reports.
- **Route TDCC rows to each bank's own producer.** Rejected. A route assigns one producer to one source stream; Cathay's producer is scoped to its own stream.

## Consequences

- A TDCC row whose label matches nothing specific takes the shared direction fallback, `purchase` or `receipt`, like any other bank row; ADR 0140 adds the exchange, settlement, dividend and interest labels.
- Rows captured before the route get their Kind on the next store open, through the one-time Kind re-derivation.
