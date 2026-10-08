export function createBeforeQuitHandler(options: {
  cleanup(): Promise<void>;
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
    void options.cleanup().catch(() => {});
    quittingAllowed = true;
    // Electron resets its quitting state when this prevented quit returns, so
    // a nested quit is lost whenever the window closes after this handler.
    setImmediate(options.quit);
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
