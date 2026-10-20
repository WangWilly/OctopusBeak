import { randomUUID } from "node:crypto";
import type { PGliteTransaction } from "./transaction.ts";

export type PGliteCanonicalCommitKind =
  | "source_capture"
  | "user_assertion"
  | "derived_import"
  | "relation_resolution";

/** How a commit's recorded time is chosen. Ordering always comes from commit_sequence. */
export type PGliteCanonicalCommitTime =
  /** A person's action, shown back to them as when it was decided. */
  | Readonly<{ kind: "wall-clock" }>
  /** Derived data, recorded immediately after the latest commit. */
  | Readonly<{ kind: "after-latest" }>
  /** A requested or clocked time, never earlier than the latest commit. */
  | Readonly<{ kind: "requested"; recordedAtUtcUs?: number; clock?: () => number }>;

export type PGliteCanonicalCommitRef = Readonly<{
  id: Uint8Array;
  sequence: number;
  recordedAtUtcUs: number;
}>;

/** Allocate the next canonical commit inside the writer's transaction. */
export async function insertPGliteCanonicalCommit(
  transaction: PGliteTransaction,
  commit: Readonly<{
    kind: PGliteCanonicalCommitKind;
    authorityRoute: string;
    time: PGliteCanonicalCommitTime;
  }>,
): Promise<PGliteCanonicalCommitRef> {
  const latest = (await transaction.query<{ sequence: number | string; recorded_at_utc_us: number | string | null }>(
    `SELECT COALESCE(MAX(commit_sequence), 0) AS sequence,
            MAX(recorded_at_utc_us) AS recorded_at_utc_us
       FROM canonical_commits`,
  )).rows[0];
  const sequence = Number(latest?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("Canonical commit sequence is not a safe integer.");
  const latestRecordedAt = latest?.recorded_at_utc_us === null || latest?.recorded_at_utc_us === undefined
    ? null
    : Number(latest.recorded_at_utc_us);
  const recordedAtUtcUs = recordedTime(commit.time, latestRecordedAt);
  const id = Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
  await transaction.query(
    `INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, sequence, recordedAtUtcUs, commit.authorityRoute, commit.kind],
  );
  return { id, sequence, recordedAtUtcUs };
}

function recordedTime(time: PGliteCanonicalCommitTime, latest: number | null): number {
  switch (time.kind) {
    case "wall-clock":
      return Date.now() * 1000;
    case "after-latest":
      return (latest ?? 0) + 1;
    case "requested": {
      const candidate = time.recordedAtUtcUs ?? time.clock?.() ?? Date.now() * 1000;
      if (!Number.isSafeInteger(candidate) || candidate < 0)
        throw new Error("Canonical PGlite commit clock returned an invalid timestamp.");
      return latest === null ? candidate : Math.max(candidate, latest + 1);
    }
  }
}
