import type { PreviewVisibility } from "../../ledger/pglite/preview-financial-data.ts";
import type { InstitutionKey, InstitutionProduct } from "../institutions/institutions.ts";
import type { PreviewSource } from "./registry.ts";

export type InstitutionProductCoverage = Readonly<{ institution: InstitutionKey; product: InstitutionProduct }>;

export const VERIFIED_SOURCE_COVERAGE: Readonly<Record<string, readonly InstitutionProductCoverage[]>> = {
  fubon: [{ institution: "fubon", product: "deposit" }],
  yuanta: [{ institution: "yuanta-bank", product: "deposit" }, { institution: "yuanta-bank", product: "fund" }],
  "yuanta-trade": [{ institution: "yuanta-securities", product: "securities" }],
  cathay: [{ institution: "cathay", product: "deposit" }],
  hncb: [{ institution: "hncb", product: "deposit" }],
  ctbc: [{ institution: "ctbc", product: "deposit" }],
  post: [{ institution: "post", product: "deposit" }],
  sinopac: [{ institution: "sinopac", product: "deposit" }],
  linebank: [{ institution: "linebank", product: "deposit" }],
};

export type PreviewVisibilityInput = Readonly<{
  previewFeaturesEnabled: boolean;
  enabledGroups: Readonly<Record<string, boolean>>;
  sources: readonly Pick<PreviewSource, "id" | "institution" | "product">[];
}>;

const key = (coverage: InstitutionProductCoverage) => `${coverage.institution}\u0000${coverage.product}`;

export function previewVisibility({
  previewFeaturesEnabled,
  enabledGroups,
  sources,
}: PreviewVisibilityInput): PreviewVisibility {
  if (!previewFeaturesEnabled) return { sourceIds: [] };
  const covered = new Set(
    Object.entries(VERIFIED_SOURCE_COVERAGE)
      .filter(([groupId]) => enabledGroups[groupId] === true)
      .flatMap(([, coverage]) => coverage.map(key)),
  );
  return { sourceIds: sources.filter((source) => !covered.has(key(source))).map((source) => source.id) };
}
