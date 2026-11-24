/**
 * How long one chunk of the ledger compaction job holds the ledger (ADR
 * 0154). A sync, a commit or a page read waits behind a running chunk, so no
 * chunk may take long, whatever it removes.
 *
 *   npm run check:pglite-compaction-chunks
 *
 * The store is the compaction checks' old-shaped store with two more chains,
 * among PGLITE_COMPACTION_OTHER_RECORDS records (default 30000) of many
 * other subjects:
 *
 * - PGLITE_COMPACTION_CITED_COPIES records (default 8000), each cited, so
 *   the compaction keeps them all. A chunk classifies its chain's copies
 *   against the rows that cite them. Planned as one query, that scanned
 *   every citation again for each copy, and this chunk took about 16 s for
 *   8000 copies and four times as long for twice as many.
 * - PGLITE_COMPACTION_HISTORY_CAPTURES captures (default 1200) of one chain,
 *   each with 50 records only it saw, of which eight hold a copy of one
 *   record. The chunk removes seven copies. Its readers read the records it
 *   removes a copy of and the captures that own one; read for the whole
 *   chain and every capture that holds it, they took most of the chunk,
 *   which then took about 4.5 s. It takes about 0.8 s.
 *
 * - PGLITE_COMPACTION_LISTING_CAPTURES captures (default 400), each with a
 *   manifest that lists 1000 records, as captures have once they reuse what
 *   an earlier one stored. Every chunk reads every manifest to find the ones
 *   that list a copy of its own, twice when it removes something. With each
 *   listed id read from the stored column on its own, the two reads took
 *   about 1.4 s in every chunk that removes a copy.
 *
 * It fails when the longest chunk takes more than
 * PGLITE_COMPACTION_CHUNK_BUDGET_MS (default 2000), which the chunks of
 * the whole-chain readers exceed. `compaction.check.ts`
 * counts the rows a chunk's readers read, which does not depend on timing.
 */
import { addCaptureChain, addCitedChain, addListingCaptures, legacyStore } from "./compaction-fixtures.ts";
import { runLedgerCompaction } from "./compaction-job.ts";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const CITED_COPIES = positiveInteger("PGLITE_COMPACTION_CITED_COPIES", 8000);
const OTHER_RECORDS = positiveInteger("PGLITE_COMPACTION_OTHER_RECORDS", 30_000);
const HISTORY_CAPTURES = positiveInteger("PGLITE_COMPACTION_HISTORY_CAPTURES", 1200);
const LISTING_CAPTURES = positiveInteger("PGLITE_COMPACTION_LISTING_CAPTURES", 400);
/** The records each listing capture's manifest lists: long enough to be stored out of line. */
const LISTED_RECORDS = 1000;
const CHUNK_BUDGET_MS = positiveInteger("PGLITE_COMPACTION_CHUNK_BUDGET_MS", 2000);
/** The copies the history chain's chunk removes: one record's copies after the first, in eight captures. */
const HISTORY_REMOVED = 7;

const { store } = await legacyStore();
try {
  const kind = await addCitedChain(store, { copies: CITED_COPIES, others: OTHER_RECORDS });
  const history = await addCaptureChain(store, { name: "history", captures: HISTORY_CAPTURES, fresh: 50, steady: 1, steadyCaptures: HISTORY_REMOVED + 1 });
  await addListingCaptures(store, { captures: LISTING_CAPTURES, records: LISTED_RECORDS });
  const copies = async (recordKind: string) =>
    (await store.query<{ copies: number }>("SELECT count(*)::int AS copies FROM source_records WHERE record_kind = $1", [recordKind])).rows[0]!.copies;
  const historyBefore = await copies(history);
  const result = await runLedgerCompaction(store);
  const kept = await copies(kind);
  const historyRemoved = historyBefore - await copies(history);
  const ran = result.status === "compacted";
  console.log(JSON.stringify({
    citedCopies: CITED_COPIES,
    otherRecords: OTHER_RECORDS,
    historyCaptures: HISTORY_CAPTURES,
    listedRecords: LISTING_CAPTURES * LISTED_RECORDS,
    status: result.status,
    chunks: ran ? result.chunks : null,
    longestChunkMs: ran ? result.longestChunkMs : null,
    chunkBudgetMs: CHUNK_BUDGET_MS,
    citedCopiesKept: kept,
    historyCopiesRemoved: historyRemoved,
  }, null, 2));
  if (!ran || kept !== CITED_COPIES || historyRemoved !== HISTORY_REMOVED) {
    console.error("The compaction did not complete, removed a cited copy, or did not remove the history chain's repeated copies.");
    process.exitCode = 1;
  } else if (result.longestChunkMs > CHUNK_BUDGET_MS) {
    console.error(`A compaction chunk held the ledger for ${result.longestChunkMs} ms, over the ${CHUNK_BUDGET_MS} ms budget (ADR 0154).`);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
