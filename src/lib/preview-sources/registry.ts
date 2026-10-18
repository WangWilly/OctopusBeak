import type {
  AutomationCredentialField,
  AutomationCredentialGroup,
  AutomationLocalizedText,
  AutomationSetupGuide,
} from "../automation/types.ts";
import type { InstitutionKey } from "../institutions/institutions.ts";
import type { PreviewProduct } from "../../ledger/pglite/preview-financial-data.ts";
import { PREVIEW_PRODUCTS, PREVIEW_SOURCE_ID } from "./source-id.ts";
import { previewStatementSelectionKey, type PreviewWorkflowRun } from "./workflow.ts";
import { PREVIEW_FIXTURE_SOURCE, PREVIEW_PRODUCTS_FIXTURE_SOURCE, previewSourceFixtureEnabled } from "./fixture-source.ts";
import { NEXTBANK_PREVIEW_SOURCE } from "./nextbank-source.ts";
import { SKBANK_PREVIEW_SOURCE } from "./skbank-source.ts";
import { RAKUTEN_PREVIEW_SOURCE } from "./rakuten-source.ts";
import { MEGA_PREVIEW_SOURCE } from "./mega-source.ts";
import { TAISHIN_PREVIEW_SOURCE } from "./taishin-source.ts";
import { OBANK_PREVIEW_SOURCE } from "./obank-source.ts";
import { FIRSTBANK_PREVIEW_SOURCE } from "./firstbank-source.ts";
import { KGIBANK_PREVIEW_SOURCE } from "./kgibank-source.ts";

export type PreviewSource = Readonly<{
  id: string;
  institution: InstitutionKey;
  /** The products the source can collect, in Statement Selection order. Never empty. */
  products: readonly PreviewProduct[];
  displayName: AutomationLocalizedText;
  searchAliases: readonly string[];
  credentialFields: readonly AutomationCredentialField[];
  setupGuide: AutomationSetupGuide;
  sessionTakeoverNotice?: AutomationLocalizedText;
  startUrl: string;
  run: PreviewWorkflowRun;
}>;

const PRODUCTION_PREVIEW_SOURCES: readonly PreviewSource[] = [NEXTBANK_PREVIEW_SOURCE, SKBANK_PREVIEW_SOURCE, RAKUTEN_PREVIEW_SOURCE, MEGA_PREVIEW_SOURCE, TAISHIN_PREVIEW_SOURCE, OBANK_PREVIEW_SOURCE, FIRSTBANK_PREVIEW_SOURCE, KGIBANK_PREVIEW_SOURCE];

function previewSourcesForEnvironment(environment: NodeJS.ProcessEnv = process.env): readonly PreviewSource[] {
  return previewSourceFixtureEnabled(environment)
    ? [...PRODUCTION_PREVIEW_SOURCES, PREVIEW_FIXTURE_SOURCE, PREVIEW_PRODUCTS_FIXTURE_SOURCE]
    : PRODUCTION_PREVIEW_SOURCES;
}

export const PREVIEW_SOURCES: readonly PreviewSource[] = previewSourcesForEnvironment();

const envId = (id: string) => id.toUpperCase().replaceAll("-", "_");

const previewEnabledKey = (source: Pick<PreviewSource, "id">) => `PREVIEW_${envId(source.id)}_ENABLED`;

export function previewCredentialGroup(source: PreviewSource): AutomationCredentialGroup {
  return {
    id: source.id,
    label: source.displayName.en,
    displayName: source.displayName,
    searchAliases: source.searchAliases,
    enabledKey: previewEnabledKey(source),
    credentialKeys: source.credentialFields.map((field) => field.key),
    credentialFields: source.credentialFields,
    setupGuide: source.setupGuide,
    ...(source.sessionTakeoverNotice ? { sessionTakeoverNotice: source.sessionTakeoverNotice } : {}),
    preview: true,
    statementSelectionKey: previewStatementSelectionKey(source),
    statementTypes: source.products.map((id) => ({ id })),
  };
}

export function assertPreviewRegistry(
  sources: readonly PreviewSource[],
  reservedGroupIds: readonly string[],
): readonly PreviewSource[] {
  const ids = new Set(reservedGroupIds);
  for (const source of sources) {
    if (!PREVIEW_SOURCE_ID.test(source.id)) throw new Error(`Preview source id is invalid: ${source.id}`);
    if (ids.has(source.id)) throw new Error(`Preview source id is not unique: ${source.id}`);
    ids.add(source.id);
    if (source.products.length === 0 || new Set(source.products).size !== source.products.length
      || source.products.some((product) => !PREVIEW_PRODUCTS.includes(product)))
      throw new Error(`Preview source products must be a non-empty set of known products: ${source.id}`);
    const prefix = `PREVIEW_${envId(source.id)}_`;
    for (const field of source.credentialFields) {
      if (!field.key.startsWith(prefix)) throw new Error(`Preview credential key must start with ${prefix}: ${field.key}`);
    }
    if (new URL(source.startUrl).protocol !== "https:") throw new Error(`Preview start URL must use https: ${source.id}`);
  }
  return sources;
}
