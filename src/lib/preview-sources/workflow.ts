import type { ProductRunResult } from "../automation/workflow-run-result.ts";
import type { PreviewProduct } from "../../ledger/pglite/preview-financial-data.ts";
import { verifiedSourceById } from "../automation/server/sources/index.ts";
import { defineWorkflow, type WorkflowContext, type WorkflowDefinition } from "../automation/workflow-executor.ts";
import { ATTACHED_PREVIEW_PRODUCTS, type AttachedPreviewGroupId } from "./attached-products.ts";
import {
  boundPreviewWriter,
  collectPreviewProducts,
  previewRunOutput,
  type PreviewProductCollectors,
} from "./product-collection.ts";
import type { PreviewSource } from "./registry.ts";
import { previewTaskId } from "./source-id.ts";
import { previewVisibilityFromEnvironment, visibleProducts } from "./visibility.ts";

export type { WorkflowPreviewWritePort } from "./product-collection.ts";

export type PreviewResponseObservation = Readonly<{ endpoint: string; status: number; body: unknown }>;

/**
 * The writer a source's run holds. `collect` runs the selected products
 * through the given collectors and writes each one as it completes; it is
 * the only way a run produces its output.
 */
export type PreviewSourceWriter = Readonly<{
  collect(collectors: PreviewProductCollectors, options?: Readonly<{ assertSession?: () => Promise<void> }>): Promise<ProductRunResult>;
  observe(response: PreviewResponseObservation): void;
}>;

const MAX_OBSERVATIONS = 50;
const failureObservations = new WeakMap<object, readonly PreviewResponseObservation[]>();

export function takePreviewObservations(error: unknown): readonly PreviewResponseObservation[] {
  if (typeof error !== "object" || error === null) return [];
  const observations = failureObservations.get(error) ?? [];
  failureObservations.delete(error);
  return observations;
}

export type PreviewWorkflowContext = Omit<
  WorkflowContext,
  "financialCommit" | "maicoinPersistence" | "tdcc" | "previewWrite"
> & Readonly<{ preview: PreviewSourceWriter }>;

export type PreviewWorkflowInput = Readonly<{
  startUrl: string;
  credentials: Readonly<Record<string, string>>;
  /** The selected products no verified source covers, in the source's declared order. */
  products: readonly PreviewProduct[];
}>;

export type PreviewWorkflowRun = (
  context: PreviewWorkflowContext,
  input: PreviewWorkflowInput,
) => Promise<ProductRunResult>;

export const previewStatementSelectionKey = (source: Pick<PreviewSource, "id">) =>
  `PREVIEW_${source.id.toUpperCase().replaceAll("-", "_")}_STATEMENT_TYPES`;

/**
 * Statement Selection for a Preview Source. A single product is the
 * selection; several products need an explicit choice, and a product a
 * verified source covers is never collected.
 */
export function selectedPreviewProducts(
  source: Pick<PreviewSource, "id" | "institution" | "products">,
  environment: NodeJS.ProcessEnv,
): readonly PreviewProduct[] {
  const raw = environment[previewStatementSelectionKey(source)];
  const chosen = new Set(raw === undefined
    ? source.products.length === 1 ? source.products : []
    : raw.split(",").map((id) => id.trim()));
  const selected = source.products.filter((product) => chosen.has(product));
  const visibility = previewVisibilityFromEnvironment(environment, [source]);
  return visibleProducts(visibility, { sourceId: source.id, products: selected });
}

/**
 * The attached products a verified workflow run may write: the person's
 * selection, reduced to the products Preview features offer and no verified
 * source covers. Empty while Preview features are off.
 */
export function selectedAttachedPreviewProducts(
  groupId: AttachedPreviewGroupId,
  environment: NodeJS.ProcessEnv,
): readonly PreviewProduct[] {
  const attached = ATTACHED_PREVIEW_PRODUCTS[groupId];
  const raw = environment[verifiedSourceById(groupId)!.statementSelection!.key] ?? "";
  const chosen = new Set(raw.split(",").map((id) => id.trim()));
  const selected = attached.products.filter((product) => chosen.has(product));
  return visibleProducts(previewVisibilityFromEnvironment(environment, []), { sourceId: attached.sourceId, products: selected });
}

export function previewWorkflowInput(
  source: PreviewSource,
  environment: NodeJS.ProcessEnv,
): PreviewWorkflowInput {
  return {
    startUrl: source.startUrl,
    credentials: Object.fromEntries(
      source.credentialFields.map((field) => [field.key, environment[field.key] ?? ""]),
    ),
    products: selectedPreviewProducts(source, environment),
  };
}

export function previewWorkflowDefinition(
  source: PreviewSource,
): WorkflowDefinition<PreviewWorkflowInput, ProductRunResult> {
  return defineWorkflow({
    id: previewTaskId(source),
    requiresFinancialCommit: false,
    requiresPreviewWrite: true,
  }, async (context, input: PreviewWorkflowInput): Promise<ProductRunResult> => {
    const port = context.previewWrite;
    const { financialCommit: _commit, maicoinPersistence: _maicoin, tdcc: _tdcc, previewWrite: _port, ...rest } = context;
    const observations: PreviewResponseObservation[] = [];
    const write = boundPreviewWriter(port, { sourceId: source.id, institution: source.institution });
    try {
      return await source.run({
        ...rest,
        preview: {
          collect: async (collectors, options = {}) => previewRunOutput(await collectPreviewProducts({
            products: source.products,
            selected: input.products,
            collectors,
            write,
            signal: context.signal,
            event: context.event,
            ...(options.assertSession ? { assertSession: options.assertSession } : {}),
          })),
          observe(response) {
            observations.push(response);
            if (observations.length > MAX_OBSERVATIONS) observations.shift();
          },
        },
      }, input);
    } catch (error) {
      if (typeof error === "object" && error !== null) failureObservations.set(error, [...observations]);
      throw error;
    }
  });
}
