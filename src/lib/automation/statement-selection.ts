import type { AutomationCredentialGroup, StatementTypeCapability } from "./types.ts";

export type StatementCapability = {
  label: string;
  statementSelectionKey: string;
  statementTypes: readonly StatementTypeCapability[];
};

type Settings = Record<string, string | boolean | undefined>;

export type StatementSelectionState = {
  selectedIds: string[];
  needsSetup: boolean;
  persisted: boolean;
};

const types = (...ids: string[]) => ids.map((id) => ({ id }));

export const BANK_STATEMENT_CAPABILITIES = {
  fubon: { label: "Fubon", statementSelectionKey: "LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES", statementTypes: types("deposit", "credit_card", "loan") },
  esun: { label: "ESun", statementSelectionKey: "LIBRETTO_CLOUD_ESUN_STATEMENT_TYPES", statementTypes: types("credit_card") },
  yuanta: { label: "Yuanta", statementSelectionKey: "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES", statementTypes: types("deposit", "foreign_currency", "loan", "credit_card", "fund") },
  "yuanta-trade": { label: "Yuanta Trade", statementSelectionKey: "LIBRETTO_CLOUD_YUANTA_TRADE_STATEMENT_TYPES", statementTypes: types("brokerage") },
  cathay: { label: "Cathay", statementSelectionKey: "LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES", statementTypes: types("domestic", "foreign_currency") },
  hncb: { label: "HNCB", statementSelectionKey: "LIBRETTO_CLOUD_HNCB_STATEMENT_TYPES", statementTypes: types("deposit") },
  ctbc: { label: "CTBC", statementSelectionKey: "LIBRETTO_CLOUD_CTBC_STATEMENT_TYPES", statementTypes: types("deposit") },
  post: { label: "Post Office", statementSelectionKey: "LIBRETTO_CLOUD_POST_STATEMENT_TYPES", statementTypes: types("deposit") },
  sinopac: { label: "SinoPac", statementSelectionKey: "LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES", statementTypes: types("accounts") },
  linebank: { label: "LINE Bank", statementSelectionKey: "LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES", statementTypes: types("accounts") },
} as const satisfies Record<string, StatementCapability>;

export function resolveStatementSelection(
  group: StatementCapability,
  settings: Settings,
  enabled: boolean,
): StatementSelectionState {
  const raw = settings[group.statementSelectionKey];
  if (raw === undefined) {
    const selectedIds = group.statementTypes.length === 1 ? [group.statementTypes[0].id] : [];
    return { selectedIds, needsSetup: enabled && selectedIds.length === 0, persisted: false };
  }
  if (typeof raw !== "string") throw new Error(`${group.statementSelectionKey} must be a string.`);
  const requested = new Set(raw.split(",").map((id) => id.trim()).filter(Boolean));
  const known = new Set(group.statementTypes.map((type) => type.id));
  for (const id of requested) {
    if (!known.has(id)) throw new Error(`Unknown ${group.label} statement type: ${id}`);
  }
  const selectedIds = group.statementTypes.map((type) => type.id).filter((id) => requested.has(id));
  return { selectedIds, needsSetup: enabled && selectedIds.length === 0, persisted: true };
}

export const serializeStatementSelection = (ids: readonly string[]) => ids.join(",");

export function assertValidStatementSelections(
  groups: readonly AutomationCredentialGroup[],
  settings: Settings,
) {
  for (const group of groups) {
    if (!group.statementSelectionKey || !group.statementTypes) continue;
    const state = resolveStatementSelection(
      { label: group.label, statementSelectionKey: group.statementSelectionKey, statementTypes: group.statementTypes },
      settings,
      settings[group.enabledKey] !== false,
    );
    if (state.needsSetup) throw new Error(`Select at least one ${group.label} statement type.`);
  }
}
