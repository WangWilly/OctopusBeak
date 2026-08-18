import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CATHAY_INTEGRATION_NAMESPACE = "cathay";
export const CATHAY_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
export const CATHAY_DOMESTIC_DEPOSIT_AUTHORITY = "cathay/domestic-deposit/v1";
export const CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";
export const CANONICAL_SQLITE_FILE = "canonical.sqlite";
export const CANONICAL_SCHEMA_VERSION = 6;
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
  absenceAuthority?: CathayAbsenceAuthority;
};

export type CathayAbsenceAuthority = "comparable-complete-range";
export type CathayTransportCheckpoint = {
  kind: "transport-progress";
  ordinal: number;
  token: string | null;
};
export type CathayStagedCapturePage = {
  accountNo: string;
  currency: "TWD";
  scope: { startDate: string; endDate: string };
  pageOrdinal: number;
  requestPageToken: string | null;
  nextPageToken: string | null;
  rawResponse: string;
  contractFingerprint: string;
  preflightFingerprint: string;
  absenceAuthority?: CathayAbsenceAuthority;
  transportCheckpoint?: CathayTransportCheckpoint;
};
export type CathayDomesticDepositSyncInput = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  syncState: { cursor?: string | null };
  observedAt: string;
  pages: CathayStagedCapturePage[];
};

/** The first derived import contract is deliberately transaction-scoped.  A
 * complete run supplies one coordinate for every transaction/field pair it
 * claims to own.  Unsupported is an explicit output state, not a missing
 * array element, so a partial producer can never withdraw an old claim. */
export type CathayDerivedField = "display_name" | "note";
export type CathayDerivedOutputState = "supported" | "unsupported";
export type CathayDerivedImportCoordinate = {
  transactionId: string;
  field: CathayDerivedField;
  state: CathayDerivedOutputState;
  value?: string | null;
};
export type CathayDerivedImportSubject = { kind: "transaction"; id: string } | string;
export type CathayDerivedImportScope = {
  subjects: CathayDerivedImportSubject[];
  fields: CathayDerivedField[];
  producerId?: string;
  origin?: string;
  ruleLineage?: string;
};
export type CathayDerivedImportRunInput = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  producerId: string;
  ruleLineage: string;
  origin?: string;
  observedAt?: string;
  /** Complete subject/field/producer/rule-lineage coordinate matrix. */
  scope?: CathayDerivedImportCoordinate[] | CathayDerivedImportScope;
  outputScope?: CathayDerivedImportCoordinate[] | CathayDerivedImportScope;
  coordinates?: CathayDerivedImportCoordinate[];
  outputs?: CathayDerivedImportCoordinate[];
  /** Compatibility spelling for callers that model a complete run explicitly. */
  complete?: boolean;
};
export type CathayDerivedImportDiagnostic = {
  kind: "derived-import-diagnostic";
  stage: "preflight" | "scope" | "commit";
  reason: string;
  producerId?: string;
  ruleLineage?: string;
};
export type CathayDerivedImportResult =
  | { status: "committed"; runId: string; commitSequence: number; assertionIds: string[] }
  | { status: "diagnostic"; diagnostic: CathayDerivedImportDiagnostic };
export type CathayDerivedImportOptions = CathayCanonicalCommitOptions & {
  onDiagnostic?: (diagnostic: CathayDerivedImportDiagnostic) => void;
};

export type CathayUserAssertionField = "display_name" | "note";
export type CathayUserAssertionInput = {
  transactionId?: string;
  subject?: { kind: "transaction"; id: string };
  field?: CathayUserAssertionField | string;
  target?: { kind?: string; field?: string; id?: string } | string;
  value?: string | null;
  userId?: string;
  observedAt?: string;
};
export type CathayUserAssertionResult = {
  status: "committed";
  assertionId: string;
  commitSequence: number;
  field: CathayUserAssertionField;
  withdrawn: boolean;
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
type ValidatedCathayScope = {
  accountNo: string;
  currency: "TWD";
  startDate: string;
  endDate: string;
  absenceAuthority?: CathayAbsenceAuthority;
  contractFingerprint: string;
  preflightFingerprint: string;
  pages: Array<{
    pageOrdinal: number;
    terminal: boolean;
    rowCount: number;
    responseDigest: string;
    rows: ValidatedCathayRow[];
  }>;
  rows: ValidatedCathayRow[];
};
type ValidatedCathaySync = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  syncState: { cursor?: string | null };
  observedAt: string;
  scopes: ValidatedCathayScope[];
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

function responseDigest(rawResponse: string): string {
  return createHash("sha256").update(rawResponse, "utf8").digest("hex");
}

function validateSyncInput(input: CathayDomesticDepositSyncInput): ValidatedCathaySync {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim()) throw new Error("Source Connection and Identity Epoch are required.");
  if (input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY || input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM) throw new Error("Invalid Cathay sync authority route or stream.");
  if (input.syncState.cursor !== undefined && input.syncState.cursor !== null) throw new Error("Cathay domestic deposit has no continuation cursor.");
  parseRfc3339UtcMicros(input.observedAt, "Capture observedAt");
  if (input.pages.length === 0) throw new Error("Cathay sync requires at least one staged page.");

  const grouped = new Map<string, CathayStagedCapturePage[]>();
  for (const page of input.pages) {
    if (!page.accountNo.trim() || page.currency !== "TWD") throw new Error("Cathay staged page has an invalid account identity or currency.");
    if (!Number.isInteger(page.pageOrdinal) || page.pageOrdinal < 0) throw new Error("Cathay page ordinal must be a non-negative integer.");
    if (!page.contractFingerprint.trim() || !page.preflightFingerprint.trim()) throw new Error("Cathay page contract and preflight fingerprints are required.");
    if (page.contractFingerprint !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY) throw new Error("Cathay page contract fingerprint is unsupported.");
    const pages = grouped.get(page.accountNo) ?? [];
    pages.push(page);
    grouped.set(page.accountNo, pages);
  }
  const scopes: ValidatedCathayScope[] = [];
  let contractFingerprint: string | undefined;
  let preflightFingerprint: string | undefined;
  for (const [accountNo, pagesForAccount] of grouped) {
    const pages = [...pagesForAccount].sort((left, right) => left.pageOrdinal - right.pageOrdinal);
    if (new Set(pages.map((page) => page.pageOrdinal)).size !== pages.length) throw new Error("Cathay staged pages contain duplicate ordinals.");
    const first = pages[0]!;
    const startDate = requireDate(first.scope.startDate, "Cathay scope.startDate");
    const endDate = requireDate(first.scope.endDate, "Cathay scope.endDate");
    if (startDate > endDate) throw new Error("Cathay scope startDate must not be after endDate.");
    const pageRows: ValidatedCathayScope["pages"] = [];
    const rows: ValidatedCathayRow[] = [];
    const sequences = new Set<string>();
    let expectedRequestToken: string | null = null;
    let absenceAuthority = first.absenceAuthority;
    if ((first.absenceAuthority as string | undefined) === "tombstone") throw new Error("Cathay tombstone authority is unsupported without a source-validated tombstone record.");
    for (const [index, page] of pages.entries()) {
      if ((page.absenceAuthority as string | undefined) === "tombstone") throw new Error("Cathay tombstone authority is unsupported without a source-validated tombstone record.");
      if (page.pageOrdinal !== index) throw new Error("Cathay staged pages must have contiguous ordinals starting at zero.");
      if (page.scope.startDate !== startDate || page.scope.endDate !== endDate) throw new Error("Cathay page scope drifted within one account.");
      if (page.contractFingerprint !== first.contractFingerprint || page.preflightFingerprint !== first.preflightFingerprint) throw new Error("Cathay page contract or preflight fingerprint drifted.");
      if (page.absenceAuthority !== absenceAuthority) throw new Error("Cathay page absence authority drifted.");
      const requestPageToken = page.requestPageToken ?? null;
      if (requestPageToken !== expectedRequestToken) throw new Error("Cathay page continuation token is not contiguous.");
      const validated = validateCapture({
        rawResponse: page.rawResponse,
        sourceConnectionId: input.sourceConnectionId,
        identityEpoch: input.identityEpoch,
        accountNo,
        currency: page.currency,
        authorityRoute: input.authorityRoute,
        stream: input.stream,
        scope: { startDate, endDate },
        syncState: { cursor: null },
        observedAt: input.observedAt,
      });
      const nextPageToken = page.nextPageToken ?? null;
      const terminal = nextPageToken === null;
      if (!terminal && index === pages.length - 1) throw new Error("Cathay staged pages end before the terminal page.");
      if (terminal && index !== pages.length - 1) throw new Error("Cathay staged pages contain a missing continuation page.");
      for (const row of validated.rows) {
        if (sequences.has(row.sequence)) throw new Error("Cathay source sequence was duplicated across pages.");
        sequences.add(row.sequence);
        rows.push(row);
      }
      pageRows.push({ pageOrdinal: page.pageOrdinal, terminal, rowCount: validated.rows.length, responseDigest: responseDigest(page.rawResponse), rows: validated.rows });
      expectedRequestToken = nextPageToken;
      contractFingerprint ??= page.contractFingerprint;
      preflightFingerprint ??= page.preflightFingerprint;
      if (contractFingerprint !== page.contractFingerprint || preflightFingerprint !== page.preflightFingerprint) throw new Error("Cathay sync contract or preflight fingerprint drifted across scopes.");
    }
    scopes.push({ accountNo, currency: "TWD", startDate, endDate, absenceAuthority, contractFingerprint: first.contractFingerprint, preflightFingerprint: first.preflightFingerprint, pages: pageRows, rows });
  }
  return { sourceConnectionId: input.sourceConnectionId, identityEpoch: input.identityEpoch, authorityRoute: input.authorityRoute, stream: input.stream, syncState: { cursor: null }, observedAt: input.observedAt, scopes };
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
  stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),
  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS source_records (
  source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), sequence_lexeme TEXT NOT NULL, description TEXT,
  payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)
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
  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),
  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),
  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),
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
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
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

const SCHEMA_V4_APPEND = `
CREATE TABLE IF NOT EXISTS capture_scopes (
  scope_id BLOB PRIMARY KEY CHECK(length(scope_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id), account_no TEXT NOT NULL, stream TEXT NOT NULL,
  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),
  completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),
  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'),
  absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'tombstone')),
  contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL, page_count INTEGER NOT NULL CHECK(page_count > 0),
  terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(capture_id, account_id, scope_start, scope_end)
);
CREATE TABLE IF NOT EXISTS capture_scope_pages (
  scope_page_id BLOB PRIMARY KEY CHECK(length(scope_page_id) = 16), scope_id BLOB NOT NULL REFERENCES capture_scopes(scope_id),
  page_ordinal INTEGER NOT NULL CHECK(page_ordinal >= 0), terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)), row_count INTEGER NOT NULL CHECK(row_count >= 0),
  response_digest TEXT NOT NULL, proof_kind TEXT NOT NULL CHECK(proof_kind = 'success-status-scope-count-details'),
  contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL, commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(scope_id, page_ordinal)
);
CREATE TABLE IF NOT EXISTS assertion_lifecycle_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16), assertion_id BLOB NOT NULL REFERENCES source_assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id), revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), scope_id BLOB REFERENCES capture_scopes(scope_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), event_kind TEXT NOT NULL CHECK(event_kind IN ('observed', 'superseded', 'withdrawn', 'restored'))
);
CREATE INDEX IF NOT EXISTS idx_capture_scopes_account_time ON capture_scopes(source_connection_id, identity_epoch_id, account_id, scope_start, scope_end, commit_id);
CREATE INDEX IF NOT EXISTS idx_capture_scope_pages_proof ON capture_scope_pages(scope_id, page_ordinal, commit_id);
CREATE INDEX IF NOT EXISTS idx_assertion_lifecycle_assertion_knowledge ON assertion_lifecycle_events(assertion_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_lifecycle_transaction_knowledge ON assertion_lifecycle_events(transaction_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_lifecycle_scope ON assertion_lifecycle_events(scope_id, commit_id, assertion_id);
`;
const SCHEMA_V4_BASE = SCHEMA
  .replace("stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL", "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL")
  .replace("payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)", "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)")
  .replace("  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n", "")
  .replace("  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);", "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);");
const SCHEMA_V4 = `${SCHEMA_V4_BASE}${SCHEMA_V4_APPEND}`;
const SCHEMA_V5_APPEND = `
CREATE TABLE IF NOT EXISTS source_record_scopes (
  source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16),
  scope_id BLOB NOT NULL CHECK(length(scope_id) = 16),
  capture_id BLOB NOT NULL CHECK(length(capture_id) = 16) REFERENCES source_captures(capture_id),
  account_id BLOB NOT NULL CHECK(length(account_id) = 16) REFERENCES financial_accounts(account_id),
  sequence_lexeme TEXT NOT NULL, commit_id BLOB NOT NULL CHECK(length(commit_id) = 16) REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(source_record_id, capture_id) REFERENCES source_records(source_record_id, capture_id),
  FOREIGN KEY(scope_id, capture_id) REFERENCES capture_scopes(scope_id, capture_id),
  FOREIGN KEY(scope_id, account_id) REFERENCES capture_scopes(scope_id, account_id),
  UNIQUE(scope_id, sequence_lexeme)
);
CREATE INDEX IF NOT EXISTS idx_source_record_scopes_scope_sequence ON source_record_scopes(scope_id, sequence_lexeme, source_record_id);
CREATE INDEX IF NOT EXISTS idx_source_record_scopes_account_capture ON source_record_scopes(account_id, capture_id, source_record_id);
`;
const SCHEMA_V5 = `${SCHEMA_V4}${SCHEMA_V5_APPEND}`
  .replace("stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL", "stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL")
  .replace("payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)", "payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)")
  .replace("  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,\n", "  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,\n  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n")
  .replace("  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);\nCREATE TABLE IF NOT EXISTS current_projection_state", "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);\nCREATE TABLE IF NOT EXISTS current_projection_state")
  .replace("  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),", "  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, scope_kind TEXT NOT NULL CHECK(scope_kind = 'bounded-range'), completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),")
  .replace("UNIQUE(capture_id, account_id, scope_start, scope_end)", "UNIQUE(scope_id, capture_id), UNIQUE(scope_id, account_id), UNIQUE(capture_id, account_id, scope_start, scope_end)")
  .replace("absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'tombstone'))", "absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range'))");

const SCHEMA_V6_APPEND = `
CREATE TABLE IF NOT EXISTS derived_import_runs (
  run_id BLOB PRIMARY KEY CHECK(length(run_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  stream TEXT NOT NULL, producer_id TEXT NOT NULL, origin TEXT NOT NULL,
  rule_lineage TEXT NOT NULL, observed_at TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  status TEXT NOT NULL CHECK(status = 'complete'),
  UNIQUE(run_id, producer_id, rule_lineage)
);
CREATE TABLE IF NOT EXISTS derived_scope_coordinates (
  coordinate_id BLOB PRIMARY KEY CHECK(length(coordinate_id) = 16),
  run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  producer_id TEXT NOT NULL, origin TEXT NOT NULL, rule_lineage TEXT NOT NULL,
  output_state TEXT NOT NULL CHECK(output_state IN ('supported','unsupported')),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(run_id, transaction_id, field_name, producer_id, origin, rule_lineage)
);
CREATE TABLE IF NOT EXISTS derived_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  producer_id TEXT NOT NULL, origin TEXT NOT NULL, rule_lineage TEXT NOT NULL,
  value_text TEXT NOT NULL, run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(assertion_id, transaction_id, field_name, producer_id, origin, rule_lineage)
);
CREATE TABLE IF NOT EXISTS derived_assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES derived_assertions(assertion_id),
  run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB NOT NULL REFERENCES derived_scope_coordinates(coordinate_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, run_id, coordinate_id)
);
CREATE TABLE IF NOT EXISTS derived_assertion_lifecycle_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES derived_assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','restored','provenance_only'))
);
CREATE TABLE IF NOT EXISTS user_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  user_id TEXT NOT NULL, value_text TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(assertion_id, transaction_id, field_name, user_id)
);
CREATE TABLE IF NOT EXISTS user_assertion_lifecycle_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES user_assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  user_id TEXT NOT NULL, commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','provenance_only'))
);
CREATE TABLE IF NOT EXISTS user_assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES user_assertions(assertion_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, commit_id)
);
CREATE TABLE IF NOT EXISTS current_transaction_fields (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BLOB REFERENCES derived_assertions(assertion_id),
  user_assertion_id BLOB REFERENCES user_assertions(assertion_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_derived_scope_coordinates_lineage ON derived_scope_coordinates(transaction_id, field_name, origin, producer_id, rule_lineage, commit_id);
CREATE INDEX IF NOT EXISTS idx_derived_assertions_lineage ON derived_assertions(transaction_id, field_name, origin, producer_id, rule_lineage, commit_id);
CREATE INDEX IF NOT EXISTS idx_derived_assertion_provenance_run ON derived_assertion_provenance(run_id, coordinate_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_derived_assertion_lifecycle_knowledge ON derived_assertion_lifecycle_events(assertion_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_user_assertion_lifecycle_knowledge ON user_assertion_lifecycle_events(assertion_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_user_assertion_provenance_commit ON user_assertion_provenance(commit_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_current_transaction_fields_projection ON current_transaction_fields(field_name, origin, projection_commit_id, transaction_id);
`;
const SCHEMA_V6 = `${SCHEMA_V5.replace("CHECK(commit_kind = 'source_capture')", "CHECK(commit_kind IN ('source_capture','derived_import','user_assertion'))")}${SCHEMA_V6_APPEND}`;

// Version 2 deliberately excludes only the v3 completeness proof columns and nullable cursor.
// Keeping this target schema separate prevents an older database from being created at a
// partially upgraded shape before its migration transaction reaches the next version.
const SCHEMA_V2 = SCHEMA
  .replace("stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL", "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL")
  .replace("payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)", "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)")
  .replace("  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n", "")
  .replace("  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);", "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);")
  .replace(
    "completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),\n  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)",
    "completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)",
  )
  .replace("stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT,", "stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT NOT NULL,");
if (SCHEMA_V2.includes("completeness_basis") || SCHEMA_V2.includes("completeness_rule_version") || !SCHEMA_V2.includes("cursor TEXT NOT NULL")) {
  throw new Error("Canonical schema v2 target definition is inconsistent with its migration contract.");
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((row) => row.name === column);
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
    db.exec(SCHEMA_V2);
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
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(2, currentUtcMicros());
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
    db.exec(SCHEMA_V2);
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(3, currentUtcMicros());
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function migrateV3ToV4(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_V4_APPEND);
    db.exec(`INSERT INTO capture_scopes(
      scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, account_no, stream, scope_start, scope_end,
      completeness, completeness_basis, completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id
    )
      SELECT randomblob(16), sc.capture_id, sc.source_connection_id, sc.identity_epoch_id, account_row.account_id, account_row.account_no, sc.stream,
        sc.scope_start, sc.scope_end, sc.completeness, sc.completeness_basis, sc.completeness_rule_version, NULL,
        sc.authority_route, 'legacy-migration-v4', 1, 1, sc.commit_id
      FROM source_captures sc
      JOIN financial_accounts account_row ON account_row.source_connection_id = sc.source_connection_id
        AND account_row.identity_epoch_id = sc.identity_epoch_id AND account_row.stream = sc.stream AND account_row.account_no = sc.account_no
      WHERE NOT EXISTS (SELECT 1 FROM capture_scopes existing WHERE existing.capture_id = sc.capture_id)`);
    db.exec(`INSERT INTO capture_scope_pages(
      scope_page_id, scope_id, page_ordinal, terminal, row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, commit_id
    )
      SELECT randomblob(16), cs.scope_id, 0, 1,
        (SELECT COUNT(*) FROM source_records sr WHERE sr.capture_id = cs.capture_id), 'legacy-migration-v4', cs.completeness_basis,
        cs.contract_fingerprint, cs.preflight_fingerprint, cs.commit_id
      FROM capture_scopes cs LEFT JOIN capture_scope_pages existing_page ON existing_page.scope_id = cs.scope_id
      WHERE existing_page.scope_id IS NULL`);
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(4, currentUtcMicros());
    db.exec("PRAGMA user_version = 4");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export type CanonicalMigrationFailureInjection = "v4-v5-after-record-copy" | "v5-v6-after-derived-schema";
export type CanonicalDatabaseOptions = { readOnly?: boolean; injectMigrationFailure?: CanonicalMigrationFailureInjection };

function migrateV4ToV5(db: DatabaseSync, injectMigrationFailure?: CanonicalMigrationFailureInjection): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TEMP TABLE source_record_scope_migration AS
      WITH source_record_accounts AS (
        SELECT sr.source_record_id, sr.capture_id, sr.commit_id, sr.sequence_lexeme, sr.description, sr.payload_json, account_row.account_id
        FROM source_records sr
        JOIN transaction_revisions revision ON revision.source_record_id = sr.source_record_id
        JOIN financial_transactions transaction_row ON transaction_row.transaction_id = revision.transaction_id
        JOIN financial_accounts account_row ON account_row.account_id = transaction_row.account_id
        UNION
        SELECT sr.source_record_id, sr.capture_id, sr.commit_id, sr.sequence_lexeme, sr.description, sr.payload_json, account_row.account_id
        FROM source_records sr
        JOIN assertion_provenance provenance ON provenance.source_record_id = sr.source_record_id
        JOIN source_assertions assertion ON assertion.assertion_id = provenance.assertion_id
        JOIN financial_transactions transaction_row ON transaction_row.transaction_id = assertion.transaction_id
        JOIN financial_accounts account_row ON account_row.account_id = transaction_row.account_id
      )
      SELECT DISTINCT source_record_accounts.source_record_id, source_record_accounts.capture_id, source_record_accounts.commit_id,
        source_record_accounts.sequence_lexeme AS old_sequence, source_record_accounts.description, source_record_accounts.payload_json,
        cs.scope_id, cs.account_id, cs.account_no,
        CASE WHEN source_record_accounts.sequence_lexeme LIKE cs.account_no || ':%'
          THEN substr(source_record_accounts.sequence_lexeme, length(cs.account_no) + 2) ELSE source_record_accounts.sequence_lexeme END AS provider_sequence
      FROM source_record_accounts
      JOIN capture_scopes cs ON cs.capture_id = source_record_accounts.capture_id AND cs.account_id = source_record_accounts.account_id`);
    const recordCount = Number((db.prepare("SELECT COUNT(*) AS count FROM source_records").get() as { count?: number }).count ?? 0);
    const mappedCount = Number((db.prepare("SELECT COUNT(*) AS count FROM source_record_scope_migration").get() as { count?: number }).count ?? 0);
    if (recordCount !== mappedCount) throw new Error("v4 source records could not be deterministically mapped to capture scopes.");
    const ambiguous = Number((db.prepare("SELECT COUNT(*) AS count FROM (SELECT source_record_id FROM source_record_scope_migration GROUP BY source_record_id HAVING COUNT(*) <> 1)").get() as { count?: number }).count ?? 0);
    if (ambiguous !== 0) throw new Error("v4 source records have ambiguous capture scope identity.");
    const projectionState = db.prepare(`SELECT state.commit_id, commit_row.commit_sequence FROM current_projection_state state
      JOIN canonical_commits commit_row ON commit_row.commit_id = state.commit_id WHERE state.generation = 1`).get() as { commit_id?: unknown; commit_sequence?: number } | undefined;
    const currentRowCount = Number((db.prepare("SELECT COUNT(*) AS count FROM current_transactions").get() as { count?: number }).count ?? 0);
    if (currentRowCount > 0 && !projectionState) throw new Error("v4 current projection state is missing; restoration knowledge is ambiguous.");
    const ambiguousRestorations = Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT lifecycle.transaction_id, lifecycle.revision_id, commit_row.commit_sequence
      FROM assertion_lifecycle_events lifecycle JOIN canonical_commits commit_row ON commit_row.commit_id = lifecycle.commit_id
      WHERE lifecycle.event_kind = 'restored'
      GROUP BY lifecycle.transaction_id, lifecycle.revision_id, commit_row.commit_sequence HAVING COUNT(*) > 1
    )`).get() as { count?: number }).count ?? 0);
    if (ambiguousRestorations !== 0) throw new Error("v4 restoration projection knowledge is ambiguous.");
    db.exec(`CREATE TEMP TABLE current_projection_migration AS
      SELECT current_row.transaction_id, current_row.revision_id,
        COALESCE((SELECT lifecycle.commit_id FROM assertion_lifecycle_events lifecycle JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = lifecycle.commit_id
          WHERE lifecycle.event_kind = 'restored' AND lifecycle.transaction_id = current_row.transaction_id AND lifecycle.revision_id = current_row.revision_id
          ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC LIMIT 1), current_row.commit_id) AS projection_commit_id,
        revision.commit_id AS revision_commit_id
      FROM current_transactions current_row JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id`);
    if (projectionState) {
      if (projectionState.commit_sequence === undefined) throw new Error("v4 current projection state sequence is missing; restoration knowledge is ambiguous.");
      const outOfBounds = Number((db.prepare(`SELECT COUNT(*) AS count FROM current_projection_migration migrated JOIN canonical_commits projection_commit ON projection_commit.commit_id = migrated.projection_commit_id WHERE projection_commit.commit_sequence > ?`).get(projectionState.commit_sequence) as { count?: number }).count ?? 0);
      if (outOfBounds !== 0) throw new Error("v4 restoration projection knowledge exceeds current projection state.");
    }

    db.exec(`CREATE TABLE source_captures_v5 (
      capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
      stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
      completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),
      completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
    )`);
    db.exec(`INSERT INTO source_captures_v5(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id)
      SELECT capture_id, source_connection_id, identity_epoch_id, authority_route, stream,
        CASE WHEN account_no = 'multi-scope' THEN NULL ELSE account_no END, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id
      FROM source_captures`);
    db.exec(`CREATE TABLE source_records_v5 (
      source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), sequence_lexeme TEXT NOT NULL, description TEXT, payload_json TEXT NOT NULL,
      UNIQUE(source_record_id, capture_id)
    )`);
    db.exec("INSERT INTO source_records_v5(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) SELECT source_record_id, capture_id, commit_id, provider_sequence, description, payload_json FROM source_record_scope_migration");
    if (injectMigrationFailure === "v4-v5-after-record-copy") throw new Error("Injected v4-v5 migration failure after record copy.");
    db.exec("DROP TABLE source_records; DROP TABLE source_captures; ALTER TABLE source_captures_v5 RENAME TO source_captures; ALTER TABLE source_records_v5 RENAME TO source_records");
    if (!columnExists(db, "capture_scopes", "scope_kind")) db.exec("ALTER TABLE capture_scopes ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'bounded-range' CHECK(scope_kind = 'bounded-range')");
    if (!columnExists(db, "transaction_revisions", "economic_status")) db.exec("ALTER TABLE transaction_revisions ADD COLUMN economic_status TEXT NOT NULL DEFAULT 'normal' CHECK(economic_status IN ('normal','canceled','refund','reversal'))");
    if (!columnExists(db, "transaction_revisions", "administrative_state")) db.exec("ALTER TABLE transaction_revisions ADD COLUMN administrative_state TEXT NOT NULL DEFAULT 'active' CHECK(administrative_state IN ('active','deleted','purged'))");
    if (!columnExists(db, "transaction_revisions", "semantic_rule_version")) db.exec("ALTER TABLE transaction_revisions ADD COLUMN semantic_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')");
    if (!columnExists(db, "current_transactions", "projection_commit_id")) db.exec("ALTER TABLE current_transactions ADD COLUMN projection_commit_id BLOB REFERENCES canonical_commits(commit_id)");
    if (!columnExists(db, "current_transactions", "revision_commit_id")) db.exec("ALTER TABLE current_transactions ADD COLUMN revision_commit_id BLOB REFERENCES canonical_commits(commit_id)");
    db.exec("UPDATE current_transactions SET projection_commit_id = (SELECT migrated.projection_commit_id FROM current_projection_migration migrated WHERE migrated.transaction_id = current_transactions.transaction_id AND migrated.revision_id = current_transactions.revision_id), revision_commit_id = (SELECT migrated.revision_commit_id FROM current_projection_migration migrated WHERE migrated.transaction_id = current_transactions.transaction_id AND migrated.revision_id = current_transactions.revision_id)");
    db.exec("UPDATE current_transactions SET commit_id = projection_commit_id");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_scopes_scope_capture ON capture_scopes(scope_id, capture_id); CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_scopes_scope_account ON capture_scopes(scope_id, account_id)");
    db.exec(SCHEMA_V5_APPEND);
    db.exec("INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, sequence_lexeme, commit_id) SELECT source_record_id, scope_id, capture_id, account_id, provider_sequence, commit_id FROM source_record_scope_migration");
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(5, currentUtcMicros());
    db.exec("PRAGMA user_version = 5");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV5ToV6(db: DatabaseSync, injectMigrationFailure?: CanonicalMigrationFailureInjection): void {
  // commit_kind was intentionally narrow in v5. Rebuild only that table while
  // foreign keys are disabled; every existing child reference is preserved by
  // the same primary keys and the whole operation remains one transaction.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE canonical_commits_v6 (
      commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16), commit_sequence INTEGER NOT NULL UNIQUE,
      recorded_at_utc_us INTEGER NOT NULL, authority_route TEXT NOT NULL,
      commit_kind TEXT NOT NULL CHECK(commit_kind IN ('source_capture','derived_import','user_assertion'))
    )`);
    db.exec("INSERT INTO canonical_commits_v6 SELECT * FROM canonical_commits");
    db.exec("DROP TABLE canonical_commits; ALTER TABLE canonical_commits_v6 RENAME TO canonical_commits");
    db.exec(SCHEMA_V6_APPEND);
    if (injectMigrationFailure === "v5-v6-after-derived-schema") throw new Error("Injected v5-v6 migration failure after derived schema.");
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(6, currentUtcMicros());
    db.exec("PRAGMA user_version = 6");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}
function applySchemaMigration(db: DatabaseSync, options: CanonicalDatabaseOptions = {}): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
  const version = Number(row.user_version ?? 0);
  if (version > CANONICAL_SCHEMA_VERSION) throw new Error(`Canonical SQLite schema ${version} is newer than supported ${CANONICAL_SCHEMA_VERSION}.`);
  if (version === 0 && tableExists(db, "canonical_commits")) throw new Error("Unversioned canonical SQLite schema is not compatible; refusing ad-hoc migration.");
  if (version === 1) {
    migrateV1ToV2(db);
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    return;
  }
  if (version === 2) {
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    return;
  }
  if (version === 3) {
    migrateV3ToV4(db);
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    return;
  }
  if (version === 4) {
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    return;
  }
  if (version === 5) {
    migrateV5ToV6(db, options.injectMigrationFailure);
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
    db.exec(SCHEMA_V6);
    db.prepare("INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)").run(CANONICAL_SCHEMA_VERSION, currentUtcMicros());
    db.exec(`PRAGMA user_version = ${CANONICAL_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateReadOnlyDatabase(db: DatabaseSync): void {
  const requiredTables = ["capture_scopes", "capture_scope_pages", "assertion_lifecycle_events", "source_record_scopes", "current_projection_state", "derived_import_runs", "derived_scope_coordinates", "derived_assertions", "derived_assertion_provenance", "derived_assertion_lifecycle_events", "user_assertions", "user_assertion_lifecycle_events", "user_assertion_provenance", "current_transaction_fields"];
  for (const table of requiredTables) {
    if (!tableExists(db, table)) throw new Error(`Canonical schema v6 table ${table} is missing.`);
  }
  const requiredColumns: Record<string, string[]> = {
    source_captures: ["account_no", "completeness_basis", "completeness_rule_version"],
    capture_scopes: ["scope_kind", "contract_fingerprint", "preflight_fingerprint", "completeness_rule_version"],
    source_record_scopes: ["source_record_id", "scope_id", "capture_id", "account_id", "sequence_lexeme"],
    transaction_revisions: ["economic_status", "administrative_state", "semantic_rule_version"],
    current_transactions: ["projection_commit_id", "revision_commit_id"],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).map((column) => column.name));
    for (const column of columns) if (!actual.has(column)) throw new Error(`Canonical schema v6 column ${table}.${column} is missing.`);
  }
  const requiredIndexes = [
    "idx_capture_scopes_account_time", "idx_capture_scope_pages_proof", "idx_assertion_lifecycle_scope",
    "idx_source_record_scopes_scope_sequence", "idx_source_record_scopes_account_capture", "idx_current_transactions_revision",
    "idx_derived_scope_coordinates_lineage", "idx_derived_assertions_lineage", "idx_derived_assertion_provenance_run",
    "idx_derived_assertion_lifecycle_knowledge", "idx_user_assertion_lifecycle_knowledge", "idx_current_transaction_fields_projection",
    "idx_user_assertion_provenance_commit",
  ];
  for (const index of requiredIndexes) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) throw new Error(`Canonical schema v6 index ${index} is missing.`);
  }
  const tableSql = (table: string): string => String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: unknown } | undefined)?.sql ?? "");
  if (!/FOREIGN KEY\s*\(source_record_id,\s*capture_id\)/i.test(tableSql("source_record_scopes")) || !/capture_scopes/i.test(tableSql("source_record_scopes"))) {
    throw new Error("Canonical schema v6 source-record scope constraints are missing.");
  }
  if (!/economic_status.*canceled.*refund.*reversal/i.test(tableSql("transaction_revisions")) || !/administrative_state.*deleted.*purged/i.test(tableSql("transaction_revisions"))) {
    throw new Error("Canonical schema v6 semantic constraints are missing.");
  }
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
    WHERE r.transaction_id = current_row.transaction_id AND r.commit_id = current_row.revision_commit_id
      AND current_row.commit_id = current_row.projection_commit_id`).get() as { count?: number }).count ?? 0);
  if (projectionRows !== currentCount) throw new Error("Canonical current projection authority is inconsistent.");
}

export function openCanonicalDatabase(ledgerDir: string, options: CanonicalDatabaseOptions = {}): DatabaseSync {
  const path = canonicalSqlitePath(ledgerDir);
  if (options.readOnly && !existsSync(path)) throw new Error(`Missing canonical SQLite: ${path}`);
  if (!options.readOnly) mkdirSync(ledgerDir, { recursive: true });
  const db = new DatabaseSync(path, options.readOnly ? { readOnly: true } : {});
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 30000");
    if (!options.readOnly) { db.exec("PRAGMA journal_mode = WAL"); db.exec("PRAGMA synchronous = FULL"); applySchemaMigration(db, options); }
    else {
      const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
      if (Number(row.user_version ?? 0) !== CANONICAL_SCHEMA_VERSION) throw new Error("Canonical SQLite schema is missing or unsupported for read-only access.");
      validateReadOnlyDatabase(db);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export type CanonicalAmount = { coefficient: string; scale: number };
export type CanonicalAssertionSupportState = "supported" | "withdrawn";
export type CanonicalEconomicStatus = "normal" | "canceled" | "refund" | "reversal";
export type CanonicalAdministrativeState = "active" | "deleted" | "purged";
export type CanonicalTransaction = {
  id: string; accountId: string; accountNo: string; sourceSequence: string; amount: CanonicalAmount; currency: "TWD";
  direction: "inflow" | "outflow"; postingStatus: "posted"; postingOrigin: "provider_booked_history"; postingBasis: "query-status-success-with-accounting-date"; postingRuleVersion: "cathay/domestic-deposit/v1";
  assertionSupportState: CanonicalAssertionSupportState; economicStatus: CanonicalEconomicStatus; administrativeState: CanonicalAdministrativeState; semanticRuleVersion: "cathay/domestic-deposit/v1";
  displayLabel: string | null; displayLabelOrigin: "source" | "derived" | "user"; displayLabelCommitSequence: number | null; note: string | null; noteOrigin: "derived" | "user" | null; noteCommitSequence: number | null;
  effectiveOn: string; effectiveTimeBasis: "accounting"; effectiveTimeRuleVersion: "cathay/domestic-deposit/v1"; transactionDateTimeLocal: string;
  timeZone: typeof CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE; timePrecision: "second"; timeOrigin: "source_reported";
  utcInstantUtcUs: number; revisionId: string; commitSequence: number;
};
export type CathayCanonicalCurrentQueryRequest = { kind: "current" };
export type CathayCanonicalCurrentQueryResult = { status: "ok"; kind: "current"; accounts: Array<{ id: string; accountNo: string; currency: "TWD"; accountType: "depository" }>; transactions: CanonicalTransaction[]; commitSequence: number };
export type CathayCanonicalHistoricalQueryRequest = { kind: "historical"; cutoff: { kind: "both"; financialAt: string; knowledgeAt: string } };
export type CathayCanonicalHistoricalQueryResult = { status: "ok"; kind: "historical"; cutoff: CathayCanonicalHistoricalQueryRequest["cutoff"]; transactions: CanonicalTransaction[] };
export type CathayCanonicalLineageQueryRequest = { kind: "lineage"; subject: { kind: "transaction"; id: string } };
export type CathayCanonicalLifecycleEvent = {
  id: string;
  kind: "observed" | "superseded" | "withdrawn" | "restored";
  commitSequence: number;
  scopeProof: { id: string; completeness: "complete-range"; absenceAuthority: CathayAbsenceAuthority | null; contractFingerprint: string; pageCount: number } | null;
};
export type CathayCanonicalLineageEntry = {
  transaction: { id: string; accountId: string; sourceSequence: string };
  revision: CanonicalTransactionRevision;
  assertion: { id: string; revisionId: string; commitSequence: number };
  sourceRecord: { id: string; captureId: string; sequence: string; description: string | null; payload: string; scopeProof: { id: string; accountId: string; accountNo: string; stream: string; scopeStart: string; scopeEnd: string; completeness: "complete-range"; contractFingerprint: string; preflightFingerprint: string } };
  capture: { id: string; observedAt: string; scopeStart: string; scopeEnd: string; authorityRoute: string };
  provenance: Array<{ sourceRecordId: string; captureId: string }>;
  lifecycleEvents: CathayCanonicalLifecycleEvent[];
  derivedAssertions: Array<{ id: string; field: CathayDerivedField; producerId: string; origin: string; ruleLineage: string; value: string; state: "supported" | "withdrawn"; commitSequence: number; runId: string; provenance: Array<{ runId: string; coordinateId: string }> }>;
  userAssertions: Array<{ id: string; field: CathayUserAssertionField; userId: string; value: string; state: "supported" | "withdrawn"; commitSequence: number; provenance: Array<{ commitSequence: number }> }>;
};
export type CathayCanonicalLineageQueryResult = { status: "ok"; kind: "lineage"; subject: CathayCanonicalLineageQueryRequest["subject"]; entries: CathayCanonicalLineageEntry[] };
export type CanonicalTransactionRevision = CanonicalTransaction & { transactionId: string };
export interface CathayCanonicalFinancialQuery {
  current(request: CathayCanonicalCurrentQueryRequest): Promise<CathayCanonicalCurrentQueryResult>;
  historical(request: CathayCanonicalHistoricalQueryRequest): Promise<CathayCanonicalHistoricalQueryResult>;
  lineage(request: CathayCanonicalLineageQueryRequest): Promise<CathayCanonicalLineageQueryResult>;
}
export type CathayCommitTransactionResult = { transactionId: string; revisionId: string; sourceSequence: string; direction: "inflow" | "outflow"; amount: CanonicalAmount; revisionCreated: boolean };
export type CathayCanonicalCommitScopeResult = { scopeId: string; accountId: string; accountNo: string; transactions: CathayCommitTransactionResult[] };
export type CathayCanonicalCommitResult = { captureId: string; commitSequence: number; accountIds: string[]; transactions: CathayCommitTransactionResult[]; scopes: CathayCanonicalCommitScopeResult[] };

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

type LifecycleEventKind = CathayCanonicalLifecycleEvent["kind"];
function insertLifecycleEvent(
  db: DatabaseSync,
  values: { assertionId: CanonicalId; transactionId: CanonicalId; revisionId: CanonicalId; captureId: CanonicalId; scopeId: CanonicalId | null; commitId: CanonicalId; kind: LifecycleEventKind },
): void {
  db.prepare("INSERT INTO assertion_lifecycle_events(event_id, assertion_id, transaction_id, revision_id, capture_id, scope_id, commit_id, event_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(uuidV7(), values.assertionId, values.transactionId, values.revisionId, values.captureId, values.scopeId, values.commitId, values.kind);
}
function latestLifecycleEvent(db: DatabaseSync, assertionId: CanonicalId): LifecycleEventKind | null {
  const row = db.prepare(`SELECT e.event_kind FROM assertion_lifecycle_events e JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE e.assertion_id = ? ORDER BY c.commit_sequence DESC, e.event_id DESC LIMIT 1`).get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind as LifecycleEventKind | null;
}

function commitCathayDomesticDepositSyncOnce(
  ledgerDir: string,
  input: ValidatedCathaySync,
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
    db.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, ?)").run(commitId, commitSequence, recordedAtUtcUs(admissionClock()), input.authorityRoute, "source_capture");
    db.prepare("INSERT OR IGNORE INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?)").run(input.authorityRoute, CATHAY_INTEGRATION_NAMESPACE, input.stream, "v1", commitId);
    const connectionExisting = db.prepare("SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?").get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    const sourceConnectionId = connectionExisting ? blob(dbRow<{ source_connection_id: unknown }>(connectionExisting).source_connection_id) : uuidV7();
    if (!connectionExisting) db.prepare("INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?)").run(sourceConnectionId, CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId, commitId);
    const epochExisting = db.prepare("SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?").get(sourceConnectionId, input.identityEpoch);
    const identityEpochId = epochExisting ? blob(dbRow<{ identity_epoch_id: unknown }>(epochExisting).identity_epoch_id) : uuidV7();
    if (!epochExisting) db.prepare("INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?)").run(identityEpochId, sourceConnectionId, input.identityEpoch, commitId);
    const accountIds = new Map<string, CanonicalId>();
    for (const scope of input.scopes) {
      const existing = db.prepare("SELECT account_id, currency, account_type FROM financial_accounts WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND account_no = ?").get(sourceConnectionId, identityEpochId, input.stream, scope.accountNo);
      const accountId = existing ? blob(dbRow<{ account_id: unknown }>(existing).account_id) : uuidV7();
      if (existing) {
        const row = dbRow<{ currency: string; account_type: string }>(existing);
        if (row.currency !== scope.currency || row.account_type !== "depository") throw new Error("Cathay account identity has conflicting required classification.");
      } else db.prepare("INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, account_no, account_type, currency, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(accountId, sourceConnectionId, identityEpochId, input.stream, scope.accountNo, "depository", scope.currency, commitId);
      accountIds.set(scope.accountNo, accountId);
    }
    const captureId = uuidV7();
    const captureStart = [...input.scopes].map((scope) => scope.startDate).sort()[0]!;
    const captureEnd = [...input.scopes].map((scope) => scope.endDate).sort().at(-1)!;
    db.prepare("INSERT INTO source_captures(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(captureId, sourceConnectionId, identityEpochId, input.authorityRoute, input.stream, input.scopes.length === 1 ? input.scopes[0]!.accountNo : null, input.observedAt, captureStart, captureEnd, CATHAY_COMPLETENESS_PROOF.kind, CATHAY_COMPLETENESS_PROOF.basis, CATHAY_COMPLETENESS_PROOF.ruleVersion, commitId);
    const allTransactions: CathayCommitTransactionResult[] = [];
    const scopeResults: CathayCanonicalCommitScopeResult[] = [];
    for (const scope of input.scopes) {
      const accountId = accountIds.get(scope.accountNo)!;
      const scopeId = uuidV7();
      db.prepare("INSERT INTO capture_scopes(scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, account_no, stream, scope_start, scope_end, scope_kind, completeness, completeness_basis, completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(scopeId, captureId, sourceConnectionId, identityEpochId, accountId, scope.accountNo, input.stream, scope.startDate, scope.endDate, "bounded-range", CATHAY_COMPLETENESS_PROOF.kind, CATHAY_COMPLETENESS_PROOF.basis, CATHAY_COMPLETENESS_PROOF.ruleVersion, scope.absenceAuthority ?? null, scope.contractFingerprint, scope.preflightFingerprint, scope.pages.length, 1, commitId);
      for (const page of scope.pages) db.prepare("INSERT INTO capture_scope_pages(scope_page_id, scope_id, page_ordinal, terminal, row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(uuidV7(), scopeId, page.pageOrdinal, page.terminal ? 1 : 0, page.rowCount, page.responseDigest, CATHAY_COMPLETENESS_PROOF.basis, scope.contractFingerprint, scope.preflightFingerprint, commitId);
      const seenSequences = new Set(scope.rows.map((row) => row.sequence));
      const scopeTransactions: CathayCommitTransactionResult[] = [];
      for (const detail of scope.rows) {
        const sourceRecordId = uuidV7();
        db.prepare("INSERT INTO source_records(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(sourceRecordId, captureId, commitId, detail.sequence, detail.description, detail.payload);
        db.prepare("INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, sequence_lexeme, commit_id) VALUES (?, ?, ?, ?, ?, ?)").run(sourceRecordId, scopeId, captureId, accountId, detail.sequence, commitId);
        const existingTransaction = db.prepare("SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?").get(accountId, detail.sequence);
        const transactionId = existingTransaction ? blob(dbRow<{ transaction_id: unknown }>(existingTransaction).transaction_id) : uuidV7();
        if (!existingTransaction) db.prepare("INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)").run(transactionId, accountId, detail.sequence, commitId);
        const latest = db.prepare("SELECT * FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1").get(transactionId);
        const latestRow = latest ? dbRow<Record<string, unknown>>(latest) : undefined;
        const revisionCreated = !latestRow || !sameRevision(latestRow, detail);
        let revisionId = latestRow ? blob(latestRow.revision_id) : uuidV7();
        let assertionId: CanonicalId;
        if (revisionCreated) {
          if (latestRow) {
            const oldAssertion = db.prepare("SELECT assertion_id FROM source_assertions WHERE revision_id = ?").get(blob(latestRow.revision_id));
            if (oldAssertion) insertLifecycleEvent(db, { assertionId: blob(dbRow<{ assertion_id: unknown }>(oldAssertion).assertion_id), transactionId, revisionId: blob(latestRow.revision_id), captureId, scopeId, commitId, kind: "superseded" });
          }
          revisionId = uuidV7();
          const revisionNumber = latestRow ? Number(latestRow.revision_number) + 1 : 1;
          db.prepare(`INSERT INTO transaction_revisions(
          revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency,
            direction, posting_status, posting_origin, posting_basis, posting_rule_version, description, economic_status, administrative_state, semantic_rule_version, effective_on, transaction_date_time_local,
            time_zone, time_precision, time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            revisionId, transactionId, sourceRecordId, captureId, commitId, revisionNumber, detail.amount.coefficient.toString(), detail.amount.scale,
            scope.currency, detail.direction, CATHAY_POSTING_MAPPING.postingStatus, CATHAY_POSTING_MAPPING.origin, CATHAY_POSTING_MAPPING.basis, CATHAY_POSTING_MAPPING.ruleVersion,
            detail.description, "normal", "active", CATHAY_POSTING_MAPPING.ruleVersion, detail.accountDate, detail.transactionDateTime, CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "second", "source_reported", "accounting", CATHAY_POSTING_MAPPING.ruleVersion, detail.utcInstantUtcUs,
          );
          const observation = db.prepare("INSERT INTO transaction_time_observations(observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
          observation.run(uuidV7(), transactionId, revisionId, sourceRecordId, commitId, "accounting", detail.accountDate, CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "date", "source_reported", detail.accountingUtcInstantUtcUs);
          observation.run(uuidV7(), transactionId, revisionId, sourceRecordId, commitId, "occurred", detail.transactionDateTime, CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, "second", "source_reported", detail.utcInstantUtcUs);
          assertionId = uuidV7();
          db.prepare("INSERT INTO source_assertions(assertion_id, transaction_id, revision_id, source_record_id, commit_id) VALUES (?, ?, ?, ?, ?)").run(assertionId, transactionId, revisionId, sourceRecordId, commitId);
          insertLifecycleEvent(db, { assertionId, transactionId, revisionId, captureId, scopeId, commitId, kind: "observed" });
          db.prepare("INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET revision_id = excluded.revision_id, commit_id = excluded.commit_id, projection_commit_id = excluded.projection_commit_id, revision_commit_id = excluded.revision_commit_id").run(transactionId, revisionId, commitId, commitId, commitId);
        } else {
          const assertion = db.prepare("SELECT assertion_id FROM source_assertions WHERE transaction_id = ? AND revision_id = ?").get(transactionId, revisionId);
          if (!assertion) throw new Error("Canonical assertion was not created.");
          assertionId = blob(dbRow<{ assertion_id: unknown }>(assertion).assertion_id);
          const wasWithdrawn = latestLifecycleEvent(db, assertionId) === "withdrawn";
          insertLifecycleEvent(db, { assertionId, transactionId, revisionId, captureId, scopeId, commitId, kind: wasWithdrawn ? "restored" : "observed" });
          if (wasWithdrawn) {
            const revisionCommit = blob(dbRow<{ commit_id: unknown }>(db.prepare("SELECT commit_id FROM transaction_revisions WHERE revision_id = ?").get(revisionId)).commit_id);
            db.prepare("INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET revision_id = excluded.revision_id, commit_id = excluded.commit_id, projection_commit_id = excluded.projection_commit_id, revision_commit_id = excluded.revision_commit_id").run(transactionId, revisionId, commitId, commitId, revisionCommit);
          }
        }
        db.prepare("INSERT INTO assertion_provenance(assertion_id, source_record_id, commit_id) VALUES (?, ?, ?)").run(assertionId, sourceRecordId, commitId);
        const result = { transactionId: idToString(transactionId), revisionId: idToString(revisionId), sourceSequence: detail.sequence, direction: detail.direction, amount: { coefficient: detail.amount.coefficient.toString(), scale: detail.amount.scale }, revisionCreated } satisfies CathayCommitTransactionResult;
        scopeTransactions.push(result);
        allTransactions.push(result);
      }
      if (scope.absenceAuthority) {
        const prior = db.prepare(`SELECT sa.assertion_id, sa.transaction_id, sa.revision_id, t.source_sequence FROM source_assertions sa
          JOIN financial_transactions t ON t.transaction_id = sa.transaction_id JOIN transaction_revisions r ON r.revision_id = sa.revision_id
          JOIN current_transactions current_row ON current_row.transaction_id = t.transaction_id AND current_row.revision_id = r.revision_id
          JOIN assertion_provenance provenance ON provenance.assertion_id = sa.assertion_id
          JOIN source_records prior_record ON prior_record.source_record_id = provenance.source_record_id
          JOIN source_record_scopes prior_record_scope ON prior_record_scope.source_record_id = prior_record.source_record_id
          JOIN capture_scopes prior_scope ON prior_scope.scope_id = prior_record_scope.scope_id
          JOIN source_captures prior_capture ON prior_capture.capture_id = prior_scope.capture_id
          WHERE t.account_id = ? AND r.effective_on BETWEEN ? AND ?
            AND prior_scope.source_connection_id = ? AND prior_scope.identity_epoch_id = ? AND prior_scope.account_id = ?
            AND prior_scope.stream = ? AND prior_scope.scope_kind = 'bounded-range'
            AND prior_scope.completeness = 'complete-range' AND prior_scope.completeness_rule_version = ?
            AND prior_scope.contract_fingerprint = ? AND prior_scope.preflight_fingerprint = ?
            AND prior_capture.authority_route = ? AND prior_capture.stream = ?`).all(
          accountId, scope.startDate, scope.endDate, sourceConnectionId, identityEpochId, accountId, input.stream,
          CATHAY_COMPLETENESS_PROOF.ruleVersion, scope.contractFingerprint, scope.preflightFingerprint, input.authorityRoute, input.stream,
        ) as Array<Record<string, unknown>>;
        for (const row of prior) {
          if (seenSequences.has(String(row.source_sequence))) continue;
          const assertionId = blob(row.assertion_id);
          if (latestLifecycleEvent(db, assertionId) === "withdrawn") continue;
          insertLifecycleEvent(db, { assertionId, transactionId: blob(row.transaction_id), revisionId: blob(row.revision_id), captureId, scopeId, commitId, kind: "withdrawn" });
          db.prepare("DELETE FROM current_transactions WHERE transaction_id = ? AND revision_id = ?").run(blob(row.transaction_id), blob(row.revision_id));
        }
      }
      db.prepare(`INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET scope_start = excluded.scope_start,
        scope_end = excluded.scope_end, cursor = excluded.cursor, last_capture_id = excluded.last_capture_id, commit_id = excluded.commit_id`).run(sourceConnectionId, accountId, input.stream, scope.startDate, scope.endDate, input.syncState.cursor ?? null, captureId, commitId);
      scopeResults.push({ scopeId: idToString(scopeId), accountId: idToString(accountId), accountNo: scope.accountNo, transactions: scopeTransactions });
    }
    db.prepare("INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id").run(commitId);
    db.exec("COMMIT");
    inTransaction = false;
    return { captureId: idToString(captureId), commitSequence, accountIds: [...accountIds.values()].map(idToString), transactions: allTransactions, scopes: scopeResults };
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
  const sync = validateSyncInput({
    sourceConnectionId: input.sourceConnectionId,
    identityEpoch: input.identityEpoch,
    authorityRoute: input.authorityRoute,
    stream: input.stream,
    syncState: input.syncState,
    observedAt: input.observedAt,
    pages: [{
      accountNo: validated.accountNo,
      currency: input.currency as "TWD",
      scope: { startDate: validated.startDate, endDate: validated.endDate },
      pageOrdinal: 0,
      requestPageToken: null,
      nextPageToken: null,
      rawResponse: input.rawResponse,
      contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      preflightFingerprint: "cathay/domestic-deposit/v1",
      absenceAuthority: input.absenceAuthority,
    }],
  });
  return withCanonicalWriter(ledgerDir, () => commitCathayDomesticDepositSyncOnce(ledgerDir, sync, admissionClock));
}

export function commitCathayDomesticDepositSync(
  ledgerDir: string,
  input: CathayDomesticDepositSyncInput,
  options: CathayCanonicalCommitOptions = {},
): Promise<CathayCanonicalCommitResult> {
  const validated = validateSyncInput(input);
  const admissionClock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(ledgerDir, () => commitCathayDomesticDepositSyncOnce(ledgerDir, validated, admissionClock));
}

function importCoordinates(input: CathayDerivedImportRunInput): CathayDerivedImportCoordinate[] {
  if (input.complete === false) throw new Error("Derived import is partial; no canonical mutation was admitted.");
  const structuredScope = [input.scope, input.outputScope].find((candidate): candidate is CathayDerivedImportScope => candidate !== undefined && !Array.isArray(candidate));
  if (structuredScope) {
    if (!Array.isArray(structuredScope.subjects) || !Array.isArray(structuredScope.fields) || structuredScope.subjects.length === 0 || structuredScope.fields.length === 0) throw new Error("A structured derived import scope requires subjects and fields.");
    const expected = new Set<string>();
    for (const subject of structuredScope.subjects) {
      const transactionId = typeof subject === "string" ? subject : subject.kind === "transaction" ? subject.id : "";
      if (!transactionId) throw new Error("Derived import scope contains a non-transaction subject.");
      for (const field of structuredScope.fields) expected.add(`${transactionId}:${field}`);
    }
    const outputCandidates = [input.coordinates, input.outputs, input.scope, input.outputScope].filter((candidate): candidate is CathayDerivedImportCoordinate[] => Array.isArray(candidate));
    const outputs = outputCandidates[0];
    if (!outputs) throw new Error("A structured derived import scope requires output coordinates.");
    const actual = new Set(outputs.map((coordinate) => `${coordinate.transactionId}:${coordinate.field}`));
    if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) throw new Error("Derived import output does not cover the complete declared scope.");
    return normalizeDerivedCoordinates(outputs);
  }
  const candidates = [input.coordinates, input.outputs, input.scope, input.outputScope].filter((candidate): candidate is CathayDerivedImportCoordinate[] => Array.isArray(candidate));
  if (candidates.length === 0) throw new Error("A complete derived import requires an explicit coordinate matrix.");
  const first = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (JSON.stringify(candidate) !== JSON.stringify(first)) throw new Error("Derived import coordinate matrices disagree.");
  }
  return normalizeDerivedCoordinates(first);
}

function normalizeDerivedCoordinates(first: CathayDerivedImportCoordinate[]): CathayDerivedImportCoordinate[] {
  const normalized = first.map((coordinate) => {
    if (!coordinate || typeof coordinate !== "object") throw new Error("Derived import coordinate must be an object.");
    if (!coordinate.transactionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coordinate.transactionId)) throw new Error("Derived import coordinate has an invalid transaction subject.");
    const normalizedField = coordinate.field === ("displayName" as CathayDerivedField) || coordinate.field === ("displayLabel" as CathayDerivedField) ? "display_name" : coordinate.field;
    if (normalizedField !== "display_name" && normalizedField !== "note") throw new Error("Derived import field is not supported.");
    if (coordinate.state !== "supported" && coordinate.state !== "unsupported") throw new Error("Derived import coordinate has an invalid output state.");
    if (coordinate.state === "supported" && typeof coordinate.value !== "string") throw new Error("Supported derived output must provide a typed string value.");
    if (coordinate.state === "unsupported" && coordinate.value !== undefined && coordinate.value !== null) throw new Error("Unsupported derived output cannot carry a value.");
    return { transactionId: coordinate.transactionId, field: normalizedField, state: coordinate.state, value: coordinate.state === "supported" ? coordinate.value! : null };
  });
  const seen = new Set<string>();
  for (const coordinate of normalized) {
    const key = `${coordinate.transactionId}:${coordinate.field}`;
    if (seen.has(key)) throw new Error("Derived import coordinate matrix contains a duplicate subject/field.");
    seen.add(key);
  }
  return normalized;
}

function validateDerivedImportInput(input: CathayDerivedImportRunInput): CathayDerivedImportCoordinate[] {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim()) throw new Error("Derived import Source Connection and Identity Epoch are required.");
  if (input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY || input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM) throw new Error("Derived import authority route or stream is not supported.");
  if (!input.producerId.trim() || !input.ruleLineage.trim()) throw new Error("Derived import producer and rule lineage are required.");
  if (input.origin !== undefined && !input.origin.trim()) throw new Error("Derived import origin is required when supplied.");
  if (input.observedAt !== undefined) parseRfc3339UtcMicros(input.observedAt, "Derived import observedAt");
  return importCoordinates(input);
}

function derivedDiagnostic(error: unknown, input: CathayDerivedImportRunInput, stage: CathayDerivedImportDiagnostic["stage"]): CathayDerivedImportDiagnostic {
  return { kind: "derived-import-diagnostic", stage, reason: error instanceof Error ? error.message : String(error), producerId: input.producerId, ruleLineage: input.ruleLineage };
}

function insertDerivedLifecycleEvent(db: DatabaseSync, values: { assertionId: CanonicalId; transactionId: CanonicalId; field: CathayDerivedField; runId: CanonicalId; coordinateId: CanonicalId | null; commitId: CanonicalId; kind: "observed" | "superseded" | "withdrawn" | "restored" | "provenance_only" }): void {
  db.prepare("INSERT INTO derived_assertion_lifecycle_events(event_id, assertion_id, transaction_id, field_name, run_id, coordinate_id, commit_id, event_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(uuidV7(), values.assertionId, values.transactionId, values.field, values.runId, values.coordinateId, values.commitId, values.kind);
}

function latestDerivedLifecycle(db: DatabaseSync, assertionId: CanonicalId): string | null {
  const row = db.prepare(`SELECT event_kind FROM derived_assertion_lifecycle_events e JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE assertion_id = ? ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`).get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind ?? null;
}

function latestUserLifecycle(db: DatabaseSync, assertionId: CanonicalId): string | null {
  const row = db.prepare(`SELECT event_kind FROM user_assertion_lifecycle_events e JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE assertion_id = ? ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`).get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind ?? null;
}

function insertCurrentDerivedField(db: DatabaseSync, transactionId: CanonicalId, field: CathayDerivedField, assertionId: CanonicalId, value: string, commitId: CanonicalId): void {
  const user = db.prepare("SELECT 1 FROM current_transaction_fields WHERE transaction_id = ? AND field_name = ? AND origin = 'user'").get(transactionId, field);
  if (user) return;
  db.prepare(`INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
    VALUES (?, ?, ?, 'derived', ?, NULL, ?) ON CONFLICT(transaction_id, field_name) DO UPDATE SET value_text = excluded.value_text, origin = 'derived', derived_assertion_id = excluded.derived_assertion_id, user_assertion_id = NULL, projection_commit_id = excluded.projection_commit_id`).run(transactionId, field, value, assertionId, commitId);
}

function refreshCurrentFieldAfterWithdrawal(db: DatabaseSync, transactionId: CanonicalId, field: CathayDerivedField, commitId: CanonicalId): void {
  const user = db.prepare(`SELECT ua.assertion_id, ua.value_text FROM user_assertions ua
    JOIN user_assertion_lifecycle_events e ON e.assertion_id = ua.assertion_id
    WHERE ua.transaction_id = ? AND ua.field_name = ?
    AND e.event_kind NOT IN ('withdrawn','superseded')
    AND NOT EXISTS (SELECT 1 FROM user_assertion_lifecycle_events newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
      WHERE newer.assertion_id = e.assertion_id AND (nc.commit_sequence > (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id)
        OR (nc.commit_sequence = (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) AND newer.rowid > e.rowid)))
    ORDER BY (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) DESC, e.rowid DESC LIMIT 1`).get(transactionId, field) as Record<string, unknown> | undefined;
  if (user) {
    db.prepare(`INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
      VALUES (?, ?, ?, 'user', NULL, ?, ?) ON CONFLICT(transaction_id, field_name) DO UPDATE SET value_text = excluded.value_text, origin = 'user', derived_assertion_id = NULL, user_assertion_id = excluded.user_assertion_id, projection_commit_id = excluded.projection_commit_id`).run(transactionId, field, String(user.value_text), blob(user.assertion_id), commitId);
    return;
  }
  const derived = db.prepare(`SELECT da.assertion_id, da.value_text FROM derived_assertions da
    JOIN derived_assertion_lifecycle_events e ON e.assertion_id = da.assertion_id
    WHERE da.transaction_id = ? AND da.field_name = ? AND e.event_kind NOT IN ('withdrawn','superseded')
    AND NOT EXISTS (SELECT 1 FROM derived_assertion_lifecycle_events newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
      WHERE newer.assertion_id = e.assertion_id AND (nc.commit_sequence > (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id)
        OR (nc.commit_sequence = (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) AND newer.rowid > e.rowid)))
    ORDER BY (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) DESC, e.rowid DESC LIMIT 1`).get(transactionId, field) as Record<string, unknown> | undefined;
  if (derived) insertCurrentDerivedField(db, transactionId, field, blob(derived.assertion_id), String(derived.value_text), commitId);
  else db.prepare("DELETE FROM current_transaction_fields WHERE transaction_id = ? AND field_name = ?").run(transactionId, field);
}

function commitCathayDerivedImportRunOnce(ledgerDir: string, input: CathayDerivedImportRunInput, coordinates: CathayDerivedImportCoordinate[], clock: CanonicalAdmissionClock): { runId: string; commitSequence: number; assertionIds: string[] } {
  const db = openCanonicalDatabase(ledgerDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const connection = db.prepare("SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?").get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    if (!connection) throw new Error("Derived import source connection is unknown; source lineage must already exist.");
    const sourceConnectionId = blob(dbRow<{ source_connection_id: unknown }>(connection).source_connection_id);
    const epoch = db.prepare("SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?").get(sourceConnectionId, input.identityEpoch);
    if (!epoch) throw new Error("Derived import identity epoch is unknown; source lineage must already exist.");
    const identityEpochId = blob(dbRow<{ identity_epoch_id: unknown }>(epoch).identity_epoch_id);
    const commitId = uuidV7();
    const commitSequence = Number((db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits").get() as { max_sequence?: number }).max_sequence ?? 0) + 1;
    db.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'derived_import')").run(commitId, commitSequence, recordedAtUtcUs(clock()), input.authorityRoute);
    const runId = uuidV7();
    const origin = input.origin?.trim() || input.authorityRoute;
    db.prepare("INSERT INTO derived_import_runs(run_id, source_connection_id, identity_epoch_id, authority_route, stream, producer_id, origin, rule_lineage, observed_at, commit_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')").run(runId, sourceConnectionId, identityEpochId, input.authorityRoute, input.stream, input.producerId, origin, input.ruleLineage, input.observedAt ?? clock(), commitId);
    const assertionIds: string[] = [];
    for (const coordinate of coordinates) {
      const transactionId = idFromString(coordinate.transactionId);
      const transaction = db.prepare(`SELECT t.account_id, a.source_connection_id, a.identity_epoch_id, a.stream FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id WHERE t.transaction_id = ?`).get(transactionId) as Record<string, unknown> | undefined;
      if (!transaction) throw new Error("Derived import targets an unknown transaction subject.");
      if (Buffer.compare(blob(transaction.source_connection_id), sourceConnectionId) !== 0 || Buffer.compare(blob(transaction.identity_epoch_id), identityEpochId) !== 0 || transaction.stream !== input.stream) throw new Error("Derived import crossed a source identity or stream boundary.");
      const coordinateId = uuidV7();
      db.prepare("INSERT INTO derived_scope_coordinates(coordinate_id, run_id, transaction_id, field_name, producer_id, origin, rule_lineage, output_state, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(coordinateId, runId, transactionId, coordinate.field, input.producerId, origin, input.ruleLineage, coordinate.state, commitId);
      const existingCurrent = db.prepare(`SELECT f.origin, f.derived_assertion_id, f.user_assertion_id FROM current_transaction_fields f WHERE f.transaction_id = ? AND f.field_name = ?`).get(transactionId, coordinate.field) as Record<string, unknown> | undefined;
      const conflicting = db.prepare(`SELECT da.assertion_id, da.producer_id, da.origin, da.rule_lineage FROM derived_assertions da
        JOIN derived_assertion_lifecycle_events e ON e.assertion_id = da.assertion_id
        JOIN canonical_commits c ON c.commit_id = e.commit_id
        WHERE da.transaction_id = ? AND da.field_name = ? AND (da.producer_id <> ? OR da.origin <> ? OR da.rule_lineage <> ?)
        AND e.event_kind NOT IN ('withdrawn','superseded')
        AND NOT EXISTS (SELECT 1 FROM derived_assertion_lifecycle_events newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
          WHERE newer.assertion_id = e.assertion_id AND (nc.commit_sequence > c.commit_sequence OR (nc.commit_sequence = c.commit_sequence AND newer.rowid > e.rowid)))
        LIMIT 1`).get(transactionId, coordinate.field, input.producerId, origin, input.ruleLineage) as Record<string, unknown> | undefined;
      if (conflicting) throw new Error("A different derived producer or origin cannot supersede the current lineage.");
      const latest = db.prepare(`SELECT da.* FROM derived_assertions da JOIN canonical_commits c ON c.commit_id = da.commit_id
        WHERE da.transaction_id = ? AND da.field_name = ? AND da.producer_id = ? AND da.origin = ? AND da.rule_lineage = ?
        ORDER BY c.commit_sequence DESC, da.assertion_id DESC LIMIT 1`).get(transactionId, coordinate.field, input.producerId, origin, input.ruleLineage) as Record<string, unknown> | undefined;
      if (coordinate.state === "unsupported") {
        if (latest && latestDerivedLifecycle(db, blob(latest.assertion_id)) !== "withdrawn") {
          const withdrawnAssertion = blob(latest.assertion_id);
          insertDerivedLifecycleEvent(db, { assertionId: withdrawnAssertion, transactionId, field: coordinate.field, runId, coordinateId, commitId, kind: "withdrawn" });
          if (existingCurrent?.origin === "derived" && existingCurrent.derived_assertion_id && Buffer.compare(blob(existingCurrent.derived_assertion_id), withdrawnAssertion) === 0) refreshCurrentFieldAfterWithdrawal(db, transactionId, coordinate.field, commitId);
        }
        continue;
      }
      const value = coordinate.value!;
      let assertionId: CanonicalId;
      let eventKind: "observed" | "superseded" | "restored" | "provenance_only" = "observed";
      if (latest && String(latest.value_text) === value) {
        assertionId = blob(latest.assertion_id);
        eventKind = latestDerivedLifecycle(db, assertionId) === "withdrawn" ? "restored" : "provenance_only";
      } else {
        assertionId = uuidV7();
        if (latest) insertDerivedLifecycleEvent(db, { assertionId: blob(latest.assertion_id), transactionId, field: coordinate.field, runId, coordinateId, commitId, kind: "superseded" });
        db.prepare("INSERT INTO derived_assertions(assertion_id, transaction_id, field_name, producer_id, origin, rule_lineage, value_text, run_id, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(assertionId, transactionId, coordinate.field, input.producerId, origin, input.ruleLineage, value, runId, commitId);
      }
      db.prepare("INSERT INTO derived_assertion_provenance(assertion_id, run_id, coordinate_id, commit_id) VALUES (?, ?, ?, ?)").run(assertionId, runId, coordinateId, commitId);
      insertDerivedLifecycleEvent(db, { assertionId, transactionId, field: coordinate.field, runId, coordinateId, commitId, kind: eventKind });
      assertionIds.push(idToString(assertionId));
      if (existingCurrent?.origin !== "user") insertCurrentDerivedField(db, transactionId, coordinate.field, assertionId, value, commitId);
    }
    db.prepare("INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id").run(commitId);
    db.exec("COMMIT");
    inTransaction = false;
    return { runId: idToString(runId), commitSequence, assertionIds };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

export function commitCathayDerivedImportRun(ledgerDir: string, input: CathayDerivedImportRunInput, options: CathayDerivedImportOptions = {}): Promise<CathayDerivedImportResult & { status: "committed" }> {
  const coordinates = validateDerivedImportInput(input);
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(ledgerDir, () => ({ status: "committed", ...commitCathayDerivedImportRunOnce(ledgerDir, input, coordinates, clock) }));
}

export const commitCathayImportRun = commitCathayDerivedImportRun;
export const commitDerivedImportRun = commitCathayDerivedImportRun;
export const commitCathayDerivedImport = commitCathayDerivedImportRun;

export async function runCathayDerivedImportRun(ledgerDir: string, input: CathayDerivedImportRunInput, options: CathayDerivedImportOptions = {}): Promise<CathayDerivedImportResult> {
  let coordinates: CathayDerivedImportCoordinate[];
  try { coordinates = validateDerivedImportInput(input); }
  catch (error) {
    const diagnostic = derivedDiagnostic(error, input, "preflight");
    options.onDiagnostic?.(diagnostic);
    return { status: "diagnostic", diagnostic };
  }
  try { return { status: "committed", ...await withCanonicalWriter(ledgerDir, () => commitCathayDerivedImportRunOnce(ledgerDir, input, coordinates, options.clock ?? (() => new Date().toISOString()))) }; }
  catch (error) {
    const diagnostic = derivedDiagnostic(error, input, "commit");
    options.onDiagnostic?.(diagnostic);
    return { status: "diagnostic", diagnostic };
  }
}

export async function commitCathayUserAssertion(ledgerDir: string, input: CathayUserAssertionInput, options: CathayCanonicalCommitOptions = {}): Promise<CathayUserAssertionResult> {
  if (typeof input.target === "object" && input.target !== null && input.target.kind !== undefined && input.target.kind !== "transaction") throw new Error("User Assertions support transaction targets only.");
  const rawField = typeof input.field === "string" ? input.field : typeof input.target === "object" ? input.target.field : undefined;
  const field = rawField === "displayName" || rawField === "displayLabel" ? "display_name" : rawField;
  if (field !== "display_name" && field !== "note") throw new Error("User Assertions may target only display_name or note.");
  const transactionIdText = input.transactionId ?? input.subject?.id ?? (typeof input.target === "object" ? input.target.id : undefined);
  if (!transactionIdText) throw new Error("User Assertion requires a transaction subject.");
  if (input.subject && input.subject.kind !== "transaction") throw new Error("User Assertions support transaction subjects only.");
  const transactionId = idFromString(transactionIdText);
  if (input.value !== undefined && input.value !== null && typeof input.value !== "string") throw new Error("User Assertion value must be a string or null.");
  const userId = input.userId?.trim() || "local-user";
  if (!userId) throw new Error("User Assertion user identity is required.");
  if (input.observedAt) parseRfc3339UtcMicros(input.observedAt, "User Assertion observedAt");
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(ledgerDir, () => {
    const db = openCanonicalDatabase(ledgerDir);
    let inTransaction = false;
    try {
      db.exec("BEGIN IMMEDIATE"); inTransaction = true;
      if (!db.prepare("SELECT 1 FROM financial_transactions WHERE transaction_id = ?").get(transactionId)) throw new Error("User Assertion targets an unknown transaction.");
      const commitId = uuidV7();
      const commitSequence = Number((db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits").get() as { max_sequence?: number }).max_sequence ?? 0) + 1;
      db.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'user_assertion')").run(commitId, commitSequence, recordedAtUtcUs(clock()), "user/local");
      const prior = db.prepare(`SELECT ua.* FROM user_assertions ua JOIN canonical_commits c ON c.commit_id = ua.commit_id
        WHERE ua.transaction_id = ? AND ua.field_name = ? AND ua.user_id = ? ORDER BY c.commit_sequence DESC, ua.assertion_id DESC LIMIT 1`).get(transactionId, field, userId) as Record<string, unknown> | undefined;
      let assertionId: CanonicalId;
      const withdrawn = input.value === null;
      if (withdrawn) {
        if (!prior) throw new Error("Cannot withdraw a user assertion that does not exist.");
        assertionId = blob(prior.assertion_id);
        db.prepare("INSERT INTO user_assertion_lifecycle_events(event_id, assertion_id, transaction_id, field_name, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, ?, ?, 'withdrawn')").run(uuidV7(), assertionId, transactionId, field, userId, commitId);
      } else {
        const value = input.value ?? "";
        if (prior && String(prior.value_text) === value && latestUserLifecycle(db, blob(prior.assertion_id)) !== "withdrawn") {
          assertionId = blob(prior.assertion_id);
          db.prepare("INSERT INTO user_assertion_lifecycle_events(event_id, assertion_id, transaction_id, field_name, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, ?, ?, 'provenance_only')").run(uuidV7(), assertionId, transactionId, field, userId, commitId);
        } else {
          assertionId = uuidV7();
          if (prior) db.prepare("INSERT INTO user_assertion_lifecycle_events(event_id, assertion_id, transaction_id, field_name, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, ?, ?, 'superseded')").run(uuidV7(), blob(prior.assertion_id), transactionId, field, userId, commitId);
          db.prepare("INSERT INTO user_assertions(assertion_id, transaction_id, field_name, user_id, value_text, commit_id) VALUES (?, ?, ?, ?, ?, ?)").run(assertionId, transactionId, field, userId, value, commitId);
          db.prepare("INSERT INTO user_assertion_lifecycle_events(event_id, assertion_id, transaction_id, field_name, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, ?, ?, 'observed')").run(uuidV7(), assertionId, transactionId, field, userId, commitId);
        }
      }
      if (withdrawn) {
        db.prepare("DELETE FROM current_transaction_fields WHERE transaction_id = ? AND field_name = ? AND origin = 'user' AND user_assertion_id = ?").run(transactionId, field, assertionId);
        refreshCurrentFieldAfterWithdrawal(db, transactionId, field, commitId);
      }
      else db.prepare(`INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
        VALUES (?, ?, ?, 'user', NULL, ?, ?) ON CONFLICT(transaction_id, field_name) DO UPDATE SET value_text = excluded.value_text, origin = 'user', derived_assertion_id = NULL, user_assertion_id = excluded.user_assertion_id, projection_commit_id = excluded.projection_commit_id`).run(transactionId, field, input.value ?? "", assertionId, commitId);
      db.prepare("INSERT OR IGNORE INTO user_assertion_provenance(assertion_id, commit_id) VALUES (?, ?)").run(assertionId, commitId);
      db.prepare("INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id").run(commitId);
      db.exec("COMMIT"); inTransaction = false;
      return { status: "committed", assertionId: idToString(assertionId), commitSequence, field, withdrawn };
    } catch (error) { if (inTransaction) db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  });
}

export const setCathayUserAssertion = commitCathayUserAssertion;
export const commitCathayUserTransactionAssertion = commitCathayUserAssertion;
export const commitCathayUserAssertionAction = commitCathayUserAssertion;

function amountFromRow(row: Record<string, unknown>, prefix = ""): CanonicalAmount { return { coefficient: String(row[`${prefix}amount_coefficient`]), scale: Number(row[`${prefix}amount_scale`]) }; }
function transactionFromRow(row: Record<string, unknown>): CanonicalTransaction {
  const selectedDisplay = typeof row.selected_display_label === "string" ? row.selected_display_label : typeof row.description === "string" ? row.description : null;
  const selectedDisplayOrigin = row.selected_display_origin === "user" || row.selected_display_origin === "derived" ? row.selected_display_origin : "source";
  const selectedDisplayCommitSequence = typeof row.selected_display_commit_sequence === "number" ? row.selected_display_commit_sequence : row.selected_display_commit_sequence !== undefined && row.selected_display_commit_sequence !== null ? Number(row.selected_display_commit_sequence) : null;
  const selectedNote = typeof row.selected_note === "string" ? row.selected_note : null;
  const selectedNoteOrigin = row.selected_note_origin === "user" || row.selected_note_origin === "derived" ? row.selected_note_origin : null;
  const selectedNoteCommitSequence = typeof row.selected_note_commit_sequence === "number" ? row.selected_note_commit_sequence : row.selected_note_commit_sequence !== undefined && row.selected_note_commit_sequence !== null ? Number(row.selected_note_commit_sequence) : null;
  return {
    id: idToString(row.transaction_id), accountId: idToString(row.account_id), accountNo: String(row.account_no), sourceSequence: String(row.source_sequence),
    amount: amountFromRow(row), currency: "TWD", direction: row.direction as "inflow" | "outflow", postingStatus: row.posting_status as "posted",
    postingOrigin: row.posting_origin as "provider_booked_history", postingBasis: row.posting_basis as "query-status-success-with-accounting-date", postingRuleVersion: row.posting_rule_version as "cathay/domestic-deposit/v1",
    assertionSupportState: row.assertion_support_state === "withdrawn" ? "withdrawn" : "supported", economicStatus: row.economic_status as CanonicalEconomicStatus, administrativeState: row.administrative_state as CanonicalAdministrativeState, semanticRuleVersion: row.semantic_rule_version as "cathay/domestic-deposit/v1",
    displayLabel: selectedDisplay, displayLabelOrigin: selectedDisplayOrigin, displayLabelCommitSequence: selectedDisplayCommitSequence, note: selectedNote, noteOrigin: selectedNoteOrigin, noteCommitSequence: selectedNoteCommitSequence, effectiveOn: String(row.effective_on), effectiveTimeBasis: row.effective_time_basis as "accounting", effectiveTimeRuleVersion: row.effective_time_rule_version as "cathay/domestic-deposit/v1",
    transactionDateTimeLocal: String(row.transaction_date_time_local), timeZone: CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE, timePrecision: "second", timeOrigin: "source_reported",
    utcInstantUtcUs: Number(row.utc_instant_utc_us), revisionId: idToString(row.revision_id), commitSequence: Number(row.commit_sequence),
  };
}
function transactionRevisionFromRow(row: Record<string, unknown>): CanonicalTransactionRevision {
  const transaction = transactionFromRow(row);
  return { ...transaction, id: idToString(row.revision_id), transactionId: transaction.id };
}

function selectedCurrentField(db: DatabaseSync, transactionId: unknown, field: CathayDerivedField): { value: string; origin: "derived" | "user"; commitSequence: number } | undefined {
  const row = db.prepare("SELECT f.value_text, f.origin, c.commit_sequence FROM current_transaction_fields f JOIN canonical_commits c ON c.commit_id = f.projection_commit_id WHERE f.transaction_id = ? AND f.field_name = ?").get(transactionId as CanonicalId, field) as { value_text?: unknown; origin?: string; commit_sequence?: number } | undefined;
  if (row?.origin !== "derived" && row?.origin !== "user") return undefined;
  return { value: String(row.value_text), origin: row.origin, commitSequence: Number(row.commit_sequence) };
}

function selectedHistoricalField(db: DatabaseSync, transactionId: unknown, field: CathayDerivedField, knowledgeAt: number): { value: string; origin: "derived" | "user"; commitSequence: number } | undefined {
  const user = db.prepare(`SELECT ua.value_text, c.commit_sequence FROM user_assertions ua JOIN user_assertion_lifecycle_events e ON e.assertion_id = ua.assertion_id
    JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE ua.transaction_id = ? AND ua.field_name = ? AND c.commit_sequence <= ? AND e.event_kind NOT IN ('withdrawn','superseded')
      AND NOT EXISTS (SELECT 1 FROM user_assertion_lifecycle_events newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
        WHERE newer.assertion_id = e.assertion_id AND nc.commit_sequence <= ? AND (nc.commit_sequence > c.commit_sequence OR (nc.commit_sequence = c.commit_sequence AND newer.rowid > e.rowid)))
    ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`).get(transactionId as CanonicalId, field, knowledgeAt, knowledgeAt) as { value_text?: unknown; commit_sequence?: number } | undefined;
  if (user) return { value: String(user.value_text), origin: "user", commitSequence: Number(user.commit_sequence) };
  const derived = db.prepare(`SELECT da.value_text, c.commit_sequence FROM derived_assertions da JOIN derived_assertion_lifecycle_events e ON e.assertion_id = da.assertion_id
    JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE da.transaction_id = ? AND da.field_name = ? AND c.commit_sequence <= ? AND e.event_kind NOT IN ('withdrawn','superseded')
      AND NOT EXISTS (SELECT 1 FROM derived_assertion_lifecycle_events newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
        WHERE newer.assertion_id = e.assertion_id AND nc.commit_sequence <= ? AND (nc.commit_sequence > c.commit_sequence OR (nc.commit_sequence = c.commit_sequence AND newer.rowid > e.rowid)))
    ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`).get(transactionId as CanonicalId, field, knowledgeAt, knowledgeAt) as { value_text?: unknown; commit_sequence?: number } | undefined;
  return derived ? { value: String(derived.value_text), origin: "derived", commitSequence: Number(derived.commit_sequence) } : undefined;
}

function addSelectedFields(db: DatabaseSync, row: Record<string, unknown>, knowledgeAt?: number): Record<string, unknown> {
  const display = knowledgeAt === undefined ? selectedCurrentField(db, row.transaction_id, "display_name") : selectedHistoricalField(db, row.transaction_id, "display_name", knowledgeAt);
  const note = knowledgeAt === undefined ? selectedCurrentField(db, row.transaction_id, "note") : selectedHistoricalField(db, row.transaction_id, "note", knowledgeAt);
  return { ...row, selected_display_label: display?.value, selected_display_origin: display?.origin, selected_display_commit_sequence: display?.commitSequence, selected_note: note?.value, selected_note_origin: note?.origin, selected_note_commit_sequence: note?.commitSequence };
}

class CathayCanonicalFinancialQueryAdapter implements CathayCanonicalFinancialQuery {
  private readonly ledgerDir: string;

  constructor(ledgerDir: string) { this.ledgerDir = ledgerDir; }
  async current(_request: CathayCanonicalCurrentQueryRequest): Promise<CathayCanonicalCurrentQueryResult> {
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const accounts = (db.prepare("SELECT account_id AS id, account_no AS accountNo, currency, account_type AS accountType FROM financial_accounts ORDER BY account_no").all() as Record<string, unknown>[]).map((row) => ({ id: idToString(row.id), accountNo: String(row.accountNo), currency: "TWD" as const, accountType: "depository" as const }));
      const rows = db.prepare(`SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence FROM current_transactions current_row
        JOIN financial_transactions t ON t.transaction_id = current_row.transaction_id JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.revision_id = current_row.revision_id JOIN canonical_commits c ON c.commit_id = current_row.projection_commit_id
        ORDER BY a.account_no, t.source_sequence`).all() as Record<string, unknown>[];
      const projection = db.prepare(`SELECT c.commit_sequence FROM current_projection_state state
        JOIN canonical_commits c ON c.commit_id = state.commit_id WHERE state.generation = 1`).get() as { commit_sequence?: number } | undefined;
      if (!projection) throw new Error("Canonical current projection cutoff is missing.");
      return { status: "ok", kind: "current", accounts, transactions: rows.map((row) => transactionFromRow(addSelectedFields(db, row))), commitSequence: Number(projection.commit_sequence) };
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
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence,
        COALESCE((SELECT CASE WHEN lifecycle.event_kind = 'withdrawn' THEN 'withdrawn' ELSE 'supported' END FROM assertion_lifecycle_events lifecycle
          JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = lifecycle.commit_id
          WHERE lifecycle.assertion_id = sa.assertion_id AND lifecycle_commit.commit_sequence <= ?
          ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC LIMIT 1), 'supported') AS assertion_support_state
        FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        JOIN source_assertions sa ON sa.revision_id = r.revision_id
        WHERE r.effective_on <= ? AND c.commit_sequence <= ? AND NOT EXISTS (
          SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
          WHERE newer.transaction_id = r.transaction_id AND newer.effective_on <= ? AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > c.commit_sequence
        ) ORDER BY a.account_no, t.source_sequence`).all(knowledgeAt, request.cutoff.financialAt, knowledgeAt, request.cutoff.financialAt, knowledgeAt) as Record<string, unknown>[];
      return { status: "ok", kind: "historical", cutoff: request.cutoff, transactions: rows.map((row) => transactionFromRow(addSelectedFields(db, row, knowledgeAt))) };
    } finally { db.close(); }
  }
  async lineage(request: CathayCanonicalLineageQueryRequest): Promise<CathayCanonicalLineageQueryResult> {
    if (request.subject.kind !== "transaction" || !request.subject.id) throw new Error("Cathay lineage queries require a transaction subject.");
    const transactionId = idFromString(request.subject.id);
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      const revisionRows = db.prepare(`SELECT t.transaction_id, t.account_id, t.source_sequence, a.account_no, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence, r.source_record_id, r.capture_id, sr.sequence_lexeme, sr.description, sr.payload_json,
        source_scope.scope_id, source_scope.account_id AS scope_account_id, source_scope.account_no AS scope_account_no, source_scope.stream AS scope_stream,
        source_scope.scope_start AS scope_scope_start, source_scope.scope_end AS scope_scope_end, source_scope.contract_fingerprint AS scope_contract_fingerprint, source_scope.preflight_fingerprint AS scope_preflight_fingerprint,
        sc.observed_at, sc.scope_start, sc.scope_end, sc.authority_route, sa.assertion_id FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        JOIN source_records sr ON sr.source_record_id = r.source_record_id JOIN source_record_scopes record_scope ON record_scope.source_record_id = sr.source_record_id
        JOIN capture_scopes source_scope ON source_scope.scope_id = record_scope.scope_id JOIN source_captures sc ON sc.capture_id = r.capture_id
        JOIN source_assertions sa ON sa.revision_id = r.revision_id WHERE t.transaction_id = ? ORDER BY r.revision_number`).all(transactionId) as Record<string, unknown>[];
      const entries = revisionRows.map((row) => {
        const assertionId = blob(row.assertion_id);
        const provenance = db.prepare(`SELECT p.source_record_id AS sourceRecordId, sr.capture_id AS captureId FROM assertion_provenance p
          JOIN source_records sr ON sr.source_record_id = p.source_record_id WHERE p.assertion_id = ? ORDER BY p.source_record_id`).all(assertionId) as Record<string, unknown>[];
        const lifecycleEvents = db.prepare(`SELECT e.event_id, e.event_kind, c.commit_sequence, cs.scope_id, cs.completeness, cs.absence_authority, cs.contract_fingerprint, cs.page_count
          FROM assertion_lifecycle_events e JOIN canonical_commits c ON c.commit_id = e.commit_id
          LEFT JOIN capture_scopes cs ON cs.scope_id = e.scope_id WHERE e.assertion_id = ? ORDER BY c.commit_sequence, e.event_id`).all(assertionId) as Record<string, unknown>[];
        const derivedRows = db.prepare(`SELECT da.assertion_id, da.field_name, da.producer_id, da.origin, da.rule_lineage, da.value_text, da.run_id, c.commit_sequence
          FROM derived_assertions da JOIN canonical_commits c ON c.commit_id = da.commit_id
          WHERE da.transaction_id = ? ORDER BY c.commit_sequence, da.assertion_id`).all(transactionId) as Record<string, unknown>[];
        const userRows = db.prepare(`SELECT ua.assertion_id, ua.field_name, ua.user_id, ua.value_text, c.commit_sequence
          FROM user_assertions ua JOIN canonical_commits c ON c.commit_id = ua.commit_id
          WHERE ua.transaction_id = ? ORDER BY c.commit_sequence, ua.assertion_id`).all(transactionId) as Record<string, unknown>[];
        const revision = transactionRevisionFromRow(addSelectedFields(db, row, Number(row.commit_sequence)));
        return {
          transaction: { id: idToString(row.transaction_id), accountId: idToString(row.account_id), sourceSequence: String(row.source_sequence) },
          revision,
          assertion: { id: idToString(row.assertion_id), revisionId: idToString(row.revision_id), commitSequence: Number(row.commit_sequence) },
          sourceRecord: { id: idToString(row.source_record_id), captureId: idToString(row.capture_id), sequence: String(row.sequence_lexeme), description: typeof row.description === "string" ? row.description : null, payload: String(row.payload_json), scopeProof: { id: idToString(row.scope_id), accountId: idToString(row.scope_account_id), accountNo: String(row.scope_account_no), stream: String(row.scope_stream), scopeStart: String(row.scope_scope_start), scopeEnd: String(row.scope_scope_end), completeness: "complete-range" as const, contractFingerprint: String(row.scope_contract_fingerprint), preflightFingerprint: String(row.scope_preflight_fingerprint) } },
          capture: { id: idToString(row.capture_id), observedAt: String(row.observed_at), scopeStart: String(row.scope_start), scopeEnd: String(row.scope_end), authorityRoute: String(row.authority_route) },
          provenance: provenance.map((item) => ({ sourceRecordId: idToString(item.sourceRecordId), captureId: idToString(item.captureId) })),
          lifecycleEvents: lifecycleEvents.map((event) => ({
            id: idToString(event.event_id), kind: event.event_kind as CathayCanonicalLifecycleEvent["kind"], commitSequence: Number(event.commit_sequence),
            scopeProof: event.scope_id ? { id: idToString(event.scope_id), completeness: "complete-range" as const, absenceAuthority: (event.absence_authority as CathayAbsenceAuthority | null) ?? null, contractFingerprint: String(event.contract_fingerprint), pageCount: Number(event.page_count) } : null,
          })),
          derivedAssertions: derivedRows.map((derived) => {
            const derivedAssertionId = blob(derived.assertion_id);
            const provenanceRows = db.prepare("SELECT run_id, coordinate_id FROM derived_assertion_provenance WHERE assertion_id = ? ORDER BY run_id, coordinate_id").all(derivedAssertionId) as Record<string, unknown>[];
            return { id: idToString(derivedAssertionId), field: derived.field_name as CathayDerivedField, producerId: String(derived.producer_id), origin: String(derived.origin), ruleLineage: String(derived.rule_lineage), value: String(derived.value_text), state: latestDerivedLifecycle(db, derivedAssertionId) === "withdrawn" ? "withdrawn" as const : "supported" as const, commitSequence: Number(derived.commit_sequence), runId: idToString(derived.run_id), provenance: provenanceRows.map((provenanceRow) => ({ runId: idToString(provenanceRow.run_id), coordinateId: idToString(provenanceRow.coordinate_id) })) };
          }),
          userAssertions: userRows.map((user) => {
            const userAssertionId = blob(user.assertion_id);
            const userProvenance = db.prepare(`SELECT c.commit_sequence FROM user_assertion_provenance p JOIN canonical_commits c ON c.commit_id = p.commit_id WHERE p.assertion_id = ? ORDER BY c.commit_sequence`).all(userAssertionId) as Array<Record<string, unknown>>;
            return { id: idToString(userAssertionId), field: user.field_name as CathayUserAssertionField, userId: String(user.user_id), value: String(user.value_text), state: latestUserLifecycle(db, userAssertionId) === "withdrawn" ? "withdrawn" as const : "supported" as const, commitSequence: Number(user.commit_sequence), provenance: userProvenance.map((item) => ({ commitSequence: Number(item.commit_sequence) })) };
          }),
        } satisfies CathayCanonicalLineageEntry;
      });
      return { status: "ok", kind: "lineage", subject: request.subject, entries };
    } finally { db.close(); }
  }
}

export function createCathayCanonicalFinancialQuery(ledgerDir: string): CathayCanonicalFinancialQuery { return new CathayCanonicalFinancialQueryAdapter(ledgerDir); }
