export const INSTITUTION_KEYS = [
  "fubon",
  "esun",
  "yuanta-bank",
  "yuanta-securities",
  "cathay",
  "hncb",
  "ctbc",
  "post",
  "sinopac",
  "linebank",
  "einvoice",
  "maicoin",
] as const;

export type InstitutionKey = (typeof INSTITUTION_KEYS)[number];

const NAMESPACE_INSTITUTIONS: Readonly<Record<string, InstitutionKey>> = {
  fubon: "fubon",
  esun: "esun",
  yuanta: "yuanta-bank",
  "yuanta-fund": "yuanta-bank",
  "yuanta-trade": "yuanta-securities",
  cathay: "cathay",
  hncb: "hncb",
  ctbc: "ctbc",
  post: "post",
  sinopac: "sinopac",
  linebank: "linebank",
  einvoice: "einvoice",
  maicoin: "maicoin",
};

const TASK_INSTITUTIONS: Readonly<Record<string, InstitutionKey>> = {
  "fubon-all-statements": "fubon",
  "esun-credit-card-statements": "esun",
  "yuanta-all-statements": "yuanta-bank",
  "yuanta-trade-statements": "yuanta-securities",
  "cathay-all-statements": "cathay",
  "hncb-statements": "hncb",
  "ctbc-statements": "ctbc",
  "post-statements": "post",
  "sinopac-statements": "sinopac",
  "linebank-statements": "linebank",
  "einvoice-personal-invoices": "einvoice",
  "sync-maicoin": "maicoin",
};

export function institutionForNamespace(namespace: string | undefined): InstitutionKey | null {
  return (namespace && NAMESPACE_INSTITUTIONS[namespace]) || null;
}

export function institutionForTask(taskId: string): InstitutionKey | null {
  return TASK_INSTITUTIONS[taskId] ?? null;
}

export function institutionLogoFile(key: InstitutionKey): string {
  return `${key}.webp`;
}
