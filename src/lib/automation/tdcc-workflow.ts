import {
  TDCC_PRODUCT_COLLECTORS,
  TDCC_PRODUCT_IDS,
  tdccFatalCode,
  tdccProductFailureCode,
  TdccRunSession,
  type TdccProductId,
} from "../../workflows/tdcc-epassbook-collection.ts";
import type { TdccClientOptions } from "../../workflows/tdcc-epassbook-client.ts";
import {
  collectSelectedProducts,
  ProductCollectionFatalError,
  ProductCollectionInterruptedError,
  StatementComponentAbsentError,
} from "./product-collection.ts";
import type { ProductCollectionRunSummary } from "./product-collection.ts";
import { aggregateTdccExclusionCounts, createTdccRunSummary } from "./tdcc-collection-summary.ts";
import { productRunResult } from "./workflow-run-result.ts";
import { defineWorkflow, type WorkflowDefinition } from "./workflow-executor.ts";

export type TdccWorkflowInput = Readonly<{ statementTypes: readonly TdccProductId[] }>;

export type TdccWorkflowOptions = Readonly<{
  /** Test seam; production calls TDCC with the global fetch. */
  fetch?: TdccClientOptions["fetch"];
}>;

function selectedProducts(input: unknown): TdccProductId[] {
  const statementTypes = (input as Partial<TdccWorkflowInput> | null)?.statementTypes;
  if (!Array.isArray(statementTypes)) throw new ProductCollectionFatalError("workflow-failed");
  return TDCC_PRODUCT_IDS.filter((id) => statementTypes.includes(id));
}

/**
 * TDCC e-Passbook through its App protocol (ADR 0041, 0042). Authentication
 * secrets come only from the host-owned session port.
 */
export function createTdccWorkflow(options: TdccWorkflowOptions = {}): WorkflowDefinition<TdccWorkflowInput> {
  return defineWorkflow({
    id: "sync-tdcc",
    requiresFinancialCommit: true,
    requiresTdcc: true,
  }, async (context, input: TdccWorkflowInput) => {
    const selectedIds = selectedProducts(input);
    const tdcc = context.tdcc;
    await context.event("preparation", "completed", "input-validated");
    await context.event("authentication", "started", "authentication-started");
    const lease = await tdcc.session.open();
    if (lease.status !== "ready") {
      await context.event("authentication", "advanced", "device-registration-required");
      throw new ProductCollectionFatalError("device-registration-required");
    }
    const session = new TdccRunSession(tdcc.session, lease, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      signal: context.signal,
      now: () => new Date(context.now()),
    });
    const runSummary = createTdccRunSummary(selectedIds);

    let collectedSummary: ProductCollectionRunSummary;
    try {
      collectedSummary = await collectSelectedProducts({
        provider: "tdcc",
        productIds: TDCC_PRODUCT_IDS,
        selectedIds,
        signal: context.signal,
        event: context.event,
        productFailure: context.productFailure,
        classifyFatal: tdccFatalCode,
        classifyFailure: tdccProductFailureCode,
        async collect(typeId, product) {
          await product.reportActivity("query");
          const decision = await runSummary.collect(typeId, (recordValidatedExclusions) =>
            TDCC_PRODUCT_COLLECTORS[typeId]({
              session,
              runId: context.runId,
              observedAt: context.now(),
              recordValidatedExclusions,
              admittedFundAccounts: tdcc.admittedFundAccounts,
            }));
          const collected = decision.collection;
          if (decision.kind === "absent") {
            throw new StatementComponentAbsentError(`TDCC reports no ${typeId} account.`, "not_held");
          }
          if (decision.kind !== "items") {
            return {
              sourceCaptureCount: collected.sourceCaptureCount,
              rowCount: collected.rowCount,
              ...(decision.kind === "complete-with-exclusions" ? { completeWithExclusions: true } : {}),
            };
          }
          product.stage(...collected.items);
          return { sourceCaptureCount: collected.sourceCaptureCount, rowCount: collected.rowCount };
        },
        financialCommit: context.financialCommit,
      });
    } catch (error) {
      if (error instanceof ProductCollectionInterruptedError) {
        throw new ProductCollectionInterruptedError(error.errorCode, runSummary.summarize(error.summary));
      }
      throw error;
    }

    const summary = runSummary.summarize(collectedSummary);
    return productRunResult(summary, {
      counts: aggregateTdccExclusionCounts(summary.products.flatMap((product) =>
        product.collection ? [product.collection.exclusionCounts] : [])),
    });
  });
}
