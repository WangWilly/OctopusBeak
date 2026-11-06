# One module verifies every provider response

Status: accepted

Amends [ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md) and [ADR 0109](0109-a-failed-snapshot-check-names-itself-in-the-failure-diagnostic.md), which verify and name the checks of Current-state snapshot responses only. Keeps product validation in the product handle ([ADR 0106](0106-the-product-handle-decides-what-is-a-validation-failure.md)).

## Context

ADR 0096 moved the transport checks of Current-state snapshots into one declaration per source. It rejected shared helpers that each parser calls, because a parser could skip a check and the next bank would copy whichever parser it found first.

Statement history reads, which produce most Source Captures, never got that treatment. Each bank checks its own replies:

- Cathay, Post, SinoPac, HNCB and Yuanta Trade each hand-write a host, path, method, status, content-type and charset check.
- CTBC and E.SUN match the endpoint with a substring of the URL and check no host. CTBC checks neither status nor content type.
- Fubon's postback and LINE Bank accept any 2xx reply.
- A failed history check throws a plain `Error`, so the failure diagnostic of ADR 0109 cannot say which check failed.

A run-ending product failure also dropped its error: the Product collection run threw a new `ProductCollectionInterruptedError` without a `cause`, so a check named anywhere below it never reached the diagnostic.

## Decision

**One module verifies a provider response and decodes its evidence.** `acceptProviderResponse(declaration, acquired, { observedAt, text })` in `src/workflows/provider-response.ts` checks one acquired response against the source's declaration, then strictly decodes its evidence through the Source text port. A failed check throws before any decoding. A source's parser receives decoded evidence only from this module.

**It handles one response and reports nothing.** It emits no product events and runs no product validation. The Current-state snapshot module calls it inside its validation step and keeps its own events and the `row-parse` check. A history read calls it once for each response it reads, and its product runner keeps reporting.

**The checks are provider response checks.** `src/lib/automation/provider-response-check.ts` holds the fixed set ADR 0109 named, now `PROVIDER_RESPONSE_CHECKS`, and `ProviderResponseCheckError`. The failure diagnostic and the Error report carry the check in the node field `responseCheck`, which replaces `snapshotCheck`. The App has sent `snapshotCheck` in reports only since a change no release includes, so the report receiver renames its field too and keeps no old name. The receiver accepts `responseCheck` before an App release sends it, because it refuses an unknown node key.

**History reads adopt it source by source.** Each history read that receives an HTTP response declares that response and passes it through the module:

1. Sources that already check their replies strictly move first. Their own checker is deleted, and every commit golden stays unchanged.
2. Sources that check loosely follow. A declaration states what the provider is observed to send, from fixtures or a live run. A fact with no evidence is left undeclared rather than guessed.
3. Reads whose rows come from the DOM but are witnessed by a response declare that response and keep reading the DOM.

A new evidence kind or check, such as a declared charset for a Big5 export, is added with the first source that needs it.

**A run-ending product failure keeps its error as its cause**, so a named check reaches the diagnostic on that path too.

## Considered options

- **Keep one verification function and let each bank decode.** Rejected for the reason ADR 0096 gave: a bank can skip the decoding check, and the copies drift again.
- **Have the module acquire the response too.** Rejected. The snapshot module reports a failed acquisition as a collection failure and a failed check as a validation failure (ADR 0106), so acquisition stays with the caller.
- **Keep the diagnostic field `snapshotCheck`.** Rejected. The field would name a snapshot for a check that also covers history reads, and no released App has sent it yet.
- **Tighten every loose source to the strictest form.** Rejected. It changes live behavior without evidence of what each provider sends.

## Consequences

- A development diagnostic line names the check as `"responseCheck":"response-endpoint"` instead of `"snapshotCheck"`.
- A Current-state snapshot reads exactly as before. Every check name, message and commit golden is unchanged, except that a body that is not JSON now reads "Provider response is not valid JSON."
- Reads with no HTTP response stay outside the module: Fubon credit-card history and Yuanta loan scrape the DOM, and E-Invoice, TDCC and Binance speak app protocols over their own transports.
- Until a history read adopts the module, its failures still report without a check.
