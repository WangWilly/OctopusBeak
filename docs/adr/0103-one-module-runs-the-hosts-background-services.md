# One module runs the host's background services

Status: accepted

Keeps the runner and its recovery in Electron main, as [ADR 0052](0052-active-automation-task-run-owns-run-lifecycle.md) decided. Concerns the services added by [ADR 0045](0045-scheduled-collection.md), [ADR 0078](0078-opt-in-anonymous-daily-usage-ping.md) and [ADR 0083](0083-automatic-updates-from-github-releases.md).

Electron main held each background service in a module-level variable: the exchange-rate schedule, the collection schedule, the usage ping and app updates, plus the browser-state and run-event cleanups. Each service was written in four places in `main.ts`: built in `start()`, started once recovery was ready, told about settings changes, and stopped on quit. Which services a fixture or an unpackaged build runs was decided by `if` blocks around those places. The only checks were regular expressions over the source of `main.ts`, which pinned the statements rather than the behaviour. A quit while recovery was still running stopped the services, and recovery then started them again.

**`electron/host-services.ts` runs the background services.** Main builds each service and hands it to `createHostServices` with what this launch runs: schedules unless a fixture is running, and the usage ping only in a packaged app. The module starts them once recovery's readiness resolves, passes each settings change to every service, pauses and resumes the schedules, and stops them all on quit.

**Once stopped, nothing starts.** If the person quits before recovery finishes, the services stay stopped when it does.

**The lifecycle is checked through the module.** `host-services.check.ts` drives fake services: nothing starts before recovery or after a failed one, a fixture launch runs no schedules, a settings change reaches every service, pause resumes only what was running, and stop ends everything once. The checks over `main.ts` keep only where main hands over readiness, settings and the quit.

## Considered options

- **Let the module build the services too.** Rejected. Each service already has its own checks, and building them needs timers, the settings file and network calls. The lifecycle between them was what had no check.
- **Move the whole quit sequence into the module.** Rejected. Closing IPC, the desktop service and the runner are not background services, and the database close already lives in `automation-shutdown.ts`.

## Consequences

- A new background service is added to `createHostServices` and gets its start, settings and stop there, with a behaviour check.
- Main builds the schedules in every launch. A fixture launch builds them but never starts them.
- Seeding the disposable CDP fixture lives in `electron/cdp-runtime-fixture.ts`, outside `main.ts`.
