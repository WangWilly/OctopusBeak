# Signed-in reads stop on the run signal

Status: accepted

Extends [ADR 0066](0066-source-site-owns-signed-in-navigation.md) to every bank. Leaves sign-in to the Source sign-in step of [ADR 0061](0061-source-sign-in-step-owns-every-browser-sign-in.md).

ADR 0066 made the Fubon and Yuanta Source sites race every wait against the run signal and deferred the other banks. They kept wrapping individual awaits in `withAbort`. Racing only stopped the workflow from waiting: the Playwright operation kept running in the browser until its own timeout, so an abandoned click could still land after the run was cancelled. Some reads had no signal at all. The Cathay attached preview waited up to 60 seconds on `goto` and `waitForResponse`. The Yuanta Trade report capture waited up to 60 seconds on navigation and slept without checking the run.

**Every signed-in read stops its browser work when the run is cancelled.** A read builds a `FrameScope` bound to the run signal. On a site without frames the scope is just the page. An operation that accepts Playwright's `signal` option runs through `withSignal`, so Playwright stops it in the browser. The caller receives the run's reason, which makes the product record `cancelled`. An operation without that option, such as `evaluate` or reading a response body, is raced through `race`. A fixed wait is the scope's cancellable `pause`. `withAbort` remains only for promises outside the page, such as the CAPTCHA solver, human assistance and the commit port.

**Timeouts and their classification do not change.** Each call keeps its current timeout. A timeout fails the way it did before, and deposit goldens are unchanged.

**Each bank has a mid-read cancellation check.** It runs in real Chromium against a synthetic page, cancels while a wait is pending, and asserts that the read rejects with the run's reason promptly and stages nothing.

## Considered options

- **Race every bank's waits, as ADR 0066 first did.** Rejected. A raced operation keeps running in the browser and can act after cancellation.
- **A separate signed-in page object for single-page banks.** Rejected. `FrameScope` already treats a page without frames as one scope, and one helper serves every bank.
- **Fix only the reads that had no signal.** Rejected. The banks that wrapped their waits still left browser work running for up to two minutes.

## Consequences

- A new bank's signed-in read uses `FrameScope` from the start, and a review can reject a bare `withAbort` around a page operation.
- Sign-in flows still follow ADR 0061 and may use `withAbort` until that step adopts the same helper.
