import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

type KnowledgePointReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

/** The latest canonical commit sequence: the canonical knowledge point every Financial read is versioned by. */
export async function readKnowledgePoint(reader: KnowledgePointReader): Promise<number> {
  const result = await reader.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits");
  const value = Number(result.rows[0]?.value ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Canonical knowledge point is invalid.");
  return value;
}
