# Bank Kind rules read labels and payload text, not payload keys

Status: accepted

The bank Kind classifier joined a row's description with its raw source payload JSON and ran keyword rules over the result. Every foreign-currency payload has a `feeAmount` key, so the fee rule matched every foreign-currency row the earlier rules missed, and Sinopac and Cathay exchange and settlement rows became `fee.bank` (#478). The same text also holds base64 digests, which can contain `fee`, `ach` or `atm` by chance.

**Keyword rules read the description and the payload's text values, never its keys or machine tokens.** A payload string with no whitespace that is printable ASCII and holds a digit or one of `: _ - / = . +` is a token, such as a digest, an id, a date or a version, and is skipped. A payload note such as a memo still counts, because it can carry text the description lacks.

**Label rules match the bank's own label whole, before the keyword rules.** The label is the description's first `·` part, without whitespace or a leading Debit/Credit marker. A currency exchange (手機換匯, 行動換匯, 網路換匯, 網銀換匯, 換匯) is `transfer.internal` for any bank, replacing the Fubon-only rule. 複委託 and 交割股款 are `transfer.investment_contribution` on an outflow and `transfer.investment_withdrawal` on an inflow. An inflow 配息 line or ticker 息 line is `income.dividend`, which counts once, from the bank side (ADR 0138). An inflow 存款息 or 活存息 is `interest.earned`. An exchange's own fee row has its own label, such as 換匯手續費, so it stays a fee.

## Considered options

- **Drop the payload from matching.** Rejected. Foreign-currency payloads carry the provider's memo, note or transaction info, which the description does not hold.
- **Narrow only the fee rule.** Rejected. Every keyword rule had the same key and digest exposure.

## Consequences

- The producer, its version and its outputs are unchanged, so no taxonomy row is added. Changed Kinds supersede the old ones through the one-time Kind re-derivation on the next open.
