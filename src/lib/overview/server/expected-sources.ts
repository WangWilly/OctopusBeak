import type {
  CanonicalOverviewExpectedSource,
} from "../../../ledger/canonical/canonical-overview-query.ts";
import { statementSelectionGroup, VERIFIED_SOURCES } from "../../automation/server/sources/index.ts";
import { selectStatementTypes } from "../../automation/statement-selection.ts";
import {
  automationGroupEnabledStatus,
  readAutomationSettings,
} from "../../automation/server/settings.ts";
import type { AutomationSettingsFile } from "../../automation/server/config-files.ts";

/**
 * Read enabled source configuration without touching financial projection
 * storage. The result is passed into the Current Overview query as an
 * expectation, so an enabled source with no capture remains visible as a
 * source gap instead of disappearing.
 *
 * Persisted statement selections narrow the expectation to the selected
 * product streams. An enabled source with no selection remains one source
 * expectation, which preserves the setup/awaiting state without inventing
 * gaps for every product the provider could support.
 */
export function configuredOverviewSources(
  settings: AutomationSettingsFile = readAutomationSettings(),
  env: Record<string, string | undefined> = process.env,
): CanonicalOverviewExpectedSource[] {
  const enabledGroups = automationGroupEnabledStatus(settings, env);
  return VERIFIED_SOURCES.flatMap((source) => {
    if (source.overview === false || enabledGroups[source.id] !== true) return [];
    const group = statementSelectionGroup(source);
    const selection = group
      ? selectStatementTypes(group, { ...settings, [group.enabledKey]: true }, "display")
      : null;
    if (!selection || selection.selectedIds.length === 0) {
      return [{
        sourceId: source.id,
        integrationNamespace: source.integrationNamespace,
        label: source.displayName.en,
        ...(source.overview ? { stream: source.overview.defaultStream } : {}),
      }];
    }
    return selection.selectedIds.map((productId) => {
      const product = source.statementSelection?.products.find(({ id }) => id === productId);
      return {
        sourceId: `${source.id}:${productId}`,
        integrationNamespace: product?.integrationNamespace ?? source.integrationNamespace,
        label: `${source.displayName.en} · ${productId}`,
        ...(product ? { stream: product.stream } : {}),
      };
    });
  });
}
