import { boundProductCollection, type CollectionProductTypeId } from "./product-collection.ts";
import type { VerifiedSource } from "./server/sources/verified-source.ts";
import type { WorkflowCapability, WorkflowContext, WorkflowContextWith } from "./workflow-executor.ts";

/**
 * The context the executor hands a run of `source` for `input`: the hand-built
 * context plus the Product collection run bound to the source's facts, as the
 * workflow registry derives them.
 */
export function withBoundProducts<O extends WorkflowCapability = never>(
  context: WorkflowContextWith<"financialCommit", O>,
  source: VerifiedSource,
  input: unknown,
): WorkflowContextWith<"financialCommit" | "products", O> {
  const attachedSource = source.workflow.attachedPreviewProducts;
  const { previewWrite } = context as WorkflowContext;
  return {
    ...context,
    products: boundProductCollection({
      provider: source.integrationNamespace,
      productIds: (source.statementSelection?.products ?? []).map(({ id }) => id as CollectionProductTypeId),
      input,
      ...(attachedSource ? { attachedSource } : {}),
      signal: context.signal,
      event: context.event,
      ...(context.productFailure ? { productFailure: context.productFailure } : {}),
      financialCommit: context.financialCommit,
      ...(previewWrite ? { previewWrite } : {}),
    }),
  };
}
