import type { AutomationSettingsFile, AutomationSettingsStore } from "./config-files.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./tasks.ts";
import { PREVIEW_SOURCES } from "../../preview-sources/registry.ts";
import { attachedPreviewSource, attachedStatementType } from "../../preview-sources/attached-products.ts";
import { previewVisibility, sameVisibility, visibleProducts } from "../../preview-sources/visibility.ts";
import type { PreviewProduct, PreviewVisibility } from "../../../ledger/pglite/preview-financial-data.ts";
import type { AutomationCredentialGroup } from "../types.ts";
import { automationFlagEnabled } from "../statement-selection.ts";
import { systemSettings } from "../../settings/system-settings.ts";

export function envFlagEnabled(value: string | boolean | undefined) {
  return automationFlagEnabled(value);
}

export function automationBusinessTimezone(settings: AutomationSettingsFile) {
  return systemSettings(settings).systemTimezone;
}

export function automationGroupEnabledStatus(
  settings: AutomationSettingsFile,
  env: Record<string, string | undefined> = process.env,
) {
  return Object.fromEntries(
    AUTOMATION_CREDENTIAL_GROUPS.map((group) => [
      group.id,
      envFlagEnabled(settings[group.enabledKey] ?? env[group.enabledKey]),
    ]),
  );
}

/**
 * The Statement Selection a group offers under a visibility: a Preview
 * Source lists its uncovered products, and a verified group adds its
 * uncovered Attached Preview Products, marked preview.
 */
export function offeredStatementTypes(group: AutomationCredentialGroup, visibility: PreviewVisibility): AutomationCredentialGroup {
  if (group.preview) {
    const products = visibleProducts(visibility, {
      sourceId: group.id,
      products: (group.statementTypes ?? []).map((type) => type.id as PreviewProduct),
    });
    return { ...group, statementTypes: products.map((id) => ({ id })) };
  }
  const attached = attachedPreviewSource(group.id);
  if (!attached || !group.statementSelectionKey) return group;
  const products = visibleProducts(visibility, attached);
  return { ...group, statementTypes: [...(group.statementTypes ?? []), ...products.map(attachedStatementType)] };
}

export function offeredAutomationSources(settings: AutomationSettingsFile) {
  const visibility = currentPreviewVisibility(settings);
  const offeredPreviewIds = new Set(visibility.visible.map((entry) => entry.sourceId));
  const enabled = automationGroupEnabledStatus(settings);
  const credentialGroups = AUTOMATION_CREDENTIAL_GROUPS
    .filter((group) => !group.preview || offeredPreviewIds.has(group.id))
    .map((group) => offeredStatementTypes(group, visibility));
  return {
    credentialGroups,
    enabledGroups: Object.fromEntries(AUTOMATION_CREDENTIAL_GROUPS.map((group) => [
      group.id,
      credentialGroups.some((offered) => offered.id === group.id) && enabled[group.id] === true,
    ])),
  };
}

export function currentPreviewVisibility(settings: AutomationSettingsFile) {
  return previewVisibility({
    previewFeaturesEnabled: systemSettings(settings).previewFeaturesEnabled,
    enabledGroups: automationGroupEnabledStatus(settings),
    sources: PREVIEW_SOURCES,
  });
}

function initialPreviewVisibility(settings: AutomationSettingsStore): PreviewVisibility | null {
  try {
    return currentPreviewVisibility(settings.read());
  } catch {
    // An invalid settings file must not stop the app from starting; the first write announces.
    return null;
  }
}

/**
 * Calls `onChange` after any write of the settings file changes Preview
 * visibility, comparing with the visibility last seen.
 */
export function watchPreviewVisibility(
  settings: AutomationSettingsStore,
  onChange: () => void,
): () => void {
  let last = initialPreviewVisibility(settings);
  return settings.subscribe((written) => {
    const next = currentPreviewVisibility(written);
    if (last !== null && sameVisibility(next, last)) return;
    last = next;
    onChange();
  });
}
