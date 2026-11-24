import { performance } from "node:perf_hooks";
import {
  COMPACTED_TABLES,
  COMPACTION_READERS,
  compactLedgerChunk,
  DOMAIN_COUNTS_MARKER,
  LedgerCompactionError,
  markerSignature,
  RECORDS_MARKER,
  zeroRemoved,
  type CompactedTable,
  type CompactionChain,
  type CompactionChunk,
  type LedgerCompactionFailure,
  type LedgerCompactionOptions,
} from "./compaction.ts";
import { MANIFEST, PHASE_A, type PhaseATable } from "./compaction-plan.ts";
import { LedgerBackupError } from "./data-dir-backup.ts";
import { reclaimLedgerSpace, type LedgerReclaimOptions, type LedgerReclaimProgress, type LedgerReclaimResult } from "./reclaim.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * The worker's ledger compaction (ADR 0154): `compactLedger`'s phases, run
 * as chunks, each its own verified transaction and its own step on the
 * background lane, so syncs, commits and page reads run between two chunks.
 *
 * 1. Phase A, one chunk per domain table, store-wide. Tables whose selection
 *    or a reader names both are one chunk: the e-invoice observations and
 *    events.
 * 2. Phases B and C, one chunk per set of chains (a source subject and record
 *    kind) that share a capture. A capture's manifest is written once, by the
 *    chunk that removes its copies, so its other copies must be removed in
 *    the same chunk.
 * 0. When the owner asked for one, a backup of the data folder, as one
 *    step before the first chunk (`backUpLedger` in `data-dir-backup.ts`).
 * 3. The markers, once every chunk is done.
 * 4. `reclaimLedgerSpace` on the compacted tables, then the space marker.
 *
 * Progress is the data itself: a committed chunk's selection finds nothing
 * the next time, so a stop, crash or quit resumes by planning again and
 * running every chunk, and the done ones commit nothing. A chunk that fails
 * rolls back alone and ends the run as `failed`; nothing retries it. The
 * compactor records a failed run in the ledger, so Settings still shows it
 * after a restart, and clears the record when the owner starts again.
 */

/** Recorded once the compacted tables are rewritten, so a run that stops before then rewrites them next time. */
export const SPACE_MARKER = "ledger-compaction-space-v1";

/** The tables a compaction leaves holes in, which the reclaim measures. */
const RECLAIMED_TABLES = [...COMPACTED_TABLES, MANIFEST].map((table) => `public.${table}`);

export type LedgerCompactionProgress =
  | Readonly<{ phase: "backing-up" }>
  | Readonly<{
    phase: "compacting";
    /** 1-based: chunk `index` of `count` is running. */
    index: number;
    count: number;
    chunk: CompactionChunk;
    /** Rows removed by the chunks committed in this run, every table together. */
    removedRows: number;
  }>
  | Readonly<{ phase: "reclaiming"; removedRows: number; reclaim: LedgerReclaimProgress }>;

/** How a run's chunks went. A resumed run counts the chunks done before as done again, removing nothing. */
type Tally = Readonly<{
  removed: Readonly<Record<CompactedTable, number>>;
  manifests: number;
  chunks: Readonly<{ done: number; count: number }>;
  /** The longest time one chunk held the ledger. */
  longestChunkMs: number;
  durationMs: number;
}>;

export type LedgerCompactionJobFailure =
  | LedgerCompactionFailure
  | Readonly<{ reason: "error"; message: string }>
  /** The backup was not made, so no chunk ran. */
  | Readonly<{ reason: "backup"; backup: LedgerBackupError["reason"] }>;

export type LedgerCompactionJobResult =
  /** Every marker was already written; nothing was read or removed. */
  | Readonly<{ status: "already-compacted" }>
  | Readonly<{ status: "already-running" }>
  /** Every chunk committed and the markers are written. `reclaim` says whether the space returned too. */
  | Readonly<{ status: "compacted"; reclaim: LedgerReclaimResult } & Tally>
  /** The signal aborted; the running chunk, if any, rolled back. A stop during the reclaim leaves every chunk committed but the space not yet returned. */
  | Readonly<{ status: "stopped" } & Tally>
  /** `chunk` rolled back (null: the plan or the markers failed); the chunks before it stay committed. */
  | Readonly<{ status: "failed"; chunk: CompactionChunk | null; failure: LedgerCompactionJobFailure } & Tally>;

/** A failed run recorded in the ledger, as read back after a restart. */
export type LedgerCompactionRecordedFailure = Readonly<{
  status: "failed-earlier";
  removedRows: number;
  chunks: Readonly<{ done: number; count: number }>;
  /** The backup failed, so no chunk ran. */
  backup: boolean;
  failedAt: string;
}>;

export type LedgerCompactionStatus =
  | Readonly<{ running: true; progress: LedgerCompactionProgress | null }>
  /** `last` is this process's last run, or else the failed run the ledger recorded. */
  | Readonly<{ running: false; last: LedgerCompactionJobResult | LedgerCompactionRecordedFailure | null }>;

/** What the owner chose when starting a compaction. */
export type LedgerCompactionRequest = Readonly<{ backup: boolean }>;

export type LedgerCompactionBackup = (context: Readonly<{
  runStep: <T>(step: () => Promise<T>) => Promise<T>;
  signal: AbortSignal | undefined;
}>) => Promise<unknown>;

export type LedgerCompactionJobOptions = Readonly<{
  /** Queues one step on the worker's background lane; by default a step runs at once. */
  runStep?: <T>(step: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
  onProgress?: (progress: LedgerCompactionProgress) => void;
  /**
   * Takes a backup before the first chunk, queuing its copy with `runStep`
   * itself; a backup that throws ends the run as `failed`, or `stopped` when
   * `signal` aborted it.
   */
  backup?: LedgerCompactionBackup;
  /** Passed to the reclaim, which rewrites the compacted tables. */
  reclaim?: Pick<LedgerReclaimOptions, "freeBytes" | "folderBytes" | "syncToDisk" | "minBytes" | "minShare">;
  /** Replaces a chunk's selections; only checks use it. */
  selections?: LedgerCompactionOptions["selections"];
}>;

export type LedgerCompactionJobPlan = Readonly<{
  markers: ReadonlySet<string>;
  chunks: readonly CompactionChunk[];
}>;

const runAtOnce = <T>(step: () => Promise<T>) => step();

/**
 * Tables compacted in one chunk: a table whose selection names another, or
 * which shares a reader with another. Deleting one alone would change the
 * other's selection or the shared reader's answer.
 */
export function domainChunks(): readonly (readonly PhaseATable[])[] {
  const tables = Object.keys(PHASE_A) as PhaseATable[];
  const names = (sql: string, table: string) => new RegExp(`\\b${table}\\b`, "u").test(sql);
  const together = (a: PhaseATable, b: PhaseATable) =>
    names(PHASE_A[a].marked, b) || names(PHASE_A[b].marked, a)
    || Object.values(COMPACTION_READERS).some((sql: string) => names(sql, a) && names(sql, b));
  const chunks: PhaseATable[][] = [];
  for (const table of tables) {
    const joined = chunks.filter((chunk) => chunk.some((other) => together(table, other)));
    const merged = [...joined.flat(), table];
    chunks.splice(0, chunks.length, ...chunks.filter((chunk) => !joined.includes(chunk)), merged);
  }
  return chunks.sort((a, b) => tables.indexOf(a[0]!) - tables.indexOf(b[0]!));
}

/**
 * The chunks a run would commit, read in one read-only transaction. Phase B
 * and C chains are grouped so that no capture holds copies of two groups,
 * as the copies stand when the plan is read.
 */
export async function planLedgerCompactionJob(store: PGliteStore): Promise<LedgerCompactionJobPlan> {
  return store.transaction(async (transaction) => {
    await transaction.query("SET TRANSACTION READ ONLY");
    const { rows: marked } = await transaction.query<{ migration_key: string }>(
      "SELECT migration_key FROM pglite_operational_migrations WHERE migration_key = ANY($1::text[])",
      [[DOMAIN_COUNTS_MARKER, RECORDS_MARKER, SPACE_MARKER]],
    );
    const markers = new Set(marked.map(({ migration_key }) => migration_key));
    const counts = !markers.has(DOMAIN_COUNTS_MARKER);
    const records = !markers.has(RECORDS_MARKER);
    if (!counts && !records) return { markers, chunks: [] };

    const { rows: held } = await transaction.query<{ capture: string; subject: string; record_kind: string }>(
      `SELECT encode(capture_id, 'hex') AS capture, encode(source_subject_id, 'hex') AS subject, record_kind
         FROM source_records WHERE source_subject_id IS NOT NULL AND occurrence_key IS NOT NULL
        GROUP BY capture_id, source_subject_id, record_kind`,
    );
    const { rows: covered } = counts
      ? await transaction.query<{ subject: string; record_kind: string }>(
        `SELECT DISTINCT encode(source_subject_id, 'hex') AS subject, record_kind FROM source_occurrence_group_coverages`)
      : { rows: [] };
    const { rows: namespaces } = await transaction.query<{ subject: string; namespace: string }>(
      `SELECT encode(subject.source_subject_id, 'hex') AS subject, connection.integration_namespace AS namespace
         FROM source_subjects subject
         JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id`,
    );
    const namespaceOf = new Map(namespaces.map(({ subject, namespace }) => [subject, namespace]));

    const groups = new ChainGroups();
    for (const { subject, record_kind } of [...held, ...covered]) groups.add({ subject, recordKind: record_kind });
    const byCapture = new Map<string, CompactionChain>();
    for (const { capture, subject, record_kind } of held) {
      const chain = { subject, recordKind: record_kind };
      const other = byCapture.get(capture);
      if (other) groups.join(other, chain);
      else byCapture.set(capture, chain);
    }
    const chainChunks = groups.list().map((chains): CompactionChunk => ({
      kind: "chains",
      chains,
      namespaces: [...new Set(chains.map(({ subject }) => namespaceOf.get(subject) ?? ""))].sort(),
      records,
      counts,
    }));
    const domain = counts ? domainChunks().map((tables): CompactionChunk => ({ kind: "domain", tables })) : [];
    // Phase A first: the domain rows it keeps are the ones that still pin a copy.
    return { markers, chunks: [...domain, ...chainChunks] };
  });
}

/** Chains joined by the captures they share, as disjoint groups. */
class ChainGroups {
  readonly #parent = new Map<string, string>();
  readonly #chains = new Map<string, CompactionChain>();

  add(chain: CompactionChain): void {
    const key = ChainGroups.#key(chain);
    if (this.#parent.has(key)) return;
    this.#parent.set(key, key);
    this.#chains.set(key, chain);
  }

  join(a: CompactionChain, b: CompactionChain): void {
    this.add(a);
    this.add(b);
    this.#parent.set(this.#root(ChainGroups.#key(a)), this.#root(ChainGroups.#key(b)));
  }

  /** Each group's chains sorted, the groups by their first chain. */
  list(): CompactionChain[][] {
    const groups = new Map<string, string[]>();
    for (const key of this.#parent.keys()) {
      const root = this.#root(key);
      groups.set(root, [...(groups.get(root) ?? []), key]);
    }
    return [...groups.values()]
      .map((keys) => keys.sort())
      .sort((a, b) => a[0]!.localeCompare(b[0]!))
      .map((keys) => keys.map((key) => this.#chains.get(key)!));
  }

  #root(key: string): string {
    let root = key;
    while (this.#parent.get(root) !== root) root = this.#parent.get(root)!;
    for (let at = key; at !== root;) {
      const next = this.#parent.get(at)!;
      this.#parent.set(at, root);
      at = next;
    }
    return root;
  }

  static #key({ subject, recordKind }: CompactionChain): string {
    return `${subject}\u0000${recordKind}`;
  }
}

async function writeMarkers(store: PGliteStore, markers: readonly string[]): Promise<void> {
  await store.transaction(async (transaction) => {
    for (const marker of markers)
      await transaction.query(
        `INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)
         ON CONFLICT (migration_key) DO NOTHING`,
        [marker, markerSignature(marker)],
      );
  });
}

const failureOf = (error: unknown): LedgerCompactionJobFailure =>
  error instanceof LedgerCompactionError ? error.failure : { reason: "error", message: error instanceof Error ? error.message : String(error) };

/** The key of the one row that records the last failed run, in the markers' table. Not a marker: no run skips anything for it. */
export const FAILURE_RECORD = "ledger-compaction-last-failure";

type RecordedFailureJson = Readonly<{ removedRows: number; chunks: Readonly<{ done: number; count: number }>; backup: boolean }>;

async function recordFailure(store: PGliteStore, failed: Extract<LedgerCompactionJobResult, { status: "failed" }>): Promise<void> {
  const recorded: RecordedFailureJson = {
    removedRows: Object.values(failed.removed).reduce((sum, rows) => sum + rows, 0),
    chunks: failed.chunks,
    backup: failed.failure.reason === "backup",
  };
  // The signature column holds the record; only this module reads it.
  await store.query(
    `INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)
     ON CONFLICT (migration_key) DO UPDATE SET schema_signature = EXCLUDED.schema_signature, applied_at = CURRENT_TIMESTAMP`,
    [FAILURE_RECORD, JSON.stringify(recorded)],
  );
}

async function clearRecordedFailure(store: PGliteStore): Promise<void> {
  await store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = $1", [FAILURE_RECORD]);
}

/** The failed run the ledger recorded, or null when the last run did not fail or none ran. */
export async function readRecordedFailure(store: PGliteStore): Promise<LedgerCompactionRecordedFailure | null> {
  const { rows: [row] } = await store.query<{ schema_signature: string; applied_at: Date | string }>(
    "SELECT schema_signature, applied_at FROM pglite_operational_migrations WHERE migration_key = $1",
    [FAILURE_RECORD],
  );
  if (!row) return null;
  let recorded: Partial<RecordedFailureJson> = {};
  try {
    recorded = JSON.parse(row.schema_signature) as Partial<RecordedFailureJson>;
  } catch {
    // An unreadable record still says a run failed.
  }
  const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    status: "failed-earlier",
    removedRows: count(recorded.removedRows),
    chunks: { done: count(recorded.chunks?.done), count: count(recorded.chunks?.count) },
    backup: recorded.backup === true,
    failedAt: new Date(row.applied_at).toISOString(),
  };
}

/**
 * Compact `store` chunk by chunk, then return the space. Never rejects: a
 * stop ends the run as `stopped`, and a chunk, plan or marker that fails
 * ends it as `failed` with what the chunks before it removed. Not for the
 * open path.
 */
export async function runLedgerCompaction(store: PGliteStore, options: LedgerCompactionJobOptions = {}): Promise<LedgerCompactionJobResult> {
  const started = performance.now();
  const runStep = options.runStep ?? runAtOnce;
  const removed = zeroRemoved();
  let manifests = 0;
  let done = 0;
  let count = 0;
  let longestChunkMs = 0;
  const removedRows = () => Object.values(removed).reduce((sum, rows) => sum + rows, 0);
  const tally = (): Tally => ({
    removed: { ...removed },
    manifests,
    chunks: { done, count },
    longestChunkMs: Math.round(longestChunkMs),
    durationMs: Math.round(performance.now() - started),
  });
  // A chunk that rolled back on its own verification failed, even when a stop came meanwhile.
  const ended = (error: unknown, chunk: CompactionChunk | null): LedgerCompactionJobResult =>
    options.signal?.aborted && !(error instanceof LedgerCompactionError)
      ? { status: "stopped", ...tally() }
      : { status: "failed", chunk, failure: failureOf(error), ...tally() };

  let plan: LedgerCompactionJobPlan;
  try {
    options.signal?.throwIfAborted();
    plan = await runStep(() => planLedgerCompactionJob(store));
  } catch (error) {
    return ended(error, null);
  }
  const compacted = plan.markers.has(DOMAIN_COUNTS_MARKER) && plan.markers.has(RECORDS_MARKER);
  if (compacted && plan.markers.has(SPACE_MARKER)) return { status: "already-compacted" };

  if (options.backup) {
    if (options.signal?.aborted) return { status: "stopped", ...tally() };
    options.onProgress?.({ phase: "backing-up" });
    try {
      await options.backup({ runStep, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) return { status: "stopped", ...tally() };
      const backup = error instanceof LedgerBackupError ? error.reason : "copy-failed";
      return { status: "failed", chunk: null, failure: { reason: "backup", backup }, ...tally() };
    }
  }

  count = plan.chunks.length;
  for (const [position, chunk] of plan.chunks.entries()) {
    if (options.signal?.aborted) return { status: "stopped", ...tally() };
    options.onProgress?.({ phase: "compacting", index: position + 1, count, chunk, removedRows: removedRows() });
    try {
      const result = await runStep(async () => {
        const chunkStarted = performance.now();
        const committed = await compactLedgerChunk(store, chunk, { signal: options.signal, selections: options.selections });
        longestChunkMs = Math.max(longestChunkMs, performance.now() - chunkStarted);
        return committed;
      });
      for (const table of COMPACTED_TABLES) removed[table] += result.removed[table];
      manifests += result.manifests;
      done += 1;
    } catch (error) {
      return ended(error, chunk);
    }
  }
  if (!compacted) {
    try {
      await runStep(() => writeMarkers(store, [DOMAIN_COUNTS_MARKER, RECORDS_MARKER]));
    } catch (error) {
      return ended(error, null);
    }
  }

  const reclaim = await reclaimLedgerSpace(store, {
    ...options.reclaim,
    runStep,
    signal: options.signal,
    tables: RECLAIMED_TABLES,
    onProgress: (progress) => options.onProgress?.({ phase: "reclaiming", removedRows: removedRows(), reclaim: progress }),
  });
  if (reclaim.status === "reclaimed" || reclaim.status === "nothing-to-reclaim") {
    try {
      await runStep(() => writeMarkers(store, [SPACE_MARKER]));
    } catch (error) {
      return ended(error, null);
    }
  }
  // Every chunk committed, but the person pressed Stop before the space returned; the next run reclaims it.
  if (reclaim.status === "stopped") return { status: "stopped", ...tally() };
  return { status: "compacted", reclaim, ...tally() };
}

export type LedgerCompactor = Readonly<{
  /** Runs a compaction; refuses with `already-running` while another runs. */
  compact(signal?: AbortSignal, request?: LedgerCompactionRequest): Promise<LedgerCompactionJobResult>;
  /** Reads the ledger only when this process has run none: for the failure a run before a restart recorded. */
  status(): Promise<LedgerCompactionStatus>;
  /** Stops the running compaction: its running chunk rolls back, and no other starts. False when none runs. */
  stop(): boolean;
}>;

/** The worker's one compaction at a time, whose status and stop other requests reach, as `createLedgerReclaimer`. */
export function createLedgerCompactor(
  store: PGliteStore,
  options: Pick<LedgerCompactionJobOptions, "runStep" | "reclaim" | "backup"> = {},
): LedgerCompactor {
  const runStep = options.runStep ?? runAtOnce;
  const unavailable = async () => { throw new LedgerBackupError("unavailable", "This ledger has no folder to back up."); };
  let running: { readonly controller: AbortController; progress: LedgerCompactionProgress | null } | null = null;
  let last: LedgerCompactionJobResult | null = null;
  return Object.freeze({
    async compact(signal?: AbortSignal, request: LedgerCompactionRequest = { backup: false }) {
      if (running) return { status: "already-running" } as const;
      const run = { controller: new AbortController(), progress: null as LedgerCompactionProgress | null };
      const stopOnAbort = () => run.controller.abort();
      signal?.addEventListener("abort", stopOnAbort, { once: true });
      running = run;
      try {
        // Starting again is the owner's answer to a recorded failure. A store
        // that cannot delete it fails the run's plan too, which records it again.
        await runStep(() => clearRecordedFailure(store)).catch(() => undefined);
        const result = await runLedgerCompaction(store, {
          runStep: options.runStep,
          reclaim: options.reclaim,
          backup: request.backup ? options.backup ?? unavailable : undefined,
          signal: run.controller.signal,
          onProgress: (progress) => { run.progress = progress; },
        });
        last = result;
        // Kept in memory regardless, so this process still shows it if the write fails.
        if (result.status === "failed") await runStep(() => recordFailure(store, result)).catch(() => undefined);
        return result;
      } finally {
        signal?.removeEventListener("abort", stopOnAbort);
        running = null;
      }
    },
    async status(): Promise<LedgerCompactionStatus> {
      if (running) return { running: true, progress: running.progress };
      return { running: false, last: last ?? await readRecordedFailure(store) };
    },
    stop() {
      if (!running) return false;
      running.controller.abort();
      return true;
    },
  });
}
