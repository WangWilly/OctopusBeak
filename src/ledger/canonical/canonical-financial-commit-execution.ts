import { createHash } from "node:crypto";
import {
  createCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  canonicalDatabaseWriterKey,
  openCanonicalDatabaseHandle,
} from "./canonical-database.ts";
import {
  CanonicalBusyRetryExhaustedError,
  withCanonicalWriterQueue,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import {
  CanonicalSourceCaptureAdmissionError,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
  type CanonicalSourceCaptureAdmissionTransactionResult,
  withCanonicalSourceCaptureAdmissionTransaction,
} from "./canonical-source-capture-admission.ts";
import type { ValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";

/** The four outcomes a controlled provider persistence run can report. */
export type CanonicalFinancialCommitRunStatus =
  | "completed"
  | "partially-completed"
  | "failed"
  | "cancelled";

export type CanonicalFinancialCommitFailureKind = "item" | "fatal";

export type CanonicalFinancialCommitExecutionStage =
  | "admission"
  | "commit"
  | "relation-resolution"
  | "cancellation"
  | "run";

/**
 * A data-only view of the lifecycle-created store.  It deliberately omits
 * the store's close operation and the physical database path.  Existing
 * typed writers can use this view for their in-transaction operations without
 * acquiring ownership of the run's handle.
 */
export type CanonicalFinancialCommitWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "commitClock" | "withWriter"
>;

/** Structured, non-financial diagnostic safe for an operational/UI seam. */
export type CanonicalFinancialCommitDiagnostic = Readonly<{
  provider: string;
  product: string;
  itemKey: string;
  stage: CanonicalFinancialCommitExecutionStage;
  errorCode: string;
  message: string;
}>;

/** Read-only receipt summary for one Source Capture admitted in this item. */
export type CanonicalFinancialCommitAdmissionSummary = Readonly<{
  captureId: string;
  commitSequence: number;
}>;

/** A provider adapter's transaction-scoped view of canonical persistence. */
export type CanonicalFinancialCommitTransaction = Readonly<{
  /** The lifecycle-created data capability; it has no schema controls. */
  database: ValidatedCanonicalDatabase;
  /**
   * A transaction-scoped recording wrapper around source admission.  The
   * domain commit must perform one or more admissions through this capability;
   * the execution seam never pre-admits provider evidence.
   */
  admission: CanonicalSourceCaptureAdmissionTransactionCapability;
  /** Data-only writer view; it cannot close the run or identify its path. */
  writer: CanonicalFinancialCommitWriterStore;
  /** Throw an execution cancellation error when the active signal is aborted. */
  throwIfCancelled(): void;
}>;

export type CanonicalFinancialCommitRelationContext<T> = Readonly<{
  provider: string;
  product: string;
  itemKey: string;
  result: T;
  /** One or more Source Captures admitted atomically by this item. */
  admissionSummaries: readonly CanonicalFinancialCommitAdmissionSummary[];
  database: ValidatedCanonicalDatabase;
  writer: CanonicalFinancialCommitWriterStore;
}>;

export type CanonicalFinancialCommitItem<T> = Readonly<{
  /** Operational identity only; it is sanitized before entering diagnostics. */
  provider: string;
  product: string;
  itemKey: string;
  /**
   * Domain-specific financial persistence.  It runs inside the Capture's
   * transaction and may use only the validated transaction view.  The
   * provider capture/evidence is deliberately closed over by this callback;
   * it must call `transaction.admission.admit(...)` one or more times.
   */
  commit: (
    transaction: CanonicalFinancialCommitTransaction,
  ) => T | Promise<T>;
  /**
   * Optional domain-specific relation follow-through.  It runs only after
   * the Capture transaction has committed; all failures become warnings.
   */
  resolveRelations?: (
    context: CanonicalFinancialCommitRelationContext<T>,
  ) => void | Promise<void>;
  /** Use when a domain adapter can classify its own validation error. */
  classifyError?: (
    error: unknown,
  ) => CanonicalFinancialCommitFailureKind;
}>;

export type CanonicalFinancialCommitItemSource<T> =
  | Iterable<CanonicalFinancialCommitItem<T>>
  | AsyncIterable<CanonicalFinancialCommitItem<T>>;

export type CanonicalFinancialCommitRunRequest<T> = Readonly<{
  canonicalLedgerDir: string;
  items: CanonicalFinancialCommitItemSource<T>;
  signal?: AbortSignal;
  runtime?: CanonicalRuntimeOptions;
  commitClock?: () => number;
  /** Optional fallback labels for a run-fatal error before an item exists. */
  provider?: string;
  product?: string;
}>;

export type CanonicalFinancialCommitItemResult<T> =
  | Readonly<{
      itemKey: string;
      provider: string;
      product: string;
      status: "committed";
      /** One or more Source Captures admitted atomically by this item. */
      admissionSummaries: readonly CanonicalFinancialCommitAdmissionSummary[];
      value: T;
      relationWarnings: readonly CanonicalFinancialCommitDiagnostic[];
    }>
  | Readonly<{
      itemKey: string;
      provider: string;
      product: string;
      status: "failed";
      failureKind: CanonicalFinancialCommitFailureKind;
      diagnostics: readonly CanonicalFinancialCommitDiagnostic[];
    }>;

export type CanonicalFinancialCommitRunResult<T> = Readonly<{
  status: CanonicalFinancialCommitRunStatus;
  items: readonly CanonicalFinancialCommitItemResult<T>[];
  diagnostics: readonly CanonicalFinancialCommitDiagnostic[];
  committedCount: number;
  failedCount: number;
}>;

export type CanonicalFinancialCommitRunOptions = Readonly<{
  signal?: AbortSignal;
  runtime?: CanonicalRuntimeOptions;
  commitClock?: () => number;
  provider?: string;
  product?: string;
}>;

export class CanonicalFinancialCommitItemError extends Error {
  readonly failureKind = "item" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CanonicalFinancialCommitItemError";
  }
}

export class CanonicalFinancialCommitFatalError extends Error {
  readonly failureKind = "fatal" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CanonicalFinancialCommitFatalError";
  }
}

export class CanonicalFinancialCommitCancelledError extends Error {
  readonly failureKind = "cancelled" as const;
  readonly code = "cancelled" as const;

  constructor() {
    super("Canonical financial commit execution was cancelled.");
    this.name = "CanonicalFinancialCommitCancelledError";
  }
}

/** A run-fatal violation of the one-or-more-admissions execution contract. */
export class CanonicalFinancialCommitCapabilityError extends CanonicalFinancialCommitFatalError {
  readonly code = "capability-violation" as const;

  constructor(message: string) {
    super(message);
    this.name = "CanonicalFinancialCommitCapabilityError";
  }
}

const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u;
const SECRET_OR_PHYSICAL =
  /account|credential|cookie|header|password|payload|path|record|secret|sql|token|trace|uuid/i;
/**
 * One short-lived gate for both lifecycle opens and active commit turns. A
 * second handle may be opened after a first open finishes, but it can never
 * enter lifecycle BEGIN IMMEDIATE while another handle is committing.
 */
const LEDGER_OPERATION_QUEUES = new Map<string, Promise<void>>();

function hashIdentity(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function safeIdentity(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (SAFE_IDENTITY.test(text) && !SECRET_OR_PHYSICAL.test(text)) return text;
  return text ? hashIdentity(text) : fallback;
}

function safeLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_IDENTITY.test(text) && !SECRET_OR_PHYSICAL.test(text)
    ? text
    : fallback;
}

function rejectLegacyLedgerAliases(value: object): void {
  if (
    Object.prototype.hasOwnProperty.call(value, "canonicalSourceLedgerDir") ||
    Object.prototype.hasOwnProperty.call(value, "canonicalFinancialLedgerDir")
  )
    throw new CanonicalFinancialCommitFatalError(
      "Canonical Financial Commit execution accepts canonicalLedgerDir only.",
    );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(
  error: unknown,
  stage: CanonicalFinancialCommitExecutionStage,
): string {
  if (error instanceof CanonicalFinancialCommitCancelledError) return "cancelled";
  if (error instanceof CanonicalFinancialCommitCapabilityError)
    return error.code;
  if (error instanceof CanonicalBusyRetryExhaustedError)
    return "writer-serialization";
  if (error instanceof CanonicalSourceCaptureAdmissionError)
    return `admission-${error.code}`;
  if (error instanceof CanonicalFinancialCommitFatalError) return "run-fatal";
  if (error instanceof CanonicalFinancialCommitItemError) return "item-failure";
  const text = errorText(error);
  if (/schema|lifecycle|capability/i.test(text)) return "schema-or-capability";
  if (/database|sqlite|foreign key|integrity/i.test(text)) return "database";
  if (/writer|queue|busy|locked/i.test(text)) return "writer-serialization";
  if (/disk|i\/o|eacces|eexist|enoent|file/i.test(text)) return "storage-io";
  if (/transaction|commit|rollback/i.test(text)) return "transaction";
  return stage === "relation-resolution"
    ? "relation-resolution-failed"
    : stage === "admission"
      ? "admission-failed"
      : "commit-failed";
}

function diagnosticMessage(
  stage: CanonicalFinancialCommitExecutionStage,
  code: string,
): string {
  return `Canonical ${stage} failed (${code}).`;
}

function diagnosticFor(
  item: Pick<CanonicalFinancialCommitItem<unknown>, "provider" | "product" | "itemKey">,
  stage: CanonicalFinancialCommitExecutionStage,
  error: unknown,
): CanonicalFinancialCommitDiagnostic {
  const code = errorCode(error, stage);
  return Object.freeze({
    provider: safeLabel(item.provider, "unknown-provider"),
    product: safeLabel(item.product, "unknown-product"),
    itemKey: safeIdentity(item.itemKey, "unknown-item"),
    stage,
    errorCode: code,
    message: diagnosticMessage(stage, code),
  });
}

function runDiagnostic(
  request: Pick<CanonicalFinancialCommitRunRequest<unknown>, "provider" | "product">,
  stage: CanonicalFinancialCommitExecutionStage,
  error: unknown,
): CanonicalFinancialCommitDiagnostic {
  return diagnosticFor(
    {
      provider: request.provider ?? "canonical",
      product: request.product ?? "financial",
      itemKey: "run",
    },
    stage,
    error,
  );
}

function failureKind(
  error: unknown,
  classify?: (error: unknown) => CanonicalFinancialCommitFailureKind,
): CanonicalFinancialCommitFailureKind {
  // Infrastructure failures fail closed before consulting a domain classifier.
  // A mistaken or malicious adapter must not downgrade a database, schema,
  // writer, transaction, or capability failure into a recoverable item error.
  if (error instanceof CanonicalFinancialCommitCapabilityError) return "fatal";
  if (error instanceof CanonicalFinancialCommitFatalError) return "fatal";
  if (error instanceof CanonicalBusyRetryExhaustedError) return "fatal";
  if (error instanceof CanonicalSourceCaptureAdmissionError)
    if (error.reason === "infrastructure") return "fatal";
  const text = errorText(error);
  if (
    /schema|lifecycle|capability|database|sqlite|disk|i\/o|eacces|eexist|enoent|file|writer|queue|busy|locked|transaction|commit|rollback|foreign key|integrity/i.test(
      text,
    )
  )
    return "fatal";

  // Only domain validation/admission failures may be classified by the
  // provider after the infrastructure checks above have passed.
  if (classify) {
    const result = classify(error);
    if (result === "item" || result === "fatal") return result;
  }
  if (error instanceof CanonicalFinancialCommitItemError) return "item";
  if (error instanceof CanonicalSourceCaptureAdmissionError) return "item";
  if (/validation|admission|capture|evidence|completeness|identity|conflict|occurrence|unsupported|incomplete|invalid/i.test(text))
    return "item";
  // Unknown persistence failures fail closed rather than being reported as a
  // recoverable item failure.
  return "fatal";
}

function assertItem<T>(value: unknown): asserts value is CanonicalFinancialCommitItem<T> {
  if (value === null || typeof value !== "object")
    throw new CanonicalFinancialCommitItemError("Canonical commit item is invalid.");
  const item = value as Partial<CanonicalFinancialCommitItem<T>>;
  if (
    typeof item.provider !== "string" ||
    typeof item.product !== "string" ||
    typeof item.itemKey !== "string" ||
    typeof item.commit !== "function"
  )
    throw new CanonicalFinancialCommitItemError(
      "Canonical commit item must provide provider, product, itemKey, and commit.",
    );
  if (item.resolveRelations !== undefined && typeof item.resolveRelations !== "function")
    throw new CanonicalFinancialCommitItemError(
      "Canonical commit relation resolver must be a function.",
    );
}

function writerView(
  store: CanonicalSourceStore,
): CanonicalFinancialCommitWriterStore {
  return Object.freeze({
    db: store.db,
    commitClock: store.commitClock,
    withWriter<T>(operation: () => T, runtime?: CanonicalRuntimeOptions): Promise<T> {
      // The execution seam already owns the per-commit writer turn and the
      // active transaction.  Re-entering the store queue here would deadlock
      // (the outer turn is awaiting this callback), so a transaction-scoped
      // writer executes inline and deliberately ignores retry policy.  The
      // runtime argument remains accepted for structural compatibility with
      // existing typed writers; the outer commit boundary remains the only
      // retry-free serialization point.
      void runtime;
      return Promise.resolve().then(operation);
    },
  });
}

function relationWriterView(
  store: CanonicalSourceStore,
): CanonicalFinancialCommitWriterStore {
  return Object.freeze({
    db: store.db,
    commitClock: store.commitClock,
    withWriter<T>(operation: () => T, runtime?: CanonicalRuntimeOptions): Promise<T> {
      // Relation resolution runs after the Capture transaction and therefore
      // may use the store queue normally.  It still must not retry a failed
      // write: a resolver warning cannot establish whether a partial write
      // became visible.
      return store.withWriter(operation, {
        ...runtime,
        maxAttempts: 1,
      });
    },
  });
}

type RecordedAdmission = {
  results: CanonicalSourceCaptureAdmissionTransactionResult[];
};

/**
 * Keep the lifecycle capability opaque while adding the execution contract's
 * admission accounting.  The underlying capability remains the object minted
 * by Source Capture Admission; only its `admit` operation is wrapped, so all
 * legacy in-transaction helpers continue to use their existing signature.
 * One item may admit multiple distinct Source Captures as one atomic group.
 */
function recordingAdmissionCapability(
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
  state: RecordedAdmission,
): CanonicalSourceCaptureAdmissionTransactionCapability {
  const admit = (
    ...args: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["admit"]>
  ): ReturnType<CanonicalSourceCaptureAdmissionTransactionCapability["admit"]> => {
    const result = capability.admit(...args);
    state.results.push(result);
    return result;
  };
  return Object.freeze({ ...capability, admit }) as CanonicalSourceCaptureAdmissionTransactionCapability;
}

function requireRecordedAdmissions(
  state: RecordedAdmission,
): readonly CanonicalSourceCaptureAdmissionTransactionResult[] {
  if (state.results.length === 0)
    throw new CanonicalFinancialCommitCapabilityError(
      "A Canonical Financial Commit item must admit at least one Source Capture.",
    );
  return Object.freeze([...state.results]);
}

function admissionSummary(
  result: CanonicalSourceCaptureAdmissionTransactionResult,
): CanonicalFinancialCommitAdmissionSummary {
  return Object.freeze({
    captureId: result.receipt.captureId,
    commitSequence: result.receipt.knowledgePoint,
  });
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (cancelled(signal)) throw new CanonicalFinancialCommitCancelledError();
}

/**
 * Serialize one short lifecycle-open or active-commit operation for a ledger.
 * The caller's provider run, async item source, and post-commit resolver stay
 * outside this gate.
 */
async function withLedgerOperation<T>(
  ledgerDir: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previous = LEDGER_OPERATION_QUEUES.get(ledgerDir) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn);
  LEDGER_OPERATION_QUEUES.set(ledgerDir, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (LEDGER_OPERATION_QUEUES.get(ledgerDir) === queued)
      LEDGER_OPERATION_QUEUES.delete(ledgerDir);
  }
}

/** Serialize the lifecycle-created handle open without holding the gate for
 * the lifetime of the returned handle. */
async function openStore(
  ledgerDir: string,
  options: Parameters<typeof createCanonicalSourceStore>[1],
  runtime?: CanonicalRuntimeOptions,
): Promise<CanonicalSourceStore> {
  return withLedgerOperation(ledgerDir, () => {
    const hasExplicitRuntime =
      runtime !== undefined &&
      Object.values(runtime).some((value) => value !== undefined);
    if (!hasExplicitRuntime)
      return createCanonicalSourceStore(ledgerDir, options);

    // `createCanonicalSourceStore` intentionally owns construction, but its
    // historical open path does not accept runtime options. Probe the
    // lifecycle with the caller's busy/retry policy before creating the one
    // run handle. A failed probe has no handle or visibility to retry, so the
    // canonical writer retry semantics are safe here. The probe and actual
    // handle creation remain inside the same ledger gate.
    return withCanonicalWriterQueue(
      canonicalDatabaseWriterKey(ledgerDir),
      () => {
        const probe = openCanonicalDatabaseHandle(ledgerDir, { runtime });
        probe.close();
        return createCanonicalSourceStore(ledgerDir, options);
      },
      runtime,
    );
  });
}

/**
 * Serialize only the active SQLite transaction for a ledger path.  The
 * lifecycle writer queue is still the final authority for a store, but this
 * module-level queue also covers independent handles opened by concurrent
 * provider runs.  Relation resolution deliberately happens after this scope
 * so network or other operational work never holds the commit turn.
 */
async function withSerializedCommit<T>(
  ledgerDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLedgerOperation(ledgerDir, operation);
}

async function executeItem<T>(
  store: CanonicalSourceStore,
  item: CanonicalFinancialCommitItem<T>,
  signal: AbortSignal | undefined,
  ledgerDir: string,
): Promise<CanonicalFinancialCommitItemResult<T>> {
  const writer = writerView(store);
  const relationWriter = relationWriterView(store);
  const committed = await withSerializedCommit(ledgerDir, () =>
    withCanonicalSourceCaptureAdmissionTransaction(
      store,
      async (admission) => {
        throwIfCancelled(signal);
        const state: RecordedAdmission = { results: [] };
        const recordingAdmission = recordingAdmissionCapability(admission, state);
        const transaction = Object.freeze({
          database: store.db,
          admission: recordingAdmission,
          writer,
          throwIfCancelled: () => throwIfCancelled(signal),
        }) satisfies CanonicalFinancialCommitTransaction;
        const value = await item.commit(transaction);
        // Check after the domain callback and before the helper commits.  An
        // abort during a long adapter operation therefore rolls back this item.
        throwIfCancelled(signal);
        const admissions = requireRecordedAdmissions(state);
        return {
          value,
          admissionSummaries: Object.freeze(admissions.map(admissionSummary)),
        };
      },
    ),
  );

  const relationWarnings: CanonicalFinancialCommitDiagnostic[] = [];
  if (item.resolveRelations) {
    try {
      await item.resolveRelations({
        provider: item.provider,
        product: item.product,
        itemKey: item.itemKey,
        result: committed.value,
        admissionSummaries: committed.admissionSummaries,
        database: store.db,
        writer: relationWriter,
      });
    } catch (error) {
      // Relation follow-through is deliberately fail-soft and post-commit.
      const diagnostic = diagnosticFor(item, "relation-resolution", error);
      relationWarnings.push(diagnostic);
    }
  }
  return Object.freeze({
    itemKey: item.itemKey,
    provider: item.provider,
    product: item.product,
    status: "committed" as const,
    admissionSummaries: committed.admissionSummaries,
    value: committed.value,
    relationWarnings: Object.freeze(relationWarnings),
  });
}

function aggregateStatus<T>(
  results: readonly CanonicalFinancialCommitItemResult<T>[],
  fatal: boolean,
  wasCancelled: boolean,
): CanonicalFinancialCommitRunStatus {
  if (wasCancelled) return "cancelled";
  if (fatal) return "failed";
  const committed = results.filter((item) => item.status === "committed").length;
  const failed = results.length - committed;
  if (failed === 0) return "completed";
  return committed > 0 ? "partially-completed" : "failed";
}

/**
 * Execute provider Captures against one lifecycle-created store.  The store
 * is opened once for the run and closed on every exit path; each item enters
 * its own admission transaction and writer-queue turn.
 */
export async function executeCanonicalFinancialCommitRun<T>(
  request: CanonicalFinancialCommitRunRequest<T>,
): Promise<CanonicalFinancialCommitRunResult<T>> {
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.canonicalLedgerDir !== "string" ||
    request.canonicalLedgerDir.trim() === ""
  )
    throw new CanonicalFinancialCommitFatalError(
      "Canonical ledger directory is required.",
    );
  rejectLegacyLedgerAliases(request);
  const canonicalLedgerDir = request.canonicalLedgerDir.trim();

  const diagnostics: CanonicalFinancialCommitDiagnostic[] = [];
  const results: CanonicalFinancialCommitItemResult<T>[] = [];
  let fatal = false;
  let wasCancelled = cancelled(request.signal);
  if (wasCancelled) {
    diagnostics.push(runDiagnostic(request, "cancellation", new CanonicalFinancialCommitCancelledError()));
    return Object.freeze({
      status: "cancelled" as const,
      items: Object.freeze(results),
      diagnostics: Object.freeze(diagnostics),
      committedCount: 0,
      failedCount: 0,
    });
  }

  let store: CanonicalSourceStore;
  try {
    store = await openStore(
      canonicalLedgerDir,
      {
        commitClock: request.commitClock,
        writerRuntime: {
          ...request.runtime,
          // See writerView: this execution seam never retries a commit.
          maxAttempts: 1,
        },
      },
      request.runtime,
    );
  } catch (error) {
    // Open failure happens before a run handle exists, so the explicit
    // pre-handle retry policy is safe to apply while still returning the same
    // structured run result used by all other fatal failures.
    diagnostics.push(runDiagnostic(request, "run", error));
    return Object.freeze({
      status: "failed" as const,
      items: Object.freeze(results),
      diagnostics: Object.freeze(diagnostics),
      committedCount: 0,
      failedCount: 0,
    });
  }

  try {
    try {
      for await (const candidate of request.items) {
        if (cancelled(request.signal)) {
          wasCancelled = true;
          diagnostics.push(
            runDiagnostic(request, "cancellation", new CanonicalFinancialCommitCancelledError()),
          );
          break;
        }

        let item: CanonicalFinancialCommitItem<T>;
        try {
          assertItem<T>(candidate);
          item = candidate;
        } catch (error) {
          const fallback = {
            provider: request.provider ?? "canonical",
            product: request.product ?? "financial",
            itemKey: "invalid-item",
          } satisfies Pick<CanonicalFinancialCommitItem<unknown>, "provider" | "product" | "itemKey">;
          const diagnostic = diagnosticFor(fallback, "admission", error);
          diagnostics.push(diagnostic);
          results.push(Object.freeze({
            ...fallback,
            status: "failed" as const,
            failureKind: "item" as const,
            diagnostics: Object.freeze([diagnostic]),
          }));
          continue;
        }

        try {
          const committed = await executeItem(
            store,
            item,
            request.signal,
            canonicalLedgerDir,
          );
          results.push(committed);
          const last = results.at(-1);
          if (last?.status === "committed" && last.relationWarnings.length > 0)
            diagnostics.push(...last.relationWarnings);
          // A resolver may finish after the user cancels.  The Capture is
          // already durable, but no subsequent Capture may enter the queue;
          // retain this committed result and report the run as cancelled.
          if (cancelled(request.signal)) {
            wasCancelled = true;
            diagnostics.push(
              runDiagnostic(
                request,
                "cancellation",
                new CanonicalFinancialCommitCancelledError(),
              ),
            );
            break;
          }
        } catch (error) {
          if (error instanceof CanonicalFinancialCommitCancelledError || cancelled(request.signal)) {
            wasCancelled = true;
            const diagnostic = diagnosticFor(item, "cancellation", error);
            diagnostics.push(diagnostic);
            break;
          }
          const kind = failureKind(error, item.classifyError);
          const diagnostic = diagnosticFor(
            item,
            kind === "fatal" ? "run" : "commit",
            error,
          );
          diagnostics.push(diagnostic);
          results.push(Object.freeze({
            itemKey: item.itemKey,
            provider: item.provider,
            product: item.product,
            status: "failed" as const,
            failureKind: kind,
            diagnostics: Object.freeze([diagnostic]),
          }));
          if (kind === "fatal") {
            fatal = true;
            break;
          }
        }
      }
    } catch (error) {
      fatal = true;
      diagnostics.push(runDiagnostic(request, "run", error));
    }
  } finally {
    try {
      store.close();
    } catch (error) {
      fatal = true;
      diagnostics.push(runDiagnostic(request, "run", error));
    }
  }

  const committedCount = results.filter((item) => item.status === "committed").length;
  return Object.freeze({
    status: aggregateStatus(results, fatal, wasCancelled),
    items: Object.freeze(results),
    diagnostics: Object.freeze(diagnostics),
    committedCount,
    failedCount: results.length - committedCount,
  });
}
