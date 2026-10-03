import type {
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import { CaptchaProviderRejectedError } from "./captcha-rejection.ts";
import { SourceAccessChallengeError, SourceUnavailableError } from "./source-access.ts";
import { SourceTextIntegrityError } from "./source-text.ts";
import { BrowserRuntimeConfigurationError } from "./server/browser-runtime.ts";
import { TYPED_WORKFLOW_ERROR_CODES, type TypedWorkflowErrorCode } from "./workflow-failures.ts";
import type { WorkflowStage } from "./workflow-executor.ts";

/** The product IDs currently used by the app-owned multi-product workflows. */
export const COLLECTION_PRODUCT_TYPE_IDS = [
  "deposit",
  "credit_card",
  "loan",
  "foreign_currency",
  "fund",
  "domestic",
] as const;

export type CollectionProductTypeId = typeof COLLECTION_PRODUCT_TYPE_IDS[number];
export type CollectionProductStatus = "success" | "no_data" | "not_held" | "failed" | "skipped";
export type CollectionProductSkipReason = "not_selected" | "not_attempted";

export type CollectionProductOutcome = Readonly<{
  typeId: CollectionProductTypeId;
  status: CollectionProductStatus;
  /** Complete commit items produced by this product's staged collection. */
  itemCount: number;
  /** Commit items with durable receipts, including before a later fatal stop. */
  committedCount: number;
  errorCode?: TypedWorkflowErrorCode;
  skipReason?: CollectionProductSkipReason;
}>;

const supportedProductTypeIds = new Set<string>(COLLECTION_PRODUCT_TYPE_IDS);
const safeWorkflowErrorCodes = new Set<string>(TYPED_WORKFLOW_ERROR_CODES);

/** Strictly retain the bounded, non-financial product result contract. */
export function sanitizeCollectionProductOutcomes(
  value: unknown,
): readonly CollectionProductOutcome[] | null {
  if (!Array.isArray(value) || value.length > COLLECTION_PRODUCT_TYPE_IDS.length) return null;
  const seen = new Set<string>();
  const outcomes: CollectionProductOutcome[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => ![
      "typeId", "status", "itemCount", "committedCount", "errorCode", "skipReason",
    ].includes(key))) return null;
    if (typeof candidate.typeId !== "string" || !supportedProductTypeIds.has(candidate.typeId)
      || seen.has(candidate.typeId)) return null;
    if (typeof candidate.status !== "string"
      || !["success", "no_data", "not_held", "failed", "skipped"].includes(candidate.status)) return null;
    if (!isSafeCount(candidate.itemCount as number) || !isSafeCount(candidate.committedCount as number)
      || Number(candidate.committedCount) > Number(candidate.itemCount)) return null;
    if (candidate.errorCode !== undefined
      && (typeof candidate.errorCode !== "string" || !safeWorkflowErrorCodes.has(candidate.errorCode))) return null;
    if (candidate.skipReason !== undefined
      && candidate.skipReason !== "not_selected" && candidate.skipReason !== "not_attempted") return null;

    const status = candidate.status as CollectionProductStatus;
    if (status === "skipped") {
      if (candidate.skipReason === undefined || candidate.errorCode !== undefined
        || candidate.itemCount !== 0 || candidate.committedCount !== 0) return null;
    } else if (candidate.skipReason !== undefined) {
      return null;
    }
    if (status === "failed" && candidate.errorCode === undefined) return null;
    if (status !== "failed" && candidate.errorCode !== undefined) return null;
    if ((status === "no_data" || status === "not_held")
      && (candidate.itemCount !== 0 || candidate.committedCount !== 0)) return null;
    if (status === "success" && (candidate.itemCount === 0
      || candidate.committedCount !== candidate.itemCount)) return null;

    seen.add(candidate.typeId);
    outcomes.push(Object.freeze({
      typeId: candidate.typeId as CollectionProductTypeId,
      status,
      itemCount: Number(candidate.itemCount),
      committedCount: Number(candidate.committedCount),
      ...(candidate.errorCode === undefined ? {} : { errorCode: candidate.errorCode as TypedWorkflowErrorCode }),
      ...(candidate.skipReason === undefined ? {} : { skipReason: candidate.skipReason as CollectionProductSkipReason }),
    }));
  }
  return Object.freeze(outcomes);
}

export type ProductCollectionSummary = Readonly<{
  sourceCaptureCount: number;
  rowCount: number;
  /** Must equal the number of items appended to the product staging array. */
  itemCount: number;
  /** Use only when the completed source response explicitly proves no data. */
  noDataEvidence?: boolean;
}>;

export type ProductCollectionRunSummary = Readonly<{
  products: readonly CollectionProductOutcome[];
  sourceCaptureCount: number;
  rowCount: number;
  itemCount: number;
  committedCount: number;
  status: "completed" | "partial" | "failed";
}>;

export type ProductCollectionStageEvent = (
  stage: WorkflowStage,
  code: string,
  counts?: Readonly<{ completed?: number; total?: number }>,
) => Promise<void>;

/** Explicit evidence classification for a selected product with no records. */
export class StatementComponentAbsentError extends Error {
  readonly skipReason = "absent" as const;
  readonly disposition: "not_held" | "no_data" | undefined;

  constructor(message: string, disposition?: "not_held" | "no_data") {
    super(message);
    this.name = "StatementComponentAbsentError";
    this.disposition = disposition;
  }
}

/** An authenticated session, required capability, or workflow invariant failed. */
export class ProductCollectionFatalError extends Error {
  readonly errorCode: TypedWorkflowErrorCode;

  constructor(errorCode: TypedWorkflowErrorCode) {
    super("Product collection stopped because a required workflow condition failed.");
    this.name = "ProductCollectionFatalError";
    this.errorCode = errorCode;
  }
}

/** Carries only bounded, typed product results across the worker boundary. */
export class ProductCollectionInterruptedError extends Error {
  readonly errorCode: TypedWorkflowErrorCode;
  readonly summary: ProductCollectionRunSummary;

  constructor(errorCode: TypedWorkflowErrorCode, summary: ProductCollectionRunSummary) {
    super("Product collection stopped before every selected product completed.");
    this.name = "ProductCollectionInterruptedError";
    this.errorCode = errorCode;
    this.summary = summary;
  }
}

/** Preserve a completed product snapshot if cancellation wins after run() resolves. */
export function interruptedProductCollectionFromOutput(
  output: unknown,
  errorCode: "cancelled" = "cancelled",
): ProductCollectionInterruptedError | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const candidate = output as Record<string, unknown>;
  const products = sanitizeCollectionProductOutcomes(candidate.products);
  if (!products) return undefined;
  const readCount = (name: string): number => isSafeCount(candidate[name] as number)
    ? candidate[name] as number
    : 0;
  const sourceCaptureCount = readCount("sourceCaptureCount");
  const rowCount = readCount("rowCount");
  const itemCount = readCount("itemCount");
  const committedCount = products.reduce((total, product) => total + product.committedCount, 0);
  const hasFailure = products.some((product) => product.status === "failed");
  return new ProductCollectionInterruptedError(errorCode, Object.freeze({
    products,
    sourceCaptureCount,
    rowCount,
    itemCount,
    committedCount,
    status: hasFailure ? committedCount > 0 ? "partial" : "failed" : "completed",
  }));
}

export type CollectSelectedProductsOptions<
  TId extends CollectionProductTypeId,
  TItem extends PGliteWorkflowRunItem,
> = Readonly<{
  /** Every product supported by the parent workflow, in stable UI order. */
  productIds: readonly TId[];
  /** The caller's saved selection; no implicit all-products fallback is used. */
  selectedIds: readonly TId[];
  signal: AbortSignal;
  prepare?: (typeId: TId) => Promise<void>;
  /** Must fail with a ProductCollectionFatalError if the source session is no longer valid. */
  assertSession?: () => Promise<void>;
  collect: (typeId: TId, stagedItems: TItem[]) => Promise<ProductCollectionSummary>;
  /** Called once for each non-empty, fully collected product staging group. */
  commit: (typeId: TId, stagedItems: readonly TItem[]) => Promise<PGliteWorkflowRunResult<unknown>>;
  event?: ProductCollectionStageEvent;
  /** Provider-specific typed session/terminal-state errors can join the shared fatal set. */
  classifyFatal?: (error: unknown) => TypedWorkflowErrorCode | undefined;
}>;

function isSafeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function slug(typeId: string): string {
  return typeId.replaceAll("_", "-");
}

function defaultFatalCode(error: unknown): TypedWorkflowErrorCode | undefined {
  if (error instanceof ProductCollectionFatalError) return error.errorCode;
  if (error instanceof SourceAccessChallengeError) return "source-access-challenged";
  if (error instanceof SourceUnavailableError) return "source-unavailable";
  if (error instanceof BrowserRuntimeConfigurationError) return "browser-runtime-config-failed";
  if (error instanceof CaptchaProviderRejectedError) return "captcha-provider-rejected";
  return undefined;
}

function productFailureCode(error: unknown): TypedWorkflowErrorCode {
  if (error instanceof SourceTextIntegrityError) return "source-integrity-failed";
  if (error instanceof SourceAccessChallengeError) return "source-access-challenged";
  if (error instanceof SourceUnavailableError) return "source-unavailable";
  if (error instanceof BrowserRuntimeConfigurationError) return "browser-runtime-config-failed";
  if (error instanceof CaptchaProviderRejectedError) return "captcha-provider-rejected";
  return "source-collection-failed";
}

function validateSelection<TId extends CollectionProductTypeId>(
  productIds: readonly TId[],
  selectedIds: readonly TId[],
): void {
  if (productIds.length === 0 || new Set(productIds).size !== productIds.length) {
    throw new ProductCollectionFatalError("workflow-failed");
  }
  const supported = new Set(productIds);
  if (selectedIds.length === 0 || new Set(selectedIds).size !== selectedIds.length
    || selectedIds.some((typeId) => !supported.has(typeId))) {
    throw new ProductCollectionFatalError("workflow-failed");
  }
}

function createOutcome(
  typeId: CollectionProductTypeId,
  status: CollectionProductStatus,
  itemCount = 0,
  committedCount = 0,
  extras: Readonly<Pick<CollectionProductOutcome, "errorCode" | "skipReason">> = {},
): CollectionProductOutcome {
  return Object.freeze({ typeId, status, itemCount, committedCount, ...extras });
}

function summarize(
  outcomes: readonly CollectionProductOutcome[],
  sourceCaptureCount: number,
  rowCount: number,
  itemCount: number,
  committedCount: number,
): ProductCollectionRunSummary {
  const failed = outcomes.some((outcome) => outcome.status === "failed");
  return Object.freeze({
    products: Object.freeze([...outcomes]),
    sourceCaptureCount,
    rowCount,
    itemCount,
    committedCount,
    status: failed ? committedCount > 0 ? "partial" : "failed" : "completed",
  });
}

function countCommittedItems(result: PGliteWorkflowRunResult<unknown>): number {
  return result.items.filter((item) => item.status === "committed").length;
}

function itemIdentity(item: Pick<PGliteWorkflowRunItem, "provider" | "product" | "itemKey">): string {
  return JSON.stringify([item.provider, item.product, item.itemKey]);
}

function hasUniqueStagedIdentities(items: readonly PGliteWorkflowRunItem[]): boolean {
  const identities = new Set<string>();
  for (const item of items) {
    if (!item.provider || !item.product || !item.itemKey) return false;
    const identity = itemIdentity(item);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function validateCommitReceipts(
  stagedItems: readonly PGliteWorkflowRunItem[],
  result: PGliteWorkflowRunResult<unknown>,
): Readonly<{ valid: boolean; committedCount: number }> {
  if (!hasUniqueStagedIdentities(stagedItems) || result.items.length > stagedItems.length) {
    return { valid: false, committedCount: 0 };
  }

  const returnedIdentities = new Set<string>();
  for (const [index, item] of result.items.entries()) {
    const identity = itemIdentity(item);
    if (returnedIdentities.has(identity)
      || identity !== itemIdentity(stagedItems[index]!)) {
      return { valid: false, committedCount: 0 };
    }
    returnedIdentities.add(identity);
  }

  return {
    valid: true,
    committedCount: countCommittedItems(result),
  };
}

function hasFatalCommitFailure(result: PGliteWorkflowRunResult<unknown>): boolean {
  return result.status === "cancelled"
    || result.items.some((item) => item.status === "failed" && item.failureKind === "fatal")
    || result.diagnostics.some((item) => item.stage === "run" || item.stage === "cancellation");
}

/**
 * Collect and commit one product at a time. Every collector writes into a
 * private staging array so a failure cannot leak incomplete items into another
 * product's commit. A product's own related evidence remains one commit group.
 */
export async function collectSelectedProducts<
  TId extends CollectionProductTypeId,
  TItem extends PGliteWorkflowRunItem,
>(options: CollectSelectedProductsOptions<TId, TItem>): Promise<ProductCollectionRunSummary> {
  const { productIds, selectedIds, signal } = options;
  validateSelection(productIds, selectedIds);
  const selected = new Set(selectedIds);
  const outcomes: CollectionProductOutcome[] = productIds
    .filter((typeId) => !selected.has(typeId))
    .map((typeId) => createOutcome(typeId, "skipped", 0, 0, { skipReason: "not_selected" }));
  const completedByType = new Map<CollectionProductTypeId, CollectionProductOutcome>();
  for (const outcome of outcomes) completedByType.set(outcome.typeId, outcome);

  let sourceCaptureCount = 0;
  let rowCount = 0;
  let itemCount = 0;
  let committedCount = 0;

  const orderedOutcomes = () => productIds.map((typeId) => completedByType.get(typeId)
    ?? createOutcome(typeId, "skipped", 0, 0, { skipReason: "not_attempted" }));

  for (const typeId of selectedIds) {
    if (signal.aborted) {
      throw new ProductCollectionInterruptedError("cancelled", summarize(
        orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
      ));
    }
    const stagedItems: TItem[] = [];
    const codePrefix = slug(typeId);
    let sourceCountForProduct = 0;
    let rowsForProduct = 0;
    let productItemCount = 0;

    try {
      await options.assertSession?.();
      await options.prepare?.(typeId);
      await options.event?.("collection", `${codePrefix}-collection-started`);
      const collected = await options.collect(typeId, stagedItems);
      await options.assertSession?.();

      if (!isSafeCount(collected.sourceCaptureCount)
        || !isSafeCount(collected.rowCount)
        || !isSafeCount(collected.itemCount)
        || (collected.noDataEvidence !== undefined && typeof collected.noDataEvidence !== "boolean")
        || stagedItems.length !== collected.itemCount) {
        throw new ProductCollectionFatalError("workflow-failed");
      }
      sourceCountForProduct = collected.sourceCaptureCount;
      rowsForProduct = collected.rowCount;
      productItemCount = collected.itemCount;

      if (!hasUniqueStagedIdentities(stagedItems)) {
        throw new ProductCollectionFatalError("workflow-failed");
      }
      signal.throwIfAborted();

      if (stagedItems.length === 0) {
        if (collected.noDataEvidence === true) {
          sourceCaptureCount += sourceCountForProduct;
          rowCount += rowsForProduct;
          completedByType.set(typeId, createOutcome(typeId, "no_data"));
          await options.event?.("collection", `${codePrefix}-collection-no-data`);
          if (signal.aborted) {
            throw new ProductCollectionInterruptedError("cancelled", summarize(
              orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
            ));
          }
        } else {
          completedByType.set(typeId, createOutcome(typeId, "failed", 0, 0, {
            errorCode: "source-collection-failed",
          }));
          await options.event?.("validation", `${codePrefix}-source-validation-rejected`);
        }
        continue;
      }

      itemCount += productItemCount;
      sourceCaptureCount += sourceCountForProduct;
      rowCount += rowsForProduct;
      await options.event?.("decoding", `${codePrefix}-source-decoding-completed`, {
        completed: sourceCountForProduct,
        total: sourceCountForProduct,
      });
      await options.event?.("validation", `${codePrefix}-source-validation-completed`, {
        completed: productItemCount,
        total: productItemCount,
      });
      let commitResult: PGliteWorkflowRunResult<unknown>;
      try {
        await options.event?.("commit", `${codePrefix}-canonical-commit-started`, {
          completed: 0,
          total: stagedItems.length,
        });
        commitResult = await options.commit(typeId, stagedItems);
      } catch {
        const commitFailure = createOutcome(typeId, "failed", productItemCount, 0, {
          errorCode: "commit-outcome-unknown",
        });
        completedByType.set(typeId, commitFailure);
        const partialSummary = summarize(orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount);
        throw new ProductCollectionInterruptedError("commit-outcome-unknown", partialSummary);
      }

      const validatedReceipts = validateCommitReceipts(stagedItems, commitResult);
      const receiptsForProduct = validatedReceipts.committedCount;
      const resultShapeValid = Number.isSafeInteger(commitResult.committedCount)
        && commitResult.committedCount >= 0
        && commitResult.committedCount <= stagedItems.length
        && receiptsForProduct === commitResult.committedCount
        && validatedReceipts.valid
        && (commitResult.items.length === stagedItems.length || hasFatalCommitFailure(commitResult));
      committedCount += receiptsForProduct;
      if (!resultShapeValid) {
        completedByType.set(typeId, createOutcome(typeId, "failed", productItemCount, receiptsForProduct, {
          errorCode: "commit-outcome-unknown",
        }));
        throw new ProductCollectionInterruptedError("commit-outcome-unknown", summarize(
          orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
        ));
      }

      if (hasFatalCommitFailure(commitResult)) {
        await options.event?.("commit", signal.aborted
          ? `${codePrefix}-canonical-commit-cancelled`
          : `${codePrefix}-canonical-commit-failed`, {
          completed: receiptsForProduct,
          total: stagedItems.length,
        });
        const errorCode = signal.aborted || commitResult.status === "cancelled"
          ? "cancelled"
          : "commit-outcome-unknown";
        completedByType.set(typeId, createOutcome(typeId, "failed", productItemCount, receiptsForProduct, {
          errorCode,
        }));
        throw new ProductCollectionInterruptedError(errorCode, summarize(
          orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
        ));
      }

      const fullyCommitted = commitResult.status === "completed"
        && receiptsForProduct === stagedItems.length
        && commitResult.items.every((item) => item.status === "committed");
      if (!fullyCommitted) {
        completedByType.set(typeId, createOutcome(typeId, "failed", productItemCount, receiptsForProduct, {
          errorCode: "canonical-commit-failed",
        }));
        await options.event?.("commit", `${codePrefix}-canonical-commit-failed`, {
          completed: receiptsForProduct,
          total: stagedItems.length,
        });
        continue;
      }

      completedByType.set(typeId, createOutcome(typeId, "success", productItemCount, receiptsForProduct));
      await options.event?.("commit", `${codePrefix}-canonical-commit-completed`, {
        completed: receiptsForProduct,
        total: stagedItems.length,
      });
    } catch (error) {
      if (error instanceof ProductCollectionInterruptedError) throw error;
      const fatalCode = signal.aborted
        ? "cancelled"
        : defaultFatalCode(error) ?? options.classifyFatal?.(error);
      if (fatalCode) {
        const current = completedByType.get(typeId);
        if (!current) {
          completedByType.set(typeId, createOutcome(typeId, "failed", productItemCount, 0, { errorCode: fatalCode }));
        } else if (current.status !== "failed") {
          completedByType.set(typeId, createOutcome(typeId, "failed", current.itemCount, current.committedCount, {
            errorCode: fatalCode,
          }));
        }
        if (options.assertSession && !signal.aborted) {
          try {
            await options.assertSession();
          } catch (sessionError) {
            const sessionCode = defaultFatalCode(sessionError)
              ?? options.classifyFatal?.(sessionError)
              ?? "authentication-failed";
            const existing = completedByType.get(typeId);
            completedByType.set(typeId, createOutcome(typeId, "failed", existing?.itemCount ?? 0, existing?.committedCount ?? 0, {
              errorCode: sessionCode,
            }));
            const summary = summarize(orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount);
            throw new ProductCollectionInterruptedError(sessionCode, summary);
          }
        }
        const summary = summarize(orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount);
        throw new ProductCollectionInterruptedError(fatalCode, summary);
      }

      if (error instanceof StatementComponentAbsentError && error.disposition) {
        completedByType.set(typeId, createOutcome(typeId, error.disposition));
        await options.event?.("collection", `${codePrefix}-component-${error.disposition.replaceAll("_", "-")}`);
      } else {
        const errorCode = productFailureCode(error);
        completedByType.set(typeId, createOutcome(typeId, "failed", 0, 0, { errorCode }));
        await options.event?.("validation", `${codePrefix}-source-validation-rejected`);
      }

      if (options.assertSession && !signal.aborted) {
        try {
          await options.assertSession();
        } catch (sessionError) {
          const sessionCode = defaultFatalCode(sessionError)
            ?? options.classifyFatal?.(sessionError)
            ?? "authentication-failed";
          const existing = completedByType.get(typeId);
          completedByType.set(typeId, createOutcome(typeId, "failed", existing?.itemCount ?? 0, existing?.committedCount ?? 0, {
            errorCode: sessionCode,
          }));
          const summary = summarize(orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount);
          throw new ProductCollectionInterruptedError(sessionCode, summary);
        }
      }
    }

    if (signal.aborted) {
      throw new ProductCollectionInterruptedError("cancelled", summarize(
        orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
      ));
    }
  }

  const summary = summarize(orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount);
  if (signal.aborted) throw new ProductCollectionInterruptedError("cancelled", summary);
  return summary;
}
