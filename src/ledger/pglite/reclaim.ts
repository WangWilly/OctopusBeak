import type { PGliteStore } from "./transaction.ts";

/**
 * Reclaims the disk space a table lost to dead tuples before the worker
 * vacuumed it (ADR 0155). A plain VACUUM, which the worker runs (ADR 0153),
 * frees that space only for the table's own next writes; `VACUUM FULL`
 * rewrites the table and its indexes into new files and deletes the old ones,
 * so the space returns to the disk. Nothing is deleted: the new copy holds
 * every live row.
 *
 * A rewrite locks its table, and PGlite runs one statement at a time, so
 * every other query waits while one table is rewritten. Each table is
 * therefore its own step on the worker's background lane: queued work,
 * a commit included, runs between two tables.
 *
 * Tables are picked by size, not by `pg_stat_*` dead-tuple counts: PGlite
 * keeps no table statistics across a close, so `n_dead_tup` reads 0 after
 * every open, and a plain VACUUM already removed the dead tuples whose space
 * stays behind. The counts never cover TOAST chunks either. PGlite 0.5 ships
 * no `pgstattuple`.
 */

/** A table whose rewrite would free less than this is left alone. */
export const LEDGER_RECLAIM_MIN_BYTES = 1024 * 1024;
/** Nor is a table whose rewrite would free less than this share of its size. */
export const LEDGER_RECLAIM_MIN_SHARE = 0.25;
/** Free space kept beyond the largest rewrite, for other writes meanwhile. */
export const LEDGER_RECLAIM_HEADROOM_BYTES = 64 * 1024 * 1024;
/**
 * Free space a rewrite needs, in new copies of its table: the copy itself,
 * written before the old files go, and the WAL that records it. PGlite runs
 * with `full_page_writes=on`, and one rewrite measured about 1.9 copies of
 * WAL. A WAL write that fails on a full disk stops the database.
 */
export const LEDGER_RECLAIM_COPIES_NEEDED = 3;

const PAGE_BYTES = 8192;
// Page headers, line pointers' alignment and the space a page leaves when the next row does not fit.
const PAGE_FILL = 0.9;
// A heap row's line pointer; `pg_column_size(t.*)` counts its tuple header and data.
const LINE_POINTER_BYTES = 4;
const INDEX_TUPLE_HEADER_BYTES = 8;

/** One table a reclaim would rewrite. Sizes include the table's TOAST and indexes. */
export type LedgerReclaimTable = Readonly<{
  /** Schema-qualified and quoted, as `format('%I.%I')` writes it. */
  table: string;
  bytes: number;
  /** About how much smaller its rewrite would be. */
  reclaimableBytes: number;
}>;

export type LedgerReclaimEstimate = Readonly<{
  /** Smallest first, the order a reclaim rewrites them. */
  tables: readonly LedgerReclaimTable[];
  reclaimableBytes: number;
  /** `LEDGER_RECLAIM_COPIES_NEEDED` new copies of the largest table, plus the headroom. */
  requiredFreeBytes: number;
  /** Free space on the ledger's disk; null when it could not be read. */
  freeBytes: number | null;
}>;

export type LedgerReclaimedTable = Readonly<{
  table: string;
  bytesBefore: number;
  bytesAfter: number;
  /** How long the rewrite held the ledger. */
  milliseconds: number;
}>;

export type LedgerReclaimProgress = Readonly<{
  /** 1-based: table `index` of `count` is being rewritten. */
  index: number;
  count: number;
  table: string;
  /** What the tables rewritten so far took before and take now. */
  bytesBefore: number;
  bytesAfter: number;
}>;

export type LedgerReclaimSummary = Readonly<{
  tables: readonly LedgerReclaimedTable[];
  /** What the rewritten tables took before and take now. */
  bytesBefore: number;
  bytesAfter: number;
  /**
   * The ledger's folder before and after, WAL included; null without
   * `folderBytes`. The tables can shrink by more than the folder: the WAL
   * keeps its segments for reuse after a checkpoint.
   */
  folderBytesBefore: number | null;
  folderBytesAfter: number | null;
  /** The longest time one rewrite held the ledger. */
  longestMilliseconds: number;
}>;

export type LedgerReclaimResult =
  | Readonly<{ status: "nothing-to-reclaim" }>
  | Readonly<{ status: "not-enough-space"; requiredFreeBytes: number; freeBytes: number }>
  | Readonly<{ status: "already-running" }>
  /** `stopped`: the signal aborted between two tables; `failed`: a rewrite failed and the rest were not started. */
  | Readonly<{ status: "reclaimed" | "stopped" | "failed" } & LedgerReclaimSummary>;

/** What a reclaimer reports when asked: the running reclaim, or how the last one ended. */
export type LedgerReclaimStatus =
  | Readonly<{ running: true; progress: LedgerReclaimProgress | null }>
  | Readonly<{ running: false; last: LedgerReclaimResult | null }>;

export type LedgerReclaimOptions = Readonly<{
  /** Queues one step on the worker's background lane; by default a step runs at once. */
  runStep?: <T>(step: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
  /** Free bytes on the disk that holds the ledger. */
  freeBytes?: () => Promise<number>;
  /** Bytes the ledger's folder takes. */
  folderBytes?: () => Promise<number>;
  /** Flushes the ledger's folder to the disk; called after each checkpoint that follows a catalog rewrite, and at the end. */
  syncToDisk?: () => Promise<void>;
  /** Measures only these tables, as an estimate the person confirmed named them. */
  tables?: readonly string[];
  onProgress?: (progress: LedgerReclaimProgress) => void;
  minBytes?: number;
  minShare?: number;
}>;

type TableSize = Readonly<{ table: string; total: number; heap: number; indexes: number }>;

const runAtOnce = <T>(step: () => Promise<T>) => step();

async function tableSizes(store: PGliteStore, minBytes: number, only: readonly string[] | undefined): Promise<TableSize[]> {
  // Shared catalogs belong to every database and are tiny here; TOAST tables
  // are rewritten with their owners, and temporary tables belong to a session.
  const result = await store.query<{ table_name: string; total: number | string; heap: number | string; indexes: number | string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS table_name,
            pg_total_relation_size(c.oid) AS total,
            pg_table_size(c.oid) AS heap,
            pg_indexes_size(c.oid) AS indexes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND c.relpersistence = 'p'
        AND NOT c.relisshared
        AND n.nspname <> 'pg_toast'
        AND pg_total_relation_size(c.oid) >= $1::bigint
        AND ($2::text[] IS NULL OR format('%I.%I', n.nspname, c.relname) = ANY($2::text[]))
      ORDER BY pg_total_relation_size(c.oid), n.nspname, c.relname`,
    [minBytes, only === undefined ? null : [...only]],
  );
  return result.rows.map((row) => ({
    table: row.table_name,
    total: Number(row.total),
    heap: Number(row.heap),
    indexes: Number(row.indexes),
  }));
}

const pages = (bytes: number) => Math.ceil(bytes / (PAGE_BYTES * PAGE_FILL));
const maxAlign = (bytes: number) => Math.ceil(bytes / 8) * 8;

/**
 * About how small a rewrite would leave the table: its live rows packed into
 * pages, TOAST included, and one B-tree entry per row in each index, built
 * from the indexed columns' average sizes. Reads every live row once.
 *
 * The indexes need their own estimate. A catalog churned by temporary views
 * keeps few live rows in a small heap, which a plain VACUUM keeps compact,
 * while its indexes keep every page they ever split into.
 */
async function compactBytes(store: PGliteStore, size: TableSize): Promise<number> {
  const { rows: indexes } = await store.query<{ columns: string[]; keys: number }>(
    `SELECT ARRAY(SELECT quote_ident(a.attname)
                    FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                   ORDER BY k.position) AS columns,
            cardinality(i.indkey::int2[]) AS keys
       FROM pg_index i
      WHERE i.indrelid = $1::regclass`,
    [size.table],
  );
  const columns = [...new Set(indexes.flatMap((index) => index.columns))];
  const { rows: [live] } = await store.query<Record<string, number | string>>(
    `SELECT count(*) AS rows, coalesce(sum(pg_column_size(t.*)), 0) AS bytes
            ${columns.map((column, at) => `, coalesce(sum(pg_column_size(t.${column})), 0) AS c${at}`).join("")}
       FROM ONLY ${size.table} t`,
  );
  const rowCount = Number(live!.rows);
  const heap = Math.min(size.heap, pages(Number(live!.bytes) + LINE_POINTER_BYTES * rowCount) * PAGE_BYTES);
  if (rowCount === 0) return heap + indexes.length * 2 * PAGE_BYTES;
  const averageBytes = new Map(columns.map((column, at) => [column, Number(live![`c${at}`]) / rowCount]));
  const indexBytes = indexes.reduce((sum, index) => {
    // An expression key is not a column; count it as one 8-byte value.
    const keyBytes = index.columns.reduce((bytes, column) => bytes + averageBytes.get(column)!, 0)
      + 8 * (index.keys - index.columns.length);
    const entry = INDEX_TUPLE_HEADER_BYTES + maxAlign(keyBytes) + LINE_POINTER_BYTES;
    // The metapage, a root, and about one inner page per hundred leaves.
    const leaves = pages(entry * rowCount);
    return sum + (leaves + Math.ceil(leaves / 100) + 2) * PAGE_BYTES;
  }, 0);
  return heap + Math.min(size.indexes, indexBytes);
}

async function readFreeBytes(options: LedgerReclaimOptions): Promise<number | null> {
  if (!options.freeBytes) return null;
  try {
    return await options.freeBytes();
  } catch {
    return null;
  }
}

/** The tables worth rewriting, smallest first, each measured in its own step. */
export async function estimateLedgerReclaim(store: PGliteStore, options: LedgerReclaimOptions = {}): Promise<LedgerReclaimEstimate> {
  const runStep = options.runStep ?? runAtOnce;
  const minBytes = options.minBytes ?? LEDGER_RECLAIM_MIN_BYTES;
  const minShare = options.minShare ?? LEDGER_RECLAIM_MIN_SHARE;
  const tables: LedgerReclaimTable[] = [];
  for (const size of await runStep(() => tableSizes(store, minBytes, options.tables))) {
    options.signal?.throwIfAborted();
    const compact = await runStep(() => compactBytes(store, size));
    const reclaimableBytes = Math.max(0, size.total - compact);
    if (reclaimableBytes >= minBytes && reclaimableBytes >= minShare * size.total) {
      tables.push({ table: size.table, bytes: size.total, reclaimableBytes });
    }
  }
  const largest = Math.max(0, ...tables.map(({ bytes, reclaimableBytes }) => bytes - reclaimableBytes));
  return {
    tables,
    reclaimableBytes: tables.reduce((sum, { reclaimableBytes }) => sum + reclaimableBytes, 0),
    requiredFreeBytes: tables.length === 0 ? 0 : LEDGER_RECLAIM_COPIES_NEEDED * largest + LEDGER_RECLAIM_HEADROOM_BYTES,
    freeBytes: await readFreeBytes(options),
  };
}

async function totalBytes(store: PGliteStore, table: string): Promise<number> {
  const { rows } = await store.query<{ bytes: number | string }>(
    "SELECT pg_total_relation_size($1::regclass) AS bytes",
    [table],
  );
  return Number(rows[0]!.bytes);
}

/**
 * Rewrites one table with `VACUUM FULL`, which cannot run in a transaction
 * block. A store table is analyzed too, as the worker's vacuum does; a
 * catalog is only rewritten.
 */
async function rewrite(store: PGliteStore, table: string): Promise<LedgerReclaimedTable> {
  const bytesBefore = await totalBytes(store, table);
  const started = performance.now();
  await store.exec(table.startsWith("pg_catalog.") ? `VACUUM FULL ${table}` : `VACUUM (FULL, ANALYZE) ${table}`);
  const milliseconds = performance.now() - started;
  return { table, bytesBefore, bytesAfter: await totalBytes(store, table), milliseconds };
}

async function readFolderBytes(options: LedgerReclaimOptions): Promise<number | null> {
  if (!options.folderBytes) return null;
  try {
    return await options.folderBytes();
  } catch {
    return null;
  }
}

/**
 * Rewrites every table the estimate picks, smallest first, one step per
 * table, and checkpoints after each, so the WAL holds one table's rewrite at
 * most and a crash replays no more. After a catalog's checkpoint the folder
 * is flushed to the disk: the relation map then names the catalog's new
 * file, and a power loss before that file is on the disk would leave a store
 * that cannot open. Refuses before it starts when the disk cannot hold the
 * largest rewrite. The signal is honoured between tables; a table being
 * rewritten finishes first.
 */
export async function reclaimLedgerSpace(store: PGliteStore, options: LedgerReclaimOptions = {}): Promise<LedgerReclaimResult> {
  const runStep = options.runStep ?? runAtOnce;
  const done: LedgerReclaimedTable[] = [];
  let folderBytesBefore: number | null = null;
  const bytes = () => ({
    bytesBefore: done.reduce((sum, { bytesBefore }) => sum + bytesBefore, 0),
    bytesAfter: done.reduce((sum, { bytesAfter }) => sum + bytesAfter, 0),
  });
  const summary = async (status: "reclaimed" | "stopped" | "failed"): Promise<LedgerReclaimResult> => ({
    status,
    tables: done,
    ...bytes(),
    folderBytesBefore,
    folderBytesAfter: done.length === 0 ? folderBytesBefore : await readFolderBytes(options),
    longestMilliseconds: Math.max(0, ...done.map(({ milliseconds }) => milliseconds)),
  });
  let estimate: LedgerReclaimEstimate;
  try {
    estimate = await estimateLedgerReclaim(store, options);
  } catch (error) {
    if (options.signal?.aborted) return summary("stopped");
    throw error;
  }
  if (estimate.tables.length === 0) return { status: "nothing-to-reclaim" };
  if (estimate.freeBytes !== null && estimate.freeBytes < estimate.requiredFreeBytes) {
    return { status: "not-enough-space", requiredFreeBytes: estimate.requiredFreeBytes, freeBytes: estimate.freeBytes };
  }
  folderBytesBefore = await readFolderBytes(options);
  const count = estimate.tables.length;
  let unsynced = false;
  try {
    for (const [position, { table }] of estimate.tables.entries()) {
      if (options.signal?.aborted) return await summary("stopped");
      options.onProgress?.({ index: position + 1, count, table, ...bytes() });
      try {
        done.push(await runStep(() => rewrite(store, table)));
      } catch {
        return await summary("failed");
      }
      const catalog = table.startsWith("pg_catalog.");
      await runStep(() => store.exec("CHECKPOINT"));
      // Off the queue: a flush can take seconds and needs no lock. The next table waits for it.
      if (catalog) await options.syncToDisk?.();
      unsynced = !catalog;
    }
  } finally {
    // A store table's checkpoint reaches only the OS cache; however the reclaim ends, flush it too.
    if (unsynced && options.syncToDisk) await options.syncToDisk().catch(() => undefined);
  }
  return summary("reclaimed");
}

export type LedgerReclaimer = Readonly<{
  /** Remembers the tables it picks; the next reclaim measures only those again. */
  estimate(signal?: AbortSignal): Promise<LedgerReclaimEstimate>;
  /** Refuses with `already-running` while another reclaim runs. */
  reclaim(signal?: AbortSignal): Promise<LedgerReclaimResult>;
  status(): LedgerReclaimStatus;
  /** Stops the running reclaim before its next table; false when none runs. */
  stop(): boolean;
}>;

/** The worker's one reclaim at a time, whose status and stop other requests reach. */
export function createLedgerReclaimer(
  store: PGliteStore,
  options: Pick<LedgerReclaimOptions, "runStep" | "freeBytes" | "folderBytes" | "syncToDisk" | "minBytes" | "minShare"> = {},
): LedgerReclaimer {
  let running: { readonly controller: AbortController; progress: LedgerReclaimProgress | null } | null = null;
  let last: LedgerReclaimResult | null = null;
  let confirmed: readonly string[] | undefined;
  return Object.freeze({
    async estimate(signal?: AbortSignal) {
      const estimate = await estimateLedgerReclaim(store, { ...options, signal });
      confirmed = estimate.tables.map(({ table }) => table);
      return estimate;
    },
    async reclaim(signal?: AbortSignal) {
      if (running) return { status: "already-running" } as const;
      const run = { controller: new AbortController(), progress: null as LedgerReclaimProgress | null };
      const stopOnAbort = () => run.controller.abort();
      signal?.addEventListener("abort", stopOnAbort, { once: true });
      running = run;
      const tables = confirmed;
      confirmed = undefined;
      try {
        last = await reclaimLedgerSpace(store, {
          ...options,
          tables,
          signal: run.controller.signal,
          onProgress: (progress) => { run.progress = progress; },
        });
        return last;
      } finally {
        signal?.removeEventListener("abort", stopOnAbort);
        running = null;
      }
    },
    status: (): LedgerReclaimStatus => running ? { running: true, progress: running.progress } : { running: false, last },
    stop() {
      if (!running) return false;
      running.controller.abort();
      return true;
    },
  });
}
