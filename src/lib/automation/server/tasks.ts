export type AutomationTaskKind = "crawler" | "sync" | "import";

export type AutomationTask = {
  id: string;
  label: string;
  script: string;
  command: readonly string[];
  kind: AutomationTaskKind;
  credentialGroupId?: string;
  credentialKeys: readonly string[];
  dependencies: readonly string[];
  maxAttempts: number;
};

export type AutomationCredentialGroup = {
  id: string;
  label: string;
  enabledKey: string;
  credentialKeys: readonly string[];
};

export const CSV_IMPORT_DEPENDENCY_IDS = [
  "fubon-all-statements",
  "esun-credit-card-statements",
  "yuanta-all-statements",
  "yuanta-trade-statements",
  "cathay-all-statements",
  "hncb-statements",
] as const;

export const AUTOMATION_CREDENTIAL_GROUPS: readonly AutomationCredentialGroup[] = [
  {
    id: "fubon",
    label: "Fubon",
    enabledKey: "LIBRETTO_CLOUD_FUBON_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_FUBON_USER_ID",
      "LIBRETTO_CLOUD_FUBON_ACCOUNT",
      "LIBRETTO_CLOUD_FUBON_PASSWORD",
    ],
  },
  {
    id: "esun",
    label: "ESun",
    enabledKey: "LIBRETTO_CLOUD_ESUN_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_ESUN_USER_ID",
      "LIBRETTO_CLOUD_ESUN_ACCOUNT",
      "LIBRETTO_CLOUD_ESUN_PASSWORD",
    ],
  },
  {
    id: "yuanta",
    label: "Yuanta",
    enabledKey: "LIBRETTO_CLOUD_YUANTA_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_ACCOUNT",
      "LIBRETTO_CLOUD_YUANTA_PASSWORD",
    ],
  },
  {
    id: "yuanta-trade",
    label: "Yuanta Trade",
    enabledKey: "LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD",
    ],
  },
  {
    id: "cathay",
    label: "Cathay",
    enabledKey: "LIBRETTO_CLOUD_CATHAY_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_CATHAY_USER_ID",
      "LIBRETTO_CLOUD_CATHAY_ACCOUNT",
      "LIBRETTO_CLOUD_CATHAY_PASSWORD",
    ],
  },
  {
    id: "hncb",
    label: "HNCB",
    enabledKey: "LIBRETTO_CLOUD_HNCB_ENABLED",
    credentialKeys: [
      "LIBRETTO_CLOUD_HNCB_USER_ID",
      "LIBRETTO_CLOUD_HNCB_ACCOUNT",
      "LIBRETTO_CLOUD_HNCB_PASSWORD",
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
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[6].credentialKeys,
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

export function taskById(taskId: string) {
  return AUTOMATION_TASKS.find((task) => task.id === taskId) ?? null;
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
