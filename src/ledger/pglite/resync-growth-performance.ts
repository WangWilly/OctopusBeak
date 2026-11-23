/**
 * How much the canonical store grows when a source is synced again with
 * nothing new (ADR 0152). It commits the same records repeatedly, each time
 * under a new capture id and a window that ends a day later, as a collection
 * window does. It fails when any table gains rows in proportion to the
 * records re-sighted rather than a fixed number per capture.
 *
 *   npm run check:pglite-resync-growth
 *
 * PGLITE_RESYNC_RECORDS (default 200) and PGLITE_RESYNC_SYNCS (default 10)
 * size the run; PGLITE_RESYNC_MODE is `deposit`, `card-route` or `both`.
 * Both modes go through the generic commit; `card-route` uses a credit-card
 * route and bucket coverage but not the credit-card command, whose own rows
 * a later step measures.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { assignOccurrenceSlots } from "../canonical/occurrence-groups.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import { installFinancialStore } from "./store-layout.ts";
import type { PGliteStore } from "./transaction.ts";

type Mode = "deposit" | "card-route";

function positiveInteger(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

const RECORDS = positiveInteger("PGLITE_RESYNC_RECORDS", 200, 20);
const SYNCS = positiveInteger("PGLITE_RESYNC_SYNCS", 10, 2);
const MODES: readonly Mode[] = (() => {
  const mode = process.env.PGLITE_RESYNC_MODE ?? "both";
  if (mode === "both") return ["deposit", "card-route"];
  if (mode === "deposit" || mode === "card-route") return [mode];
  throw new Error("PGLITE_RESYNC_MODE must be deposit, card-route or both.");
})();

/**
 * Rows a table may gain per unchanged re-sync. A capture itself, its scope,
 * pages, coverage and a reuse manifest are a few rows each; anything more
 * grows with the records the sync saw again.
 */
const ROWS_PER_RESYNC_BUDGET = 8;

/**
 * Bytes an unchanged re-sync may add per record seen again: a reused record
 * costs about 16 bytes in its capture's manifest, and a capture's own rows
 * are spread over its records. Storing each record again cost about 3,900.
 */
const BYTES_PER_RECORD_BUDGET = 256;

const token = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);

/** One complete bounded capture of `RECORDS` synthetic rows; sync `sync` ends its window that many days later. */
function capture(mode: Mode, sync: number): PGliteCanonicalFinancialCommitRequest {
  const captureId = `${mode}-capture-${sync}`;
  const endDate = day(180 + sync);
  const card = mode === "card-route";
  const scopeKey = token("scope");
  const routeKey = card ? "fubon/credit-card/human-attested-v2" : "fubon/domestic-deposit/human-attested-v1";
  const contractVersion = card ? routeKey : "human-attested-v1";
  // Every tenth row repeats the one before it, so some occurrence groups have two members.
  const rows = Array.from({ length: RECORDS }, (_, index) => ({
    index,
    date: day((index % 10 === 9 ? index - 1 : index) % 180),
    fingerprint: token(`row-${index % 10 === 9 ? index - 1 : index}`),
    bucketKey: card ? `2026-${String(1 + Math.floor((index % 180) / 30)).padStart(2, "0")}` : undefined,
  }));
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => row.fingerprint,
    partitionDate: (row) => row.date,
  });
  const records = slots.map(({ row, occurrenceKey, collisionKey, group }) => ({
    occurrenceKey,
    collisionKey,
    sequenceLexeme: `${row.date}/${row.fingerprint}/${group.ordinal}`,
    providerKey: "human-attested:no-provider-key",
    contentHash: token(JSON.stringify([row.date, row.fingerprint])),
    compact: {
      amount: { coefficient: String(1000 + row.index), scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postedOn: row.date,
      description: `SYNTHETIC MERCHANT ${row.index}`,
      balance: { coefficient: String(500_000 - row.index), scale: 0 },
    },
    occurrenceGroup: group,
    ...(row.bucketKey === undefined ? {} : { occurrenceGroupBucketKey: row.bucketKey }),
  }));
  const bucketKeys = card ? [...new Set(rows.map((row) => row.bucketKey!))] : undefined;
  return {
    capture: {
      captureId,
      integrationNamespace: "fubon",
      sourceConnectionKey: token("connection"),
      identityEpoch: token("epoch"),
      stream: card ? "credit-card" : "domestic-deposit",
      recordKind: card ? "fubon-credit-card-transaction" : "fubon-domestic-deposit",
      routeKey,
      contractVersion,
      subjectDigest: token("subject"),
      observedAt: "2026-09-30T00:00:00.000Z",
      accountNumber: {
        value: "123456",
        kind: card ? "credit-portfolio-account" : "depository-account",
        evidenceVersion: "synthetic-v1",
        sourceField: "accountNumber",
      },
      scope: {
        startDate: "2026-01-01",
        endDate,
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: "full-bounded-range",
        ruleVersion: routeKey,
        sourceAccountKey: "checking-account",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { pageCount: 1 } }],
      records,
      occurrenceGroupCoverage: [{
        scopeKey,
        startDate: "2026-01-01",
        endDate,
        contractVersion,
        ...(bucketKeys ? { bucketKeys } : {}),
      }],
    },
    account: {
      sourceAccountKey: "checking-account",
      accountNo: "123456",
      accountType: card ? "credit" : "depository",
      currency: "TWD",
    },
    transactions: slots.map(({ row, occurrenceKey, group }) => ({
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: `${row.date}-${row.fingerprint}-${group.ordinal}`,
      amount: { coefficient: String(1000 + row.index), scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: routeKey,
      description: `SYNTHETIC MERCHANT ${row.index}`,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: routeKey,
      effectiveOn: row.date,
      transactionDateTimeLocal: `${row.date}T00:00:00+08:00`,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: routeKey,
      utcInstantUtcUs: Date.parse(`${row.date}T00:00:00.000+08:00`) * 1000,
    })),
    withdrawalPolicy: "never-infer",
  };
}

async function rowCounts(store: PGliteStore): Promise<Map<string, number>> {
  const tables = await store.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  const counts = new Map<string, number>();
  for (const { name } of tables.rows) {
    const { rows: [row] } = await store.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${name}"`);
    counts.set(name, row!.count);
  }
  return counts;
}

async function databaseBytes(store: PGliteStore): Promise<number> {
  const { rows: [row] } = await store.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  return Number(row!.bytes);
}

type Growth = Readonly<{ table: string; perResync: number }>;

async function deadTuples(store: PGliteStore): Promise<number> {
  const { rows: [row] } = await store.query<{ dead: string }>(
    "SELECT COALESCE(SUM(n_dead_tup), 0)::text AS dead FROM pg_stat_user_tables",
  );
  return Number(row!.dead);
}

async function measure(mode: Mode) {
  const store = await installFinancialStore(await PGlite.create());
  try {
    await commitPGliteCanonicalFinancialCapture(store, capture(mode, 1));
    const afterFirst = await rowCounts(store);
    const bytesAfterFirst = await databaseBytes(store);
    const deadAfterFirst = await deadTuples(store);
    const started = performance.now();
    for (let sync = 2; sync <= SYNCS; sync += 1) {
      await commitPGliteCanonicalFinancialCapture(store, capture(mode, sync));
    }
    const resyncMs = (performance.now() - started) / (SYNCS - 1);
    const afterLast = await rowCounts(store);
    const bytesPerResync = (await databaseBytes(store) - bytesAfterFirst) / (SYNCS - 1);
    const deadTuplesPerResync = (await deadTuples(store) - deadAfterFirst) / (SYNCS - 1);
    const growth: Growth[] = [...afterLast]
      .map(([table, count]) => ({ table, perResync: (count - (afterFirst.get(table) ?? 0)) / (SYNCS - 1) }))
      .filter(({ perResync }) => perResync > 0)
      .sort((a, b) => b.perResync - a.perResync);
    return { mode, growth, bytesPerResync, deadTuplesPerResync, resyncMs };
  } finally {
    await store.close();
  }
}

let failed = false;
for (const mode of MODES) {
  const { growth, bytesPerResync, deadTuplesPerResync, resyncMs } = await measure(mode);
  const overBudget = growth.filter(({ perResync }) => perResync > ROWS_PER_RESYNC_BUDGET);
  const bytesPerRecord = bytesPerResync / RECORDS;
  console.log(JSON.stringify({
    mode,
    records: RECORDS,
    syncs: SYNCS,
    bytesPerResync: Math.round(bytesPerResync),
    bytesPerRecordPerResync: Math.round(bytesPerRecord),
    deadTuplesPerResync: Math.round(deadTuplesPerResync),
    commitMsPerResync: Math.round(resyncMs),
    rowsPerResync: Object.fromEntries(growth.map(({ table, perResync }) => [table, perResync])),
    overBudget: overBudget.map(({ table }) => table),
  }, null, 2));
  if (overBudget.length > 0 || bytesPerRecord > BYTES_PER_RECORD_BUDGET) failed = true;
}
if (failed) {
  console.error(
    `An unchanged re-sync grew a table by more than ${ROWS_PER_RESYNC_BUDGET} rows, `
      + `or the store by more than ${BYTES_PER_RECORD_BUDGET} bytes per record (ADR 0152).`,
  );
  process.exitCode = 1;
}
