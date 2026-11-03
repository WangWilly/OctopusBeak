# The snapshot module verifies the provider response and stamps observed time

Status: accepted

Builds on [ADR 0092](0092-one-module-captures-every-current-state-snapshot.md) and reverses its one clause that kept "the endpoint and header checks" with each bank's row parser.

ADR 0092 moved decoding, matching, keying and events into the Current-state snapshot capture module, but left each bank to check the response that carried its rows. All eight banks therefore kept private copies of the same transport checks: a header lookup, HTTP Date parsing, URL host and path checks, method, status, content type and Cache-Control. Each bank also produced its own observedAt. These copies had drifted in the same way 0092 found for amount parsing:

- **The clock.** HNCB stamped observedAt from the wall clock instead of the run clock, so its balances could not be pinned in a test. Post fell back to `new Date()` when no observedAt arrived. SinoPac used the run clock in UTC, CTBC added eight hours by hand, and HNCB, Post and Yuanta formatted Taipei time through `Intl`.
- **The format.** Post's domestic deposit admission accepts only `+08:00` to the second, while CTBC's accepts optional milliseconds and Fubon's accepts any offset, so which observedAt a bank produced decided which admissions it could satisfy.
- **Header checks.** Eight `responseHeader` copies and seven HTTP Date parsers under five names, one of which returned a bare string instead of the raw and effective time.

**A source declares the response that carries its snapshot, and the module verifies it before parsing.** The declaration names the host, one or more endpoints (path, method, optional content type, allowed query), the Cache-Control directives the response must carry, and whether the HTTP Date is required. The acquisition hands over its evidence together with the response's URL, status, method and headers. The module rejects any response the declaration does not name, with the source's label leading the message, and the failure reports as a decoding failure exactly as a parser failure did. Acquisitions use the same declaration to recognise the response they wait for.

**The module stamps observedAt from the run clock**, as RFC3339 in Taipei's offset to the second, the one form every source admission accepts. It samples the clock when the acquisition returns. Banks no longer pass or check observedAt for balances. LINE Bank reuses the account-list response it read before the statements, so it hands the module the run-clock instant of that read instead of the live clock. The statement captures that already used Taipei time (CTBC, HNCB, Post and Yuanta) format it through the same helper. SinoPac and Cathay statement captures keep the run clock's own form.

**The row parser receives a Verified provider response.** It reads the URL, content type, cache policy, provider date and observedAt from it, and still decides effective time: the HTTP Date by default, or a body time where the provider sends one (CTBC `dataTime`, Cathay `systemTime`, Post `SERVER_TIMESTAMP`), compared with the HTTP Date as before.

## Considered options

- **Share helper functions that each parser calls.** Rejected. A parser could still skip a check, and the next bank would copy whichever parser it found first.
- **Add a per-bank check hook to the declaration.** Rejected. Every transport check the eight banks enforce fits the declaration as data, and a hook would let the copies grow back.
- **Let the module also decide effective time from a declared body field.** Rejected. The body times differ in field, format and tolerance, so the interface would widen without removing a bug.
- **Generalise LINE Bank's check that observedAt never precedes the HTTP Date.** Rejected, and the check is deleted. observedAt is the local clock and the HTTP Date is the provider's, so a few seconds of local lag would fail a run while the check protects no stored fact.

## Consequences

- Every balance observedAt is `YYYY-MM-DDTHH:mm:ss+08:00`. The deposit-commit goldens record the new values. observedAt varies by run and no identity derives from it.
- Cathay derives its balance scope date from observedAt, so the scope date is now the Taipei calendar day. A run between 00:00 and 08:00 Taipei time used to record the previous UTC day.
- Transport-failure tests live once in the module's check. Each bank keeps tests for its declared data and its rows.
- A new bank declares its response instead of writing a checker. A check the declaration cannot express extends the declaration type.
- Source admissions keep their own observedAt validators, as ADR 0054 decided.
