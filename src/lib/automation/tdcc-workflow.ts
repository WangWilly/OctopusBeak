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
import {
  aggregateTdccExclusionCounts,
  mergeTdccExclusionCounts,
  summarizeTdccExclusions,
  tdccCompletenessAfterMerge,
  type TdccCollectionCompleteness,
  type TdccProductCollectionEvidence,
} from "./tdcc-collection-summary.ts";
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
      // Validated source observations stay private to this run and are keyed by
      // product. Collectors receive a product-bound recorder, never a mutable bag.
      const observations = new Map<TdccProductId, TdccProductCollectionEvidence>();
      const completedCollections = new Set<TdccProductId>();
      const recordValidatedExclusions = (typeId: TdccProductId) => (
        exclusions: Parameters<typeof summarizeTdccExclusions>[0],
      ) => {
        const next = summarizeTdccExclusions(exclusions);
        const previous = observations.get(typeId);
        const merged: TdccProductCollectionEvidence = Object.freeze({
          status: previous
            ? tdccCompletenessAfterMerge(previous.status, next.status)
            : next.status,
          exclusionCounts: previous
            ? mergeTdccExclusionCounts(previous.exclusionCounts, next.exclusionCounts)
            : next.exclusionCounts,
        });
        const proposed = [...observations.entries()]
          .filter(([productId]) => productId !== typeId)
          .map(([, observation]) => observation.exclusionCounts);
        proposed.push(merged.exclusionCounts);
        aggregateTdccExclusionCounts(proposed);
        observations.set(typeId, merged);
      };
      const withTdccEvidence = (summary: ProductCollectionRunSummary): ProductCollectionRunSummary => {
        const products = summary.products.map((product) => {
          if (product.skipReason) return product;
          const typeId = product.typeId as TdccProductId;
          const observed = observations.get(typeId);
          const status: TdccCollectionCompleteness = observed?.status === "incomplete"
            || !completedCollections.has(typeId)
            ? "incomplete"
            : observed?.status ?? "complete";
          return Object.freeze({
            ...product,
            collection: Object.freeze({
              status,
              exclusionCounts: observed?.exclusionCounts ?? Object.freeze({}),
            }),
          });
        });
        const hasIncompleteCollection = products.some((product) => product.collection?.status === "incomplete");
        return Object.freeze({
          ...summary,
          products: Object.freeze(products),
          status: hasIncompleteCollection
            ? summary.committedCount > 0 ? "partial" : "failed"
            : summary.status,
        });
      };

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
          const collected = await TDCC_PRODUCT_COLLECTORS[typeId]({
            session,
            runId: context.runId,
            observedAt: context.now(),
            recordValidatedExclusions: recordValidatedExclusions(typeId),
            admittedFundAccounts: tdcc.admittedFundAccounts,
          });
          completedCollections.add(typeId);
          if (collected.items.length === 0) {
            const observation = observations.get(typeId);
            if (observation?.status === "complete_with_exclusions") {
              return {
                sourceCaptureCount: collected.sourceCaptureCount,
                rowCount: collected.rowCount,
                itemCount: 0,
                completeWithExclusions: true,
              };
            }
            if (observation?.status === "incomplete") {
              return {
                sourceCaptureCount: collected.sourceCaptureCount,
                rowCount: collected.rowCount,
                itemCount: 0,
              };
            }
            throw new StatementComponentAbsentError(`TDCC reports no ${typeId} account.`, "not_held");
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
          throw new ProductCollectionInterruptedError(error.errorCode, withTdccEvidence(error.summary));
        }
        throw error;
      }

      const summary = withTdccEvidence(collectedSummary);
      const exclusions = aggregateTdccExclusionCounts(
        [...observations.values()].map((observation) => observation.exclusionCounts),
      );
      const hasCommittedReceipts = summary.committedCount > 0;
      const hasIntentionalExclusions = summary.products.some(
        (product) => product.collection?.status === "complete_with_exclusions",
      );
      return {
        ...summary,
        ...exclusions,
        status: summary.status === "completed"
          ? hasCommittedReceipts ? "financial-admitted" : hasIntentionalExclusions ? "completed" : "no-data"
          : summary.status,
      };
    },
  };
}
