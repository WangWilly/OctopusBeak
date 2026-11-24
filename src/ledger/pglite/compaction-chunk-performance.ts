/**
 * How long one chunk of the ledger compaction job holds the ledger (ADR
 * 0154). A sync, a commit or a page read waits behind a running chunk, so no
 * chunk may take long, whatever it removes.
 *
 *   npm run check:pglite-compaction-chunks
 *
 * The store is the compaction checks' old-shaped store with one more chain:
 * PGLITE_COMPACTION_CITED_COPIES records (default 8000), each cited, so the
 * compaction keeps them all, among PGLITE_COMPACTION_OTHER_RECORDS records
 * (default 30000) of many other subjects. A chunk classifies its chain's
 * copies against the rows that cite them. Planned as one query, that scanned
 * every citation again for each copy, and this chunk took about 16 s for
 * 8000 copies and four times as long for twice as many. It fails when the
 * longest chunk takes more than PGLITE_COMPACTION_CHUNK_BUDGET_MS (default
 * 4000).
 */
import { addCitedChain, legacyStore } from "./compaction-fixtures.ts";
import { runLedgerCompaction } from "./compaction-job.ts";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const CITED_COPIES = positiveInteger("PGLITE_COMPACTION_CITED_COPIES", 8000);
const OTHER_RECORDS = positiveInteger("PGLITE_COMPACTION_OTHER_RECORDS", 30_000);
const CHUNK_BUDGET_MS = positiveInteger("PGLITE_COMPACTION_CHUNK_BUDGET_MS", 4000);

const { store } = await legacyStore();
try {
  const kind = await addCitedChain(store, { copies: CITED_COPIES, others: OTHER_RECORDS });
  const result = await runLedgerCompaction(store);
  const { rows: [kept] } = await store.query<{ copies: number }>(
    "SELECT count(*)::int AS copies FROM source_records WHERE record_kind = $1", [kind]);
  const ran = result.status === "compacted";
  console.log(JSON.stringify({
    citedCopies: CITED_COPIES,
    otherRecords: OTHER_RECORDS,
    status: result.status,
    chunks: ran ? result.chunks : null,
    longestChunkMs: ran ? result.longestChunkMs : null,
    chunkBudgetMs: CHUNK_BUDGET_MS,
    citedCopiesKept: kept!.copies,
  }, null, 2));
  if (!ran || kept!.copies !== CITED_COPIES) {
    console.error("The compaction did not complete, or removed a cited copy.");
    process.exitCode = 1;
  } else if (result.longestChunkMs > CHUNK_BUDGET_MS) {
    console.error(`A compaction chunk held the ledger for ${result.longestChunkMs} ms, over the ${CHUNK_BUDGET_MS} ms budget (ADR 0154).`);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
