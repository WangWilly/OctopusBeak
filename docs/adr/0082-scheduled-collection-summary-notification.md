# Every scheduled collection ends with one summary notification

Status: accepted

Supersedes the notification rules of [ADR 0045](0045-scheduled-collection.md): "Only User-action Failures raise an operating-system notification" and the rejected option "Notify on every failure". The rest of ADR 0045 stands.

ADR 0045 kept transient failures in run history so notifications would stay rare. A person who never opens the App then never learns that a source has stopped syncing, and a day where every source synced looks the same as a day where the schedule never ran.

## Decision

**A Scheduled Collection occurrence sends exactly one operating-system notification, after every source it started has ended.**

- **Which sources.** Every source the occurrence started, plus any source it could not start. A source already running from a manual sync when the occurrence fires is not part of it. An occurrence with no due source sends nothing. Exchange rates have their own schedule and never notify.
- **What it says.** A run counts as synced only when it completed; a partial, failed, cancelled, or unfinalized run did not sync.
  - Every source synced: "Automatic sync finished" with the count. A click opens the Overview.
  - Some sources did not sync and none needs the person: the title counts them, the body names up to three and says the next automatic sync tries again. A click opens the Automation page.
  - Any source ended with a User-action Failure: "Automatic sync needs you". One such source is named with its action; a click opens its sign-in settings, or Settings for Delete all financial data. Several are named together and a click opens the Automation page. Sources that only failed transiently are counted after them.
- **What it never says.** Like every notification, it carries source names and actions only, never an amount, an account, or a source error message, because notifications appear on the lock screen and in Notification Center history.
- **Manual syncs** still send no notification.

## Considered options

- **Keep ADR 0045's rule.** Rejected. A source that fails transiently every day stays silent until the person opens the App.
- **One notification per source.** Rejected. A bad day would raise several notifications at once; one summary per day stays rare enough not to be ignored.
- **Notify only on failure.** Rejected. A daily confirmation tells the person the schedule is working.
- **Notify when a source has not synced for several days.** Deferred.

## Consequences

- A person with Scheduled Collection on gets one notification every day the App is open at the scheduled time.
- The runner reports a run whose record could not be finalized (`onSettled` with `null`), so a summary is never held back by one source.
- The renderer follows a notification's destination (Overview, Automation with an optional source, or Settings) instead of only sign-in settings.
