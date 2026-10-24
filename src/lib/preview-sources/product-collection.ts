import type { RunEventOutcome } from "../automation/run-event.ts";
import type {
  PreviewProduct,
  PreviewProductCollection,
  PreviewProductWrite,
  PreviewTimeDepositCollection,
  PreviewWrite,
  PreviewWriteReceipt,
} from "../../ledger/pglite/preview-financial-data.ts";
import { PreviewDataRejected } from "./source-id.ts";
import type { InstitutionKey } from "../institutions/institutions.ts";
import {
  ProductCollectionFatalError,
  ProductCollectionInterruptedError,
  type CollectionProductOutcome,
  type ProductCollectionRunSummary,
} from "../automation/product-collection.ts";
import { productRunStatus } from "../automation/product-run-status.ts";
import type { TypedWorkflowErrorCode } from "../automation/workflow-failures.ts";
import type { WorkflowContextStage, WorkflowEventCounts } from "../automation/workflow-executor.ts";
import { productRunResult, type ProductRunResult } from "../automation/workflow-run-result.ts";
import { PreviewSourceFailure, type PreviewFailureReason } from "./source-kit.ts";

/** Explicit provider evidence that the person holds no such product, or that it holds nothing. */
export type PreviewProductAbsence = Readonly<{ absent: "not_held" | "no_data" }>;

/**
 * What a product collector returns. A time-deposit collector must return the
 * complete list, because an empty complete list is what closes deposits.
 */
export type PreviewProductCollectorResult<P extends PreviewProduct> =
  P extends "time_deposit" ? PreviewTimeDepositCollection : PreviewProductCollection[P] | PreviewProductAbsence;

export type PreviewProductCollectors = Readonly<{
  [P in PreviewProduct]?: () => Promise<PreviewProductCollectorResult<P>>;
}>;

export type PreviewProductWriter = (write: PreviewProductWrite) => Promise<PreviewWriteReceipt>;

export type WorkflowPreviewWritePort = Readonly<{
  write(input: PreviewWrite): Promise<PreviewWriteReceipt>;
}>;

/** A writer that can only write the given source's rows. */
export function boundPreviewWriter(
  port: WorkflowPreviewWritePort,
  source: Readonly<{ sourceId: string; institution: InstitutionKey }>,
): PreviewProductWriter {
  return (write) => port.write({ sourceId: source.sourceId, institution: source.institution, ...write });
}

export type PreviewProductRunOptions = Readonly<{
  /** Every product the source declares, in Statement Selection order. */
  products: readonly PreviewProduct[];
  /** The person's selection, already reduced to products no verified source covers. */
  selected: readonly PreviewProduct[];
  collectors: PreviewProductCollectors;
  write: PreviewProductWriter;
  signal: AbortSignal;
  event?: (stage: WorkflowContextStage, outcome: RunEventOutcome, code: string, counts?: WorkflowEventCounts) => Promise<void>;
  /** Throws a session-loss failure when the signed-in session is gone. */
  assertSession?: () => Promise<void>;
}>;

export type PreviewProductRun = Readonly<{
  products: readonly CollectionProductOutcome[];
  receipts: readonly PreviewWriteReceipt[];
  /** Set when a session loss or cancellation stopped the run before every selected product ran. */
  interrupted: Readonly<{ errorCode: TypedWorkflowErrorCode; error: unknown }> | null;
  /** The first product failure, for a run in which nothing succeeded. */
  firstFailure: unknown;
}>;

const SESSION_REASONS: ReadonlySet<PreviewFailureReason> = new Set([
  "sign-in-rejected",
  "session-conflict",
  "verification-rejected",
  "verification-exhausted",
  "verification-unsupported",
  "device-registration-required",
]);

function fatalCode(error: unknown): TypedWorkflowErrorCode | null {
  if (error instanceof PreviewSourceFailure) return SESSION_REASONS.has(error.reason) ? error.errorCode : null;
  if (error instanceof ProductCollectionFatalError) return error.errorCode;
  return null;
}

function failureCode(error: unknown): TypedWorkflowErrorCode {
  if (error instanceof PreviewSourceFailure) return error.errorCode;
  if (error instanceof PreviewDataRejected) return "source-validation-failed";
  return "source-collection-failed";
}

const outcome = (
  typeId: PreviewProduct,
  status: CollectionProductOutcome["status"],
  count = 0,
  extras: Partial<Pick<CollectionProductOutcome, "errorCode" | "skipReason">> = {},
): CollectionProductOutcome => Object.freeze({ typeId, status, itemCount: count, committedCount: count, ...extras });

function collectionFor<P extends PreviewProduct>(
  product: P,
  result: PreviewProductCollectorResult<P>,
): PreviewProductWrite | PreviewProductAbsence {
  if ("absent" in result) return result;
  return { product, collection: result } as PreviewProductWrite;
}

/**
 * Runs the selected products in declared order, writing each product as soon
 * as it is collected so a later failure cannot discard it. A session loss or
 * cancellation stops the run; any other failure stays with its product.
 */
export async function collectPreviewProducts(options: PreviewProductRunOptions): Promise<PreviewProductRun> {
  const selected = new Set(options.selected);
  const done = new Map<PreviewProduct, CollectionProductOutcome>();
  const receipts: PreviewWriteReceipt[] = [];
  let firstFailure: unknown = null;
  const ordered = () => options.products.map((product) => done.get(product)
    ?? outcome(product, "skipped", 0, { skipReason: selected.has(product) ? "not_attempted" : "not_selected" }));
  const interrupted = (errorCode: TypedWorkflowErrorCode, error: unknown): PreviewProductRun =>
    ({ products: ordered(), receipts, interrupted: { errorCode, error }, firstFailure });
  const event = (
    product: PreviewProduct,
    stage: WorkflowContextStage,
    outcome: RunEventOutcome,
    code: string,
    counts?: WorkflowEventCounts,
  ) => options.event?.(stage, outcome, `${product.replaceAll("_", "-")}-${code}`, { ...counts, statementType: product });

  for (const product of options.products) {
    if (!selected.has(product)) continue;
    if (options.signal.aborted) return interrupted("cancelled", options.signal.reason);
    try {
      await options.assertSession?.();
      await event(product, "collection", "started", "collection-started", { activity: "query" });
      const collector = options.collectors[product];
      if (!collector) throw new ProductCollectionFatalError("workflow-failed");
      const result = collectionFor(product, await collector() as PreviewProductCollectorResult<typeof product>);
      if ("absent" in result) {
        done.set(product, outcome(product, result.absent));
        await event(product, "collection", "advanced", `component-${result.absent.replaceAll("_", "-")}`);
        continue;
      }
      const receipt = await options.write(result);
      receipts.push(receipt);
      if (receipt.accounts === 0) {
        done.set(product, outcome(product, "not_held"));
        await event(product, "collection", "advanced", "component-not-held");
        continue;
      }
      done.set(product, outcome(product, "success", receipt.accounts));
    } catch (error) {
      if (options.signal.aborted) return interrupted("cancelled", error);
      const fatal = fatalCode(error);
      if (fatal !== null) {
        done.set(product, outcome(product, "failed", 0, { errorCode: fatal }));
        return interrupted(fatal, error);
      }
      firstFailure ??= error;
      done.set(product, outcome(product, "failed", 0, { errorCode: failureCode(error) }));
      await event(product, "validation", "failed", "source-validation-rejected");
      if (options.assertSession) {
        try {
          await options.assertSession();
        } catch (sessionError) {
          return interrupted(fatalCode(sessionError) ?? "authentication-failed", sessionError);
        }
      }
    }
  }
  if (options.signal.aborted) return interrupted("cancelled", options.signal.reason);
  return { products: ordered(), receipts, interrupted: null, firstFailure };
}

function previewRunSummary(run: PreviewProductRun): ProductCollectionRunSummary {
  const committed = run.products.reduce((total, product) => total + product.committedCount, 0);
  return Object.freeze({
    products: run.products,
    sourceCaptureCount: 0,
    rowCount: run.receipts.reduce((total, receipt) => total + receipt.transactions, 0),
    itemCount: run.products.reduce((total, product) => total + product.itemCount, 0),
    committedCount: committed,
    status: productRunStatus(run.products, committed),
  });
}

/**
 * The workflow output for a Preview Source run. An interrupted run throws
 * with its product summary. A run in which no product produced data throws
 * the sole product's own error, so a single-product source fails exactly as
 * before, or an interrupted error carrying every product's outcome.
 */
export function previewRunOutput(run: PreviewProductRun): ProductRunResult {
  const summary = previewRunSummary(run);
  if (run.interrupted) {
    throw withCause(new ProductCollectionInterruptedError(run.interrupted.errorCode, summary), run.interrupted.error);
  }
  const attempted = run.products.filter((product) => product.status !== "skipped");
  const produced = attempted.some((product) => product.status !== "failed");
  if (attempted.length > 0 && !produced) {
    if (attempted.length === 1) throw run.firstFailure;
    const first = attempted.find((product) => product.status === "failed")!;
    throw withCause(new ProductCollectionInterruptedError(first.errorCode ?? "source-collection-failed", summary), run.firstFailure);
  }
  return productRunResult(summary, { preview: true, counts: { accountCount: summary.committedCount } });
}

function withCause<E extends Error>(error: E, cause: unknown): E {
  if (cause !== null && cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}
