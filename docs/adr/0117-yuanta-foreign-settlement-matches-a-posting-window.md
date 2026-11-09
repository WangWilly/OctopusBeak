# Yuanta foreign settlement matches a posting window

Status: accepted

Applies the Institution-specific date rule that [ADR 0016](0016-evidence-gated-loan-repayment-relations.md) requires to Yuanta foreign-securities (複委託) funding. The window below is a Yuanta contract, not a universal date window across Institutions.

## Context

Yuanta settles a foreign-securities trade in the person's Yuanta foreign-currency deposit account. The settlement model is `account-currency-date-net`: every buy and sell that settles on the same Taiwan banking day, in one currency, nets into one posting. The posting reads `複委託扣` (outflow) or `複委託入` (inflow), its transaction info reads `淨額扣` or `淨額入`, and it carries the settlement linkage key derived from the stable login identity and currency.

Relation resolution used to compute each trade's settlement day from a hard-coded Taiwan holiday list (buy T+1, sell T+2 business days). The list covered 2026 only. From 2027-01-01, and already for a 2026-12-30 sell, the computation returned nothing and the trade was dropped from resolution without a reason.

The provider cannot supply the date instead. The live 複委託 stock trade report (`OverseaTrade`, stock grid) has no settlement-date column.

## Decision

**A trade expects to settle on a weekday.** Its expected settlement day is the trade date plus one weekday for a buy and two for a sell. Only Saturdays and Sundays are skipped. Trades are grouped by investment account, cash currency, settlement market and that expected day, and each group nets as before.

**A group matches a posting inside a ten-day window.** A candidate posting passes every check the exact-date match applied: description, transaction info, linkage key and linkage contract, complete-range coverage with a terminal page, posted, normal and active, direction, currency and exact net amount. Its effective date must fall from the expected day through ten calendar days after it. The window absorbs Taiwan closures; the longest, Lunar New Year, is shorter than ten days.

**Ambiguity relates nothing, in both directions.** A group with two or more candidates in its window relates nothing. A posting that is the only candidate of two or more groups in the same resolution pass relates to none of them. Both record `ambiguous-funding-candidate`. A group with no candidate records `no-complete-funding-candidate`.

**The relation keeps the posting's day.** The relation's settlement date is the matched posting's effective date, and its settlement group key stays `<investment account>:<posting date>`. A relation the calendar created for a correctly dated trade has the same key, identity and support reason, so it stays current with no withdrawal or new observation.

**Prior relations are found by their trades.** A settlement-contract group has no source date, so its prior active relations are the ones holding any of its trades. When the group matches a different posting, or no posting, those relations are withdrawn: complete coverage makes a missing replacement authoritative, as before. Source-linked-account funding keeps finding prior relations by its source settlement date.

**No trade disappears.** Every group that does not relate is counted under a named reason. The `unsupported-settlement-calendar` reason is gone, along with the calendar and its contract constants.

## Considered options

- **Sync the DGPA government office calendar.** Rejected. It adds a network dependency and a parser for an official spreadsheet to every resolution, and a missed sync silently stops relations again.
- **Keep the calendar and regenerate it yearly, with a CI reminder.** Rejected. It needs maintenance every year, and a missed update drops relations the way the 2026 list did.
- **Search combinations of trades that sum to a posting.** Rejected. A subset search across neighbouring days can find several combinations that fit one amount, so it trades a missed relation for a wrong one.
- **Take the earliest posting when a window holds several.** Rejected. Equal amounts are not evidence of which trade a posting settles, and a wrong relation is worse than none.

## Consequences

- When a holiday splits trades the bank netted into one posting, the weekday groups do not match it. Those trades stay unrelated, counted under `no-complete-funding-candidate`, and never relate to a wrong posting.
- Two groups with the same net amount close together can both lose their relation to ambiguity.
- There is no yearly calendar to maintain.
