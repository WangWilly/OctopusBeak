import type { PreviewProduct } from "../../ledger/pglite/preview-financial-data.ts";
import type { InstitutionKey } from "../institutions/institutions.ts";
import type { StatementTypeCapability } from "../automation/types.ts";
import type { WorkflowContext } from "../automation/workflow-executor.ts";
import {
  boundPreviewWriter,
  collectPreviewProducts,
  type PreviewProductCollectors,
  type PreviewProductRun,
} from "./product-collection.ts";

/**
 * ADR 0051: the preview products a verified workflow collects during its own
 * sign-in. `sourceId` is the verified credential group's id, so the preview
 * rows name the source that wrote them.
 */
export type AttachedPreviewSource = Readonly<{
  sourceId: string;
  institution: InstitutionKey;
  products: readonly PreviewProduct[];
}>;

export const ATTACHED_PREVIEW_PRODUCTS = {
  cathay: { sourceId: "cathay", institution: "cathay", products: ["credit_card", "time_deposit"] },
  hncb: { sourceId: "hncb", institution: "hncb", products: ["credit_card"] },
  sinopac: { sourceId: "sinopac", institution: "sinopac", products: ["credit_card"] },
  esun: { sourceId: "esun", institution: "esun", products: ["deposit"] },
} as const satisfies Readonly<Record<string, AttachedPreviewSource>>;

export type AttachedPreviewGroupId = keyof typeof ATTACHED_PREVIEW_PRODUCTS;

export const ATTACHED_PREVIEW_SOURCES: readonly AttachedPreviewSource[] = Object.values(ATTACHED_PREVIEW_PRODUCTS);

export function attachedPreviewSource(groupId: string): AttachedPreviewSource | null {
  return Object.hasOwn(ATTACHED_PREVIEW_PRODUCTS, groupId)
    ? ATTACHED_PREVIEW_PRODUCTS[groupId as AttachedPreviewGroupId]
    : null;
}

/** A Statement Selection entry for an attached product: offered, unselected by default, marked preview. */
export const attachedStatementType = (product: PreviewProduct): StatementTypeCapability => ({ id: product, preview: true });

export type AttachedPreviewCollectionOptions = Readonly<{
  context: Pick<WorkflowContext, "previewWrite" | "signal" | "event">;
  source: AttachedPreviewSource;
  /** `input.attachedPreviewProducts`: the selected attached products this run may write. */
  selected: readonly PreviewProduct[];
  collectors: PreviewProductCollectors;
  assertSession?: () => Promise<void>;
}>;

/**
 * Collects the selected attached products after the verified workflow has
 * signed in. Each product writes only Preview Financial Data through the
 * writer bound to the verified source. The result never throws: a session
 * loss is reported in `interrupted`, and the verified workflow decides how
 * its own run ends.
 */
export async function collectAttachedPreviewProducts(options: AttachedPreviewCollectionOptions): Promise<PreviewProductRun> {
  const { context, source, selected } = options;
  const port = context.previewWrite;
  if (!port) {
    return {
      products: source.products.map((product) => selected.includes(product)
        ? { typeId: product, status: "failed", itemCount: 0, committedCount: 0, errorCode: "workflow-failed" }
        : { typeId: product, status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" }),
      receipts: [],
      interrupted: null,
      firstFailure: new Error("Preview write port is unavailable."),
    };
  }
  return collectPreviewProducts({
    products: source.products,
    selected: selected.filter((product) => source.products.includes(product)),
    collectors: options.collectors,
    write: boundPreviewWriter(port, source),
    signal: context.signal,
    event: context.event,
    ...(options.assertSession ? { assertSession: options.assertSession } : {}),
  });
}

/**
 * The `attached` option of `collectSelectedProducts`: collects the selected
 * attached products, or is absent when the person selected none. Collectors
 * are built only when collection starts, so an unselected product never opens
 * its provider port.
 */
export function attachedPreviewRun(
  options: Omit<AttachedPreviewCollectionOptions, "collectors"> & Readonly<{ collectors: () => PreviewProductCollectors }>,
): (() => Promise<PreviewProductRun>) | undefined {
  if (options.selected.length === 0) return undefined;
  return () => collectAttachedPreviewProducts({ ...options, collectors: options.collectors() });
}
