import type { StatementTypeCapability } from "./types.ts";

export type StatementSelectionGroup = {
  id: string;
  label: string;
  enabledKey: string;
  statementSelectionKey: string;
  statementTypes: readonly StatementTypeCapability[];
};

type StatementSelectionFields = Pick<
  StatementSelectionGroup,
  "statementSelectionKey" | "statementTypes"
>;

export function isStatementSelectionGroup<
  T extends {
    statementSelectionKey?: string;
    statementTypes?: readonly StatementTypeCapability[];
  },
>(group: T): group is T & StatementSelectionFields {
  return Boolean(
    group.statementSelectionKey && Array.isArray(group.statementTypes),
  );
}

type Settings = Record<string, string | boolean | undefined>;

const disabledFlagValues = new Set(["0", "false", "no", "off", "disabled"]);

export function automationFlagEnabled(value: string | boolean | undefined) {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  return !disabledFlagValues.has(value.trim().toLowerCase());
}

export type StatementSelectionMode = "display" | "strict";

export type StatementSelectionErrorReason =
  "missing-selection" | "unknown-type" | "invalid-value";

export type StatementSelectionState = {
  selectedIds: string[];
  needsSetup: boolean;
  persisted: boolean;
};

export class StatementSelectionError extends Error {
  readonly name = "StatementSelectionError";
  readonly unknownIds: readonly string[];
  readonly groupId: string;
  readonly reason: StatementSelectionErrorReason;

  constructor(
    groupId: string,
    reason: StatementSelectionErrorReason,
    group: StatementSelectionGroup,
    unknownIds: readonly string[] = [],
  ) {
    const message =
      reason === "missing-selection"
        ? "Select at least one " + group.label + " statement type."
        : reason === "unknown-type"
          ? "Unknown " +
            group.label +
            " statement type: " +
            (unknownIds[0] ?? "unknown")
          : group.statementSelectionKey + " must be a string.";
    super(message);
    this.groupId = groupId;
    this.reason = reason;
    this.unknownIds = [...unknownIds];
  }
}

const types = (...ids: string[]) => ids.map((id) => ({ id }));

export function allSupportedStatementTypeIds(
  group: StatementSelectionGroup,
): string[] {
  return group.statementTypes.map((type) => type.id);
}

export const BANK_STATEMENT_CAPABILITIES = {
  fubon: {
    id: "fubon",
    label: "Fubon",
    enabledKey: "LIBRETTO_CLOUD_FUBON_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES",
    statementTypes: types("deposit", "credit_card", "loan"),
  },
  esun: {
    id: "esun",
    label: "ESun",
    enabledKey: "LIBRETTO_CLOUD_ESUN_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_ESUN_STATEMENT_TYPES",
    statementTypes: types("credit_card"),
  },
  yuanta: {
    id: "yuanta",
    label: "Yuanta",
    enabledKey: "LIBRETTO_CLOUD_YUANTA_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES",
    statementTypes: types(
      "deposit",
      "foreign_currency",
      "credit_card",
      "loan",
      "fund",
    ),
  },
  "yuanta-trade": {
    id: "yuanta-trade",
    label: "Yuanta Trade",
    enabledKey: "LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_YUANTA_TRADE_STATEMENT_TYPES",
    statementTypes: types("brokerage"),
  },
  cathay: {
    id: "cathay",
    label: "Cathay",
    enabledKey: "LIBRETTO_CLOUD_CATHAY_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES",
    statementTypes: types("domestic", "foreign_currency"),
  },
  hncb: {
    id: "hncb",
    label: "HNCB",
    enabledKey: "LIBRETTO_CLOUD_HNCB_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_HNCB_STATEMENT_TYPES",
    statementTypes: types("deposit"),
  },
  ctbc: {
    id: "ctbc",
    label: "CTBC",
    enabledKey: "LIBRETTO_CLOUD_CTBC_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_CTBC_STATEMENT_TYPES",
    statementTypes: types("deposit"),
  },
  post: {
    id: "post",
    label: "Post Office",
    enabledKey: "LIBRETTO_CLOUD_POST_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_POST_STATEMENT_TYPES",
    statementTypes: types("deposit"),
  },
  sinopac: {
    id: "sinopac",
    label: "SinoPac",
    enabledKey: "LIBRETTO_CLOUD_SINOPAC_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES",
    statementTypes: types("accounts"),
  },
  linebank: {
    id: "linebank",
    label: "LINE Bank",
    enabledKey: "LIBRETTO_CLOUD_LINEBANK_ENABLED",
    statementSelectionKey: "LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES",
    statementTypes: types("accounts"),
  },
} as const satisfies Record<string, StatementSelectionGroup>;

export function selectStatementTypes(
  group: StatementSelectionGroup,
  settings: Settings,
  mode: StatementSelectionMode,
): StatementSelectionState {
  const enabled = automationFlagEnabled(settings[group.enabledKey]);
  const raw = settings[group.statementSelectionKey];
  if (raw === undefined) {
    const selectedIds =
      group.statementTypes.length === 1 ? [group.statementTypes[0].id] : [];
    if (enabled && !selectedIds.length && mode === "strict") {
      throw new StatementSelectionError(group.id, "missing-selection", group);
    }
    return {
      selectedIds,
      needsSetup: enabled && selectedIds.length === 0,
      persisted: false,
    };
  }
  if (typeof raw !== "string") {
    throw new StatementSelectionError(group.id, "invalid-value", group);
  }
  const requested = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const known = new Set(group.statementTypes.map((type) => type.id));
  const unknownIds = [...requested].filter((id) => !known.has(id));
  if (enabled && unknownIds.length > 0 && mode === "strict") {
    throw new StatementSelectionError(
      group.id,
      "unknown-type",
      group,
      unknownIds,
    );
  }
  const selectedIds = group.statementTypes
    .map((type) => type.id)
    .filter((id) => requested.has(id));
  if (enabled && !selectedIds.length && mode === "strict") {
    throw new StatementSelectionError(group.id, "missing-selection", group);
  }
  return {
    selectedIds,
    needsSetup: enabled && (selectedIds.length === 0 || unknownIds.length > 0),
    persisted: true,
  };
}
