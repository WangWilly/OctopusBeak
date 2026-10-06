import type { CurrentProjectionStateDto } from "./types.ts";

/**
 * No account has arrived yet: either nothing is configured ("empty") or
 * configured sources have not collected ("awaiting"). A failed read
 * ("unavailable") is a different story and keeps its own notice.
 */
export function awaitingFirstData(projection: Readonly<{
  availability: CurrentProjectionStateDto["availability"];
  accounts: readonly unknown[];
}>): boolean {
  return projection.availability !== "unavailable" && projection.accounts.length === 0;
}
