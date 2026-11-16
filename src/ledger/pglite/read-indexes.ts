import type { PGliteStore } from "./transaction.ts";

/**
 * Indexes a page read needs that the baseline does not carry. Each statement
 * is safe to repeat, so the step runs on every open and an older store gains
 * the index without a baseline change.
 */
const READ_INDEXES = [
  // The 0.1% of assertions that select a transaction revision: a page reads
  // each transaction's lifecycle from them, and without this it scans them all.
  "CREATE INDEX IF NOT EXISTS idx_assertions_revision ON assertions (revision_id) WHERE revision_id IS NOT NULL",
] as const;

export async function applyPgliteReadIndexes(store: PGliteStore): Promise<void> {
  for (const statement of READ_INDEXES) await store.exec(statement);
}
