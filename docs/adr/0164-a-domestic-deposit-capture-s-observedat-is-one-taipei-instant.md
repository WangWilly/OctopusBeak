# A domestic deposit capture's observedAt is one Taipei instant

Status: accepted

Amends [ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md), which left each source admission its own observedAt validator.

A capture's `observedAt` is the time the App read the source, not a time the bank reports. ADR 0096 gave balance captures one form, `YYYY-MM-DDTHH:MM:SS+08:00` from the run clock. The CTBC, Post, Fubon and Yuanta domestic deposit statement captures did not all follow:

- CTBC, Post and Yuanta stamped `taipeiInstant(context.now())`. Fubon defaulted to `new Date().toISOString()`, which is UTC and ignores the injected clock, so a check or `workflow-dev --now` could not set it.
- The four admissions' validators had drifted to match their producers. Fubon's accepted any offset and any fraction. CTBC's accepted three fractional digits and Yuanta's any. CTBC, Post and Yuanta accepted `2026-02-30`, because `Date.parse` rolls it over.
- The overview, assets and liabilities pages took an account's last-updated date as the first ten characters of `observedAt`. For a Fubon capture stored in UTC, a sync between 00:00 and 08:00 Taipei showed the previous day.

## Decision

- **A CTBC, Post, Fubon or Yuanta domestic deposit capture stamps `taipeiInstant(context.now())`.** Fubon's builder takes the time as an argument and has no default.
- **One validator admits it.** `isTaipeiInstant` in `src/lib/time/timezone.ts`, beside `taipeiInstant`, accepts exactly the text `taipeiInstant` writes: no fraction, no other offset, a real calendar date, hour 0 to 23, minute and second 0 to 59. The CTBC, Post, Fubon and Yuanta admissions use it. Their diagnostics and failure codes are unchanged.
- **A date derived from `observedAt` is `taipeiDate` of the instant**, never a slice of its text.
- **Stored UTC values stay.** Fubon statement captures admitted before this change keep `...Z` in `source_captures.observed_at`. No migration rewrites them. Admission validates only new captures, so nothing refuses them later. They read correctly because dates come from `taipeiDate`, and because a later instant written as Taipei wall time always has greater leading digits than an earlier instant written in UTC, so text order stays chronological.

## Considered options

- **Keep a validator per admission.** Rejected. The copies had already drifted, and a producer's format decided which admission it could pass.
- **Accept `Z` and fractions, and normalize on read.** Rejected. Every producer already writes one shape, and a looser validator admits values the producer never writes.
- **Rewrite stored Fubon rows to `+08:00`.** Rejected. No query misreads them once dates come from `taipeiDate`, and a migration would rewrite evidence to fix a display bug.

## Consequences

- The Fubon deposit-commit goldens record statement captures' `observedAt` as `2026-09-25T08:00:00+08:00` instead of `2026-09-25T00:00:00.000Z`, the same instant.
- `fubon-observed-at.check.ts` pins both readings of a stored UTC row: its last-updated date, and that a newer Taipei row outranks it, also when they are under eight hours apart.
- Other captures keep their own forms and validators, among them Fubon's credit-card and loan captures, which stamp `context.now()` in UTC, and the Cathay, HNCB, LINE Bank and SinoPac statement captures. This decision does not cover them. An account's last-updated date uses `taipeiDate` for every account, so for those captures it is now the Taipei day as well.
