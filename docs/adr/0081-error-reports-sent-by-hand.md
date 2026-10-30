# Error reports the person sends by hand

Status: accepted

Builds on [ADR 0078](0078-opt-in-anonymous-daily-usage-ping.md), whose receiver this reuses, and on the sanitized failure record of the workflow failure diagnostics (`workflow-failure-diagnostics.ts`). Narrows the Local-only privacy positioning in [`PRODUCT.md`](../../PRODUCT.md) a second time.

ADR 0078's failure counts tell us which source broke and how often, but not why one person's run failed. Today a person can only paste a Preview structure report into a public GitHub issue, which needs a GitHub account and makes the report public. We want a private way for a person to send one failure, with their own words, to the developer.

**A failed run offers "Report this error". Nothing is sent until the person selects Send.**

- **Where.** The button sits beside the Failure code in a failed run's details, next to Copy error code and the Preview structure report. It is shown only when the build has a receiver (`OCTOPUSBEAK_USAGE_PING_URL`, ADR 0078). It does not depend on the usage statistics switch: each report is its own consent.
- **The dialog says what is and is not sent**, takes an optional note (at most 1,000 characters) and an optional email, and can show the exact JSON. The main process builds that JSON; the renderer only displays it.
- **The payload.** `schema`, `appVersion`, `osVersion` (major.minor), `arch`, `locale` (as in ADR 0078), `source` (the task id), `code` (the Failure code), `stage` (the last operating stage, or null), `diagnostic`, `note` and `email`.
  - `diagnostic` is the record the host already builds for a failed execution, kept in memory for the task's latest failure and dropped on restart. It holds only enumerated values: the failing side, the Failure code, stage, statement type, operation, admission reason, and a chain of at most four error types with SQLSTATE or HTTP status and at most eight stack frames, each inside `build-electron/*.cjs`. It never holds an error message, a value, a path outside the app, the run id or the time. A record whose Failure code differs from the reported one is left out rather than attached to the wrong failure. Building the host record is no longer gated by `OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE`; writing it to a file still is, and so is retaining the chain of a financial or operational RPC error, so such a report carries its codes without a chain. The record is dropped when a later run of the task finishes, and frames outside `build-electron/` are left out of the report.
  - The note has control characters removed and after folding full-width digits, dashes, dots and slashes, every run of six or more digits, however split by spaces, dashes, dots or slashes, replaced by `[已遮蔽]` before the preview, so the preview shows what leaves the Mac. The receiver masks again.
- **The receiver.** `POST /v1/report` on the ADR 0078 Worker validates every field against the same vocabulary, refuses a browser `Origin`, allows one report per minute per address and 500 per Asia/Taipei day, and stores each report as one row with a random id, the receiving time and an `open` or `resolved` status. The answer is `201` with the id, which the dialog shows as a reference. Reports, including notes and emails, are deleted after one year.
- **Reading them.** The Access-protected dashboard lists reports and shows one at a time, escaping everything a person typed. Marking a report resolved is a same-origin `POST`; every other dashboard request only reads.

## Considered options

- **Keep only the public GitHub issue.** Rejected as the only path. It needs a GitHub account, and a note about a failed bank sign-in should not be public.
- **Send a report automatically on every failure.** Rejected. It would send per-failure detail and timing without a decision by the person; ADR 0078's daily counts cover the automatic part.
- **Send raw error messages and stack traces.** Rejected. Messages from sources and libraries can carry account names, numbers or URLs with tokens; the sanitized record already drops them.
- **No note or email.** Rejected. The person's description is often the only way to tell what they saw, and an email is the only way to answer. Both are optional, masked or bounded, and kept for a year.
- **Persist the diagnostic with the run.** Deferred. Keeping it in memory means a report after a restart arrives without a diagnostic, but nothing new is written to disk.

## Consequences

- The receiver now stores individual rows that can hold personal data (an email, a note), unlike ADR 0078's daily totals. The one-year retention, the Access-protected dashboard and the masking bound that.
- `PRODUCT.md`, `CONTEXT.md` (**Error report**) and the READMEs say the App sends something only through usage statistics or an Error report the person sends.
- Reports are unauthenticated like pings. A forged report can only add a row the daily cap and rate limit bound; it cannot reach the person who failed.
- Adding a field to the diagnostic or the payload needs an amendment here and a matching change to the receiver's validation.
