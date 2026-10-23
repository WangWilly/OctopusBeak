import type { PreviewProduct, PreviewVisibility } from "../../ledger/pglite/preview-financial-data.ts";
import type { InstitutionKey, InstitutionProduct } from "../institutions/institutions.ts";
import { automationFlagEnabled } from "../automation/statement-selection.ts";
import { VERIFIED_SOURCES } from "../automation/server/sources/index.ts";
import type { InstitutionProductCoverage } from "../automation/server/sources/verified-source.ts";
import { ATTACHED_PREVIEW_SOURCES, type AttachedPreviewSource } from "./attached-products.ts";
import type { PreviewSource } from "./registry.ts";

export type CoveredProduct = PreviewProduct | InstitutionProduct;

/** What each enabled Verified source collects, by Institution and product. */
export const VERIFIED_SOURCE_COVERAGE: Readonly<Record<string, readonly InstitutionProductCoverage[]>> = Object.fromEntries(
  VERIFIED_SOURCES.flatMap((source) => source.coverage ? [[source.id, source.coverage]] : []),
);

export type PreviewVisibilitySource = Pick<PreviewSource, "id" | "institution" | "products">;

export type PreviewVisibilityInput = Readonly<{
  previewFeaturesEnabled: boolean;
  enabledGroups: Readonly<Record<string, boolean>>;
  sources: readonly PreviewVisibilitySource[];
  attached?: readonly AttachedPreviewSource[];
}>;

const key = (institution: InstitutionKey, product: CoveredProduct) => `${institution}\u0000${product}`;

export function previewVisibility({
  previewFeaturesEnabled,
  enabledGroups,
  sources,
  attached = ATTACHED_PREVIEW_SOURCES,
}: PreviewVisibilityInput): PreviewVisibility {
  if (!previewFeaturesEnabled) return { visible: [] };
  const covered = new Set(
    Object.entries(VERIFIED_SOURCE_COVERAGE)
      .filter(([groupId]) => enabledGroups[groupId] === true)
      .flatMap(([, coverage]) => coverage.map((entry) => key(entry.institution, entry.product))),
  );
  const entries = [
    ...sources.map((source) => ({ sourceId: source.id, institution: source.institution, products: source.products })),
    ...attached,
  ];
  return {
    visible: entries.flatMap((entry) => entry.products
      .filter((product) => !covered.has(key(entry.institution, product)))
      .map((product) => ({ sourceId: entry.sourceId, product }))),
  };
}

/** The products of one source that a visibility leaves offered and collectable. */
export function visibleProducts(
  visibility: PreviewVisibility,
  source: Readonly<{ sourceId: string; products: readonly PreviewProduct[] }>,
): readonly PreviewProduct[] {
  return source.products.filter((product) =>
    visibility.visible.some((entry) => entry.sourceId === source.sourceId && entry.product === product));
}

export function sameVisibility(left: PreviewVisibility, right: PreviewVisibility): boolean {
  const render = (visibility: PreviewVisibility) =>
    visibility.visible.map((entry) => `${entry.sourceId}\u0000${entry.product}`).sort().join("\n");
  return render(left) === render(right);
}

/**
 * The visibility a workflow launch environment implies. The launch
 * environment carries the settings file, so the group flags and the Preview
 * features flag are read from it like any other setting.
 */
export function previewVisibilityFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  sources: readonly PreviewVisibilitySource[],
): PreviewVisibility {
  return previewVisibility({
    previewFeaturesEnabled: automationFlagEnabled(environment.PREVIEW_FEATURES_ENABLED),
    enabledGroups: Object.fromEntries(VERIFIED_SOURCES
      .map((source) => [source.id, automationFlagEnabled(environment[source.enabledKey])])),
    sources,
  });
}
