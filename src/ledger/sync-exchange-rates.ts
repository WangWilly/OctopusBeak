import { pathToFileURL } from "node:url";
import {
  appendExchangeRateAuditRecord,
  type ExchangeRateAuditRecord,
} from "./exchange-rate-audit-log.ts";
import {
  loadExchangeRateRequest,
  type ExchangeRateRequest,
} from "./exchange-rate-requirements.ts";
import {
  syncExchangeRates,
  type ExchangeRateSyncResult,
} from "./exchange-rates.ts";
import { DEFAULT_LEDGER_DIR } from "./db/client.ts";

const AUDIT_LOG_PATH = "data/automation/logs/exchange-rates.log";

type CommandOptions = {
  argv?: string[];
  ledgerDir?: string;
  loadRequest?: (ledgerDir: string) => Promise<ExchangeRateRequest>;
  sync?: (
    ledgerDir: string,
    request: ExchangeRateRequest,
  ) => Promise<ExchangeRateSyncResult>;
  appendAudit?: (path: string, record: ExchangeRateAuditRecord) => void;
  now?: () => Date;
  stderr?: { write(chunk: string): unknown };
};

function scheduledAtUtc(argv: string[]) {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== "--scheduled-at-utc") {
    throw new Error(`Unknown arguments: ${argv.join(" ")}`);
  }
  const value = argv[1];
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  const parsed = new Date(value);
  const normalized = Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString();
  const expected = match
    ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`
    : "";
  if (!match || normalized !== expected) {
    throw new Error(`Invalid --scheduled-at-utc: ${value}`);
  }
  return normalized;
}

export async function runExchangeRateSyncCommand(
  options: CommandOptions = {},
): Promise<ExchangeRateSyncResult> {
  const now = options.now ?? (() => new Date());
  const appendAudit = options.appendAudit ?? appendExchangeRateAuditRecord;
  const stderr = options.stderr ?? process.stderr;
  const startedAtUtc = now().toISOString();
  let scheduled: string | null = null;
  let request: ExchangeRateRequest = { requiredFrom: null, currencies: [] };

  const audit = (record: ExchangeRateAuditRecord) => {
    try {
      appendAudit(AUDIT_LOG_PATH, record);
    } catch (error) {
      stderr.write(`exchange-rate-audit-log-warning: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  try {
    scheduled = scheduledAtUtc(options.argv ?? []);
    request = await (options.loadRequest ?? loadExchangeRateRequest)(
      options.ledgerDir ?? DEFAULT_LEDGER_DIR,
    );
    const result = await (options.sync ?? syncExchangeRates)(
      options.ledgerDir ?? DEFAULT_LEDGER_DIR,
      request,
    );
    audit({
      scheduledAtUtc: scheduled,
      startedAtUtc,
      finishedAtUtc: now().toISOString(),
      requiredFrom: request.requiredFrom,
      currencies: request.currencies,
      written: result.written,
      status: "success",
    });
    return result;
  } catch (error) {
    audit({
      scheduledAtUtc: scheduled,
      startedAtUtc,
      finishedAtUtc: now().toISOString(),
      requiredFrom: request.requiredFrom,
      currencies: request.currencies,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

const isCliEntry = process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCliEntry) {
  runExchangeRateSyncCommand({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
