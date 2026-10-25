import type { DataVersionStore } from "../shared-shell/data-version.ts";

export type CollectionControl = Readonly<{
  /** Stops scheduled collection and returns its resume. */
  pauseSchedules(): () => void;
  /** Cancels every run, waits until each is terminal, and runs `work` before any new run starts. */
  whileStopped<T>(work: () => Promise<T>): Promise<T>;
}>;

async function withCollectionStopped(collection: CollectionControl, work: () => Promise<void>) {
  const resume = collection.pauseSchedules();
  try {
    await collection.whileStopped(work);
  } finally {
    resume();
  }
}

/** Canonical Reset from Settings. No collection starts afterwards. */
export function deleteAllFinancialData(
  collection: CollectionControl,
  financial: Readonly<{ reset(): Promise<void> }>,
  versions: Pick<DataVersionStore, "markStale">,
) {
  return withCollectionStopped(collection, async () => {
    await financial.reset();
    versions.markStale("financial-data-deleted");
  });
}

/** Sign-in Erasure from Settings. */
export function clearAllSignInData(
  collection: CollectionControl,
  signIn: Readonly<{ cancelRegistrations(): Promise<unknown>; erase(): void; refresh(): Promise<unknown> }>,
  versions: Pick<DataVersionStore, "markStale">,
) {
  return withCollectionStopped(collection, async () => {
    // A registration still in progress would write its trusted device back.
    await signIn.cancelRegistrations();
    signIn.erase();
    await signIn.refresh();
    versions.markStale("sign-in-data-cleared");
  });
}
