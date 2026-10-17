# Direct source precedence per currency

Status: accepted

Amends the Direct source precedence section of [ADR 0042](0042-tdcc-admission-direct-source-precedence-and-passbook-movements.md).

## Context

ADR 0042 covers every TDCC account at an Institution and product while a direct source holds any current account there. TDCC reports one settlement account per bank code, account number, and currency, so it can report a USD settlement account at Taipei Fubon Bank. The Fubon source collects only TWD deposits, because its current-deposit snapshot keeps only TWD rows. The direct Fubon TWD account therefore covered the TDCC USD account, and the USD balance was counted nowhere.

## Decision

Coverage is decided per Institution, product, and currency. An Intermediary-source account is covered only while, for every currency it holds, a direct-source account for the same Institution and product holds that currency at the reader's knowledge point.

The currencies an account holds come from data the store already records. An account with a `currency` holds that one currency. A multi-currency account, whose `currency` is null, holds the currency of every balance observation and transaction revision committed in it at or before the knowledge point. Only multi-currency accounts are scanned, so the query stays as cheap as before for accounts with many transactions.

A direct domestic deposit account is denominated in TWD, so it covers only TWD. A direct foreign-currency deposit account has no single denomination, so it covers each currency it has reported a balance or transaction in. A TDCC settlement account is denominated in its one currency. TDCC and direct investment accounts carry their reporting currency, which is TWD for every source today, so broker and fund coverage is unchanged.

`directSourceCoverage` stays the one place that decides coverage, and `readPGliteDirectSourceCoverage` stays the one query that feeds it. Nothing compares account numbers and no identities merge.

## Considered options

- **Declare the currencies each direct source and product collects.** For example, a domestic-deposit stream collects TWD and a foreign-currency-deposit stream collects every other currency. Rejected. It is a second list that must track each workflow's filters, and it would cover a TDCC USD account at a bank whose foreign-currency account holds no USD, hiding a real balance. Observed currencies follow what the direct source actually reports.
- **Keep coverage per Institution and product.** Rejected. A currency the direct source never collects is lost from every total.

## Consequences

- A TDCC account in a currency the direct source does not report counts toward totals, labelled as coming via TDCC. Totals no longer lose it.
- When a direct source first reports a currency, the TDCC account in that currency becomes covered from that knowledge point on. Before then only TDCC counts it, so the switch never double counts.
- Once a direct account has reported a currency, it covers that currency at every later knowledge point, because balance observations and transaction revisions are never removed. A later zero balance still covers it.
