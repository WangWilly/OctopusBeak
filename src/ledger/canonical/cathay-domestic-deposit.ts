import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CATHAY_INTEGRATION_NAMESPACE = "cathay";
export const CATHAY_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
export const CATHAY_DOMESTIC_DEPOSIT_AUTHORITY = "cathay/domestic-deposit/v1";
export const CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";
export const CANONICAL_SQLITE_FILE = "canonical.sqlite";

export const CATHAY_DOMESTIC_DEPOSIT_PROVENANCE = {
  validatedAt: "2026-08-17",
  source: "Cathay domestic deposit",
  values: "synthetic",
  liveResponseRetained: false,
  note: "Human-assisted validation covered response shape only; no live values are retained.",
} as const;

export const CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE = `{"success":true,"returnCode":"000","content":{"datas":[{"queryStatus":"Success","accountNumber":"SYNTHETIC-ACCOUNT-001","count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":[{"sequenceNumber":1,"txnDateTime":"2026-07-01T09:00:00","accountDate":"2026-07-01","description":"Synthetic deposit","expendAmt":null,"incomeAmt":12500,"balance":12500},{"sequenceNumber":2,"txnDateTime":"2026-07-02T10:15:30","accountDate":"2026-07-02","description":"Synthetic transfer","expendAmt":300,"incomeAmt":null,"balance":12200},{"sequenceNumber":3,"txnDateTime":"2026-07-03T11:45:00","accountDate":"2026-07-03","description":"Synthetic credit","expendAmt":null,"incomeAmt":800,"balance":13000}]}]}}`;

export type CathayDomesticDepositCaptureInput = {
  rawResponse: string;
  sourceConnectionId: string;
  identityEpoch: string;
  accountNo: string;
  currency: string;
  authorityRoute: string;
  stream: string;
  scope: {
    startDate: string;
    endDate: string;
    complete: boolean;
  };
  observedAt: string;
};

export const CATHAY_DOMESTIC_DEPOSIT_FIXTURE: CathayDomesticDepositCaptureInput = {
  rawResponse: CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
  sourceConnectionId: "synthetic-cathay-connection",
  identityEpoch: "cathay-domestic-deposit-v1",
  accountNo: "SYNTHETIC-ACCOUNT-001",
  currency: "TWD",
  authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
  scope: { startDate: "2025-08-17", endDate: "2026-08-17", complete: true },
  observedAt: "2026-08-17T12:00:00+08:00",
};

export type ExactDecimal = {
  coefficient: bigint;
  scale: number;
};

export function parseExactDecimalLexeme(lexeme: string): ExactDecimal {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(lexeme)) {
    throw new Error(`Invalid exact decimal lexeme: ${lexeme}`);
  }
  const negative = lexeme.startsWith("-");
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole, fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${negative ? "-" : ""}${whole}${fraction}`);
  return { coefficient, scale: fraction.length };
}

type LosslessJsonNumber = { kind: "number"; lexeme: string };
type LosslessJsonValue =
  | null
  | boolean
  | string
  | LosslessJsonNumber
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue };

class LosslessJsonParser {
  private position = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): LosslessJsonValue {
    const value = this.value();
    this.whitespace();
    if (this.position !== this.source.length) throw new Error("Invalid JSON trailing data.");
    return value;
  }

  private value(): LosslessJsonValue {
    this.whitespace();
    const char = this.source[this.position];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (this.source.startsWith("true", this.position)) {
      this.position += 4;
      return true;
    }
    if (this.source.startsWith("false", this.position)) {
      this.position += 5;
      return false;
    }
    if (this.source.startsWith("null", this.position)) {
      this.position += 4;
      return null;
    }
    return { kind: "number", lexeme: this.number() };
  }

  private object(): { [key: string]: LosslessJsonValue } {
    this.position += 1;
    const output: { [key: string]: LosslessJsonValue } = {};
    this.whitespace();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return output;
    }
    while (true) {
      this.whitespace();
      if (this.source[this.position] !== '"') throw new Error("Invalid JSON object key.");
      const key = this.string();
      this.whitespace();
      if (this.source[this.position] !== ":") throw new Error("Invalid JSON object separator.");
      this.position += 1;
      if (key in output) throw new Error(`Duplicate JSON object key: ${key}`);
      output[key] = this.value();
      this.whitespace();
      if (this.source[this.position] === "}") {
        this.position += 1;
        return output;
      }
      if (this.source[this.position] !== ",") throw new Error("Invalid JSON object delimiter.");
      this.position += 1;
    }
  }

  private array(): LosslessJsonValue[] {
    this.position += 1;
    const output: LosslessJsonValue[] = [];
    this.whitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return output;
    }
    while (true) {
      output.push(this.value());
      this.whitespace();
      if (this.source[this.position] === "]") {
        this.position += 1;
        return output;
      }
      if (this.source[this.position] !== ",") throw new Error("Invalid JSON array delimiter.");
      this.position += 1;
    }
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.source.length) {
      const char = this.source[this.position];
      if (char === "\\") {
        this.position += 2;
        continue;
      }
      if (char === '"') {
        this.position += 1;
        return JSON.parse(this.source.slice(start, this.position)) as string;
      }
      this.position += 1;
    }
    throw new Error("Unterminated JSON string.");
  }

  private number(): string {
    const match = this.source.slice(this.position).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error(`Invalid JSON value at position ${this.position}.`);
    this.position += match[0].length;
    return match[0];
  }

  private whitespace() {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }
}

function asObject(value: LosslessJsonValue, label: string): { [key: string]: LosslessJsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value) || "kind" in value) {
    throw new Error(`${label} must be an object.`);
  }
  return value as { [key: string]: LosslessJsonValue };
}

function asArray(value: LosslessJsonValue | undefined, label: string): LosslessJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(object: { [key: string]: LosslessJsonValue }, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing required string ${key}.`);
  return value;
}

function isLosslessJsonNumber(value: LosslessJsonValue | undefined): value is LosslessJsonNumber {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.kind === "number");
}

function requiredNumber(object: { [key: string]: LosslessJsonValue }, key: string): string {
  const value = object[key];
  if (!isLosslessJsonNumber(value)) {
    throw new Error(`Missing required JSON number ${key}.`);
  }
  return value.lexeme;
}

function nullableNumber(object: { [key: string]: LosslessJsonValue }, key: string): string | null {
  const value = object[key];
  if (value === null) return null;
  if (!isLosslessJsonNumber(value)) {
    throw new Error(`${key} must be a JSON number or null.`);
  }
  return value.lexeme;
}

function requireDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid calendar date.`);
  }
  return value;
}

function requireDateTime(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DDTHH:mm:ss.`);
  }
  const date = new Date(`${value}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value) {
    throw new Error(`${label} must be a valid local date-time.`);
  }
  return value;
}

type ValidatedCathayRow = {
  sequence: string;
  accountDate: string;
  transactionDateTime: string;
  amount: ExactDecimal;
  direction: "inflow" | "outflow";
  balance: ExactDecimal;
  payload: string;
};

type ValidatedCathayCapture = {
  accountNo: string;
  startDate: string;
  endDate: string;
  rows: ValidatedCathayRow[];
};

function validateCapture(input: CathayDomesticDepositCaptureInput): ValidatedCathayCapture {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim()) {
    throw new Error("Source Connection and Identity Epoch are required.");
  }
  if (input.currency !== "TWD") throw new Error("Cathay domestic deposit currency must be TWD.");
  if (input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY) throw new Error("Invalid authority route.");
  if (input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM) throw new Error("Invalid Cathay product stream.");
  if (!input.scope.complete) throw new Error("Cathay transfer scope must be complete.");
  const startDate = requireDate(input.scope.startDate, "scope.startDate");
  const endDate = requireDate(input.scope.endDate, "scope.endDate");
  if (startDate > endDate) throw new Error("Cathay scope startDate must not be after endDate.");
  if (Number.isNaN(Date.parse(input.observedAt))) throw new Error("Invalid observation time.");

  const root = asObject(new LosslessJsonParser(input.rawResponse).parse(), "Cathay response");
  if (root.success !== true) throw new Error("Cathay response was not successful.");
  if (root.returnCode !== "000") throw new Error("Cathay response returnCode was not 000.");
  const content = asObject(root.content, "Cathay response content");
  const statement = asObject(asArray(content.datas, "Cathay response datas")[0], "Cathay transfer result");
  if (requiredString(statement, "queryStatus") !== "Success") throw new Error("Cathay queryStatus was not Success.");
  const accountNo = requiredString(statement, "accountNumber");
  if (accountNo !== input.accountNo) throw new Error("Cathay account scope does not match the response.");
  if (requiredString(statement, "startDate") !== startDate || requiredString(statement, "endDate") !== endDate) {
    throw new Error("Cathay response date scope does not match the requested scope.");
  }
  const count = parseExactDecimalLexeme(requiredNumber(statement, "count"));
  if (count.scale !== 0 || count.coefficient < 0n) throw new Error("Cathay count must be a non-negative integer.");
  const details = asArray(statement.details, "Cathay transfer details");
  if (count.coefficient !== BigInt(details.length)) throw new Error("Cathay response count does not match details.");

  const sequences = new Set<string>();
  const rows = details.map((detailValue, index) => {
    const detail = asObject(detailValue, `Cathay detail ${index}`);
    const sequenceLexeme = requiredNumber(detail, "sequenceNumber");
    const sequence = parseExactDecimalLexeme(sequenceLexeme);
    if (sequence.scale !== 0 || sequence.coefficient < 0n || sequences.has(sequenceLexeme)) {
      throw new Error("Cathay sequenceNumber must be a unique exact integer.");
    }
    sequences.add(sequenceLexeme);
    const expendLexeme = nullableNumber(detail, "expendAmt");
    const incomeLexeme = nullableNumber(detail, "incomeAmt");
    if ((expendLexeme === null) === (incomeLexeme === null)) {
      throw new Error("Cathay detail must have exactly one direction amount.");
    }
    const amountLexeme = incomeLexeme ?? expendLexeme!;
    const amount = parseExactDecimalLexeme(amountLexeme);
    if (amount.coefficient < 0n) throw new Error("Cathay amount must be non-negative.");
    const balance = parseExactDecimalLexeme(requiredNumber(detail, "balance"));
    const accountDate = requireDate(requiredString(detail, "accountDate"), "accountDate");
    const transactionDateTime = requireDateTime(requiredString(detail, "txnDateTime"), "txnDateTime");
    const direction = incomeLexeme === null ? "outflow" : "inflow";
    return {
      sequence: sequenceLexeme,
      accountDate,
      transactionDateTime,
      amount,
      direction,
      balance,
      payload: JSON.stringify({
        sequenceNumber: sequenceLexeme,
        accountDate,
        txnDateTime: transactionDateTime,
        amount: amountLexeme,
        amountDirection: direction,
        balance: requiredNumber(detail, "balance"),
      }),
    } satisfies ValidatedCathayRow;
  });
  return { accountNo, startDate, endDate, rows };
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function canonicalSqlitePath(ledgerDir: string): string {
  return join(ledgerDir, CANONICAL_SQLITE_FILE);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS canonical_commits (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  authority_route TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_authority_routes (
  authority_route TEXT PRIMARY KEY,
  integration_namespace TEXT NOT NULL,
  stream TEXT NOT NULL,
  contract_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_connections (
  source_connection_id TEXT PRIMARY KEY,
  integration_namespace TEXT NOT NULL,
  source_connection_key TEXT NOT NULL,
  created_commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence),
  UNIQUE(integration_namespace, source_connection_key)
);
CREATE TABLE IF NOT EXISTS identity_epochs (
  identity_epoch_id TEXT PRIMARY KEY,
  source_connection_id TEXT NOT NULL REFERENCES source_connections(source_connection_id),
  epoch_key TEXT NOT NULL,
  created_commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence),
  UNIQUE(source_connection_id, epoch_key)
);
CREATE TABLE IF NOT EXISTS source_captures (
  capture_id TEXT PRIMARY KEY,
  source_connection_id TEXT NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id TEXT NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  stream TEXT NOT NULL,
  account_no TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  scope_start TEXT NOT NULL,
  scope_end TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness = 'complete-range'),
  commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence)
);
CREATE TABLE IF NOT EXISTS source_records (
  source_record_id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES source_captures(capture_id),
  sequence_lexeme TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(capture_id, sequence_lexeme)
);
CREATE TABLE IF NOT EXISTS financial_accounts (
  account_id TEXT PRIMARY KEY,
  source_connection_id TEXT NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id TEXT NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  stream TEXT NOT NULL,
  account_no TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('depository', 'credit', 'loan', 'investment', 'other')),
  currency TEXT NOT NULL,
  created_commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence),
  UNIQUE(source_connection_id, identity_epoch_id, stream, account_no)
);
CREATE TABLE IF NOT EXISTS financial_transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES financial_accounts(account_id),
  source_sequence TEXT NOT NULL,
  UNIQUE(account_id, source_sequence)
);
CREATE TABLE IF NOT EXISTS transaction_revisions (
  revision_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES financial_transactions(transaction_id),
  source_record_id TEXT NOT NULL REFERENCES source_records(source_record_id),
  capture_id TEXT NOT NULL REFERENCES source_captures(capture_id),
  commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence),
  revision_number INTEGER NOT NULL,
  amount_coefficient TEXT NOT NULL,
  amount_scale INTEGER NOT NULL CHECK (amount_scale >= 0),
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  posting_status TEXT NOT NULL CHECK (posting_status IN ('pending', 'posted')),
  effective_on TEXT NOT NULL,
  transaction_date_time_local TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  time_precision TEXT NOT NULL CHECK (time_precision = 'second'),
  balance_coefficient TEXT NOT NULL,
  balance_scale INTEGER NOT NULL CHECK (balance_scale >= 0),
  UNIQUE(transaction_id, revision_number)
);
CREATE TABLE IF NOT EXISTS source_assertions (
  assertion_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id TEXT NOT NULL REFERENCES transaction_revisions(revision_id),
  source_record_id TEXT NOT NULL REFERENCES source_records(source_record_id),
  commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence),
  UNIQUE(transaction_id, revision_id)
);
CREATE TABLE IF NOT EXISTS assertion_provenance (
  assertion_id TEXT NOT NULL REFERENCES source_assertions(assertion_id),
  source_record_id TEXT NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(assertion_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS source_sync_states (
  source_connection_id TEXT NOT NULL REFERENCES source_connections(source_connection_id),
  account_id TEXT NOT NULL REFERENCES financial_accounts(account_id),
  stream TEXT NOT NULL,
  scope_start TEXT NOT NULL,
  scope_end TEXT NOT NULL,
  last_capture_id TEXT NOT NULL REFERENCES source_captures(capture_id),
  commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence),
  PRIMARY KEY(source_connection_id, account_id, stream)
);
CREATE TABLE IF NOT EXISTS current_transactions (
  transaction_id TEXT PRIMARY KEY REFERENCES financial_transactions(transaction_id),
  revision_id TEXT NOT NULL REFERENCES transaction_revisions(revision_id),
  commit_sequence INTEGER NOT NULL REFERENCES canonical_commits(commit_sequence)
);
`;

export function openCanonicalDatabase(
  ledgerDir: string,
  options: { readOnly?: boolean } = {},
): DatabaseSync {
  const path = canonicalSqlitePath(ledgerDir);
  if (options.readOnly && !existsSync(path)) throw new Error(`Missing canonical SQLite: ${path}`);
  if (!options.readOnly) mkdirSync(ledgerDir, { recursive: true });
  const db = new DatabaseSync(path, options.readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 30000");
  if (!options.readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
  }
  return db;
}

export type CanonicalAmount = { coefficient: string; scale: number };
export type CanonicalTransaction = {
  id: string;
  accountId: string;
  accountNo: string;
  sourceSequence: string;
  amount: CanonicalAmount;
  currency: "TWD";
  direction: "inflow" | "outflow";
  postingStatus: "posted";
  effectiveOn: string;
  transactionDateTimeLocal: string;
  timeZone: typeof CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE;
  balance: CanonicalAmount;
  revisionId: string;
  commitSequence: number;
};

export type CathayCanonicalCurrentQueryRequest = { kind: "current" };
export type CathayCanonicalCurrentQueryResult = {
  status: "ok";
  kind: "current";
  accounts: Array<{ id: string; accountNo: string; currency: "TWD"; accountType: "depository" }>;
  transactions: CanonicalTransaction[];
  commitSequence: number;
};
export type CathayCanonicalHistoricalQueryRequest = {
  kind: "historical";
  cutoff: { kind: "both"; financialAt: string; knowledgeAt: string };
};
export type CathayCanonicalHistoricalQueryResult = {
  status: "ok";
  kind: "historical";
  cutoff: CathayCanonicalHistoricalQueryRequest["cutoff"];
  transactions: CanonicalTransaction[];
};
export type CathayCanonicalLineageQueryRequest = {
  kind: "lineage";
  subject: { kind: "transaction"; id: string };
};
export type CathayCanonicalLineageEntry = {
  transaction: { id: string; accountId: string; sourceSequence: string };
  revision: CanonicalTransactionRevision;
  assertion: { id: string; revisionId: string; commitSequence: number };
  sourceRecord: { id: string; captureId: string; sequence: string; payload: string };
  capture: { id: string; observedAt: string; scopeStart: string; scopeEnd: string; authorityRoute: string };
  provenance: Array<{ sourceRecordId: string; captureId: string }>;
};
export type CathayCanonicalLineageQueryResult = {
  status: "ok";
  kind: "lineage";
  subject: CathayCanonicalLineageQueryRequest["subject"];
  entries: CathayCanonicalLineageEntry[];
};
export type CanonicalTransactionRevision = CanonicalTransaction & { transactionId: string };

export interface CathayCanonicalFinancialQuery {
  current(request: CathayCanonicalCurrentQueryRequest): Promise<CathayCanonicalCurrentQueryResult>;
  historical(request: CathayCanonicalHistoricalQueryRequest): Promise<CathayCanonicalHistoricalQueryResult>;
  lineage(request: CathayCanonicalLineageQueryRequest): Promise<CathayCanonicalLineageQueryResult>;
}

export type CathayCommitTransactionResult = {
  transactionId: string;
  revisionId: string;
  sourceSequence: string;
  direction: "inflow" | "outflow";
  amount: CanonicalAmount;
  revisionCreated: boolean;
};
export type CathayCanonicalCommitResult = {
  captureId: string;
  commitSequence: number;
  accountId: string;
  transactions: CathayCommitTransactionResult[];
};

function dbRow<T extends Record<string, unknown>>(value: unknown): T {
  return value as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sameRevision(
  row: Record<string, unknown>,
  detail: ValidatedCathayRow,
): boolean {
  return row.amount_coefficient === detail.amount.coefficient.toString()
    && row.amount_scale === detail.amount.scale
    && row.direction === detail.direction
    && row.effective_on === detail.accountDate
    && row.transaction_date_time_local === detail.transactionDateTime
    && row.balance_coefficient === detail.balance.coefficient.toString()
    && row.balance_scale === detail.balance.scale;
}

export function commitCathayDomesticDeposit(
  ledgerDir: string,
  input: CathayDomesticDepositCaptureInput,
): CathayCanonicalCommitResult {
  const validated = validateCapture(input);
  const db = openCanonicalDatabase(ledgerDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    db.prepare(
      "INSERT OR IGNORE INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version) VALUES (?, ?, ?, ?)",
    ).run(CATHAY_DOMESTIC_DEPOSIT_AUTHORITY, CATHAY_INTEGRATION_NAMESPACE, CATHAY_DOMESTIC_DEPOSIT_STREAM, "v1");
    const commitInsert = db.prepare(
      "INSERT INTO canonical_commits(commit_id, recorded_at, authority_route) VALUES (?, ?, ?)",
    ).run(uuidV7(), nowIso(), CATHAY_DOMESTIC_DEPOSIT_AUTHORITY);
    const commitSequence = Number(commitInsert.lastInsertRowid);
    const connectionExisting = db.prepare(
      "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
    ).get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    const sourceConnectionId = connectionExisting
      ? String(dbRow<{ source_connection_id: string }>(connectionExisting).source_connection_id)
      : uuidV7();
    if (!connectionExisting) {
      db.prepare(
        "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_sequence) VALUES (?, ?, ?, ?)",
      ).run(sourceConnectionId, CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId, commitSequence);
    }
    const epochExisting = db.prepare(
      "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
    ).get(sourceConnectionId, input.identityEpoch);
    const identityEpochId = epochExisting
      ? String(dbRow<{ identity_epoch_id: string }>(epochExisting).identity_epoch_id)
      : uuidV7();
    if (!epochExisting) {
      db.prepare(
        "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_sequence) VALUES (?, ?, ?, ?)",
      ).run(identityEpochId, sourceConnectionId, input.identityEpoch, commitSequence);
    }
    const accountExisting = db.prepare(
      "SELECT account_id, currency, account_type FROM financial_accounts WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND account_no = ?",
    ).get(sourceConnectionId, identityEpochId, CATHAY_DOMESTIC_DEPOSIT_STREAM, validated.accountNo);
    const accountId = accountExisting
      ? String(dbRow<{ account_id: string }>(accountExisting).account_id)
      : uuidV7();
    if (accountExisting) {
      const account = dbRow<{ currency: string; account_type: string }>(accountExisting);
      if (account.currency !== input.currency || account.account_type !== "depository") {
        throw new Error("Cathay account identity has conflicting required classification.");
      }
    } else {
      db.prepare(
        "INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, account_no, account_type, currency, created_commit_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(accountId, sourceConnectionId, identityEpochId, CATHAY_DOMESTIC_DEPOSIT_STREAM, validated.accountNo, "depository", input.currency, commitSequence);
    }
    const captureId = uuidV7();
    db.prepare(
      "INSERT INTO source_captures(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, commit_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(captureId, sourceConnectionId, identityEpochId, input.authorityRoute, input.stream, validated.accountNo, input.observedAt, validated.startDate, validated.endDate, "complete-range", commitSequence);

    const transactionResults: CathayCommitTransactionResult[] = [];
    for (const detail of validated.rows) {
      const sourceRecordId = uuidV7();
      db.prepare(
        "INSERT INTO source_records(source_record_id, capture_id, sequence_lexeme, payload_json) VALUES (?, ?, ?, ?)",
      ).run(sourceRecordId, captureId, detail.sequence, detail.payload);
      const transactionExisting = db.prepare(
        "SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
      ).get(accountId, detail.sequence);
      const transactionId = transactionExisting
        ? String(dbRow<{ transaction_id: string }>(transactionExisting).transaction_id)
        : uuidV7();
      if (!transactionExisting) {
        db.prepare(
          "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence) VALUES (?, ?, ?)",
        ).run(transactionId, accountId, detail.sequence);
      }
      const latest = db.prepare(
        "SELECT * FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1",
      ).get(transactionId);
      const latestRow = latest ? dbRow<Record<string, unknown>>(latest) : undefined;
      const revisionCreated = !latestRow || !sameRevision(latestRow, detail);
      let revisionId = latestRow ? String(latestRow.revision_id) : uuidV7();
      if (revisionCreated) {
        revisionId = uuidV7();
        const revisionNumber = latestRow ? Number(latestRow.revision_number) + 1 : 1;
        db.prepare(
          `INSERT INTO transaction_revisions(
            revision_id, transaction_id, source_record_id, capture_id, commit_sequence, revision_number,
            amount_coefficient, amount_scale, currency, direction, posting_status, effective_on,
            transaction_date_time_local, time_zone, time_precision, balance_coefficient, balance_scale
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(revisionId, transactionId, sourceRecordId, captureId, commitSequence, revisionNumber,
          detail.amount.coefficient.toString(), detail.amount.scale, input.currency, detail.direction, "posted",
          detail.accountDate, detail.transactionDateTime, CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "second",
          detail.balance.coefficient.toString(), detail.balance.scale);
        db.prepare(
          "INSERT INTO source_assertions(assertion_id, transaction_id, revision_id, source_record_id, commit_sequence) VALUES (?, ?, ?, ?, ?)",
        ).run(uuidV7(), transactionId, revisionId, sourceRecordId, commitSequence);
        db.prepare(
          "INSERT INTO current_transactions(transaction_id, revision_id, commit_sequence) VALUES (?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET revision_id = excluded.revision_id, commit_sequence = excluded.commit_sequence",
        ).run(transactionId, revisionId, commitSequence);
      }
      const assertion = db.prepare(
        "SELECT assertion_id FROM source_assertions WHERE transaction_id = ? AND revision_id = ?",
      ).get(transactionId, revisionId);
      if (!assertion) throw new Error("Canonical assertion was not created.");
      db.prepare("INSERT INTO assertion_provenance(assertion_id, source_record_id) VALUES (?, ?)")
        .run(String(dbRow<{ assertion_id: string }>(assertion).assertion_id), sourceRecordId);
      transactionResults.push({
        transactionId,
        revisionId,
        sourceSequence: detail.sequence,
        direction: detail.direction,
        amount: { coefficient: detail.amount.coefficient.toString(), scale: detail.amount.scale },
        revisionCreated,
      });
    }
    db.prepare(
      `INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, last_capture_id, commit_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET
         scope_start = excluded.scope_start, scope_end = excluded.scope_end,
         last_capture_id = excluded.last_capture_id, commit_sequence = excluded.commit_sequence`,
    ).run(sourceConnectionId, accountId, CATHAY_DOMESTIC_DEPOSIT_STREAM, validated.startDate, validated.endDate, captureId, commitSequence);
    db.exec("COMMIT");
    inTransaction = false;
    return { captureId, commitSequence, accountId, transactions: transactionResults };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function amountFromRow(row: Record<string, unknown>, prefix = ""): CanonicalAmount {
  return { coefficient: String(row[`${prefix}amount_coefficient`]), scale: Number(row[`${prefix}amount_scale`]) };
}

function transactionFromRow(row: Record<string, unknown>): CanonicalTransaction {
  return {
    id: String(row.transaction_id),
    accountId: String(row.account_id),
    accountNo: String(row.account_no),
    sourceSequence: String(row.source_sequence),
    amount: amountFromRow(row),
    currency: "TWD",
    direction: row.direction as "inflow" | "outflow",
    postingStatus: "posted",
    effectiveOn: String(row.effective_on),
    transactionDateTimeLocal: String(row.transaction_date_time_local),
    timeZone: CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
    balance: { coefficient: String(row.balance_coefficient), scale: Number(row.balance_scale) },
    revisionId: String(row.revision_id),
    commitSequence: Number(row.commit_sequence),
  };
}

function transactionRevisionFromRow(row: Record<string, unknown>): CanonicalTransactionRevision {
  const transaction = transactionFromRow(row);
  return {
    ...transaction,
    id: String(row.revision_id),
    transactionId: transaction.id,
  };
}

class CathayCanonicalFinancialQueryAdapter implements CathayCanonicalFinancialQuery {
  private readonly ledgerDir: string;

  constructor(ledgerDir: string) {
    this.ledgerDir = ledgerDir;
  }

  async current(_request: CathayCanonicalCurrentQueryRequest): Promise<CathayCanonicalCurrentQueryResult> {
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const accounts = (db.prepare(
        "SELECT account_id AS id, account_no AS accountNo, currency, account_type AS accountType FROM financial_accounts ORDER BY account_no",
      ).all() as Record<string, unknown>[]).map((row) => ({
        id: String(row.id), accountNo: String(row.accountNo), currency: "TWD" as const, accountType: "depository" as const,
      }));
      const rows = db.prepare(
        `SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence,
          r.amount_coefficient, r.amount_scale, r.currency, r.direction, r.posting_status,
          r.effective_on, r.transaction_date_time_local, r.balance_coefficient, r.balance_scale,
          r.revision_id, r.commit_sequence
         FROM current_transactions c
         JOIN financial_transactions t ON t.transaction_id = c.transaction_id
         JOIN financial_accounts a ON a.account_id = t.account_id
         JOIN transaction_revisions r ON r.revision_id = c.revision_id
         ORDER BY a.account_no, t.source_sequence`,
      ).all() as Record<string, unknown>[];
      return {
        status: "ok", kind: "current", accounts, transactions: rows.map(transactionFromRow),
        commitSequence: rows.reduce((max, row) => Math.max(max, Number(row.commit_sequence)), 0),
      };
    } finally {
      db.close();
    }
  }

  async historical(request: CathayCanonicalHistoricalQueryRequest): Promise<CathayCanonicalHistoricalQueryResult> {
    if (request.cutoff.kind !== "both" || !/^\d+$/.test(request.cutoff.knowledgeAt)) {
      throw new Error("Canonical historical queries require financial-time and knowledge-time cutoffs.");
    }
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence,
          r.amount_coefficient, r.amount_scale, r.currency, r.direction, r.posting_status,
          r.effective_on, r.transaction_date_time_local, r.balance_coefficient, r.balance_scale,
          r.revision_id, r.commit_sequence
         FROM financial_transactions t
         JOIN financial_accounts a ON a.account_id = t.account_id
         JOIN transaction_revisions r ON r.transaction_id = t.transaction_id
         JOIN canonical_commits c ON c.commit_sequence = r.commit_sequence
         WHERE r.effective_on <= ? AND c.commit_sequence <= ?
           AND NOT EXISTS (
             SELECT 1 FROM transaction_revisions newer
             JOIN canonical_commits newer_commit ON newer_commit.commit_sequence = newer.commit_sequence
             WHERE newer.transaction_id = r.transaction_id
               AND newer.effective_on <= ?
               AND newer_commit.commit_sequence <= ?
               AND newer_commit.commit_sequence > c.commit_sequence
           )
         ORDER BY a.account_no, t.source_sequence`,
      ).all(request.cutoff.financialAt, Number(request.cutoff.knowledgeAt), request.cutoff.financialAt, Number(request.cutoff.knowledgeAt)) as Record<string, unknown>[];
      return { status: "ok", kind: "historical", cutoff: request.cutoff, transactions: rows.map(transactionFromRow) };
    } finally {
      db.close();
    }
  }

  async lineage(request: CathayCanonicalLineageQueryRequest): Promise<CathayCanonicalLineageQueryResult> {
    if (request.subject.kind !== "transaction" || !request.subject.id) {
      throw new Error("Cathay lineage queries require a transaction subject.");
    }
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const revisionRows = db.prepare(
        `SELECT t.transaction_id, t.account_id, t.source_sequence, a.account_no,
          r.amount_coefficient, r.amount_scale, r.currency, r.direction, r.posting_status,
          r.effective_on, r.transaction_date_time_local, r.balance_coefficient, r.balance_scale,
          r.revision_id, r.commit_sequence, r.source_record_id, r.capture_id,
          sr.sequence_lexeme, sr.payload_json, sc.observed_at, sc.scope_start, sc.scope_end, sc.authority_route,
          sa.assertion_id
         FROM financial_transactions t
         JOIN financial_accounts a ON a.account_id = t.account_id
         JOIN transaction_revisions r ON r.transaction_id = t.transaction_id
         JOIN source_records sr ON sr.source_record_id = r.source_record_id
         JOIN source_captures sc ON sc.capture_id = r.capture_id
         JOIN source_assertions sa ON sa.revision_id = r.revision_id
         WHERE t.transaction_id = ?
         ORDER BY r.revision_number`,
      ).all(request.subject.id) as Record<string, unknown>[];
      const entries = revisionRows.map((row) => {
        const provenance = db.prepare(
          `SELECT p.source_record_id AS sourceRecordId, sr.capture_id AS captureId
           FROM assertion_provenance p JOIN source_records sr ON sr.source_record_id = p.source_record_id
           WHERE p.assertion_id = ? ORDER BY p.source_record_id`,
        ).all(String(row.assertion_id)) as Record<string, unknown>[];
        const revision = transactionRevisionFromRow(row);
        return {
          transaction: { id: String(row.transaction_id), accountId: String(row.account_id), sourceSequence: String(row.source_sequence) },
          revision,
          assertion: { id: String(row.assertion_id), revisionId: String(row.revision_id), commitSequence: Number(row.commit_sequence) },
          sourceRecord: { id: String(row.source_record_id), captureId: String(row.capture_id), sequence: String(row.sequence_lexeme), payload: String(row.payload_json) },
          capture: { id: String(row.capture_id), observedAt: String(row.observed_at), scopeStart: String(row.scope_start), scopeEnd: String(row.scope_end), authorityRoute: String(row.authority_route) },
          provenance: provenance.map((item) => ({ sourceRecordId: String(item.sourceRecordId), captureId: String(item.captureId) })),
        } satisfies CathayCanonicalLineageEntry;
      });
      return { status: "ok", kind: "lineage", subject: request.subject, entries };
    } finally {
      db.close();
    }
  }
}

export function createCathayCanonicalFinancialQuery(ledgerDir: string): CathayCanonicalFinancialQuery {
  return new CathayCanonicalFinancialQueryAdapter(ledgerDir);
}
