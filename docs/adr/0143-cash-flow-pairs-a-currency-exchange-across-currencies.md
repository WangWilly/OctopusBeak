# Cash flow pairs a currency exchange across currencies

Status: accepted

A person who exchanges TWD for USD at their bank produces two transactions: a TWD outflow on one account and a USD inflow on another. Since ADR 0140 both sides carry an evidence-backed `transfer.internal` from the bank's exchange label, so neither counts. A Cash-flow transfer link (ADR 0137), however, needs equal amount and currency, so the two sides can never be paired. Cash flow then shows the TWD side as 「另有 1 筆未配對」. That reads like unfinished work, though there is nothing to do and the sides cannot be paired.

**A currency exchange link is a Cash-flow transfer link whose sides are in different currencies.** It has the same lifecycle as any other link: evidence, candidate, confirm, deny, revoke and suspend, stored in the same history.
- **Evidence:** it is established automatically when both sides carry a bank's exchange label and an evidence-backed `transfer.internal`, sit at the same Institution, move in opposite directions on the same date, and are each other's only such candidate.
- **Candidate:** two deposit transactions in different currencies, in opposite directions, in two owned accounts, at most 3 days apart, are proposed when at least one of them carries an exchange label and neither carries an evidence-backed Kind other than `transfer.internal`. A card purchase, an investment row or an evidenced salary is never offered beside an exchange.
- **Manual:** the person may pair any two such transactions, at any distance. ADR 0137's exclusion rules apply unchanged: only a weak or fallback side is excluded, and an evidence-backed Kind keeps its own side.

The amounts never match, so they are not evidence. The exchange labels at both ends, the shared Institution and the shared date are.

**It shows in both currencies' Cash flow and counts in neither.** It appears apart from same-currency pairs, as 「換匯 N 組」, with the rate the two amounts imply. The rate is stated per one unit of the costlier currency (「1 USD = 32.7036 TWD」), so a buy and a sell read the same way and can be compared.

**An Unpaired internal transfer is information, not a task.** An evidence-backed `transfer.internal` that no link names is already out of inflow and outflow. Its counterpart may be in an account the person has not connected. Cash flow lists such transactions in the transfer panel so a large amount never disappears silently, and says why each one has no pair.

## Considered options

- **Keep exchanges as unpaired internal transfers.** Rejected. The note keeps reading as unfinished work, and the page cannot show what the money became or at what rate.
- **Show exchanges apart from transfers without pairing them.** Rejected. It hides the false alarm, but still cannot show both sides or the rate.
- **Never pair across currencies automatically; always ask.** Rejected. The labels at both ends, the shared Institution and the shared date are as strong as the evidence for a same-currency pair.
- **Require the implied rate to sit near that day's market rate.** Rejected. It adds little over the label, Institution and date evidence, and turns a missing rate into a missed pair.
- **Propose any cross-currency pair in opposite directions within 3 days.** Rejected. A USD card purchase and an unrelated TWD inflow would flood the candidates.

## Consequences

- An exchange split across two banks, such as a remittance into a foreign-currency account elsewhere, is never paired by evidence. The person confirms it as a candidate or pairs it by hand.
- One link now spans two currencies. Every per-currency view must show it without counting it, and the CSV export gives both sides the same pairing id.
