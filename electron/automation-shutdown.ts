/** Settles when `work` settles or `ms` passes, whichever is first; never rejects. */
function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(() => {}, () => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function createBeforeQuitHandler(options: {
  cleanup(): Promise<void>;
  /** How long the ledger close waits for cleanup's final automation writes. */
  cleanupWaitMs: number;
  closeDatabase(): Promise<void>;
  /** How long, from before-quit, the quit waits for the ledger close. */
  closeDatabaseDeadlineMs: number;
  quit(): void;
}) {
  let quittingAllowed = false;
  let cleanupStarted = false;

  return (event: { preventDefault(): void }) => {
    if (quittingAllowed) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;

    // Child trees are terminated best-effort by the cleanup hook. Closing the
    // app must never wait for a browser daemon or a stuck child process.
    const cleanup = Promise.resolve().then(options.cleanup);
    // The ledger close is different: exiting before PGlite's shutdown
    // checkpoint finishes makes the next launch replay the WAL first. Close
    // after cleanup has persisted the runs' outcome, and wait for it, each
    // only up to its bound.
    const closed = settleWithin(cleanup, options.cleanupWaitMs).then(options.closeDatabase);
    void settleWithin(closed, options.closeDatabaseDeadlineMs).then(() => {
      quittingAllowed = true;
      // Electron resets its quitting state when this prevented quit returns,
      // so a nested quit is lost whenever the window closes after this handler.
      setImmediate(options.quit);
    });
  };
}

/**
 * Playwright adds SIGINT, SIGTERM and SIGHUP listeners while it owns a browser
 * in this process. Its SIGTERM and SIGHUP listeners close the browser but never
 * exit, and any listener disables Node's default exit, so the App turns all
 * three signals into a quit.
 */
export function quitOnTerminationSignals(
  target: Pick<NodeJS.Process, "on">,
  quit: () => void,
) {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    target.on(signal, quit);
  }
}
