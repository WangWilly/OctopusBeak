import type {
  CanonicalOverviewExpectedSource,
} from "../../../ledger/canonical/canonical-overview-query.ts";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
} from "../../automation/server/tasks.ts";
import {
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../../automation/statement-selection.ts";
import {
  automationGroupEnabledStatus,
  readAutomationSettings,
} from "../../automation/server/settings.ts";
import type { AutomationSettingsFile } from "../../automation/server/config-files.ts";

type ExpectedSourceDefinition = Readonly<{
  integrationNamespace: string;
  products: Readonly<Record<string, { stream: string; integrationNamespace?: string }>>;
  defaultStream?: string;
}>;

/**
 * Financial automation sources that can be expected by Overview. E-Invoice
 * is deliberately absent because it is a spending source, while investment
 * accounts remain in the same Current Overview source contract as bank and
 * liability accounts.
 */
const EXPECTED_SOURCE_DEFINITIONS: Readonly<Record<string, ExpectedSourceDefinition>> = {
  fubon: {
    integrationNamespace: "fubon",
    products: {
      deposit: { stream: "domestic-deposit" },
      credit_card: { stream: "credit-card" },
      loan: { stream: "loan" },
    },
  },
  esun: {
    integrationNamespace: "esun",
    products: { credit_card: { stream: "credit-card" } },
  },
  yuanta: {
    integrationNamespace: "yuanta",
    products: {
      deposit: { stream: "domestic-deposit" },
      foreign_currency: { stream: "foreign-currency-deposit" },
      credit_card: { stream: "credit-card" },
      loan: { stream: "loan" },
      fund: { stream: "investment", integrationNamespace: "yuanta-fund" },
    },
  },
  "yuanta-trade": {
    integrationNamespace: "yuanta-trade",
    products: { brokerage: { stream: "investment" } },
  },
  cathay: {
    integrationNamespace: "cathay",
    products: {
      domestic: { stream: "domestic-deposit" },
      foreign_currency: { stream: "foreign-currency-deposit" },
    },
  },
  hncb: {
    integrationNamespace: "hncb",
    products: { deposit: { stream: "domestic-deposit" } },
  },
  ctbc: {
    integrationNamespace: "ctbc",
    products: { deposit: { stream: "domestic-deposit" } },
  },
  post: {
    integrationNamespace: "post",
    products: { deposit: { stream: "domestic-deposit" } },
  },
  sinopac: {
    integrationNamespace: "sinopac",
    products: { accounts: { stream: "domestic-deposit" } },
  },
  linebank: {
    integrationNamespace: "linebank",
    products: { accounts: { stream: "domestic-deposit" } },
  },
  maicoin: {
    integrationNamespace: "maicoin",
    products: {},
    defaultStream: "investment",
  },
};

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
  const groupsById = new Map(
    AUTOMATION_CREDENTIAL_GROUPS.map((group) => [group.id, group]),
  );
  return Object.entries(EXPECTED_SOURCE_DEFINITIONS).flatMap(([sourceId, definition]) => {
    if (enabledGroups[sourceId] !== true) return [];
    const group = groupsById.get(sourceId);
    if (!group) return [];
    const selection = isStatementSelectionGroup(group)
      ? selectStatementTypes(group, {
          ...settings,
          [group.enabledKey]: true,
        }, "display")
      : null;
    if (!selection || selection.selectedIds.length === 0) {
      return [{
        sourceId,
        integrationNamespace: definition.integrationNamespace,
        label: group.displayName.en,
        ...(definition.defaultStream ? { stream: definition.defaultStream } : {}),
      }];
    }
    return selection.selectedIds.map((productId) => ({
      sourceId: `${sourceId}:${productId}`,
      integrationNamespace: definition.integrationNamespace,
      label: `${group.displayName.en} · ${productId}`,
      ...(definition.products[productId]?.stream ? { stream: definition.products[productId].stream } : {}),
      ...(definition.products[productId]?.integrationNamespace
        ? { integrationNamespace: definition.products[productId].integrationNamespace }
        : {}),
    }));
  });
}
