# MAX rewards and outside crypto deposits count as income

Status: accepted

Amends [ADR 0138](./0138-investment-and-loan-accounts-decide-their-own-cash-flow.md).

ADR 0138 left everything on an investment account out of Cash flow. That rule holds for a cash effect, because the funding account already shows it. Two kinds of MaiCoin (MAX) inflow have no funding account at all. A crypto deposit from an outside wallet, such as a salary paid in USDT, is new money. A MAX reward, such as daily interest, is new money too. Both left Cash flow showing no income for them.

ADR 0138 also deferred valuing a reward, and said a value would sit beside the total, never inside it. The person has decided otherwise. A value now counts inside the income total.

**A MAX inflow counts as Cash flow income when all of these hold:**

- It is a `corporate_action_in` on a MAX account.
- Its source record key names a statement row in the MAX statement log, `maicoin_statement_rows`.
- That statement row is a `reward`, or a `deposit` in a currency other than TWD that MAX reports as `done`. A deposit still processing, or one MAX rejected, never arrived. A reward carries no state.

A reward counts in the `income.reward` group. A deposit counts in the `income` group. The row keeps its Kind, `investment.corporate_action`, and its booked direction.

**The amount is the statement's logged `value_twd`, in TWD.** The MAX sync computes it as the statement amount times a price. The price is MAX's daily candle close for the row's UTC day. A coin with no TWD market is priced through USDT. Cash flow rounds the value half-up to two decimals and keeps it as an exact amount. The value is an estimate from MAX's own daily close, not the price at the moment the coin arrived. The person accepted that estimate, because a period with crypto salary otherwise shows no income at all. The list, the account change, the detail and the CSV show the row at this amount.

A sync upserts each statement by its own id, so the log holds the latest copy and the latest value. A statement counts once.

**A crypto deposit that is the person's own transfer does not count.** It is their own transfer when it matches one outflow from another imported investment account, and that match is unique. The outflow must be:

- a `corporate_action_out` of the same coin, from a source other than MaiCoin, which is Binance today;
- dated at most `CASH_FLOW_TRANSFER_WINDOW_DAYS` (3) days from the deposit;
- at least the received quantity, and at most 1% more, to cover a network fee.

The match must be unique on both sides. The deposit fits no other outflow, and the outflow fits no other MAX deposit, in the period or not. A matched deposit stays `not_counted` as `investment_move`. A reward never matches.

**A TWD deposit stays out.** It comes from a bank, and ADR 0145 relates it to its bank row.

**A qualifying row with no logged value is unresolved.** It joins Cash flow's unresolved bucket, so it never drops out silently.

**The read stays in the Cash flow query.** The decision is a pure function. The read joins the investment rows to the statement log by source record key, the same join ADR 0145 uses. It reads the log only when a MAX inflow is in the rows it classifies, and only around their dates. Kinds, the projection and the stored data do not change. Spending does not change.

Cash flow inclusion policy `cash-flow-by-kind` moves to v3.

## Considered options

- **Show the value beside the total, as ADR 0138 proposed.** Rejected by the person. Crypto salary is income, and a total without it misstates the period.
- **Value each row at the price at the moment it arrived.** Rejected. MAX's daily close is the price the sync already logs. A finer price needs another provider call per row.
- **Count every crypto deposit, including one from Binance.** Rejected. A move between two of the person's own exchanges would count as income.
- **Pick the closest outflow when several fit.** Rejected. A guess would hide real income, and nothing on the page would show it. An ambiguous deposit counts, and it stays visible.
- **Count TWD deposits too.** Rejected. A TWD deposit is a bank transfer, and ADR 0145 handles it.

## Consequences

- A MAX row synced before the statement log existed has no row type. It stays out until the next MAX sync logs its history again.
- An own transfer from a wallet the person has not imported counts as income. The person cannot mark it otherwise yet.
- An own transfer with an ambiguous match counts as income.
- A Cash flow search across every period finds an amount by its stored value. A MAX income row stores zero, so an amount search outside the shown period does not find its TWD value.
- A reward worth less than half a cent counts as zero.
- A Cash flow search across every period also picks rows by the label their Kind gives. A MAX income row's Kind is an investment move, so a search for its income or reward label outside the shown period does not find it.
- A later sync that cannot price an old statement replaces its value with none, and the row moves to unresolved.
