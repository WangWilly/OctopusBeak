import { pathToFileURL } from "node:url";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
  requirePGliteChildRpcClientFromEnv,
} from "../../electron/pglite-child-rpc-client.ts";
import {
  exchangeRateRequestFromOverview,
  type ExchangeRateRequest,
} from "./exchange-rate-requirements.ts";
import {
  syncExchangeRates,
  type ExchangeRatePersistencePort,
  type ExchangeRateSyncResult,
} from "./exchange-rates.ts";
import {
  createExchangeRateCliPGliteWorkerClient,
  type ExchangeRateCliPGliteWorkerClient,
} from "./pglite/exchange-rate-cli-worker.ts";
import type { AutomationProgressEvent } from "../lib/automation/progress.ts";

const DEFAULT_LEDGER_DIR = process.env.LEDGER_DIR ?? "data/ledger";

type ExchangeRateCliPGliteProvider = Readonly<{
  ready: Promise<void>;
  exchangeRates: ExchangeRatePersistencePort;
  overviewCurrent(): ReturnType<ExchangeRateCliPGliteWorkerClient["overviewCurrent"]>;
  close(): void | Promise<unknown>;
}>;

function createCliPGliteProvider(ledgerDir: string): ExchangeRateCliPGliteProvider {
  if (process.env[PGLITE_CHILD_RPC_ENDPOINT_ENV] !== undefined
    || process.env[PGLITE_CHILD_RPC_TOKEN_ENV] !== undefined) {
    const client = requirePGliteChildRpcClientFromEnv();
    return {
      ready: client.ready,
      exchangeRates: client.operationalProvider.exchangeRates,
      overviewCurrent: () => client.financial.overviewCurrent(),
      close: () => client.close(),
    };
  }
  return createExchangeRateCliPGliteWorkerClient(ledgerDir);
}

type CommandOptions = {
  argv?: string[];
  ledgerDir?: string;
  loadRequest?: (ledgerDir: string) => Promise<ExchangeRateRequest>;
  sync?: (
    ledgerDir: string,
    request: ExchangeRateRequest,
  ) => Promise<ExchangeRateSyncResult>;
  emitProgress?: (event: Omit<AutomationProgressEvent, "type">) => void;
};

function validateScheduledAtUtc(argv: string[]) {
  if (argv.length === 0) return;
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
}

export async function runExchangeRateSyncCommand(
  options: CommandOptions = {},
): Promise<ExchangeRateSyncResult> {
  let pglite: ExchangeRateCliPGliteProvider | undefined;

  const closePGlite = async () => {
    const owned = pglite;
    pglite = undefined;
    await owned?.close();
  };

  try {
    validateScheduledAtUtc(options.argv ?? []);
    options.emitProgress?.({ phaseCode: "load-request", completed: 0, total: 3, percent: 0 });
    const ledgerDir = options.ledgerDir ?? DEFAULT_LEDGER_DIR;
    if (!options.loadRequest || !options.sync) {
      pglite = createCliPGliteProvider(ledgerDir);
      await pglite.ready;
    }
    const request = options.loadRequest
      ? await options.loadRequest(ledgerDir)
      : exchangeRateRequestFromOverview(await pglite!.overviewCurrent());
    options.emitProgress?.({ phaseCode: "sync", completed: 1, total: 3, percent: 33 });
    const result = options.sync
      ? await options.sync(ledgerDir, request)
      : await syncExchangeRates(pglite!.exchangeRates, request);
    await closePGlite();
    options.emitProgress?.({ phaseCode: "complete", completed: 3, total: 3, percent: 100 });
    return result;
  } catch (error) {
    await closePGlite().catch(() => undefined);
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
