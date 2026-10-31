# Scheduled collection runs every enabled source once a day and never waits for a person

Status: accepted; notification rules superseded by [ADR 0082](0082-one-summary-notification-per-sync.md)

## Decision

The App gains Scheduled Collection: one daily time, shared by every enabled source, at which the App enqueues those sources into the existing Sync all FIFO queue (concurrency 3, ADR 0032). It follows ADR 0032's schedule rules: nothing runs while the App is closed, and at most one missed occurrence is caught up on launch. It does not start until Collection Scope Version revalidation before admission is implemented, because background runs make edits during a run common.

A scheduled run never waits for a person. A source that needs a one-time code or an untrusted device fails with an actionable reason that links to its sign-in settings, where the person completes Source Device Registration ([ADR 0041](0041-tdcc-epassbook-app-protocol-source.md)); this keeps [ADR 0039](0039-solver-only-verification.md) intact. A scheduled run may confirm a provider's duplicate-login takeover prompt, as manual runs already do for SinoPac, even though that signs the person out of the provider's phone App or website. Sign-in settings disclose that takeover for each source that does it.

Only User-action Failures raise an operating-system notification: untrusted device, rejected sign-in details, account restriction, and an outdated provider protocol. Transient failures stay in run history.

## Considered options

- **Manual collection only.** Rejected. Collection that depends on the person remembering to open the App defeats the automation.
- **Per-source schedules.** Rejected. Separate times add settings with little value for one person's handful of sources.
- **Prompt for a one-time code inside a scheduled run.** Rejected. It breaks ADR 0039, and nobody is watching a scheduled run.
- **Never confirm a takeover prompt on a scheduled run.** Rejected. Every such source would then fail daily, which is worse than a disclosed sign-out.
- **Notify on every failure.** Rejected. Transient failures would train the person to ignore notifications.

## Consequences

- A person who uses a takeover source's phone App will be signed out of it once a day.
- Daily automated sign-ins with solver-backed CAPTCHAs may draw a bank's risk controls. The daily cadence and the bounded CAPTCHA campaign of [ADR 0046](0046-in-page-captcha-refresh.md) limit the exposure.
