/** App-wide FIFO admission. A slot covers the entire run, including verification
 * and CAPTCHA retries, so every entry point shares the same resource bound. */
export function createWorkflowRunQueue(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Invalid workflow concurrency limit.");
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    enter(signal: AbortSignal): { queued: boolean; ready: Promise<() => void> } {
      signal.throwIfAborted();
      const queued = active >= limit;
      const ready = new Promise<() => void>((resolve, reject) => {
        const admit = () => {
          signal.removeEventListener("abort", cancel);
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.();
          });
        };
        const cancel = () => {
          const index = waiting.indexOf(admit);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason ?? new Error("Workflow queue cancelled."));
        };
        if (queued) {
          waiting.push(admit);
          signal.addEventListener("abort", cancel, { once: true });
        } else admit();
      });
      return { queued, ready };
    },
  };
}

export const APP_WORKFLOW_CONCURRENCY = 3;
