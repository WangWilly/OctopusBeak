# Manual assets live outside Financial Accounts and survive a reset

Status: accepted

## Decision

A person can enter assets that no source collects: cash, a house, an insurance policy's cash value, a vehicle, a Labor Pension individual account, or another asset. A Manual Asset is not a Financial Account. It lives in its own records outside canonical financial data, as Preview Financial Data does ([ADR 0047](0047-preview-sources-outside-canonical-admission.md)), and counts toward assets and net position with a manual marker.

A Financial Account's identity, evidence, withdrawal, and completeness rules all describe what a source asserts. A Manual Asset has no source connection, no capture, and no contract that could prove completeness. Making it an account would add an exception to each of those rules.

A Canonical Reset keeps Manual Assets. Collected data comes back through new collection, but a Manual Asset exists only because the person typed it in, so a reset would destroy it for good. The Settings action is therefore named 「刪除所有收集的財務資料」, and Manual Assets are deleted only through their own action.

## Considered options

- **A Financial Account behind a synthetic "manual" source connection.** Rejected. It would reuse the account pages and totals, but every source rule would need a manual exception. The rule that source amounts and balances are never user-governed would also have to bend.
- **Delete Manual Assets with the reset, like Preview Financial Data.** Rejected. The reset is safe only because collection can rebuild what it removes. Nothing can rebuild a hand-entered valuation history.
- **Store Manual Assets as Preserved Operational Configuration.** Rejected. That configuration may not assert a financial fact, and a valuation is one.
