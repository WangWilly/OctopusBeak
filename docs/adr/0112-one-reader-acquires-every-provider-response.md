# One reader acquires every provider response

Status: accepted

Builds on [ADR 0110](0110-one-module-verifies-every-provider-response.md), which keeps acquisition out of the verifying module. Keeps product validation in the product handle ([ADR 0106](0106-the-product-handle-decides-what-is-a-validation-failure.md)) and the run clock as the observed time ([ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md)).

## Context

After ADR 0110, `acceptProviderResponse` was the only way evidence reached a parser, but every caller still wrote the step that fed it. About twenty call sites armed Playwright's `waitForResponse`, ran their own action, built a `ProviderResponse` by hand, read the body and picked a time. The copies had drifted:

- Some read headers with `allHeaders()` and some with `headers()`, which leaves out headers Chromium treats as security-sensitive.
- Some read the body without the run signal, so a cancelled run kept waiting on it.
- Cathay and SinoPac's card and loan reads stamped the wall clock instead of the run clock.
- Four sources checked the transport before reading the body by hand; the rest read the body first.
- Cathay accepted its replies outside product validation, so a refused Cathay reply failed as `source-collection-failed` while every other bank's failed as `source-validation-failed`.

The follow-up fixes of the ADR 0110 migration all landed in this layer.

## Decision

**One module acquires every provider response.** `providerResponseReader({ now, text, validate })` in `src/workflows/provider-response-reader.ts` is built from the run's ports. Its `capture` arms the wait for the declared response, runs the source's trigger, reads the transport facts with `allHeaders()`, checks them before reading the body, reads the body under the run signal, stamps the run clock and accepts the response. A bank passes only the declaration, the trigger, and the request the response must answer.

**A refused response fails inside the caller's validation.** The transport check and the accept both run inside the `validate` the reader was built with. A product passes its own `validate`, so a refused reply is always a validation failure. A read that no product owns yet, such as Cathay's session and profile, passes `WITHOUT_PRODUCT_VALIDATION`. A response that never arrives, a trigger that throws and a body read that fails stay collection failures, as ADR 0110 required.

**The trigger runs until the reply.** The trigger receives a signal that aborts once the reply has arrived or the read has failed, so a trigger that repeats, such as E.SUN scrolling its timeline, returns. Its value comes back with the response, so Cathay still compares the status its in-page fetch saw.

**Its entry points follow how a source meets the response.** `capture` waits, reads and accepts. `acquire` does the same without the accept, for the snapshot module's `acquire` callbacks. `witness` waits and checks the transport without reading the body, for a source whose evidence is the page the response carried. `watch` starts waiting for a response the provider may or may not send while the source does other reads, such as E.SUN's card summary, and settles to nothing when none arrives or the provider says it has nothing. `acquireFrom` reads a response the source already holds: a navigation's return, a routed `route.fetch()` or an `APIRequestContext` reply. `accept` stamps the run clock and accepts evidence the reader did not read, such as DOM cells or the bytes of an in-page fetch. The snapshot module accepts through the reader too, so there is one accept path.

**The wait may be wider than the declaration.** By default the reader waits for the declared endpoint and method. A source may wait for more, such as any host on its history path or the end of a redirect chain, so the declaration refuses a lookalike by name instead of the wait running out. A declared endpoint path may be a pattern, for an endpoint known only by its name.

**A structural check keeps it the only one.** Outside the reader and the verifying module, workflow source does not call `waitForResponse`, `acceptProviderResponse`, `verifyProviderResponse` or a response's header methods. Checks fake a Playwright response with one fixture, `fakeProviderReply`.

## Considered options

- **Keep migrating one bank at a time, as ADR 0110 did.** Rejected. Each bank re-stated the same sequence and each restatement drifted; one change with a structural check ends the drift at once.
- **Let banks keep the Playwright response and read the request themselves.** Rejected. The response and its headers would leak past the reader again; the reader returns the request's URL, method and body instead.
- **Accept only one-shot triggers.** Rejected. E.SUN and HNCB would stay outside the reader, and the structural check could not forbid their waits.

## Consequences

- A refused Cathay or Cathay foreign-currency reply now fails as `source-validation-failed`.
- SinoPac card and loan and Cathay replies carry the run clock as their observed time.
- A body is never read from a response whose transport was refused.
