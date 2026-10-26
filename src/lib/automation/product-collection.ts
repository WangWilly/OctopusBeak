import type { RunEventOutcome } from "./run-event.ts";
import { CommitOutcomeUnknownError, commitRefused } from "./commit-attempt.ts";
import type {
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import type { PGliteWorkflowCommand } from "../../ledger/pglite/workflow-client.ts";
import type { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../../ledger/pglite/workflow-commands.ts";
import { CaptchaProviderRejectedError } from "./captcha-rejection.ts";
import { SourceAccessChallengeError, SourceUnavailableError } from "./source-access.ts";
import { SourceTextIntegrityError, strictSourceText } from "./source-text.ts";
import { BrowserRuntimeConfigurationError } from "./server/browser-runtime.ts";
import { TYPED_WORKFLOW_ERROR_CODES, type TypedWorkflowErrorCode } from "./workflow-failures.ts";
import type {
  WorkflowEventCounts,
  WorkflowFinancialCommitPort,
  WorkflowProductFailure,
  WorkflowContextStage,
  WorkflowProgressActivity,
  WorkflowStage,
} from "./workflow-executor.ts";
import { sanitizeTdccProductEvidence } from "./tdcc-collection-summary.ts";
import { productRunStatus } from "./product-run-status.ts";
import type { TdccProductCollectionEvidence } from "./tdcc-collection-summary.ts";
import type { PreviewProductRun } from "../preview-sources/product-collection.ts";

/**
 * Typed against the command name so a rename fails to compile, while the
 * value import stays out of the TDCC probe's PGlite-free module graph.
 */
const SOURCE_ADMIT_COMMAND: typeof PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND = "financial.source.admit";

/** The product IDs currently used by the app-owned multi-product workflows. */
export const COLLECTION_PRODUCT_TYPE_IDS = [
  "deposit",
  "credit_card",
  "time_deposit",
  "loan",
  "foreign_currency",
  "fund",
  "domestic",
  "securities",
  "settlement",
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
  /** TDCC's validated source coverage evidence; absent for other providers. */
  collection?: TdccProductCollectionEvidence;
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
      "typeId", "status", "itemCount", "committedCount", "errorCode", "skipReason", "collection",
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

    let collection: TdccProductCollectionEvidence | undefined;
    if (candidate.collection !== undefined) {
      const evidence = sanitizeTdccProductEvidence(candidate.typeId, candidate.status, Number(candidate.itemCount), candidate.collection);
      if (!evidence) return null;
      collection = evidence;
    }

    const status = candidate.status as CollectionProductStatus;
    if (status === "skipped") {
      if (candidate.skipReason === undefined || candidate.errorCode !== undefined
        || candidate.itemCount !== 0 || candidate.committedCount !== 0 || collection !== undefined) return null;
    } else if (candidate.skipReason !== undefined) {
      return null;
    }
    if (status === "failed" && candidate.errorCode === undefined) return null;
    if (status !== "failed" && candidate.errorCode !== undefined) return null;
    if ((status === "no_data" || status === "not_held")
      && (candidate.itemCount !== 0 || candidate.committedCount !== 0)) return null;
    if (status === "success" && (candidate.committedCount !== candidate.itemCount
      || (candidate.itemCount === 0 && collection === undefined))) return null;

    seen.add(candidate.typeId);
    outcomes.push(Object.freeze({
      typeId: candidate.typeId as CollectionProductTypeId,
      status,
      itemCount: Number(candidate.itemCount),
      committedCount: Number(candidate.committedCount),
      ...(candidate.errorCode === undefined ? {} : { errorCode: candidate.errorCode as TypedWorkflowErrorCode }),
      ...(candidate.skipReason === undefined ? {} : { skipReason: candidate.skipReason as CollectionProductSkipReason }),
      ...(collection === undefined ? {} : { collection }),
    }));
  }
  return Object.freeze(outcomes);
}

export type ProductCollectionSummary = Readonly<{
  sourceCaptureCount: number;
  rowCount: number;
  /** Use only when the completed source response explicitly proves no data. */
  noDataEvidence?: boolean;
  /** The source completed with intentional exclusions and no admitted items. */
  completeWithExclusions?: boolean;
}>;

export type ProductCollectionRunSummary = Readonly<{
  products: readonly CollectionProductOutcome[];
  sourceCaptureCount: number;
  rowCount: number;
  itemCount: number;
  committedCount: number;
  /** Receipts of verified products only, when Attached Preview Products also wrote; absent means every receipt is verified. */
  verifiedCommittedCount?: number;
  /** Every verified item the run committed was a source assertion (ADR 0064); absent means false. */
  sourceOnly?: boolean;
  status: "completed" | "partial" | "failed";
}>;

export type ProductCollectionStageEvent = (
  stage: WorkflowContextStage,
  outcome: RunEventOutcome,
  code: string,
  counts?: WorkflowEventCounts,
) => Promise<void>;

/** Provider hook for reporting the start of a real source query or download. */
export type ProductCollectionActivityReporter = (
  activity: WorkflowProgressActivity,
) => Promise<void>;

/** One commit item a collector chooses; the run adds the provider (ADR 0063). */
export type ProductStageRequest = Readonly<{
  product: string;
  itemKey: string;
  command: PGliteWorkflowCommand;
  relationCommands?: PGliteWorkflowRunItem["relationCommands"];
}>;

/** What the run hands each selected product's collector. */
export type ProductCollectionHandle = Readonly<{
  /**
   * Throws `SourceTextIntegrityError` for a command whose text is not intact,
   * which fails only this product, and `ProductCollectionFatalError` for an
   * identity this product already staged, which stops the run.
   */
  stage: (...requests: readonly ProductStageRequest[]) => void;
  reportActivity: ProductCollectionActivityReporter;
  /**
   * Reports the collector's own run events. A decoding or validation failure
   * it reports names the product's failure when the collector then throws an
   * untyped error.
   */
  event: ProductCollectionStageEvent;
}>;

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

/** Preserve a completed product snapshot if cancellation wins after run() resolves with its run result. */
export function interruptedProductCollectionFromOutput(
  output: unknown,
  errorCode: "cancelled" = "cancelled",
): ProductCollectionInterruptedError | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const result = output as Readonly<{ counts?: unknown; products?: unknown }>;
  const products = sanitizeCollectionProductOutcomes(result.products);
  if (!products) return undefined;
  const counts = result.counts && typeof result.counts === "object" && !Array.isArray(result.counts)
    ? result.counts as Readonly<Record<string, unknown>>
    : {};
  const readCount = (name: string): number => isSafeCount(counts[name] as number) ? counts[name] as number : 0;
  const committedCount = products.reduce((total, product) => total + product.committedCount, 0);
  return new ProductCollectionInterruptedError(errorCode, Object.freeze({
    products,
    sourceCaptureCount: readCount("sourceCaptureCount"),
    rowCount: readCount("rowCount"),
    itemCount: readCount("itemCount"),
    committedCount,
    status: productRunStatus(products, committedCount),
  }));
}

export type CollectSelectedProductsOptions<TId extends CollectionProductTypeId> = Readonly<{
  /** The provider every staged item carries. */
  provider: string;
  /** Every product supported by the parent workflow, in stable UI order. */
  productIds: readonly TId[];
  /**
   * The caller's saved selection; no implicit all-products fallback is used.
   * It may be empty only when attached products are selected.
   */
  selectedIds: readonly TId[];
  signal: AbortSignal;
  prepare?: (typeId: TId) => Promise<void>;
  /** Must fail with a ProductCollectionFatalError if the source session is no longer valid. */
  assertSession?: () => Promise<void>;
  collect: (typeId: TId, product: ProductCollectionHandle) => Promise<ProductCollectionSummary>;
  /** Commits each non-empty, fully collected product staging group, labelled with its product type id. */
  financialCommit: WorkflowFinancialCommitPort;
  event?: ProductCollectionStageEvent;
  /** Receives a product's non-fatal failure with its error; the run itself continues. */
  productFailure?: (failure: WorkflowProductFailure) => Promise<void>;
  /** Provider-specific typed session/terminal-state errors can join the shared fatal set. */
  classifyFatal?: (error: unknown) => TypedWorkflowErrorCode | undefined;
  /** Names a recoverable product failure more precisely than source-collection-failed. */
  classifyFailure?: (error: unknown) => TypedWorkflowErrorCode | undefined;
  /**
   * Collects the selected Attached Preview Products (ADR 0051) after every
   * verified product has run. Build it with `attachedPreviewRun`; it is
   * absent when none is selected.
   */
  attached?: () => Promise<PreviewProductRun>;
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

function typedProductFailureCode(error: unknown): TypedWorkflowErrorCode | undefined {
  if (error instanceof SourceTextIntegrityError) return "source-integrity-failed";
  if (error instanceof SourceAccessChallengeError) return "source-access-challenged";
  if (error instanceof SourceUnavailableError) return "source-unavailable";
  if (error instanceof BrowserRuntimeConfigurationError) return "browser-runtime-config-failed";
  if (error instanceof CaptchaProviderRejectedError) return "captcha-provider-rejected";
  return undefined;
}

/** The failed stages a collector reported, as the host would read them from run events (ADR 0058). */
function failedStageCode(failed: ReadonlySet<WorkflowContextStage>): TypedWorkflowErrorCode | undefined {
  if (failed.has("decoding")) return "source-integrity-failed";
  if (failed.has("validation")) return "source-validation-failed";
  return undefined;
}

function validateSelection<TId extends CollectionProductTypeId>(
  productIds: readonly TId[],
  selectedIds: readonly TId[],
  attachedSelected: boolean,
): void {
  if (productIds.length === 0 || new Set(productIds).size !== productIds.length) {
    throw new ProductCollectionFatalError("workflow-failed");
  }
  const supported = new Set(productIds);
  if ((selectedIds.length === 0 && !attachedSelected) || new Set(selectedIds).size !== selectedIds.length
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
  return Object.freeze({
    products: Object.freeze([...outcomes]),
    sourceCaptureCount,
    rowCount,
    itemCount,
    committedCount,
    status: productRunStatus(outcomes, committedCount),
  });
}

function itemIdentity(item: Pick<PGliteWorkflowRunItem, "provider" | "product" | "itemKey">): string {
  return JSON.stringify([item.provider, item.product, item.itemKey]);
}

/** Accepts one product's items into its private commit group (ADR 0063). */
function productStager(provider: string, staged: PGliteWorkflowRunItem[]): ProductCollectionHandle["stage"] {
  const identities = new Set<string>();
  return (...requests) => {
    for (const request of requests) {
      const item: PGliteWorkflowRunItem = Object.freeze({ ...request, provider });
      const identity = itemIdentity(item);
      if (!provider || !item.product || !item.itemKey || identities.has(identity)) {
        throw new ProductCollectionFatalError("workflow-failed");
      }
      strictSourceText.assertIntact(JSON.stringify(item.command));
      identities.add(identity);
      staged.push(item);
    }
  };
}

/**
 * Collect and commit one product at a time. Every collector stages into a
 * private commit group so a failure cannot leak incomplete items into another
 * product's commit. A product's own related evidence remains one commit group.
 */
export async function collectSelectedProducts<TId extends CollectionProductTypeId>(
  options: CollectSelectedProductsOptions<TId>,
): Promise<ProductCollectionRunSummary> {
  const { productIds, selectedIds, signal } = options;
  validateSelection(productIds, selectedIds, options.attached !== undefined);
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
  let firstFailure: unknown = null;
  let committedAny = false;
  let committedOnlySourceAssertions = true;

  const orderedOutcomes = () => productIds.map((typeId) => completedByType.get(typeId)
    ?? createOutcome(typeId, "skipped", 0, 0, { skipReason: "not_attempted" }));

  for (const typeId of selectedIds) {
    if (signal.aborted) {
      throw new ProductCollectionInterruptedError("cancelled", summarize(
        orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
      ));
    }
    const stagedItems: PGliteWorkflowRunItem[] = [];
    const codePrefix = slug(typeId);
    let sourceCountForProduct = 0;
    let rowsForProduct = 0;
    let productItemCount = 0;
    let lastStage: WorkflowStage = "collection";
    const failedStages = new Set<WorkflowContextStage>();
    const collectorEvent: ProductCollectionStageEvent = async (stage, outcome, code, counts) => {
      if (outcome === "failed") failedStages.add(stage);
      await options.event?.(stage, outcome, code, counts);
    };
    const emitProductEvent = (
      stage: WorkflowContextStage,
      outcome: RunEventOutcome,
      code: string,
      counts?: WorkflowEventCounts,
    ) => {
      lastStage = stage;
      return options.event?.(stage, outcome, code, { ...counts, statementType: typeId });
    };

    try {
      await options.assertSession?.();
      await options.prepare?.(typeId);
      await emitProductEvent("collection", "started", `${codePrefix}-collection-started`, { activity: "query" });
      const reportActivity: ProductCollectionActivityReporter = async (activity) => {
        await emitProductEvent("collection", "advanced", `${codePrefix}-collection-${activity}-started`, { activity });
      };
      const collected = await options.collect(typeId, {
        stage: productStager(options.provider, stagedItems),
        reportActivity,
        event: collectorEvent,
      });
      await options.assertSession?.();

      if (!isSafeCount(collected.sourceCaptureCount)
        || !isSafeCount(collected.rowCount)
        || (collected.noDataEvidence !== undefined && typeof collected.noDataEvidence !== "boolean")
        || (collected.completeWithExclusions !== undefined && typeof collected.completeWithExclusions !== "boolean")
        || (collected.completeWithExclusions === true
          && (stagedItems.length !== 0 || collected.noDataEvidence === true))) {
        throw new ProductCollectionFatalError("workflow-failed");
      }
      sourceCountForProduct = collected.sourceCaptureCount;
      rowsForProduct = collected.rowCount;
      productItemCount = stagedItems.length;
      signal.throwIfAborted();

      if (stagedItems.length === 0) {
        if (collected.completeWithExclusions === true) {
          sourceCaptureCount += sourceCountForProduct;
          rowCount += rowsForProduct;
          completedByType.set(typeId, createOutcome(typeId, "success"));
          await emitProductEvent("collection", "completed", `${codePrefix}-collection-completed-with-exclusions`, {
            completed: sourceCountForProduct,
            total: sourceCountForProduct,
          });
          if (signal.aborted) {
            throw new ProductCollectionInterruptedError("cancelled", summarize(
              orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
            ));
          }
        } else if (collected.noDataEvidence === true) {
          sourceCaptureCount += sourceCountForProduct;
          rowCount += rowsForProduct;
          completedByType.set(typeId, createOutcome(typeId, "no_data"));
          await emitProductEvent("collection", "completed", `${codePrefix}-collection-no-data`);
          if (signal.aborted) {
            throw new ProductCollectionInterruptedError("cancelled", summarize(
              orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
            ));
          }
        } else {
          completedByType.set(typeId, createOutcome(typeId, "failed", 0, 0, {
            errorCode: "source-collection-failed",
          }));
          await emitProductEvent("validation", "failed", `${codePrefix}-source-validation-rejected`);
        }
        continue;
      }

      itemCount += productItemCount;
      sourceCaptureCount += sourceCountForProduct;
      rowCount += rowsForProduct;
      await emitProductEvent("collection", "completed", `${codePrefix}-collection-completed`, {
        completed: sourceCountForProduct,
        total: sourceCountForProduct,
      });
      await emitProductEvent("decoding", "completed", `${codePrefix}-source-decoding-completed`, {
        completed: sourceCountForProduct,
        total: sourceCountForProduct,
      });
      await emitProductEvent("validation", "completed", `${codePrefix}-source-validation-completed`, {
        completed: productItemCount,
        total: productItemCount,
      });
      let commitResult: PGliteWorkflowRunResult<unknown>;
      // The commit port reports this stage and has already verified the receipts (ADR 0056).
      lastStage = "commit";
      committedAny = true;
      committedOnlySourceAssertions &&= stagedItems.every((item) => item.command.kind === SOURCE_ADMIT_COMMAND);
      try {
        commitResult = await options.financialCommit.execute(stagedItems, {
          provider: options.provider,
          product: typeId,
          signal,
        });
      } catch (error) {
        // Only the commit port knows a request may have landed; any other error
        // committed nothing. A cancellation stays a cancellation; an unrecorded
        // start means the run cannot record commits, so no later product may try.
        if (!(error instanceof CommitOutcomeUnknownError)) {
          if (signal.aborted) throw error;
          throw new ProductCollectionFatalError("workflow-failed");
        }
        committedCount += error.committedCount;
        const commitFailure = createOutcome(typeId, "failed", productItemCount, error.committedCount, {
          errorCode: "commit-outcome-unknown",
        });
        completedByType.set(typeId, commitFailure);
        const partialSummary = summarize(orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount);
        throw new ProductCollectionInterruptedError("commit-outcome-unknown", partialSummary);
      }

      const receiptsForProduct = commitResult.committedCount;
      committedCount += receiptsForProduct;
      if (commitResult.status === "cancelled" || commitRefused(commitResult)) {
        // A refused collection scope refuses every later product as well.
        const errorCode = commitResult.status === "cancelled" ? "cancelled" : "collection-scope-changed";
        completedByType.set(typeId, createOutcome(typeId, "failed", productItemCount, receiptsForProduct, {
          errorCode,
        }));
        throw new ProductCollectionInterruptedError(errorCode, summarize(
          orderedOutcomes(), sourceCaptureCount, rowCount, itemCount, committedCount,
        ));
      }
      if (commitResult.status !== "completed") {
        // Each rejected item names its admission rule; there is no error to rethrow.
        const rejections = commitResult.items.flatMap((item) => item.status === "failed"
          ? [item.diagnostics.find((diagnostic) => diagnostic.reason)?.reason]
          : []);
        // A store waiting for a Canonical Reset refuses the product until the
        // person deletes the old data; the other products still collect.
        const errorCode = rejections.includes("canonical-reset-required")
          ? "canonical-reset-required"
          : "canonical-commit-failed";
        completedByType.set(typeId, createOutcome(typeId, "failed", productItemCount, receiptsForProduct, {
          errorCode,
        }));
        for (const reason of rejections) {
          await options.productFailure?.({
            stage: "commit",
            statementType: typeId,
            errorCode,
            error: undefined,
            ...(reason ? { reason } : {}),
          });
        }
        continue;
      }

      completedByType.set(typeId, createOutcome(typeId, "success", productItemCount, receiptsForProduct));
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
        await emitProductEvent("collection", "advanced", `${codePrefix}-component-${error.disposition.replaceAll("_", "-")}`);
      } else {
        const errorCode = options.classifyFailure?.(error)
          ?? typedProductFailureCode(error)
          ?? failedStageCode(failedStages)
          ?? "source-collection-failed";
        firstFailure ??= error;
        completedByType.set(typeId, createOutcome(typeId, "failed", 0, 0, { errorCode }));
        await options.productFailure?.({ stage: lastStage, statementType: typeId, errorCode, error });
        await emitProductEvent("validation", "failed", `${codePrefix}-source-validation-rejected`);
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
  const finished = finishProductCollectionRun(
    { ...summary, sourceOnly: committedAny && committedOnlySourceAssertions },
    firstFailure,
    options.attached ? await options.attached() : null,
    signal,
  );
  if (selectedIds.length > 0) {
    await options.event?.("validation", "completed", "source-validation-completed", {
      completed: finished.sourceCaptureCount,
      total: finished.sourceCaptureCount,
    });
  }
  return finished;
}

/**
 * Combines the verified and attached results and ends the run. Counts keep
 * their units: preview accounts are commit items, never Source Captures. A run
 * in which nothing produced durable data throws with the combined summary, so
 * the failed product's own code reaches the host.
 */
function finishProductCollectionRun(
  verified: ProductCollectionRunSummary,
  verifiedFailure: unknown,
  attached: PreviewProductRun | null,
  signal: AbortSignal,
): ProductCollectionRunSummary {
  const products = Object.freeze([...verified.products, ...(attached?.products ?? [])]);
  const committed = products.reduce((total, product) => total + product.committedCount, 0);
  const summary: ProductCollectionRunSummary = Object.freeze({
    products,
    sourceCaptureCount: verified.sourceCaptureCount,
    rowCount: verified.rowCount + (attached?.receipts.reduce((total, receipt) => total + receipt.transactions, 0) ?? 0),
    itemCount: products.reduce((total, product) => total + product.itemCount, 0),
    committedCount: committed,
    ...(attached ? { verifiedCommittedCount: verified.committedCount } : {}),
    ...(verified.sourceOnly ? { sourceOnly: true } : {}),
    status: productRunStatus(products, committed),
  });
  // An uncertain commit remains a failure even when cancellation also wins.
  const interruption = attached?.interrupted;
  if (interruption && (interruption.errorCode === "commit-outcome-unknown" || !signal.aborted)) {
    throw withCause(new ProductCollectionInterruptedError(interruption.errorCode, summary), interruption.error);
  }
  if (signal.aborted || interruption) {
    throw withCause(new ProductCollectionInterruptedError("cancelled", summary), signal.reason ?? interruption?.error);
  }
  if (summary.status !== "failed") return summary;
  const failedVerified = verified.products.find((product) => product.status === "failed");
  if (failedVerified) {
    throw withCause(
      new ProductCollectionInterruptedError(failedVerified.errorCode ?? "source-collection-failed", summary),
      verifiedFailure,
    );
  }
  const attempted = products.filter((product) => product.status !== "skipped");
  if (attempted.length === 1 && attached?.firstFailure != null) throw attached.firstFailure;
  const failed = products.find((product) => product.status === "failed");
  throw withCause(
    new ProductCollectionInterruptedError(failed?.errorCode ?? "source-collection-failed", summary),
    attached?.firstFailure,
  );
}

function withCause(error: ProductCollectionInterruptedError, cause: unknown): ProductCollectionInterruptedError {
  if (cause !== null && cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
