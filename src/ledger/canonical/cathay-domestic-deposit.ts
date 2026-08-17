import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CATHAY_INTEGRATION_NAMESPACE = "cathay";
export const CATHAY_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
export const CATHAY_DOMESTIC_DEPOSIT_AUTHORITY = "cathay/domestic-deposit/v1";
export const CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";
export const CANONICAL_SQLITE_FILE = "canonical.sqlite";
export const CANONICAL_SCHEMA_VERSION = 3;
export const CATHAY_POSTING_MAPPING = {
  contractVersion: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  postingStatus: "posted",
  origin: "provider_booked_history",
  basis: "query-status-success-with-accounting-date",
  ruleVersion: "cathay/domestic-deposit/v1",
} as const;
export const CATHAY_COMPLETENESS_PROOF = {
  kind: "complete-range",
  basis: "success-status-scope-count-details",
  ruleVersion: "cathay/domestic-deposit/v1",
} as const;

export const CATHAY_DOMESTIC_DEPOSIT_PROVENANCE = {
  validatedAt: "2026-08-17",
  source: "Cathay domestic deposit",
  values: "synthetic",
  liveResponseRetained: false,
  note: "Human-assisted validation covered response shape only; no live values are retained.",
} as const;

export const CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE = `{"success":true,"returnCode":"0000","content":{"datas":[{"queryStatus":"Success","accountNumber":"SYNTHETIC-ACCOUNT-001","count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":[{"sequenceNumber":1,"txnDateTime":"2026-07-01T09:00:00","accountDate":"2026-07-01","description":"Synthetic Cathay deposit description","expendAmt":null,"incomeAmt":12500,"balance":12500},{"sequenceNumber":2,"txnDateTime":"2026-07-02T10:15:30","accountDate":"2026-07-02","description":"Synthetic Cathay transfer description","expendAmt":300,"incomeAmt":null,"balance":12200},{"sequenceNumber":3,"txnDateTime":"2026-07-03T11:45:00","accountDate":"2026-07-03","description":"Synthetic Cathay credit description","expendAmt":null,"incomeAmt":800,"balance":13000}]}]}}`;

export type CathayDomesticDepositCaptureInput = {
  rawResponse: string;
  sourceConnectionId: string;
  identityEpoch: string;
  accountNo: string;
  currency: string;
  authorityRoute: string;
  stream: string;
  scope: { startDate: string; endDate: string; complete?: boolean };
  syncState: { cursor?: string | null };
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
  scope: { startDate: "2025-08-17", endDate: "2026-08-17" },
  syncState: { cursor: null },
  observedAt: "2026-08-17T12:00:00+08:00",
};

export type ExactDecimal = { coefficient: bigint; scale: number };

export function parseExactDecimalLexeme(lexeme: string): ExactDecimal {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(lexeme)) {
    throw new Error(`Invalid exact decimal lexeme: ${lexeme}`);
  }
  const negative = lexeme.startsWith("-");
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole, fraction = ""] = unsigned.split(".");
  return {
    coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`),
    scale: fraction.length,
  };
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

  constructor(source: string) { this.source = source; }

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
    if (this.source.startsWith("true", this.position)) { this.position += 4; return true; }
    if (this.source.startsWith("false", this.position)) { this.position += 5; return false; }
    if (this.source.startsWith("null", this.position)) { this.position += 4; return null; }
    return { kind: "number", lexeme: this.number() };
  }

  private object(): { [key: string]: LosslessJsonValue } {
    this.position += 1;
    const output: { [key: string]: LosslessJsonValue } = {};
    this.whitespace();
    if (this.source[this.position] === "}") { this.position += 1; return output; }
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
      if (this.source[this.position] === "}") { this.position += 1; return output; }
      if (this.source[this.position] !== ",") throw new Error("Invalid JSON object delimiter.");
      this.position += 1;
    }
  }

  private array(): LosslessJsonValue[] {
    this.position += 1;
    const output: LosslessJsonValue[] = [];
    this.whitespace();
    if (this.source[this.position] === "]") { this.position += 1; return output; }
    while (true) {
      output.push(this.value());
      this.whitespace();
      if (this.source[this.position] === "]") { this.position += 1; return output; }
      if (this.source[this.position] !== ",") throw new Error("Invalid JSON array delimiter.");
      this.position += 1;
    }
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.source.length) {
      const char = this.source[this.position];
      if (char === "\\") { this.position += 2; continue; }
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
  if (!value || typeof value !== "object" || Array.isArray(value) || "kind" in value) throw new Error(`${label} must be an object.`);
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
  if (!isLosslessJsonNumber(value)) throw new Error(`Missing required JSON number ${key}.`);
  return value.lexeme;
}
function nullableNumber(object: { [key: string]: LosslessJsonValue }, key: string): string | null {
  const value = object[key];
  if (value === null) return null;
  if (!isLosslessJsonNumber(value)) throw new Error(`${key} must be a JSON number or null.`);
  return value.lexeme;
}
function requireDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a valid calendar date.`);
  return value;
}
function requireDateTime(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DDTHH:mm:ss.`);
  const calendarShape = new Date(`${value}Z`);
  if (Number.isNaN(calendarShape.getTime()) || calendarShape.toISOString().slice(0, 19) !== value) throw new Error(`${label} must be a valid local date-time.`);
  return value;
}
function parseRfc3339UtcMicros(value: string, label: string): number {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new Error(`${label} must be RFC3339 with an explicit UTC designator or numeric offset.`);
  const civil = `${match[1]}T${match[2]}`;
  if ((match[3]?.length ?? 0) > 6) throw new Error(`${label} exceeds integer microsecond precision.`);
  const calendarShape = new Date(`${civil}Z`);
  if (Number.isNaN(calendarShape.getTime()) || calendarShape.toISOString().slice(0, 19) !== civil) throw new Error(`${label} must be a valid RFC3339 timestamp.`);
  if (match[4] !== "Z") {
    const [hours, minutes] = match[4].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59) throw new Error(`${label} has an invalid numeric offset.`);
  }
  const epochMilliseconds = Date.parse(`${civil}${match[4]}`);
  if (!Number.isSafeInteger(epochMilliseconds)) throw new Error(`${label} is outside the supported instant range.`);
  const fractionMicros = BigInt((match[3] ?? "").slice(0, 6).padEnd(6, "0"));
  const micros = BigInt(epochMilliseconds) * 1000n + fractionMicros;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) || micros < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`${label} microseconds exceed the safe SQLite binding range.`);
  return Number(micros);
}
function localDateTimeToUtcMicros(value: string): number {
  return parseRfc3339UtcMicros(`${value}+08:00`, "Cathay local date-time");
}
function localDateToUtcMicros(value: string): number {
  return localDateTimeToUtcMicros(`${value}T00:00:00`);
}

type ValidatedCathayRow = {
  sequence: string;
  accountDate: string;
  transactionDateTime: string;
  description: string | null;
  accountingUtcInstantUtcUs: number;
  utcInstantUtcUs: number;
  amount: ExactDecimal;
  direction: "inflow" | "outflow";
  balance: ExactDecimal;
  payload: string;
};
type ValidatedCathayCapture = {
  accountNo: string;
  startDate: string;
  endDate: string;
  posting: typeof CATHAY_POSTING_MAPPING;
  completeness: typeof CATHAY_COMPLETENESS_PROOF;
  rows: ValidatedCathayRow[];
};

function cathayPostingMapping(
  statement: { [key: string]: LosslessJsonValue },
  details: LosslessJsonValue[],
): typeof CATHAY_POSTING_MAPPING {
  if (requiredString(statement, "queryStatus") !== "Success") throw new Error("Cathay queryStatus was not Success; posting status is not mappable.");
  for (const detailValue of details) {
    const detail = asObject(detailValue, "Cathay transfer detail");
    if ("status" in detail || "pending" in detail || "postingStatus" in detail) {
      throw new Error("Cathay posting mapping requires the booked-history response without pending status fields.");
    }
  }
  return CATHAY_POSTING_MAPPING;
}

function validateCapture(input: CathayDomesticDepositCaptureInput): ValidatedCathayCapture {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim()) throw new Error("Source Connection and Identity Epoch are required.");
  if (input.currency !== "TWD") throw new Error("Cathay domestic deposit currency must be TWD.");
  if (input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY) throw new Error("Invalid authority route.");
  if (input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM) throw new Error("Invalid Cathay product stream.");
  const startDate = requireDate(input.scope.startDate, "scope.startDate");
  const endDate = requireDate(input.scope.endDate, "scope.endDate");
  if (startDate > endDate) throw new Error("Cathay scope startDate must not be after endDate.");
  parseRfc3339UtcMicros(input.observedAt, "Capture observedAt");

  const root = asObject(new LosslessJsonParser(input.rawResponse).parse(), "Cathay response");
  if (root.success !== true) throw new Error("Cathay response was not successful.");
  if (root.returnCode !== "0000") throw new Error("Cathay response returnCode was not 0000.");
  const content = asObject(root.content, "Cathay response content");
  const datas = asArray(content.datas, "Cathay response datas");
  if (datas.length !== 1) throw new Error("Cathay response must contain exactly one transfer result.");
  const statement = asObject(datas[0]!, "Cathay transfer result");
  const accountNo = requiredString(statement, "accountNumber");
  if (accountNo !== input.accountNo) throw new Error("Cathay account scope does not match the response.");
  if (requiredString(statement, "startDate") !== startDate || requiredString(statement, "endDate") !== endDate) throw new Error("Cathay response date scope does not match the requested scope.");
  const count = parseExactDecimalLexeme(requiredNumber(statement, "count"));
  if (count.scale !== 0 || count.coefficient < 0n) throw new Error("Cathay count must be a non-negative integer.");
  const details = asArray(statement.details, "Cathay transfer details");
  if (count.coefficient !== BigInt(details.length)) throw new Error("Cathay response count does not match details.");
  const posting = cathayPostingMapping(statement, details);

  const sequences = new Set<string>();
  const rows = details.map((detailValue, index) => {
    const detail = asObject(detailValue, `Cathay detail ${index}`);
    const sequenceLexeme = requiredNumber(detail, "sequenceNumber");
    const sequence = parseExactDecimalLexeme(sequenceLexeme);
    if (sequence.scale !== 0 || sequence.coefficient < 0n || sequences.has(sequenceLexeme)) throw new Error("Cathay sequenceNumber must be a unique exact integer.");
    sequences.add(sequenceLexeme);
    const expendLexeme = nullableNumber(detail, "expendAmt");
    const incomeLexeme = nullableNumber(detail, "incomeAmt");
    if ((expendLexeme === null) === (incomeLexeme === null)) throw new Error("Cathay detail must have exactly one direction amount.");
    const amountLexeme = incomeLexeme ?? expendLexeme!;
    const amount = parseExactDecimalLexeme(amountLexeme);
    if (amount.coefficient < 0n) throw new Error("Cathay amount must be non-negative.");
    const balanceLexeme = requiredNumber(detail, "balance");
    const balance = parseExactDecimalLexeme(balanceLexeme);
    const accountDate = requireDate(requiredString(detail, "accountDate"), "accountDate");
    const transactionDateTime = requireDateTime(requiredString(detail, "txnDateTime"), "txnDateTime");
    const descriptionValue = detail.description;
    if (descriptionValue !== undefined && descriptionValue !== null && typeof descriptionValue !== "string") {
      throw new Error("Cathay description must be a string or absent.");
    }
    if (typeof descriptionValue === "string" && descriptionValue.length > 512) throw new Error("Cathay description exceeds the supported compact length.");
    const description = typeof descriptionValue === "string" && descriptionValue.length > 0 ? descriptionValue : null;
    const direction = incomeLexeme === null ? "outflow" : "inflow";
    const payload: Record<string, string> = { sequenceNumber: sequenceLexeme, accountDate, txnDateTime: transactionDateTime, amount: amountLexeme, amountDirection: direction, balance: balanceLexeme };
    if (description !== null) payload.description = description;
    return {
      sequence: sequenceLexeme,
      accountDate,
      transactionDateTime,
      description,
      accountingUtcInstantUtcUs: localDateToUtcMicros(accountDate),
      utcInstantUtcUs: localDateTimeToUtcMicros(transactionDateTime),
      amount,
      direction,
      balance,
      payload: JSON.stringify(payload),
    } satisfies ValidatedCathayRow;
  });
  return { accountNo, startDate, endDate, posting, completeness: CATHAY_COMPLETENESS_PROOF, rows };
}

type CanonicalId = Buffer;
function uuidV7(): CanonicalId {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1) bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}
function idToString(value: unknown): string {
  const bytes = value instanceof Uint8Array ? Buffer.from(value) : undefined;
  if (!bytes || bytes.length !== 16) throw new Error("Canonical ID must be a 16-byte UUID blob.");
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function idFromString(value: string): CanonicalId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("Canonical ID must be a UUID string.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}
function blob(value: unknown): CanonicalId { return value instanceof Uint8Array && value.byteLength === 16 ? Buffer.from(value) : (() => { throw new Error("Expected a 16-byte canonical ID blob."); })(); }

export function canonicalSqlitePath(ledgerDir: string): string { return join(ledgerDir, CANONICAL_SQLITE_FILE); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc_us INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS canonical_commits (
  commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16),
  commit_sequence INTEGER NOT NULL UNIQUE,
  recorded_at_utc_us INTEGER NOT NULL,
  authority_route TEXT NOT NULL,
  commit_kind TEXT NOT NULL CHECK(commit_kind = 'source_capture')
);
CREATE TABLE IF NOT EXISTS source_authority_routes (
  authority_route TEXT PRIMARY KEY, integration_namespace TEXT NOT NULL, stream TEXT NOT NULL, contract_version TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS source_connections (
  source_connection_id BLOB PRIMARY KEY CHECK(length(source_connection_id) = 16),
  integration_namespace TEXT NOT NULL, source_connection_key TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(integration_namespace, source_connection_key)
);
CREATE TABLE IF NOT EXISTS identity_epochs (
  identity_epoch_id BLOB PRIMARY KEY CHECK(length(identity_epoch_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), epoch_key TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(source_connection_id, epoch_key)
);
CREATE TABLE IF NOT EXISTS source_captures (
  capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),
  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS source_records (
  source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), sequence_lexeme TEXT NOT NULL, description TEXT,
  payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)
);
CREATE TABLE IF NOT EXISTS financial_accounts (
  account_id BLOB PRIMARY KEY CHECK(length(account_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), stream TEXT NOT NULL, account_no TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')), currency TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(source_connection_id, identity_epoch_id, stream, account_no)
);
CREATE TABLE IF NOT EXISTS financial_transactions (
  transaction_id BLOB PRIMARY KEY CHECK(length(transaction_id) = 16), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  source_sequence TEXT NOT NULL, created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(account_id, source_sequence)
);
CREATE TABLE IF NOT EXISTS transaction_revisions (
  revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), revision_number INTEGER NOT NULL,
  amount_coefficient TEXT NOT NULL, amount_scale INTEGER NOT NULL CHECK(amount_scale >= 0), currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')), posting_status TEXT NOT NULL CHECK(posting_status IN ('pending','posted')),
  posting_origin TEXT NOT NULL CHECK(posting_origin = 'provider_booked_history'), posting_basis TEXT NOT NULL CHECK(posting_basis = 'query-status-success-with-accounting-date'),
  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,
  effective_on TEXT NOT NULL, transaction_date_time_local TEXT NOT NULL, time_zone TEXT NOT NULL,
  time_precision TEXT NOT NULL CHECK(time_precision = 'second'), time_origin TEXT NOT NULL CHECK(time_origin = 'source_reported'),
  effective_time_basis TEXT NOT NULL CHECK(effective_time_basis = 'accounting'), effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1'),
  utc_instant_utc_us INTEGER NOT NULL, UNIQUE(transaction_id, revision_number)
);
CREATE TABLE IF NOT EXISTS transaction_time_observations (
  observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), role TEXT NOT NULL CHECK(role IN ('accounting','occurred')),
  local_value TEXT NOT NULL, time_zone TEXT NOT NULL CHECK(time_zone = 'Asia/Taipei'), time_precision TEXT NOT NULL CHECK(time_precision IN ('date','second')),
  time_origin TEXT NOT NULL CHECK(time_origin = 'source_reported'), utc_instant_utc_us INTEGER NOT NULL,
  UNIQUE(revision_id, role)
);
CREATE TABLE IF NOT EXISTS source_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(transaction_id, revision_id)
);
CREATE TABLE IF NOT EXISTS assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES source_assertions(assertion_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), PRIMARY KEY(assertion_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS source_sync_states (
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT,
  last_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(source_connection_id, account_id, stream)
);
CREATE TABLE IF NOT EXISTS current_transactions (
  transaction_id BLOB PRIMARY KEY REFERENCES financial_transactions(transaction_id), revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS current_projection_state (
  generation INTEGER PRIMARY KEY CHECK(generation = 1), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_revisions_financial_time ON transaction_revisions(effective_on, utc_instant_utc_us, transaction_id, commit_id);
CREATE INDEX IF NOT EXISTS idx_transaction_revisions_knowledge_time ON transaction_revisions(commit_id, transaction_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id);
CREATE INDEX IF NOT EXISTS idx_current_transactions_revision ON current_transactions(revision_id, commit_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_revisions_lineage ON transaction_revisions(transaction_id, revision_number, revision_id);
CREATE INDEX IF NOT EXISTS idx_source_assertions_revision ON source_assertions(revision_id, transaction_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_assertion_provenance_record ON assertion_provenance(source_record_id, assertion_id, commit_id);
CREATE INDEX IF NOT EXISTS idx_source_records_capture ON source_records(capture_id, sequence_lexeme, source_record_id);
CREATE INDEX IF NOT EXISTS idx_time_observations_revision ON transaction_time_observations(revision_id, role, observation_id);
`;

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function migrateV1ToV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE canonical_commits ADD COLUMN commit_kind TEXT NOT NULL DEFAULT 'source_capture' CHECK(commit_kind = 'source_capture')");
    db.exec("ALTER TABLE source_records ADD COLUMN description TEXT");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN posting_origin TEXT NOT NULL DEFAULT 'provider_booked_history' CHECK(posting_origin = 'provider_booked_history')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN posting_basis TEXT NOT NULL DEFAULT 'query-status-success-with-accounting-date' CHECK(posting_basis = 'query-status-success-with-accounting-date')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN posting_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN description TEXT");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN effective_time_basis TEXT NOT NULL DEFAULT 'accounting' CHECK(effective_time_basis = 'accounting')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN effective_time_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')");
    db.exec(SCHEMA);
    const revisions = db.prepare("SELECT revision_id, transaction_id, source_record_id, commit_id, capture_id, effective_on, transaction_date_time_local, utc_instant_utc_us FROM transaction_revisions").all() as Array<Record<string, unknown>>;
    const insertObservation = db.prepare(`INSERT INTO transaction_time_observations(
      observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const revision of revisions) {
      insertObservation.run(uuidV7(), blob(revision.transaction_id), blob(revision.revision_id), blob(revision.source_record_id), blob(revision.commit_id), "accounting", String(revision.effective_on), CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "date", "source_reported", localDateToUtcMicros(String(revision.effective_on)));
      insertObservation.run(uuidV7(), blob(revision.transaction_id), blob(revision.revision_id), blob(revision.source_record_id), blob(revision.commit_id), "occurred", String(revision.transaction_date_time_local), CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "second", "source_reported", Number(revision.utc_instant_utc_us));
    }
    const latestCommit = db.prepare("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (latestCommit) db.prepare("INSERT OR REPLACE INTO current_projection_state(generation, commit_id) VALUES (1, ?)").run(blob(latestCommit.commit_id));
    db.prepare("INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(2, currentUtcMicros());
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function migrateV2ToV3(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE source_captures ADD COLUMN completeness_basis TEXT NOT NULL DEFAULT 'success-status-scope-count-details' CHECK(completeness_basis = 'success-status-scope-count-details')");
    db.exec("ALTER TABLE source_captures ADD COLUMN completeness_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1')");
    db.exec("ALTER TABLE source_sync_states RENAME TO source_sync_states_v2");
    db.exec(`CREATE TABLE source_sync_states (
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
      stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT,
      last_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(source_connection_id, account_id, stream)
    )`);
    db.exec(`INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id)
      SELECT source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id FROM source_sync_states_v2`);
    db.exec("DROP TABLE source_sync_states_v2");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(3, currentUtcMicros());
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function applySchemaMigration(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
  const version = Number(row.user_version ?? 0);
  if (version > CANONICAL_SCHEMA_VERSION) throw new Error(`Canonical SQLite schema ${version} is newer than supported ${CANONICAL_SCHEMA_VERSION}.`);
  if (version === 0 && tableExists(db, "canonical_commits")) throw new Error("Unversioned canonical SQLite schema is not compatible; refusing ad-hoc migration.");
  if (version === 1) {
    migrateV1ToV2(db);
    migrateV2ToV3(db);
    return;
  }
  if (version === 2) {
    migrateV2ToV3(db);
    return;
  }
  if (version === CANONICAL_SCHEMA_VERSION) {
    if (!tableExists(db, "schema_migrations")) throw new Error("Canonical SQLite schema version metadata is missing.");
    const migration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(CANONICAL_SCHEMA_VERSION);
    if (!migration) throw new Error("Canonical SQLite schema migration metadata is incomplete.");
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA);
    db.prepare("INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(CANONICAL_SCHEMA_VERSION, currentUtcMicros());
    db.exec(`PRAGMA user_version = ${CANONICAL_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateReadOnlyDatabase(db: DatabaseSync): void {
  const journalMode = String((db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown }).journal_mode ?? "").toLowerCase();
  if (journalMode !== "wal") throw new Error("Canonical SQLite WAL journal is not available for read-only access.");
  const integrity = String((db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown }).integrity_check ?? "");
  if (integrity !== "ok") throw new Error(`Canonical SQLite integrity check failed: ${integrity}`);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) throw new Error("Canonical SQLite foreign-key integrity check failed.");
  const commitCount = Number((db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get() as { count?: number }).count ?? 0);
  const currentCount = Number((db.prepare("SELECT COUNT(*) AS count FROM current_transactions").get() as { count?: number }).count ?? 0);
  const stateRows = db.prepare("SELECT generation, commit_id FROM current_projection_state").all() as Array<Record<string, unknown>>;
  if (commitCount > 0 && stateRows.length !== 1) throw new Error("Canonical current projection generation is missing or ambiguous.");
  if (stateRows.length === 1) {
    if (Number(stateRows[0]!.generation) !== 1 || !db.prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?").get(blob(stateRows[0]!.commit_id))) throw new Error("Canonical current projection generation references no commit.");
  }
  const projectionRows = Number((db.prepare(`SELECT COUNT(*) AS count FROM current_transactions current_row
    JOIN financial_transactions t ON t.transaction_id = current_row.transaction_id
    JOIN transaction_revisions r ON r.revision_id = current_row.revision_id
    WHERE r.transaction_id = current_row.transaction_id AND r.commit_id = current_row.commit_id`).get() as { count?: number }).count ?? 0);
  if (projectionRows !== currentCount) throw new Error("Canonical current projection authority is inconsistent.");
}

export function openCanonicalDatabase(ledgerDir: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const path = canonicalSqlitePath(ledgerDir);
  if (options.readOnly && !existsSync(path)) throw new Error(`Missing canonical SQLite: ${path}`);
  if (!options.readOnly) mkdirSync(ledgerDir, { recursive: true });
  const db = new DatabaseSync(path, options.readOnly ? { readOnly: true } : {});
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 30000");
    if (!options.readOnly) { db.exec("PRAGMA journal_mode = WAL"); db.exec("PRAGMA synchronous = FULL"); applySchemaMigration(db); }
    else {
      const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
      if (Number(row.user_version ?? 0) !== CANONICAL_SCHEMA_VERSION) throw new Error("Canonical SQLite schema is missing or unsupported for read-only access.");
      validateReadOnlyDatabase(db);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export type CanonicalAmount = { coefficient: string; scale: number };
export type CanonicalTransaction = {
  id: string; accountId: string; accountNo: string; sourceSequence: string; amount: CanonicalAmount; currency: "TWD";
  direction: "inflow" | "outflow"; postingStatus: "posted"; postingOrigin: "provider_booked_history"; postingBasis: "query-status-success-with-accounting-date"; postingRuleVersion: "cathay/domestic-deposit/v1";
  displayLabel: string | null; effectiveOn: string; effectiveTimeBasis: "accounting"; effectiveTimeRuleVersion: "cathay/domestic-deposit/v1"; transactionDateTimeLocal: string;
  timeZone: typeof CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE; timePrecision: "second"; timeOrigin: "source_reported";
  utcInstantUtcUs: number; revisionId: string; commitSequence: number;
};
export type CathayCanonicalCurrentQueryRequest = { kind: "current" };
export type CathayCanonicalCurrentQueryResult = { status: "ok"; kind: "current"; accounts: Array<{ id: string; accountNo: string; currency: "TWD"; accountType: "depository" }>; transactions: CanonicalTransaction[]; commitSequence: number };
export type CathayCanonicalHistoricalQueryRequest = { kind: "historical"; cutoff: { kind: "both"; financialAt: string; knowledgeAt: string } };
export type CathayCanonicalHistoricalQueryResult = { status: "ok"; kind: "historical"; cutoff: CathayCanonicalHistoricalQueryRequest["cutoff"]; transactions: CanonicalTransaction[] };
export type CathayCanonicalLineageQueryRequest = { kind: "lineage"; subject: { kind: "transaction"; id: string } };
export type CathayCanonicalLineageEntry = {
  transaction: { id: string; accountId: string; sourceSequence: string };
  revision: CanonicalTransactionRevision;
  assertion: { id: string; revisionId: string; commitSequence: number };
  sourceRecord: { id: string; captureId: string; sequence: string; description: string | null; payload: string };
  capture: { id: string; observedAt: string; scopeStart: string; scopeEnd: string; authorityRoute: string };
  provenance: Array<{ sourceRecordId: string; captureId: string }>;
};
export type CathayCanonicalLineageQueryResult = { status: "ok"; kind: "lineage"; subject: CathayCanonicalLineageQueryRequest["subject"]; entries: CathayCanonicalLineageEntry[] };
export type CanonicalTransactionRevision = CanonicalTransaction & { transactionId: string };
export interface CathayCanonicalFinancialQuery {
  current(request: CathayCanonicalCurrentQueryRequest): Promise<CathayCanonicalCurrentQueryResult>;
  historical(request: CathayCanonicalHistoricalQueryRequest): Promise<CathayCanonicalHistoricalQueryResult>;
  lineage(request: CathayCanonicalLineageQueryRequest): Promise<CathayCanonicalLineageQueryResult>;
}
export type CathayCommitTransactionResult = { transactionId: string; revisionId: string; sourceSequence: string; direction: "inflow" | "outflow"; amount: CanonicalAmount; revisionCreated: boolean };
export type CathayCanonicalCommitResult = { captureId: string; commitSequence: number; accountId: string; transactions: CathayCommitTransactionResult[] };

function dbRow<T extends Record<string, unknown>>(value: unknown): T { return value as T; }
function sameRevision(row: Record<string, unknown>, detail: ValidatedCathayRow): boolean {
  return row.amount_coefficient === detail.amount.coefficient.toString()
    && row.amount_scale === detail.amount.scale && row.direction === detail.direction
    && row.posting_status === CATHAY_POSTING_MAPPING.postingStatus && row.posting_origin === CATHAY_POSTING_MAPPING.origin
    && row.posting_basis === CATHAY_POSTING_MAPPING.basis && row.posting_rule_version === CATHAY_POSTING_MAPPING.ruleVersion
    && row.description === detail.description
    && row.effective_on === detail.accountDate && row.transaction_date_time_local === detail.transactionDateTime
    && row.time_zone === CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE && row.time_precision === "second"
    && row.time_origin === "source_reported" && row.effective_time_basis === "accounting"
    && row.effective_time_rule_version === CATHAY_POSTING_MAPPING.ruleVersion && Number(row.utc_instant_utc_us) === detail.utcInstantUtcUs;
}
function recordedAtUtcUs(value: string): number {
  return parseRfc3339UtcMicros(value, "Canonical admission clock");
}

function currentUtcMicros(): number {
  return parseRfc3339UtcMicros(new Date().toISOString(), "Canonical migration clock");
}

export type CanonicalAdmissionClock = () => string;
export type CathayCanonicalCommitOptions = { clock?: CanonicalAdmissionClock };

function commitCathayDomesticDepositOnce(
  ledgerDir: string,
  input: CathayDomesticDepositCaptureInput,
  validated: ValidatedCathayCapture,
  admissionClock: CanonicalAdmissionClock,
): CathayCanonicalCommitResult {
  const db = openCanonicalDatabase(ledgerDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const commitId = uuidV7();
    const maxSequence = Number((db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits").get() as { max_sequence?: number }).max_sequence ?? 0);
    const commitSequence = maxSequence + 1;
    db.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, ?)").run(commitId, commitSequence, recordedAtUtcUs(admissionClock()), CATHAY_DOMESTIC_DEPOSIT_AUTHORITY, "source_capture");
    db.prepare("INSERT OR IGNORE INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?)").run(CATHAY_DOMESTIC_DEPOSIT_AUTHORITY, CATHAY_INTEGRATION_NAMESPACE, CATHAY_DOMESTIC_DEPOSIT_STREAM, "v1", commitId);
    const connectionExisting = db.prepare("SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?").get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    const sourceConnectionId = connectionExisting ? blob(dbRow<{ source_connection_id: unknown }>(connectionExisting).source_connection_id) : uuidV7();
    if (!connectionExisting) db.prepare("INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?)").run(sourceConnectionId, CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId, commitId);
    const epochExisting = db.prepare("SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?").get(sourceConnectionId, input.identityEpoch);
    const identityEpochId = epochExisting ? blob(dbRow<{ identity_epoch_id: unknown }>(epochExisting).identity_epoch_id) : uuidV7();
    if (!epochExisting) db.prepare("INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?)").run(identityEpochId, sourceConnectionId, input.identityEpoch, commitId);
    const accountExisting = db.prepare("SELECT account_id, currency, account_type FROM financial_accounts WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND account_no = ?").get(sourceConnectionId, identityEpochId, CATHAY_DOMESTIC_DEPOSIT_STREAM, validated.accountNo);
    const accountId = accountExisting ? blob(dbRow<{ account_id: unknown }>(accountExisting).account_id) : uuidV7();
    if (accountExisting) {
      const account = dbRow<{ currency: string; account_type: string }>(accountExisting);
      if (account.currency !== input.currency || account.account_type !== "depository") throw new Error("Cathay account identity has conflicting required classification.");
    } else db.prepare("INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, account_no, account_type, currency, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(accountId, sourceConnectionId, identityEpochId, CATHAY_DOMESTIC_DEPOSIT_STREAM, validated.accountNo, "depository", input.currency, commitId);
    const captureId = uuidV7();
    db.prepare("INSERT INTO source_captures(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(captureId, sourceConnectionId, identityEpochId, input.authorityRoute, input.stream, validated.accountNo, input.observedAt, validated.startDate, validated.endDate, validated.completeness.kind, validated.completeness.basis, validated.completeness.ruleVersion, commitId);

    const transactionResults: CathayCommitTransactionResult[] = [];
    for (const detail of validated.rows) {
      const sourceRecordId = uuidV7();
      db.prepare("INSERT INTO source_records(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(sourceRecordId, captureId, commitId, detail.sequence, detail.description, detail.payload);
      const transactionExisting = db.prepare("SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?").get(accountId, detail.sequence);
      const transactionId = transactionExisting ? blob(dbRow<{ transaction_id: unknown }>(transactionExisting).transaction_id) : uuidV7();
      if (!transactionExisting) db.prepare("INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)").run(transactionId, accountId, detail.sequence, commitId);
      const latest = db.prepare("SELECT * FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1").get(transactionId);
      const latestRow = latest ? dbRow<Record<string, unknown>>(latest) : undefined;
      const revisionCreated = !latestRow || !sameRevision(latestRow, detail);
      let revisionId = latestRow ? blob(latestRow.revision_id) : uuidV7();
      if (revisionCreated) {
        revisionId = uuidV7();
        const revisionNumber = latestRow ? Number(latestRow.revision_number) + 1 : 1;
        db.prepare(`INSERT INTO transaction_revisions(
          revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency,
          direction, posting_status, posting_origin, posting_basis, posting_rule_version, description, effective_on, transaction_date_time_local,
          time_zone, time_precision, time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          revisionId, transactionId, sourceRecordId, captureId, commitId, revisionNumber, detail.amount.coefficient.toString(), detail.amount.scale,
          input.currency, detail.direction, validated.posting.postingStatus, validated.posting.origin, validated.posting.basis, validated.posting.ruleVersion,
          detail.description, detail.accountDate, detail.transactionDateTime, CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
          "second", "source_reported", "accounting", validated.posting.ruleVersion, detail.utcInstantUtcUs,
        );
        const insertObservation = db.prepare(`INSERT INTO transaction_time_observations(
          observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        insertObservation.run(uuidV7(), transactionId, revisionId, sourceRecordId, commitId, "accounting", detail.accountDate, CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "date", "source_reported", detail.accountingUtcInstantUtcUs);
        insertObservation.run(uuidV7(), transactionId, revisionId, sourceRecordId, commitId, "occurred", detail.transactionDateTime, CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "second", "source_reported", detail.utcInstantUtcUs);
        const assertionId = uuidV7();
        db.prepare("INSERT INTO source_assertions(assertion_id, transaction_id, revision_id, source_record_id, commit_id) VALUES (?, ?, ?, ?, ?)").run(assertionId, transactionId, revisionId, sourceRecordId, commitId);
        db.prepare("INSERT INTO current_transactions(transaction_id, revision_id, commit_id) VALUES (?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET revision_id = excluded.revision_id, commit_id = excluded.commit_id").run(transactionId, revisionId, commitId);
      }
      const assertion = db.prepare("SELECT assertion_id FROM source_assertions WHERE transaction_id = ? AND revision_id = ?").get(transactionId, revisionId);
      if (!assertion) throw new Error("Canonical assertion was not created.");
      const assertionId = blob(dbRow<{ assertion_id: unknown }>(assertion).assertion_id);
      db.prepare("INSERT INTO assertion_provenance(assertion_id, source_record_id, commit_id) VALUES (?, ?, ?)").run(assertionId, sourceRecordId, commitId);
      transactionResults.push({ transactionId: idToString(transactionId), revisionId: idToString(revisionId), sourceSequence: detail.sequence, direction: detail.direction, amount: { coefficient: detail.amount.coefficient.toString(), scale: detail.amount.scale }, revisionCreated });
    }
    db.prepare(`INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET scope_start = excluded.scope_start,
      scope_end = excluded.scope_end, cursor = excluded.cursor, last_capture_id = excluded.last_capture_id, commit_id = excluded.commit_id`).run(sourceConnectionId, accountId, CATHAY_DOMESTIC_DEPOSIT_STREAM, validated.startDate, validated.endDate, input.syncState.cursor ?? null, captureId, commitId);
    db.prepare("INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id").run(commitId);
    db.exec("COMMIT");
    inTransaction = false;
    return { captureId: idToString(captureId), commitSequence, accountId: idToString(accountId), transactions: transactionResults };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

const writerQueues = new Map<string, Promise<void>>();
async function withCanonicalWriter<T>(ledgerDir: string, operation: () => T): Promise<T> {
  const key = canonicalSqlitePath(ledgerDir);
  const previous = writerQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => turn);
  writerQueues.set(key, queued);
  await previous;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { return operation(); }
      catch (error) {
        if (attempt >= 2 || !/busy|locked/i.test(String(error))) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    release();
    if (writerQueues.get(key) === queued) writerQueues.delete(key);
  }
}

export function commitCathayDomesticDeposit(
  ledgerDir: string,
  input: CathayDomesticDepositCaptureInput,
  options: CathayCanonicalCommitOptions = {},
): Promise<CathayCanonicalCommitResult> {
  const validated = validateCapture(input);
  const admissionClock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(ledgerDir, () => commitCathayDomesticDepositOnce(ledgerDir, input, validated, admissionClock));
}

function amountFromRow(row: Record<string, unknown>, prefix = ""): CanonicalAmount { return { coefficient: String(row[`${prefix}amount_coefficient`]), scale: Number(row[`${prefix}amount_scale`]) }; }
function transactionFromRow(row: Record<string, unknown>): CanonicalTransaction {
  return {
    id: idToString(row.transaction_id), accountId: idToString(row.account_id), accountNo: String(row.account_no), sourceSequence: String(row.source_sequence),
    amount: amountFromRow(row), currency: "TWD", direction: row.direction as "inflow" | "outflow", postingStatus: row.posting_status as "posted",
    postingOrigin: row.posting_origin as "provider_booked_history", postingBasis: row.posting_basis as "query-status-success-with-accounting-date", postingRuleVersion: row.posting_rule_version as "cathay/domestic-deposit/v1",
    displayLabel: typeof row.description === "string" ? row.description : null, effectiveOn: String(row.effective_on), effectiveTimeBasis: row.effective_time_basis as "accounting", effectiveTimeRuleVersion: row.effective_time_rule_version as "cathay/domestic-deposit/v1",
    transactionDateTimeLocal: String(row.transaction_date_time_local), timeZone: CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, timePrecision: "second", timeOrigin: "source_reported",
    utcInstantUtcUs: Number(row.utc_instant_utc_us), revisionId: idToString(row.revision_id), commitSequence: Number(row.commit_sequence),
  };
}
function transactionRevisionFromRow(row: Record<string, unknown>): CanonicalTransactionRevision {
  const transaction = transactionFromRow(row);
  return { ...transaction, id: idToString(row.revision_id), transactionId: transaction.id };
}

class CathayCanonicalFinancialQueryAdapter implements CathayCanonicalFinancialQuery {
  private readonly ledgerDir: string;

  constructor(ledgerDir: string) { this.ledgerDir = ledgerDir; }
  async current(_request: CathayCanonicalCurrentQueryRequest): Promise<CathayCanonicalCurrentQueryResult> {
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const accounts = (db.prepare("SELECT account_id AS id, account_no AS accountNo, currency, account_type AS accountType FROM financial_accounts ORDER BY account_no").all() as Record<string, unknown>[]).map((row) => ({ id: idToString(row.id), accountNo: String(row.accountNo), currency: "TWD" as const, accountType: "depository" as const }));
      const rows = db.prepare(`SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence FROM current_transactions current_row
        JOIN financial_transactions t ON t.transaction_id = current_row.transaction_id JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.revision_id = current_row.revision_id JOIN canonical_commits c ON c.commit_id = current_row.commit_id
        ORDER BY a.account_no, t.source_sequence`).all() as Record<string, unknown>[];
      return { status: "ok", kind: "current", accounts, transactions: rows.map(transactionFromRow), commitSequence: rows.reduce((max, row) => Math.max(max, Number(row.commit_sequence)), 0) };
    } finally { db.close(); }
  }
  async historical(request: CathayCanonicalHistoricalQueryRequest): Promise<CathayCanonicalHistoricalQueryResult> {
    if (request.cutoff.kind !== "both" || !/^\d{4}-\d{2}-\d{2}$/.test(request.cutoff.financialAt) || !/^\d+$/.test(request.cutoff.knowledgeAt)) throw new Error("Canonical historical queries require financial-time and knowledge-time cutoffs.");
    requireDate(request.cutoff.financialAt, "historical financialAt");
    const knowledgeAt = Number(request.cutoff.knowledgeAt);
    if (!Number.isSafeInteger(knowledgeAt)) throw new Error("Canonical historical knowledgeAt is outside the supported sequence range.");
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        WHERE r.effective_on <= ? AND c.commit_sequence <= ? AND NOT EXISTS (
          SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
          WHERE newer.transaction_id = r.transaction_id AND newer.effective_on <= ? AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > c.commit_sequence
        ) ORDER BY a.account_no, t.source_sequence`).all(request.cutoff.financialAt, knowledgeAt, request.cutoff.financialAt, knowledgeAt) as Record<string, unknown>[];
      return { status: "ok", kind: "historical", cutoff: request.cutoff, transactions: rows.map(transactionFromRow) };
    } finally { db.close(); }
  }
  async lineage(request: CathayCanonicalLineageQueryRequest): Promise<CathayCanonicalLineageQueryResult> {
    if (request.subject.kind !== "transaction" || !request.subject.id) throw new Error("Cathay lineage queries require a transaction subject.");
    const transactionId = idFromString(request.subject.id);
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const revisionRows = db.prepare(`SELECT t.transaction_id, t.account_id, t.source_sequence, a.account_no, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence, r.source_record_id, r.capture_id, sr.sequence_lexeme, sr.description, sr.payload_json,
        sc.observed_at, sc.scope_start, sc.scope_end, sc.authority_route, sa.assertion_id FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        JOIN source_records sr ON sr.source_record_id = r.source_record_id JOIN source_captures sc ON sc.capture_id = r.capture_id
        JOIN source_assertions sa ON sa.revision_id = r.revision_id WHERE t.transaction_id = ? ORDER BY r.revision_number`).all(transactionId) as Record<string, unknown>[];
      const entries = revisionRows.map((row) => {
        const assertionId = blob(row.assertion_id);
        const provenance = db.prepare(`SELECT p.source_record_id AS sourceRecordId, sr.capture_id AS captureId FROM assertion_provenance p
          JOIN source_records sr ON sr.source_record_id = p.source_record_id WHERE p.assertion_id = ? ORDER BY p.source_record_id`).all(assertionId) as Record<string, unknown>[];
        const revision = transactionRevisionFromRow(row);
        return {
          transaction: { id: idToString(row.transaction_id), accountId: idToString(row.account_id), sourceSequence: String(row.source_sequence) },
          revision,
          assertion: { id: idToString(row.assertion_id), revisionId: idToString(row.revision_id), commitSequence: Number(row.commit_sequence) },
          sourceRecord: { id: idToString(row.source_record_id), captureId: idToString(row.capture_id), sequence: String(row.sequence_lexeme), description: typeof row.description === "string" ? row.description : null, payload: String(row.payload_json) },
          capture: { id: idToString(row.capture_id), observedAt: String(row.observed_at), scopeStart: String(row.scope_start), scopeEnd: String(row.scope_end), authorityRoute: String(row.authority_route) },
          provenance: provenance.map((item) => ({ sourceRecordId: idToString(item.sourceRecordId), captureId: idToString(item.captureId) })),
        } satisfies CathayCanonicalLineageEntry;
      });
      return { status: "ok", kind: "lineage", subject: request.subject, entries };
    } finally { db.close(); }
  }
}

export function createCathayCanonicalFinancialQuery(ledgerDir: string): CathayCanonicalFinancialQuery { return new CathayCanonicalFinancialQueryAdapter(ledgerDir); }
