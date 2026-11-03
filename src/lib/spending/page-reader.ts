import type { SpendingPageReadResult } from "./model.ts";

/**
 * Coordinate all page reads through one seam. A stale version is blocked before
 * refreshing, so concurrent readers share recovery and cannot retry it. A live
 * publication can supersede both pending reads and recovery without a timer.
 */
export function createSpendingPageReader(refreshSummary: () => Promise<void>) {
  let observedVersion = -1;
  let blockedVersion = -1;
  let recovery: Promise<void> | null = null;
  return {
    observe(version: number) { observedVersion = Math.max(observedVersion, version); },
    async read<T extends object>(version: number, request: () => Promise<SpendingPageReadResult<T>>): Promise<T | null> {
      if (version <= blockedVersion || version < observedVersion) return null;
      const result = await request();
      if (version < observedVersion) return null;
      if ("stale" in result && result.stale === true) {
        blockedVersion = Math.max(blockedVersion, version, result.knowledgeAt - 1);
        if (!recovery) {
          recovery = Promise.resolve().then(refreshSummary).finally(() => { recovery = null; });
        }
        await recovery;
        return null;
      }
      return result as T;
    },
  };
}
