import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_LEDGER_DIR,
  openLedgerDatabase,
  type LedgerDatabase,
} from "./db/client.ts";

const API_BASE_URL = "https://max-api.maicoin.com";
const DEFAULT_STATEMENT_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRY_DELAYS_MS = [500, 1_000, 2_000];
const WALLET_TYPES = ["spot", "m"] as const;

type WalletType = typeof WALLET_TYPES[number];
type QueryParams = Record<string, string | number | boolean | undefined>;

type CliParams = {
  ledgerDir: string;
  walletTypes: WalletType[];
  statementJson: string | null;
  statementLimit: number;
  subAccount: string;
  selfTest: boolean;
  help: boolean;
};

type Credentials = {
  accessKey: string;
  secretKey: string;
  subAccount: string;
};

type Account = {
  currency: string;
  balance: string;
  locked: string;
  staked?: string | null;
  principal?: string | null;
  interest?: string | null;
  [key: string]: unknown;
};

type Market = {
  id: string;
  base_unit: string;
  quote_unit: string;
  status: string;
};

type Ticker = {
  market: string;
  at: number;
  last: string;
  [key: string]: unknown;
};

type AccountSnapshot = {
  walletType: WalletType;
  account: Account;
  price: PriceQuote;
  totalQuantity: number;
  valueTwd: number | null;
};

type PriceQuote = {
  market: string | null;
  currency: string | null;
  price: number | null;
  at: string | null;
  raw: unknown;
};

type StatementBatch = {
  endpoint: string;
  walletType: WalletType | null;
  rowType: string;
  rows: Record<string, unknown>[];
};

type StatementSpec = Omit<StatementBatch, "rows">;
type StatementValueMap = Map<string, number | null>;
type KLine = [number, number | string, number | string, number | string, number | string, number | string];

class MaxClient {
  #lastNonce = 0;
  private readonly credentials: Credentials;

  constructor(credentials: Credentials) {
    this.credentials = credentials;
  }

  async publicGet<T>(path: string, params: QueryParams = {}): Promise<T> {
    return fetchWithRetry(() => {
      const url = new URL(path, API_BASE_URL);
      appendQuery(url, params);
      return fetchJson<T>(url);
    });
  }

  async privateGet<T>(path: string, params: QueryParams = {}): Promise<T> {
    return fetchWithRetry(() => {
      const signedParams = { nonce: this.nextNonce(), ...params };
      const { payload, signature } = signPayload(
        path,
        signedParams,
        this.credentials.secretKey,
      );
      const url = new URL(path, API_BASE_URL);
      appendQuery(url, signedParams);
      return fetchJson<T>(url, {
        headers: {
          "Content-Type": "application/json",
          "X-MAX-ACCESSKEY": this.credentials.accessKey,
          "X-MAX-PAYLOAD": payload,
          "X-MAX-SIGNATURE": signature,
          "X-Sub-Account": this.credentials.subAccount,
        },
      });
    });
  }

  private nextNonce() {
    this.#lastNonce = Math.max(Date.now(), this.#lastNonce + 1);
    return this.#lastNonce;
  }
}

function usage() {
  return `Usage:
  npm run run:sync-maicoin
  npm run run:sync-maicoin -- --statement-json data/ledger/maicoin-statement.json

Options:
  --ledger-dir <dir>       SQLite ledger directory. Default: ${DEFAULT_LEDGER_DIR}
  --wallet-types <list>    Comma list: spot,m. Default: spot,m
  --statement-json <file>  Export full statement rows as JSON
  --limit <n>              Statement page size per endpoint. Max/default: ${DEFAULT_STATEMENT_LIMIT}
  --sub-account <name>     MAX sub-account header. Default: main
  --self-test              Run local checks only
`;
}

function parseCli(argv: string[]): CliParams {
  const params: CliParams = {
    ledgerDir: process.env.LEDGER_DIR ?? DEFAULT_LEDGER_DIR,
    walletTypes: [...WALLET_TYPES],
    statementJson: null,
    statementLimit: DEFAULT_STATEMENT_LIMIT,
    subAccount: process.env.MAX_SUB_ACCOUNT ?? "main",
    selfTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      params.help = true;
    } else if (arg === "--self-test") {
      params.selfTest = true;
    } else if (arg === "--ledger-dir") {
      params.ledgerDir = requireValue(argv, ++index, arg);
    } else if (arg === "--wallet-types" || arg === "--wallet-type") {
      params.walletTypes = parseWalletTypes(requireValue(argv, ++index, arg));
    } else if (arg === "--statement-json") {
      params.statementJson = requireValue(argv, ++index, arg);
    } else if (arg === "--limit") {
      const limit = parsePositiveInt(requireValue(argv, ++index, arg), arg);
      if (limit > DEFAULT_STATEMENT_LIMIT) throw new Error(`${arg} must be <= ${DEFAULT_STATEMENT_LIMIT}`);
      params.statementLimit = limit;
    } else if (arg === "--sub-account") {
      params.subAccount = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return params;
}

function requireValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return numberValue;
}

function parseWalletTypes(value: string): WalletType[] {
  const walletTypes = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (walletTypes.length === 0) throw new Error("--wallet-types cannot be empty");
  for (const walletType of walletTypes) {
    if (!WALLET_TYPES.includes(walletType as WalletType)) {
      throw new Error(`Unsupported wallet type: ${walletType}`);
    }
  }
  return walletTypes as WalletType[];
}

function credentialsFromEnv(subAccount: string): Credentials {
  const accessKey = process.env.MAX_ACCESS_KEY;
  const secretKey = process.env.MAX_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error("Set MAX_ACCESS_KEY and MAX_SECRET_KEY before running sync-maicoin.");
  }
  return { accessKey, secretKey, subAccount };
}

function appendQuery(url: URL, params: QueryParams) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.append(key, String(value));
  }
}

async function fetchJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`${init.method ?? "GET"} ${url.pathname} failed ${response.status}: ${body}`) as Error & {
      status: number;
    };
    error.status = response.status;
    throw error;
  }
  const data = body ? JSON.parse(body) : null;
  return data as T;
}

async function fetchWithRetry<T>(
  request: () => Promise<T>,
  delays = FETCH_RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt === delays.length || !isRetryableFetchError(error)) throw error;
      await sleep(delays[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableFetchError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status: unknown }).status
    : null;
  return typeof status !== "number" || status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signPayload(path: string, params: QueryParams, secretKey: string) {
  const payload = Buffer.from(JSON.stringify({ ...params, path })).toString("base64");
  const signature = createHmac("sha256", secretKey).update(payload).digest("hex");
  return { payload, signature };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function amount(value: unknown) {
  return numeric(value) ?? 0;
}

function isoFromTimestamp(value: unknown): string | null {
  const timestamp = numeric(value);
  if (timestamp === null) return null;
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp).toISOString();
}

function createdAtMillis(row: Record<string, unknown>) {
  const timestamp = numeric(row.created_at) ?? 0;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function hashId(...parts: unknown[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? part : JSON.stringify(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function statementExternalId(row: Record<string, unknown>) {
  return String(row.id ?? row.sn ?? row.uuid ?? hashId(row));
}

function statementIdFor(batch: StatementSpec, row: Record<string, unknown>) {
  return hashId(batch.endpoint, batch.walletType ?? "", batch.rowType, statementExternalId(row));
}

function accountHasValue(account: Account) {
  return (
    amount(account.balance) !== 0 ||
    amount(account.locked) !== 0 ||
    amount(account.staked) !== 0 ||
    amount(account.principal) !== 0 ||
    amount(account.interest) !== 0
  );
}

function totalQuantity(account: Account) {
  return amount(account.balance) + amount(account.locked) + amount(account.staked);
}

function priceForCurrency(currency: string, tickers: Map<string, Ticker>): PriceQuote {
  const normalized = currency.toLowerCase();
  if (normalized === "twd") {
    return { market: null, currency: "TWD", price: 1, at: null, raw: null };
  }

  const direct = tickers.get(`${normalized}twd`);
  if (direct) return tickerQuote(direct, "TWD");

  if (normalized === "usdt") {
    return { ...missingQuote(), market: "usdttwd", currency: "TWD" };
  }

  const viaUsdt = tickers.get(`${normalized}usdt`);
  const usdtTwd = tickers.get("usdttwd");
  const viaUsdtPrice = numeric(viaUsdt?.last);
  const usdtTwdPrice = numeric(usdtTwd?.last);
  if (viaUsdt && usdtTwd && viaUsdtPrice !== null && usdtTwdPrice !== null) {
    return {
      market: `${viaUsdt.market}+${usdtTwd.market}`,
      currency: "TWD",
      price: viaUsdtPrice * usdtTwdPrice,
      at: isoFromTimestamp(Math.max(viaUsdt.at, usdtTwd.at)),
      raw: [viaUsdt, usdtTwd],
    };
  }

  return missingQuote();
}

function tickerQuote(ticker: Ticker, currency: string): PriceQuote {
  return {
    market: ticker.market,
    currency,
    price: numeric(ticker.last),
    at: isoFromTimestamp(ticker.at),
    raw: ticker,
  };
}

function missingQuote(): PriceQuote {
  return { market: null, currency: null, price: null, at: null, raw: null };
}

function tickerMarketsForAccounts(accounts: Account[], markets: Set<string>) {
  const tickerMarkets = new Set<string>();
  for (const account of accounts) {
    const currency = account.currency.toLowerCase();
    if (currency === "twd") continue;
    if (markets.has(`${currency}twd`)) tickerMarkets.add(`${currency}twd`);
    if (markets.has(`${currency}usdt`)) tickerMarkets.add(`${currency}usdt`);
    if (markets.has("usdttwd")) tickerMarkets.add("usdttwd");
  }
  return tickerMarkets;
}

async function fetchTickers(client: MaxClient, markets: Set<string>) {
  if (markets.size === 0) return new Map<string, Ticker>();
  const url = new URL("/api/v3/tickers", API_BASE_URL);
  for (const market of [...markets].sort()) {
    url.searchParams.append("markets[]", market);
  }
  const tickers = await fetchJson<Ticker[]>(url);
  return new Map(tickers.map((ticker) => [ticker.market, ticker]));
}

async function statementValueMap(
  client: MaxClient,
  statement: StatementBatch[],
  markets: Set<string>,
): Promise<StatementValueMap> {
  const cache = new Map<string, Promise<number | null>>();
  const values: StatementValueMap = new Map();
  for (const batch of statement) {
    for (const row of batch.rows) {
      values.set(statementIdFor(batch, row), await statementValueTwd(client, markets, cache, batch.rowType, row));
    }
  }
  return values;
}

async function statementValueTwd(
  client: MaxClient,
  markets: Set<string>,
  cache: Map<string, Promise<number | null>>,
  rowType: string,
  row: Record<string, unknown>,
) {
  const timestamp = createdAtMillis(row);
  if (!timestamp) return null;

  if (rowType === "trade") {
    const units = marketUnits(stringValue(row.market));
    const quotePrice = units ? await historicalPriceTwd(client, markets, cache, units.quote, timestamp) : null;
    return quotePrice === null ? null : amount(row.funds) * quotePrice;
  }

  if (rowType === "convert") {
    const price = await historicalPriceTwd(client, markets, cache, stringValue(row.from_currency), timestamp);
    return price === null ? null : amount(row.from_amount) * price;
  }

  if (rowType === "deposit" || rowType === "reward" || rowType === "withdrawal") {
    const price = await historicalPriceTwd(client, markets, cache, stringValue(row.currency), timestamp);
    return price === null ? null : amount(row.amount) * price;
  }

  return null;
}

async function historicalPriceTwd(
  client: MaxClient,
  markets: Set<string>,
  cache: Map<string, Promise<number | null>>,
  currency: string | null,
  timestamp: number,
) {
  const normalized = currency?.toLowerCase();
  if (!normalized) return null;
  if (normalized === "twd") return 1;
  const day = dayStartSeconds(timestamp);
  const key = `${normalized}:${day}`;
  if (!cache.has(key)) {
    cache.set(key, historicalPriceTwdUncached(client, markets, normalized, day));
  }
  return cache.get(key)!;
}

async function historicalPriceTwdUncached(
  client: MaxClient,
  markets: Set<string>,
  normalized: string,
  dayStart: number,
) {
  const directMarket = `${normalized}twd`;
  if (markets.has(directMarket)) return historicalMarketClose(client, directMarket, dayStart);

  const viaUsdtMarket = `${normalized}usdt`;
  if (!markets.has(viaUsdtMarket) || !markets.has("usdttwd")) return null;
  const [viaUsdt, usdtTwd] = await Promise.all([
    historicalMarketClose(client, viaUsdtMarket, dayStart),
    historicalMarketClose(client, "usdttwd", dayStart),
  ]);
  return viaUsdt === null || usdtTwd === null ? null : viaUsdt * usdtTwd;
}

async function historicalMarketClose(client: MaxClient, market: string, dayStart: number) {
  try {
    const rows = await client.publicGet<KLine[]>("/api/v3/k", {
      market,
      period: 1440,
      limit: 2,
      timestamp: dayStart,
    });
    const row = rows.find((item) => Number(item[0]) >= dayStart && Number(item[0]) < dayStart + 86400) ?? rows[0];
    return numeric(row?.[4]);
  } catch {
    return null;
  }
}

function dayStartSeconds(timestamp: number) {
  return Math.floor(timestamp / 86_400_000) * 86_400;
}

function marketUnits(market: string | null) {
  if (!market) return null;
  for (const quote of ["usdt", "usdc", "twd", "btc", "eth"]) {
    if (market.endsWith(quote) && market.length > quote.length) {
      return { base: market.slice(0, -quote.length), quote };
    }
  }
  return null;
}

async function fetchWalletTypes(client: MaxClient, requested: WalletType[]) {
  if (!requested.includes("m")) return requested;
  const info = await client.privateGet<{ m_wallet_enabled?: boolean }>("/api/v3/info");
  if (info.m_wallet_enabled === false) return requested.filter((walletType) => walletType !== "m");
  return requested;
}

async function fetchAccounts(client: MaxClient, walletTypes: WalletType[]) {
  const batches: Array<{ walletType: WalletType; accounts: Account[] }> = [];
  for (const walletType of walletTypes) {
    const accounts = await client.privateGet<Account[]>(`/api/v3/wallet/${walletType}/accounts`);
    batches.push({ walletType, accounts: accounts.filter(accountHasValue) });
  }
  return batches;
}

async function fetchStatement(
  client: MaxClient,
  walletTypes: WalletType[],
  limit: number,
) {
  const specs: StatementSpec[] = [
    ...walletTypes.map((walletType) => ({
      endpoint: `/api/v3/wallet/${walletType}/trades`,
      walletType,
      rowType: "trade",
    })),
    {
      endpoint: "/api/v3/fund_transactions/deposits",
      walletType: null,
      rowType: "deposit",
    },
    {
      endpoint: "/api/v3/fund_transactions/withdrawals",
      walletType: null,
      rowType: "withdrawal",
    },
    {
      endpoint: "/api/v3/fund_transactions/transfers",
      walletType: null,
      rowType: "transfer",
    },
    {
      endpoint: "/api/v3/rewards",
      walletType: null,
      rowType: "reward",
    },
    {
      endpoint: "/api/v3/converts",
      walletType: null,
      rowType: "convert",
    },
  ];

  const batches: StatementBatch[] = [];
  for (const spec of specs) {
    const rows = await fetchFullStatementRows(client, spec.endpoint, limit);
    batches.push({ ...spec, rows });
  }
  return batches;
}

async function fetchFullStatementRows(client: MaxClient, endpoint: string, limit: number) {
  const rows: Record<string, unknown>[] = [];
  let timestamp = 1512950400000;
  while (true) {
    const page = await client.privateGet<Record<string, unknown>[]>(endpoint, {
      order: "asc",
      limit,
      timestamp,
    });
    if (page.length === 0) break;

    rows.push(...page);
    const nextTimestamp = Math.max(...page.map((row) => createdAtMillis(row))) + 1;
    if (page.length < limit || nextTimestamp <= timestamp) break;
    timestamp = nextTimestamp;
  }
  return rows;
}

function buildSnapshots(
  accountBatches: Array<{ walletType: WalletType; accounts: Account[] }>,
  tickers: Map<string, Ticker>,
) {
  const snapshots: AccountSnapshot[] = [];
  for (const batch of accountBatches) {
    for (const account of batch.accounts) {
      const price = priceForCurrency(account.currency, tickers);
      const quantity = totalQuantity(account);
      snapshots.push({
        walletType: batch.walletType,
        account,
        price,
        totalQuantity: quantity,
        valueTwd: price.price === null ? null : quantity * price.price,
      });
    }
  }
  return snapshots;
}

function insertSyncRun(db: LedgerDatabase, params: CliParams, syncRunId: string, startedAt: string) {
  db.prepare(`
    INSERT INTO maicoin_sync_runs (
      sync_run_id,
      started_at,
      sub_account,
      wallet_types_json,
      statement_enabled,
      statement_limit,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    syncRunId,
    startedAt,
    params.subAccount,
    JSON.stringify(params.walletTypes),
    1,
    params.statementLimit,
    JSON.stringify({ status: "started", params }),
  );
}

function finishSyncRun(db: LedgerDatabase, syncRunId: string, record: Record<string, unknown>) {
  db.prepare(`
    UPDATE maicoin_sync_runs
    SET finished_at = ?, record_json = ?
    WHERE sync_run_id = ?
  `).run(new Date().toISOString(), JSON.stringify(record), syncRunId);
}

function insertSnapshots(
  db: LedgerDatabase,
  syncRunId: string,
  capturedAt: string,
  subAccount: string,
  snapshots: AccountSnapshot[],
) {
  const insert = db.prepare(`
    INSERT INTO maicoin_account_snapshots (
      snapshot_id,
      sync_run_id,
      captured_at,
      sub_account,
      wallet_type,
      currency,
      balance,
      locked,
      staked,
      principal,
      interest,
      total_quantity,
      price_market,
      price_currency,
      price,
      value_twd,
      price_at,
      raw_account_json,
      raw_price_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const snapshot of snapshots) {
    insert.run(
      randomUUID(),
      syncRunId,
      capturedAt,
      subAccount,
      snapshot.walletType,
      snapshot.account.currency.toLowerCase(),
      amount(snapshot.account.balance),
      amount(snapshot.account.locked),
      numeric(snapshot.account.staked),
      numeric(snapshot.account.principal),
      numeric(snapshot.account.interest),
      snapshot.totalQuantity,
      snapshot.price.market,
      snapshot.price.currency,
      snapshot.price.price,
      snapshot.valueTwd,
      snapshot.price.at,
      JSON.stringify(snapshot.account),
      snapshot.price.raw === null ? null : JSON.stringify(snapshot.price.raw),
    );
  }
}

function insertStatementRows(
  db: LedgerDatabase,
  syncRunId: string,
  capturedAt: string,
  statement: StatementBatch[],
  statementValues: StatementValueMap = new Map(),
) {
  const insert = db.prepare(`
    INSERT INTO maicoin_statement_rows (
      statement_id,
      sync_run_id,
      captured_at,
      endpoint,
      wallet_type,
      row_type,
      external_id,
      occurred_at,
      currency,
      amount,
      fee,
      fee_currency,
      market,
      side,
      price,
      value_twd,
      raw_payload_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(statement_id) DO UPDATE SET
      sync_run_id = excluded.sync_run_id,
      captured_at = excluded.captured_at,
      occurred_at = excluded.occurred_at,
      currency = excluded.currency,
      amount = excluded.amount,
      fee = excluded.fee,
      fee_currency = excluded.fee_currency,
      market = excluded.market,
      side = excluded.side,
      price = excluded.price,
      value_twd = excluded.value_twd,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const batch of statement) {
    for (const row of batch.rows) {
      const externalId = statementExternalId(row);
      const statementId = statementIdFor(batch, row);
      insert.run(
        statementId,
        syncRunId,
        capturedAt,
        batch.endpoint,
        batch.walletType,
        batch.rowType,
        externalId,
        isoFromTimestamp(row.created_at),
        stringValue(row.currency),
        numeric(row.amount ?? row.volume ?? row.funds),
        numeric(row.fee),
        stringValue(row.fee_currency),
        stringValue(row.market),
        stringValue(row.side),
        numeric(row.price),
        statementValues.get(statementId) ?? null,
        JSON.stringify(row),
      );
    }
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function writeStatementJson(filePath: string, statement: StatementBatch[]) {
  const outputPath = resolve(filePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(statement, null, 2));
  return outputPath;
}

async function syncMaicoin(params: CliParams) {
  console.log("automation-progress: 0");
  const credentials = credentialsFromEnv(params.subAccount);
  const client = new MaxClient(credentials);
  const syncRunId = randomUUID();
  const startedAt = new Date().toISOString();
  const db = openLedgerDatabase(params.ledgerDir);
  insertSyncRun(db, params, syncRunId, startedAt);

  try {
    const walletTypes = await fetchWalletTypes(client, params.walletTypes);
    const accountBatches = await fetchAccounts(client, walletTypes);
    const accounts = accountBatches.flatMap((batch) => batch.accounts);
    console.log("automation-progress: 25");
    const markets = new Set(
      (await client.publicGet<Market[]>("/api/v3/markets")).map((market) => market.id),
    );
    const tickers = await fetchTickers(client, tickerMarketsForAccounts(accounts, markets));
    const snapshots = buildSnapshots(accountBatches, tickers);
    const capturedAt = new Date().toISOString();
    console.log("automation-progress: 50");
    const statement = await fetchStatement(client, walletTypes, params.statementLimit);
    const statementValues = await statementValueMap(client, statement, markets);
    const statementJsonPath = params.statementJson
      ? await writeStatementJson(params.statementJson, statement)
      : null;
    console.log("automation-progress: 80");

    db.exec("BEGIN");
    try {
      insertSnapshots(db, syncRunId, capturedAt, credentials.subAccount, snapshots);
      insertStatementRows(db, syncRunId, capturedAt, statement, statementValues);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const result = {
      status: "completed",
      syncRunId,
      ledgerDir: params.ledgerDir,
      capturedAt,
      walletTypes,
      accountSnapshots: snapshots.length,
      statementMode: "full",
      statementRows: statement.reduce((sum, batch) => sum + batch.rows.length, 0),
      statementJsonPath,
      missingPrices: snapshots
        .filter((snapshot) => snapshot.price.price === null)
        .map((snapshot) => `${snapshot.walletType}:${snapshot.account.currency.toLowerCase()}`),
      totalValueTwd: snapshots.reduce((sum, snapshot) => sum + (snapshot.valueTwd ?? 0), 0),
    };
    finishSyncRun(db, syncRunId, result);
    console.log("automation-progress: 100");
    return result;
  } catch (error) {
    finishSyncRun(db, syncRunId, {
      status: "failed",
      syncRunId,
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    db.close();
  }
}

async function selfTest() {
  assert.equal(parseCli([]).statementLimit, DEFAULT_STATEMENT_LIMIT);
  assert.throws(() => parseCli(["--statement"]), /Unknown option/);
  assert.throws(() => parseCli(["--statement-full"]), /Unknown option/);
  assert.throws(() => parseCli(["--limit", "1001"]), /--limit must be <= 1000/);

  const signed = signPayload("/api/v3/info", { nonce: 123 }, "secret");
  assert.equal(
    signed.signature,
    createHmac("sha256", "secret").update(signed.payload).digest("hex"),
  );
  assert.deepEqual(JSON.parse(Buffer.from(signed.payload, "base64").toString()), {
    nonce: 123,
    path: "/api/v3/info",
  });

  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: calls === 2 }), {
        status: calls === 1 ? 503 : 200,
      });
    }) as typeof fetch;

    assert.deepEqual(
      await fetchWithRetry(() => fetchJson<{ ok: boolean }>(new URL("https://example.test/retry")), [0]),
      { ok: true },
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const tickers = new Map<string, Ticker>([
    ["usdttwd", { market: "usdttwd", at: 1_700_000_000, last: "31" }],
    ["btcusdt", { market: "btcusdt", at: 1_700_000_001, last: "50000" }],
  ]);
  assert.equal(priceForCurrency("twd", tickers).price, 1);
  assert.equal(priceForCurrency("btc", tickers).price, 1_550_000);

  const ledgerDir = await mkdtemp(join(tmpdir(), "maicoin-ledger-"));
  const db = openLedgerDatabase(ledgerDir);
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>).map((row) => row.name),
  );
  assert.equal(tables.has("maicoin_account_snapshots"), true);
  assert.equal(tables.has("maicoin_statement_rows"), true);
  db.close();
}

async function main() {
  const params = parseCli(process.argv.slice(2));
  if (params.help) {
    console.log(usage());
    return;
  }
  if (params.selfTest) {
    await selfTest();
    console.log("sync-maicoin self-test passed");
    return;
  }

  const result = await syncMaicoin(params);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
