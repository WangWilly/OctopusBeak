# Every sync ends with one summary notification

Status: accepted

Supersedes the notification rules of [ADR 0045](0045-scheduled-collection.md): "Only User-action Failures raise an operating-system notification" and the rejected option "Notify on every failure". The rest of ADR 0045 stands.

ADR 0045 kept transient failures in run history so notifications would stay rare. A person who never opens the App then never learns that a source has stopped syncing, a day where every source synced looks the same as a day where the schedule never ran, and a person who starts Sync all and switches to another App has to keep checking back.

## Decision

**Every sync batch sends exactly one operating-system notification, after every source it started has ended.** A batch is one Scheduled Collection occurrence, or one sync the person starts: a single source, Sync all, or Collect all sources in Settings.

- **Which sources.** Every source the batch started, plus any source it could not start. A source already running from another batch belongs to that batch. A batch with no source sends nothing; exchange rates are not a source and never notify.
- **When.** A Scheduled Collection occurrence always notifies. A sync the person started notifies only when no App window is focused when it ends, because a person watching the App already sees the result.
- **What it says.** A run counts as synced only when it completed; a partial, failed, cancelled, or unfinalized run did not sync. Titles say "Automatic sync" for Scheduled Collection and "Sync" for a sync the person started.
  - Every source synced: "… finished" with the count. A click opens the Overview.
  - Some sources did not sync and none needs the person: the title counts them and the body names up to three. A scheduled body says the next automatic sync tries again; a manual body points to run history. A click opens the Automation page.
  - Any source ended with a User-action Failure: "… needs you". One such source is named with its action; a click opens its sign-in settings, or Settings for Delete all financial data. Several are named together and a click opens the Automation page. Sources that only failed transiently are counted after them.
- **What it never says.** A notification carries source names and actions only, never an amount, an account, or a source error message, because notifications appear on the lock screen and in Notification Center history.

## Considered options

- **Keep ADR 0045's rule.** Rejected. A source that fails transiently every day stays silent until the person opens the App.
- **One notification per source.** Rejected. A bad day would raise several notifications at once; one summary per batch stays rare enough not to be ignored.
- **Notify only on failure.** Rejected. A daily confirmation tells the person the schedule is working.
- **Notify a manual sync while the App is focused.** Rejected. The Automation page already shows the same result.
- **Notify when a source has not synced for several days.** Deferred.

## Consequences

- A person with Scheduled Collection on gets one notification every day the App is open at the scheduled time.
- The runner reports a run whose record could not be finalized (`onSettled` with `null`), so a summary is never held back by one source.
- The renderer follows a notification's destination (Overview, Automation with an optional source, or Settings) instead of only sign-in settings.
