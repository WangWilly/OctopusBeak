# One exact money module

Status: accepted

Applies [ADR 0006](0006-canonical-transaction-money-currency-and-time.md). Keeps the display totals of [ADR 0069](0069-ledger-composes-financial-pages-and-decides-net-position.md) and replaces the purchase money helpers named in [ADR 0076](0076-purchase-report-module-owns-purchase-basis-spending.md).

An Exact monetary value is an integer coefficient, a decimal scale and a currency. The arithmetic on it existed in about twenty private copies: `exact.ts`, the purchase report core, a second copy of the purchase adder in `spending-facts.ts`, the Purchase category reader, purchase matching, the pairing index, month insights, manual pairing, the renderer's summary delta in `model.ts`, overview, daily history, financial pages, `overview-amount.ts`, the Spending dashboard, and the parity checks that reduced both sides before comparing them. Each copy chose its own answer to two questions, and the answers disagreed:

- **Currency case.** Purchase totals, month insights and matching upper-cased the currency. The Purchase category reader and the renderer delta did not:
  - The split check compared an item's currency to the total's currency case-sensitively, so an invoice whose items are in `twd` and whose total is in `TWD` read as Unclassified.
  - A split component took the stored currency of the amount it reconciles to, so the renderer's summary delta opened a `twd` category bucket beside the `TWD` bucket the server reports.
  - The dashboard compared a pairing's invoice and payment currencies case-sensitively.
- **Scale.** The server reduces every total to canonical scale. The renderer delta kept the widest scale it saw, so a patched summary said `12500` at scale 2 where the server said `125` at scale 0. The parity checks hid this by reducing both sides. The dashboard decided whether an invoice and a payment differ by comparing their plain decimal text, so `100` against `100.00` showed a false "source difference" note.
- **Zero.** Daily history dropped any amount whose floating-point value was within 1e-6 of zero, so a real tiny balance or change disappeared from the history.

**`src/lib/shared-money/exact-money.ts` is the one module for exact money arithmetic.**

- **Types.** `ExactAmount` is a coefficient and a scale. `ExactMoney` adds the currency. `MoneyTotal` adds a count. `spending-recognition-contracts.ts`, `money-text.ts` and `spending-sql.ts` re-export or alias `ExactMoney` instead of declaring their own. The DTO shapes that cross processes do not change.
- **Validation at the boundary.** `parseExactMoney` and `parseExactAmount` accept an integer coefficient string and a scale from 0 to 1000, and throw `ExactMoneyError` otherwise. The renderer delta parses every amount it receives. The other operations trust their typed inputs.
- **The currency rule.** Every money operation compares and groups by the trimmed, upper-cased currency (`normalizeCurrency`, `sameCurrency`). Stored values are never rewritten; only computed results name the upper-cased currency.
- **The scale rule.** `normalizeExact` and `normalizeMoney` reduce to canonical scale: no trailing zero digits after the point, and zero is `0` at scale 0. Every money operation returns the reduced form. `equalMoney` and `moneyKey` are the canonical equality: two values are equal exactly when their keys are equal.
- **Display totals are a separate operation.** `addKeepingScale` adds at the larger operand scale and never reduces, so financial pages still show the decimals their sources reported (ADR 0069). It is not a canonical form and is never used to compare or key.
- **Totals.** `addToTotals` and `readTotals` keep keyed running totals with counts; `moneyTotals` and `mergeMoneyTotals` are the per-currency forms. A total stays while it counts at least one amount, even when it sums to zero, and drops when its count reaches zero. A negative count with a negated amount removes amounts again, which is how the renderer applies a delta.
- **Scalar operations** (`multiplyExact`, `divideExact`, `decimalToExact`, `exactToNumber`) move from `exact.ts` unchanged.

The admission parsers and comparators of individual integrations, exchange-rate conversion, and `money.ts` display formatting keep their own code; they parse or format source text rather than combine canonical values.

## Considered options

- **Keep scale everywhere.** Rejected. Equality and keys need one canonical form, or `100` and `100.00` stay two values; the dashboard note and the delta parity are both this defect.
- **Reduce display totals too.** Rejected. ADR 0069 keeps source decimals on purpose, so `1334.60` stays `1334.60`. The module offers both operations under different names instead of one operation with a flag.
- **Upper-case the currency when it is stored.** Rejected. Stored source values are immutable evidence; the comparison rule covers every reader without a migration.
- **Change the dashboard's amount display at the same time.** Deferred. The display goes through `formatMoney`; this decision changes only the arithmetic and equality behind it.

## Consequences

- An invoice split whose items and total differ only in currency case now reads as a split, and each component names the upper-cased currency. A transaction split component in another case of its transaction's currency now counts as classified.
- The renderer's patched summary equals the server's summary without masking: amounts come back reduced and upper-cased, for example `25` at scale 0 instead of `2500` at scale 2.
- The dashboard no longer shows the source-difference note for `100` against `100.00`, or for `twd` against `TWD`. Its day and month totals merge lowercase-stored currencies into the upper-cased total and come back reduced.
- Purchase totals already merged lowercase currencies; the remaining spending readers now do too, so a ledger that stored `twd` beside `TWD` shows one total where it showed two.
- Daily history shows a tiny non-zero amount, such as 0.0000001, instead of hiding it, and still omits an exact zero. An amount too large or too small for a JavaScript number is shown with its exact value instead of being dropped.
- Overview, daily history and financial pages still group by the currency as stored; they only use the module's adders.
