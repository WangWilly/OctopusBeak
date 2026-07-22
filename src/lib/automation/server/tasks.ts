import type { AutomationCredentialGroup, AutomationTaskKind, AutomationTaskSummary } from "../types.ts";
import { BANK_STATEMENT_CAPABILITIES, resolveStatementSelection } from "../statement-selection.ts";

export type { AutomationCredentialGroup, AutomationTaskKind, AutomationTaskSummary } from "../types.ts";

export type AutomationTask = AutomationTaskSummary & {
  command: readonly string[];
  maxAttempts: number;
};

export const CSV_IMPORT_DEPENDENCY_IDS = [
  "fubon-all-statements",
  "esun-credit-card-statements",
  "yuanta-all-statements",
  "yuanta-trade-statements",
  "cathay-all-statements",
  "hncb-statements",
  "ctbc-statements",
  "post-statements",
  "sinopac-statements",
  "linebank-statements",
  "einvoice-personal-invoices",
] as const;

export const AUTOMATION_CREDENTIAL_GROUPS: readonly AutomationCredentialGroup[] = [
  {
    id: "fubon",
    enabledKey: "LIBRETTO_CLOUD_FUBON_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_FUBON_USER_ID",
      "LIBRETTO_CLOUD_FUBON_ACCOUNT",
      "LIBRETTO_CLOUD_FUBON_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.fubon,
  },
  {
    id: "esun",
    enabledKey: "LIBRETTO_CLOUD_ESUN_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_ESUN_USER_ID",
      "LIBRETTO_CLOUD_ESUN_ACCOUNT",
      "LIBRETTO_CLOUD_ESUN_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.esun,
  },
  {
    id: "yuanta",
    enabledKey: "LIBRETTO_CLOUD_YUANTA_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_ACCOUNT",
      "LIBRETTO_CLOUD_YUANTA_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.yuanta,
  },
  {
    id: "yuanta-trade",
    enabledKey: "LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES["yuanta-trade"],
  },
  {
    id: "cathay",
    enabledKey: "LIBRETTO_CLOUD_CATHAY_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_CATHAY_USER_ID",
      "LIBRETTO_CLOUD_CATHAY_ACCOUNT",
      "LIBRETTO_CLOUD_CATHAY_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.cathay,
  },
  {
    id: "hncb",
    enabledKey: "LIBRETTO_CLOUD_HNCB_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_HNCB_USER_ID",
      "LIBRETTO_CLOUD_HNCB_ACCOUNT",
      "LIBRETTO_CLOUD_HNCB_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.hncb,
  },
  {
    id: "ctbc",
    enabledKey: "LIBRETTO_CLOUD_CTBC_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_CTBC_USER_ID",
      "LIBRETTO_CLOUD_CTBC_ACCOUNT",
      "LIBRETTO_CLOUD_CTBC_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.ctbc,
  },
  {
    id: "post",
    enabledKey: "LIBRETTO_CLOUD_POST_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_POST_USER_ID",
      "LIBRETTO_CLOUD_POST_ACCOUNT",
      "LIBRETTO_CLOUD_POST_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.post,
  },
  {
    id: "sinopac",
    enabledKey: "LIBRETTO_CLOUD_SINOPAC_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_SINOPAC_USER_ID",
      "LIBRETTO_CLOUD_SINOPAC_ACCOUNT",
      "LIBRETTO_CLOUD_SINOPAC_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.sinopac,
  },
  {
    id: "linebank",
    enabledKey: "LIBRETTO_CLOUD_LINEBANK_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_LINEBANK_USER_ID",
      "LIBRETTO_CLOUD_LINEBANK_ACCOUNT",
      "LIBRETTO_CLOUD_LINEBANK_PASSWORD",
    ],
    ...BANK_STATEMENT_CAPABILITIES.linebank,
  },
  {
    id: "einvoice",
    label: "E-Invoice",
    enabledKey: "LIBRETTO_CLOUD_EINVOICE_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER",
      "LIBRETTO_CLOUD_EINVOICE_PASSWORD",
    ],
  },
  {
    id: "maicoin",
    label: "MaiCoin",
    enabledKey: "MAX_ENABLED",
    credentialKeys: ["MAX_ACCESS_KEY", "MAX_SECRET_KEY", "MAX_SUB_ACCOUNT"],
  },
];

export const AUTOMATION_TASKS: readonly AutomationTask[] = [
  {
    id: "fubon-all-statements",
    label: "Fubon all statements",
    script: "run:fubon-all-statements",
    command: ["libretto", "run", "src/workflows/fubon-all-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "fubon",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[0].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "esun-credit-card-statements",
    label: "ESun credit card statements",
    script: "run:esun-credit-card-statements",
    command: ["libretto", "run", "src/workflows/esun-credit-card-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "esun",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[1].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "yuanta-all-statements",
    label: "Yuanta all statements",
    script: "run:yuanta-all-statements",
    command: ["libretto", "run", "src/workflows/yuanta-all-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "yuanta",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[2].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "yuanta-trade-statements",
    label: "Yuanta trade statements",
    script: "run:yuanta-trade-statements",
    command: ["libretto", "run", "src/workflows/yuanta-trade-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "yuanta-trade",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[3].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "cathay-all-statements",
    label: "Cathay all statements",
    script: "run:cathay-all-statements",
    command: ["libretto", "run", "src/workflows/cathay-all-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "cathay",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[4].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "hncb-statements",
    label: "HNCB statements",
    script: "run:hncb-statements",
    command: ["libretto", "run", "src/workflows/hncb-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "hncb",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[5].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "ctbc-statements",
    label: "CTBC statements",
    script: "run:ctbc-statements",
    command: ["libretto", "run", "src/workflows/ctbc-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "ctbc",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[6].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "post-statements",
    label: "Post Office statements",
    script: "run:post-statements",
    command: ["libretto", "run", "src/workflows/post-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "post",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[7].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "sinopac-statements",
    label: "SinoPac statements",
    script: "run:sinopac-statements",
    command: ["libretto", "run", "src/workflows/sinopac-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "sinopac",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[8].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "linebank-statements",
    label: "LINE Bank statements",
    script: "run:linebank-statements",
    command: ["libretto", "run", "src/workflows/linebank-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "linebank",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[9].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "einvoice-personal-invoices",
    label: "E-Invoice personal invoices",
    script: "run:einvoice-personal-invoices",
    command: [
      "libretto",
      "run",
      "src/workflows/einvoice-personal-invoices.ts",
      "--headless",
    ],
    kind: "crawler",
    credentialGroupId: "einvoice",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[10].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "exchange-rates",
    label: "Exchange rates",
    script: "run:exchange-rates",
    command: [
      "node",
      "--no-warnings",
      "--experimental-strip-types",
      "src/ledger/sync-exchange-rates.ts",
    ],
    kind: "sync",
    credentialKeys: [],
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "sync-maicoin",
    label: "MaiCoin sync",
    script: "run:sync-maicoin",
    command: [
      "node",
      "--env-file-if-exists=.env",
      "--no-warnings",
      "--experimental-strip-types",
      "src/ledger/sync-maicoin.ts",
    ],
    kind: "sync",
    credentialGroupId: "maicoin",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[11].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "import-downloads-csv",
    label: "Import downloads CSV",
    script: "run:import-downloads-csv",
    command: ["node", "--no-warnings", "--experimental-strip-types", "src/ledger/import-downloads-csv.ts"],
    kind: "import",
    credentialKeys: [],
    dependencies: CSV_IMPORT_DEPENDENCY_IDS,
    maxAttempts: 1,
  },
];

export const AUTOMATION_CREDENTIAL_KEYS = Array.from(
  new Set(AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) => group.credentialKeys)),
);

export const AUTOMATION_ENABLED_KEYS = AUTOMATION_CREDENTIAL_GROUPS.map((group) => group.enabledKey);

const AUTOMATION_STATEMENT_SELECTION_KEYS = AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) =>
  group.statementSelectionKey ? [group.statementSelectionKey] : [],
);

export const AUTOMATION_NON_SECRET_KEYS = [
  "SYSTEM_TIMEZONE",
  "EXCHANGE_RATE_UPDATE_TIME",
  "AUTOMATION_BUSINESS_TIMEZONE",
  "MAX_SUB_ACCOUNT",
  ...AUTOMATION_ENABLED_KEYS,
  ...AUTOMATION_STATEMENT_SELECTION_KEYS,
] as const;

const nonSecretCredentialKeys = new Set<string>(["MAX_SUB_ACCOUNT"]);

export const AUTOMATION_SECRET_KEYS = AUTOMATION_CREDENTIAL_KEYS.filter(
  (key) => !nonSecretCredentialKeys.has(key),
);

export function automationCredentialKeyIsSecret(key: string) {
  return !nonSecretCredentialKeys.has(key);
}

export function taskById(taskId: string) {
  return AUTOMATION_TASKS.find((task) => task.id === taskId) ?? null;
}

export function assertTaskStatementSelection(
  task: AutomationTask,
  settings: Record<string, string | boolean | undefined>,
) {
  if (!task.credentialGroupId) return;
  const group = AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId);
  if (!group?.statementSelectionKey || !group.statementTypes) return;
  const selection = resolveStatementSelection(
    { label: group.label, statementSelectionKey: group.statementSelectionKey, statementTypes: group.statementTypes },
    settings,
    settings[group.enabledKey] !== false,
  );
  if (selection.needsSetup) throw new Error(`Select at least one ${group.label} statement type.`);
}

function taskIsEnabled(task: AutomationTask, enabledGroups: Record<string, boolean>) {
  return !task.credentialGroupId || enabledGroups[task.credentialGroupId] !== false;
}

export function enabledAutomationTasks(enabledGroups: Record<string, boolean>) {
  return AUTOMATION_TASKS.filter((task) => task.kind === "import" || taskIsEnabled(task, enabledGroups));
}

export function enabledCsvImportDependencyIds(enabledGroups: Record<string, boolean>) {
  return CSV_IMPORT_DEPENDENCY_IDS.filter((taskId) => {
    const task = taskById(taskId);
    return task ? taskIsEnabled(task, enabledGroups) : false;
  });
}
