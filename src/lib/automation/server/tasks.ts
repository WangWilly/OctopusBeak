export type AutomationTaskKind = "crawler" | "sync" | "import";

export type AutomationTask = {
  id: string;
  label: string;
  script: string;
  kind: AutomationTaskKind;
  credentialKeys: readonly string[];
  dependencies: readonly string[];
  maxAttempts: number;
};

export const CSV_IMPORT_DEPENDENCY_IDS = [
  "fubon-all-statements",
  "esun-credit-card-statements",
  "yuanta-all-statements",
  "yuanta-trade-statements",
  "cathay-all-statements",
  "hncb-statements",
] as const;

export const AUTOMATION_TASKS: readonly AutomationTask[] = [
  {
    id: "fubon-all-statements",
    label: "Fubon all statements",
    script: "run:fubon-all-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_FUBON_USER_ID",
      "LIBRETTO_CLOUD_FUBON_ACCOUNT",
      "LIBRETTO_CLOUD_FUBON_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "esun-credit-card-statements",
    label: "ESun credit card statements",
    script: "run:esun-credit-card-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_ESUN_USER_ID",
      "LIBRETTO_CLOUD_ESUN_ACCOUNT",
      "LIBRETTO_CLOUD_ESUN_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "yuanta-all-statements",
    label: "Yuanta all statements",
    script: "run:yuanta-all-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_ACCOUNT",
      "LIBRETTO_CLOUD_YUANTA_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "yuanta-trade-statements",
    label: "Yuanta trade statements",
    script: "run:yuanta-trade-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "cathay-all-statements",
    label: "Cathay all statements",
    script: "run:cathay-all-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_CATHAY_USER_ID",
      "LIBRETTO_CLOUD_CATHAY_ACCOUNT",
      "LIBRETTO_CLOUD_CATHAY_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "hncb-statements",
    label: "HNCB statements",
    script: "run:hncb-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_HNCB_USER_ID",
      "LIBRETTO_CLOUD_HNCB_ACCOUNT",
      "LIBRETTO_CLOUD_HNCB_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "sync-maicoin",
    label: "MaiCoin sync",
    script: "run:sync-maicoin",
    kind: "sync",
    credentialKeys: ["MAX_ACCESS_KEY", "MAX_SECRET_KEY", "MAX_SUB_ACCOUNT"],
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "import-downloads-csv",
    label: "Import downloads CSV",
    script: "run:import-downloads-csv",
    kind: "import",
    credentialKeys: [],
    dependencies: CSV_IMPORT_DEPENDENCY_IDS,
    maxAttempts: 1,
  },
];

export function taskById(taskId: string) {
  return AUTOMATION_TASKS.find((task) => task.id === taskId) ?? null;
}
