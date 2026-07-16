# Asset Account Spending Design

## Goal

Add spending from asset accounts to `#/spending` without double counting transfers, debt settlement, credit-card payments, or purchases already represented by an electronic invoice. Keep the existing OctopusBeak visual structure and make every automatic decision reversible.

## Approved UI

Preserve the current page order and visual language:

1. Monthly spending card.
2. Month selector and the existing daily-chart button.
3. Daily spending and records card.

Do not add summary metrics, equations, or other metadata above the monthly chart. The daily bar chart remains in `DailySpendingModal`; it is not embedded in the records card.

## Approved Chart Design

Use the low-chroma OKLCH palette already established by the overview, assets, and liabilities charts: muted blue, green, ochre, plum, rust, teal, and slate. Apply the same category color consistently in monthly and daily charts.

Each month or day is one rounded group containing two narrow stacked bars:

- Left bar: electronic-invoice spending.
- Right bar: included asset-account spending.

Each source bar remains stacked by spending category. Clip the full bar to a rounded shape, retain subtle surface-colored separators between category segments, and keep horizontal grid lines and compact value axes consistent with the other financial charts.

Selecting a month outlines the complete two-bar group with a rounded focus band. It must not imply that only one source is selected. The legend identifies category colors, while a short source key establishes the fixed left/right order. Tooltips show invoice subtotal, account subtotal, category breakdown, and combined confirmed total.

The records card combines electronic invoices and asset-account transactions, grouped by local calendar date from newest to oldest. Each date header shows the confirmed daily total and counts of excluded or pending records. The records area has its own vertical scroll; its current date header is sticky until the next date replaces it.

Immediately below the category filters, show a single disclosure such as `另有 3 筆自動排除交易 · 不計入每日合計` with a `查看與修改` action. This disclosure stays above the date groups rather than at the end of the list.

## Record States

Each account transaction has one of three spending states:

- `included`: counted in monthly and daily spending totals.
- `excluded`: not counted; the row shows the reason and an action to change it back to spending.
- `pending`: not counted until the user classifies it.

Electronic invoices remain included unless an existing invoice rule excludes them. Rows identify their source as electronic invoice or account.

## Classification Policy

Automatic classification is conservative:

- Exclude a credit-card payment only when the account description or note explicitly identifies a card payment, or when it matches a genuine negative card-payment record by amount and nearby date. A generic `繳費` label is insufficient.
- Exclude an internal transfer when it is explicitly a self-transfer, references another owned account, or has a mirrored deposit in another owned account with the same currency and amount within two calendar days.
- Exclude a loan payment from consumption spending while retaining it as a debt payment.
- Treat generic transfers, cash withdrawals, and other ambiguous outflows as pending.
- When an account transaction confidently represents the same purchase as an included electronic invoice, keep one spending record and attach both sources. Do not count the amount twice. Ambiguous matches remain pending.

The existing database demonstrates why conservative rules are required: only 3 of 148 deduplicated outflows had an exact mirrored deposit candidate, while 35 account rows explicitly identified credit-card payments.

## Manual Overrides

Every automatic state is a suggestion. A user can change an excluded record to included, classify a pending record, or restore automatic classification.

Persist the override against the transaction's stable ledger identity. Manual state takes precedence after re-imports and rule changes. Store the selected state, optional category, update time, and enough rule metadata to explain what was overridden. Do not copy the source transaction into the override record.

If a source transaction disappears, retain its override without affecting totals. If the same stable transaction returns, apply the override again.

## Data Flow

`loadSpending` loads confirmed invoices, account outflows, and saved overrides. It deduplicates source rows using the existing normalized-transaction identity before applying spending classification.

For each account transaction:

1. Apply a saved manual override when present.
2. Otherwise evaluate high-confidence exclusion and duplicate-purchase rules.
3. Mark unmatched ambiguous outflows as pending.
4. Merge included invoices and account transactions into date groups.
5. Calculate monthly and daily totals from included records only.
6. Produce category amounts separately for invoice and account sources so the paired charts never infer source from display text.

The renderer receives display-ready records with source, state, reason, category, and stable key. Classification and total calculation remain server-side so all consumers use the same result.

## Interaction And Errors

`查看與修改` opens the excluded records for the selected month. Changing a state updates the row and totals optimistically, then persists through the desktop API. If saving fails, restore the previous state and show an inline error on that record.

Keyboard users can reach filters, disclosure actions, records, and override controls. Sticky date headers are informational and do not receive focus. Reduced-motion settings require no special animation.

## Verification

Add one focused model check covering included, excluded, pending, duplicate invoice/account purchase, manual-override precedence, and per-source chart totals. Add one store check proving overrides survive reload. Verify the live Electron screen through CDP at `#/spending`, including paired rounded bars, full-group month selection, date-header stickiness, the daily modal, and changing an excluded record back to included.

## Out Of Scope

- Merchant-wide rule editing.
- Machine-learning classification.
- A separate reconciliation dashboard.
- Chart types beyond the approved paired, category-stacked bars.
