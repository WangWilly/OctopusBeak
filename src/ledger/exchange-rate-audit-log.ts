import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ExchangeRateAuditRecord = {
  scheduledAtUtc: string | null;
  startedAtUtc: string;
  finishedAtUtc: string;
  requiredFrom: string | null;
  currencies: string[];
  written?: number;
  status: "success" | "failed";
  error?: string;
};

export function appendExchangeRateAuditRecord(
  path: string,
  record: ExchangeRateAuditRecord,
) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
