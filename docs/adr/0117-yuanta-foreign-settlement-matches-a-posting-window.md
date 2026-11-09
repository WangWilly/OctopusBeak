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

**A posting relates only when nothing else could claim it.** A group relates to a posting only when all of these hold:

- the posting is the group's only candidate;
- no other settlement-contract group in the same resolution pass sees the posting in its window, whether as its only candidate or as one of several;
- the posting funds no observed relation other than the group's own prior relations.

Otherwise the group relates nothing and records `ambiguous-funding-candidate`. A group with no candidate records `no-complete-funding-candidate`.

**The relation keeps the posting's day.** The relation's settlement date is the matched posting's effective date, and its settlement group key stays `<investment account>:<posting date>`. When the weekday rule groups a calendar relation's trades exactly as the calendar did, the relation has the same key, identity and support reason. It stays current with no withdrawal or new observation.

**Calendar relations netted across a closure are withdrawn.** The calendar could put trades on either side of a Taiwan closure on one settlement day. One example is a sell on Thursday 2026-02-12 and a buy on Friday 2026-02-20, which both settled on 2026-02-23. The weekday rule splits such trades into separate groups. No posting matches either group's net amount, so the relation is withdrawn and the trades stay unrelated under `no-complete-funding-candidate`. They are not re-paired to another posting.

**Prior relations are found by their trades.** A settlement-contract group has no source date, so its prior active relations are the ones holding any of its trades. When the group matches a different posting, or no posting, those relations are withdrawn: complete coverage makes a missing replacement authoritative, as before. Source-linked-account funding keeps finding prior relations by its source settlement date.

**No trade disappears.** Every group that does not relate is counted under a named reason. The `unsupported-settlement-calendar` reason is gone, along with the calendar and its contract constants.

## Considered options

- **Sync the DGPA government office calendar.** Rejected. It adds a network dependency and a parser for an official spreadsheet to every resolution, and a missed sync silently stops relations again.
- **Keep the calendar and regenerate it yearly, with a CI reminder.** Rejected. It needs maintenance every year, and a missed update drops relations the way the 2026 list did.
- **Search combinations of trades that sum to a posting.** Rejected. A subset search across neighbouring days can find several combinations that fit one amount, so it trades a missed relation for a wrong one.
- **Take the earliest posting when a window holds several.** Rejected. Equal amounts are not evidence of which trade a posting settles, and a wrong relation is worse than none.

## Consequences

- When a holiday splits trades the bank netted into one posting, the weekday groups do not match it. Those trades stay unrelated, counted under `no-complete-funding-candidate`, and never relate to a wrong posting.
- Groups with the same net amount whose windows overlap lose their relations to ambiguity. Recurring equal buys, such as a weekly fixed-amount purchase, stay unrelated.
- 2026 relations that the calendar netted across a closure are withdrawn on the first resolution after this change.
- There is no yearly calendar to maintain.
