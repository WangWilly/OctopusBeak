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
    options.quit();
  };
}
