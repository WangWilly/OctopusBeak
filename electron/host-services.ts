/**
 * The host's background services: the two daily schedules, the usage
 * statistics ping and app updates, plus the cleanups that run beside them.
 * Main builds each one; this module decides when they start, passes them
 * settings, pauses the schedules and stops everything (ADR 0103).
 */

export type HostSchedule = Readonly<{
  start(): void;
  stop(): void;
  reschedule(): void;
  /** Stops until the returned resume, which restarts only a schedule that was running. */
  pause(): () => void;
}>;

export type HostUsagePing = Readonly<{ start(): void; stop(): void; check(): unknown }>;

export type HostAppUpdates = Readonly<{
  start(): void;
  stop(): void;
  applySettings(settings: Readonly<{ enabled: boolean; autoDownload: boolean }>): void;
}>;

/** The system settings the services read when they change. */
export type HostServiceSettings = Readonly<{ appUpdatesEnabled: boolean; appUpdatesAutoDownload: boolean }>;

export type HostServiceDependencies = Readonly<{
  exchangeRates: HostSchedule;
  collection: HostSchedule;
  usagePing: HostUsagePing;
  appUpdates: HostAppUpdates;
  /** What this launch runs: fixtures run no schedules, and only a packaged app pings. */
  run: Readonly<{ schedules: boolean; usagePing: boolean }>;
  /** Work that starts once the runtime has recovered; each start returns its stop. */
  startAfterReady: readonly (() => () => void)[];
  /** Stops for work main started before recovery, called on stop with the rest. */
  stopOnQuit: readonly (() => void)[];
}>;

export type HostServices = Readonly<{
  /**
   * Start the services once `ready` resolves, after recovery has reconciled the
   * persisted active run. Nothing starts if `ready` rejects or `stop` came first.
   */
  startWhenReady(ready: Promise<unknown>): void;
  settingsChanged(settings: HostServiceSettings): void;
  /** Pause both schedules; the returned resume restarts the ones that were running. */
  pauseSchedules(): () => void;
  /** Stop every service and cleanup. Safe before, during or after start. */
  stop(): void;
}>;

export function createHostServices(deps: HostServiceDependencies): HostServices {
  let stopped = false;
  const startedStops: (() => void)[] = [];

  const start = () => {
    if (stopped) return;
    for (const startCleanup of deps.startAfterReady) startedStops.push(startCleanup());
    if (deps.run.schedules) {
      deps.exchangeRates.start();
      deps.collection.start();
    }
    if (deps.run.usagePing) deps.usagePing.start();
    deps.appUpdates.start();
  };

  return Object.freeze({
    startWhenReady(ready) {
      void ready.then(start, () => {
        // A failed recovery is reported as a fatal runtime error by its owner; nothing starts.
      });
    },
    settingsChanged(settings) {
      deps.exchangeRates.reschedule();
      deps.collection.reschedule();
      void deps.usagePing.check();
      deps.appUpdates.applySettings({ enabled: settings.appUpdatesEnabled, autoDownload: settings.appUpdatesAutoDownload });
    },
    pauseSchedules() {
      const resumes = [deps.exchangeRates.pause(), deps.collection.pause()];
      return () => {
        for (const resume of resumes) resume();
      };
    },
    stop() {
      stopped = true;
      deps.exchangeRates.stop();
      deps.collection.stop();
      deps.usagePing.stop();
      deps.appUpdates.stop();
      for (const stopCleanup of deps.stopOnQuit) stopCleanup();
      for (const stopCleanup of startedStops.splice(0)) stopCleanup();
    },
  });
}
