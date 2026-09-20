export function createBeforeQuitHandler(options: {
  cleanup(): Promise<void>;
  quit(): void;
  timeoutMs: number;
}, timerDeps: {
  setTimer(callback: () => void, ms: number): NodeJS.Timeout | number;
  clearTimer(timer: NodeJS.Timeout | number): void;
} = {
  setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimer: (timer: NodeJS.Timeout | number) => clearTimeout(timer as NodeJS.Timeout),
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
