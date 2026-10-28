import { boundProductCollection, type ProductCollection } from "./product-collection.ts";
import { productCollectionFacts } from "./server/app-workflow-registry.ts";
import type { VerifiedSource } from "./server/sources/verified-source.ts";
import type { WorkflowContext, WorkflowFinancialCommitPort } from "./workflow-executor.ts";

type ProductRunContext = Pick<WorkflowContext, "signal" | "event" | "productFailure" | "previewWrite">
  & Readonly<{ financialCommit: WorkflowFinancialCommitPort }>;

/**
 * The context the executor hands a run of `source` for `input`: the hand-built
 * context, with every port it already carries, plus the Product collection run
 * bound to the facts the workflow registry derives from the source.
 */
export function withBoundProducts<T extends ProductRunContext>(
  context: T,
  source: VerifiedSource,
  input: unknown,
): Omit<T, "products"> & Readonly<{ products: ProductCollection }> {
  const facts = productCollectionFacts(source);
  if (!facts) throw new Error(`${source.id} does not collect through a bound Product collection run.`);
  const attachedSource = source.workflow.attachedPreviewProducts;
  return {
    ...context,
    products: boundProductCollection({
      ...facts,
      input,
      ...(attachedSource ? { attachedSource } : {}),
      signal: context.signal,
      event: context.event,
      ...(context.productFailure ? { productFailure: context.productFailure } : {}),
      financialCommit: context.financialCommit,
      ...(context.previewWrite ? { previewWrite: context.previewWrite } : {}),
    }),
  };
}
