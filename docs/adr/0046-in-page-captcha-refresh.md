# Refresh a CAPTCHA in the page before submitting, and cap campaigns at three rounds

Status: accepted; supersedes the round limit and the deferred in-page refresh of [ADR 0015](0015-bounded-captcha-retry-campaigns.md)

## Decision

Under ADR 0015 every CAPTCHA Challenge Round restarts the provider workflow and, unless the solver is exhausted, submits one sign-in. A campaign of ten rounds can therefore submit ten sign-ins, and some Taiwan banks lock an account after three wrong attempts.

A round now separates solving from submitting. When no candidate satisfies the provider's Solve Acceptance Policy, the workflow uses an In-page CAPTCHA Refresh to load a new challenge on the same login page and solves again, up to five challenges per round, without submitting. A round still submits at most one answer. Only a provider-rejected answer, or five refreshed challenges without an accepted candidate, ends the round, and the next round restarts the workflow as before. A campaign permits at most three rounds instead of ten.

In-page refresh is provider-specific. A provider declares it only with fixture or live evidence that its refresh control yields a new challenge without resetting the entered sign-in details. A provider without that evidence keeps ADR 0015's behavior: one challenge per round, now within three rounds.

Every other rule of ADR 0015 and [ADR 0012](0012-automatic-captcha-verification.md) is unchanged: retry triggers, fail-closed exhaustion, privacy of images and answers, and no persisted campaign state.

## Considered options

- **Keep ten restart-based rounds.** Rejected for its lockout exposure.
- **Per-provider lockout counters persisted across runs.** Deferred. In-page refresh removes most unaccepted submissions; a persisted counter adds secret-adjacent state for the remaining few.
- **Refresh without a per-round cap.** Rejected. A broken solver would loop against the provider indefinitely.
