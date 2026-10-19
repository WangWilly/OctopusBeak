# Preview credit cards, attached preview products, and preview time deposits

Status: Current. This contract extends [Building on Preview Sources](../agents/preview-sources.md) and [ADR 0047](../adr/0047-preview-sources-outside-canonical-admission.md). [ADR 0051](../adr/0051-attached-preview-products-on-verified-sources.md) owns the attached-product decision. Terms are defined in `CONTEXT.md`. Progress lives in issues #228 and #229.

## Products

A preview product is one of `deposit`, `credit_card`, or `time_deposit`. A Preview Source declares a list of products instead of one. The person selects among them in Statement Selection ([ADR 0036](../adr/0036-explicit-statement-selection-and-product-results.md)); nothing is selected automatically, and each selected product reports its own result (`success`, `no_data`, `not_held`, `failed`, `skipped`). A failure in one product does not discard another product's data from the same run. A lost session still ends the run.

`not_held` needs explicit evidence: a provider message that the person holds no card or no time deposit, or a complete empty list. A timeout, an unknown shape, or a missing list fails. A product reported `not_held` writes no account and no zero balance, and deletes nothing collected earlier.

Verified coverage is checked per Institution and product. A preview product is hidden and not collected while a verified source covers the same Institution and product.

## Attached preview products

A verified workflow may declare attached preview products. They appear in that source's Statement Selection only while Preview Features are on, unselected by default, each marked as a preview. The workflow then receives a preview writer bound to that source next to its canonical commit port. Each product writes to exactly one side: a verified product never writes Preview Financial Data, and an attached product never builds a Source Capture. The attached products in this program are:

| Verified source | Attached product |
| --- | --- |
| Cathay (`cathay`) | `credit_card`, `time_deposit` |
| HNCB (`hncb`) | `credit_card` |
| SinoPac (`sinopac`) | `credit_card` |
| E.SUN (`esun`) | `deposit` (NT-dollar and foreign-currency accounts) |

CTBC credit cards use the mobile App protocol, unlike the verified CTBC website workflow, so they are a separate Preview Source (`ctbc-credit-card`) with its own Sign-in Details.

Preview Sources that gain products: Taishin, Mega, and SKBank gain `credit_card`; First Bank gains `credit_card`; O-Bank gains `time_deposit`; NextBank's term-deposit pockets move from `deposit` to `time_deposit`.

## Credit card data

The shapes follow the canonical credit-card design, and add only what the canonical design cannot hold.

- **Credit account.** One account per issuer-aggregate cardholder portfolio and currency, like a canonical `credit` account. It has an optional credit limit, which the canonical design lacks.
- **Card.** One row per card within an account, keyed by a stable source key, with a card mask that ends in four digits. Purchases name their card when the source does.
- **Used-credit balance.** The balance kind is `credit_used`: positive for an amount owed and negative when overpaid, never clamped. Each observation records its basis, one of `provider-used-credit`, `credit-limit-minus-available`, or `statement-minus-paid-plus-unbilled`, and the exact source operands the basis used. Any missing operand fails the product. Nothing defaults to zero.
- **Purchase.** An exact amount, a direction (`inflow`, `outflow`, or `unknown`), a posting status (`pending` or `posted`), a billing status (`billed`, `unbilled`, or absent for a pending authorization), a consume date with optional time and precision, an optional posting date, and an optional statement key.
- **Statement.** Keyed by a statement key within the account. It holds a required billing period label (`YYYY-MM`), a required due date, the statement amount, an optional minimum payment, and the cycle start, cycle end, and closing date when the source reports them. Canonical statements require the cycle dates; some banks, such as Mega, report only the billing month, so the preview follows all-set-tw and leaves them empty rather than inventing them. It adds the paid amount, a paid flag, and a no-payment-needed flag. A later collection that lacks an optional field keeps the stored value. A due date given only as a status text means the statement is not written.
- **Relations.** `pending_to_posted` (Preview Authorization Pairing) and `unbilled_to_billed` (Preview Billing Supersession), stored in their own relation rows, never reassigned once written.

### Direction

A purchase's direction comes from a source field. A card purchase may take its direction from the sign of its amount only when the bank's section in `docs/agents/preview-sources.md` states that assumption and a collection holds both positive and negative amounts. Zero amounts are refused. Otherwise the direction is `unknown`.

### Pairing and supersession

Both run at write time inside the same database transaction as the write.

1. A bank reference, when the source supplies one for both rows, links a pending authorization to the one posted purchase with the same reference, and only when each side has exactly one candidate.
2. Otherwise a pending authorization pairs with a posted purchase in the same account and card, with the same Taipei consume date, currency, exact amount, and known direction. Candidates are taken in a stable order (consume time, then source key), each row used once.
3. Unbilled-to-billed supersession uses the same key between an unbilled posted purchase that vanished from the latest unbilled list and a billed purchase that appeared, when the source changed the row key at billing.

Rows with `unknown` direction or no card never pair. An established link is kept even if a later collection would pair differently. A pending authorization that disappears without a match stays visible as pending.

## Time deposits

A time deposit is a depository preview account with the `time_deposit` product. It may carry a maturity date, principal, and interest rate, each optional, and a closed-at time. Each collection must read the complete time-deposit list. A deposit absent from a complete list is closed (Preview Time Deposit Closure): it stops counting toward assets and keeps its history. A list that cannot be shown complete fails the product and closes nothing.

## Presentation

- Credit balances count toward liabilities and net worth with the preview marker. The Liabilities view shows a Preview group like the Assets view does.
- A credit account whose latest used-credit balance is unknown shows 「剩餘應繳金額未取得」, and a total that would include it shows 「資料不完整」 instead of treating it as zero.
- A credit account's purchase list hides paired authorizations and superseded unbilled purchases. The posted purchase shows the authorization time when it has one. Unpaired pending purchases show as pending.
- A closed time deposit leaves every total and shows as closed in its account view.
- Statements show in the credit account view: period, closing date, due date, amount, minimum, and payment state when known.

## Promotion

Promotion follows ADR 0047. Preview data for the Institution and product is compared against the verified data, then deleted and recollected through canonical admission. Nothing is migrated.
