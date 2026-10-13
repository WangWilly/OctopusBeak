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
import { createTdccRunSummary, tdccWorkflowOutput } from "./tdcc-collection-summary.ts";
import type { WorkflowDefinition } from "./workflow-executor.ts";

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
  return {
    id: "sync-tdcc",
    requiresFinancialCommit: true,
    requiresTdcc: true,
    async run(context, input) {
      const selectedIds = selectedProducts(input);
      const tdcc = context.tdcc!;
      await context.event("authentication", "authentication-started");
      const lease = await tdcc.session.open();
      if (lease.status !== "ready") {
        await context.event("authentication", "device-registration-required");
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
          productIds: TDCC_PRODUCT_IDS,
          selectedIds,
          signal: context.signal,
          event: context.event,
          productFailure: context.productFailure,
          classifyFatal: tdccFatalCode,
          classifyFailure: tdccProductFailureCode,
          async collect(typeId, stagedItems, reportActivity) {
            await reportActivity("query");
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
                itemCount: 0,
                ...(decision.kind === "complete-with-exclusions" ? { completeWithExclusions: true } : {}),
              };
            }
            stagedItems.push(...collected.items);
            return { sourceCaptureCount: collected.sourceCaptureCount, rowCount: collected.rowCount, itemCount: collected.items.length };
          },
          commit: (typeId, stagedItems) => context.financialCommit!.execute(stagedItems, {
            provider: "tdcc",
            product: typeId,
            signal: context.signal,
          }),
        });
      } catch (error) {
        if (error instanceof ProductCollectionInterruptedError) {
          throw new ProductCollectionInterruptedError(error.errorCode, runSummary.summarize(error.summary));
        }
        throw error;
      }

      return tdccWorkflowOutput(runSummary.summarize(collectedSummary));
    },
  };
}
