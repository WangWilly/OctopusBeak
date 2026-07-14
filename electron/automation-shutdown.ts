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

    let timer: NodeJS.Timeout | number | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = timerDeps.setTimer(resolve, options.timeoutMs);
    });
    void Promise.race([options.cleanup(), deadline]).finally(() => {
      if (timer !== undefined) timerDeps.clearTimer(timer);
      quittingAllowed = true;
      options.quit();
    });
  };
}
