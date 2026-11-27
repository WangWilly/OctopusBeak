# A MAX TWD transfer names its one matching bank row

Status: accepted; where the row type lives amended by [ADR 0158](./0158-the-max-commit-carries-row-type-state-and-twd-valuation.md)

Amends [ADR 0138](./0138-investment-and-loan-accounts-decide-their-own-cash-flow.md).

A TWD withdrawal from MaiCoin (MAX) to a bank showed up in Cash flow as income. The MAX side is an investment-account move, which Cash flow never counts (ADR 0138). The bank side read as a generic `receipt`, which counts. It is the person's own money coming back from an investment account, so it must not count. A TWD deposit into MAX had the same problem in the other direction.

The MAX adapter records a TWD movement as a `corporate_action_in` or `corporate_action_out` of the `TWD` cash security. The TWD is the quantity, and the cash effect is zero. A convert, a reward and a wallet transfer move the same security, and no bank row mirrors them. MAX gives no evidence that names the bank row. So the only link is the amount and the date.

**A MAX TWD movement and a bank row form an investment funding relation when all of these hold:**

- The MAX movement came from a deposit or withdrawal statement. The MAX sync logs every statement row, with its row type, in `maicoin_statement_rows`, and the movement's source record key is derived from that row. A movement with no logged deposit or withdrawal row never matches. (Amended by [ADR 0158](./0158-the-max-commit-carries-row-type-state-and-twd-valuation.md): the row type is `investment_transactions.row_type`, written by the commit that admits the movement, and the log is gone.)
- The bank row is posted, normal and active, in TWD, on a domestic or foreign-currency deposit account that Direct source precedence does not cover. A TDCC copy of a directly synced account repeats every row of that account, so counting it would make every match on that account ambiguous.
- The directions are opposite. A MAX withdrawal pairs with a bank inflow, and a MAX deposit with a bank outflow.
- The amounts are exactly equal.
- The dates are at most `CASH_FLOW_TRANSFER_WINDOW_DAYS` (3) days apart.
- The match is unique on both sides. The MAX movement fits no other bank row, and the bank row fits no other MAX movement.

The bank row then reads as `transfer.investment_withdrawal` or `transfer.investment_contribution`, which Cash flow leaves out as `investment_move`.

**The match is unique-only because amount and date are weak evidence.** Two bank rows with the same amount in the window give no way to tell which one is the transfer. Picking one would hide a real receipt or a real payment from Cash flow, and nothing on the page would show the guess. Leaving both as they are keeps every total correct except the one move, and that row is still visible.

The relation is stored like a Yuanta funding relation, in `investment_funding_relations`, with its own evidence contract `maicoin-twd-bank-transfer/v1` and the `single-transaction` settlement model. Its `settlement_group_key` names the MAX transaction. It has no member rows, because members hold only `buy` and `sell` trades. Yuanta relations keep their own rules.

**Resolution reads every MAX TWD movement each time, so it gives the same relations whoever calls it.** It runs in every `financial.investmentRelations.resolve`, which the MaiCoin workflow calls after each capture. It also runs inside every deposit commit, because a new bank row can complete a match or make one ambiguous. A relation whose match is gone or no longer unique is withdrawn, and its bank row's Kind is derived again. A store that already holds such pairs gains the relations on its next open, through a one-time pass.

## Considered options

- **Pick the closest date when two bank rows fit.** Rejected. A same-day salary or refund of the same amount would be hidden from Cash flow.
- **Read the bank label.** Rejected. Banks label these transfers in many ways, and the label does not name MAX.
- **Leave the bank row as a receipt and offer a Cash-flow transfer link.** Rejected. A link pairs two counted sides, and the MAX side is never counted.

## Consequences

- A MAX transfer with a same-amount twin within three days stays counted on the bank side, as income or an outflow.
- A MAX movement synced before the statement log existed has no row type, so it does not match until the next MAX sync logs its history again. (Amended by [ADR 0158](./0158-the-max-commit-carries-row-type-state-and-twd-valuation.md): the next MAX commit fills the row type.)
- A Cathay domestic deposit row keeps the Kind its own description rules give, because those rules do not read relations.
