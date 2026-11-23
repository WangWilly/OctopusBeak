# Schedules read the clock after sleep

Status: accepted

Amends [ADR 0045](./0045-scheduled-collection.md), and the exchange-rate catch-up of [ADR 0032](./0032-app-owned-workflow-runtime.md), which now also happens on waking.

The exchange-rate and Scheduled Collection schedulers each armed one timer for the time until their next occurrence. On macOS, timers count only time the Mac is awake. Suppose the Mac sleeps through 07:00. The timer then fires once the remaining awake time has passed, which can be hours later or the next afternoon. The configured time is ignored.

A launch also always caught up the latest missed occurrence. If yesterday's 07:00 was missed and the App opened at 06:00, Scheduled Collection signed in to every source at 06:00 and again at 07:00.

**Schedules read the wall clock again whenever it may have moved.**

- No timer waits longer than an hour (`MAX_TIMER_MS`). Every timer fire reads the clock once and acts as a wake does. A Mac that sleeps through an occurrence therefore runs it within an hour of waking, even when no wake event arrives. A timer that fires days late runs only the latest occurrence, never the one it was armed for.
- Electron's `powerMonitor` `resume` and `unlock-screen` events wake both schedulers. A woken scheduler behaves as a launch would:
  - it runs the latest occurrence if that occurrence passed while the Mac slept;
  - it arms the next occurrence from the real time.
- Each occurrence still runs at most once. The scheduler remembers the occurrence it last considered, and each source keeps its own record of an attempted occurrence.

**Scheduled Collection does not catch up when the next run is close.** A launch or a wake skips the missed occurrence when the next one is due within three hours (`COLLECTION_CATCH_UP_GRACE_MS`), so it does not repeat every sign-in within that window. Exchange rates sign in nowhere, so they keep catching up at once.

## Considered options

- **Rely on the wake events alone.** Rejected. They cover sleep but not a clock that moves for another reason, such as a manual change or a time-zone change while awake. The hour cap bounds every case.
- **Poll every minute.** Rejected. An hour bounds the drift well enough, and a scheduled run can start up to an hour late only when no wake event arrived.
- **Always skip the catch-up.** Rejected. A Mac closed overnight would then never collect the morning it missed until the next day.

## Consequences

- A launch or wake within three hours before the scheduled time leaves yesterday's missed collection to today's run. That run collects the same window.
- A Mac that wakes after an occurrence it slept through, with nothing missed before it, runs that occurrence on waking, not at the configured time. This matches a launch after the App was closed.
- A catch-up skipped for the grace is not remembered. If the person then moves the scheduled time to one that already passed today, nothing runs until that time tomorrow.
