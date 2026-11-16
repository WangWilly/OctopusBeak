# Investment and loan accounts decide their own cash flow

Status: accepted

Investment and loan rows had no Transaction Kind: only deposit and credit-card streams had a Kind producer, so every investment and loan row sat in Cash flow's unresolved bucket. These rows already carry structured meaning. An investment writer records an `action` (`buy`, `sell`, `corporate_action_in`, `corporate_action_out`, `dividend`), and a loan writer records an `event_kind` (`disbursement`, `payment`, `interest`, `fee`). Issue #476 decides how they get a Kind and how Cash flow counts them.

**An evidence-backed producer reads the Kind from that event, never from description text.** `account-event/kind-enrichment` v1 covers the investment streams of Yuanta Fund, Yuanta Trade, MaiCoin and Binance, and the loan streams of Yuanta and Fubon. `buy` gives `investment.trade.buy`, `sell` gives `investment.trade.sell`, both corporate actions give `investment.corporate_action`, and `dividend` gives `income.dividend`. A loan `payment` gives `payment.loan`, `disbursement` gives `loan.disbursement`, `interest` gives `interest.charged`, and `fee` gives `fee.loan`. Its evidence kinds, `investment-event` and `loan-event`, are evidence for Cash flow, so no transfer link can override them. Its compatibility rows, producer version and routes are taxonomy additions, which an operational seed step adds to an existing store. Rows captured before the producer get their Kind on the next store open: a one-time pass re-derives every current Kind. A person still cannot set a Kind.

**Nothing on an investment account counts in Cash flow, whatever its Kind.** Every cash effect on an investment account has a counterpart on a funding account: an investment contribution or withdrawal, or a dividend credited to a bank account. Counting both sides would count it twice. So Financial report inclusion has an account rule before the Kind table: a transaction on an `investment` or `investment-fund` stream account is `not_counted` (`investment_move`), even with no Kind. `income.dividend` is recorded truthfully there and counts once, through the bank-side credit. A crypto reward has no TWD cash effect, so leaving it out changes no total; valuing it is deferred.

**A loan's interest and fees count once, from the loan side.** A loan account books its interest and fee as inflows, the share of a repayment that went to the bank rather than to principal. The loan side is the only place that splits a repayment into principal and interest, so a second account rule counts an inflow `interest.charged` or `fee.loan` on a `loan` stream account as an outflow, grouped by its Personal Category, and Unclassified until the person gives it one. The row keeps its booked direction, so the account's net change still reads as it was booked. The list, the detail and the CSV show the row as an outflow, and it is never a side of a Cash-flow transfer link. The principal `payment.loan` and the `loan.disbursement` stay not counted. The deposit debit that repays the loan carries `payment.loan` and stays out. That includes a debit whose label the bank rule would read as interest, once a `loan_repayment_settlement_group` or a one-to-one `transfer_counterpart` loan repayment relation names it. Spending leaves out a loan disbursement outflow too, so its totals do not change.

Cash flow inclusion policy `cash-flow-by-kind` moves to v2.

## Considered options

- **Classify from description text.** Rejected. The writers already record the meaning; text is opaque and varies by provider.
- **Count investment rows by Kind, as the deposit rows are.** Rejected. A dividend or a sale would count on the investment side and again where it reaches the bank.
- **Count loan interest from the deposit debit.** Rejected. The debit pays principal and interest in one amount, and only the loan side splits it.
- **Count both the deposit debit and the loan-side interest.** Rejected. The interest would count twice.
- **Show rewards at a TWD value inside the inflow total.** Deferred. MaiCoin's daily-close value is operational, a float, and has no recorded price provenance. If it is added, it is an estimate beside the total, never inside it.

## Consequences

- A bank-side dividend line counts as a generic `receipt` until it gets its own `income.dividend` Kind (#478).
- A loan repayment relation that only a loan source asserts, with no resolver event, does not guard a deposit debit: no current loan relation reads it as active either.
- The one-time re-derivation runs the same full Kind refresh as a credit-card sync, so the first open after an upgrade takes as long as such a sync.
