# A broken credit-card current snapshot fails the card capture

Status: accepted

Follows [ADR 0107](0107-the-snapshot-module-assembles-every-current-state-capture.md), which left the credit-card current snapshots outside the module's read and stage steps. Applies [ADR 0106](0106-the-product-handle-decides-what-is-a-validation-failure.md) and [ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md) to them.

## Context

Fubon, Yuanta and E.SUN read the current used credit beside their statements. Each of them treated any problem with that read as "no current balance" and staged the statements alone:

- no response,
- a status other than 200,
- missing response headers,
- a page without the used-credit table,
- a reply that failed to parse,
- and, for Fubon, replacement characters in the page.

None of them reported current-balance events. A bank that changed its page therefore lost the current balance without any signal, while the statements read in the same run were committed as if nothing had changed.

## Decision

**Credit-card current snapshots read and stage through the snapshot module.** Each bank declares its provider response, its row parser, the credit-card staging kind and a matching for its one issuer aggregate. Fubon and Yuanta hand over page markup as `html` evidence; E.SUN hands over its card-summary body as `json` evidence. The read reports collection and decoding, and the stage reports validation, with the same six current-balance events as deposits.

**No response means no snapshot.** When the page's own response is never observed, or E.SUN answers 204, the bank reads nothing, stages nothing and reports nothing.

**A provider that says there is nothing is an empty snapshot.** E.SUN's `hasCreditCard: false` parses to no rows. The validation events still report, with zero counts.

**Anything else that goes wrong fails the card capture.** Examples are an unexpected endpoint or status, missing cache directives or HTTP Date, a page without its table, a reply without its fields, and replacement characters. The card capture is cancelled together with its statements, as a deposit snapshot failure cancels its capture.

**The staged balance keeps its existing facts.** Its item key stays the capture id, and its `observedAt` stays the card capture's. Moving `observedAt` to the verified response's time is a separate change, so that the commit goldens here differ only by the new events.

**The E.SUN v1 grid parser is removed.** No production path read it. The `esun/credit-card/current-used-credit-v1` route contract stays, because stored captures may cite it.

## Considered options

- **Treat every failure as absence.** Rejected. It keeps the silent loss that strict decoding exists to prevent.
- **Report the failure but still commit the statements.** Rejected. The product handle would report a rejected validation on a run that then succeeds, which reads as a contradiction. A changed page also casts doubt on the statements read next to it.
- **Let the cards keep their own staging.** Rejected. Each card would write the validation events by hand, and the order between them would drift from the module's.

## Consequences

- A Fubon, Yuanta or E.SUN run whose current-credit page changes now fails instead of committing statements without a current balance.
- A summary page that never loads, such as Yuanta's settled-summary navigation failing, still leaves the current balance unread, because no response was observed.
- The Fubon and Yuanta commit goldens feed a snapshot that has already been read, so they show only the two staging events. The Fubon shell check covers the read events.
