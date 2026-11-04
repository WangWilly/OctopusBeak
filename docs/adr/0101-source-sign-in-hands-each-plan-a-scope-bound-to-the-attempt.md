# Source sign-in hands each plan a scope bound to the attempt

Status: accepted

Completes [ADR 0094](0094-signed-in-reads-stop-on-the-run-signal.md) for sign-in. Keeps the Source sign-in step of [ADR 0061](0061-source-sign-in-step-owns-every-browser-sign-in.md).

ADR 0094 made every signed-in read stop its browser work when the run is cancelled, and left sign-in on `withAbort` until the step adopted the same helper. The step handed each plan callback the page and a bare signal. Each bank then wrapped every Playwright call in `withAbort` by hand, more than eighty in all. The step also raced each callback against the first dialog verdict. Both only stopped the wait: a click or fill already sent kept running in the browser and could land after the run was cancelled or after a dialog had ended the sign-in.

**The step hands each plan callback a `FrameScope`, never a page and a signal.** `signedIn`, `fill`, `submit`, `prompts` and a shell plan's `own` receive a scope bound to the attempt. A plan reaches the page as `scope.page` and runs its waits through `withSignal`, `race`, `pause` and `until`, as a signed-in read does.

**A dialog verdict ends the attempt the way cancellation does.** The first verdict aborts the attempt's signal with the verdict as its reason. Playwright stops the plan's pending operation, and the step throws that verdict. Run cancellation, the first verdict and the end of the attempt now stop plan code through one signal.

**The session probe gets its own scope bound to the run.** Collection calls it after the attempt has ended, so it cannot share the attempt's scope. The same probe function serves both.

**The step still races each callback against the attempt signal.** A plan that bypasses the scope cannot hold the step. The race stops only the wait, so the bank's own cancellation check catches such a plan.

The CAPTCHA `stage` and `answer` callbacks keep taking the page. They hand off to the verification port or return a locator, and do not wait on the page themselves.

## Considered options

- **Keep `(page, signal)` and reject bare `withAbort` in review.** Rejected. Every plan would still need its own wrapping, and a dialog verdict would still leave browser work running.
- **Pass both the page and the scope.** Rejected. The interface grows, and the page stays the easier path.
- **Narrow `FrameScope.page` so plans cannot act on it directly.** Rejected for now. Signed-in reads share the type, and the per-bank cancellation checks already catch a plan that bypasses the scope.
- **A source check that rejects `withAbort` or `scope.page.` in plan files.** Rejected. It pins the source rather than the behaviour.

## Consequences

- A new bank's sign-in plan uses the scope from the start, and a review can reject a bare `withAbort` around a page operation, as ADR 0094 allows for reads.
- `withAbort` remains only for promises outside the page, such as the CAPTCHA solver and human assistance.
- `sign-in.check.ts` proves that a pending click does not land after run cancellation or after a dialog verdict. Each bank keeps its own sign-in cancellation check.
