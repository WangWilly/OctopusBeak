import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  configureCanonicalRuntime,
  verifyCanonicalRuntime,
  withCanonicalSnapshot,
  withCanonicalWriterQueue,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import { FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_ROUTES } from "./foreign-currency-deposit-authorities.ts";

export const CATHAY_INTEGRATION_NAMESPACE = "cathay";
export const CATHAY_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
export const CATHAY_DOMESTIC_DEPOSIT_AUTHORITY = "cathay/domestic-deposit/v1";
export const CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION = "v1";
export const CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";
export const CATHAY_DERIVED_ORIGIN =
  "derived/cathay/domestic-deposit/v1" as const;
const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1 =
  "fubon/credit-card/human-attested-v1" as const;
const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2 =
  "fubon/credit-card/human-attested-v2" as const;
const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1 =
  "esun/credit-card/human-attested-v1" as const;
const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2 =
  "esun/credit-card/human-attested-v2" as const;
const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1 =
  "yuanta/credit-card/human-attested-v1" as const;
const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2 =
  "yuanta/credit-card/human-attested-v2" as const;
const FUBON_CREDIT_CARD_QUERY_ROUTES = new Set<string>([
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2,
]);
const ESUN_CREDIT_CARD_QUERY_ROUTES = new Set<string>([
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2,
]);
const YUANTA_CREDIT_CARD_QUERY_ROUTES = new Set<string>([
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2,
]);
export const CANONICAL_SQLITE_FILE = "canonical.sqlite";
export const CANONICAL_SCHEMA_VERSION = 9;
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
export type CathayDerivedOrigin = typeof CATHAY_DERIVED_ORIGIN;
export type CathayDerivedOutputState = "supported" | "unsupported";
export type CathayDerivedImportCoordinate = {
  transactionId: string;
  field: CathayDerivedField;
  state: CathayDerivedOutputState;
  value?: string | null;
};
export type CathayDerivedImportRunInput = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  producerId: string;
  ruleLineage: string;
  origin?: CathayDerivedOrigin;
  observedAt?: string;
  /** The closed-run marker; only a complete successful run may mutate canonical data. */
  complete: boolean;
  status: "complete" | "partial" | "failed";
  /** Complete, non-empty subject/field/producer/rule-lineage coordinate matrix. */
  subjectIds: string[];
  fields: CathayDerivedField[];
  scope: CathayDerivedImportCoordinate[];
};
export type CathayDerivedImportDiagnostic = {
  kind: "derived-import-diagnostic";
  stage: "preflight" | "scope" | "commit";
  reason: string;
  producerId?: string;
  ruleLineage?: string;
};
export type CathayDerivedImportResult =
  | {
      status: "committed";
      runId: string;
      commitSequence: number;
      assertionIds: string[];
    }
  | { status: "diagnostic"; diagnostic: CathayDerivedImportDiagnostic };
export type CathayDerivedImportOptions = CathayCanonicalCommitOptions & {
  onDiagnostic?: (diagnostic: CathayDerivedImportDiagnostic) => void;
};

export type CathayUserAssertionField = "display_name" | "note";
export type CathayUserAssertionTargetField =
  CathayUserAssertionField | "displayName" | "displayLabel";
export type CathayUserAssertionInput = {
  transactionId?: string;
  subject?: { kind: "transaction"; id: string };
  field?: CathayUserAssertionField | string;
  target?: {
    kind: "transaction";
    field?: CathayUserAssertionTargetField;
    id: string;
  };
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

export const CATHAY_DOMESTIC_DEPOSIT_FIXTURE: CathayDomesticDepositCaptureInput =
  {
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

/** The physical representation is deliberately stricter than SQLite's TEXT /
 * INTEGER affinities.  In particular, SQLite's `GLOB '[0-9]*'` means "a
 * digit followed by anything", so it accepts values such as `12abc`. */
const MAX_CANONICAL_SCALE = 9007199254740991n;
function canonicalStoredInteger(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value))
    return value.toString();
  return null;
}

function isCanonicalStoredExactAmount(
  coefficientValue: unknown,
  scaleValue: unknown,
): boolean {
  const coefficient = canonicalStoredInteger(coefficientValue);
  const scale = canonicalStoredInteger(scaleValue);
  if (
    coefficient === null ||
    scale === null ||
    !/^-?(?:0|[1-9]\d*)$/.test(coefficient) ||
    !/^(?:0|[1-9]\d*)$/.test(scale)
  )
    return false;
  try {
    BigInt(coefficient);
    return BigInt(scale) <= MAX_CANONICAL_SCALE;
  } catch {
    return false;
  }
}

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

  constructor(source: string) {
    this.source = source;
  }

  parse(): LosslessJsonValue {
    const value = this.value();
    this.whitespace();
    if (this.position !== this.source.length)
      throw new Error("Invalid JSON trailing data.");
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
      if (this.source[this.position] !== '"')
        throw new Error("Invalid JSON object key.");
      const key = this.string();
      this.whitespace();
      if (this.source[this.position] !== ":")
        throw new Error("Invalid JSON object separator.");
      this.position += 1;
      if (key in output) throw new Error(`Duplicate JSON object key: ${key}`);
      output[key] = this.value();
      this.whitespace();
      if (this.source[this.position] === "}") {
        this.position += 1;
        return output;
      }
      if (this.source[this.position] !== ",")
        throw new Error("Invalid JSON object delimiter.");
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
      if (this.source[this.position] !== ",")
        throw new Error("Invalid JSON array delimiter.");
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
    const match = this.source
      .slice(this.position)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match)
      throw new Error(`Invalid JSON value at position ${this.position}.`);
    this.position += match[0].length;
    return match[0];
  }

  private whitespace() {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }
}

function asObject(
  value: LosslessJsonValue,
  label: string,
): { [key: string]: LosslessJsonValue } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    "kind" in value
  )
    throw new Error(`${label} must be an object.`);
  return value as { [key: string]: LosslessJsonValue };
}
function asArray(
  value: LosslessJsonValue | undefined,
  label: string,
): LosslessJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}
function requiredString(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Missing required string ${key}.`);
  return value;
}
function isLosslessJsonNumber(
  value: LosslessJsonValue | undefined,
): value is LosslessJsonNumber {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.kind === "number",
  );
}
function requiredNumber(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string {
  const value = object[key];
  if (!isLosslessJsonNumber(value))
    throw new Error(`Missing required JSON number ${key}.`);
  return value.lexeme;
}
function nullableNumber(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string | null {
  const value = object[key];
  if (value === null) return null;
  if (!isLosslessJsonNumber(value))
    throw new Error(`${key} must be a JSON number or null.`);
  return value.lexeme;
}
function requireDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`${label} must be a valid calendar date.`);
  return value;
}

function normalizeCathayAccountDate(value: string, label: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return requireDate(value, label);
  }
  const localSecond = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/.exec(value);
  if (!localSecond) {
    throw new Error(`${label} must be YYYY-MM-DD.`);
  }
  requireDateTime(value, `${label} date-time`);
  return localSecond[1]!;
}

function normalizeCathayResponseDate(value: string, expected: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/.exec(value)?.[1];
  if (!date) {
    throw new Error(
      "Cathay response date scope does not match the requested scope.",
    );
  }
  try {
    if (date === value) requireDate(date, "Cathay response date");
    else requireDateTime(value, "Cathay response date-time");
  } catch {
    throw new Error(
      "Cathay response date scope does not match the requested scope.",
    );
  }
  if (date !== expected) {
    throw new Error(
      "Cathay response date scope does not match the requested scope.",
    );
  }
  return date;
}

function requireDateTime(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value))
    throw new Error(`${label} must be YYYY-MM-DDTHH:mm:ss.`);
  const calendarShape = new Date(`${value}Z`);
  if (
    Number.isNaN(calendarShape.getTime()) ||
    calendarShape.toISOString().slice(0, 19) !== value
  )
    throw new Error(`${label} must be a valid local date-time.`);
  return value;
}
function parseRfc3339UtcMicros(value: string, label: string): number {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match)
    throw new Error(
      `${label} must be RFC3339 with an explicit UTC designator or numeric offset.`,
    );
  const civil = `${match[1]}T${match[2]}`;
  if ((match[3]?.length ?? 0) > 6)
    throw new Error(`${label} exceeds integer microsecond precision.`);
  const calendarShape = new Date(`${civil}Z`);
  if (
    Number.isNaN(calendarShape.getTime()) ||
    calendarShape.toISOString().slice(0, 19) !== civil
  )
    throw new Error(`${label} must be a valid RFC3339 timestamp.`);
  if (match[4] !== "Z") {
    const [hours, minutes] = match[4].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59)
      throw new Error(`${label} has an invalid numeric offset.`);
  }
  const epochMilliseconds = Date.parse(`${civil}${match[4]}`);
  if (!Number.isSafeInteger(epochMilliseconds))
    throw new Error(`${label} is outside the supported instant range.`);
  const fractionMicros = BigInt((match[3] ?? "").slice(0, 6).padEnd(6, "0"));
  const micros = BigInt(epochMilliseconds) * 1000n + fractionMicros;
  if (
    micros > BigInt(Number.MAX_SAFE_INTEGER) ||
    micros < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error(
      `${label} microseconds exceed the safe SQLite binding range.`,
    );
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
  if (requiredString(statement, "queryStatus") !== "Success")
    throw new Error(
      "Cathay queryStatus was not Success; posting status is not mappable.",
    );
  for (const detailValue of details) {
    const detail = asObject(detailValue, "Cathay transfer detail");
    if (
      "status" in detail ||
      "pending" in detail ||
      "postingStatus" in detail
    ) {
      throw new Error(
        "Cathay posting mapping requires the booked-history response without pending status fields.",
      );
    }
  }
  return CATHAY_POSTING_MAPPING;
}

function validateCapture(
  input: CathayDomesticDepositCaptureInput,
): ValidatedCathayCapture {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim())
    throw new Error("Source Connection and Identity Epoch are required.");
  if (input.currency !== "TWD")
    throw new Error("Cathay domestic deposit currency must be TWD.");
  if (input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY)
    throw new Error("Invalid authority route.");
  if (input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM)
    throw new Error("Invalid Cathay product stream.");
  const startDate = requireDate(input.scope.startDate, "scope.startDate");
  const endDate = requireDate(input.scope.endDate, "scope.endDate");
  if (startDate > endDate)
    throw new Error("Cathay scope startDate must not be after endDate.");
  parseRfc3339UtcMicros(input.observedAt, "Capture observedAt");

  const root = asObject(
    new LosslessJsonParser(input.rawResponse).parse(),
    "Cathay response",
  );
  if (root.success !== true)
    throw new Error("Cathay response was not successful.");
  if (root.returnCode !== "0000")
    throw new Error("Cathay response returnCode was not 0000.");
  const content = asObject(root.content, "Cathay response content");
  const datas = asArray(content.datas, "Cathay response datas");
  if (datas.length !== 1)
    throw new Error(
      "Cathay response must contain exactly one transfer result.",
    );
  const statement = asObject(datas[0]!, "Cathay transfer result");
  const accountNo = requiredString(statement, "accountNumber");
  if (accountNo !== input.accountNo)
    throw new Error("Cathay account scope does not match the response.");
  normalizeCathayResponseDate(
    requiredString(statement, "startDate"),
    startDate,
  );
  normalizeCathayResponseDate(requiredString(statement, "endDate"), endDate);
  const count = parseExactDecimalLexeme(requiredNumber(statement, "count"));
  if (count.scale !== 0 || count.coefficient < 0n)
    throw new Error("Cathay count must be a non-negative integer.");
  const details = asArray(statement.details, "Cathay transfer details");
  if (count.coefficient !== BigInt(details.length))
    throw new Error("Cathay response count does not match details.");
  const posting = cathayPostingMapping(statement, details);

  const sequences = new Set<string>();
  const rows = details.map((detailValue, index) => {
    const detail = asObject(detailValue, `Cathay detail ${index}`);
    const sequenceLexeme = requiredNumber(detail, "sequenceNumber");
    const sequence = parseExactDecimalLexeme(sequenceLexeme);
    if (
      sequence.scale !== 0 ||
      sequence.coefficient < 0n ||
      sequences.has(sequenceLexeme)
    )
      throw new Error("Cathay sequenceNumber must be a unique exact integer.");
    sequences.add(sequenceLexeme);
    const expendLexeme = nullableNumber(detail, "expendAmt");
    const incomeLexeme = nullableNumber(detail, "incomeAmt");
    if ((expendLexeme === null) === (incomeLexeme === null))
      throw new Error("Cathay detail must have exactly one direction amount.");
    const amountLexeme = incomeLexeme ?? expendLexeme!;
    const amount = parseExactDecimalLexeme(amountLexeme);
    if (amount.coefficient < 0n)
      throw new Error("Cathay amount must be non-negative.");
    const balanceLexeme = requiredNumber(detail, "balance");
    const balance = parseExactDecimalLexeme(balanceLexeme);
    const accountDateValue = requiredString(detail, "accountDate");
    const accountDate = normalizeCathayAccountDate(
      accountDateValue,
      "accountDate",
    );
    const transactionDateTime = requireDateTime(
      requiredString(detail, "txnDateTime"),
      "txnDateTime",
    );
    const descriptionValue = detail.description;
    if (
      descriptionValue !== undefined &&
      descriptionValue !== null &&
      typeof descriptionValue !== "string"
    ) {
      throw new Error("Cathay description must be a string or absent.");
    }
    if (typeof descriptionValue === "string" && descriptionValue.length > 512)
      throw new Error(
        "Cathay description exceeds the supported compact length.",
      );
    const description =
      typeof descriptionValue === "string" && descriptionValue.length > 0
        ? descriptionValue
        : null;
    const direction = incomeLexeme === null ? "outflow" : "inflow";
    const payload: Record<string, string> = {
      sequenceNumber: sequenceLexeme,
      accountDate: accountDateValue,
      txnDateTime: transactionDateTime,
      amount: amountLexeme,
      amountDirection: direction,
      balance: balanceLexeme,
    };
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
  return {
    accountNo,
    startDate,
    endDate,
    posting,
    completeness: CATHAY_COMPLETENESS_PROOF,
    rows,
  };
}

function responseDigest(rawResponse: string): string {
  return createHash("sha256").update(rawResponse, "utf8").digest("hex");
}

function validateSyncInput(
  input: CathayDomesticDepositSyncInput,
): ValidatedCathaySync {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim())
    throw new Error("Source Connection and Identity Epoch are required.");
  if (
    input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY ||
    input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM
  )
    throw new Error("Invalid Cathay sync authority route or stream.");
  if (input.syncState.cursor !== undefined && input.syncState.cursor !== null)
    throw new Error("Cathay domestic deposit has no continuation cursor.");
  parseRfc3339UtcMicros(input.observedAt, "Capture observedAt");
  if (input.pages.length === 0)
    throw new Error("Cathay sync requires at least one staged page.");

  const grouped = new Map<string, CathayStagedCapturePage[]>();
  for (const page of input.pages) {
    if (!page.accountNo.trim() || page.currency !== "TWD")
      throw new Error(
        "Cathay staged page has an invalid account identity or currency.",
      );
    if (!Number.isInteger(page.pageOrdinal) || page.pageOrdinal < 0)
      throw new Error("Cathay page ordinal must be a non-negative integer.");
    if (!page.contractFingerprint.trim() || !page.preflightFingerprint.trim())
      throw new Error(
        "Cathay page contract and preflight fingerprints are required.",
      );
    if (page.contractFingerprint !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY)
      throw new Error("Cathay page contract fingerprint is unsupported.");
    const pages = grouped.get(page.accountNo) ?? [];
    pages.push(page);
    grouped.set(page.accountNo, pages);
  }
  const scopes: ValidatedCathayScope[] = [];
  let contractFingerprint: string | undefined;
  let preflightFingerprint: string | undefined;
  for (const [accountNo, pagesForAccount] of grouped) {
    const pages = [...pagesForAccount].sort(
      (left, right) => left.pageOrdinal - right.pageOrdinal,
    );
    if (new Set(pages.map((page) => page.pageOrdinal)).size !== pages.length)
      throw new Error("Cathay staged pages contain duplicate ordinals.");
    const first = pages[0]!;
    const startDate = requireDate(
      first.scope.startDate,
      "Cathay scope.startDate",
    );
    const endDate = requireDate(first.scope.endDate, "Cathay scope.endDate");
    if (startDate > endDate)
      throw new Error("Cathay scope startDate must not be after endDate.");
    const pageRows: ValidatedCathayScope["pages"] = [];
    const rows: ValidatedCathayRow[] = [];
    const sequences = new Set<string>();
    let expectedRequestToken: string | null = null;
    let absenceAuthority = first.absenceAuthority;
    if ((first.absenceAuthority as string | undefined) === "tombstone")
      throw new Error(
        "Cathay tombstone authority is unsupported without a source-validated tombstone record.",
      );
    for (const [index, page] of pages.entries()) {
      if ((page.absenceAuthority as string | undefined) === "tombstone")
        throw new Error(
          "Cathay tombstone authority is unsupported without a source-validated tombstone record.",
        );
      if (page.pageOrdinal !== index)
        throw new Error(
          "Cathay staged pages must have contiguous ordinals starting at zero.",
        );
      if (page.scope.startDate !== startDate || page.scope.endDate !== endDate)
        throw new Error("Cathay page scope drifted within one account.");
      if (
        page.contractFingerprint !== first.contractFingerprint ||
        page.preflightFingerprint !== first.preflightFingerprint
      )
        throw new Error(
          "Cathay page contract or preflight fingerprint drifted.",
        );
      if (page.absenceAuthority !== absenceAuthority)
        throw new Error("Cathay page absence authority drifted.");
      const requestPageToken = page.requestPageToken ?? null;
      if (requestPageToken !== expectedRequestToken)
        throw new Error("Cathay page continuation token is not contiguous.");
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
      if (!terminal && index === pages.length - 1)
        throw new Error("Cathay staged pages end before the terminal page.");
      if (terminal && index !== pages.length - 1)
        throw new Error(
          "Cathay staged pages contain a missing continuation page.",
        );
      for (const row of validated.rows) {
        if (sequences.has(row.sequence))
          throw new Error(
            "Cathay source sequence was duplicated across pages.",
          );
        sequences.add(row.sequence);
        rows.push(row);
      }
      pageRows.push({
        pageOrdinal: page.pageOrdinal,
        terminal,
        rowCount: validated.rows.length,
        responseDigest: responseDigest(page.rawResponse),
        rows: validated.rows,
      });
      expectedRequestToken = nextPageToken;
      contractFingerprint ??= page.contractFingerprint;
      preflightFingerprint ??= page.preflightFingerprint;
      if (
        contractFingerprint !== page.contractFingerprint ||
        preflightFingerprint !== page.preflightFingerprint
      )
        throw new Error(
          "Cathay sync contract or preflight fingerprint drifted across scopes.",
        );
    }
    scopes.push({
      accountNo,
      currency: "TWD",
      startDate,
      endDate,
      absenceAuthority,
      contractFingerprint: first.contractFingerprint,
      preflightFingerprint: first.preflightFingerprint,
      pages: pageRows,
      rows,
    });
  }
  return {
    sourceConnectionId: input.sourceConnectionId,
    identityEpoch: input.identityEpoch,
    authorityRoute: input.authorityRoute,
    stream: input.stream,
    syncState: { cursor: null },
    observedAt: input.observedAt,
    scopes,
  };
}

type CanonicalId = Buffer;
function uuidV7(): CanonicalId {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}
function idToString(value: unknown): string {
  const bytes = value instanceof Uint8Array ? Buffer.from(value) : undefined;
  if (!bytes || bytes.length !== 16)
    throw new Error("Canonical ID must be a 16-byte UUID blob.");
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function idFromString(value: string): CanonicalId {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Canonical ID must be a UUID string.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}
function blob(value: unknown): CanonicalId {
  return value instanceof Uint8Array && value.byteLength === 16
    ? Buffer.from(value)
    : (() => {
        throw new Error("Expected a 16-byte canonical ID blob.");
      })();
}

export function canonicalSqlitePath(ledgerDir: string): string {
  return join(ledgerDir, CANONICAL_SQLITE_FILE);
}

// One typed assertion metadata/provenance spine is shared by Source, Derived,
// and User claims. The older source-specific tables remain compatibility
// projections for #129 callers, while these tables own cross-origin identity,
// transitions, and provenance for v6 admissions.
const SCHEMA_SHARED_ASSERTION_SPINE = `
CREATE TABLE IF NOT EXISTS assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note')),
  target_kind TEXT NOT NULL CHECK(target_kind = 'transaction'),
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','user')),
  producer_id TEXT NOT NULL,
  rule_lineage TEXT NOT NULL,
  revision_id BLOB REFERENCES transaction_revisions(revision_id),
  value_text TEXT,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK((origin = 'source' AND field_name = 'transaction_revision' AND revision_id IS NOT NULL AND value_text IS NULL)
    OR (origin IN ('derived','user') AND field_name IN ('display_name','note') AND revision_id IS NULL AND value_text IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS assertion_transitions (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note')),
  capture_id BLOB,
  scope_id BLOB,
  run_id BLOB REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  user_id TEXT,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','restored'))
);
CREATE TABLE IF NOT EXISTS assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  run_id BLOB REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
);
`;
const SCHEMA_SHARED_ASSERTION_SPINE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_assertions_lineage ON assertions(transaction_id, field_name, origin, producer_id, rule_lineage, created_commit_id);
CREATE INDEX IF NOT EXISTS idx_assertion_transitions_knowledge ON assertion_transitions(assertion_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_transitions_transaction ON assertion_transitions(transaction_id, field_name, commit_id, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_provenance_authority ON assertion_provenance(assertion_id, commit_id, source_record_id, run_id, coordinate_id);
CREATE INDEX IF NOT EXISTS idx_assertion_provenance_record ON assertion_provenance(source_record_id, assertion_id, commit_id);
`;

const SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS = [
  "assertion_id",
  "transaction_id",
  "revision_id",
  "source_record_id",
  "commit_id",
] as const;
const SOURCE_ASSERTIONS_COMPATIBILITY_SELECT = `SELECT assertion.assertion_id, assertion.transaction_id, assertion.revision_id,
  revision.source_record_id, assertion.created_commit_id AS commit_id
  FROM assertions assertion JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id
  WHERE assertion.origin = 'source' AND EXISTS (
    SELECT 1 FROM assertion_provenance provenance
    WHERE provenance.assertion_id = assertion.assertion_id
      AND provenance.source_record_id IS NOT NULL
      AND provenance.source_record_id = revision.source_record_id
  )`;

function sourceAssertionsViewSql(db: DatabaseSync): string {
  return String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
}

function sourceAssertionsRelationColumns(db: DatabaseSync): string[] {
  return (
    db.prepare("PRAGMA table_info(source_assertions)").all() as Array<{
      name?: unknown;
    }>
  ).map((column) => String(column.name ?? ""));
}

const SOURCE_ASSERTIONS_SQL_KEYWORDS = new Set([
  "AS",
  "AND",
  "OR",
  "ON",
  "WHERE",
  "HAVING",
  "FROM",
  "SELECT",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "GROUP",
  "ORDER",
  "LIMIT",
  "UNION",
  "EXCEPT",
  "INTERSECT",
]);

function sourceAssertionsSqlIdentifierPattern(identifier: string): string {
  return identifier
    .split("")
    .map((character) =>
      /[A-Za-z0-9_]/.test(character) ? character : `\\${character}`,
    )
    .join("");
}

function sourceAssertionsSqlAlias(
  sql: string,
  keyword: "FROM" | "JOIN",
  relation: string,
): string {
  const relationPattern = sourceAssertionsSqlIdentifierPattern(relation);
  const identifierPattern =
    `(?:"([^"]+)"|\\[([^\\]]+)\\]|([A-Za-z_][A-Za-z0-9_$]*))`;
  const match = sql.match(
    new RegExp(
      `\\b${keyword}\\s+(?:"${relationPattern}"|\\[${relationPattern}\\]|${relationPattern})(?:\\s+(?:AS\\s+)?${identifierPattern})?`,
      "i",
    ),
  );
  const candidate = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!candidate || SOURCE_ASSERTIONS_SQL_KEYWORDS.has(candidate.toUpperCase()))
    return relation;
  return candidate;
}

function sourceAssertionsSqlQualifiedColumnPattern(
  alias: string,
  relation: string,
  column: string,
): string {
  const aliasPattern = sourceAssertionsSqlIdentifierPattern(alias);
  const relationPattern = sourceAssertionsSqlIdentifierPattern(relation);
  const columnPattern = sourceAssertionsSqlIdentifierPattern(column);
  if (alias === relation)
    return `(?:(?:${aliasPattern}|${relationPattern})\\s*\\.\\s*)?${columnPattern}`;
  return `${aliasPattern}\\s*\\.\\s*${columnPattern}`;
}

function sourceAssertionsSqlRelationPattern(relation: string): string {
  const relationPattern = sourceAssertionsSqlIdentifierPattern(relation);
  return `(?:"${relationPattern}"|\\[${relationPattern}\\]|${relationPattern})`;
}

function sourceAssertionsViewSqlHasSourceSemantics(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, " ");
  const assertionAlias = sourceAssertionsSqlAlias(
    normalized,
    "FROM",
    "assertions",
  );
  const provenanceAlias = sourceAssertionsSqlAlias(
    normalized,
    "FROM",
    "assertion_provenance",
  );
  const sourceOrigin = sourceAssertionsSqlQualifiedColumnPattern(
    assertionAlias,
    "assertions",
    "origin",
  );
  const provenanceAssertionId = sourceAssertionsSqlQualifiedColumnPattern(
    provenanceAlias,
    "assertion_provenance",
    "assertion_id",
  );
  const assertionId = sourceAssertionsSqlQualifiedColumnPattern(
    assertionAlias,
    "assertions",
    "assertion_id",
  );
  const provenanceSourceRecordId =
    sourceAssertionsSqlQualifiedColumnPattern(
      provenanceAlias,
      "assertion_provenance",
      "source_record_id",
    );
  const provenanceAssertionLink = new RegExp(
    `(?:${provenanceAssertionId}\\s*=\\s*${assertionId}|${assertionId}\\s*=\\s*${provenanceAssertionId})`,
    "i",
  );
  return (
    new RegExp(
      `\\bFROM\\s+${sourceAssertionsSqlRelationPattern("assertions")}(?![A-Za-z0-9_$])`,
      "i",
    ).test(normalized) &&
    new RegExp(
      `\\b(?:FROM|JOIN)\\s+${sourceAssertionsSqlRelationPattern("transaction_revisions")}(?![A-Za-z0-9_$])`,
      "i",
    ).test(normalized) &&
    new RegExp(
      `\\b(?:FROM|JOIN)\\s+${sourceAssertionsSqlRelationPattern("assertion_provenance")}(?![A-Za-z0-9_$])`,
      "i",
    ).test(normalized) &&
    new RegExp(`${sourceOrigin}\\s*=\\s*'source'`, "i").test(normalized) &&
    provenanceAssertionLink.test(normalized) &&
    new RegExp(
      `${provenanceSourceRecordId}\\s+IS\\s+NOT\\s+NULL`,
      "i",
    ).test(normalized)
  );
}

function sourceAssertionsViewMatchesContract(db: DatabaseSync): boolean {
  const columns = SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS.join(", ");
  try {
    if (relationType(db, "source_assertions") !== "view") return false;
    if (
      sourceAssertionsRelationColumns(db).join(",") !==
      SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS.join(",")
    )
      return false;
    if (
      !sourceAssertionsViewSqlHasSourceSemantics(sourceAssertionsViewSql(db))
    )
      return false;
    const actualCount = Number(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM source_assertions`).get() as {
          count?: number;
        }
      ).count ?? 0,
    );
    const expectedCount = Number(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM (${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT})`).get() as {
          count?: number;
        }
      ).count ?? 0,
    );
    if (actualCount !== expectedCount) return false;
    const invalidCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM source_assertions source_assertion
             LEFT JOIN assertions assertion ON assertion.assertion_id = source_assertion.assertion_id
             LEFT JOIN transaction_revisions revision ON revision.revision_id = source_assertion.revision_id
             WHERE assertion.assertion_id IS NULL
               OR assertion.origin <> 'source'
               OR assertion.field_name <> 'transaction_revision'
               OR assertion.target_kind <> 'transaction'
               OR assertion.revision_id IS NULL
               OR assertion.transaction_id IS NOT source_assertion.transaction_id
               OR assertion.revision_id IS NOT source_assertion.revision_id
               OR assertion.created_commit_id IS NOT source_assertion.commit_id
               OR revision.revision_id IS NULL
               OR revision.transaction_id IS NOT source_assertion.transaction_id
               OR revision.source_record_id IS NULL
               OR revision.source_record_id IS NOT source_assertion.source_record_id
               OR source_assertion.source_record_id IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM assertion_provenance provenance
                 WHERE provenance.assertion_id = assertion.assertion_id
                   AND provenance.source_record_id IS NOT NULL
                   AND provenance.source_record_id = revision.source_record_id
               )`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (invalidCount !== 0) return false;
    const expectedOnly = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT} EXCEPT SELECT ${columns} FROM source_assertions)`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    const actualOnly = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (SELECT ${columns} FROM source_assertions EXCEPT ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT})`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    return expectedOnly === 0 && actualOnly === 0;
  } catch {
    return false;
  }
}

function legacySourceAssertionsTableMatchesContract(db: DatabaseSync): boolean {
  if (relationType(db, "source_assertions") !== "table") return false;
  if (
    sourceAssertionsRelationColumns(db).join(",") !==
    SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS.join(",")
  )
    return false;
  try {
    const integrityRows = db
      .prepare("PRAGMA integrity_check(source_assertions)")
      .all() as Array<{ integrity_check?: unknown }>;
    if (
      integrityRows.some((row) => String(row.integrity_check ?? "") !== "ok") ||
      db.prepare("PRAGMA foreign_key_check(source_assertions)").all().length !== 0
    )
      return false;
    const invalidCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM source_assertions source_assertion
             LEFT JOIN transaction_revisions revision ON revision.revision_id = source_assertion.revision_id
             LEFT JOIN source_records source_record ON source_record.source_record_id = source_assertion.source_record_id
             WHERE source_assertion.assertion_id IS NULL
               OR source_assertion.transaction_id IS NULL
               OR source_assertion.revision_id IS NULL
               OR source_assertion.source_record_id IS NULL
               OR source_assertion.commit_id IS NULL
               OR revision.revision_id IS NULL
               OR revision.transaction_id IS NOT source_assertion.transaction_id
               OR revision.source_record_id IS NOT source_assertion.source_record_id
               OR revision.commit_id IS NOT source_assertion.commit_id
               OR source_record.source_record_id IS NULL
               OR source_record.capture_id IS NOT revision.capture_id`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    return invalidCount === 0;
  } catch {
    return false;
  }
}

function createCanonicalSourceAssertionsView(db: DatabaseSync): void {
  db.exec(
    `CREATE VIEW source_assertions AS ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT}`,
  );
}

function rebuildCanonicalSourceAssertionsView(db: DatabaseSync): void {
  if (relationType(db, "source_assertions") === "view")
    db.exec("DROP VIEW source_assertions");
  else if (relationType(db, "source_assertions") !== null)
    throw new Error(
      "Canonical Source assertions compatibility relation is not a view.",
    );
  createCanonicalSourceAssertionsView(db);
}

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
  account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')), currency TEXT,
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
  local_value TEXT NOT NULL, time_zone TEXT NOT NULL CHECK(time_zone = 'Asia/Taipei'), time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
  time_origin TEXT NOT NULL CHECK(time_origin = 'source_reported'), utc_instant_utc_us INTEGER NOT NULL,
  UNIQUE(revision_id, role)
);
CREATE TABLE IF NOT EXISTS source_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(transaction_id, revision_id)
);
CREATE TABLE IF NOT EXISTS assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES source_assertions(assertion_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, source_record_id)
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
const SCHEMA_V4_BASE = SCHEMA.replace(
  "stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL",
  "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL",
)
  .replace(
    "payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)",
    "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)",
  )
  .replace(
    "  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n",
    "",
  )
  .replace(
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
  );
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
  .replace(
    "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL",
    "stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL",
  )
  .replace(
    "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)",
    "payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)",
  )
  .replace(
    "  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,\n",
    "  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,\n  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n",
  )
  .replace(
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);\nCREATE TABLE IF NOT EXISTS current_projection_state",
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);\nCREATE TABLE IF NOT EXISTS current_projection_state",
  )
  .replace(
    "  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),",
    "  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, scope_kind TEXT NOT NULL CHECK(scope_kind = 'bounded-range'), completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),",
  )
  .replace(
    "UNIQUE(capture_id, account_id, scope_start, scope_end)",
    "UNIQUE(scope_id, capture_id), UNIQUE(scope_id, account_id), UNIQUE(capture_id, account_id, scope_start, scope_end)",
  )
  .replace(
    "absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'tombstone'))",
    "absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data'))",
  )
  .replace(
    "posting_origin TEXT NOT NULL CHECK(posting_origin = 'provider_booked_history')",
    "posting_origin TEXT NOT NULL CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%')",
  )
  .replace(
    "posting_basis TEXT NOT NULL CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    "posting_basis TEXT NOT NULL CHECK(posting_basis IN ('query-status-success-with-accounting-date','human-attested-formally-posted','statement-posted-history') OR posting_basis LIKE 'synthetic_%')",
  )
  .replace(
    "posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    "posting_rule_version TEXT NOT NULL CHECK(posting_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR posting_rule_version LIKE 'synthetic-%' OR posting_rule_version LIKE 'yuanta/credit-card/%')",
  )
  .replace(
    "semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
    "semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR semantic_rule_version LIKE 'synthetic-%' OR semantic_rule_version LIKE 'yuanta/credit-card/%')",
  )
  .replace(
    "effective_time_basis TEXT NOT NULL CHECK(effective_time_basis = 'accounting')",
    "effective_time_basis TEXT NOT NULL CHECK(effective_time_basis IN ('accounting','transaction-time','source-reported'))",
  )
  .replace(
    "time_precision TEXT NOT NULL CHECK(time_precision = 'second')",
    "time_precision TEXT NOT NULL CHECK(time_precision IN ('minute','second'))",
  )
  .replace(
    "effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    "effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR effective_time_rule_version LIKE 'synthetic-%' OR effective_time_rule_version LIKE 'yuanta/credit-card/%')",
  );

const SCHEMA_V6_APPEND = `
${SCHEMA_SHARED_ASSERTION_SPINE}
${SCHEMA_SHARED_ASSERTION_SPINE_INDEXES}
CREATE TABLE IF NOT EXISTS derived_import_runs (
  run_id BLOB PRIMARY KEY CHECK(length(run_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  stream TEXT NOT NULL, producer_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'),
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
  producer_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'), rule_lineage TEXT NOT NULL,
  output_state TEXT NOT NULL CHECK(output_state IN ('supported','unsupported')),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(run_id, transaction_id, field_name, producer_id, origin, rule_lineage)
);
CREATE TABLE IF NOT EXISTS derived_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  producer_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'), rule_lineage TEXT NOT NULL,
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
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','restored'))
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
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn'))
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
  derived_assertion_id BLOB REFERENCES assertions(assertion_id),
  user_assertion_id BLOB REFERENCES assertions(assertion_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_derived_scope_coordinates_lineage ON derived_scope_coordinates(transaction_id, field_name, origin, producer_id, rule_lineage, commit_id);
CREATE INDEX IF NOT EXISTS idx_current_transaction_fields_projection ON current_transaction_fields(field_name, origin, projection_commit_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_current_transactions_revision ON current_transactions(revision_id, commit_id, transaction_id);
`;
// A fresh v6 database must not first create the v5 Source-only provenance table:
// the shared spine owns provenance at v6, while v5 migrations still retain the
// legacy table long enough for ensureV6SharedAssertionSpine to backfill it.
const SCHEMA_V6_BASE = SCHEMA_V5.replace(
  /CREATE TABLE IF NOT EXISTS assertion_provenance \([\s\S]*?\n\);\n/,
  "",
).replace(
  "CREATE INDEX IF NOT EXISTS idx_assertion_provenance_record ON assertion_provenance(source_record_id, assertion_id, commit_id);",
  "",
);
const SCHEMA_V6 = `${SCHEMA_V6_BASE.replace("CHECK(commit_kind = 'source_capture')", "CHECK(commit_kind IN ('source_capture','derived_import','user_assertion'))")}${SCHEMA_V6_APPEND}`;

/** v7 keeps the public Current query contract while moving its physical rows
 * behind an immutable generation boundary. Compatibility tables are mirrored
 * inside the same write transaction for older #129/#130 callers; these rows
 * are never consulted by the v7 query adapter. */
const SCHEMA_V7_APPEND = `
CREATE TABLE IF NOT EXISTS projection_generations (
  generation_id INTEGER PRIMARY KEY CHECK(generation_id > 0),
  status TEXT NOT NULL CHECK(status IN ('building','validated','active','retired')),
  build_cutoff_commit_sequence INTEGER NOT NULL CHECK(build_cutoff_commit_sequence >= 0),
  rule_version TEXT NOT NULL,
  created_commit_id BLOB REFERENCES canonical_commits(commit_id),
  validated_commit_id BLOB REFERENCES canonical_commits(commit_id),
  switched_commit_id BLOB REFERENCES canonical_commits(commit_id),
  UNIQUE(generation_id, status)
);
CREATE TABLE IF NOT EXISTS projection_generation_provenance (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  previous_event_id BLOB CHECK(previous_event_id IS NULL OR length(previous_event_id) = 16),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('created','validated','switched','knowledge')),
  event_source TEXT NOT NULL CHECK(event_source IN ('migration','rebuild','routine')),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_digest BLOB NOT NULL CHECK(length(event_digest) = 32),
  UNIQUE(generation_id, ordinal),
  UNIQUE(generation_id, event_kind, event_source, commit_id)
);
CREATE TABLE IF NOT EXISTS active_projection_generation (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  generation_id INTEGER NOT NULL UNIQUE REFERENCES projection_generations(generation_id),
  switched_commit_id BLOB REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS projection_generation_transactions (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, transaction_id),
  UNIQUE(generation_id, revision_id)
);
CREATE TABLE IF NOT EXISTS projection_generation_transaction_selection (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  selection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  selection_kind TEXT NOT NULL CHECK(selection_kind IN ('source_lifecycle','rebuild','migration')),
  PRIMARY KEY(generation_id, transaction_id),
  UNIQUE(generation_id, revision_id),
  FOREIGN KEY(generation_id, transaction_id) REFERENCES projection_generation_transactions(generation_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS projection_generation_transaction_fields (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BLOB REFERENCES assertions(assertion_id),
  user_assertion_id BLOB REFERENCES assertions(assertion_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_projection_generation_transactions_active ON projection_generation_transactions(generation_id, transaction_id, revision_id);
CREATE INDEX IF NOT EXISTS idx_projection_generation_transactions_revision ON projection_generation_transactions(generation_id, revision_id, projection_commit_id);
CREATE INDEX IF NOT EXISTS idx_projection_generation_selection_commit ON projection_generation_transaction_selection(generation_id, selection_commit_id, selection_kind, transaction_id);
CREATE INDEX IF NOT EXISTS idx_projection_generation_fields_active ON projection_generation_transaction_fields(generation_id, transaction_id, field_name, projection_commit_id);
CREATE INDEX IF NOT EXISTS idx_projection_generations_status ON projection_generations(status, build_cutoff_commit_sequence, generation_id);
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_switch_insert
BEFORE INSERT ON active_projection_generation
WHEN (SELECT COUNT(*) FROM canonical_commits) > 0 AND NEW.switched_commit_id IS NULL
BEGIN SELECT RAISE(ABORT, 'active projection switch commit is required'); END;
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_switch_update
BEFORE UPDATE OF switched_commit_id ON active_projection_generation
WHEN (SELECT COUNT(*) FROM canonical_commits) > 0 AND NEW.switched_commit_id IS NULL
BEGIN SELECT RAISE(ABORT, 'active projection switch commit is required'); END;
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_commit_insert
BEFORE INSERT ON active_projection_generation
WHEN NEW.switched_commit_id IS NOT (SELECT switched_commit_id FROM projection_generations WHERE generation_id = NEW.generation_id)
BEGIN SELECT RAISE(ABORT, 'active projection switch commit does not match generation'); END;
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_commit_update
BEFORE UPDATE OF generation_id, switched_commit_id ON active_projection_generation
WHEN NEW.switched_commit_id IS NOT (SELECT switched_commit_id FROM projection_generations WHERE generation_id = NEW.generation_id)
BEGIN SELECT RAISE(ABORT, 'active projection switch commit does not match generation'); END;
CREATE TRIGGER IF NOT EXISTS projection_generation_events_no_update
BEFORE UPDATE ON projection_generation_provenance
BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS projection_generation_events_no_delete
BEFORE DELETE ON projection_generation_provenance
BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_projection_generation_fields_integrity_insert
BEFORE INSERT ON projection_generation_transaction_fields
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion JOIN projection_generations generation ON generation.generation_id = NEW.generation_id
  WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
    AND assertion.origin = NEW.origin AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
)
BEGIN SELECT RAISE(ABORT, 'projection generation field assertion integrity mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_projection_generation_fields_integrity_update
BEFORE UPDATE OF generation_id, transaction_id, field_name, origin, derived_assertion_id, user_assertion_id, projection_commit_id ON projection_generation_transaction_fields
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion JOIN projection_generations generation ON generation.generation_id = NEW.generation_id
  WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
    AND assertion.origin = NEW.origin AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
)
BEGIN SELECT RAISE(ABORT, 'projection generation field assertion integrity mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_transitions_integrity_insert
BEFORE INSERT ON assertion_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
    AND (assertion.origin = 'source'
      OR (assertion.origin = 'user' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL AND NEW.user_id = assertion.producer_id)
      OR (assertion.origin = 'derived' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.user_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      )))
)
BEGIN SELECT RAISE(ABORT, 'assertion transition coordinate mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_transitions_integrity_update
BEFORE UPDATE OF assertion_id, transaction_id, field_name ON assertion_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
    AND (assertion.origin = 'source'
      OR (assertion.origin = 'user' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL AND NEW.user_id = assertion.producer_id)
      OR (assertion.origin = 'derived' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.user_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      )))
)
BEGIN SELECT RAISE(ABORT, 'assertion transition coordinate mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_provenance_integrity_insert
BEFORE INSERT ON assertion_provenance
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND (assertion.origin = 'source' AND NEW.source_record_id IS NOT NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'user' AND NEW.source_record_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'derived' AND NEW.source_record_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      ))
)
BEGIN SELECT RAISE(ABORT, 'assertion provenance coordinate mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_provenance_integrity_update
BEFORE UPDATE OF assertion_id, source_record_id, run_id, coordinate_id ON assertion_provenance
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND (assertion.origin = 'source' AND NEW.source_record_id IS NOT NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'user' AND NEW.source_record_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'derived' AND NEW.source_record_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      ))
)
BEGIN SELECT RAISE(ABORT, 'assertion provenance coordinate mismatch'); END;
`;

// Version 2 deliberately excludes only the v3 completeness proof columns and nullable cursor.
// Keeping this target schema separate prevents an older database from being created at a
// partially upgraded shape before its migration transaction reaches the next version.
const SCHEMA_V2 = SCHEMA.replace(
  "stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL",
  "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL",
)
  .replace(
    "payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)",
    "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)",
  )
  .replace(
    "  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n",
    "",
  )
  .replace(
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
  )
  .replace(
    "completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),\n  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)",
    "completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)",
  )
  .replace(
    "stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT,",
    "stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT NOT NULL,",
  );
if (
  SCHEMA_V2.includes("completeness_basis") ||
  SCHEMA_V2.includes("completeness_rule_version") ||
  !SCHEMA_V2.includes("cursor TEXT NOT NULL")
) {
  throw new Error(
    "Canonical schema v2 target definition is inconsistent with its migration contract.",
  );
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}
function relationType(db: DatabaseSync, name: string): "table" | "view" | null {
  const row = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(name) as { type?: string } | undefined;
  return row?.type === "table" || row?.type === "view" ? row.type : null;
}
function columnExists(
  db: DatabaseSync,
  table: string,
  column: string,
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  ).some((row) => row.name === column);
}
function migrateV1ToV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "ALTER TABLE canonical_commits ADD COLUMN commit_kind TEXT NOT NULL DEFAULT 'source_capture' CHECK(commit_kind = 'source_capture')",
    );
    db.exec("ALTER TABLE source_records ADD COLUMN description TEXT");
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN posting_origin TEXT NOT NULL DEFAULT 'provider_booked_history' CHECK(posting_origin = 'provider_booked_history')",
    );
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN posting_basis TEXT NOT NULL DEFAULT 'query-status-success-with-accounting-date' CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    );
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN posting_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    );
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN description TEXT");
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN effective_time_basis TEXT NOT NULL DEFAULT 'accounting' CHECK(effective_time_basis = 'accounting')",
    );
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN effective_time_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    );
    db.exec(SCHEMA_V2);
    const revisions = db
      .prepare(
        "SELECT revision_id, transaction_id, source_record_id, commit_id, capture_id, effective_on, transaction_date_time_local, utc_instant_utc_us FROM transaction_revisions",
      )
      .all() as Array<Record<string, unknown>>;
    const insertObservation =
      db.prepare(`INSERT INTO transaction_time_observations(
      observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const revision of revisions) {
      insertObservation.run(
        uuidV7(),
        blob(revision.transaction_id),
        blob(revision.revision_id),
        blob(revision.source_record_id),
        blob(revision.commit_id),
        "accounting",
        String(revision.effective_on),
        CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
        "date",
        "source_reported",
        localDateToUtcMicros(String(revision.effective_on)),
      );
      insertObservation.run(
        uuidV7(),
        blob(revision.transaction_id),
        blob(revision.revision_id),
        blob(revision.source_record_id),
        blob(revision.commit_id),
        "occurred",
        String(revision.transaction_date_time_local),
        CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
        "second",
        "source_reported",
        Number(revision.utc_instant_utc_us),
      );
    }
    const latestCommit = db
      .prepare(
        "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (latestCommit)
      db.prepare(
        "INSERT OR REPLACE INTO current_projection_state(generation, commit_id) VALUES (1, ?)",
      ).run(blob(latestCommit.commit_id));
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(2, currentUtcMicros());
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
    db.exec(
      "ALTER TABLE source_captures ADD COLUMN completeness_basis TEXT NOT NULL DEFAULT 'success-status-scope-count-details' CHECK(completeness_basis = 'success-status-scope-count-details')",
    );
    db.exec(
      "ALTER TABLE source_captures ADD COLUMN completeness_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1')",
    );
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
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(3, currentUtcMicros());
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
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(4, currentUtcMicros());
    db.exec("PRAGMA user_version = 4");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export type CanonicalMigrationFailureInjection =
  | "v4-v5-after-record-copy"
  | "v5-v6-after-derived-schema"
  | "v6-v7-after-generation-creation"
  | "v6-v7-after-generation-copy"
  | "v6-v7-after-pointer"
  | "v6-v7-after-validation"
  | "v7-v8-after-source-copy";
export type CanonicalDatabaseOptions = {
  readOnly?: boolean;
  injectMigrationFailure?: CanonicalMigrationFailureInjection;
  runtime?: CanonicalRuntimeOptions;
};

function ensureV6SharedAssertionSpine(db: DatabaseSync): void {
  const provenanceSql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assertion_provenance'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const legacyProvenance = /REFERENCES\s+source_assertions/i.test(
    provenanceSql,
  );
  if (legacyProvenance)
    db.exec(
      "ALTER TABLE assertion_provenance RENAME TO assertion_provenance_v5",
    );
  db.exec(SCHEMA_SHARED_ASSERTION_SPINE);
  const sourceAssertionRelation = relationType(db, "source_assertions");
  let sourceAssertionHasExpectedAuthority =
    sourceAssertionRelation === "view" &&
    sourceAssertionsViewMatchesContract(db);
  if (sourceAssertionRelation === "view" && !sourceAssertionHasExpectedAuthority) {
    // A compatibility view is derived state. Rebuild it before reading any
    // rows so a token-compatible but semantically broad view cannot promote
    // derived assertions or assertions without source provenance.
    rebuildCanonicalSourceAssertionsView(db);
    sourceAssertionHasExpectedAuthority = sourceAssertionsViewMatchesContract(db);
  }
  const sourceAssertionTableIsValid =
    sourceAssertionRelation === "table" &&
    legacySourceAssertionsTableMatchesContract(db);
  if (sourceAssertionRelation === "table" && !sourceAssertionTableIsValid)
    throw new Error(
      "Canonical legacy Source assertions table is malformed; refusing to backfill it.",
    );
  const canBackfillSourceAssertions =
    sourceAssertionTableIsValid || sourceAssertionHasExpectedAuthority;
  if (canBackfillSourceAssertions)
    db.exec(`INSERT OR IGNORE INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
      SELECT source_assertion.assertion_id, source_assertion.transaction_id, 'transaction_revision', 'transaction', 'source', capture.authority_route, capture.authority_route,
        source_assertion.revision_id, NULL, source_assertion.commit_id
      FROM source_assertions source_assertion JOIN transaction_revisions revision ON revision.revision_id = source_assertion.revision_id
        JOIN source_captures capture ON capture.capture_id = revision.capture_id`);
  db.exec(`INSERT OR IGNORE INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind)
    SELECT event.event_id, event.assertion_id, event.transaction_id, 'transaction_revision', event.capture_id, event.scope_id, NULL, NULL, NULL, event.commit_id, event.event_kind
    FROM assertion_lifecycle_events event`);
  if (legacyProvenance) {
    db.exec(`INSERT OR IGNORE INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
      SELECT assertion_id, source_record_id, NULL, NULL, commit_id FROM assertion_provenance_v5`);
    db.exec("DROP TABLE assertion_provenance_v5");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id)",
  );
}

function backfillV6DerivedAndUserAssertions(db: DatabaseSync): void {
  if (tableExists(db, "derived_assertions")) {
    db.exec(`INSERT OR IGNORE INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
      SELECT assertion_id, transaction_id, field_name, 'transaction', 'derived', producer_id, rule_lineage, NULL, value_text, commit_id FROM derived_assertions`);
  }
  if (tableExists(db, "user_assertions")) {
    db.exec(`INSERT OR IGNORE INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
      SELECT assertion_id, transaction_id, field_name, 'transaction', 'user', user_id, 'user/local', NULL, value_text, commit_id FROM user_assertions`);
  }
  if (tableExists(db, "derived_assertion_lifecycle_events")) {
    db.exec(`INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind)
      SELECT event.event_id, event.assertion_id, event.transaction_id, event.field_name, NULL, NULL, event.run_id, event.coordinate_id, NULL, event.commit_id, event.event_kind
      FROM derived_assertion_lifecycle_events event
      WHERE NOT EXISTS (SELECT 1 FROM assertion_transitions existing
        WHERE existing.assertion_id = event.assertion_id AND existing.transaction_id = event.transaction_id
          AND existing.field_name = event.field_name AND existing.run_id = event.run_id
          AND existing.coordinate_id IS event.coordinate_id AND existing.commit_id = event.commit_id
          AND existing.event_kind = event.event_kind)`);
  }
  if (tableExists(db, "user_assertion_lifecycle_events")) {
    db.exec(`INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind)
      SELECT event.event_id, event.assertion_id, event.transaction_id, event.field_name, NULL, NULL, NULL, NULL, event.user_id, event.commit_id, event.event_kind
      FROM user_assertion_lifecycle_events event
      WHERE NOT EXISTS (SELECT 1 FROM assertion_transitions existing
        WHERE existing.assertion_id = event.assertion_id AND existing.transaction_id = event.transaction_id
          AND existing.field_name = event.field_name AND existing.user_id IS event.user_id
          AND existing.commit_id = event.commit_id AND existing.event_kind = event.event_kind)`);
  }
  if (tableExists(db, "derived_assertion_provenance")) {
    db.exec(`INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
      SELECT provenance.assertion_id, NULL, provenance.run_id, provenance.coordinate_id, provenance.commit_id
      FROM derived_assertion_provenance provenance
      WHERE NOT EXISTS (SELECT 1 FROM assertion_provenance existing
        WHERE existing.assertion_id = provenance.assertion_id AND existing.source_record_id IS NULL
          AND existing.run_id = provenance.run_id AND existing.coordinate_id = provenance.coordinate_id
          AND existing.commit_id = provenance.commit_id)`);
  }
  if (tableExists(db, "user_assertion_provenance")) {
    db.exec(`INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
      SELECT provenance.assertion_id, NULL, NULL, NULL, provenance.commit_id
      FROM user_assertion_provenance provenance
      WHERE NOT EXISTS (SELECT 1 FROM assertion_provenance existing
        WHERE existing.assertion_id = provenance.assertion_id AND existing.source_record_id IS NULL
          AND existing.run_id IS NULL AND existing.coordinate_id IS NULL AND existing.commit_id = provenance.commit_id)`);
  }
}

function rebuildCurrentTransactionFieldsForSharedAssertions(
  db: DatabaseSync,
): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'current_transaction_fields'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (
    /derived_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(sql) &&
    /user_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(sql)
  )
    return;
  db.exec(`CREATE TABLE current_transaction_fields_shared (
    transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
    field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
    value_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
    derived_assertion_id BLOB REFERENCES assertions(assertion_id),
    user_assertion_id BLOB REFERENCES assertions(assertion_id),
    projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
    PRIMARY KEY(transaction_id, field_name),
    CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
      OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
  )`);
  db.exec(`INSERT INTO current_transaction_fields_shared(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
    SELECT transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields`);
  db.exec(
    "DROP TABLE current_transaction_fields; ALTER TABLE current_transaction_fields_shared RENAME TO current_transaction_fields",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_current_transaction_fields_projection ON current_transaction_fields(field_name, origin, projection_commit_id, transaction_id)",
  );
}

function ensureV6ProjectionOriginConstraints(db: DatabaseSync): void {
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_current_transaction_fields_origin_insert
    BEFORE INSERT ON current_transaction_fields
    WHEN NOT EXISTS (
      SELECT 1 FROM assertions assertion
      WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
        AND assertion.origin = NEW.origin
        AND assertion.transaction_id = NEW.transaction_id
        AND assertion.field_name = NEW.field_name
    )
    BEGIN SELECT RAISE(ABORT, 'current transaction field assertion origin mismatch'); END;
  CREATE TRIGGER IF NOT EXISTS trg_current_transaction_fields_origin_update
    BEFORE UPDATE OF transaction_id, field_name, origin, derived_assertion_id, user_assertion_id ON current_transaction_fields
    WHEN NOT EXISTS (
      SELECT 1 FROM assertions assertion
      WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
        AND assertion.origin = NEW.origin
        AND assertion.transaction_id = NEW.transaction_id
        AND assertion.field_name = NEW.field_name
    )
    BEGIN SELECT RAISE(ABORT, 'current transaction field assertion origin mismatch'); END;`);
}

function convertV6CompatibilityTables(db: DatabaseSync): void {
  backfillV6DerivedAndUserAssertions(db);
  const compatibilityViews: Array<{ name: string; select: string }> = [
    {
      name: "source_assertions",
      select: SOURCE_ASSERTIONS_COMPATIBILITY_SELECT,
    },
    {
      name: "derived_assertions",
      select: `SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name, assertion.producer_id,
        run.origin, assertion.rule_lineage, assertion.value_text, run.run_id, assertion.created_commit_id AS commit_id
        FROM assertions assertion JOIN derived_import_runs run ON run.commit_id = assertion.created_commit_id
          AND run.producer_id = assertion.producer_id AND run.rule_lineage = assertion.rule_lineage
        WHERE assertion.origin = 'derived'`,
    },
    {
      name: "user_assertions",
      select: `SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name, assertion.producer_id AS user_id,
        assertion.value_text, assertion.created_commit_id AS commit_id
        FROM assertions assertion WHERE assertion.origin = 'user'`,
    },
    {
      name: "assertion_lifecycle_events",
      select: `SELECT transition.event_id, transition.assertion_id, transition.transaction_id, assertion.revision_id,
        transition.capture_id, transition.scope_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'source'`,
    },
    {
      name: "derived_assertion_lifecycle_events",
      select: `SELECT transition.event_id, transition.assertion_id, transition.transaction_id, transition.field_name,
        transition.run_id, transition.coordinate_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'derived'`,
    },
    {
      name: "user_assertion_lifecycle_events",
      select: `SELECT transition.event_id, transition.assertion_id, transition.transaction_id, transition.field_name,
        transition.user_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'user'`,
    },
    {
      name: "derived_assertion_provenance",
      select: `SELECT provenance.assertion_id, provenance.run_id, provenance.coordinate_id, provenance.commit_id
        FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
        WHERE assertion.origin = 'derived' AND provenance.run_id IS NOT NULL`,
    },
    {
      name: "user_assertion_provenance",
      select: `SELECT provenance.assertion_id, provenance.commit_id
        FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
        WHERE assertion.origin = 'user' AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL`,
    },
  ];
  for (const compatibility of compatibilityViews) {
    if (relationType(db, compatibility.name) === "table") {
      if (
        compatibility.name === "source_assertions" &&
        !legacySourceAssertionsTableMatchesContract(db)
      )
        throw new Error(
          "Canonical legacy Source assertions table is malformed; refusing to convert it.",
        );
      const legacyName = `${compatibility.name}_compat_legacy`;
      db.exec(`ALTER TABLE ${compatibility.name} RENAME TO ${legacyName}`);
      db.exec(`CREATE VIEW ${compatibility.name} AS ${compatibility.select}`);
      db.exec(`DROP TABLE ${legacyName}`);
    } else if (
      relationType(db, compatibility.name) === "view" &&
      compatibility.name === "source_assertions"
    ) {
      if (!sourceAssertionsViewMatchesContract(db))
        rebuildCanonicalSourceAssertionsView(db);
    } else if (relationType(db, compatibility.name) === null) {
      db.exec(`CREATE VIEW ${compatibility.name} AS ${compatibility.select}`);
    }
  }
}

function ensureV6CompatibilitySchema(db: DatabaseSync): void {
  ensureV6SharedAssertionSpine(db);
  if (relationType(db, "assertion_lifecycle_events") !== "view")
    db.exec(SCHEMA_V6_APPEND);
  rebuildCurrentTransactionFieldsForSharedAssertions(db);
  convertV6CompatibilityTables(db);
}

function validateCanonicalCompatibilityViews(db: DatabaseSync): void {
  const compatibilityViews: Record<string, string[]> = {
    source_assertions: [
      "assertion_id",
      "transaction_id",
      "revision_id",
      "source_record_id",
      "commit_id",
    ],
    derived_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "producer_id",
      "origin",
      "rule_lineage",
      "value_text",
      "run_id",
      "commit_id",
    ],
    user_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "value_text",
      "commit_id",
    ],
    assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "revision_id",
      "capture_id",
      "scope_id",
      "commit_id",
      "event_kind",
    ],
    derived_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "run_id",
      "coordinate_id",
      "commit_id",
      "event_kind",
    ],
    user_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "commit_id",
      "event_kind",
    ],
    derived_assertion_provenance: [
      "assertion_id",
      "run_id",
      "coordinate_id",
      "commit_id",
    ],
    user_assertion_provenance: ["assertion_id", "commit_id"],
  };
  const authority: Record<string, RegExp> = {
    source_assertions: /FROM\s+assertions\b/i,
    derived_assertions: /FROM\s+assertions\b/i,
    user_assertions: /FROM\s+assertions\b/i,
    assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    user_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_provenance: /FROM\s+assertion_provenance\b/i,
    user_assertion_provenance: /FROM\s+assertion_provenance\b/i,
  };
  for (const [view, columns] of Object.entries(compatibilityViews)) {
    if (relationType(db, view) !== "view")
      throw new Error(
        `Canonical schema v6 compatibility relation ${view} is not a read-only view.`,
      );
    const actual = new Set(
      (
        db.prepare(`PRAGMA table_info(${view})`).all() as Array<{
          name?: string;
        }>
      ).map((column) => column.name),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(
          `Canonical schema v6 compatibility view ${view}.${column} is missing.`,
        );
    const sql = String(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?",
          )
          .get(view) as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    if (view === "source_assertions") {
      if (!sourceAssertionsViewMatchesContract(db))
        throw new Error(
          "Canonical schema v6 Source compatibility view does not preserve source origin and provenance semantics.",
        );
      continue;
    }
    if (!authority[view]!.test(sql))
      throw new Error(
        `Canonical schema v6 compatibility view ${view} is not backed by its shared authority.`,
      );
  }
}

function migrateV4ToV5(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
): void {
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
    const recordCount = Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM source_records").get() as {
          count?: number;
        }
      ).count ?? 0,
    );
    const mappedCount = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_record_scope_migration",
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (recordCount !== mappedCount)
      throw new Error(
        "v4 source records could not be deterministically mapped to capture scopes.",
      );
    const ambiguous = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM (SELECT source_record_id FROM source_record_scope_migration GROUP BY source_record_id HAVING COUNT(*) <> 1)",
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (ambiguous !== 0)
      throw new Error(
        "v4 source records have ambiguous capture scope identity.",
      );
    const projectionState = db
      .prepare(
        `SELECT state.commit_id, commit_row.commit_sequence FROM current_projection_state state
      JOIN canonical_commits commit_row ON commit_row.commit_id = state.commit_id WHERE state.generation = 1`,
      )
      .get() as { commit_id?: unknown; commit_sequence?: number } | undefined;
    const currentRowCount = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM current_transactions")
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (currentRowCount > 0 && !projectionState)
      throw new Error(
        "v4 current projection state is missing; restoration knowledge is ambiguous.",
      );
    const ambiguousRestorations = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (
      SELECT lifecycle.transaction_id, lifecycle.revision_id, commit_row.commit_sequence
      FROM assertion_lifecycle_events lifecycle JOIN canonical_commits commit_row ON commit_row.commit_id = lifecycle.commit_id
      WHERE lifecycle.event_kind = 'restored'
      GROUP BY lifecycle.transaction_id, lifecycle.revision_id, commit_row.commit_sequence HAVING COUNT(*) > 1
    )`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (ambiguousRestorations !== 0)
      throw new Error("v4 restoration projection knowledge is ambiguous.");
    db.exec(`CREATE TEMP TABLE current_projection_migration AS
      SELECT current_row.transaction_id, current_row.revision_id,
        COALESCE((SELECT lifecycle.commit_id FROM assertion_lifecycle_events lifecycle JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = lifecycle.commit_id
          WHERE lifecycle.event_kind = 'restored' AND lifecycle.transaction_id = current_row.transaction_id AND lifecycle.revision_id = current_row.revision_id
          ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC LIMIT 1), current_row.commit_id) AS projection_commit_id,
        revision.commit_id AS revision_commit_id
      FROM current_transactions current_row JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id`);
    if (projectionState) {
      if (projectionState.commit_sequence === undefined)
        throw new Error(
          "v4 current projection state sequence is missing; restoration knowledge is ambiguous.",
        );
      const outOfBounds = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM current_projection_migration migrated JOIN canonical_commits projection_commit ON projection_commit.commit_id = migrated.projection_commit_id WHERE projection_commit.commit_sequence > ?`,
            )
            .get(projectionState.commit_sequence) as { count?: number }
        ).count ?? 0,
      );
      if (outOfBounds !== 0)
        throw new Error(
          "v4 restoration projection knowledge exceeds current projection state.",
        );
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
    db.exec(
      "INSERT INTO source_records_v5(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) SELECT source_record_id, capture_id, commit_id, provider_sequence, description, payload_json FROM source_record_scope_migration",
    );
    if (injectMigrationFailure === "v4-v5-after-record-copy")
      throw new Error("Injected v4-v5 migration failure after record copy.");
    db.exec(
      "DROP TABLE source_records; DROP TABLE source_captures; ALTER TABLE source_captures_v5 RENAME TO source_captures; ALTER TABLE source_records_v5 RENAME TO source_records",
    );
    if (!columnExists(db, "capture_scopes", "scope_kind"))
      db.exec(
        "ALTER TABLE capture_scopes ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'bounded-range' CHECK(scope_kind = 'bounded-range')",
      );
    if (!columnExists(db, "transaction_revisions", "economic_status"))
      db.exec(
        "ALTER TABLE transaction_revisions ADD COLUMN economic_status TEXT NOT NULL DEFAULT 'normal' CHECK(economic_status IN ('normal','canceled','refund','reversal'))",
      );
    if (!columnExists(db, "transaction_revisions", "administrative_state"))
      db.exec(
        "ALTER TABLE transaction_revisions ADD COLUMN administrative_state TEXT NOT NULL DEFAULT 'active' CHECK(administrative_state IN ('active','deleted','purged'))",
      );
    if (!columnExists(db, "transaction_revisions", "semantic_rule_version"))
      db.exec(
        "ALTER TABLE transaction_revisions ADD COLUMN semantic_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
      );
    if (!columnExists(db, "current_transactions", "projection_commit_id"))
      db.exec(
        "ALTER TABLE current_transactions ADD COLUMN projection_commit_id BLOB REFERENCES canonical_commits(commit_id)",
      );
    if (!columnExists(db, "current_transactions", "revision_commit_id"))
      db.exec(
        "ALTER TABLE current_transactions ADD COLUMN revision_commit_id BLOB REFERENCES canonical_commits(commit_id)",
      );
    db.exec(
      "UPDATE current_transactions SET projection_commit_id = (SELECT migrated.projection_commit_id FROM current_projection_migration migrated WHERE migrated.transaction_id = current_transactions.transaction_id AND migrated.revision_id = current_transactions.revision_id), revision_commit_id = (SELECT migrated.revision_commit_id FROM current_projection_migration migrated WHERE migrated.transaction_id = current_transactions.transaction_id AND migrated.revision_id = current_transactions.revision_id)",
    );
    db.exec("UPDATE current_transactions SET commit_id = projection_commit_id");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_scopes_scope_capture ON capture_scopes(scope_id, capture_id); CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_scopes_scope_account ON capture_scopes(scope_id, account_id)",
    );
    db.exec(SCHEMA_V5_APPEND);
    db.exec(
      "INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, sequence_lexeme, commit_id) SELECT source_record_id, scope_id, capture_id, account_id, provider_sequence, commit_id FROM source_record_scope_migration",
    );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(5, currentUtcMicros());
    db.exec("PRAGMA user_version = 5");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV5ToV6(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
): void {
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
    db.exec(
      "DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_update; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_update",
    );
    db.exec(
      "DROP TABLE canonical_commits; ALTER TABLE canonical_commits_v6 RENAME TO canonical_commits",
    );
    ensureV6SharedAssertionSpine(db);
    db.exec(SCHEMA_V6_APPEND);
    rebuildCurrentTransactionFieldsForSharedAssertions(db);
    convertV6CompatibilityTables(db);
    ensureV6ProjectionOriginConstraints(db);
    if (injectMigrationFailure === "v5-v6-after-derived-schema")
      throw new Error("Injected v5-v6 migration failure after derived schema.");
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(6, currentUtcMicros());
    db.exec("PRAGMA user_version = 6");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV6ToV7(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
  transactionAlreadyOpen = false,
): void {
  if (!transactionAlreadyOpen) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
  }
  try {
    // The v6 commit-kind constraint predates projection switches. Rebuild the
    // small root table while all children are protected by this transaction.
    db.exec(`CREATE TABLE canonical_commits_v7 (
      commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16), commit_sequence INTEGER NOT NULL UNIQUE,
      recorded_at_utc_us INTEGER NOT NULL, authority_route TEXT NOT NULL,
      commit_kind TEXT NOT NULL CHECK(commit_kind IN ('source_capture','derived_import','user_assertion','projection_rebuild'))
    )`);
    db.exec("INSERT INTO canonical_commits_v7 SELECT * FROM canonical_commits");
    db.exec(
      "DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_update; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_update",
    );
    db.exec(
      "DROP TABLE canonical_commits; ALTER TABLE canonical_commits_v7 RENAME TO canonical_commits",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id)",
    );
    db.exec(SCHEMA_V7_APPEND);
    backfillProjectionProvenance(db);
    if (injectMigrationFailure === "v6-v7-after-generation-creation")
      throw new Error(
        "Injected v6-v7 migration failure after generation creation.",
      );

    const latest = db
      .prepare(
        "SELECT commit_id, commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
      )
      .get() as { commit_id?: unknown; commit_sequence?: number } | undefined;
    const latestCommit = latest?.commit_id ? blob(latest.commit_id) : undefined;
    let latestSequence = Number(latest?.commit_sequence ?? 0);
    const existingGeneration = db
      .prepare(
        `SELECT created_commit_id, switched_commit_id
      FROM projection_generations WHERE generation_id = 1`,
      )
      .get() as
      { created_commit_id?: unknown; switched_commit_id?: unknown } | undefined;
    const generationExists = Boolean(existingGeneration);
    // A pre-typed v7 database may already have an active generation whose
    // switch boundary is older than the latest routine commit. Migration must
    // preserve that immutable activation provenance; advancing the pointer to
    // the latest commit would make the trigger reject a valid database and
    // would silently turn a routine knowledge commit into a switch event.
    const generationSwitchCommit = existingGeneration?.switched_commit_id
      ? blob(existingGeneration.switched_commit_id)
      : latestCommit;
    if (!generationExists && latestCommit) {
      db.prepare(
        `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id, switched_commit_id)
      VALUES (1, 'active', ?, 'canonical/projection/v1', ?, ?, ?)`,
      ).run(
        latestSequence,
        latestCommit ?? null,
        latestCommit ?? null,
        latestCommit ?? null,
      );
      db.prepare(
        `INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id)
        SELECT 1, transaction_id, revision_id, projection_commit_id, revision_commit_id FROM current_transactions`,
      ).run();
      db.prepare(
        `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
        SELECT 1, transaction_id, revision_id, projection_commit_id, 'migration' FROM current_transactions`,
      ).run();
      db.prepare(
        `INSERT INTO projection_generation_transaction_fields(generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
        SELECT 1, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields`,
      ).run();
    }
    if (injectMigrationFailure === "v6-v7-after-generation-copy")
      throw new Error(
        "Injected v6-v7 migration failure after generation copy.",
      );
    const existingPointer = db
      .prepare(
        "SELECT switched_commit_id FROM active_projection_generation WHERE singleton_id = 1",
      )
      .get() as { switched_commit_id?: unknown } | undefined;
    if (
      existingGeneration &&
      existingPointer &&
      !canonicalIdsEqual(
        existingPointer.switched_commit_id,
        generationSwitchCommit,
      )
    ) {
      throw new Error(
        "Canonical v7 active projection pointer does not match its generation switch commit.",
      );
    }
    if (generationSwitchCommit) {
      db.prepare(
        `INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id)
        VALUES (1, 1, ?) ON CONFLICT(singleton_id) DO UPDATE SET generation_id = excluded.generation_id, switched_commit_id = excluded.switched_commit_id`,
      ).run(generationSwitchCommit);
      recordProjectionGenerationEventIfMissing(
        db,
        1,
        "created",
        "migration",
        generationSwitchCommit,
      );
      recordProjectionGenerationEventIfMissing(
        db,
        1,
        "validated",
        "migration",
        generationSwitchCommit,
      );
      recordProjectionGenerationEventIfMissing(
        db,
        1,
        "switched",
        "migration",
        generationSwitchCommit,
      );
    }
    if (latestCommit)
      db.prepare(
        "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id",
      ).run(latestCommit);
    if (injectMigrationFailure === "v6-v7-after-pointer")
      throw new Error("Injected v6-v7 migration failure after active pointer.");
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (7, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 7");
    if (!transactionAlreadyOpen) {
      db.exec("COMMIT");
      db.exec("PRAGMA foreign_keys = ON");
    }
  } catch (error) {
    if (!transactionAlreadyOpen) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON");
    }
    throw error;
  }
}

function validateGenerationExactAmounts(
  db: DatabaseSync,
  generationId: number,
): void {
  const rows = db
    .prepare(
      `SELECT revision.amount_coefficient, CAST(revision.amount_scale AS TEXT) AS amount_scale
    FROM projection_generation_transactions projected
    JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    WHERE projected.generation_id = ?`,
    )
    .all(generationId) as Array<{
    amount_coefficient?: unknown;
    amount_scale?: unknown;
  }>;
  if (
    rows.some(
      (row) =>
        !isCanonicalStoredExactAmount(row.amount_coefficient, row.amount_scale),
    )
  ) {
    throw new Error(
      "Canonical v7 projection contains non-exact arithmetic values.",
    );
  }
}

function validateCanonicalAuthorityRoutes(
  db: DatabaseSync,
  generationId: number,
): void {
  const invalid = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transactions projected
    WHERE projected.generation_id = ? AND NOT EXISTS (
      SELECT 1 FROM transaction_revisions revision
      JOIN source_captures capture ON capture.capture_id = revision.capture_id
      JOIN assertions source_assertion ON source_assertion.revision_id = revision.revision_id AND source_assertion.origin = 'source'
      JOIN source_authority_routes registered ON registered.authority_route = capture.authority_route
      WHERE revision.revision_id = projected.revision_id AND revision.transaction_id = projected.transaction_id
        AND (
          (capture.stream = ? AND registered.stream = ?)
          OR (capture.stream = 'credit-card' AND registered.stream = 'credit-card')
          OR (capture.stream = 'foreign-currency-deposit' AND registered.stream = 'foreign-currency-deposit')
          OR (capture.stream = 'loan' AND registered.stream = 'loan')
          OR (capture.stream = 'domestic-deposit' AND registered.stream = 'domestic-deposit')
        )
        AND source_assertion.producer_id = capture.authority_route
        AND source_assertion.rule_lineage IN (capture.authority_route, revision.semantic_rule_version)
        AND (
          (capture.authority_route = ?
            AND capture.completeness_rule_version = ?
            AND registered.integration_namespace = ?
            AND registered.contract_version = ?)
          OR
          (capture.authority_route = 'fubon/loan/canonical-v1'
            AND capture.completeness_rule_version = 'loan/canonical/v1.fubon'
            AND capture.stream = 'loan' AND registered.stream = 'loan'
            AND registered.integration_namespace = 'fubon'
            AND registered.contract_version = 'loan/canonical/v1.fubon')
          OR
          (capture.authority_route = 'fubon/loan/canonical-v2'
            AND capture.completeness_rule_version = 'loan/canonical/v2.fubon'
            AND capture.stream = 'loan' AND registered.stream = 'loan'
            AND registered.integration_namespace = 'fubon'
            AND registered.contract_version = 'loan/canonical/v2.fubon')
          OR
          (capture.authority_route = 'yuanta/loan/canonical-v1'
            AND capture.completeness_rule_version = 'loan/canonical/v1.yuanta'
            AND capture.stream = 'loan' AND registered.stream = 'loan'
            AND registered.integration_namespace = 'yuanta'
            AND registered.contract_version = 'loan/canonical/v1.yuanta')
          OR
          (capture.authority_route = 'fubon/loan/counterpart-deposit-v1'
            AND capture.completeness_rule_version = 'loan/counterpart/v1.fubon'
            AND capture.stream = 'domestic-deposit'
            AND registered.stream = 'domestic-deposit'
            AND registered.integration_namespace = 'fubon'
            AND registered.contract_version = 'loan/counterpart/v1.fubon')
          OR
          (capture.authority_route = 'yuanta/loan/counterpart-deposit-v1'
            AND capture.completeness_rule_version = 'loan/counterpart/v1.yuanta'
            AND capture.stream = 'domestic-deposit'
            AND registered.stream = 'domestic-deposit'
            AND registered.integration_namespace = 'yuanta'
            AND registered.contract_version = 'loan/counterpart/v1.yuanta')
          OR
          (capture.authority_route = 'fubon/credit-card/human-attested-v1'
            AND capture.completeness_rule_version = 'fubon/credit-card/human-attested-v1'
            AND capture.stream = 'credit-card'
            AND registered.stream = 'credit-card'
            AND registered.integration_namespace = 'fubon'
            AND registered.contract_version = 'fubon/credit-card/human-attested-v1')
          OR
          (capture.authority_route = 'fubon/credit-card/human-attested-v2'
            AND capture.completeness_rule_version = 'fubon/credit-card/human-attested-v2'
            AND capture.stream = 'credit-card'
            AND registered.stream = 'credit-card'
            AND registered.integration_namespace = 'fubon'
            AND registered.contract_version = 'fubon/credit-card/human-attested-v2')
          OR
          (capture.authority_route = 'esun/credit-card/human-attested-v1'
            AND capture.completeness_rule_version = 'esun/credit-card/human-attested-v1'
            AND capture.stream = 'credit-card'
            AND registered.stream = 'credit-card'
            AND registered.integration_namespace = 'esun'
            AND registered.contract_version = 'esun/credit-card/human-attested-v1')
          OR
          (capture.authority_route = 'esun/credit-card/human-attested-v2'
            AND capture.completeness_rule_version = 'esun/credit-card/human-attested-v2'
            AND capture.stream = 'credit-card'
            AND registered.stream = 'credit-card'
            AND registered.integration_namespace = 'esun'
            AND registered.contract_version = 'esun/credit-card/human-attested-v2')
          OR
          (capture.authority_route = 'yuanta/credit-card/human-attested-v1'
            AND capture.completeness_rule_version = 'yuanta/credit-card/human-attested-v1'
            AND capture.stream = 'credit-card'
            AND registered.stream = 'credit-card'
            AND registered.integration_namespace = 'yuanta'
            AND registered.contract_version = 'yuanta/credit-card/human-attested-v1')
          OR
          (capture.authority_route = 'yuanta/credit-card/human-attested-v2'
            AND capture.completeness_rule_version = 'yuanta/credit-card/human-attested-v2'
            AND capture.stream = 'credit-card'
            AND registered.stream = 'credit-card'
            AND registered.integration_namespace = 'yuanta'
            AND registered.contract_version = 'yuanta/credit-card/human-attested-v2')
          OR
          (capture.authority_route = 'linebank/domestic-deposit/human-attested-v13'
            AND capture.completeness_rule_version = 'linebank/domestic-deposit/human-attested-v13'
            AND registered.integration_namespace = 'linebank'
            AND registered.contract_version = 'human-attested-v13')
          OR
          (capture.authority_route = 'fubon/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'fubon/domestic-deposit/human-attested-v1'
            AND registered.integration_namespace = 'fubon'
            AND registered.contract_version = 'human-attested-v1')
          OR
          (capture.authority_route = 'yuanta/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'yuanta/domestic-deposit/human-attested-v1'
            AND registered.integration_namespace = 'yuanta'
            AND registered.contract_version = 'human-attested-v1')
          OR
          (capture.authority_route = 'yuanta/domestic-deposit/human-attested-v2'
            AND capture.completeness_rule_version = 'yuanta/domestic-deposit/human-attested-v2'
            AND registered.integration_namespace = 'yuanta'
            AND registered.contract_version = 'human-attested-v2')
          OR
          (capture.authority_route = 'hncb/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'hncb/domestic-deposit/human-attested-v1'
            AND registered.integration_namespace = 'hncb'
            AND registered.contract_version = 'human-attested-v1')
          OR
          (capture.authority_route = 'ctbc/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'ctbc/domestic-deposit/human-attested-v1'
            AND registered.integration_namespace = 'ctbc'
            AND registered.contract_version = 'human-attested-v1')
          OR
          (capture.authority_route = 'sinopac/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'sinopac/domestic-deposit/human-attested-v1'
            AND registered.integration_namespace = 'sinopac'
            AND registered.contract_version = 'human-attested-v1')
          OR
          (capture.authority_route = 'post/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'post/domestic-deposit/human-attested-v1'
            AND registered.integration_namespace = 'post'
            AND registered.contract_version = 'human-attested-v1')
          OR
          (capture.stream = 'foreign-currency-deposit'
            AND registered.stream = 'foreign-currency-deposit'
            AND capture.authority_route IN (${FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_ROUTES.map(() => "?").join(", ")})
            AND capture.completeness_rule_version LIKE 'foreign-currency/%'
            AND registered.contract_version = capture.completeness_rule_version)
        )
    )`,
        )
        .get(
          generationId,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_INTEGRATION_NAMESPACE,
          CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
          ...FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_ROUTES,
        ) as { count?: number }
    ).count ?? 0,
  );
  if (invalid !== 0)
    throw new Error(
      "Canonical v7 projection contains an unregistered or invalid financial authority route.",
    );
}

function canonicalIdsEqual(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array))
    return false;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

type ProjectionGenerationEventKind =
  "created" | "validated" | "switched" | "knowledge";
type ProjectionGenerationEventSource = "migration" | "rebuild" | "routine";

const PROJECTION_GENERATION_EVENT_ORDER: Record<
  ProjectionGenerationEventKind,
  number
> = {
  created: 0,
  validated: 1,
  switched: 2,
  knowledge: 3,
};

function projectionGenerationEventDigest(values: {
  generationId: number;
  ordinal: number;
  eventKind: ProjectionGenerationEventKind;
  eventSource: ProjectionGenerationEventSource;
  commitId: CanonicalId;
  previousEventId: CanonicalId | null;
}): Buffer {
  const previous = values.previousEventId
    ? Buffer.from(values.previousEventId).toString("hex")
    : "";
  const commit = Buffer.from(values.commitId).toString("hex");
  return createHash("sha256")
    .update(
      `canonical-projection-provenance/v1|${values.generationId}|${values.ordinal}|${values.eventKind}|${values.eventSource}|${commit}|${previous}`,
      "utf8",
    )
    .digest();
}

const PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS = [
  { name: "projection_generation_events_no_update", operation: "UPDATE" },
  { name: "projection_generation_events_no_delete", operation: "DELETE" },
] as const;

function ensureProjectionGenerationProvenanceTriggers(db: DatabaseSync): void {
  db.exec(
    "DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_update; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_delete",
  );
  for (const definition of PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS) {
    db.exec(`DROP TRIGGER IF EXISTS ${definition.name};
      CREATE TRIGGER ${definition.name}
      BEFORE ${definition.operation} ON projection_generation_provenance
      BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;`);
  }
}

function validateProjectionGenerationProvenanceTriggers(
  db: DatabaseSync,
): void {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.map(() => "?").join(", ")})`,
    )
    .all(
      ...PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.map(
        (definition) => definition.name,
      ),
    ) as Array<{ name?: string; sql?: string }>;
  const definitions = new Map(
    rows.map((row) => [String(row.name), String(row.sql)]),
  );
  const valid =
    definitions.size ===
      PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.length &&
    PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.every((definition) =>
      definitions
        .get(definition.name)
        ?.replaceAll(/\s+/g, " ")
        .toLowerCase()
        .includes(
          `create trigger ${definition.name} before ${definition.operation.toLowerCase()} on projection_generation_provenance`,
        ),
    ) &&
    [...definitions.values()].every((sql) =>
      /raise\s*\(\s*abort\s*,\s*'projection generation provenance is append-only'\s*\)/i.test(
        sql,
      ),
    );
  if (!valid) {
    throw new Error(
      "Canonical v7 projection provenance append-only triggers are missing or invalid.",
    );
  }
}

function ensureProjectionGenerationProvenanceSchema(db: DatabaseSync): boolean {
  const columns = new Set(
    (
      db
        .prepare("PRAGMA table_info(projection_generation_provenance)")
        .all() as Array<{ name?: string }>
    ).map((column) => String(column.name)),
  );
  const required = ["ordinal", "previous_event_id", "event_digest"];
  if (!required.some((column) => !columns.has(column))) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_ordinal ON projection_generation_provenance(generation_id, ordinal); CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_semantic ON projection_generation_provenance(generation_id, event_kind, event_source, commit_id);",
    );
    ensureProjectionGenerationProvenanceTriggers(db);
    return false;
  }

  // v7 databases created before the chain fields are upgraded in the same
  // migration transaction. Keep the legacy table beside the empty typed table;
  // rebuildLegacyProjectionProvenanceChains is the single planner/copier that
  // derives phases, ordinals, links, and digests before dropping the legacy
  // relation. This avoids a lossy first-pass chain followed by a second copy.
  db.exec(
    "DROP TRIGGER IF EXISTS projection_generation_events_no_update; DROP TRIGGER IF EXISTS projection_generation_events_no_delete; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_update; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_delete; ALTER TABLE projection_generation_provenance RENAME TO projection_generation_provenance_legacy",
  );
  db.exec(`CREATE TABLE projection_generation_provenance (
    event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
    generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    previous_event_id BLOB CHECK(previous_event_id IS NULL OR length(previous_event_id) = 16),
    event_kind TEXT NOT NULL CHECK(event_kind IN ('created','validated','switched','knowledge')),
    event_source TEXT NOT NULL CHECK(event_source IN ('migration','rebuild','routine')),
    commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
    event_digest BLOB NOT NULL CHECK(length(event_digest) = 32),
    UNIQUE(generation_id, ordinal),
    UNIQUE(generation_id, event_kind, event_source, commit_id)
  )`);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_ordinal ON projection_generation_provenance(generation_id, ordinal); CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_semantic ON projection_generation_provenance(generation_id, event_kind, event_source, commit_id);",
  );
  return true;
}

function recordProjectionGenerationEvent(
  db: DatabaseSync,
  generationId: number,
  eventKind: ProjectionGenerationEventKind,
  eventSource: ProjectionGenerationEventSource,
  commitId: CanonicalId,
): void {
  const last = db
    .prepare(
      `SELECT event_id, ordinal FROM projection_generation_provenance
    WHERE generation_id = ? ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(generationId) as { event_id?: unknown; ordinal?: number } | undefined;
  const ordinal = Number(last?.ordinal ?? 0) + 1;
  const previous = last?.event_id ? blob(last.event_id) : null;
  const eventId = uuidV7();
  db.prepare(
    `INSERT INTO projection_generation_provenance(
    event_id, generation_id, ordinal, previous_event_id, event_kind, event_source, commit_id, event_digest
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    generationId,
    ordinal,
    previous,
    eventKind,
    eventSource,
    commitId,
    projectionGenerationEventDigest({
      generationId,
      ordinal,
      eventKind,
      eventSource,
      commitId,
      previousEventId: previous,
    }),
  );
}

function recordProjectionGenerationEventIfMissing(
  db: DatabaseSync,
  generationId: number,
  eventKind: ProjectionGenerationEventKind,
  eventSource: ProjectionGenerationEventSource,
  commitId: CanonicalId,
): void {
  if (
    db
      .prepare(
        "SELECT 1 FROM projection_generation_provenance WHERE generation_id = ? AND event_kind = ?",
      )
      .get(generationId, eventKind)
  )
    return;
  recordProjectionGenerationEvent(
    db,
    generationId,
    eventKind,
    eventSource,
    commitId,
  );
}

/** Complete a legacy chain only while its pre-chain table is being upgraded.
 * The generation state and immutable canonical commits provide the missing
 * phases; the resulting ordinals, links, and digests are rebuilt as one
 * migration operation. Current chains are never repaired on ordinary startup.
 */
function rebuildLegacyProjectionProvenanceChains(db: DatabaseSync): void {
  const generations = db
    .prepare(
      `SELECT generation_id, status, build_cutoff_commit_sequence,
      created_commit_id, validated_commit_id, switched_commit_id
    FROM projection_generations ORDER BY generation_id`,
    )
    .all() as Array<Record<string, unknown>>;
  const sourceTable = relationType(
    db,
    "projection_generation_provenance_legacy",
  )
    ? "projection_generation_provenance_legacy"
    : "projection_generation_provenance";
  const events = db
    .prepare(
      `SELECT rowid AS row_id, event_id, generation_id, event_kind, event_source, commit_id
    FROM ${sourceTable} ORDER BY generation_id, rowid`,
    )
    .all() as Array<Record<string, unknown>>;
  const switchedByGeneration = new Map(
    (
      db
        .prepare(
          "SELECT generation_id, switched_commit_id FROM projection_generations",
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter(
        (row) =>
          row.switched_commit_id !== null &&
          row.switched_commit_id !== undefined,
      )
      .map(
        (row) =>
          [Number(row.generation_id), blob(row.switched_commit_id)] as const,
      ),
  );
  // The first v7 runtime recorded activation as both `switched` and a routine
  // `knowledge` event. It carried no additional knowledge advance, so the
  // single planner normalizes that legacy duplicate before copying.
  const normalizedEvents = events.filter(
    (row) =>
      row.event_kind !== "knowledge" ||
      !canonicalIdsEqual(
        blob(row.commit_id),
        switchedByGeneration.get(Number(row.generation_id)),
      ),
  );
  const commitInfo = (
    commitId: CanonicalId,
  ): { sequence: number; kind: string } => {
    const row = db
      .prepare(
        "SELECT commit_sequence, commit_kind FROM canonical_commits WHERE commit_id = ?",
      )
      .get(commitId) as
      { commit_sequence?: number; commit_kind?: string } | undefined;
    if (!row)
      throw new Error(
        "Legacy projection provenance references an unknown commit.",
      );
    return {
      sequence: Number(row.commit_sequence),
      kind: String(row.commit_kind),
    };
  };
  const inferSource = (
    commitId: CanonicalId,
  ): ProjectionGenerationEventSource =>
    commitInfo(commitId).kind === "projection_rebuild"
      ? "rebuild"
      : "migration";
  const planned = new Map<
    number,
    Array<{
      eventId: CanonicalId;
      eventKind: ProjectionGenerationEventKind;
      eventSource: ProjectionGenerationEventSource;
      commitId: CanonicalId;
      sequence: number;
    }>
  >();
  for (const generation of generations) {
    const generationId = Number(generation.generation_id);
    const generationEvents = normalizedEvents.filter(
      (event) => Number(event.generation_id) === generationId,
    );
    const phases = new Map<
      ProjectionGenerationEventKind,
      Record<string, unknown>
    >();
    for (const event of generationEvents) {
      const kind = String(event.event_kind) as ProjectionGenerationEventKind;
      if (!(
        kind === "created" ||
        kind === "validated" ||
        kind === "switched" ||
        kind === "knowledge"
      ))
        throw new Error("Legacy projection provenance has an unknown phase.");
      if (kind !== "knowledge" && phases.has(kind))
        throw new Error(
          "Legacy projection provenance has duplicate generation phases.",
        );
      if (kind !== "knowledge") phases.set(kind, event);
    }
    const required =
      generation.status === "building"
        ? ["created"]
        : generation.status === "validated"
          ? ["created", "validated"]
          : ["created", "validated", "switched"];
    const stateCommit: Record<string, unknown> = {
      created: generation.created_commit_id,
      validated: generation.validated_commit_id,
      switched: generation.switched_commit_id,
    };
    const rows: Array<{
      eventId: CanonicalId;
      eventKind: ProjectionGenerationEventKind;
      eventSource: ProjectionGenerationEventSource;
      commitId: CanonicalId;
      sequence: number;
    }> = [];
    const existingPhaseSources = [...phases.values()].map(
      (event) => String(event.event_source) as ProjectionGenerationEventSource,
    );
    if (new Set(existingPhaseSources).size > 1)
      throw new Error("Legacy projection phase sources are inconsistent.");
    let phaseSource: ProjectionGenerationEventSource | undefined =
      existingPhaseSources[0];
    let phaseCommit: CanonicalId | undefined;
    for (const phaseName of required as ProjectionGenerationEventKind[]) {
      const commitValue = stateCommit[phaseName];
      if (commitValue === null || commitValue === undefined)
        throw new Error(
          `Legacy projection generation ${generationId} is missing its ${phaseName} commit.`,
        );
      const commitId = blob(commitValue);
      const existing = phases.get(phaseName);
      if (existing && !canonicalIdsEqual(existing.commit_id, commitId))
        throw new Error(
          `Legacy projection ${phaseName} phase disagrees with generation state.`,
        );
      const eventSource: ProjectionGenerationEventSource = existing
        ? (String(existing.event_source) as ProjectionGenerationEventSource)
        : (phaseSource ?? inferSource(commitId));
      if (!(
        eventSource === "migration" ||
        eventSource === "rebuild" ||
        eventSource === "routine"
      ))
        throw new Error("Legacy projection phase source is invalid.");
      if (phaseSource && phaseSource !== eventSource)
        throw new Error("Legacy projection phase sources are inconsistent.");
      if (phaseCommit && !canonicalIdsEqual(phaseCommit, commitId))
        throw new Error("Legacy projection phase commits are inconsistent.");
      phaseSource = eventSource;
      phaseCommit = commitId;
      const info = commitInfo(commitId);
      rows.push({
        eventId: existing ? blob(existing.event_id) : uuidV7(),
        eventKind: phaseName,
        eventSource,
        commitId,
        sequence: info.sequence,
      });
    }
    if (
      generation.status === "building" &&
      generationEvents.some((event) => event.event_kind !== "created")
    )
      throw new Error(
        "Legacy building projection generation has unexpected phases.",
      );
    const switched = rows.find((row) => row.eventKind === "switched");
    const switchedSequence = switched?.sequence ?? Number.POSITIVE_INFINITY;
    const cutoff = Number(generation.build_cutoff_commit_sequence ?? -1);
    const knowledge = generationEvents
      .filter((event) => event.event_kind === "knowledge")
      .map((event) => {
        const commitId = blob(event.commit_id);
        const info = commitInfo(commitId);
        return {
          eventId: blob(event.event_id),
          eventKind: "knowledge" as const,
          eventSource: String(
            event.event_source,
          ) as ProjectionGenerationEventSource,
          commitId,
          sequence: info.sequence,
        };
      });
    const knowledgeKeys = new Set<string>();
    for (const event of knowledge) {
      const key = event.commitId.toString("hex");
      if (knowledgeKeys.has(key))
        throw new Error(
          "Legacy projection provenance has duplicate knowledge events.",
        );
      knowledgeKeys.add(key);
      if (event.sequence <= switchedSequence && event.sequence <= cutoff)
        throw new Error(
          "Legacy projection knowledge event precedes its switch boundary.",
        );
      if (event.sequence > cutoff)
        throw new Error(
          "Legacy projection knowledge event exceeds its generation cutoff.",
        );
      rows.push(event);
    }
    if (switched) {
      const expected = (
        db
          .prepare(
            `SELECT commit_id, commit_sequence, commit_kind FROM canonical_commits
        WHERE commit_sequence > ? AND commit_sequence <= ? AND commit_kind <> 'projection_rebuild' ORDER BY commit_sequence`,
          )
          .all(switched.sequence, cutoff) as Array<Record<string, unknown>>
      ).filter((commit) =>
        canonicalCommitHasEvidence(
          db,
          String(commit.commit_kind),
          blob(commit.commit_id),
        ),
      );
      for (const commit of expected) {
        const commitId = blob(commit.commit_id);
        const key = commitId.toString("hex");
        if (knowledgeKeys.has(key)) continue;
        knowledgeKeys.add(key);
        rows.push({
          eventId: uuidV7(),
          eventKind: "knowledge",
          eventSource: "routine",
          commitId,
          sequence: Number(commit.commit_sequence),
        });
      }
    }
    rows.sort((left, right) =>
      left.eventKind === "knowledge" && right.eventKind !== "knowledge"
        ? 1
        : left.eventKind !== "knowledge" && right.eventKind === "knowledge"
          ? -1
          : left.eventKind === "knowledge" && right.eventKind === "knowledge"
            ? left.sequence - right.sequence
            : PROJECTION_GENERATION_EVENT_ORDER[left.eventKind] -
              PROJECTION_GENERATION_EVENT_ORDER[right.eventKind],
    );
    planned.set(generationId, rows);
  }
  db.exec(
    "DROP TRIGGER IF EXISTS projection_generation_events_no_update; DROP TRIGGER IF EXISTS projection_generation_events_no_delete; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_update; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_delete; DELETE FROM projection_generation_provenance",
  );
  const insert =
    db.prepare(`INSERT INTO projection_generation_provenance(event_id, generation_id, ordinal, previous_event_id, event_kind, event_source, commit_id, event_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [generationId, rows] of planned) {
    let previous: CanonicalId | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const ordinal = index + 1;
      insert.run(
        row.eventId,
        generationId,
        ordinal,
        previous,
        row.eventKind,
        row.eventSource,
        row.commitId,
        projectionGenerationEventDigest({
          generationId,
          ordinal,
          eventKind: row.eventKind,
          eventSource: row.eventSource,
          commitId: row.commitId,
          previousEventId: previous,
        }),
      );
      previous = row.eventId;
    }
  }
  if (sourceTable === "projection_generation_provenance_legacy")
    db.exec("DROP TABLE projection_generation_provenance_legacy");
  ensureProjectionGenerationProvenanceTriggers(db);
}

/** Existing v7 databases predate the typed provenance tables. Backfill only
 * from persisted generation/current rows; no synthetic canonical commit is
 * created, and all future changes use append-only events. */
function backfillProjectionProvenance(db: DatabaseSync): void {
  const upgradedLegacy = ensureProjectionGenerationProvenanceSchema(db);
  if (upgradedLegacy) rebuildLegacyProjectionProvenanceChains(db);
  const generations = db
    .prepare(
      `SELECT generation_id, created_commit_id, validated_commit_id, switched_commit_id
    FROM projection_generations ORDER BY generation_id`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const generation of generations) {
    const generationId = Number(generation.generation_id);
    const selectionCount = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_generation_transaction_selection WHERE generation_id = ?",
          )
          .get(generationId) as { count?: number }
      ).count ?? 0,
    );
    if (selectionCount === 0) {
      db.prepare(
        `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
        SELECT projected.generation_id, projected.transaction_id, projected.revision_id, projected.projection_commit_id, 'migration'
        FROM projection_generation_transactions projected WHERE projected.generation_id = ?`,
      ).run(generationId);
    }
  }
}

function projectionIdentityKey(row: {
  transaction_id?: unknown;
  revision_id?: unknown;
}): string {
  return `${blob(row.transaction_id).toString("hex")}:${blob(row.revision_id).toString("hex")}`;
}

/** Rebuild population is intentionally allowed to omit malformed evidence;
 * this calculator derives the expected set from immutable revision/scope rows,
 * not from the Source Assertion join used by the population query. */
function expectedGenerationTransactions(
  db: DatabaseSync,
  cutoff: number,
): Array<{
  transaction_id?: unknown;
  revision_id?: unknown;
  selection_commit_id?: unknown;
}> {
  return db
    .prepare(
      `SELECT transaction_row.transaction_id, revision.revision_id,
      (SELECT transition.commit_id FROM assertions source_assertion
        JOIN assertion_transitions transition ON transition.assertion_id = source_assertion.assertion_id
        JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
        WHERE source_assertion.origin = 'source' AND source_assertion.revision_id = revision.revision_id
          AND transition_commit.commit_sequence <= ?
        ORDER BY transition_commit.commit_sequence DESC, transition.rowid DESC LIMIT 1) AS selection_commit_id
    FROM financial_transactions transaction_row
    JOIN transaction_revisions revision ON revision.transaction_id = transaction_row.transaction_id
    JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
    JOIN source_captures capture ON capture.capture_id = revision.capture_id
    JOIN source_records source_record ON source_record.source_record_id = revision.source_record_id AND source_record.capture_id = revision.capture_id
    JOIN source_record_scopes source_scope ON source_scope.source_record_id = source_record.source_record_id AND source_scope.capture_id = source_record.capture_id AND source_scope.sequence_lexeme = source_record.sequence_lexeme
    JOIN capture_scopes scope ON scope.scope_id = source_scope.scope_id AND scope.capture_id = source_scope.capture_id AND scope.account_id = transaction_row.account_id
    WHERE revision_commit.commit_sequence <= ?
      AND NOT EXISTS (SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
        WHERE newer.transaction_id = revision.transaction_id AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > revision_commit.commit_sequence)
      AND COALESCE((SELECT transition.event_kind FROM assertions source_assertion
        JOIN assertion_transitions transition ON transition.assertion_id = source_assertion.assertion_id
        JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
        WHERE source_assertion.origin = 'source' AND source_assertion.revision_id = revision.revision_id
          AND transition_commit.commit_sequence <= ?
        ORDER BY transition_commit.commit_sequence DESC, transition.rowid DESC LIMIT 1), 'observed') <> 'withdrawn'`,
    )
    .all(cutoff, cutoff, cutoff, cutoff) as Array<{
    transaction_id?: unknown;
    revision_id?: unknown;
    selection_commit_id?: unknown;
  }>;
}

function validateGenerationTransactionIntegrity(
  db: DatabaseSync,
  generationId: number,
  cutoff: number,
): void {
  const expected = expectedGenerationTransactions(db, cutoff);
  const actual = db
    .prepare(
      "SELECT transaction_id, revision_id FROM projection_generation_transactions WHERE generation_id = ?",
    )
    .all(generationId) as Array<{
    transaction_id?: unknown;
    revision_id?: unknown;
  }>;
  const expectedKeys = new Set(expected.map(projectionIdentityKey));
  const actualKeys = new Set(actual.map(projectionIdentityKey));
  const missing = [...expectedKeys].filter((key) => !actualKeys.has(key));
  const extra = [...actualKeys].filter((key) => !expectedKeys.has(key));
  if (
    missing.length !== 0 ||
    extra.length !== 0 ||
    expectedKeys.size !== actualKeys.size
  ) {
    throw new Error(
      `Projection rebuild completeness mismatch: missing=${missing.length}, extra=${extra.length}.`,
    );
  }
  const expectedByKey = new Map(
    expected.map((row) => [projectionIdentityKey(row), row]),
  );
  const rows = db
    .prepare(
      `SELECT projected.transaction_id, projected.revision_id, projected.projection_commit_id, projected.revision_commit_id,
      selection.selection_commit_id, selection.selection_kind,
      revision.transaction_id AS revision_transaction_id, revision.commit_id AS source_revision_commit_id,
      generation.created_commit_id AS generation_created_commit_id,
      revision_commit.commit_sequence AS revision_commit_sequence, projection_commit.commit_sequence AS projection_commit_sequence,
      selection_commit.commit_sequence AS selection_commit_sequence
    FROM projection_generation_transactions projected
    LEFT JOIN projection_generation_transaction_selection selection
      ON selection.generation_id = projected.generation_id AND selection.transaction_id = projected.transaction_id
    JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
    JOIN canonical_commits projection_commit ON projection_commit.commit_id = projected.projection_commit_id
    JOIN projection_generations generation ON generation.generation_id = projected.generation_id
    LEFT JOIN canonical_commits selection_commit ON selection_commit.commit_id = selection.selection_commit_id
    WHERE projected.generation_id = ?`,
    )
    .all(generationId) as Array<Record<string, unknown>>;
  if (
    rows.some((row) => {
      const expectedRow = expectedByKey.get(projectionIdentityKey(row));
      const rebuildSelection = row.selection_kind === "rebuild";
      const expectedSelection = expectedRow?.selection_commit_id;
      const selectionMatches =
        row.selection_commit_id !== undefined &&
        row.selection_commit_id !== null &&
        canonicalIdsEqual(row.selection_commit_id, row.projection_commit_id) &&
        (rebuildSelection
          ? canonicalIdsEqual(
              row.selection_commit_id,
              row.generation_created_commit_id,
            )
          : row.selection_kind === "migration"
            ? canonicalIdsEqual(row.selection_commit_id, expectedSelection) ||
              canonicalIdsEqual(
                row.selection_commit_id,
                row.generation_created_commit_id,
              )
            : expectedSelection !== undefined &&
              expectedSelection !== null &&
              canonicalIdsEqual(row.selection_commit_id, expectedSelection));
      return (
        !expectedRow ||
        !canonicalIdsEqual(row.revision_transaction_id, row.transaction_id) ||
        !canonicalIdsEqual(
          row.revision_commit_id,
          row.source_revision_commit_id,
        ) ||
        !selectionMatches ||
        row.selection_commit_sequence === undefined ||
        row.selection_commit_sequence === null ||
        Number(row.selection_commit_sequence) <
          Number(row.revision_commit_sequence)
      );
    })
  ) {
    throw new Error(
      "Canonical v7 projection transaction commit semantics are invalid.",
    );
  }
}

function validateGenerationFieldIntegrity(
  db: DatabaseSync,
  generationId: number,
): void {
  const rows = db
    .prepare(
      `SELECT field.generation_id, field.transaction_id, field.field_name, field.value_text, field.origin,
      field.derived_assertion_id, field.user_assertion_id, field.projection_commit_id,
      generation.build_cutoff_commit_sequence, generation.created_commit_id AS generation_created_commit_id,
      generation.switched_commit_id AS generation_switched_commit_id,
      assertion.assertion_id, assertion.transaction_id AS assertion_transaction_id, assertion.field_name AS assertion_field_name,
      assertion.origin AS assertion_origin, assertion.producer_id AS assertion_producer_id, assertion.rule_lineage AS assertion_rule_lineage,
      assertion.value_text AS assertion_value_text, assertion.created_commit_id AS assertion_created_commit_id,
      assertion_commit.commit_sequence AS assertion_commit_sequence, assertion_commit.authority_route AS assertion_authority_route,
      projected.transaction_id AS projected_transaction_id, projected.revision_id AS projected_revision_id,
      projected.projection_commit_id AS projected_projection_commit_id, projected.revision_commit_id AS projected_revision_commit_id,
      revision.transaction_id AS revision_transaction_id, revision.commit_id AS revision_commit_id,
      revision_commit.commit_sequence AS revision_commit_sequence,
      projection_commit.commit_sequence AS projection_commit_sequence,
      projection_commit.commit_kind AS projection_commit_kind,
      projected_projection_commit.commit_sequence AS projected_projection_commit_sequence,
      upper_commit.commit_sequence AS upper_commit_sequence,
      EXISTS (SELECT 1 FROM assertion_transitions projection_transition
        WHERE projection_transition.transaction_id = field.transaction_id
          AND projection_transition.field_name = field.field_name
          AND projection_transition.commit_id = field.projection_commit_id) AS projection_commit_is_field_event,
      (SELECT transition.event_kind FROM assertion_transitions transition JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
        WHERE transition.assertion_id = assertion.assertion_id AND transition_commit.commit_sequence <= generation.build_cutoff_commit_sequence
        ORDER BY transition_commit.commit_sequence DESC, transition.rowid DESC LIMIT 1) AS lifecycle_event,
      run.run_id, run.authority_route AS run_authority_route, run.stream AS run_stream, run.producer_id AS run_producer_id,
      run.origin AS run_origin, run.rule_lineage AS run_rule_lineage, run.status AS run_status,
      registered.integration_namespace AS registered_namespace, registered.stream AS registered_stream,
      registered.contract_version AS registered_contract_version
    FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    LEFT JOIN assertions assertion ON assertion.assertion_id = CASE WHEN field.origin = 'derived' THEN field.derived_assertion_id ELSE field.user_assertion_id END
    LEFT JOIN canonical_commits assertion_commit ON assertion_commit.commit_id = assertion.created_commit_id
    LEFT JOIN projection_generation_transactions projected ON projected.generation_id = field.generation_id AND projected.transaction_id = field.transaction_id
    LEFT JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    LEFT JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
    LEFT JOIN canonical_commits projection_commit ON projection_commit.commit_id = field.projection_commit_id
    LEFT JOIN canonical_commits projected_projection_commit ON projected_projection_commit.commit_id = projected.projection_commit_id
    LEFT JOIN active_projection_generation active_pointer ON active_pointer.singleton_id = 1 AND active_pointer.generation_id = generation.generation_id
    LEFT JOIN current_projection_state active_state ON active_state.generation = 1 AND active_pointer.generation_id IS NOT NULL
    LEFT JOIN canonical_commits upper_commit ON upper_commit.commit_id = COALESCE(active_state.commit_id, generation.switched_commit_id, generation.created_commit_id)
    LEFT JOIN derived_import_runs run ON run.commit_id = assertion.created_commit_id AND run.producer_id = assertion.producer_id AND run.rule_lineage = assertion.rule_lineage
    LEFT JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
    WHERE field.generation_id = ?`,
    )
    .all(generationId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const validLifecycle =
      row.lifecycle_event === "observed" || row.lifecycle_event === "restored";
    const assertionMatches =
      row.assertion_id !== undefined &&
      row.assertion_id !== null &&
      canonicalIdsEqual(row.assertion_transaction_id, row.transaction_id) &&
      row.assertion_field_name === row.field_name &&
      row.assertion_origin === row.origin &&
      row.assertion_value_text === row.value_text;
    const fieldProjectionSequence = Number(row.projection_commit_sequence);
    const projectedProjectionSequence = Number(
      row.projected_projection_commit_sequence,
    );
    const revisionSequence = Number(row.revision_commit_sequence);
    const assertionSequence = Number(row.assertion_commit_sequence);
    const upperSequence = Number(row.upper_commit_sequence);
    const projectionMatches =
      row.projection_commit_id !== undefined &&
      row.projection_commit_id !== null &&
      row.projected_projection_commit_id !== undefined &&
      row.projected_projection_commit_id !== null &&
      canonicalIdsEqual(
        row.projected_revision_commit_id,
        row.revision_commit_id,
      ) &&
      canonicalIdsEqual(row.revision_transaction_id, row.transaction_id) &&
      row.projected_transaction_id !== undefined &&
      row.projected_transaction_id !== null &&
      row.projection_commit_sequence !== undefined &&
      row.projection_commit_sequence !== null;
    const projectionCommitIsLegitimate =
      canonicalIdsEqual(
        row.projection_commit_id,
        row.assertion_created_commit_id,
      ) ||
      canonicalIdsEqual(
        row.projection_commit_id,
        row.generation_created_commit_id,
      ) ||
      row.projection_commit_kind === "projection_rebuild" ||
      Number(row.projection_commit_is_field_event) === 1;
    const commitSemantics =
      Number.isSafeInteger(fieldProjectionSequence) &&
      Number.isSafeInteger(projectedProjectionSequence) &&
      Number.isSafeInteger(revisionSequence) &&
      Number.isSafeInteger(assertionSequence) &&
      Number.isSafeInteger(upperSequence) &&
      fieldProjectionSequence >= assertionSequence &&
      fieldProjectionSequence <= upperSequence &&
      projectedProjectionSequence >= revisionSequence &&
      projectedProjectionSequence <= upperSequence;
    const assertionAsOfCutoff =
      row.assertion_commit_sequence !== undefined &&
      row.assertion_commit_sequence !== null &&
      Number(row.assertion_commit_sequence) <=
        Number(row.build_cutoff_commit_sequence);
    const authorityValid =
      row.origin === "user"
        ? row.assertion_rule_lineage === "user/local" &&
          row.assertion_authority_route === "user/local" &&
          typeof row.assertion_producer_id === "string" &&
          String(row.assertion_producer_id).length > 0
        : row.origin === "derived" &&
          row.assertion_authority_route === CATHAY_DOMESTIC_DEPOSIT_AUTHORITY &&
          row.assertion_producer_id === row.run_producer_id &&
          row.assertion_rule_lineage === row.run_rule_lineage &&
          row.run_authority_route === CATHAY_DOMESTIC_DEPOSIT_AUTHORITY &&
          row.run_stream === CATHAY_DOMESTIC_DEPOSIT_STREAM &&
          row.run_origin === CATHAY_DERIVED_ORIGIN &&
          row.run_status === "complete" &&
          row.registered_namespace === CATHAY_INTEGRATION_NAMESPACE &&
          row.registered_stream === CATHAY_DOMESTIC_DEPOSIT_STREAM &&
          row.registered_contract_version ===
            CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION;
    if (
      !assertionMatches ||
      !projectionMatches ||
      !projectionCommitIsLegitimate ||
      !commitSemantics ||
      !validLifecycle ||
      !assertionAsOfCutoff ||
      !authorityValid
    ) {
      throw new Error(
        "Canonical v7 projection field assertion integrity is invalid.",
      );
    }
  }
}

function validateGenerationFieldCompleteness(
  db: DatabaseSync,
  generationId: number,
  cutoff: number,
): void {
  const expected: string[] = [];
  for (const transaction of expectedGenerationTransactions(db, cutoff)) {
    const transactionId = blob(transaction.transaction_id);
    for (const field of ["display_name", "note"] as const) {
      const selected =
        selectAssertionAsOf(db, transactionId, field, cutoff, "user") ??
        selectAssertionAsOf(db, transactionId, field, cutoff, "derived");
      if (selected)
        expected.push(
          `${transactionId.toString("hex")}:${field}:${blob(selected.assertion_id).toString("hex")}:${selected.origin}:${selected.value_text}`,
        );
    }
  }
  const actualRows = db
    .prepare(
      `SELECT transaction_id, field_name, origin, value_text,
      CASE WHEN origin = 'derived' THEN derived_assertion_id ELSE user_assertion_id END AS assertion_id
    FROM projection_generation_transaction_fields WHERE generation_id = ?`,
    )
    .all(generationId) as Array<{
    transaction_id?: unknown;
    field_name?: unknown;
    origin?: unknown;
    value_text?: unknown;
    assertion_id?: unknown;
  }>;
  const actual = actualRows.map(
    (row) =>
      `${blob(row.transaction_id).toString("hex")}:${String(row.field_name)}:${blob(row.assertion_id).toString("hex")}:${String(row.origin)}:${String(row.value_text)}`,
  );
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((key) => !actualSet.has(key));
  const extra = [...actualSet].filter((key) => !expectedSet.has(key));
  if (
    missing.length !== 0 ||
    extra.length !== 0 ||
    expectedSet.size !== actualSet.size
  ) {
    throw new Error(
      `Canonical v7 projection field completeness mismatch: missing=${missing.length}, extra=${extra.length}.`,
    );
  }
}

/** Selected assertions are only readable when their typed provenance is still
 * present at the same Knowledge Point. This existence-aware gate deliberately
 * starts from selected projection rows, so unrelated historical assertions do
 * not become a false completeness requirement. */
function validateSelectedAssertionProvenance(
  db: DatabaseSync,
  generationId: number,
  cutoff: number,
): void {
  const invalidSource = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
    FROM projection_generation_transactions projected
    JOIN projection_generations generation ON generation.generation_id = projected.generation_id
    JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    LEFT JOIN assertions assertion ON assertion.revision_id = revision.revision_id AND assertion.origin = 'source'
    WHERE projected.generation_id = ? AND NOT EXISTS (
      SELECT 1 FROM assertion_provenance provenance
      JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
      JOIN source_records source_record ON source_record.source_record_id = provenance.source_record_id
      JOIN source_captures capture ON capture.capture_id = source_record.capture_id
      WHERE provenance.assertion_id = assertion.assertion_id
        AND provenance.source_record_id = revision.source_record_id
        AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL
        AND source_record.capture_id = revision.capture_id
        AND provenance_commit.commit_sequence <= ?
        AND provenance_commit.commit_kind = 'source_capture'
        AND provenance_commit.authority_route = capture.authority_route
        AND capture.commit_id = provenance.commit_id
        AND (
          capture.stream = ?
          OR capture.stream = 'credit-card'
          OR capture.stream = 'foreign-currency-deposit'
          OR capture.stream = 'loan'
          OR capture.stream = 'domestic-deposit'
        )
        AND (
          (capture.authority_route = ? AND capture.completeness_rule_version = ?)
          OR
          (capture.authority_route = 'fubon/loan/canonical-v1'
            AND capture.stream = 'loan'
            AND capture.completeness_rule_version = 'loan/canonical/v1.fubon')
          OR
          (capture.authority_route = 'fubon/loan/canonical-v2'
            AND capture.stream = 'loan'
            AND capture.completeness_rule_version = 'loan/canonical/v2.fubon')
          OR
          (capture.authority_route = 'yuanta/loan/canonical-v1'
            AND capture.stream = 'loan'
            AND capture.completeness_rule_version = 'loan/canonical/v1.yuanta')
          OR
          (capture.authority_route = 'fubon/loan/counterpart-deposit-v1'
            AND capture.stream = 'domestic-deposit'
            AND capture.completeness_rule_version = 'loan/counterpart/v1.fubon')
          OR
          (capture.authority_route = 'yuanta/loan/counterpart-deposit-v1'
            AND capture.stream = 'domestic-deposit'
            AND capture.completeness_rule_version = 'loan/counterpart/v1.yuanta')
          OR
          (capture.authority_route = 'fubon/credit-card/human-attested-v1'
            AND capture.stream = 'credit-card'
            AND capture.completeness_rule_version = 'fubon/credit-card/human-attested-v1')
          OR
          (capture.authority_route = 'fubon/credit-card/human-attested-v2'
            AND capture.stream = 'credit-card'
            AND capture.completeness_rule_version = 'fubon/credit-card/human-attested-v2')
          OR
          (capture.authority_route = 'esun/credit-card/human-attested-v1'
            AND capture.stream = 'credit-card'
            AND capture.completeness_rule_version = 'esun/credit-card/human-attested-v1')
          OR
          (capture.authority_route = 'esun/credit-card/human-attested-v2'
            AND capture.stream = 'credit-card'
            AND capture.completeness_rule_version = 'esun/credit-card/human-attested-v2')
          OR
          (capture.authority_route = 'yuanta/credit-card/human-attested-v1'
            AND capture.stream = 'credit-card'
            AND capture.completeness_rule_version = 'yuanta/credit-card/human-attested-v1')
          OR
          (capture.authority_route = 'yuanta/credit-card/human-attested-v2'
            AND capture.stream = 'credit-card'
            AND capture.completeness_rule_version = 'yuanta/credit-card/human-attested-v2')
          OR
          (capture.authority_route = 'linebank/domestic-deposit/human-attested-v13'
            AND capture.completeness_rule_version = 'linebank/domestic-deposit/human-attested-v13')
          OR
          (capture.authority_route = 'fubon/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'fubon/domestic-deposit/human-attested-v1')
          OR
          (capture.authority_route = 'yuanta/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'yuanta/domestic-deposit/human-attested-v1')
          OR
          (capture.authority_route = 'yuanta/domestic-deposit/human-attested-v2'
            AND capture.completeness_rule_version = 'yuanta/domestic-deposit/human-attested-v2')
          OR
          (capture.authority_route = 'hncb/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'hncb/domestic-deposit/human-attested-v1')
          OR
          (capture.authority_route = 'ctbc/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'ctbc/domestic-deposit/human-attested-v1')
          OR
          (capture.authority_route = 'sinopac/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'sinopac/domestic-deposit/human-attested-v1')
          OR
          (capture.authority_route = 'post/domestic-deposit/human-attested-v1'
            AND capture.completeness_rule_version = 'post/domestic-deposit/human-attested-v1')
          OR
          (capture.stream = 'foreign-currency-deposit'
            AND capture.authority_route IN (${FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_ROUTES.map(() => "?").join(", ")})
            AND capture.completeness_rule_version LIKE 'foreign-currency/%')
        )
    )`,
        )
        .get(
          generationId,
          cutoff,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          ...FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_ROUTES,
        ) as { count?: number }
    ).count ?? 0,
  );
  if (invalidSource !== 0)
    throw new Error(
      "Canonical v7 selected Source assertion provenance is incomplete.",
    );

  const invalidUserFields = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
    FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    LEFT JOIN assertions assertion ON assertion.assertion_id = field.user_assertion_id
    WHERE field.generation_id = ? AND field.origin = 'user' AND NOT EXISTS (
      SELECT 1 FROM assertion_provenance provenance
      JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
      WHERE provenance.assertion_id = assertion.assertion_id
        AND assertion.origin = 'user'
        AND assertion.transaction_id = field.transaction_id AND assertion.field_name = field.field_name
        AND provenance.source_record_id IS NULL AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL
        AND provenance_commit.commit_sequence <= ?
        AND provenance_commit.commit_kind = 'user_assertion' AND provenance_commit.authority_route = 'user/local'
    )`,
        )
        .get(generationId, cutoff) as { count?: number }
    ).count ?? 0,
  );
  const invalidDerivedFields = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
    FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    LEFT JOIN assertions assertion ON assertion.assertion_id = field.derived_assertion_id
    WHERE field.generation_id = ? AND field.origin = 'derived' AND NOT EXISTS (
      SELECT 1 FROM assertion_provenance provenance
      JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
      JOIN derived_import_runs run ON run.run_id = provenance.run_id
      JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = provenance.coordinate_id
      JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
      WHERE provenance.assertion_id = assertion.assertion_id
        AND provenance.source_record_id IS NULL AND provenance.run_id IS NOT NULL AND provenance.coordinate_id IS NOT NULL
        AND provenance_commit.commit_sequence <= ?
        AND provenance_commit.commit_kind = 'derived_import' AND provenance_commit.authority_route = ?
        AND run.commit_id = provenance.commit_id AND run.authority_route = ? AND run.stream = ?
        AND run.producer_id = assertion.producer_id AND run.origin = ? AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
        AND coordinate.run_id = run.run_id AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
        AND coordinate.producer_id = assertion.producer_id AND coordinate.origin = ? AND coordinate.rule_lineage = assertion.rule_lineage
        AND coordinate.output_state = 'supported'
        AND registered.integration_namespace = ? AND registered.stream = ? AND registered.contract_version = ?
    )`,
        )
        .get(
          generationId,
          cutoff,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_INTEGRATION_NAMESPACE,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        ) as { count?: number }
    ).count ?? 0,
  );
  const invalidFields = invalidUserFields + invalidDerivedFields;
  if (invalidFields !== 0)
    throw new Error(
      "Canonical v7 selected assertion provenance is incomplete.",
    );
}

function validateGenerationLifecycleCoordinates(
  db: DatabaseSync,
  generationId: number,
): void {
  const invalidTransitions = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    JOIN assertions assertion ON assertion.assertion_id = CASE WHEN field.origin = 'derived' THEN field.derived_assertion_id ELSE field.user_assertion_id END
    JOIN assertion_transitions transition ON transition.assertion_id = assertion.assertion_id
    JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
    WHERE field.generation_id = ? AND transition_commit.commit_sequence <= generation.build_cutoff_commit_sequence
      AND NOT (
        transition.transaction_id = assertion.transaction_id AND transition.field_name = assertion.field_name
        AND ((assertion.origin = 'user' AND transition.capture_id IS NULL AND transition.scope_id IS NULL
              AND transition.run_id IS NULL AND transition.coordinate_id IS NULL AND transition.user_id = assertion.producer_id
              AND transition_commit.authority_route = 'user/local')
          OR (assertion.origin = 'derived' AND transition.capture_id IS NULL AND transition.scope_id IS NULL
              AND transition.user_id IS NULL AND transition_commit.authority_route = ? AND EXISTS (
            SELECT 1 FROM derived_import_runs run
            JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = transition.coordinate_id
            JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
            WHERE run.run_id = transition.run_id AND coordinate.run_id = run.run_id
              AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
              AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
              AND run.authority_route = ? AND run.stream = ? AND run.producer_id = assertion.producer_id
              AND run.origin = ? AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
              AND registered.integration_namespace = ? AND registered.stream = ? AND registered.contract_version = ?
          )))
      )`,
        )
        .get(
          generationId,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_INTEGRATION_NAMESPACE,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        ) as { count?: number }
    ).count ?? 0,
  );
  if (invalidTransitions !== 0)
    throw new Error(
      "Canonical v7 selected assertion lifecycle coordinates are invalid.",
    );

  const invalidProvenance = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    JOIN assertions assertion ON assertion.assertion_id = CASE WHEN field.origin = 'derived' THEN field.derived_assertion_id ELSE field.user_assertion_id END
    LEFT JOIN assertion_provenance provenance ON provenance.assertion_id = assertion.assertion_id
    JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
    WHERE field.generation_id = ? AND provenance_commit.commit_sequence <= generation.build_cutoff_commit_sequence AND (
      (assertion.origin = 'user' AND provenance_commit.authority_route = 'user/local'
        AND (provenance.source_record_id IS NOT NULL OR provenance.run_id IS NOT NULL OR provenance.coordinate_id IS NOT NULL))
      OR (assertion.origin = 'derived' AND (provenance.source_record_id IS NOT NULL OR provenance_commit.authority_route <> 'cathay/domestic-deposit/v1' OR NOT EXISTS (
        SELECT 1 FROM derived_import_runs run
        JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = provenance.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = provenance.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = ? AND run.stream = ? AND run.producer_id = assertion.producer_id
          AND run.origin = ? AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = ? AND registered.stream = ? AND registered.contract_version = ?
      )))
    )`,
        )
        .get(
          generationId,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_INTEGRATION_NAMESPACE,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        ) as { count?: number }
    ).count ?? 0,
  );
  if (invalidProvenance !== 0)
    throw new Error(
      "Canonical v7 selected assertion provenance coordinates are invalid.",
    );
}

function isValidUserAssertionProvenanceEvidence(
  db: DatabaseSync,
  assertionId: CanonicalId,
  commitId: CanonicalId,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
    FROM assertion_provenance provenance
    JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id AND assertion.origin = 'user'
    JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
    JOIN canonical_commits created_commit ON created_commit.commit_id = assertion.created_commit_id
    WHERE provenance.assertion_id = ? AND provenance.commit_id = ?
      AND provenance.source_record_id IS NULL AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL
      AND provenance_commit.commit_kind = 'user_assertion' AND provenance_commit.authority_route = 'user/local'
      AND created_commit.commit_sequence <= provenance_commit.commit_sequence
      AND (
        assertion.created_commit_id = provenance.commit_id
        OR EXISTS (SELECT 1 FROM assertion_transitions transition
          WHERE transition.assertion_id = assertion.assertion_id AND transition.transaction_id = assertion.transaction_id
            AND transition.field_name = assertion.field_name AND transition.user_id = assertion.producer_id
            AND transition.commit_id = provenance.commit_id)
        OR EXISTS (SELECT 1 FROM assertion_transitions observed
          JOIN canonical_commits observed_commit ON observed_commit.commit_id = observed.commit_id
          WHERE observed.assertion_id = assertion.assertion_id AND observed.transaction_id = assertion.transaction_id
            AND observed.field_name = assertion.field_name AND observed.user_id = assertion.producer_id
            AND observed.event_kind = 'observed' AND observed_commit.commit_sequence <= provenance_commit.commit_sequence)
      )
      AND (
        EXISTS (SELECT 1 FROM assertion_transitions transition
          WHERE transition.assertion_id = assertion.assertion_id AND transition.commit_id = provenance.commit_id)
        OR COALESCE((SELECT latest.event_kind FROM assertion_transitions latest
          JOIN canonical_commits latest_commit ON latest_commit.commit_id = latest.commit_id
          WHERE latest.assertion_id = assertion.assertion_id AND latest_commit.commit_sequence <= provenance_commit.commit_sequence
          ORDER BY latest_commit.commit_sequence DESC, latest.event_id DESC LIMIT 1), 'observed') <> 'withdrawn'
      )
      AND NOT EXISTS (SELECT 1 FROM assertions newer
        JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.created_commit_id
        WHERE newer.origin = 'user' AND newer.transaction_id = assertion.transaction_id
          AND newer.field_name = assertion.field_name AND newer.producer_id = assertion.producer_id
          AND newer_commit.commit_sequence <= provenance_commit.commit_sequence
          AND newer_commit.commit_sequence > created_commit.commit_sequence)
    LIMIT 1`,
      )
      .get(assertionId, commitId),
  );
}

function canonicalCommitHasEvidence(
  db: DatabaseSync,
  commitKind: string,
  commitId: CanonicalId,
): boolean {
  if (commitKind === "source_capture") {
    const sourceOnlyAware = columnExists(db, "source_captures", "record_kind");
    return Boolean(
      db
        .prepare(
          sourceOnlyAware
            ? `SELECT 1 FROM source_captures capture
               WHERE capture.commit_id = ? AND (
                 capture.record_kind = 'cathay-domestic-deposit'
                 OR EXISTS (
                   SELECT 1 FROM capture_scopes scope
                   WHERE scope.capture_id = capture.capture_id
                     AND scope.account_id IS NOT NULL
                 )
               ) LIMIT 1`
            : "SELECT 1 FROM source_captures WHERE commit_id = ? LIMIT 1",
        )
        .get(commitId),
    );
  }
  if (commitKind === "derived_import")
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM derived_import_runs WHERE commit_id = ? LIMIT 1",
        )
        .get(commitId),
    );
  if (commitKind === "user_assertion") {
    if (
      db
        .prepare(
          `SELECT 1 FROM assertions
      WHERE origin = 'user' AND created_commit_id = ?
      UNION ALL SELECT 1 FROM assertion_transitions WHERE user_id IS NOT NULL AND commit_id = ? LIMIT 1`,
        )
        .get(commitId, commitId)
    )
      return true;
    const provenanceRows = db
      .prepare(
        `SELECT assertion_id FROM assertion_provenance
      WHERE commit_id = ? AND source_record_id IS NULL AND run_id IS NULL AND coordinate_id IS NULL`,
      )
      .all(commitId) as Array<{ assertion_id?: unknown }>;
    return provenanceRows.some((row) =>
      isValidUserAssertionProvenanceEvidence(
        db,
        blob(row.assertion_id),
        commitId,
      ),
    );
  }
  return false;
}

function projectionRelevantCommitCount(db: DatabaseSync): number {
  return (
    db
      .prepare(
        "SELECT commit_id, commit_kind FROM canonical_commits ORDER BY commit_sequence",
      )
      .all() as Array<{ commit_id?: unknown; commit_kind?: unknown }>
  ).filter((row) =>
    canonicalCommitHasEvidence(
      db,
      String(row.commit_kind),
      blob(row.commit_id),
    ),
  ).length;
}

function sourceOnlyCommitCount(db: DatabaseSync): number {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM canonical_commits commit_row
          WHERE commit_row.commit_kind = 'source_capture'
            AND EXISTS (
              SELECT 1 FROM source_captures capture
              WHERE capture.commit_id = commit_row.commit_id
                AND capture.source_subject_id IS NOT NULL
                AND capture.record_kind <> 'cathay-domestic-deposit'
            )`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
}

const CANONICAL_FINANCIAL_PROJECTION_TABLES = [
  "financial_accounts",
  "financial_transactions",
  "transaction_revisions",
  "transaction_time_observations",
  "assertions",
  "assertion_transitions",
  "assertion_provenance",
  "source_sync_states",
  "current_transactions",
  "current_projection_state",
  "derived_import_runs",
  "derived_scope_coordinates",
  "current_transaction_fields",
  "projection_generations",
  "projection_generation_provenance",
  "active_projection_generation",
  "projection_generation_transactions",
  "projection_generation_transaction_selection",
  "projection_generation_transaction_fields",
] as const;

function nonEmptyFinancialProjectionTables(db: DatabaseSync): string[] {
  return CANONICAL_FINANCIAL_PROJECTION_TABLES.filter(
    (table) =>
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count?: number;
          }
        ).count ?? 0,
      ) !== 0,
  );
}

function validateUserAssertionProvenanceAuthority(db: DatabaseSync): void {
  const invalid = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
    FROM assertions assertion
    JOIN assertion_provenance provenance ON provenance.assertion_id = assertion.assertion_id
    LEFT JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
    WHERE assertion.origin = 'user' AND (
      provenance.source_record_id IS NOT NULL OR provenance.run_id IS NOT NULL OR provenance.coordinate_id IS NOT NULL
      OR provenance.commit_id IS NULL
      OR provenance_commit.commit_id IS NULL
      OR provenance_commit.commit_kind <> 'user_assertion'
      OR provenance_commit.authority_route <> 'user/local'
      OR EXISTS (SELECT 1 FROM source_captures capture WHERE capture.commit_id = provenance.commit_id)
      OR EXISTS (SELECT 1 FROM derived_import_runs run WHERE run.commit_id = provenance.commit_id)
    )`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (invalid !== 0)
    throw new Error(
      "Canonical user assertion provenance authority is invalid.",
    );
  const provenanceRows = db
    .prepare(
      `SELECT provenance.assertion_id, provenance.commit_id
    FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
    WHERE assertion.origin = 'user'`,
    )
    .all() as Array<{ assertion_id?: unknown; commit_id?: unknown }>;
  if (
    provenanceRows.some(
      (row) =>
        !isValidUserAssertionProvenanceEvidence(
          db,
          blob(row.assertion_id),
          blob(row.commit_id),
        ),
    )
  ) {
    throw new Error(
      "Canonical user assertion provenance evidence is incomplete.",
    );
  }
}

const CANONICAL_EMPTY_STORE_TABLES = [
  "canonical_commits",
  "source_authority_routes",
  "source_connections",
  "identity_epochs",
  "source_captures",
  "source_records",
  "source_record_scopes",
  "financial_accounts",
  "financial_transactions",
  "transaction_revisions",
  "transaction_time_observations",
  "assertions",
  "assertion_transitions",
  "assertion_provenance",
  "source_sync_states",
  "current_transactions",
  "current_projection_state",
  "capture_scopes",
  "capture_scope_pages",
  "derived_import_runs",
  "derived_scope_coordinates",
  "derived_assertion_provenance",
  "derived_assertion_lifecycle_events",
  "user_assertion_lifecycle_events",
  "user_assertion_provenance",
  "current_transaction_fields",
  "projection_generations",
  "projection_generation_provenance",
  "active_projection_generation",
  "projection_generation_transactions",
  "projection_generation_transaction_selection",
  "projection_generation_transaction_fields",
] as const;

/** A fresh store is intentionally queryable before its first canonical commit.
 * Every evidence and projection relation must be empty together; accepting a
 * subset would turn a damaged initialization into a silently empty ledger. */
function validateEmptyCanonicalStore(db: DatabaseSync): void {
  const nonEmpty = CANONICAL_EMPTY_STORE_TABLES.filter(
    (table) =>
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count?: number;
          }
        ).count ?? 0,
      ) !== 0,
  );
  if (nonEmpty.length !== 0)
    throw new Error(
      `Canonical empty store is partial: ${nonEmpty.join(", ")}.`,
    );
}

function validateProjectionGenerationChain(
  db: DatabaseSync,
  generationId: number,
): Array<{
  event_kind?: string;
  event_source?: string;
  commit_id?: unknown;
  commit_sequence?: number;
}> {
  const generation = db
    .prepare(
      `SELECT status, build_cutoff_commit_sequence, created_commit_id, validated_commit_id, switched_commit_id
    FROM projection_generations WHERE generation_id = ?`,
    )
    .get(generationId) as
    | {
        status?: string;
        build_cutoff_commit_sequence?: number;
        created_commit_id?: unknown;
        validated_commit_id?: unknown;
        switched_commit_id?: unknown;
      }
    | undefined;
  if (!generation)
    throw new Error(
      "Canonical v7 projection generation provenance is missing.",
    );
  const events = db
    .prepare(
      `SELECT event.event_id, event.ordinal, event.previous_event_id, event.event_kind, event.event_source, event.commit_id, event.event_digest,
      commit_row.commit_sequence, commit_row.commit_kind, commit_row.authority_route
    FROM projection_generation_provenance event JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
    WHERE event.generation_id = ? ORDER BY event.ordinal`,
    )
    .all(generationId) as Array<Record<string, unknown>>;
  if (events.length === 0)
    throw new Error("Canonical v7 projection provenance chain is missing.");
  let previous: CanonicalId | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const row = events[index]!;
    const ordinal = Number(row.ordinal);
    const eventKind = String(row.event_kind) as ProjectionGenerationEventKind;
    const eventSource = String(
      row.event_source,
    ) as ProjectionGenerationEventSource;
    const commitId = blob(row.commit_id);
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal !== index + 1 ||
      (previous === null
        ? row.previous_event_id !== null
        : !canonicalIdsEqual(row.previous_event_id, previous))
    ) {
      throw new Error(
        "Canonical v7 projection provenance chain linkage is invalid.",
      );
    }
    const expectedDigest = projectionGenerationEventDigest({
      generationId,
      ordinal,
      eventKind,
      eventSource,
      commitId,
      previousEventId: previous,
    });
    if (!canonicalIdsEqual(row.event_digest, expectedDigest))
      throw new Error("Canonical v7 projection provenance digest is invalid.");
    if (
      !Object.prototype.hasOwnProperty.call(
        PROJECTION_GENERATION_EVENT_ORDER,
        eventKind,
      ) ||
      !Object.prototype.hasOwnProperty.call(
        { migration: true, rebuild: true, routine: true },
        eventSource,
      )
    ) {
      throw new Error(
        "Canonical v7 projection provenance phase or source is invalid.",
      );
    }
    const commitKind = String(row.commit_kind);
    const commitSequence = Number(row.commit_sequence);
    const isRebuild = commitKind === "projection_rebuild";
    if (eventSource === "rebuild") {
      if (
        !isRebuild ||
        eventKind === "knowledge" ||
        row.authority_route !== "canonical/projection/v1"
      ) {
        throw new Error("Canonical v7 rebuild provenance source is invalid.");
      }
    } else if (isRebuild) {
      throw new Error(
        "Canonical v7 projection rebuild commit has an invalid provenance source.",
      );
    } else if (eventKind === "knowledge" && eventSource !== "routine") {
      throw new Error(
        "Canonical v7 knowledge provenance must be a routine evidence event.",
      );
    } else if (
      eventSource === "routine" &&
      !canonicalCommitHasEvidence(db, commitKind, commitId)
    ) {
      throw new Error(
        "Canonical v7 routine provenance lacks canonical evidence.",
      );
    }
    if (
      eventKind !== "knowledge" &&
      eventKind !== "created" &&
      eventKind !== "validated" &&
      eventKind !== "switched"
    ) {
      throw new Error("Canonical v7 projection provenance phase is invalid.");
    }
    const cutoff = Number(generation.build_cutoff_commit_sequence ?? -1);
    if (
      eventKind === "knowledge" &&
      (!Number.isSafeInteger(commitSequence) || commitSequence > cutoff)
    ) {
      throw new Error(
        "Canonical v7 knowledge provenance exceeds its generation cutoff.",
      );
    }
    if (
      eventSource !== "rebuild" &&
      (!Number.isSafeInteger(commitSequence) || commitSequence > cutoff)
    ) {
      throw new Error(
        "Canonical v7 routine provenance exceeds its generation cutoff.",
      );
    }
    previous = blob(row.event_id);
  }

  const phaseEvents = events.filter(
    (event) => event.event_kind !== "knowledge",
  );
  const requiredPhases =
    generation.status === "building"
      ? ["created"]
      : generation.status === "validated"
        ? ["created", "validated"]
        : ["created", "validated", "switched"];
  if (
    phaseEvents.length !== requiredPhases.length ||
    phaseEvents.some(
      (event, index) => event.event_kind !== requiredPhases[index],
    ) ||
    events
      .slice(0, phaseEvents.length)
      .some((event, index) => event !== phaseEvents[index])
  ) {
    throw new Error(
      "Canonical v7 projection provenance phases are incomplete or out of order.",
    );
  }
  const phaseSource = phaseEvents[0]?.event_source;
  if (
    !phaseSource ||
    phaseEvents.some((event) => event.event_source !== phaseSource)
  )
    throw new Error("Canonical v7 projection phase sources are inconsistent.");
  const phaseCommit = phaseEvents[0]?.commit_id;
  if (
    !phaseCommit ||
    phaseEvents.some(
      (event) => !canonicalIdsEqual(event.commit_id, phaseCommit),
    )
  )
    throw new Error("Canonical v7 projection phase commits are inconsistent.");
  const requirePhase = (
    kind: ProjectionGenerationEventKind,
    commitId: unknown,
  ): void => {
    const phase = phaseEvents.find((event) => event.event_kind === kind);
    if (
      commitId === null ||
      commitId === undefined ||
      !phase ||
      !canonicalIdsEqual(phase.commit_id, commitId)
    ) {
      throw new Error(
        `Canonical v7 ${kind} provenance does not match generation state.`,
      );
    }
  };
  requirePhase("created", generation.created_commit_id);
  if (requiredPhases.includes("validated"))
    requirePhase("validated", generation.validated_commit_id);
  if (requiredPhases.includes("switched"))
    requirePhase("switched", generation.switched_commit_id);
  if (
    requiredPhases.length < 2 &&
    generation.validated_commit_id !== null &&
    generation.validated_commit_id !== undefined
  )
    throw new Error(
      "Canonical v7 building generation is unexpectedly validated.",
    );
  if (
    requiredPhases.length < 3 &&
    generation.switched_commit_id !== null &&
    generation.switched_commit_id !== undefined
  )
    throw new Error("Canonical v7 generation switched before activation.");

  const switched = phaseEvents.find((event) => event.event_kind === "switched");
  const switchedSequence = Number(switched?.commit_sequence ?? -1);
  const expectedRoutine = switched
    ? (
        db
          .prepare(
            `SELECT commit_id, commit_sequence, commit_kind FROM canonical_commits
        WHERE commit_sequence > ? AND commit_sequence <= ? AND commit_kind <> 'projection_rebuild'
        ORDER BY commit_sequence`,
          )
          .all(
            switchedSequence,
            Number(generation.build_cutoff_commit_sequence ?? -1),
          ) as Array<Record<string, unknown>>
      ).filter((commit) =>
        canonicalCommitHasEvidence(
          db,
          String(commit.commit_kind),
          blob(commit.commit_id),
        ),
      )
    : [];
  const knowledge = events.filter((event) => event.event_kind === "knowledge");
  if (
    knowledge.some(
      (event, index) =>
        index > 0 &&
        Number(event.commit_sequence) <=
          Number(knowledge[index - 1]!.commit_sequence),
    )
  ) {
    throw new Error("Canonical v7 knowledge provenance ordering is invalid.");
  }
  const expectedKeys = new Set(
    expectedRoutine.map((commit) =>
      Buffer.from(blob(commit.commit_id)).toString("hex"),
    ),
  );
  const actualKeys = new Set(
    knowledge.map((event) =>
      Buffer.from(blob(event.commit_id)).toString("hex"),
    ),
  );
  if (
    expectedKeys.size !== actualKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    throw new Error(
      "Canonical v7 projection knowledge event chain is incomplete.",
    );
  }
  if (
    switched &&
    switchedSequence <= Number(generation.build_cutoff_commit_sequence ?? -1)
  ) {
    const retirementSequence =
      generation.status === "retired"
        ? Number(
            (
              db
                .prepare(
                  `SELECT MIN(commit_row.commit_sequence) AS sequence FROM projection_generations later
          JOIN canonical_commits commit_row ON commit_row.commit_id = later.created_commit_id
          WHERE later.generation_id > ?`,
                )
                .get(generationId) as { sequence?: number } | undefined
            )?.sequence ?? -1,
          )
        : Number.POSITIVE_INFINITY;
    if (
      generation.status === "retired" &&
      (!Number.isSafeInteger(retirementSequence) ||
        retirementSequence <= switchedSequence)
    ) {
      throw new Error(
        "Canonical v7 retired generation has no immutable retirement boundary.",
      );
    }
    const evidenceSequences = (
      db
        .prepare(
          "SELECT commit_id, commit_sequence, commit_kind FROM canonical_commits ORDER BY commit_sequence",
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((commit) =>
        canonicalCommitHasEvidence(
          db,
          String(commit.commit_kind),
          blob(commit.commit_id),
        ),
      )
      .map((commit) => Number(commit.commit_sequence))
      .filter(
        (sequence) =>
          sequence >= switchedSequence && sequence < retirementSequence,
      );
    const latestEvidence = evidenceSequences.at(-1);
    if (latestEvidence !== Number(generation.build_cutoff_commit_sequence)) {
      throw new Error(
        "Canonical v7 generation cutoff does not terminate its provenance chain.",
      );
    }
  }
  return events as Array<{
    event_kind?: string;
    event_source?: string;
    commit_id?: unknown;
    commit_sequence?: number;
  }>;
}

function validateProjectionGenerationProvenance(
  db: DatabaseSync,
  generationId: number,
): void {
  const generations = db
    .prepare(
      "SELECT generation_id FROM projection_generations ORDER BY generation_id",
    )
    .all() as Array<{ generation_id?: number }>;
  for (const generation of generations)
    validateProjectionGenerationChain(db, Number(generation.generation_id));
  const activePointer = db
    .prepare(
      "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as { generation_id?: number } | undefined;
  if (!activePointer || Number(activePointer.generation_id) !== generationId)
    return;
  const commitCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const stateRows = db
    .prepare("SELECT generation, commit_id FROM current_projection_state")
    .all() as Array<{ generation?: number; commit_id?: unknown }>;
  const activeEvents = validateProjectionGenerationChain(db, generationId);
  if (commitCount === 0) {
    if (stateRows.length !== 0 || activeEvents.length !== 0)
      throw new Error(
        "Canonical v7 empty projection has unexpected provenance state.",
      );
    return;
  }
  if (
    stateRows.length !== 1 ||
    Number(stateRows[0]!.generation) !== 1 ||
    stateRows[0]!.commit_id === null ||
    stateRows[0]!.commit_id === undefined
  ) {
    throw new Error(
      "Canonical v7 current knowledge state is missing typed provenance.",
    );
  }
  const stateCommit = blob(stateRows[0]!.commit_id);
  const knowledgeEvents = activeEvents.filter(
    (event) =>
      event.event_kind === "switched" || event.event_kind === "knowledge",
  );
  const latestKnowledge = knowledgeEvents.at(-1);
  if (
    !latestKnowledge ||
    !canonicalIdsEqual(latestKnowledge.commit_id, stateCommit)
  ) {
    throw new Error(
      "Canonical v7 current knowledge state is not the latest active provenance event.",
    );
  }
}

/** A building/validated-unswitched generation is only legal inside the one
 * BEGIN IMMEDIATE rebuild transaction. Once committed, it is recovery
 * corruption; never retire or delete it implicitly. */
function rejectStrayProjectionGenerations(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT generation_id, status FROM projection_generations
    WHERE status = 'building' OR (status = 'validated' AND switched_commit_id IS NULL)
    ORDER BY generation_id`,
    )
    .all() as Array<{ generation_id?: number; status?: string }>;
  if (rows.length > 0)
    throw new Error(
      `Canonical v7 recovery found a persisted ${rows[0]!.status} generation ${rows[0]!.generation_id}.`,
    );
}

/** Validate the one switch boundary used by both writer and read-only startup.
 * This is intentionally a row-level gate: SQLite FKs can prove that a pointer
 * names a row, but cannot prove that the row is the sole active generation or
 * that all knowledge-state commits agree. */
function validateActiveProjectionBoundary(db: DatabaseSync): number {
  const commitCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (commitCount === 0) {
    validateEmptyCanonicalStore(db);
    return 0;
  }
  const projectionRelevantCommits = projectionRelevantCommitCount(db);
  const unexpectedFinancialRows = nonEmptyFinancialProjectionTables(db);
  if (projectionRelevantCommits === 0) {
    if (sourceOnlyCommitCount(db) !== commitCount)
      throw new Error(
        "Canonical source-only store contains a commit without durable source provenance evidence.",
      );
    if (unexpectedFinancialRows.length !== 0)
      throw new Error(
        `Canonical source-only store contains financial projection rows: ${unexpectedFinancialRows.join(", ")}.`,
      );
    return 0;
  }
  const pointer = db
    .prepare(
      "SELECT generation_id, switched_commit_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as
    { generation_id?: number; switched_commit_id?: unknown } | undefined;
  if (!pointer)
    throw new Error("Canonical v7 active projection pointer is missing.");
  const activeRows = db
    .prepare(
      "SELECT generation_id, switched_commit_id, build_cutoff_commit_sequence FROM projection_generations WHERE status = 'active'",
    )
    .all() as Array<{
    generation_id?: number;
    switched_commit_id?: unknown;
    build_cutoff_commit_sequence?: number;
  }>;
  if (activeRows.length !== 1)
    throw new Error("Canonical v7 active projection generation is ambiguous.");
  const active = activeRows[0]!;
  const generationId = Number(active.generation_id ?? 0);
  if (generationId <= 0 || Number(pointer.generation_id ?? 0) !== generationId)
    throw new Error(
      "Canonical v7 active projection pointer does not target the sole active generation.",
    );
  const stateRows = db
    .prepare("SELECT generation, commit_id FROM current_projection_state")
    .all() as Array<{ generation?: number; commit_id?: unknown }>;
  if (
    pointer.switched_commit_id === null ||
    pointer.switched_commit_id === undefined ||
    active.switched_commit_id === null ||
    active.switched_commit_id === undefined
  ) {
    throw new Error("Canonical v7 active projection switch commit is missing.");
  }
  if (!canonicalIdsEqual(pointer.switched_commit_id, active.switched_commit_id))
    throw new Error(
      "Canonical v7 active projection pointer does not match its generation switch commit.",
    );
  if (
    !db
      .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
      .get(blob(pointer.switched_commit_id))
  )
    throw new Error(
      "Canonical v7 active projection pointer references no commit.",
    );
  if (
    stateRows.length !== 1 ||
    Number(stateRows[0]!.generation) !== 1 ||
    stateRows[0]!.commit_id === null ||
    stateRows[0]!.commit_id === undefined ||
    !db
      .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
      .get(blob(stateRows[0]!.commit_id))
  ) {
    throw new Error(
      "Canonical v7 active projection knowledge state is missing or invalid.",
    );
  }
  const knowledgeSequence = Number(
    (
      db
        .prepare(
          "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?",
        )
        .get(blob(stateRows[0]!.commit_id)) as
        { commit_sequence?: number } | undefined
    )?.commit_sequence ?? -1,
  );
  if (knowledgeSequence < Number(active.build_cutoff_commit_sequence ?? 0))
    throw new Error(
      "Canonical v7 active projection knowledge precedes its cutoff.",
    );
  validateProjectionGenerationProvenance(db, generationId);
  validateGenerationExactAmounts(db, generationId);
  validateCanonicalAuthorityRoutes(db, generationId);
  const activeCutoff = Number(
    (
      db
        .prepare(
          "SELECT build_cutoff_commit_sequence FROM projection_generations WHERE generation_id = ?",
        )
        .get(generationId) as
        { build_cutoff_commit_sequence?: number } | undefined
    )?.build_cutoff_commit_sequence ?? 0,
  );
  validateGenerationTransactionIntegrity(db, generationId, activeCutoff);
  validateGenerationFieldCompleteness(db, generationId, activeCutoff);
  validateSelectedAssertionProvenance(db, generationId, activeCutoff);
  validateGenerationFieldIntegrity(db, generationId);
  validateGenerationLifecycleCoordinates(db, generationId);
  validateUserAssertionProvenanceAuthority(db);
  return generationId;
}

function ensureV7ProjectionSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_V7_APPEND);
  backfillProjectionProvenance(db);
  rejectStrayProjectionGenerations(db);
  const generationId = validateActiveProjectionBoundary(db);
  const mixedRows = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transactions rows
    WHERE rows.generation_id = ? AND (rows.revision_id NOT IN (SELECT revision_id FROM transaction_revisions)
      OR rows.transaction_id NOT IN (SELECT transaction_id FROM financial_transactions))`,
        )
        .get(generationId) as { count?: number }
    ).count ?? 0,
  );
  if (mixedRows !== 0)
    throw new Error(
      "Canonical v7 active projection contains mixed or dangling rows.",
    );
}

const CANONICAL_FINANCIAL_REVISION_COLUMNS = [
  "revision_id",
  "transaction_id",
  "source_record_id",
  "capture_id",
  "commit_id",
  "revision_number",
  "amount_coefficient",
  "amount_scale",
  "currency",
  "direction",
  "posting_status",
  "posting_origin",
  "posting_basis",
  "posting_rule_version",
  "description",
  "economic_status",
  "administrative_state",
  "semantic_rule_version",
  "effective_on",
  "transaction_date_time_local",
  "time_zone",
  "time_precision",
  "time_origin",
  "effective_time_basis",
  "effective_time_rule_version",
  "utc_instant_utc_us",
] as const;
const CANONICAL_FINANCIAL_REVISION_COLUMN_LIST =
  CANONICAL_FINANCIAL_REVISION_COLUMNS.join(", ");

function isCanonicalFinancialRevisionSchema(sql: string): boolean {
  return (
    /posting_origin TEXT NOT NULL CHECK\(posting_origin IN/.test(sql) &&
    /posting_basis TEXT NOT NULL CHECK\(posting_basis IN/.test(sql) &&
    /posting_rule_version TEXT NOT NULL CHECK\(posting_rule_version IN/.test(
      sql,
    ) &&
    /semantic_rule_version TEXT NOT NULL CHECK\(semantic_rule_version IN/.test(
      sql,
    ) &&
    /effective_time_rule_version TEXT NOT NULL CHECK\(effective_time_rule_version IN/.test(
      sql,
    ) &&
    /time_precision TEXT NOT NULL CHECK\(time_precision IN/.test(sql) &&
    /posting_origin LIKE 'synthetic_%'/.test(sql) &&
    /yuanta\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /yuanta\/domestic-deposit\/human-attested-v2/.test(sql) &&
    /hncb\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /ctbc\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /sinopac\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /posting_rule_version LIKE 'foreign-currency\/%'/.test(sql) &&
    /posting_rule_version LIKE 'fubon\/credit-card\/%'/.test(sql) &&
    /posting_rule_version LIKE 'fubon\/loan\/%'/.test(sql) &&
    /posting_rule_version LIKE 'yuanta\/loan\/%'/.test(sql) &&
    /posting_rule_version LIKE 'esun\/credit-card\/%'/.test(sql) &&
    /esun\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v2/.test(sql) &&
    /semantic_rule_version LIKE 'foreign-currency\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'fubon\/credit-card\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'fubon\/loan\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'yuanta\/loan\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'esun\/credit-card\/%'/.test(sql) &&
    /esun\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v2/.test(sql) &&
    /effective_time_rule_version LIKE 'foreign-currency\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'fubon\/credit-card\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'fubon\/loan\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'yuanta\/loan\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'esun\/credit-card\/%'/.test(sql) &&
    /esun\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v2/.test(sql) &&
    /time_precision TEXT NOT NULL CHECK\(time_precision IN \('date','minute','second'\)\)/.test(
      sql,
    ) &&
    /time_origin TEXT NOT NULL CHECK\(time_origin IN \('source_reported','defaulted_local_midnight'\)\)/.test(
      sql,
    ) &&
    /effective_time_basis TEXT NOT NULL CHECK\(effective_time_basis IN \('accounting','transaction-time','source-reported'\)\)/.test(
      sql,
    )
  );
}

function financialRevisionSchemaSql(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
): string {
  return String(
    (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
}

function financialRevisionColumnNames(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
    }>
  ).map((column) => String(column.name ?? ""));
}

function assertFinancialRevisionTableIntegrity(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
  label: string,
  requireCanonicalSchema = true,
): void {
  if (relationType(db, table) !== "table")
    throw new Error(
      `Canonical financial revision ${label} relation is not a table.`,
    );
  if (
    requireCanonicalSchema &&
    (!isCanonicalFinancialRevisionSchema(financialRevisionSchemaSql(db, table)) ||
      financialRevisionColumnNames(db, table).join(",") !==
        CANONICAL_FINANCIAL_REVISION_COLUMNS.join(","))
  )
    throw new Error(
      `Canonical financial revision ${label} table is not compatible with the v9 schema.`,
    );
  const integrityRows = db
    .prepare(`PRAGMA integrity_check(${table})`)
    .all() as Array<{ integrity_check?: unknown }>;
  if (
    integrityRows.some((row) => String(row.integrity_check ?? "") !== "ok")
  )
    throw new Error(
      `Canonical financial revision ${label} table failed integrity validation.`,
    );
  if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length !== 0)
    throw new Error(
      `Canonical financial revision ${label} table has invalid foreign keys.`,
    );
}

function financialRevisionRowCount(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count?: number }
    ).count ?? 0,
  );
}

function financialRevisionRowDifference(
  db: DatabaseSync,
  left: "transaction_revisions" | "transaction_revisions_widened",
  right: "transaction_revisions" | "transaction_revisions_widened",
): number {
  const leftOnly = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM (SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${left} EXCEPT SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${right})`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  const rightOnly = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM (SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${right} EXCEPT SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${left})`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  return leftOnly + rightOnly;
}

function recreateCanonicalSourceAssertionsView(db: DatabaseSync): void {
  db.exec(`
    DROP VIEW IF EXISTS source_assertions;
    CREATE VIEW source_assertions AS ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT};
    CREATE INDEX IF NOT EXISTS idx_transaction_revisions_financial_time ON transaction_revisions(effective_on, utc_instant_utc_us, transaction_id, commit_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_revisions_knowledge_time ON transaction_revisions(commit_id, transaction_id, revision_number);
    CREATE INDEX IF NOT EXISTS idx_transaction_revisions_lineage ON transaction_revisions(transaction_id, revision_number, revision_id);
  `);
}

/** Recover a migration that was interrupted after creating the widened table.
 * Both tables may be present after a process crash because the historical
 * rebuild is a multi-statement operation. The staging table is only promoted
 * when it is a valid v9 copy with exactly the same rows as the old table;
 * otherwise startup fails closed and leaves both copies for diagnosis. */
function recoverFinancialRevisionWideningStaging(
  db: DatabaseSync,
  finalSchemaIsCanonical: boolean,
): void {
  if (relationType(db, "transaction_revisions_widened") === null) return;
  if (relationType(db, "transaction_revisions") !== "table")
    throw new Error(
      "Canonical financial revision widening is ambiguous: final table is missing or not a table.",
    );

  assertFinancialRevisionTableIntegrity(
    db,
    "transaction_revisions_widened",
    "widening staging",
  );
  assertFinancialRevisionTableIntegrity(
    db,
    "transaction_revisions",
    "final",
    finalSchemaIsCanonical,
  );
  const finalCount = financialRevisionRowCount(db, "transaction_revisions");
  const stagingCount = financialRevisionRowCount(
    db,
    "transaction_revisions_widened",
  );
  if (stagingCount === 0) {
    db.exec("DROP TABLE transaction_revisions_widened");
    return;
  }
  let rowDifference: number;
  try {
    rowDifference = financialRevisionRowDifference(
      db,
      "transaction_revisions",
      "transaction_revisions_widened",
    );
  } catch (error) {
    throw new Error(
      "Canonical financial revision widening is ambiguous: staging rows cannot be compared safely.",
      { cause: error },
    );
  }
  if (finalCount !== stagingCount || rowDifference !== 0)
    throw new Error(
      "Canonical financial revision widening is ambiguous: refusing to discard or merge divergent rows.",
    );

  if (finalSchemaIsCanonical) {
    db.exec("DROP TABLE transaction_revisions_widened");
    return;
  }

  db.exec("DROP VIEW IF EXISTS source_assertions");
  db.exec(
    "DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; DROP TABLE transaction_revisions; ALTER TABLE transaction_revisions_widened RENAME TO transaction_revisions;",
  );
  recreateCanonicalSourceAssertionsView(db);
}

/** Widen provider-specific financial semantics without weakening normalized
 * enums. Existing v8 ledgers keep their rows; the revision table is rebuilt
 * transactionally on the next writable open when it still has a closed
 * provider allowlist. */
function ensureCanonicalFinancialRevisionSchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const finalSchemaIsCanonical = isCanonicalFinancialRevisionSchema(sql);
  recoverFinancialRevisionWideningStaging(db, finalSchemaIsCanonical);
  if (
    finalSchemaIsCanonical ||
    isCanonicalFinancialRevisionSchema(
      financialRevisionSchemaSql(db, "transaction_revisions"),
    )
  )
    return;
  const before = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
        .get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  db.exec(`
    DROP VIEW IF EXISTS source_assertions;
    CREATE TABLE transaction_revisions_widened (
      revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
      transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), revision_number INTEGER NOT NULL,
      amount_coefficient TEXT NOT NULL, amount_scale INTEGER NOT NULL CHECK(amount_scale >= 0), currency TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')),
      posting_status TEXT NOT NULL CHECK(posting_status IN ('pending','posted')),
      posting_origin TEXT NOT NULL CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%'),
      posting_basis TEXT NOT NULL CHECK(posting_basis IN ('query-status-success-with-accounting-date','human-attested-formally-posted','statement-posted-history') OR posting_basis LIKE 'synthetic_%'),
      posting_rule_version TEXT NOT NULL CHECK(posting_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR posting_rule_version LIKE 'synthetic-%' OR posting_rule_version LIKE 'foreign-currency/%' OR posting_rule_version LIKE 'fubon/credit-card/%' OR posting_rule_version LIKE 'fubon/loan/%' OR posting_rule_version LIKE 'yuanta/loan/%' OR posting_rule_version LIKE 'esun/credit-card/%'),
      description TEXT, economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),
      administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),
      semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR semantic_rule_version LIKE 'synthetic-%' OR semantic_rule_version LIKE 'foreign-currency/%' OR semantic_rule_version LIKE 'fubon/credit-card/%' OR semantic_rule_version LIKE 'fubon/loan/%' OR semantic_rule_version LIKE 'yuanta/loan/%' OR semantic_rule_version LIKE 'esun/credit-card/%'),
      effective_on TEXT NOT NULL, transaction_date_time_local TEXT NOT NULL, time_zone TEXT NOT NULL,
      time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
      time_origin TEXT NOT NULL CHECK(time_origin IN ('source_reported','defaulted_local_midnight')),
      effective_time_basis TEXT NOT NULL CHECK(effective_time_basis IN ('accounting','transaction-time','source-reported')),
      effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR effective_time_rule_version LIKE 'synthetic-%' OR effective_time_rule_version LIKE 'foreign-currency/%' OR effective_time_rule_version LIKE 'fubon/credit-card/%' OR effective_time_rule_version LIKE 'fubon/loan/%' OR effective_time_rule_version LIKE 'yuanta/loan/%' OR effective_time_rule_version LIKE 'esun/credit-card/%'),
      utc_instant_utc_us INTEGER NOT NULL, UNIQUE(transaction_id, revision_number)
    );
    INSERT INTO transaction_revisions_widened(
      revision_id, transaction_id, source_record_id, capture_id, commit_id,
      revision_number, amount_coefficient, amount_scale, currency, direction,
      posting_status, posting_origin, posting_basis, posting_rule_version,
      description, economic_status, administrative_state, semantic_rule_version,
      effective_on, transaction_date_time_local, time_zone, time_precision,
      time_origin, effective_time_basis, effective_time_rule_version,
      utc_instant_utc_us
    ) SELECT
      revision_id, transaction_id, source_record_id, capture_id, commit_id,
      revision_number, amount_coefficient, amount_scale, currency, direction,
      posting_status, posting_origin, posting_basis, posting_rule_version,
      description, economic_status, administrative_state, semantic_rule_version,
      effective_on, transaction_date_time_local, time_zone, time_precision,
      time_origin, effective_time_basis, effective_time_rule_version,
      utc_instant_utc_us
    FROM transaction_revisions;
    DROP TABLE transaction_revisions;
    ALTER TABLE transaction_revisions_widened RENAME TO transaction_revisions;
    CREATE VIEW source_assertions AS ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT};
    CREATE INDEX idx_transaction_revisions_financial_time ON transaction_revisions(effective_on, utc_instant_utc_us, transaction_id, commit_id);
    CREATE INDEX idx_transaction_revisions_knowledge_time ON transaction_revisions(commit_id, transaction_id, revision_number);
    CREATE INDEX idx_transaction_revisions_lineage ON transaction_revisions(transaction_id, revision_number, revision_id);
  `);
  const after = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
        .get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error(
      "Canonical v8 financial revision-schema rebuild lost legacy rows.",
    );
}

/** Add minute precision to existing v8 observation tables. SinoPac reports
 * transaction-local time at minute precision; older v8 ledgers admitted that
 * value in revisions but still rejected the matching observation row. */
function ensureCanonicalTimeObservationSchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (
    /time_precision TEXT NOT NULL CHECK\(time_precision IN \('date','minute','second'\)\)/.test(
      sql,
    ) &&
    /time_origin TEXT NOT NULL CHECK\(time_origin IN \('source_reported','defaulted_local_midnight'\)\)/.test(
      sql,
    )
  )
    return;
  const before = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_time_observations")
        .get() as { count?: number }
    ).count ?? 0,
  );
  db.exec(`
    CREATE TABLE transaction_time_observations_widened (
      observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
      transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
      revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      role TEXT NOT NULL CHECK(role IN ('accounting','occurred')),
      local_value TEXT NOT NULL,
      time_zone TEXT NOT NULL CHECK(time_zone = 'Asia/Taipei'),
      time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
      time_origin TEXT NOT NULL CHECK(time_origin IN ('source_reported','defaulted_local_midnight')),
      utc_instant_utc_us INTEGER NOT NULL,
      UNIQUE(revision_id, role)
    );
    INSERT INTO transaction_time_observations_widened(
      observation_id, transaction_id, revision_id, source_record_id, commit_id,
      role, local_value, time_zone, time_precision, time_origin,
      utc_instant_utc_us
    ) SELECT
      observation_id, transaction_id, revision_id, source_record_id, commit_id,
      role, local_value, time_zone, time_precision, time_origin,
      utc_instant_utc_us
    FROM transaction_time_observations;
    DROP TABLE transaction_time_observations;
    ALTER TABLE transaction_time_observations_widened RENAME TO transaction_time_observations;
  `);
  const after = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_time_observations")
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error(
      "Canonical time observation widening changed the row count.",
    );
}

/** Multi-currency Financial Accounts do not have an account-level ISO
 * denomination.  Older canonical ledgers declared this column NOT NULL;
 * rebuild it transactionally so the nullable scope is available without
 * changing any existing domestic account values. */
function ensureFinancialAccountCurrencySchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_accounts'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (!/currency TEXT NOT NULL/.test(sql)) return;
  const before = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM financial_accounts").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  db.exec(`
    CREATE TABLE financial_accounts_widened (
      account_id BLOB PRIMARY KEY CHECK(length(account_id) = 16),
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
      stream TEXT NOT NULL,
      account_no TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')),
      currency TEXT,
      created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      UNIQUE(source_connection_id, identity_epoch_id, stream, account_no)
    );
    INSERT INTO financial_accounts_widened(
      account_id, source_connection_id, identity_epoch_id, stream, account_no,
      account_type, currency, created_commit_id
    ) SELECT
      account_id, source_connection_id, identity_epoch_id, stream, account_no,
      account_type, currency, created_commit_id
    FROM financial_accounts;
    DROP TABLE financial_accounts;
    ALTER TABLE financial_accounts_widened RENAME TO financial_accounts;
  `);
  const after = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM financial_accounts").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error("Financial account currency widening lost legacy rows.");
}

/**
 * Conversion evidence is deliberately a separate one-to-one relation from a
 * transaction revision.  A booked amount remains the canonical transaction
 * amount while original amount/rates are retained as source evidence; no
 * conversion arithmetic is allowed to rewrite the booked value.
 */
function ensureForeignCurrencyConversionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_conversion_evidence (
      conversion_id BLOB PRIMARY KEY CHECK(length(conversion_id) = 16),
      transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
      revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      original_amount_coefficient TEXT,
      original_amount_scale INTEGER CHECK(original_amount_scale IS NULL OR original_amount_scale >= 0),
      original_currency TEXT,
      booked_amount_coefficient TEXT NOT NULL,
      booked_amount_scale INTEGER NOT NULL CHECK(booked_amount_scale >= 0),
      booked_currency TEXT NOT NULL,
      source_reported_rate_coefficient TEXT,
      source_reported_rate_scale INTEGER CHECK(source_reported_rate_scale IS NULL OR source_reported_rate_scale >= 0),
      source_reported_rate_base_currency TEXT,
      source_reported_rate_quote_currency TEXT,
      source_reported_rate_date TEXT,
      implied_rate_coefficient TEXT,
      implied_rate_scale INTEGER CHECK(implied_rate_scale IS NULL OR implied_rate_scale >= 0),
      implied_rate_base_currency TEXT,
      implied_rate_quote_currency TEXT,
      implied_rate_date TEXT,
      comparison TEXT NOT NULL CHECK(comparison IN ('consistent','conflicted','not-comparable')),
      fee_amount_coefficient TEXT,
      fee_amount_scale INTEGER CHECK(fee_amount_scale IS NULL OR fee_amount_scale >= 0),
      fee_currency TEXT,
      evidence_origin TEXT NOT NULL,
      UNIQUE(revision_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transaction_conversion_evidence_transaction
      ON transaction_conversion_evidence(transaction_id, revision_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_conversion_evidence_source_record
      ON transaction_conversion_evidence(source_record_id, capture_id);
  `);
}

/** Add the explicit no-data authority used by observed human-attested
 * providers without weakening the existing comparable-range meaning. SQLite
 * CHECK constraints require a table rebuild, so preserve every existing row
 * and index inside the caller's migration transaction. */
function ensureCanonicalCaptureScopeSchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_scopes'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (/provider-explicit-no-data/.test(sql)) return;
  const widenedSql = sql.replace(
    "CHECK(absence_authority IN ('comparable-complete-range'))",
    "CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data'))",
  );
  if (widenedSql === sql)
    throw new Error(
      "Canonical v8 capture scope schema is missing its absence-authority constraint.",
    );
  const indexes = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'capture_scopes' AND sql IS NOT NULL",
      )
      .all() as Array<{ sql?: unknown }>
  )
    .map((row) => String(row.sql ?? ""))
    .filter(Boolean);
  const before = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const widenedCreateSql = widenedSql.replace(
    /CREATE TABLE [\"]?capture_scopes[\"]?/,
    "CREATE TABLE capture_scopes_widened",
  );
  if (widenedCreateSql === widenedSql)
    throw new Error(`Capture scope table SQL did not rename: ${sql}`);
  db.exec(widenedCreateSql);
  db.exec("INSERT INTO capture_scopes_widened SELECT * FROM capture_scopes");
  db.exec("DROP TABLE capture_scopes");
  db.exec("ALTER TABLE capture_scopes_widened RENAME TO capture_scopes");
  for (const index of indexes) db.exec(index);
  const after = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error("Canonical v8 capture scope rebuild lost legacy rows.");
}

const SCHEMA_V8_SOURCE_EVIDENCE = `
CREATE TABLE source_subjects (
  source_subject_id BLOB PRIMARY KEY CHECK(length(source_subject_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  stream TEXT NOT NULL, record_kind TEXT NOT NULL, subject_digest TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest)
);
CREATE TABLE source_route_bindings (
  authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(authority_route, source_connection_id)
);
`;

function validateV7SourceRecordScopeCoverage(db: DatabaseSync): number {
  const recordCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM source_records").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const invalid = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM (
          SELECT record.source_record_id
          FROM source_records record
          LEFT JOIN source_record_scopes relation
            ON relation.source_record_id = record.source_record_id
            AND relation.capture_id = record.capture_id
          LEFT JOIN capture_scopes scope
            ON scope.scope_id = relation.scope_id
            AND scope.capture_id = relation.capture_id
          GROUP BY record.source_record_id
          HAVING COUNT(scope.scope_id) <> 1
        )`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (invalid !== 0) {
    throw new Error(
      "Canonical v7 source records contain orphaned or ambiguous scope relations; migration aborted.",
    );
  }
  return recordCount;
}

function applyV8SourceEvidenceSchema(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
  cleanupStaleV8 = false,
): void {
  const sourceRecordCount = validateV7SourceRecordScopeCoverage(db);
  const existingV8Relations = [
    "source_subjects",
    "source_route_bindings",
    "source_record_provenance",
  ].filter((table) => relationType(db, table) === "table");
  if (existingV8Relations.length > 0 && existingV8Relations.length < 3) {
    throw new Error("Canonical schema v8 is partial; refusing ad-hoc repair.");
  }
  const sourceOnlyRows =
    existingV8Relations.length === 3 &&
    columnExists(db, "source_captures", "record_kind")
      ? Number(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM source_captures WHERE record_kind <> 'cathay-domestic-deposit'",
              )
              .get() as { count?: number }
          ).count ?? 0,
        )
      : 0;
  if (
    existingV8Relations.length === 3 &&
    sourceOnlyRows > 0 &&
    !cleanupStaleV8
  ) {
    throw new Error(
      "Canonical schema v8 source evidence cannot be downgraded through a v7 migration.",
    );
  }
  if (cleanupStaleV8 || existingV8Relations.length === 3) {
    db.exec(
      "DROP TABLE IF EXISTS source_record_provenance; DROP TABLE IF EXISTS source_route_bindings; DROP TABLE IF EXISTS source_subjects",
    );
  }
  db.exec(SCHEMA_V8_SOURCE_EVIDENCE);
  db.exec(`
    INSERT INTO source_route_bindings(authority_route, source_connection_id, created_commit_id)
      SELECT DISTINCT capture.authority_route, capture.source_connection_id, route.created_commit_id
      FROM source_captures capture
      JOIN source_authority_routes route ON route.authority_route = capture.authority_route;
    INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id)
      SELECT account.account_id, account.source_connection_id, account.identity_epoch_id, account.stream,
        'cathay-domestic-deposit', 'legacy-cathay:' || lower(hex(account.account_id)), account.created_commit_id
      FROM financial_accounts account;

    CREATE TABLE source_captures_v8 (
      capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16),
      capture_key TEXT UNIQUE,
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
      authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      stream TEXT NOT NULL, record_kind TEXT NOT NULL DEFAULT 'cathay-domestic-deposit', account_no TEXT,
      observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
      completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
      completeness_basis TEXT NOT NULL, completeness_rule_version TEXT NOT NULL,
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
    );
    INSERT INTO source_captures_v8(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route,
      source_subject_id, stream, record_kind, account_no, observed_at, scope_start, scope_end,
      completeness, completeness_basis, completeness_rule_version, commit_id)
      SELECT capture_id, 'legacy-cathay:' || lower(hex(capture_id)), source_connection_id, identity_epoch_id, authority_route, NULL, stream,
        'cathay-domestic-deposit', account_no, observed_at, scope_start, scope_end,
        completeness, completeness_basis, completeness_rule_version, commit_id FROM source_captures;

    CREATE TABLE capture_scopes_v8 (
      scope_id BLOB PRIMARY KEY CHECK(length(scope_id) = 16),
      capture_id BLOB NOT NULL REFERENCES source_captures_v8(capture_id),
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
      account_id BLOB REFERENCES financial_accounts(account_id),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      account_no TEXT, stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('bounded-range','point-in-time')),
      completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
      completeness_basis TEXT NOT NULL, completeness_rule_version TEXT NOT NULL,
      absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data')),
      contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL,
      page_count INTEGER NOT NULL CHECK(page_count > 0), terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      CHECK(account_id IS NOT NULL OR source_subject_id IS NOT NULL),
      UNIQUE(scope_id, capture_id), UNIQUE(scope_id, account_id), UNIQUE(scope_id, source_subject_id),
      UNIQUE(capture_id, account_id, scope_start, scope_end),
      UNIQUE(capture_id, source_subject_id, scope_start, scope_end)
    );
    INSERT INTO capture_scopes_v8(scope_id, capture_id, source_connection_id, identity_epoch_id,
      account_id, source_subject_id, account_no, stream, scope_start, scope_end, scope_kind,
      completeness, completeness_basis, completeness_rule_version, absence_authority,
      contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id)
      SELECT scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, account_id,
        account_no, stream, scope_start, scope_end, scope_kind, completeness, completeness_basis,
        completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint,
        page_count, terminal, commit_id FROM capture_scopes;

    CREATE TABLE capture_scope_pages_v8 (
      scope_page_id BLOB PRIMARY KEY CHECK(length(scope_page_id) = 16),
      scope_id BLOB NOT NULL REFERENCES capture_scopes_v8(scope_id),
      page_ordinal INTEGER NOT NULL CHECK(page_ordinal >= 0),
      response_code TEXT NOT NULL DEFAULT '200' CHECK(response_code = '200'),
      terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), row_count INTEGER NOT NULL CHECK(row_count >= 0),
      response_digest TEXT NOT NULL, proof_kind TEXT NOT NULL,
      contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      UNIQUE(scope_id, page_ordinal)
    );
    INSERT INTO capture_scope_pages_v8(scope_page_id, scope_id, page_ordinal, response_code, terminal,
      row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, metadata_json, commit_id)
      SELECT scope_page_id, scope_id, page_ordinal, '200', terminal, row_count, response_digest,
        proof_kind, contract_fingerprint, preflight_fingerprint, '{}', commit_id FROM capture_scope_pages;

    CREATE TABLE source_records_v8 (
      source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16),
      capture_id BLOB NOT NULL REFERENCES source_captures_v8(capture_id),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), record_kind TEXT NOT NULL DEFAULT 'cathay-domestic-deposit',
      sequence_lexeme TEXT NOT NULL, provider_key TEXT, content_hash TEXT,
      occurrence_key TEXT, collision_key TEXT, description TEXT, payload_json TEXT NOT NULL,
      UNIQUE(source_record_id, capture_id), UNIQUE(capture_id, occurrence_key)
    );
    INSERT INTO source_records_v8(source_record_id, capture_id, source_subject_id, commit_id, record_kind,
      sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
      SELECT record.source_record_id, record.capture_id, scope.account_id, record.commit_id,
        'cathay-domestic-deposit', record.sequence_lexeme,
        'legacy-cathay:' || record.sequence_lexeme, 'legacy-cathay:' || lower(hex(record.source_record_id)),
        'legacy-cathay:' || lower(hex(record.source_record_id)), NULL, record.description, record.payload_json
      FROM source_records record JOIN source_record_scopes scope ON scope.source_record_id = record.source_record_id;

    CREATE TABLE source_record_scopes_v8 (
      source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16),
      scope_id BLOB NOT NULL CHECK(length(scope_id) = 16),
      capture_id BLOB NOT NULL CHECK(length(capture_id) = 16) REFERENCES source_captures_v8(capture_id),
      account_id BLOB REFERENCES financial_accounts(account_id),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      sequence_lexeme TEXT NOT NULL, occurrence_key TEXT,
      commit_id BLOB NOT NULL CHECK(length(commit_id) = 16) REFERENCES canonical_commits(commit_id),
      CHECK(account_id IS NOT NULL OR source_subject_id IS NOT NULL),
      FOREIGN KEY(source_record_id, capture_id) REFERENCES source_records_v8(source_record_id, capture_id),
      FOREIGN KEY(scope_id, capture_id) REFERENCES capture_scopes_v8(scope_id, capture_id),
      FOREIGN KEY(scope_id, account_id) REFERENCES capture_scopes_v8(scope_id, account_id),
      FOREIGN KEY(scope_id, source_subject_id) REFERENCES capture_scopes_v8(scope_id, source_subject_id),
      UNIQUE(scope_id, sequence_lexeme), UNIQUE(scope_id, occurrence_key)
    );
    INSERT INTO source_record_scopes_v8(source_record_id, scope_id, capture_id, account_id,
      source_subject_id, sequence_lexeme, occurrence_key, commit_id)
      SELECT source_record_id, scope_id, capture_id, account_id, account_id, sequence_lexeme,
        'legacy-cathay:' || lower(hex(source_record_id)), commit_id FROM source_record_scopes;
  `);
  const copiedRecordCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM source_records_v8").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const copiedRelationCount = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM source_record_scopes_v8")
        .get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (
    copiedRecordCount !== sourceRecordCount ||
    copiedRelationCount !== sourceRecordCount
  ) {
    throw new Error(
      "Canonical v7 source record migration counts are incomplete; migration aborted.",
    );
  }
  if (injectMigrationFailure === "v7-v8-after-source-copy") {
    throw new Error("Injected v7-v8 migration failure after source copy.");
  }
  db.exec(`
    DROP TABLE source_record_scopes;
    DROP TABLE capture_scope_pages;
    DROP TABLE source_records;
    DROP TABLE capture_scopes;
    DROP TABLE source_captures;
    ALTER TABLE source_captures_v8 RENAME TO source_captures;
    ALTER TABLE capture_scopes_v8 RENAME TO capture_scopes;
    ALTER TABLE capture_scope_pages_v8 RENAME TO capture_scope_pages;
    ALTER TABLE source_records_v8 RENAME TO source_records;
    ALTER TABLE source_record_scopes_v8 RENAME TO source_record_scopes;
    CREATE TABLE source_record_provenance (
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(source_record_id, capture_id)
    );
    INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id)
      SELECT source_record_id, capture_id, commit_id FROM source_records;
    CREATE INDEX idx_source_subjects_identity ON source_subjects(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest);
    CREATE INDEX idx_source_records_occurrence ON source_records(source_subject_id, occurrence_key, commit_id, source_record_id);
    CREATE INDEX idx_source_records_collision ON source_records(source_subject_id, collision_key, occurrence_key, commit_id, source_record_id);
    CREATE INDEX idx_source_records_knowledge ON source_records(commit_id, source_record_id);
    CREATE INDEX idx_source_record_provenance_capture ON source_record_provenance(capture_id, commit_id, source_record_id);
    CREATE INDEX idx_capture_scopes_account_time ON capture_scopes(account_id, stream, scope_start, scope_end, scope_id);
    CREATE INDEX idx_capture_scope_pages_proof ON capture_scope_pages(scope_id, page_ordinal, terminal, proof_kind);
    CREATE INDEX idx_source_record_scopes_scope_sequence ON source_record_scopes(scope_id, sequence_lexeme, source_record_id);
    CREATE INDEX idx_source_record_scopes_account_capture ON source_record_scopes(account_id, capture_id, source_record_id);
  `);
}

function validateV8SourceEvidenceSchema(db: DatabaseSync): void {
  for (const table of [
    "source_subjects",
    "source_route_bindings",
    "source_captures",
    "capture_scopes",
    "capture_scope_pages",
    "source_records",
    "source_record_scopes",
    "source_record_provenance",
  ]) {
    if (relationType(db, table) !== "table")
      throw new Error(`Canonical schema v8 table ${table} is missing.`);
  }
  const columns: Record<string, string[]> = {
    source_captures: ["capture_key", "source_subject_id", "record_kind"],
    capture_scopes: ["source_subject_id"],
    capture_scope_pages: ["response_code", "metadata_json"],
    source_records: [
      "source_subject_id",
      "record_kind",
      "provider_key",
      "content_hash",
      "occurrence_key",
      "collision_key",
    ],
    source_record_scopes: ["source_subject_id", "occurrence_key"],
  };
  for (const [table, required] of Object.entries(columns)) {
    const actual = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name?: string;
        }>
      ).map((row) => row.name),
    );
    for (const column of required)
      if (!actual.has(column))
        throw new Error(
          `Canonical schema v8 column ${table}.${column} is missing.`,
        );
  }
  for (const index of [
    "idx_source_subjects_identity",
    "idx_source_records_occurrence",
    "idx_source_records_collision",
    "idx_source_records_knowledge",
    "idx_source_record_provenance_capture",
  ]) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index)
    )
      throw new Error(`Canonical schema v8 index ${index} is missing.`);
  }
}

function migrateV7ToV8(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
  transactionAlreadyOpen = false,
  cleanupStaleV8 = false,
): void {
  if (!transactionAlreadyOpen) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
  }
  try {
    // Legacy v1-v7 paths can still carry the pre-foreign-currency revision
    // constraints. Widen those tables while this migration owns the
    // transaction and has foreign-key checks disabled; doing it only after
    // the migration returns makes SQLite reject the old child references.
    ensureFinancialAccountCurrencySchema(db);
    ensureCanonicalFinancialRevisionSchema(db);
    ensureCanonicalTimeObservationSchema(db);
    ensureForeignCurrencyConversionSchema(db);
    applyV8SourceEvidenceSchema(db, injectMigrationFailure, cleanupStaleV8);
    validateV8SourceEvidenceSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(8, currentUtcMicros());
    db.exec("PRAGMA user_version = 8");
    if (!transactionAlreadyOpen) {
      db.exec("COMMIT");
      db.exec("PRAGMA foreign_keys = ON");
    }
  } catch (error) {
    if (!transactionAlreadyOpen) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON");
    }
    throw error;
  }
}

const SCHEMA_V9_LOAN_FINANCIAL = `
CREATE TABLE IF NOT EXISTS loan_account_identities (
  account_id BLOB PRIMARY KEY REFERENCES financial_accounts(account_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  account_key TEXT NOT NULL, account_no TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('loan','depository')),
  stream TEXT NOT NULL CHECK(stream IN ('loan','domestic-deposit')),
  UNIQUE(source_connection_id, identity_epoch_id, stream, account_key)
);
CREATE INDEX IF NOT EXISTS idx_loan_account_identities_lookup
  ON loan_account_identities(source_connection_id, identity_epoch_id, stream, account_no);
CREATE TABLE IF NOT EXISTS loan_transaction_facts (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB PRIMARY KEY REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  occurrence_index INTEGER NOT NULL CHECK(occurrence_index > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('disbursement','payment','interest','fee')),
  event_source_code TEXT NOT NULL, event_evidence_contract_version TEXT NOT NULL,
  principal_coefficient TEXT, principal_scale INTEGER CHECK(principal_scale >= 0),
  interest_coefficient TEXT, interest_scale INTEGER CHECK(interest_scale >= 0),
  fee_coefficient TEXT, fee_scale INTEGER CHECK(fee_scale >= 0),
  component_evidence_source_record_key TEXT,
  component_evidence_contract_version TEXT,
  UNIQUE(transaction_id, revision_id)
);
CREATE INDEX IF NOT EXISTS idx_loan_transaction_facts_transaction
  ON loan_transaction_facts(transaction_id, revision_id);
CREATE TABLE IF NOT EXISTS balance_observations (
  observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  observation_key TEXT NOT NULL,
  balance_kind TEXT NOT NULL CHECK(balance_kind IN ('loan_outstanding','outstanding_principal','outstanding_total')),
  created_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(account_id, created_capture_id, observation_key, balance_kind)
);
CREATE TABLE IF NOT EXISTS balance_observation_revisions (
  revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
  observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  balance_coefficient TEXT NOT NULL, balance_scale INTEGER NOT NULL CHECK(balance_scale >= 0),
  currency TEXT NOT NULL CHECK(currency = 'TWD'), effective_at TEXT NOT NULL,
  effective_time_basis TEXT NOT NULL CHECK(effective_time_basis = 'source-reported'),
  effective_time_rule_version TEXT NOT NULL,
  effective_time_evidence_source_record_key TEXT NOT NULL,
  effective_time_evidence_source_field TEXT NOT NULL CHECK(effective_time_evidence_source_field = 'statement-as-of'),
  effective_time_evidence_value TEXT NOT NULL,
  effective_time_evidence_contract_version TEXT NOT NULL,
  observed_at TEXT NOT NULL, UNIQUE(observation_id, revision_number)
);
CREATE INDEX IF NOT EXISTS idx_balance_observation_revisions_current
  ON balance_observation_revisions(observation_id, commit_id, effective_at);
CREATE TABLE IF NOT EXISTS transaction_relations (
  relation_id BLOB PRIMARY KEY CHECK(length(relation_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), relation_key TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK(relation_kind = 'transfer_counterpart'),
  from_account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  to_account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  from_source_record_key TEXT NOT NULL, to_source_record_key TEXT NOT NULL,
  from_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  to_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  from_direction TEXT NOT NULL CHECK(from_direction IN ('inflow','outflow')),
  to_direction TEXT NOT NULL CHECK(to_direction IN ('inflow','outflow')),
  evidence_source_record_key TEXT NOT NULL, evidence_relation_id TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL, UNIQUE(account_id, relation_key),
  UNIQUE(source_connection_id, identity_epoch_id, relation_kind,
         from_account_id, from_transaction_id, to_account_id, to_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_relations_knowledge
  ON transaction_relations(account_id, relation_key, commit_id);
CREATE TABLE IF NOT EXISTS transaction_relation_provenance (
  relation_id BLOB NOT NULL REFERENCES transaction_relations(relation_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  evidence_source_record_key TEXT NOT NULL, evidence_relation_id TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL, PRIMARY KEY(relation_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS current_loan_accounts (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, account_id)
);
CREATE TABLE IF NOT EXISTS current_loan_balance_observations (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id), balance_kind TEXT NOT NULL,
  observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
  revision_id BLOB NOT NULL REFERENCES balance_observation_revisions(revision_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, account_id, balance_kind)
);
CREATE TABLE IF NOT EXISTS current_loan_relations (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  relation_id BLOB NOT NULL REFERENCES transaction_relations(relation_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  relation_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, relation_id)
);
`;

export function validateCanonicalLoanExtensionSchema(db: DatabaseSync): void {
  for (const table of [
    "loan_account_identities", "loan_transaction_facts", "balance_observations",
    "balance_observation_revisions", "transaction_relations",
    "transaction_relation_provenance", "current_loan_accounts",
    "current_loan_balance_observations", "current_loan_relations",
  ])
    if (relationType(db, table) !== "table")
      throw new Error(`Canonical schema v9 loan table ${table} is missing.`);
}

function normalizeLoanRelationsV9(db: DatabaseSync): void {
  type RelationRow = {
    relation_id: Uint8Array;
    source_connection_id: Uint8Array;
    identity_epoch_id: Uint8Array;
    from_account_id: Uint8Array;
    from_transaction_id: Uint8Array;
    from_source_record_key: string;
    from_direction: string;
    to_account_id: Uint8Array;
    to_transaction_id: Uint8Array;
    to_source_record_key: string;
    to_direction: string;
  };
  const rows = db.prepare("SELECT * FROM transaction_relations").all() as RelationRow[];
  const groups = new Map<
    string,
    Array<{ row: RelationRow; from: "from" | "to" }>
  >();
  for (const row of rows) {
    const fromKey = Buffer.concat([row.from_account_id, row.from_transaction_id]);
    const toKey = Buffer.concat([row.to_account_id, row.to_transaction_id]);
    const from = Buffer.compare(fromKey, toKey) <= 0 ? "from" : "to";
    const firstAccount = from === "from" ? row.from_account_id : row.to_account_id;
    const firstTransaction =
      from === "from" ? row.from_transaction_id : row.to_transaction_id;
    const secondAccount = from === "from" ? row.to_account_id : row.from_account_id;
    const secondTransaction =
      from === "from" ? row.to_transaction_id : row.from_transaction_id;
    const key = [
      "loan-relation-v9",
      Buffer.from(row.source_connection_id).toString("hex"),
      Buffer.from(row.identity_epoch_id).toString("hex"),
      Buffer.from(firstAccount).toString("hex"),
      Buffer.from(firstTransaction).toString("hex"),
      Buffer.from(secondAccount).toString("hex"),
      Buffer.from(secondTransaction).toString("hex"),
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push({ row, from });
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const keeper = group[0]!;
    for (const duplicate of group.slice(1)) {
      db.prepare(
        `INSERT OR IGNORE INTO transaction_relation_provenance(
           relation_id, source_record_id, capture_id, commit_id,
           evidence_source_record_key, evidence_relation_id,
           evidence_contract_version
         )
         SELECT ?, source_record_id, capture_id, commit_id,
                evidence_source_record_key, evidence_relation_id,
                evidence_contract_version
         FROM transaction_relation_provenance WHERE relation_id = ?`,
      ).run(keeper.row.relation_id, duplicate.row.relation_id);
      db.prepare("DELETE FROM transaction_relation_provenance WHERE relation_id = ?").run(
        duplicate.row.relation_id,
      );
      db.prepare("DELETE FROM current_loan_relations WHERE relation_id = ?").run(
        duplicate.row.relation_id,
      );
      db.prepare("DELETE FROM transaction_relations WHERE relation_id = ?").run(
        duplicate.row.relation_id,
      );
    }
    const row = keeper.row;
    const reversed = keeper.from === "to";
    db.prepare(
      `UPDATE transaction_relations SET relation_key = ?,
         from_account_id = ?, from_transaction_id = ?,
         from_source_record_key = ?, from_direction = ?,
         to_account_id = ?, to_transaction_id = ?,
         to_source_record_key = ?, to_direction = ?
       WHERE relation_id = ?`,
    ).run(
      key,
      reversed ? row.to_account_id : row.from_account_id,
      reversed ? row.to_transaction_id : row.from_transaction_id,
      reversed ? row.to_source_record_key : row.from_source_record_key,
      reversed ? row.to_direction : row.from_direction,
      reversed ? row.from_account_id : row.to_account_id,
      reversed ? row.from_transaction_id : row.to_transaction_id,
      reversed ? row.from_source_record_key : row.to_source_record_key,
      reversed ? row.from_direction : row.to_direction,
      row.relation_id,
    );
  }
}

function migrateV8ToV9(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureV6CompatibilitySchema(db);
    validateCanonicalCompatibilityViews(db);
    db.exec(SCHEMA_V9_LOAN_FINANCIAL);
    normalizeLoanRelationsV9(db);
    validateCanonicalLoanExtensionSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (9, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 9");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}
function applySchemaMigration(
  db: DatabaseSync,
  options: CanonicalDatabaseOptions = {},
): void {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version?: number;
  };
  const version = Number(row.user_version ?? 0);
  if (version > CANONICAL_SCHEMA_VERSION)
    throw new Error(
      `Canonical SQLite schema ${version} is newer than supported ${CANONICAL_SCHEMA_VERSION}.`,
    );
  if (version === 0 && tableExists(db, "canonical_commits"))
    throw new Error(
      "Unversioned canonical SQLite schema is not compatible; refusing ad-hoc migration.",
    );
  if (version === 1) {
    migrateV1ToV2(db);
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    migrateV6ToV7(db, options.injectMigrationFailure);
    migrateV7ToV8(db, options.injectMigrationFailure, false, true);
    migrateV8ToV9(db);
    return;
  }
  if (version === 2) {
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    migrateV6ToV7(db, options.injectMigrationFailure);
    migrateV7ToV8(db, options.injectMigrationFailure, false, true);
    migrateV8ToV9(db);
    return;
  }
  if (version === 3) {
    migrateV3ToV4(db);
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    migrateV6ToV7(db, options.injectMigrationFailure);
    migrateV7ToV8(db, options.injectMigrationFailure, false, true);
    migrateV8ToV9(db);
    return;
  }
  if (version === 4) {
    migrateV4ToV5(db, options.injectMigrationFailure);
    migrateV5ToV6(db, options.injectMigrationFailure);
    migrateV6ToV7(db, options.injectMigrationFailure);
    migrateV7ToV8(db, options.injectMigrationFailure, false, true);
    migrateV8ToV9(db);
    return;
  }
  if (version === 5) {
    migrateV5ToV6(db, options.injectMigrationFailure);
    migrateV6ToV7(db, options.injectMigrationFailure);
    migrateV7ToV8(db, options.injectMigrationFailure, false, true);
    migrateV8ToV9(db);
    return;
  }
  if (version === 6) {
    migrateV6ToV7(db, options.injectMigrationFailure);
    migrateV7ToV8(db, options.injectMigrationFailure, false, true);
    migrateV8ToV9(db);
    return;
  }
  if (version === 7) {
    // This preflight deliberately precedes every compatibility rebuild. An
    // orphan Source Record is evidence loss, not a projection repair case.
    validateV7SourceRecordScopeCoverage(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      ensureV6CompatibilitySchema(db);
      ensureV6ProjectionOriginConstraints(db);
      ensureCanonicalCaptureScopeSchema(db);
      ensureFinancialAccountCurrencySchema(db);
      ensureCanonicalFinancialRevisionSchema(db);
      ensureCanonicalTimeObservationSchema(db);
      ensureForeignCurrencyConversionSchema(db);
      ensureV7ProjectionSchema(db);
      db.exec("COMMIT");
      db.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    migrateV7ToV8(db, options.injectMigrationFailure);
    migrateV8ToV9(db);
    return;
  }
  if (version === 8) {
    validateV8SourceEvidenceSchema(db);
    migrateV8ToV9(db);
    return;
  }
  if (version === CANONICAL_SCHEMA_VERSION) {
    if (!tableExists(db, "schema_migrations"))
      throw new Error("Canonical SQLite schema version metadata is missing.");
    const migration = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(CANONICAL_SCHEMA_VERSION);
    if (!migration)
      throw new Error(
        "Canonical SQLite schema migration metadata is incomplete.",
      );
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      ensureV6CompatibilitySchema(db);
      validateCanonicalCompatibilityViews(db);
      ensureV6ProjectionOriginConstraints(db);
      ensureCanonicalCaptureScopeSchema(db);
      ensureFinancialAccountCurrencySchema(db);
      ensureCanonicalFinancialRevisionSchema(db);
      ensureCanonicalTimeObservationSchema(db);
      ensureForeignCurrencyConversionSchema(db);
      ensureV7ProjectionSchema(db);
      validateV8SourceEvidenceSchema(db);
      validateCanonicalLoanExtensionSchema(db);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  let freshV7Committed = false;
  try {
    db.exec(SCHEMA_V6);
    ensureV6SharedAssertionSpine(db);
    rebuildCurrentTransactionFieldsForSharedAssertions(db);
    convertV6CompatibilityTables(db);
    ensureV6ProjectionOriginConstraints(db);
    migrateV6ToV7(db, options.injectMigrationFailure, true);
    db.exec("COMMIT");
    freshV7Committed = true;
    db.exec("PRAGMA foreign_keys = ON");
    migrateV7ToV8(db, options.injectMigrationFailure);
    migrateV8ToV9(db);
    return;
  } catch (error) {
    if (!freshV7Committed) db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function validateReadOnlyDatabase(db: DatabaseSync): void {
  if (relationType(db, "transaction_revisions_widened") !== null)
    throw new Error(
      "Canonical financial revision widening staging requires writable recovery before read-only access.",
    );
  validateCanonicalLoanExtensionSchema(db);
  const requiredTables = [
    "capture_scopes",
    "capture_scope_pages",
    "source_subjects",
    "source_route_bindings",
    "source_record_provenance",
    "source_assertions",
    "assertion_lifecycle_events",
    "source_record_scopes",
    "current_projection_state",
    "assertions",
    "assertion_transitions",
    "assertion_provenance",
    "derived_import_runs",
    "derived_scope_coordinates",
    "derived_assertions",
    "derived_assertion_provenance",
    "derived_assertion_lifecycle_events",
    "user_assertions",
    "user_assertion_lifecycle_events",
    "user_assertion_provenance",
    "current_transaction_fields",
    "projection_generations",
    "projection_generation_provenance",
    "active_projection_generation",
    "projection_generation_transactions",
    "projection_generation_transaction_selection",
    "projection_generation_transaction_fields",
  ];
  for (const table of requiredTables) {
    if (!relationType(db, table))
      throw new Error(`Canonical schema v7 table ${table} is missing.`);
  }
  for (const table of [
    "source_assertions",
    "derived_assertions",
    "user_assertions",
    "assertion_lifecycle_events",
    "derived_assertion_lifecycle_events",
    "user_assertion_lifecycle_events",
    "derived_assertion_provenance",
    "user_assertion_provenance",
  ]) {
    if (relationType(db, table) !== "view")
      throw new Error(
        `Canonical schema v7 compatibility relation ${table} is not a read-only view.`,
      );
  }
  for (const table of [
    "assertions",
    "assertion_transitions",
    "assertion_provenance",
    "current_transaction_fields",
  ]) {
    if (relationType(db, table) !== "table")
      throw new Error(
        `Canonical schema v7 shared authority relation ${table} is not a table.`,
      );
  }
  const requiredColumns: Record<string, string[]> = {
    assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "target_kind",
      "origin",
      "producer_id",
      "rule_lineage",
      "revision_id",
      "value_text",
      "created_commit_id",
    ],
    source_assertions: [
      "assertion_id",
      "transaction_id",
      "revision_id",
      "source_record_id",
      "commit_id",
    ],
    assertion_transitions: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "capture_id",
      "scope_id",
      "run_id",
      "coordinate_id",
      "user_id",
      "commit_id",
      "event_kind",
    ],
    assertion_provenance: [
      "assertion_id",
      "source_record_id",
      "run_id",
      "coordinate_id",
      "commit_id",
    ],
    derived_import_runs: [
      "run_id",
      "source_connection_id",
      "identity_epoch_id",
      "authority_route",
      "stream",
      "producer_id",
      "origin",
      "rule_lineage",
      "observed_at",
      "commit_id",
      "status",
    ],
    derived_scope_coordinates: [
      "coordinate_id",
      "run_id",
      "transaction_id",
      "field_name",
      "producer_id",
      "origin",
      "rule_lineage",
      "output_state",
      "commit_id",
    ],
    derived_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "producer_id",
      "origin",
      "rule_lineage",
      "value_text",
      "run_id",
      "commit_id",
    ],
    derived_assertion_provenance: [
      "assertion_id",
      "run_id",
      "coordinate_id",
      "commit_id",
    ],
    derived_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "run_id",
      "coordinate_id",
      "commit_id",
      "event_kind",
    ],
    user_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "value_text",
      "commit_id",
    ],
    user_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "commit_id",
      "event_kind",
    ],
    user_assertion_provenance: ["assertion_id", "commit_id"],
    current_transaction_fields: [
      "transaction_id",
      "field_name",
      "value_text",
      "origin",
      "derived_assertion_id",
      "user_assertion_id",
      "projection_commit_id",
    ],
    source_captures: [
      "capture_key",
      "account_no",
      "source_subject_id",
      "record_kind",
      "completeness_basis",
      "completeness_rule_version",
    ],
    capture_scopes: [
      "source_subject_id",
      "scope_kind",
      "contract_fingerprint",
      "preflight_fingerprint",
      "completeness_rule_version",
    ],
    capture_scope_pages: ["response_code", "metadata_json"],
    source_records: [
      "source_subject_id",
      "record_kind",
      "provider_key",
      "content_hash",
      "occurrence_key",
      "collision_key",
    ],
    source_record_scopes: [
      "source_record_id",
      "scope_id",
      "capture_id",
      "account_id",
      "source_subject_id",
      "sequence_lexeme",
      "occurrence_key",
    ],
    transaction_revisions: [
      "economic_status",
      "administrative_state",
      "semantic_rule_version",
    ],
    current_transactions: ["projection_commit_id", "revision_commit_id"],
    projection_generations: [
      "generation_id",
      "status",
      "build_cutoff_commit_sequence",
      "rule_version",
      "created_commit_id",
      "validated_commit_id",
      "switched_commit_id",
    ],
    projection_generation_provenance: [
      "event_id",
      "generation_id",
      "ordinal",
      "previous_event_id",
      "event_kind",
      "event_source",
      "commit_id",
      "event_digest",
    ],
    active_projection_generation: [
      "singleton_id",
      "generation_id",
      "switched_commit_id",
    ],
    projection_generation_transactions: [
      "generation_id",
      "transaction_id",
      "revision_id",
      "projection_commit_id",
      "revision_commit_id",
    ],
    projection_generation_transaction_selection: [
      "generation_id",
      "transaction_id",
      "revision_id",
      "selection_commit_id",
      "selection_kind",
    ],
    projection_generation_transaction_fields: [
      "generation_id",
      "transaction_id",
      "field_name",
      "value_text",
      "origin",
      "derived_assertion_id",
      "user_assertion_id",
      "projection_commit_id",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name?: string;
        }>
      ).map((column) => column.name),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(
          `Canonical schema v6 column ${table}.${column} is missing.`,
        );
  }
  const requiredIndexes = [
    "idx_canonical_commits_sequence",
    "idx_capture_scopes_account_time",
    "idx_capture_scope_pages_proof",
    "idx_source_record_scopes_scope_sequence",
    "idx_source_record_scopes_account_capture",
    "idx_current_transactions_revision",
    "idx_assertions_lineage",
    "idx_assertion_transitions_knowledge",
    "idx_assertion_transitions_transaction",
    "idx_assertion_provenance_authority",
    "idx_derived_scope_coordinates_lineage",
    "idx_current_transaction_fields_projection",
    "idx_projection_generation_transactions_active",
    "idx_projection_generation_transactions_revision",
    "idx_projection_generation_selection_commit",
    "idx_projection_generation_provenance_ordinal",
    "idx_projection_generation_provenance_semantic",
    "idx_projection_generation_fields_active",
    "idx_projection_generations_status",
    "idx_source_subjects_identity",
    "idx_source_records_occurrence",
    "idx_source_records_collision",
    "idx_source_records_knowledge",
    "idx_source_record_provenance_capture",
  ];
  for (const index of requiredIndexes) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index)
    )
      throw new Error(`Canonical schema v6 index ${index} is missing.`);
  }
  const tableSql = (table: string): string =>
    String(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE (type = 'table' OR type = 'view') AND name = ?",
          )
          .get(table) as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
  if (
    !/FOREIGN KEY\s*\(source_record_id,\s*capture_id\)/i.test(
      tableSql("source_record_scopes"),
    ) ||
    !/capture_scopes/i.test(tableSql("source_record_scopes"))
  ) {
    throw new Error(
      "Canonical schema v7 source-record scope constraints are missing.",
    );
  }
  if (
    !/economic_status.*canceled.*refund.*reversal/i.test(
      tableSql("transaction_revisions"),
    ) ||
    !/administrative_state.*deleted.*purged/i.test(
      tableSql("transaction_revisions"),
    )
  ) {
    throw new Error("Canonical schema v7 semantic constraints are missing.");
  }
  if (
    !/origin\s+TEXT\s+NOT NULL\s+CHECK\s*\(origin\s+IN\s*\('source','derived','user'\)\)/i.test(
      tableSql("assertions"),
    )
  ) {
    throw new Error(
      "Canonical schema v7 assertion origin taxonomy is missing.",
    );
  }
  if (
    !/derived_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(
      tableSql("current_transaction_fields"),
    ) ||
    !/user_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(
      tableSql("current_transaction_fields"),
    )
  ) {
    throw new Error(
      "Canonical schema v7 current assertion references are not on the shared authority.",
    );
  }
  const transitionCheck =
    /event_kind\s+TEXT\s+NOT NULL\s+CHECK\s*\(event_kind\s+IN\s*\('observed','superseded','withdrawn'(?:,'restored')?\)\)/i;
  if (!transitionCheck.test(tableSql("assertion_transitions"))) {
    throw new Error(
      "Canonical schema v7 shared assertion transition taxonomy is missing.",
    );
  }
  const compatibilityAuthority: Record<string, RegExp> = {
    source_assertions: /FROM\s+assertions\b/i,
    derived_assertions: /FROM\s+assertions\b/i,
    user_assertions: /FROM\s+assertions\b/i,
    assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    user_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_provenance: /FROM\s+assertion_provenance\b/i,
    user_assertion_provenance: /FROM\s+assertion_provenance\b/i,
  };
  for (const [view, authority] of Object.entries(compatibilityAuthority)) {
    if (view === "source_assertions") {
      if (!sourceAssertionsViewMatchesContract(db))
        throw new Error(
          "Canonical schema v7 Source compatibility view does not preserve source origin and provenance semantics.",
        );
      continue;
    }
    if (!authority.test(tableSql(view)))
      throw new Error(
        `Canonical schema v6 compatibility view ${view} is not backed by the shared assertion spine.`,
      );
  }
  const triggerRows = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_current_transaction_fields_origin_insert', 'trg_current_transaction_fields_origin_update')",
    )
    .all() as Array<{ name?: string; sql?: string }>;
  if (
    triggerRows.length !== 2 ||
    triggerRows.some((row) => !/assertions/i.test(String(row.sql)))
  )
    throw new Error(
      "Canonical v6 current projection origin triggers are missing.",
    );
  validateProjectionGenerationProvenanceTriggers(db);
  const invalidProjectionRows = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM current_transaction_fields field
    LEFT JOIN assertions derived ON derived.assertion_id = field.derived_assertion_id
    LEFT JOIN assertions user_assertion ON user_assertion.assertion_id = field.user_assertion_id
    WHERE (field.origin = 'derived' AND (derived.origin <> 'derived' OR derived.transaction_id <> field.transaction_id OR derived.field_name <> field.field_name OR derived.assertion_id IS NULL))
       OR (field.origin = 'user' AND (user_assertion.origin <> 'user' OR user_assertion.transaction_id <> field.transaction_id OR user_assertion.field_name <> field.field_name OR user_assertion.assertion_id IS NULL))`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (invalidProjectionRows !== 0)
    throw new Error(
      "Canonical v6 current projection assertion origin is inconsistent.",
    );
  const journalMode = String(
    (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown })
      .journal_mode ?? "",
  ).toLowerCase();
  if (journalMode !== "wal")
    throw new Error(
      "Canonical SQLite WAL journal is not available for read-only access.",
    );
  const integrity = String(
    (
      db.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: unknown;
      }
    ).integrity_check ?? "",
  );
  if (integrity !== "ok")
    throw new Error(`Canonical SQLite integrity check failed: ${integrity}`);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0)
    throw new Error("Canonical SQLite foreign-key integrity check failed.");
  const projectionRelevantCommits = projectionRelevantCommitCount(db);
  const currentCount = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM current_transactions")
        .get() as { count?: number }
    ).count ?? 0,
  );
  const stateRows = db
    .prepare("SELECT generation, commit_id FROM current_projection_state")
    .all() as Array<Record<string, unknown>>;
  if (projectionRelevantCommits > 0 && stateRows.length !== 1)
    throw new Error(
      "Canonical current projection generation is missing or ambiguous.",
    );
  if (
    projectionRelevantCommits === 0 &&
    nonEmptyFinancialProjectionTables(db).length !== 0
  )
    throw new Error(
      "Canonical source-only database contains financial projection state.",
    );
  if (stateRows.length === 1) {
    if (
      Number(stateRows[0]!.generation) !== 1 ||
      !db
        .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
        .get(blob(stateRows[0]!.commit_id))
    )
      throw new Error(
        "Canonical current projection generation references no commit.",
      );
  }
  const projectionRows = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM current_transactions current_row
    JOIN financial_transactions t ON t.transaction_id = current_row.transaction_id
    JOIN transaction_revisions r ON r.revision_id = current_row.revision_id
    WHERE r.transaction_id = current_row.transaction_id AND r.commit_id = current_row.revision_commit_id
      AND current_row.commit_id = current_row.projection_commit_id`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (projectionRows !== currentCount)
    throw new Error("Canonical current projection authority is inconsistent.");
  rejectStrayProjectionGenerations(db);
  const validatedActiveGenerationId = validateActiveProjectionBoundary(db);
  if (validatedActiveGenerationId === 0) return;
  const activePointer = db
    .prepare(
      "SELECT generation_id, switched_commit_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as
    { generation_id?: number; switched_commit_id?: unknown } | undefined;
  if (!activePointer)
    throw new Error("Canonical v7 active projection pointer is missing.");
  const activeGenerationId = validatedActiveGenerationId;
  const activeGeneration = db
    .prepare(
      "SELECT status, build_cutoff_commit_sequence FROM projection_generations WHERE generation_id = ?",
    )
    .get(activeGenerationId) as
    { status?: string; build_cutoff_commit_sequence?: number } | undefined;
  if (!activeGeneration || activeGeneration.status !== "active")
    throw new Error("Canonical v7 active projection is not readable.");
  if (
    activePointer.switched_commit_id !== null &&
    activePointer.switched_commit_id !== undefined &&
    !db
      .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
      .get(blob(activePointer.switched_commit_id))
  )
    throw new Error(
      "Canonical v7 active projection pointer references no commit.",
    );
  const activeRows = Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM projection_generation_transactions WHERE generation_id = ?",
        )
        .get(activeGenerationId) as { count?: number }
    ).count ?? 0,
  );
  const activeDangling = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transactions projected
    LEFT JOIN financial_transactions transaction_row ON transaction_row.transaction_id = projected.transaction_id
    LEFT JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    WHERE projected.generation_id = ? AND (transaction_row.transaction_id IS NULL OR revision.revision_id IS NULL OR revision.transaction_id <> projected.transaction_id)`,
        )
        .get(activeGenerationId) as { count?: number }
    ).count ?? 0,
  );
  if (activeDangling !== 0)
    throw new Error(
      "Canonical v7 active projection has dangling or mixed-generation rows.",
    );
  if (activeRows !== currentCount)
    throw new Error(
      "Canonical v7 active projection does not match its compatibility mirror.",
    );
}

export function openCanonicalDatabase(
  ledgerDir: string,
  options: CanonicalDatabaseOptions = {},
): DatabaseSync {
  const path = canonicalSqlitePath(ledgerDir);
  if (options.readOnly && !existsSync(path))
    throw new Error(`Missing canonical SQLite: ${path}`);
  if (!options.readOnly) mkdirSync(ledgerDir, { recursive: true });
  const db = new DatabaseSync(path, options.readOnly ? { readOnly: true } : {});
  try {
    configureCanonicalRuntime(db, {
      readOnly: options.readOnly,
      busyTimeoutMs: options.runtime?.busyTimeoutMs ?? 30_000,
    });
    if (!options.readOnly) {
      applySchemaMigration(db, options);
      // Fresh v0 databases reach v9 through the historical migration path,
      // which predates the additive foreign-currency precision/rule allowlist.
      // Apply the same widening pass used by existing v8 ledgers before any
      // foreign capture can be admitted.
      ensureCanonicalFinancialRevisionSchema(db);
      ensureCanonicalTimeObservationSchema(db);
      ensureFinancialAccountCurrencySchema(db);
      // The conversion-evidence relation is additive and intentionally does
      // not bump the canonical schema version; old domestic ledgers remain
      // readable while newly admitted foreign captures get durable evidence.
      ensureForeignCurrencyConversionSchema(db);
      configureCanonicalRuntime(db, {
        busyTimeoutMs: options.runtime?.busyTimeoutMs ?? 30_000,
      });
      verifyCanonicalRuntime(db);
      validateCanonicalCompatibilityViews(db);
    } else {
      const row = db.prepare("PRAGMA user_version").get() as {
        user_version?: number;
      };
      if (Number(row.user_version ?? 0) !== CANONICAL_SCHEMA_VERSION)
        throw new Error(
          "Canonical SQLite schema is missing or unsupported for read-only access.",
        );
      validateReadOnlyDatabase(db);
      verifyCanonicalRuntime(db, { readOnly: true });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export type CanonicalAmount = { coefficient: string; scale: number };
export type CanonicalAssertionSupportState = "supported" | "withdrawn";
export type CanonicalEconomicStatus =
  "normal" | "canceled" | "refund" | "reversal";
export type CanonicalAdministrativeState = "active" | "deleted" | "purged";
export type CanonicalTransaction = {
  id: string;
  accountId: string;
  accountNo: string;
  sourceSequence: string;
  amount: CanonicalAmount;
  currency: "TWD";
  direction: "inflow" | "outflow";
  postingStatus: "posted";
  postingOrigin: "provider_booked_history" | "human_attested_history" | "human-attested";
  postingBasis: string;
  postingRuleVersion: string;
  assertionSupportState: CanonicalAssertionSupportState;
  economicStatus: CanonicalEconomicStatus;
  administrativeState: CanonicalAdministrativeState;
  semanticRuleVersion: string;
  displayLabel: string | null;
  displayLabelOrigin: "source" | "derived" | "user";
  displayLabelCommitSequence: number | null;
  note: string | null;
  noteOrigin: "derived" | "user" | null;
  noteCommitSequence: number | null;
  effectiveOn: string;
  effectiveTimeBasis: "accounting" | "transaction-time" | "source-reported";
  effectiveTimeRuleVersion: string;
  transactionDateTimeLocal: string;
  timeZone: typeof CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE;
  timePrecision: "date" | "minute" | "second";
  timeOrigin: "source_reported" | "defaulted_local_midnight";
  utcInstantUtcUs: number;
  revisionId: string;
  commitSequence: number;
};
export type CathayCanonicalCurrentQueryRequest = { kind: "current" };
export type CathayCanonicalCurrentQueryResult = {
  status: "ok";
  kind: "current";
  accounts: Array<{
    id: string;
    accountNo: string;
    currency: string;
    accountType: "depository" | "credit" | "loan" | "investment" | "other";
  }>;
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
export type CathayCanonicalLifecycleEvent = {
  id: string;
  kind: "observed" | "superseded" | "withdrawn" | "restored";
  commitSequence: number;
  scopeProof: {
    id: string;
    completeness: "complete-range";
    absenceAuthority: CathayAbsenceAuthority | null;
    contractFingerprint: string;
    pageCount: number;
  } | null;
};
export type CathayCanonicalLineageEntry = {
  transaction: { id: string; accountId: string; sourceSequence: string };
  revision: CanonicalTransactionRevision;
  assertion: { id: string; revisionId: string; commitSequence: number };
  sourceRecord: {
    id: string;
    captureId: string;
    sequence: string;
    description: string | null;
    payload: string;
    scopeProof: {
      id: string;
      accountId: string;
      accountNo: string;
      stream: string;
      scopeStart: string;
      scopeEnd: string;
      completeness: "complete-range";
      contractFingerprint: string;
      preflightFingerprint: string;
    };
  };
  capture: {
    id: string;
    observedAt: string;
    scopeStart: string;
    scopeEnd: string;
    authorityRoute: string;
  };
  provenance: Array<{ sourceRecordId: string; captureId: string }>;
  lifecycleEvents: CathayCanonicalLifecycleEvent[];
  derivedAssertions: Array<{
    id: string;
    field: CathayDerivedField;
    producerId: string;
    origin: string;
    ruleLineage: string;
    value: string;
    state: "supported" | "withdrawn";
    commitSequence: number;
    runId: string;
    provenance: Array<{ runId: string; coordinateId: string }>;
  }>;
  userAssertions: Array<{
    id: string;
    field: CathayUserAssertionField;
    userId: string;
    value: string;
    state: "supported" | "withdrawn";
    commitSequence: number;
    provenance: Array<{ commitSequence: number }>;
  }>;
};
export type CathayCanonicalLineageQueryResult = {
  status: "ok";
  kind: "lineage";
  subject: CathayCanonicalLineageQueryRequest["subject"];
  entries: CathayCanonicalLineageEntry[];
};
export type CanonicalTransactionRevision = CanonicalTransaction & {
  transactionId: string;
};
export interface CathayCanonicalFinancialQuery {
  current(
    request: CathayCanonicalCurrentQueryRequest,
  ): Promise<CathayCanonicalCurrentQueryResult>;
  historical(
    request: CathayCanonicalHistoricalQueryRequest,
  ): Promise<CathayCanonicalHistoricalQueryResult>;
  lineage(
    request: CathayCanonicalLineageQueryRequest,
  ): Promise<CathayCanonicalLineageQueryResult>;
}
/** Provider-scoped reader over the shared canonical financial projection. */
export type CanonicalFinancialQuery = CathayCanonicalFinancialQuery;
export type CanonicalFinancialQueryProfile = {
  integrationNamespace: string;
  postingRuleVersion: string;
};
export type CathayCommitTransactionResult = {
  transactionId: string;
  revisionId: string;
  sourceSequence: string;
  direction: "inflow" | "outflow";
  amount: CanonicalAmount;
  revisionCreated: boolean;
};
export type CathayCanonicalCommitScopeResult = {
  scopeId: string;
  accountId: string;
  accountNo: string;
  transactions: CathayCommitTransactionResult[];
};
export type CathayCanonicalCommitResult = {
  captureId: string;
  commitSequence: number;
  accountIds: string[];
  transactions: CathayCommitTransactionResult[];
  scopes: CathayCanonicalCommitScopeResult[];
};

export type CanonicalProjectionRebuildFailureInjection =
  | "creation"
  | "population"
  | "validation"
  | "pre-switch"
  | "after-generation-creation"
  | "after-generation-population"
  | "after-validation";
export type CanonicalProjectionKnowledgePoint = {
  kind: "commit-sequence";
  commitSequence: number;
};
export type CanonicalProjectionRebuildOptions = CanonicalRuntimeOptions & {
  cutoff?: CanonicalProjectionKnowledgePoint;
  injectFailure?: CanonicalProjectionRebuildFailureInjection;
  clock?: CanonicalAdmissionClock;
};
export type CanonicalProjectionRebuildResult = {
  status: "switched";
  previousGeneration: number;
  generation: number;
  cutoffCommitSequence: number;
  commitSequence: number;
  transactionCount: number;
  fieldCount: number;
};

function dbRow<T extends Record<string, unknown>>(value: unknown): T {
  return value as T;
}
function sameRevision(
  row: Record<string, unknown>,
  detail: ValidatedCathayRow,
): boolean {
  return (
    row.amount_coefficient === detail.amount.coefficient.toString() &&
    row.amount_scale === detail.amount.scale &&
    row.direction === detail.direction &&
    row.posting_status === CATHAY_POSTING_MAPPING.postingStatus &&
    row.posting_origin === CATHAY_POSTING_MAPPING.origin &&
    row.posting_basis === CATHAY_POSTING_MAPPING.basis &&
    row.posting_rule_version === CATHAY_POSTING_MAPPING.ruleVersion &&
    row.description === detail.description &&
    row.effective_on === detail.accountDate &&
    row.transaction_date_time_local === detail.transactionDateTime &&
    row.time_zone === CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE &&
    row.time_precision === "second" &&
    row.time_origin === "source_reported" &&
    row.effective_time_basis === "accounting" &&
    row.effective_time_rule_version === CATHAY_POSTING_MAPPING.ruleVersion &&
    Number(row.utc_instant_utc_us) === detail.utcInstantUtcUs
  );
}
function recordedAtUtcUs(value: string): number {
  return parseRfc3339UtcMicros(value, "Canonical admission clock");
}

function currentUtcMicros(): number {
  return parseRfc3339UtcMicros(
    new Date().toISOString(),
    "Canonical migration clock",
  );
}

export type CanonicalAdmissionClock = () => string;
export type CathayCanonicalCommitOptions = {
  clock?: CanonicalAdmissionClock;
  runtime?: CanonicalRuntimeOptions;
};

type LifecycleEventKind = CathayCanonicalLifecycleEvent["kind"];
function insertLifecycleEvent(
  db: DatabaseSync,
  values: {
    assertionId: CanonicalId;
    transactionId: CanonicalId;
    revisionId: CanonicalId;
    captureId: CanonicalId;
    scopeId: CanonicalId | null;
    commitId: CanonicalId;
    kind: LifecycleEventKind;
  },
): void {
  const eventId = uuidV7();
  db.prepare(
    "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, 'transaction_revision', ?, ?, NULL, NULL, NULL, ?, ?)",
  ).run(
    eventId,
    values.assertionId,
    values.transactionId,
    values.captureId,
    values.scopeId,
    values.commitId,
    values.kind,
  );
}
function latestLifecycleEvent(
  db: DatabaseSync,
  assertionId: CanonicalId,
): LifecycleEventKind | null {
  const row = db
    .prepare(
      `SELECT e.event_kind FROM assertion_transitions e JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE e.assertion_id = ? ORDER BY c.commit_sequence DESC, e.event_id DESC LIMIT 1`,
    )
    .get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind as LifecycleEventKind | null;
}

function commitCathayDomesticDepositSyncOnce(
  ledgerDir: string,
  input: ValidatedCathaySync,
  admissionClock: CanonicalAdmissionClock,
  runtime?: CanonicalRuntimeOptions,
): CathayCanonicalCommitResult {
  const db = openCanonicalDatabase(ledgerDir, { runtime });
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const commitId = uuidV7();
    const maxSequence = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
          )
          .get() as { max_sequence?: number }
      ).max_sequence ?? 0,
    );
    const commitSequence = maxSequence + 1;
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, ?)",
    ).run(
      commitId,
      commitSequence,
      recordedAtUtcUs(admissionClock()),
      input.authorityRoute,
      "source_capture",
    );
    db.prepare(
      "INSERT OR IGNORE INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?)",
    ).run(
      input.authorityRoute,
      CATHAY_INTEGRATION_NAMESPACE,
      input.stream,
      CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
      commitId,
    );
    const connectionExisting = db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
      )
      .get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    const sourceConnectionId = connectionExisting
      ? blob(
          dbRow<{ source_connection_id: unknown }>(connectionExisting)
            .source_connection_id,
        )
      : uuidV7();
    if (!connectionExisting)
      db.prepare(
        "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?)",
      ).run(
        sourceConnectionId,
        CATHAY_INTEGRATION_NAMESPACE,
        input.sourceConnectionId,
        commitId,
      );
    const epochExisting = db
      .prepare(
        "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
      )
      .get(sourceConnectionId, input.identityEpoch);
    const identityEpochId = epochExisting
      ? blob(
          dbRow<{ identity_epoch_id: unknown }>(epochExisting)
            .identity_epoch_id,
        )
      : uuidV7();
    if (!epochExisting)
      db.prepare(
        "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?)",
      ).run(identityEpochId, sourceConnectionId, input.identityEpoch, commitId);
    const accountIds = new Map<string, CanonicalId>();
    for (const scope of input.scopes) {
      const existing = db
        .prepare(
          "SELECT account_id, currency, account_type FROM financial_accounts WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND account_no = ?",
        )
        .get(
          sourceConnectionId,
          identityEpochId,
          input.stream,
          scope.accountNo,
        );
      const accountId = existing
        ? blob(dbRow<{ account_id: unknown }>(existing).account_id)
        : uuidV7();
      if (existing) {
        const row = dbRow<{ currency: string; account_type: string }>(existing);
        if (
          row.currency !== scope.currency ||
          row.account_type !== "depository"
        )
          throw new Error(
            "Cathay account identity has conflicting required classification.",
          );
      } else
        db.prepare(
          "INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, account_no, account_type, currency, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          accountId,
          sourceConnectionId,
          identityEpochId,
          input.stream,
          scope.accountNo,
          "depository",
          scope.currency,
          commitId,
        );
      accountIds.set(scope.accountNo, accountId);
    }
    const captureId = uuidV7();
    const captureStart = [...input.scopes]
      .map((scope) => scope.startDate)
      .sort()[0]!;
    const captureEnd = [...input.scopes]
      .map((scope) => scope.endDate)
      .sort()
      .at(-1)!;
    db.prepare(
      "INSERT INTO source_captures(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      captureId,
      sourceConnectionId,
      identityEpochId,
      input.authorityRoute,
      input.stream,
      input.scopes.length === 1 ? input.scopes[0]!.accountNo : null,
      input.observedAt,
      captureStart,
      captureEnd,
      CATHAY_COMPLETENESS_PROOF.kind,
      CATHAY_COMPLETENESS_PROOF.basis,
      CATHAY_COMPLETENESS_PROOF.ruleVersion,
      commitId,
    );
    const allTransactions: CathayCommitTransactionResult[] = [];
    const scopeResults: CathayCanonicalCommitScopeResult[] = [];
    for (const scope of input.scopes) {
      const accountId = accountIds.get(scope.accountNo)!;
      const scopeId = uuidV7();
      db.prepare(
        "INSERT INTO capture_scopes(scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, account_no, stream, scope_start, scope_end, scope_kind, completeness, completeness_basis, completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        scopeId,
        captureId,
        sourceConnectionId,
        identityEpochId,
        accountId,
        scope.accountNo,
        input.stream,
        scope.startDate,
        scope.endDate,
        "bounded-range",
        CATHAY_COMPLETENESS_PROOF.kind,
        CATHAY_COMPLETENESS_PROOF.basis,
        CATHAY_COMPLETENESS_PROOF.ruleVersion,
        scope.absenceAuthority ?? null,
        scope.contractFingerprint,
        scope.preflightFingerprint,
        scope.pages.length,
        1,
        commitId,
      );
      for (const page of scope.pages)
        db.prepare(
          "INSERT INTO capture_scope_pages(scope_page_id, scope_id, page_ordinal, terminal, row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          uuidV7(),
          scopeId,
          page.pageOrdinal,
          page.terminal ? 1 : 0,
          page.rowCount,
          page.responseDigest,
          CATHAY_COMPLETENESS_PROOF.basis,
          scope.contractFingerprint,
          scope.preflightFingerprint,
          commitId,
        );
      const seenSequences = new Set(scope.rows.map((row) => row.sequence));
      const scopeTransactions: CathayCommitTransactionResult[] = [];
      for (const detail of scope.rows) {
        const sourceRecordId = uuidV7();
        db.prepare(
          "INSERT INTO source_records(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          sourceRecordId,
          captureId,
          commitId,
          detail.sequence,
          detail.description,
          detail.payload,
        );
        db.prepare(
          "INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, sequence_lexeme, commit_id) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          sourceRecordId,
          scopeId,
          captureId,
          accountId,
          detail.sequence,
          commitId,
        );
        const existingTransaction = db
          .prepare(
            "SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
          )
          .get(accountId, detail.sequence);
        const transactionId = existingTransaction
          ? blob(
              dbRow<{ transaction_id: unknown }>(existingTransaction)
                .transaction_id,
            )
          : uuidV7();
        if (!existingTransaction)
          db.prepare(
            "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)",
          ).run(transactionId, accountId, detail.sequence, commitId);
        const latest = db
          .prepare(
            "SELECT * FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1",
          )
          .get(transactionId);
        const latestRow = latest
          ? dbRow<Record<string, unknown>>(latest)
          : undefined;
        const revisionCreated = !latestRow || !sameRevision(latestRow, detail);
        let revisionId = latestRow ? blob(latestRow.revision_id) : uuidV7();
        let assertionId: CanonicalId;
        if (revisionCreated) {
          if (latestRow) {
            const oldAssertion = db
              .prepare(
                "SELECT assertion_id FROM assertions WHERE origin = 'source' AND revision_id = ?",
              )
              .get(blob(latestRow.revision_id));
            if (oldAssertion)
              insertLifecycleEvent(db, {
                assertionId: blob(
                  dbRow<{ assertion_id: unknown }>(oldAssertion).assertion_id,
                ),
                transactionId,
                revisionId: blob(latestRow.revision_id),
                captureId,
                scopeId,
                commitId,
                kind: "superseded",
              });
          }
          revisionId = uuidV7();
          const revisionNumber = latestRow
            ? Number(latestRow.revision_number) + 1
            : 1;
          db.prepare(
            `INSERT INTO transaction_revisions(
          revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency,
            direction, posting_status, posting_origin, posting_basis, posting_rule_version, description, economic_status, administrative_state, semantic_rule_version, effective_on, transaction_date_time_local,
            time_zone, time_precision, time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            revisionId,
            transactionId,
            sourceRecordId,
            captureId,
            commitId,
            revisionNumber,
            detail.amount.coefficient.toString(),
            detail.amount.scale,
            scope.currency,
            detail.direction,
            CATHAY_POSTING_MAPPING.postingStatus,
            CATHAY_POSTING_MAPPING.origin,
            CATHAY_POSTING_MAPPING.basis,
            CATHAY_POSTING_MAPPING.ruleVersion,
            detail.description,
            "normal",
            "active",
            CATHAY_POSTING_MAPPING.ruleVersion,
            detail.accountDate,
            detail.transactionDateTime,
            CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
            "second",
            "source_reported",
            "accounting",
            CATHAY_POSTING_MAPPING.ruleVersion,
            detail.utcInstantUtcUs,
          );
          const observation = db.prepare(
            "INSERT INTO transaction_time_observations(observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          );
          observation.run(
            uuidV7(),
            transactionId,
            revisionId,
            sourceRecordId,
            commitId,
            "accounting",
            detail.accountDate,
            CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
            "date",
            "source_reported",
            detail.accountingUtcInstantUtcUs,
          );
          observation.run(
            uuidV7(),
            transactionId,
            revisionId,
            sourceRecordId,
            commitId,
            "occurred",
            detail.transactionDateTime,
            CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
            "second",
            "source_reported",
            detail.utcInstantUtcUs,
          );
          assertionId = uuidV7();
          db.prepare(
            "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES (?, ?, 'transaction_revision', 'transaction', 'source', ?, ?, ?, NULL, ?)",
          ).run(
            assertionId,
            transactionId,
            input.authorityRoute,
            input.authorityRoute,
            revisionId,
            commitId,
          );
          insertLifecycleEvent(db, {
            assertionId,
            transactionId,
            revisionId,
            captureId,
            scopeId,
            commitId,
            kind: "observed",
          });
          db.prepare(
            "INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET revision_id = excluded.revision_id, commit_id = excluded.commit_id, projection_commit_id = excluded.projection_commit_id, revision_commit_id = excluded.revision_commit_id",
          ).run(transactionId, revisionId, commitId, commitId, commitId);
        } else {
          const assertion = db
            .prepare(
              "SELECT assertion_id FROM assertions WHERE origin = 'source' AND transaction_id = ? AND revision_id = ?",
            )
            .get(transactionId, revisionId);
          if (!assertion)
            throw new Error("Canonical assertion was not created.");
          assertionId = blob(
            dbRow<{ assertion_id: unknown }>(assertion).assertion_id,
          );
          const wasWithdrawn =
            latestLifecycleEvent(db, assertionId) === "withdrawn";
          if (wasWithdrawn)
            insertLifecycleEvent(db, {
              assertionId,
              transactionId,
              revisionId,
              captureId,
              scopeId,
              commitId,
              kind: "restored",
            });
          if (wasWithdrawn) {
            const revisionCommit = blob(
              dbRow<{ commit_id: unknown }>(
                db
                  .prepare(
                    "SELECT commit_id FROM transaction_revisions WHERE revision_id = ?",
                  )
                  .get(revisionId),
              ).commit_id,
            );
            db.prepare(
              "INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET revision_id = excluded.revision_id, commit_id = excluded.commit_id, projection_commit_id = excluded.projection_commit_id, revision_commit_id = excluded.revision_commit_id",
            ).run(
              transactionId,
              revisionId,
              commitId,
              commitId,
              revisionCommit,
            );
          }
        }
        db.prepare(
          "INSERT INTO assertion_provenance(assertion_id, source_record_id, commit_id) VALUES (?, ?, ?)",
        ).run(assertionId, sourceRecordId, commitId);
        const result = {
          transactionId: idToString(transactionId),
          revisionId: idToString(revisionId),
          sourceSequence: detail.sequence,
          direction: detail.direction,
          amount: {
            coefficient: detail.amount.coefficient.toString(),
            scale: detail.amount.scale,
          },
          revisionCreated,
        } satisfies CathayCommitTransactionResult;
        scopeTransactions.push(result);
        allTransactions.push(result);
      }
      if (scope.absenceAuthority) {
        const prior = db
          .prepare(
            `SELECT sa.assertion_id, sa.transaction_id, sa.revision_id, t.source_sequence FROM assertions sa
          JOIN financial_transactions t ON t.transaction_id = sa.transaction_id JOIN transaction_revisions r ON r.revision_id = sa.revision_id
          JOIN current_transactions current_row ON current_row.transaction_id = t.transaction_id AND current_row.revision_id = r.revision_id
          JOIN assertion_provenance provenance ON provenance.assertion_id = sa.assertion_id
          JOIN source_records prior_record ON prior_record.source_record_id = provenance.source_record_id
          JOIN source_record_scopes prior_record_scope ON prior_record_scope.source_record_id = prior_record.source_record_id
          JOIN capture_scopes prior_scope ON prior_scope.scope_id = prior_record_scope.scope_id
          JOIN source_captures prior_capture ON prior_capture.capture_id = prior_scope.capture_id
          WHERE sa.origin = 'source' AND t.account_id = ? AND r.effective_on BETWEEN ? AND ?
            AND prior_scope.source_connection_id = ? AND prior_scope.identity_epoch_id = ? AND prior_scope.account_id = ?
            AND prior_scope.stream = ? AND prior_scope.scope_kind = 'bounded-range'
            AND prior_scope.completeness = 'complete-range' AND prior_scope.completeness_rule_version = ?
            AND prior_scope.contract_fingerprint = ? AND prior_scope.preflight_fingerprint = ?
            AND prior_capture.authority_route = ? AND prior_capture.stream = ?`,
          )
          .all(
            accountId,
            scope.startDate,
            scope.endDate,
            sourceConnectionId,
            identityEpochId,
            accountId,
            input.stream,
            CATHAY_COMPLETENESS_PROOF.ruleVersion,
            scope.contractFingerprint,
            scope.preflightFingerprint,
            input.authorityRoute,
            input.stream,
          ) as Array<Record<string, unknown>>;
        for (const row of prior) {
          if (seenSequences.has(String(row.source_sequence))) continue;
          const assertionId = blob(row.assertion_id);
          if (latestLifecycleEvent(db, assertionId) === "withdrawn") continue;
          insertLifecycleEvent(db, {
            assertionId,
            transactionId: blob(row.transaction_id),
            revisionId: blob(row.revision_id),
            captureId,
            scopeId,
            commitId,
            kind: "withdrawn",
          });
          db.prepare(
            "DELETE FROM current_transactions WHERE transaction_id = ? AND revision_id = ?",
          ).run(blob(row.transaction_id), blob(row.revision_id));
        }
      }
      db.prepare(
        `INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET scope_start = excluded.scope_start,
        scope_end = excluded.scope_end, cursor = excluded.cursor, last_capture_id = excluded.last_capture_id, commit_id = excluded.commit_id`,
      ).run(
        sourceConnectionId,
        accountId,
        input.stream,
        scope.startDate,
        scope.endDate,
        input.syncState.cursor ?? null,
        captureId,
        commitId,
      );
      scopeResults.push({
        scopeId: idToString(scopeId),
        accountId: idToString(accountId),
        accountNo: scope.accountNo,
        transactions: scopeTransactions,
      });
    }
    syncActiveProjectionFromCompatibility(db, commitId);
    db.prepare(
      "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id",
    ).run(commitId);
    db.exec("COMMIT");
    inTransaction = false;
    return {
      captureId: idToString(captureId),
      commitSequence,
      accountIds: [...accountIds.values()].map(idToString),
      transactions: allTransactions,
      scopes: scopeResults,
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

async function withCanonicalWriter<T>(
  ledgerDir: string,
  operation: () => T,
  runtime?: CanonicalRuntimeOptions,
): Promise<T> {
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    operation,
    runtime,
  );
}

function rebuildFailure(
  stage: CanonicalProjectionRebuildFailureInjection | undefined,
  expected: CanonicalProjectionRebuildFailureInjection[],
): void {
  if (stage !== undefined && expected.includes(stage))
    throw new Error(`Injected projection rebuild failure at ${stage}.`);
}

function rebuildCathayCanonicalProjectionOnce(
  ledgerDir: string,
  options: CanonicalProjectionRebuildOptions,
): CanonicalProjectionRebuildResult {
  const db = openCanonicalDatabase(ledgerDir, { runtime: options });
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    rejectStrayProjectionGenerations(db);
    const latest = db
      .prepare(
        "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
      )
      .get() as { max_sequence?: number };
    const currentKnowledgePoint = Number(latest.max_sequence ?? 0);
    const cutoff = options.cutoff?.commitSequence ?? currentKnowledgePoint;
    if (
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      cutoff > currentKnowledgePoint
    )
      throw new Error(
        "Projection rebuild cutoff must be a retained Canonical Knowledge Point.",
      );
    const active = db
      .prepare(
        "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
      )
      .get() as { generation_id?: number } | undefined;
    if (!active)
      throw new Error("Projection rebuild requires an active generation.");
    const previousGeneration = Number(active.generation_id);
    const generation =
      Number(
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(generation_id), 0) AS generation_id FROM projection_generations",
            )
            .get() as { generation_id?: number }
        ).generation_id ?? 0,
      ) + 1;
    const commitId = uuidV7();
    const commitSequence = currentKnowledgePoint + 1;
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, 'canonical/projection/v1', 'projection_rebuild')",
    ).run(
      commitId,
      commitSequence,
      recordedAtUtcUs((options.clock ?? (() => new Date().toISOString()))()),
    );
    db.prepare(
      `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id)
      VALUES (?, 'building', ?, 'canonical/projection/v1', ?)`,
    ).run(generation, cutoff, commitId);
    recordProjectionGenerationEvent(
      db,
      generation,
      "created",
      "rebuild",
      commitId,
    );
    rebuildFailure(options.injectFailure, [
      "creation",
      "after-generation-creation",
    ]);
    db.prepare(
      `INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id)
      SELECT ?, t.transaction_id, revision.revision_id, ?, revision.commit_id
      FROM financial_transactions t JOIN transaction_revisions revision ON revision.transaction_id = t.transaction_id
      JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
      JOIN assertions source_assertion ON source_assertion.revision_id = revision.revision_id AND source_assertion.origin = 'source'
      WHERE revision_commit.commit_sequence <= ?
        AND NOT EXISTS (SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
          WHERE newer.transaction_id = revision.transaction_id AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > revision_commit.commit_sequence)
        AND COALESCE((SELECT transition.event_kind FROM assertion_transitions transition JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
          WHERE transition.assertion_id = source_assertion.assertion_id AND transition_commit.commit_sequence <= ?
          ORDER BY transition_commit.commit_sequence DESC, transition.event_id DESC LIMIT 1), 'observed') <> 'withdrawn'`,
    ).run(generation, commitId, cutoff, cutoff, cutoff);
    db.prepare(
      `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
      SELECT generation_id, transaction_id, revision_id, projection_commit_id, 'rebuild'
      FROM projection_generation_transactions WHERE generation_id = ?`,
    ).run(generation);
    db.prepare(
      `INSERT INTO current_loan_accounts(
         generation_id, account_id, projection_commit_id, created_commit_id
       )
       SELECT ?, identity.account_id, ?, identity.created_commit_id
       FROM loan_account_identities identity
       JOIN canonical_commits created ON created.commit_id = identity.created_commit_id
       WHERE identity.account_type = 'loan' AND identity.stream = 'loan'
         AND created.commit_sequence <= ?`,
    ).run(generation, commitId, cutoff);
    db.prepare(
      `INSERT INTO current_loan_balance_observations(
         generation_id, account_id, balance_kind, observation_id, revision_id,
         projection_commit_id, revision_commit_id
       )
       SELECT ?, ranked.account_id, ranked.balance_kind, ranked.observation_id,
              ranked.revision_id, ?, ranked.commit_id
       FROM (
         SELECT observation.account_id, observation.balance_kind,
                observation.observation_id, revision.revision_id, revision.commit_id,
                ROW_NUMBER() OVER (
                  PARTITION BY observation.account_id, observation.balance_kind
                  ORDER BY revision.effective_at DESC,
                           revision_commit.commit_sequence DESC,
                           COALESCE(balance_fact.occurrence_index, -1) DESC,
                           balance_record.occurrence_key DESC,
                           observation.observation_key DESC,
                           hex(revision.revision_id) DESC
                ) AS rank
         FROM balance_observations observation
         JOIN balance_observation_revisions revision
           ON revision.observation_id = observation.observation_id
         JOIN canonical_commits revision_commit
           ON revision_commit.commit_id = revision.commit_id
         JOIN source_records balance_record
           ON balance_record.source_record_id = revision.source_record_id
         LEFT JOIN loan_transaction_facts balance_fact
           ON balance_fact.revision_id = (
             SELECT transaction_revision.revision_id
             FROM transaction_revisions transaction_revision
             WHERE transaction_revision.source_record_id = revision.source_record_id
             ORDER BY transaction_revision.revision_number DESC
             LIMIT 1
           )
         WHERE revision_commit.commit_sequence <= ?
       ) ranked WHERE ranked.rank = 1`,
    ).run(generation, commitId, cutoff);
    db.prepare(
      `INSERT INTO current_loan_relations(
         generation_id, relation_id, projection_commit_id, relation_commit_id
       )
       SELECT ?, relation.relation_id, ?, relation.commit_id
       FROM transaction_relations relation
       JOIN canonical_commits relation_commit
         ON relation_commit.commit_id = relation.commit_id
       WHERE relation_commit.commit_sequence <= ?`,
    ).run(generation, commitId, cutoff);
    const insertField =
      db.prepare(`INSERT INTO projection_generation_transaction_fields(generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const generationTransactions = db
      .prepare(
        "SELECT transaction_id FROM projection_generation_transactions WHERE generation_id = ?",
      )
      .all(generation) as Array<Record<string, unknown>>;
    let fieldCount = 0;
    for (const transaction of generationTransactions) {
      for (const field of ["display_name", "note"] as const) {
        const selected =
          selectAssertionAsOf(
            db,
            blob(transaction.transaction_id),
            field,
            cutoff,
            "user",
          ) ??
          selectAssertionAsOf(
            db,
            blob(transaction.transaction_id),
            field,
            cutoff,
            "derived",
          );
        if (!selected) continue;
        const assertion = blob(selected.assertion_id);
        insertField.run(
          generation,
          blob(transaction.transaction_id),
          field,
          selected.value_text,
          selected.origin,
          selected.origin === "derived" ? assertion : null,
          selected.origin === "user" ? assertion : null,
          commitId,
        );
        fieldCount += 1;
      }
    }
    rebuildFailure(options.injectFailure, [
      "population",
      "after-generation-population",
    ]);
    const dangling = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM projection_generation_transactions projected
      LEFT JOIN financial_transactions transaction_row ON transaction_row.transaction_id = projected.transaction_id
      LEFT JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
      WHERE projected.generation_id = ? AND (transaction_row.transaction_id IS NULL OR revision.revision_id IS NULL OR revision.transaction_id <> projected.transaction_id)`,
          )
          .get(generation) as { count?: number }
      ).count ?? 0,
    );
    if (dangling !== 0)
      throw new Error(
        "Projection rebuild validation failed for references or exact arithmetic.",
      );
    validateGenerationTransactionIntegrity(db, generation, cutoff);
    validateGenerationFieldCompleteness(db, generation, cutoff);
    validateSelectedAssertionProvenance(db, generation, cutoff);
    validateGenerationExactAmounts(db, generation);
    validateCanonicalAuthorityRoutes(db, generation);
    validateGenerationFieldIntegrity(db, generation);
    validateGenerationLifecycleCoordinates(db, generation);
    validateUserAssertionProvenanceAuthority(db);
    const duplicate = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (SELECT transaction_id FROM projection_generation_transactions WHERE generation_id = ? GROUP BY transaction_id HAVING COUNT(*) <> 1)`,
          )
          .get(generation) as { count?: number }
      ).count ?? 0,
    );
    if (duplicate !== 0)
      throw new Error(
        "Projection rebuild validation found duplicate transaction authority.",
      );
    rebuildFailure(options.injectFailure, ["validation", "after-validation"]);
    db.prepare(
      "UPDATE projection_generations SET status = 'validated', validated_commit_id = ? WHERE generation_id = ?",
    ).run(commitId, generation);
    recordProjectionGenerationEvent(
      db,
      generation,
      "validated",
      "rebuild",
      commitId,
    );
    validateProjectionGenerationProvenance(db, generation);
    rebuildFailure(options.injectFailure, ["pre-switch"]);
    db.prepare(
      "UPDATE projection_generations SET status = 'retired' WHERE status = 'active'",
    ).run();
    db.prepare(
      "UPDATE projection_generations SET status = 'active', switched_commit_id = ? WHERE generation_id = ?",
    ).run(commitId, generation);
    recordProjectionGenerationEvent(
      db,
      generation,
      "switched",
      "rebuild",
      commitId,
    );
    db.prepare(
      "UPDATE active_projection_generation SET generation_id = ?, switched_commit_id = ? WHERE singleton_id = 1",
    ).run(generation, commitId);
    db.prepare("DELETE FROM current_transactions").run();
    db.prepare(
      `INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id)
      SELECT transaction_id, revision_id, ?, projection_commit_id, revision_commit_id FROM projection_generation_transactions WHERE generation_id = ?`,
    ).run(commitId, generation);
    db.prepare("DELETE FROM current_transaction_fields").run();
    db.prepare(
      `INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
      SELECT transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, ? FROM projection_generation_transaction_fields WHERE generation_id = ?`,
    ).run(commitId, generation);
    db.prepare(
      "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id",
    ).run(commitId);
    validateProjectionGenerationProvenance(db, generation);
    db.exec("COMMIT");
    inTransaction = false;
    return {
      status: "switched",
      previousGeneration,
      generation,
      cutoffCommitSequence: cutoff,
      commitSequence,
      transactionCount: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM projection_generation_transactions WHERE generation_id = ?",
            )
            .get(generation) as { count?: number }
        ).count ?? 0,
      ),
      fieldCount,
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function rebuildCathayCanonicalProjection(
  ledgerDir: string,
  options: CanonicalProjectionRebuildOptions = {},
): Promise<CanonicalProjectionRebuildResult> {
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    () => rebuildCathayCanonicalProjectionOnce(ledgerDir, options),
    options,
  );
}

/** Generic name for callers that do not depend on the Cathay adapter. */
export const rebuildCanonicalProjection = rebuildCathayCanonicalProjection;

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
    pages: [
      {
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
      },
    ],
  });
  return withCanonicalWriter(
    ledgerDir,
    () =>
      commitCathayDomesticDepositSyncOnce(
        ledgerDir,
        sync,
        admissionClock,
        options.runtime,
      ),
    options.runtime,
  );
}

export function commitCathayDomesticDepositSync(
  ledgerDir: string,
  input: CathayDomesticDepositSyncInput,
  options: CathayCanonicalCommitOptions = {},
): Promise<CathayCanonicalCommitResult> {
  const validated = validateSyncInput(input);
  const admissionClock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(
    ledgerDir,
    () =>
      commitCathayDomesticDepositSyncOnce(
        ledgerDir,
        validated,
        admissionClock,
        options.runtime,
      ),
    options.runtime,
  );
}

function importCoordinates(
  input: CathayDerivedImportRunInput,
): CathayDerivedImportCoordinate[] {
  if (!Array.isArray(input.subjectIds) || input.subjectIds.length === 0)
    throw new Error("A complete derived import requires non-empty subjectIds.");
  if (!Array.isArray(input.fields) || input.fields.length === 0)
    throw new Error("A complete derived import requires non-empty fields.");
  if (!Array.isArray(input.scope) || input.scope.length === 0)
    throw new Error(
      "A complete derived import requires a non-empty coordinate matrix.",
    );
  const subjectIds = input.subjectIds.map((subjectId) => {
    if (
      typeof subjectId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        subjectId,
      )
    )
      throw new Error(
        "Derived import subjectIds contains an invalid transaction subject.",
      );
    return subjectId;
  });
  if (
    new Set(subjectIds.map((subjectId) => subjectId.toLowerCase())).size !==
    subjectIds.length
  )
    throw new Error(
      "Derived import subjectIds contains a duplicate transaction subject.",
    );
  const fields = input.fields.map((field) => {
    if (field !== "display_name" && field !== "note")
      throw new Error("Derived import fields contains an unsupported field.");
    return field;
  });
  if (new Set(fields).size !== fields.length)
    throw new Error("Derived import fields contains a duplicate field.");
  const normalized = normalizeDerivedCoordinates(input.scope);
  const expected = new Set(
    subjectIds.flatMap((subjectId) =>
      fields.map((field) => `${subjectId.toLowerCase()}:${field}`),
    ),
  );
  for (const coordinate of normalized) {
    const key = `${coordinate.transactionId.toLowerCase()}:${coordinate.field}`;
    if (!expected.has(key))
      throw new Error(
        "Derived import scope contains a coordinate outside the declared subject/field matrix.",
      );
    expected.delete(key);
  }
  if (expected.size > 0)
    throw new Error(
      "Derived import scope is missing a declared subject/field coordinate.",
    );
  return normalized;
}

function normalizeDerivedCoordinates(
  first: CathayDerivedImportCoordinate[],
): CathayDerivedImportCoordinate[] {
  const normalized = first.map((coordinate) => {
    if (!coordinate || typeof coordinate !== "object")
      throw new Error("Derived import coordinate must be an object.");
    if (
      !coordinate.transactionId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        coordinate.transactionId,
      )
    )
      throw new Error(
        "Derived import coordinate has an invalid transaction subject.",
      );
    const normalizedField = coordinate.field;
    if (normalizedField !== "display_name" && normalizedField !== "note")
      throw new Error("Derived import field is not supported.");
    if (coordinate.state !== "supported" && coordinate.state !== "unsupported")
      throw new Error("Derived import coordinate has an invalid output state.");
    if (
      coordinate.state === "supported" &&
      typeof coordinate.value !== "string"
    )
      throw new Error(
        "Supported derived output must provide a typed string value.",
      );
    if (
      coordinate.state === "unsupported" &&
      coordinate.value !== undefined &&
      coordinate.value !== null
    )
      throw new Error("Unsupported derived output cannot carry a value.");
    return {
      transactionId: coordinate.transactionId,
      field: normalizedField,
      state: coordinate.state,
      value: coordinate.state === "supported" ? coordinate.value! : null,
    };
  });
  const seen = new Set<string>();
  for (const coordinate of normalized) {
    const key = `${coordinate.transactionId}:${coordinate.field}`;
    if (seen.has(key))
      throw new Error(
        "Derived import coordinate matrix contains a duplicate subject/field.",
      );
    seen.add(key);
  }
  if (normalized.length === 0)
    throw new Error(
      "A complete derived import requires a non-empty subject/field coordinate matrix.",
    );
  return normalized;
}

function validateDerivedImportInput(
  input: CathayDerivedImportRunInput,
): CathayDerivedImportCoordinate[] {
  if (!input.sourceConnectionId.trim() || !input.identityEpoch.trim())
    throw new Error(
      "Derived import Source Connection and Identity Epoch are required.",
    );
  if (
    input.authorityRoute !== CATHAY_DOMESTIC_DEPOSIT_AUTHORITY ||
    input.stream !== CATHAY_DOMESTIC_DEPOSIT_STREAM
  )
    throw new Error(
      "Derived import authority route or stream is not supported.",
    );
  if (!input.producerId.trim() || !input.ruleLineage.trim())
    throw new Error("Derived import producer and rule lineage are required.");
  if (input.origin !== undefined && input.origin !== CATHAY_DERIVED_ORIGIN)
    throw new Error(
      "Derived import origin is not a registered Derived origin.",
    );
  if (input.complete !== true || input.status !== "complete")
    throw new Error(
      "Only a complete successful derived import may mutate canonical data.",
    );
  if (input.observedAt !== undefined)
    parseRfc3339UtcMicros(input.observedAt, "Derived import observedAt");
  return importCoordinates(input);
}

function validateDerivedImportSubjects(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  coordinates: CathayDerivedImportCoordinate[],
): void {
  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    const connection = db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
      )
      .get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    if (!connection)
      throw new Error(
        "Derived import source connection is unknown; source lineage must already exist.",
      );
    const sourceConnectionId = blob(
      dbRow<{ source_connection_id: unknown }>(connection).source_connection_id,
    );
    const epoch = db
      .prepare(
        "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
      )
      .get(sourceConnectionId, input.identityEpoch);
    if (!epoch)
      throw new Error(
        "Derived import identity epoch is unknown; source lineage must already exist.",
      );
    const identityEpochId = blob(
      dbRow<{ identity_epoch_id: unknown }>(epoch).identity_epoch_id,
    );
    for (const coordinate of coordinates) {
      const transactionId = idFromString(coordinate.transactionId);
      const transaction = db
        .prepare(
          `SELECT a.source_connection_id, a.identity_epoch_id, a.stream
        FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        WHERE t.transaction_id = ?`,
        )
        .get(transactionId) as Record<string, unknown> | undefined;
      if (!transaction)
        throw new Error(
          "Derived import targets an unknown transaction subject.",
        );
      if (
        Buffer.compare(
          blob(transaction.source_connection_id),
          sourceConnectionId,
        ) !== 0 ||
        Buffer.compare(blob(transaction.identity_epoch_id), identityEpochId) !==
          0 ||
        transaction.stream !== input.stream
      )
        throw new Error(
          "Derived import crossed a source identity or stream boundary.",
        );
    }
  } finally {
    db.close();
  }
}

function derivedDiagnostic(
  error: unknown,
  input: CathayDerivedImportRunInput,
  stage: CathayDerivedImportDiagnostic["stage"],
): CathayDerivedImportDiagnostic {
  return {
    kind: "derived-import-diagnostic",
    stage,
    reason: error instanceof Error ? error.message : String(error),
    producerId: input.producerId,
    ruleLineage: input.ruleLineage,
  };
}

function insertDerivedLifecycleEvent(
  db: DatabaseSync,
  values: {
    assertionId: CanonicalId;
    transactionId: CanonicalId;
    field: CathayDerivedField;
    runId: CanonicalId;
    coordinateId: CanonicalId | null;
    commitId: CanonicalId;
    kind: "observed" | "superseded" | "withdrawn" | "restored";
  },
): void {
  db.prepare(
    "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)",
  ).run(
    uuidV7(),
    values.assertionId,
    values.transactionId,
    values.field,
    values.runId,
    values.coordinateId,
    values.commitId,
    values.kind,
  );
}

function latestAssertionLifecycle(
  db: DatabaseSync,
  assertionId: CanonicalId,
): string | null {
  const row = db
    .prepare(
      `SELECT event_kind FROM assertion_transitions e JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE assertion_id = ? ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`,
    )
    .get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind ?? null;
}

function insertCurrentDerivedField(
  db: DatabaseSync,
  transactionId: CanonicalId,
  field: CathayDerivedField,
  assertionId: CanonicalId,
  value: string,
  commitId: CanonicalId,
): void {
  const user = db
    .prepare(
      "SELECT 1 FROM current_transaction_fields WHERE transaction_id = ? AND field_name = ? AND origin = 'user'",
    )
    .get(transactionId, field);
  if (user) return;
  db.prepare(
    `INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
    VALUES (?, ?, ?, 'derived', ?, NULL, ?) ON CONFLICT(transaction_id, field_name) DO UPDATE SET value_text = excluded.value_text, origin = 'derived', derived_assertion_id = excluded.derived_assertion_id, user_assertion_id = NULL,
      projection_commit_id = CASE WHEN current_transaction_fields.derived_assertion_id = excluded.derived_assertion_id AND current_transaction_fields.value_text = excluded.value_text
        THEN current_transaction_fields.projection_commit_id ELSE excluded.projection_commit_id END`,
  ).run(transactionId, field, value, assertionId, commitId);
}

function refreshCurrentFieldAfterWithdrawal(
  db: DatabaseSync,
  transactionId: CanonicalId,
  field: CathayDerivedField,
  commitId: CanonicalId,
): void {
  const user = db
    .prepare(
      `SELECT a.assertion_id, a.value_text FROM assertions a
    JOIN assertion_transitions e ON e.assertion_id = a.assertion_id
    WHERE a.transaction_id = ? AND a.field_name = ? AND a.origin = 'user'
    AND e.event_kind NOT IN ('withdrawn','superseded')
    AND NOT EXISTS (SELECT 1 FROM assertion_transitions newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
      WHERE newer.assertion_id = e.assertion_id AND (nc.commit_sequence > (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id)
        OR (nc.commit_sequence = (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) AND newer.rowid > e.rowid)))
    ORDER BY (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) DESC, e.rowid DESC LIMIT 1`,
    )
    .get(transactionId, field) as Record<string, unknown> | undefined;
  if (user) {
    db.prepare(
      `INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
      VALUES (?, ?, ?, 'user', NULL, ?, ?) ON CONFLICT(transaction_id, field_name) DO UPDATE SET value_text = excluded.value_text, origin = 'user', derived_assertion_id = NULL, user_assertion_id = excluded.user_assertion_id, projection_commit_id = excluded.projection_commit_id`,
    ).run(
      transactionId,
      field,
      String(user.value_text),
      blob(user.assertion_id),
      commitId,
    );
    return;
  }
  const derived = db
    .prepare(
      `SELECT a.assertion_id, a.value_text FROM assertions a
    JOIN assertion_transitions e ON e.assertion_id = a.assertion_id
    WHERE a.transaction_id = ? AND a.field_name = ? AND a.origin = 'derived' AND e.event_kind NOT IN ('withdrawn','superseded')
    AND NOT EXISTS (SELECT 1 FROM assertion_transitions newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
      WHERE newer.assertion_id = e.assertion_id AND (nc.commit_sequence > (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id)
        OR (nc.commit_sequence = (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) AND newer.rowid > e.rowid)))
    ORDER BY (SELECT c.commit_sequence FROM canonical_commits c WHERE c.commit_id = e.commit_id) DESC, e.rowid DESC LIMIT 1`,
    )
    .get(transactionId, field) as Record<string, unknown> | undefined;
  if (derived)
    insertCurrentDerivedField(
      db,
      transactionId,
      field,
      blob(derived.assertion_id),
      String(derived.value_text),
      commitId,
    );
  else
    db.prepare(
      "DELETE FROM current_transaction_fields WHERE transaction_id = ? AND field_name = ?",
    ).run(transactionId, field);
}

/** Keep the v6 compatibility rows and the active v7 generation in lockstep.
 * This helper is called before every routine commit's COMMIT, so no reader can
 * observe evidence from one commit with projection rows from another. */
function syncActiveProjectionFromCompatibility(
  db: DatabaseSync,
  projectionCommitId: CanonicalId,
): void {
  let pointer = db
    .prepare(
      "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as { generation_id?: number } | undefined;
  const createdGeneration = !pointer;
  if (!pointer) {
    const commitSequence = Number(
      (
        db
          .prepare(
            "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?",
          )
          .get(projectionCommitId) as { commit_sequence?: number } | undefined
      )?.commit_sequence ?? 0,
    );
    db.prepare(
      `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id, switched_commit_id)
      VALUES (1, 'active', ?, 'canonical/projection/v1', ?, ?, ?)`,
    ).run(
      commitSequence,
      projectionCommitId,
      projectionCommitId,
      projectionCommitId,
    );
    db.prepare(
      "INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id) VALUES (1, 1, ?)",
    ).run(projectionCommitId);
    recordProjectionGenerationEvent(
      db,
      1,
      "created",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      1,
      "validated",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      1,
      "switched",
      "routine",
      projectionCommitId,
    );
    pointer = { generation_id: 1 };
  }
  const generationId = Number(pointer.generation_id);
  const generation = db
    .prepare(
      "SELECT status FROM projection_generations WHERE generation_id = ?",
    )
    .get(generationId) as { status?: string } | undefined;
  if (!generation || generation.status !== "active")
    throw new Error("Canonical active projection generation is not writable.");
  const generationState = db
    .prepare(
      "SELECT created_commit_id, switched_commit_id FROM projection_generations WHERE generation_id = ?",
    )
    .get(generationId) as
    { created_commit_id?: unknown; switched_commit_id?: unknown } | undefined;
  const initializesGeneration = !generationState?.switched_commit_id;
  if (initializesGeneration) {
    db.prepare(
      "UPDATE projection_generations SET created_commit_id = COALESCE(created_commit_id, ?), validated_commit_id = COALESCE(validated_commit_id, ?), switched_commit_id = ? WHERE generation_id = ?",
    ).run(
      projectionCommitId,
      projectionCommitId,
      projectionCommitId,
      generationId,
    );
    recordProjectionGenerationEvent(
      db,
      generationId,
      "created",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      generationId,
      "validated",
      "routine",
      projectionCommitId,
    );
    recordProjectionGenerationEvent(
      db,
      generationId,
      "switched",
      "routine",
      projectionCommitId,
    );
    db.prepare(
      "UPDATE active_projection_generation SET switched_commit_id = ? WHERE singleton_id = 1",
    ).run(projectionCommitId);
  }
  db.prepare(
    "UPDATE projection_generations SET build_cutoff_commit_sequence = (SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?) WHERE generation_id = ?",
  ).run(projectionCommitId, generationId);
  db.prepare(
    "DELETE FROM projection_generation_transaction_fields WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    "DELETE FROM projection_generation_transaction_selection WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    "DELETE FROM projection_generation_transactions WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    `INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id)
    SELECT ?, transaction_id, revision_id, projection_commit_id, revision_commit_id FROM current_transactions`,
  ).run(generationId);
  db.prepare(
    `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
    SELECT ?, current_row.transaction_id, current_row.revision_id, current_row.projection_commit_id,
      CASE WHEN current_row.projection_commit_id = generation.switched_commit_id THEN 'rebuild' ELSE 'source_lifecycle' END
    FROM current_transactions current_row JOIN projection_generations generation ON generation.generation_id = ?`,
  ).run(generationId, generationId);
  db.prepare(
    `INSERT INTO projection_generation_transaction_fields(generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
    SELECT ?, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields`,
  ).run(generationId);
  if (!initializesGeneration && !createdGeneration)
    recordProjectionGenerationEvent(
      db,
      generationId,
      "knowledge",
      "routine",
      projectionCommitId,
    );
}

/** Shared projection synchronization seam for source adapters that admit
 * financial rows in the same SQLite transaction as their source evidence. */
export function syncCanonicalProjectionFromCompatibility(
  db: DatabaseSync,
  projectionCommitId: Uint8Array,
): void {
  syncActiveProjectionFromCompatibility(db, blob(projectionCommitId));
}

function commitCathayDerivedImportRunOnce(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  coordinates: CathayDerivedImportCoordinate[],
  clock: CanonicalAdmissionClock,
  runtime?: CanonicalRuntimeOptions,
): { runId: string; commitSequence: number; assertionIds: string[] } {
  const db = openCanonicalDatabase(ledgerDir, { runtime });
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const connection = db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
      )
      .get(CATHAY_INTEGRATION_NAMESPACE, input.sourceConnectionId);
    if (!connection)
      throw new Error(
        "Derived import source connection is unknown; source lineage must already exist.",
      );
    const sourceConnectionId = blob(
      dbRow<{ source_connection_id: unknown }>(connection).source_connection_id,
    );
    const epoch = db
      .prepare(
        "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
      )
      .get(sourceConnectionId, input.identityEpoch);
    if (!epoch)
      throw new Error(
        "Derived import identity epoch is unknown; source lineage must already exist.",
      );
    const identityEpochId = blob(
      dbRow<{ identity_epoch_id: unknown }>(epoch).identity_epoch_id,
    );
    const commitId = uuidV7();
    const commitSequence =
      Number(
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
            )
            .get() as { max_sequence?: number }
        ).max_sequence ?? 0,
      ) + 1;
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'derived_import')",
    ).run(
      commitId,
      commitSequence,
      recordedAtUtcUs(clock()),
      input.authorityRoute,
    );
    const runId = uuidV7();
    const origin = CATHAY_DERIVED_ORIGIN;
    db.prepare(
      "INSERT INTO derived_import_runs(run_id, source_connection_id, identity_epoch_id, authority_route, stream, producer_id, origin, rule_lineage, observed_at, commit_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')",
    ).run(
      runId,
      sourceConnectionId,
      identityEpochId,
      input.authorityRoute,
      input.stream,
      input.producerId,
      origin,
      input.ruleLineage,
      input.observedAt ?? clock(),
      commitId,
    );
    const assertionIds: string[] = [];
    for (const coordinate of coordinates) {
      const transactionId = idFromString(coordinate.transactionId);
      const transaction = db
        .prepare(
          `SELECT t.account_id, a.source_connection_id, a.identity_epoch_id, a.stream FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id WHERE t.transaction_id = ?`,
        )
        .get(transactionId) as Record<string, unknown> | undefined;
      if (!transaction)
        throw new Error(
          "Derived import targets an unknown transaction subject.",
        );
      if (
        Buffer.compare(
          blob(transaction.source_connection_id),
          sourceConnectionId,
        ) !== 0 ||
        Buffer.compare(blob(transaction.identity_epoch_id), identityEpochId) !==
          0 ||
        transaction.stream !== input.stream
      )
        throw new Error(
          "Derived import crossed a source identity or stream boundary.",
        );
      const coordinateId = uuidV7();
      db.prepare(
        "INSERT INTO derived_scope_coordinates(coordinate_id, run_id, transaction_id, field_name, producer_id, origin, rule_lineage, output_state, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        coordinateId,
        runId,
        transactionId,
        coordinate.field,
        input.producerId,
        origin,
        input.ruleLineage,
        coordinate.state,
        commitId,
      );
      const existingCurrent = db
        .prepare(
          `SELECT f.origin, f.derived_assertion_id, f.user_assertion_id FROM current_transaction_fields f WHERE f.transaction_id = ? AND f.field_name = ?`,
        )
        .get(transactionId, coordinate.field) as
        Record<string, unknown> | undefined;
      const conflicting = db
        .prepare(
          `SELECT assertion.assertion_id, assertion.producer_id, assertion.origin, assertion.rule_lineage FROM assertions assertion
        WHERE assertion.origin = 'derived' AND assertion.transaction_id = ? AND assertion.field_name = ?
          AND (assertion.producer_id <> ? OR assertion.origin <> 'derived' OR assertion.rule_lineage <> ?)
        LIMIT 1`,
        )
        .get(
          transactionId,
          coordinate.field,
          input.producerId,
          input.ruleLineage,
        ) as Record<string, unknown> | undefined;
      if (conflicting)
        throw new Error(
          "A different derived producer or origin cannot supersede the current lineage.",
        );
      const latest = db
        .prepare(
          `SELECT assertion.* FROM assertions assertion JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
        WHERE assertion.origin = 'derived' AND assertion.transaction_id = ? AND assertion.field_name = ?
          AND assertion.producer_id = ? AND assertion.rule_lineage = ?
        ORDER BY c.commit_sequence DESC, assertion.assertion_id DESC LIMIT 1`,
        )
        .get(
          transactionId,
          coordinate.field,
          input.producerId,
          input.ruleLineage,
        ) as Record<string, unknown> | undefined;
      if (coordinate.state === "unsupported") {
        if (latest) {
          const withdrawnAssertion = blob(latest.assertion_id);
          db.prepare(
            "INSERT OR IGNORE INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id) VALUES (?, NULL, ?, ?, ?)",
          ).run(withdrawnAssertion, runId, coordinateId, commitId);
          if (
            latestAssertionLifecycle(db, withdrawnAssertion) !== "withdrawn"
          ) {
            insertDerivedLifecycleEvent(db, {
              assertionId: withdrawnAssertion,
              transactionId,
              field: coordinate.field,
              runId,
              coordinateId,
              commitId,
              kind: "withdrawn",
            });
            if (
              existingCurrent?.origin === "derived" &&
              existingCurrent.derived_assertion_id &&
              Buffer.compare(
                blob(existingCurrent.derived_assertion_id),
                withdrawnAssertion,
              ) === 0
            )
              refreshCurrentFieldAfterWithdrawal(
                db,
                transactionId,
                coordinate.field,
                commitId,
              );
          }
        }
        continue;
      }
      const value = coordinate.value!;
      let assertionId: CanonicalId;
      let eventKind: "observed" | "superseded" | "restored" | null = "observed";
      if (latest && String(latest.value_text) === value) {
        assertionId = blob(latest.assertion_id);
        eventKind =
          latestAssertionLifecycle(db, assertionId) === "withdrawn"
            ? "restored"
            : null;
      } else {
        assertionId = uuidV7();
        if (latest)
          insertDerivedLifecycleEvent(db, {
            assertionId: blob(latest.assertion_id),
            transactionId,
            field: coordinate.field,
            runId,
            coordinateId,
            commitId,
            kind: "superseded",
          });
        db.prepare(
          "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES (?, ?, ?, 'transaction', 'derived', ?, ?, NULL, ?, ?)",
        ).run(
          assertionId,
          transactionId,
          coordinate.field,
          input.producerId,
          input.ruleLineage,
          value,
          commitId,
        );
      }
      db.prepare(
        "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id) VALUES (?, NULL, ?, ?, ?)",
      ).run(assertionId, runId, coordinateId, commitId);
      if (eventKind)
        insertDerivedLifecycleEvent(db, {
          assertionId,
          transactionId,
          field: coordinate.field,
          runId,
          coordinateId,
          commitId,
          kind: eventKind,
        });
      assertionIds.push(idToString(assertionId));
      if (existingCurrent?.origin !== "user")
        insertCurrentDerivedField(
          db,
          transactionId,
          coordinate.field,
          assertionId,
          value,
          commitId,
        );
    }
    syncActiveProjectionFromCompatibility(db, commitId);
    db.prepare(
      "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id",
    ).run(commitId);
    db.exec("COMMIT");
    inTransaction = false;
    return { runId: idToString(runId), commitSequence, assertionIds };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitCathayDerivedImportRun(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  options: CathayDerivedImportOptions = {},
): Promise<CathayDerivedImportResult & { status: "committed" }> {
  const coordinates = validateDerivedImportInput(input);
  validateDerivedImportSubjects(ledgerDir, input, coordinates);
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(
    ledgerDir,
    () => ({
      status: "committed",
      ...commitCathayDerivedImportRunOnce(
        ledgerDir,
        input,
        coordinates,
        clock,
        options.runtime,
      ),
    }),
    options.runtime,
  );
}

export async function runCathayDerivedImportRun(
  ledgerDir: string,
  input: CathayDerivedImportRunInput,
  options: CathayDerivedImportOptions = {},
): Promise<CathayDerivedImportResult> {
  let coordinates: CathayDerivedImportCoordinate[];
  try {
    coordinates = validateDerivedImportInput(input);
  } catch (error) {
    const diagnostic = derivedDiagnostic(error, input, "preflight");
    options.onDiagnostic?.(diagnostic);
    return { status: "diagnostic", diagnostic };
  }
  try {
    validateDerivedImportSubjects(ledgerDir, input, coordinates);
    return {
      status: "committed",
      ...(await withCanonicalWriter(
        ledgerDir,
        () =>
          commitCathayDerivedImportRunOnce(
            ledgerDir,
            input,
            coordinates,
            options.clock ?? (() => new Date().toISOString()),
            options.runtime,
          ),
        options.runtime,
      )),
    };
  } catch (error) {
    const diagnostic = derivedDiagnostic(error, input, "commit");
    options.onDiagnostic?.(diagnostic);
    return { status: "diagnostic", diagnostic };
  }
}

export async function commitCathayUserAssertion(
  ledgerDir: string,
  input: CathayUserAssertionInput,
  options: CathayCanonicalCommitOptions = {},
): Promise<CathayUserAssertionResult> {
  const hasTarget = Object.prototype.hasOwnProperty.call(input, "target");
  type RuntimeTransactionTarget = {
    kind?: unknown;
    field?: unknown;
    id?: unknown;
  };
  const targetObject =
    typeof input.target === "object" &&
    input.target !== null &&
    !Array.isArray(input.target)
      ? (input.target as RuntimeTransactionTarget)
      : undefined;
  if (hasTarget) {
    if (
      !targetObject ||
      targetObject.kind !== "transaction" ||
      typeof targetObject.id !== "string"
    )
      throw new Error(
        "User Assertions require a valid transaction target object.",
      );
    const targetId = idFromString(targetObject.id);
    if (
      input.transactionId !== undefined &&
      Buffer.compare(targetId, idFromString(input.transactionId)) !== 0
    )
      throw new Error("User Assertion target and transactionId conflict.");
    if (
      input.subject !== undefined &&
      (input.subject.kind !== "transaction" ||
        Buffer.compare(targetId, idFromString(input.subject.id)) !== 0)
    )
      throw new Error("User Assertion target and subject conflict.");
    if (
      targetObject.field !== undefined &&
      typeof targetObject.field !== "string"
    )
      throw new Error("User Assertion target field must be a string.");
  }
  const targetField = targetObject?.field;
  const normalizeField = (value: unknown) =>
    value === "displayName" || value === "displayLabel"
      ? "display_name"
      : value;
  if (
    targetField !== undefined &&
    input.field !== undefined &&
    normalizeField(targetField) !== normalizeField(input.field)
  )
    throw new Error("User Assertion target and field conflict.");
  const rawField =
    typeof input.field === "string"
      ? input.field
      : typeof targetField === "string"
        ? targetField
        : undefined;
  const field =
    rawField === "displayName" || rawField === "displayLabel"
      ? "display_name"
      : rawField;
  if (field !== "display_name" && field !== "note")
    throw new Error("User Assertions may target only display_name or note.");
  const transactionIdText =
    input.transactionId ??
    input.subject?.id ??
    (typeof targetObject?.id === "string" ? targetObject.id : undefined);
  if (!transactionIdText)
    throw new Error("User Assertion requires a transaction subject.");
  if (input.subject && input.subject.kind !== "transaction")
    throw new Error("User Assertions support transaction subjects only.");
  const transactionId = idFromString(transactionIdText);
  if (
    input.value !== undefined &&
    input.value !== null &&
    typeof input.value !== "string"
  )
    throw new Error("User Assertion value must be a string or null.");
  const userId = input.userId?.trim() || "local-user";
  if (!userId) throw new Error("User Assertion user identity is required.");
  if (input.observedAt)
    parseRfc3339UtcMicros(input.observedAt, "User Assertion observedAt");
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriter(
    ledgerDir,
    () => {
      const db = openCanonicalDatabase(ledgerDir, { runtime: options.runtime });
      let inTransaction = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        inTransaction = true;
        if (
          !db
            .prepare(
              "SELECT 1 FROM financial_transactions WHERE transaction_id = ?",
            )
            .get(transactionId)
        )
          throw new Error("User Assertion targets an unknown transaction.");
        const commitId = uuidV7();
        const commitSequence =
          Number(
            (
              db
                .prepare(
                  "SELECT COALESCE(MAX(commit_sequence), 0) AS max_sequence FROM canonical_commits",
                )
                .get() as { max_sequence?: number }
            ).max_sequence ?? 0,
          ) + 1;
        db.prepare(
          "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'user_assertion')",
        ).run(commitId, commitSequence, recordedAtUtcUs(clock()), "user/local");
        const prior = db
          .prepare(
            `SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name,
          assertion.producer_id AS user_id, assertion.value_text, assertion.created_commit_id AS commit_id
        FROM assertions assertion JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
        WHERE assertion.origin = 'user' AND assertion.transaction_id = ? AND assertion.field_name = ? AND assertion.producer_id = ?
        ORDER BY c.commit_sequence DESC, assertion.assertion_id DESC LIMIT 1`,
          )
          .get(transactionId, field, userId) as
          Record<string, unknown> | undefined;
        let assertionId: CanonicalId;
        const withdrawn = input.value === null;
        if (withdrawn) {
          if (!prior)
            throw new Error(
              "Cannot withdraw a user assertion that does not exist.",
            );
          assertionId = blob(prior.assertion_id);
          db.prepare(
            "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'withdrawn')",
          ).run(uuidV7(), assertionId, transactionId, field, userId, commitId);
        } else {
          const value = input.value ?? "";
          if (
            prior &&
            String(prior.value_text) === value &&
            latestAssertionLifecycle(db, blob(prior.assertion_id)) !==
              "withdrawn"
          ) {
            assertionId = blob(prior.assertion_id);
          } else {
            assertionId = uuidV7();
            if (prior) {
              db.prepare(
                "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'superseded')",
              ).run(
                uuidV7(),
                blob(prior.assertion_id),
                transactionId,
                field,
                userId,
                commitId,
              );
            }
            db.prepare(
              "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES (?, ?, ?, 'transaction', 'user', ?, 'user/local', NULL, ?, ?)",
            ).run(assertionId, transactionId, field, userId, value, commitId);
            db.prepare(
              "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'observed')",
            ).run(
              uuidV7(),
              assertionId,
              transactionId,
              field,
              userId,
              commitId,
            );
          }
        }
        if (withdrawn) {
          db.prepare(
            "DELETE FROM current_transaction_fields WHERE transaction_id = ? AND field_name = ? AND origin = 'user' AND user_assertion_id = ?",
          ).run(transactionId, field, assertionId);
          refreshCurrentFieldAfterWithdrawal(
            db,
            transactionId,
            field,
            commitId,
          );
        } else
          db.prepare(
            `INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
        VALUES (?, ?, ?, 'user', NULL, ?, ?) ON CONFLICT(transaction_id, field_name) DO UPDATE SET value_text = excluded.value_text, origin = 'user', derived_assertion_id = NULL, user_assertion_id = excluded.user_assertion_id,
          projection_commit_id = CASE WHEN current_transaction_fields.user_assertion_id = excluded.user_assertion_id AND current_transaction_fields.value_text = excluded.value_text
            THEN current_transaction_fields.projection_commit_id ELSE excluded.projection_commit_id END`,
          ).run(transactionId, field, input.value ?? "", assertionId, commitId);
        db.prepare(
          "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id) VALUES (?, NULL, NULL, NULL, ?)",
        ).run(assertionId, commitId);
        syncActiveProjectionFromCompatibility(db, commitId);
        db.prepare(
          "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id",
        ).run(commitId);
        db.exec("COMMIT");
        inTransaction = false;
        return {
          status: "committed",
          assertionId: idToString(assertionId),
          commitSequence,
          field,
          withdrawn,
        };
      } catch (error) {
        if (inTransaction) db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    },
    options.runtime,
  );
}

function amountFromRow(
  row: Record<string, unknown>,
  prefix = "",
): CanonicalAmount {
  return {
    coefficient: String(row[`${prefix}amount_coefficient`]),
    scale: Number(row[`${prefix}amount_scale`]),
  };
}
function effectiveTimeBasisFromRow(
  value: unknown,
): CanonicalTransaction["effectiveTimeBasis"] {
  if (
    value === "accounting" ||
    value === "transaction-time" ||
    value === "source-reported"
  )
    return value;
  throw new Error("Canonical transaction effective time basis is invalid.");
}

function transactionFromRow(
  row: Record<string, unknown>,
): CanonicalTransaction {
  const selectedDisplay =
    typeof row.selected_display_label === "string"
      ? row.selected_display_label
      : typeof row.description === "string"
        ? row.description
        : null;
  const selectedDisplayOrigin =
    row.selected_display_origin === "user" ||
    row.selected_display_origin === "derived"
      ? row.selected_display_origin
      : "source";
  const selectedDisplayCommitSequence =
    typeof row.selected_display_commit_sequence === "number"
      ? row.selected_display_commit_sequence
      : row.selected_display_commit_sequence !== undefined &&
          row.selected_display_commit_sequence !== null
        ? Number(row.selected_display_commit_sequence)
        : null;
  const selectedNote =
    typeof row.selected_note === "string" ? row.selected_note : null;
  const selectedNoteOrigin =
    row.selected_note_origin === "user" ||
    row.selected_note_origin === "derived"
      ? row.selected_note_origin
      : null;
  const selectedNoteCommitSequence =
    typeof row.selected_note_commit_sequence === "number"
      ? row.selected_note_commit_sequence
      : row.selected_note_commit_sequence !== undefined &&
          row.selected_note_commit_sequence !== null
        ? Number(row.selected_note_commit_sequence)
        : null;
  return {
    id: idToString(row.transaction_id),
    accountId: idToString(row.account_id),
    accountNo: String(row.account_no),
    sourceSequence: String(row.source_sequence),
    amount: amountFromRow(row),
    currency: "TWD",
    direction: row.direction as "inflow" | "outflow",
    postingStatus: row.posting_status as "posted",
    postingOrigin: row.posting_origin as CanonicalTransaction["postingOrigin"],
    postingBasis: String(row.posting_basis),
    postingRuleVersion: String(row.posting_rule_version),
    assertionSupportState:
      row.assertion_support_state === "withdrawn" ? "withdrawn" : "supported",
    economicStatus: row.economic_status as CanonicalEconomicStatus,
    administrativeState:
      row.administrative_state as CanonicalAdministrativeState,
    semanticRuleVersion: String(row.semantic_rule_version),
    displayLabel: selectedDisplay,
    displayLabelOrigin: selectedDisplayOrigin,
    displayLabelCommitSequence: selectedDisplayCommitSequence,
    note: selectedNote,
    noteOrigin: selectedNoteOrigin,
    noteCommitSequence: selectedNoteCommitSequence,
    effectiveOn: String(row.effective_on),
    effectiveTimeBasis: effectiveTimeBasisFromRow(row.effective_time_basis),
    effectiveTimeRuleVersion: String(row.effective_time_rule_version),
    transactionDateTimeLocal: String(row.transaction_date_time_local),
    timeZone: String(row.time_zone) as typeof CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
    timePrecision: row.time_precision as CanonicalTransaction["timePrecision"],
    timeOrigin: row.time_origin as CanonicalTransaction["timeOrigin"],
    utcInstantUtcUs: Number(row.utc_instant_utc_us),
    revisionId: idToString(row.revision_id),
    commitSequence: Number(row.commit_sequence),
  };
}
function transactionRevisionFromRow(
  row: Record<string, unknown>,
): CanonicalTransactionRevision {
  const transaction = transactionFromRow(row);
  return {
    ...transaction,
    id: idToString(row.revision_id),
    transactionId: transaction.id,
  };
}

function selectedCurrentField(
  db: DatabaseSync,
  transactionId: unknown,
  field: CathayDerivedField,
):
  | { value: string; origin: "derived" | "user"; commitSequence: number }
  | undefined {
  const row = db
    .prepare(
      `SELECT f.value_text, f.origin, c.commit_sequence FROM projection_generation_transaction_fields f
    JOIN active_projection_generation pointer ON pointer.singleton_id = 1 AND pointer.generation_id = f.generation_id
    JOIN canonical_commits c ON c.commit_id = f.projection_commit_id
    WHERE f.transaction_id = ? AND f.field_name = ?`,
    )
    .get(transactionId as CanonicalId, field) as
    | { value_text?: unknown; origin?: string; commit_sequence?: number }
    | undefined;
  if (row?.origin !== "derived" && row?.origin !== "user") return undefined;
  return {
    value: String(row.value_text),
    origin: row.origin,
    commitSequence: Number(row.commit_sequence),
  };
}

type HistoricalAssertionOrigin = "derived" | "user";
type SelectedHistoricalField = {
  value: string;
  origin: HistoricalAssertionOrigin;
  commitSequence: number;
};
type SelectedAssertionAsOf = {
  assertion_id: unknown;
  value_text: string;
  origin: HistoricalAssertionOrigin;
  commitSequence: number;
};

/** One as-of assertion selector is shared by historical reads and rebuilds so
 * lifecycle ordering and cutoff semantics cannot drift between the two paths. */
function selectAssertionAsOf(
  db: DatabaseSync,
  transactionId: unknown,
  field: CathayDerivedField,
  knowledgeAt: number,
  origin: HistoricalAssertionOrigin,
): SelectedAssertionAsOf | undefined {
  const row = db
    .prepare(
      `SELECT a.assertion_id, a.value_text, c.commit_sequence
    FROM assertions a JOIN assertion_transitions e ON e.assertion_id = a.assertion_id
    JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE a.transaction_id = ? AND a.field_name = ? AND a.origin = ? AND c.commit_sequence <= ? AND e.event_kind NOT IN ('withdrawn','superseded')
      AND NOT EXISTS (SELECT 1 FROM assertion_transitions newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
        WHERE newer.assertion_id = e.assertion_id AND nc.commit_sequence <= ?
          AND (nc.commit_sequence > c.commit_sequence OR (nc.commit_sequence = c.commit_sequence AND newer.rowid > e.rowid)))
    ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`,
    )
    .get(
      transactionId as CanonicalId,
      field,
      origin,
      knowledgeAt,
      knowledgeAt,
    ) as
    | { assertion_id?: unknown; value_text?: unknown; commit_sequence?: number }
    | undefined;
  return row
    ? {
        assertion_id: row.assertion_id,
        value_text: String(row.value_text),
        origin,
        commitSequence: Number(row.commit_sequence),
      }
    : undefined;
}

function selectHistoricalFieldByOrigin(
  db: DatabaseSync,
  transactionId: unknown,
  field: CathayDerivedField,
  knowledgeAt: number,
  origin: HistoricalAssertionOrigin,
): SelectedHistoricalField | undefined {
  const selected = selectAssertionAsOf(
    db,
    transactionId,
    field,
    knowledgeAt,
    origin,
  );
  return selected
    ? {
        value: selected.value_text,
        origin,
        commitSequence: selected.commitSequence,
      }
    : undefined;
}

function selectedHistoricalField(
  db: DatabaseSync,
  transactionId: unknown,
  field: CathayDerivedField,
  knowledgeAt: number,
): SelectedHistoricalField | undefined {
  return (
    selectHistoricalFieldByOrigin(
      db,
      transactionId,
      field,
      knowledgeAt,
      "user",
    ) ??
    selectHistoricalFieldByOrigin(
      db,
      transactionId,
      field,
      knowledgeAt,
      "derived",
    )
  );
}

function addSelectedFields(
  db: DatabaseSync,
  row: Record<string, unknown>,
  knowledgeAt?: number,
): Record<string, unknown> {
  const display =
    knowledgeAt === undefined
      ? selectedCurrentField(db, row.transaction_id, "display_name")
      : selectedHistoricalField(
          db,
          row.transaction_id,
          "display_name",
          knowledgeAt,
        );
  const note =
    knowledgeAt === undefined
      ? selectedCurrentField(db, row.transaction_id, "note")
      : selectedHistoricalField(db, row.transaction_id, "note", knowledgeAt);
  return {
    ...row,
    selected_display_label: display?.value,
    selected_display_origin: display?.origin,
    selected_display_commit_sequence: display?.commitSequence,
    selected_note: note?.value,
    selected_note_origin: note?.origin,
    selected_note_commit_sequence: note?.commitSequence,
  };
}

/**
 * A Yuanta v2 capture is allowed to supersede v1 in a current view only when
 * the durable source proof is complete.  The source connection is the stable
 * lineage key here: it identifies the provider login/portfolio without
 * comparing account numbers, card numbers, transaction facts, or any other
 * sensitive payload.  Historical reads intentionally do not use this
 * predicate, so immutable v1 rows remain queryable for audit.
 *
 * Keep the predicate SQL-only and conservative.  In particular, a malformed
 * or partially traversed v2 scope cannot hide a valid v1 projection.
 */
function yuantaV2CompleteCaptureForConnectionSql(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM source_captures yuanta_v2_capture
    JOIN capture_scopes yuanta_v2_scope
      ON yuanta_v2_scope.capture_id = yuanta_v2_capture.capture_id
     AND yuanta_v2_scope.source_connection_id = yuanta_v2_capture.source_connection_id
     AND yuanta_v2_scope.identity_epoch_id = yuanta_v2_capture.identity_epoch_id
    WHERE yuanta_v2_capture.source_connection_id = ${alias}.source_connection_id
      AND yuanta_v2_capture.authority_route = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_capture.stream = 'credit-card'
      AND yuanta_v2_capture.record_kind = 'yuanta-credit-card-transaction'
      AND yuanta_v2_capture.completeness = 'complete-range'
      AND yuanta_v2_capture.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.stream = 'credit-card'
      AND yuanta_v2_scope.completeness = 'complete-range'
      AND yuanta_v2_scope.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.terminal = 1
      AND (
        SELECT COUNT(*)
        FROM capture_scope_pages yuanta_v2_page_count
        WHERE yuanta_v2_page_count.scope_id = yuanta_v2_scope.scope_id
      ) = yuanta_v2_scope.page_count
      AND NOT EXISTS (
        SELECT 1
        FROM capture_scope_pages yuanta_v2_page
        WHERE yuanta_v2_page.scope_id = yuanta_v2_scope.scope_id
          AND (
            yuanta_v2_page.response_code <> '200'
            OR yuanta_v2_page.terminal <> 1
            OR yuanta_v2_page.page_ordinal >= yuanta_v2_scope.page_count
          )
      )
      AND EXISTS (
        SELECT 1
        FROM transaction_revisions yuanta_v2_revision
        JOIN financial_transactions yuanta_v2_transaction
          ON yuanta_v2_transaction.transaction_id = yuanta_v2_revision.transaction_id
        WHERE yuanta_v2_revision.capture_id = yuanta_v2_capture.capture_id
          AND yuanta_v2_transaction.account_id = yuanta_v2_scope.account_id
          AND yuanta_v2_revision.posting_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      )
  )`;
}

function yuantaV2CompleteCaptureForRevisionSql(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM source_captures yuanta_v2_capture
    JOIN capture_scopes yuanta_v2_scope
      ON yuanta_v2_scope.capture_id = yuanta_v2_capture.capture_id
     AND yuanta_v2_scope.source_connection_id = yuanta_v2_capture.source_connection_id
     AND yuanta_v2_scope.identity_epoch_id = yuanta_v2_capture.identity_epoch_id
    WHERE yuanta_v2_capture.capture_id = ${alias}.capture_id
      AND yuanta_v2_capture.authority_route = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_capture.stream = 'credit-card'
      AND yuanta_v2_capture.record_kind = 'yuanta-credit-card-transaction'
      AND yuanta_v2_capture.completeness = 'complete-range'
      AND yuanta_v2_capture.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.stream = 'credit-card'
      AND yuanta_v2_scope.completeness = 'complete-range'
      AND yuanta_v2_scope.completeness_rule_version = '${YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2}'
      AND yuanta_v2_scope.terminal = 1
      AND (
        SELECT COUNT(*)
        FROM capture_scope_pages yuanta_v2_page_count
        WHERE yuanta_v2_page_count.scope_id = yuanta_v2_scope.scope_id
      ) = yuanta_v2_scope.page_count
      AND NOT EXISTS (
        SELECT 1
        FROM capture_scope_pages yuanta_v2_page
        WHERE yuanta_v2_page.scope_id = yuanta_v2_scope.scope_id
          AND (
            yuanta_v2_page.response_code <> '200'
            OR yuanta_v2_page.terminal <> 1
            OR yuanta_v2_page.page_ordinal >= yuanta_v2_scope.page_count
          )
      )
  )`;
}

class CathayCanonicalFinancialQueryAdapter implements CathayCanonicalFinancialQuery {
  private readonly ledgerDir: string;
  private readonly profile: CanonicalFinancialQueryProfile;

  constructor(ledgerDir: string, profile: CanonicalFinancialQueryProfile) {
    const creditCardQueryRoutes =
      profile.integrationNamespace === "fubon"
        ? FUBON_CREDIT_CARD_QUERY_ROUTES
        : profile.integrationNamespace === "esun"
          ? ESUN_CREDIT_CARD_QUERY_ROUTES
          : profile.integrationNamespace === "yuanta"
            ? YUANTA_CREDIT_CARD_QUERY_ROUTES
            : undefined;
    if (
      profile.postingRuleVersion.includes("/credit-card/") &&
      (!creditCardQueryRoutes?.has(profile.postingRuleVersion) ||
        ![
          "fubon",
          "esun",
          "yuanta",
        ].includes(profile.integrationNamespace))
    )
      throw new Error(
        "Credit-card financial query profile is unknown or mixed.",
      );
    this.ledgerDir = ledgerDir;
    this.profile = {
      integrationNamespace: requireSourceText(
        profile.integrationNamespace,
        "Canonical financial integration namespace",
      ),
      postingRuleVersion: requireSourceText(
        profile.postingRuleVersion,
        "Canonical financial posting rule version",
      ),
    };
  }
  async current(
    _request: CathayCanonicalCurrentQueryRequest,
  ): Promise<CathayCanonicalCurrentQueryResult> {
    // The v1 Fubon contract remains queryable only through an explicit
    // historical cutoff.  Keep the profile constructible for migration and
    // audit callers, but make a current read an empty result so superseded
    // observed-order identity rows cannot enter a current product view.
    const currentRoute =
      this.profile.integrationNamespace === "fubon" &&
      this.profile.postingRuleVersion === FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1
        ? "fubon/credit-card/human-attested-v1-current-disabled"
        : this.profile.postingRuleVersion;
    const yuantaV1CurrentSupersession =
      this.profile.integrationNamespace === "yuanta" &&
      this.profile.postingRuleVersion === YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1;
    const yuantaV2CurrentRead =
      this.profile.integrationNamespace === "yuanta" &&
      this.profile.postingRuleVersion === YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2;
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      return withCanonicalSnapshot(db, () => {
        const accountEligibility =
          yuantaV1CurrentSupersession
            ? `AND NOT (${yuantaV2CompleteCaptureForConnectionSql("account")})`
            : yuantaV2CurrentRead
              ? `AND ${yuantaV2CompleteCaptureForConnectionSql("account")}`
              : "";
        const accounts = (
          db
            .prepare(
              `SELECT account.account_id AS id, account.account_no AS accountNo,
                account.currency, account.account_type AS accountType
               FROM financial_accounts account
               JOIN source_connections connection
                 ON connection.source_connection_id = account.source_connection_id
               WHERE connection.integration_namespace = ?
                 AND EXISTS (
                   SELECT 1 FROM capture_scopes scoped
                   JOIN source_captures capture
                     ON capture.capture_id = scoped.capture_id
                   WHERE scoped.account_id = account.account_id
                     AND capture.authority_route = ?
                     AND capture.stream = account.stream
                 )
                 ${accountEligibility}
               ORDER BY account.account_no`,
            )
            .all(
              this.profile.integrationNamespace,
              currentRoute,
            ) as Record<string, unknown>[]
        ).map((row) => ({
          id: idToString(row.id),
          accountNo: String(row.accountNo),
          currency: String(row.currency),
          accountType: row.accountType as CathayCanonicalCurrentQueryResult["accounts"][number]["accountType"],
        }));
        if (projectionRelevantCommitCount(db) === 0) {
          return {
            status: "ok",
            kind: "current",
            accounts: [],
            transactions: [],
            commitSequence: 0,
          } satisfies CathayCanonicalCurrentQueryResult;
        }
        const rows = db
          .prepare(
            `SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, projection_cutoff.commit_sequence FROM projection_generation_transactions current_row
        JOIN active_projection_generation pointer ON pointer.singleton_id = 1 AND pointer.generation_id = current_row.generation_id
        JOIN current_projection_state state ON state.generation = 1
        JOIN canonical_commits projection_cutoff ON projection_cutoff.commit_id = state.commit_id
        JOIN financial_transactions t ON t.transaction_id = current_row.transaction_id JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.revision_id = current_row.revision_id
        WHERE r.posting_rule_version = ?
          ${yuantaV1CurrentSupersession
            ? `AND NOT (${yuantaV2CompleteCaptureForConnectionSql("a")})`
            : yuantaV2CurrentRead
              ? `AND ${yuantaV2CompleteCaptureForRevisionSql("r")}`
              : ""}
        ORDER BY a.account_no, t.source_sequence`,
          )
          .all(currentRoute) as Record<string, unknown>[];
        const projection = db
          .prepare(
            `SELECT c.commit_sequence FROM current_projection_state state
        JOIN canonical_commits c ON c.commit_id = state.commit_id WHERE state.generation = 1`,
          )
          .get() as { commit_sequence?: number } | undefined;
        if (!projection)
          throw new Error("Canonical current projection cutoff is missing.");
        const result = {
          status: "ok",
          kind: "current",
          accounts,
          transactions: rows.map((row) =>
            transactionFromRow(addSelectedFields(db, row)),
          ),
          commitSequence: Number(projection.commit_sequence),
        } satisfies CathayCanonicalCurrentQueryResult;
        return result;
      });
    } finally {
      db.close();
    }
  }
  async historical(
    request: CathayCanonicalHistoricalQueryRequest,
  ): Promise<CathayCanonicalHistoricalQueryResult> {
    if (
      request.cutoff.kind !== "both" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(request.cutoff.financialAt) ||
      !/^\d+$/.test(request.cutoff.knowledgeAt)
    )
      throw new Error(
        "Canonical historical queries require financial-time and knowledge-time cutoffs.",
      );
    requireDate(request.cutoff.financialAt, "historical financialAt");
    const knowledgeAt = Number(request.cutoff.knowledgeAt);
    if (!Number.isSafeInteger(knowledgeAt))
      throw new Error(
        "Canonical historical knowledgeAt is outside the supported sequence range.",
      );
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      return withCanonicalSnapshot(db, () => {
        const rows = db
          .prepare(
            `SELECT t.transaction_id, t.account_id, a.account_no, t.source_sequence, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence,
        COALESCE((SELECT CASE WHEN lifecycle.event_kind = 'withdrawn' THEN 'withdrawn' ELSE 'supported' END FROM assertion_transitions lifecycle
          JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = lifecycle.commit_id
          WHERE lifecycle.assertion_id = sa.assertion_id AND lifecycle_commit.commit_sequence <= ?
          ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC LIMIT 1), 'supported') AS assertion_support_state
        FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        JOIN assertions sa ON sa.revision_id = r.revision_id AND sa.origin = 'source'
        WHERE r.posting_rule_version = ?
          AND r.effective_on <= ? AND c.commit_sequence <= ? AND NOT EXISTS (
          SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
          WHERE newer.transaction_id = r.transaction_id AND newer.effective_on <= ? AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > c.commit_sequence
        ) ORDER BY a.account_no, t.source_sequence`,
          )
          .all(
            knowledgeAt,
            this.profile.postingRuleVersion,
            request.cutoff.financialAt,
            knowledgeAt,
            request.cutoff.financialAt,
            knowledgeAt,
          ) as Record<string, unknown>[];
        const result = {
          status: "ok",
          kind: "historical",
          cutoff: request.cutoff,
          transactions: rows.map((row) =>
            transactionFromRow(addSelectedFields(db, row, knowledgeAt)),
          ),
        } satisfies CathayCanonicalHistoricalQueryResult;
        return result;
      });
    } finally {
      db.close();
    }
  }
  async lineage(
    request: CathayCanonicalLineageQueryRequest,
  ): Promise<CathayCanonicalLineageQueryResult> {
    if (request.subject.kind !== "transaction" || !request.subject.id)
      throw new Error("Cathay lineage queries require a transaction subject.");
    const transactionId = idFromString(request.subject.id);
    const db = openCanonicalDatabase(this.ledgerDir, { readOnly: true });
    try {
      return withCanonicalSnapshot(db, () => {
        const revisionRows = db
          .prepare(
            `SELECT t.transaction_id, t.account_id, t.source_sequence, a.account_no, r.amount_coefficient, r.amount_scale, r.currency,
        r.direction, r.posting_status, r.posting_origin, r.posting_basis, r.posting_rule_version, r.description, r.economic_status, r.administrative_state, r.semantic_rule_version, r.effective_on, r.effective_time_basis,
        r.effective_time_rule_version, r.transaction_date_time_local, r.time_zone, r.time_precision, r.time_origin,
        r.utc_instant_utc_us, r.revision_id, c.commit_sequence, r.source_record_id, r.capture_id, sr.sequence_lexeme, sr.description, sr.payload_json,
        source_scope.scope_id, source_scope.account_id AS scope_account_id, source_scope.account_no AS scope_account_no, source_scope.stream AS scope_stream,
        source_scope.scope_start AS scope_scope_start, source_scope.scope_end AS scope_scope_end, source_scope.contract_fingerprint AS scope_contract_fingerprint, source_scope.preflight_fingerprint AS scope_preflight_fingerprint,
        sc.observed_at, sc.scope_start, sc.scope_end, sc.authority_route, sa.assertion_id FROM financial_transactions t JOIN financial_accounts a ON a.account_id = t.account_id
        JOIN transaction_revisions r ON r.transaction_id = t.transaction_id JOIN canonical_commits c ON c.commit_id = r.commit_id
        JOIN source_records sr ON sr.source_record_id = r.source_record_id JOIN source_record_scopes record_scope ON record_scope.source_record_id = sr.source_record_id
        JOIN capture_scopes source_scope ON source_scope.scope_id = record_scope.scope_id JOIN source_captures sc ON sc.capture_id = r.capture_id
        JOIN assertions sa ON sa.revision_id = r.revision_id AND sa.origin = 'source' WHERE t.transaction_id = ? ORDER BY r.revision_number`,
          )
          .all(transactionId) as Record<string, unknown>[];
        const entries = revisionRows.map((row) => {
          const assertionId = blob(row.assertion_id);
          const provenance = db
            .prepare(
              `SELECT p.source_record_id AS sourceRecordId, sr.capture_id AS captureId FROM assertion_provenance p
          JOIN source_records sr ON sr.source_record_id = p.source_record_id WHERE p.assertion_id = ? ORDER BY p.source_record_id`,
            )
            .all(assertionId) as Record<string, unknown>[];
          const lifecycleEvents = db
            .prepare(
              `SELECT e.event_id, e.event_kind, c.commit_sequence, cs.scope_id, cs.completeness, cs.absence_authority, cs.contract_fingerprint, cs.page_count
          FROM assertion_transitions e JOIN canonical_commits c ON c.commit_id = e.commit_id
          LEFT JOIN capture_scopes cs ON cs.scope_id = e.scope_id WHERE e.assertion_id = ? ORDER BY c.commit_sequence, e.event_id`,
            )
            .all(assertionId) as Record<string, unknown>[];
          const derivedRows = db
            .prepare(
              `SELECT assertion.assertion_id, assertion.field_name, assertion.producer_id, assertion.origin,
            assertion.rule_lineage, assertion.value_text, run.run_id, c.commit_sequence
          FROM assertions assertion JOIN derived_import_runs run ON run.commit_id = assertion.created_commit_id
            AND run.producer_id = assertion.producer_id AND run.rule_lineage = assertion.rule_lineage
          JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
          WHERE assertion.transaction_id = ? AND assertion.origin = 'derived'
          ORDER BY c.commit_sequence, assertion.assertion_id`,
            )
            .all(transactionId) as Record<string, unknown>[];
          const userRows = db
            .prepare(
              `SELECT assertion.assertion_id, assertion.field_name, assertion.producer_id AS user_id,
            assertion.value_text, c.commit_sequence
          FROM assertions assertion JOIN canonical_commits c ON c.commit_id = assertion.created_commit_id
          WHERE assertion.transaction_id = ? AND assertion.origin = 'user'
          ORDER BY c.commit_sequence, assertion.assertion_id`,
            )
            .all(transactionId) as Record<string, unknown>[];
          const revision = transactionRevisionFromRow(
            addSelectedFields(db, row, Number(row.commit_sequence)),
          );
          return {
            transaction: {
              id: idToString(row.transaction_id),
              accountId: idToString(row.account_id),
              sourceSequence: String(row.source_sequence),
            },
            revision,
            assertion: {
              id: idToString(row.assertion_id),
              revisionId: idToString(row.revision_id),
              commitSequence: Number(row.commit_sequence),
            },
            sourceRecord: {
              id: idToString(row.source_record_id),
              captureId: idToString(row.capture_id),
              sequence: String(row.sequence_lexeme),
              description:
                typeof row.description === "string" ? row.description : null,
              payload: String(row.payload_json),
              scopeProof: {
                id: idToString(row.scope_id),
                accountId: idToString(row.scope_account_id),
                accountNo: String(row.scope_account_no),
                stream: String(row.scope_stream),
                scopeStart: String(row.scope_scope_start),
                scopeEnd: String(row.scope_scope_end),
                completeness: "complete-range" as const,
                contractFingerprint: String(row.scope_contract_fingerprint),
                preflightFingerprint: String(row.scope_preflight_fingerprint),
              },
            },
            capture: {
              id: idToString(row.capture_id),
              observedAt: String(row.observed_at),
              scopeStart: String(row.scope_start),
              scopeEnd: String(row.scope_end),
              authorityRoute: String(row.authority_route),
            },
            provenance: provenance.map((item) => ({
              sourceRecordId: idToString(item.sourceRecordId),
              captureId: idToString(item.captureId),
            })),
            lifecycleEvents: lifecycleEvents.map((event) => ({
              id: idToString(event.event_id),
              kind: event.event_kind as CathayCanonicalLifecycleEvent["kind"],
              commitSequence: Number(event.commit_sequence),
              scopeProof: event.scope_id
                ? {
                    id: idToString(event.scope_id),
                    completeness: "complete-range" as const,
                    absenceAuthority:
                      (event.absence_authority as CathayAbsenceAuthority | null) ??
                      null,
                    contractFingerprint: String(event.contract_fingerprint),
                    pageCount: Number(event.page_count),
                  }
                : null,
            })),
            derivedAssertions: derivedRows.map((derived) => {
              const derivedAssertionId = blob(derived.assertion_id);
              const provenanceRows = db
                .prepare(
                  "SELECT run_id, coordinate_id FROM assertion_provenance WHERE assertion_id = ? AND run_id IS NOT NULL ORDER BY run_id, coordinate_id",
                )
                .all(derivedAssertionId) as Record<string, unknown>[];
              return {
                id: idToString(derivedAssertionId),
                field: derived.field_name as CathayDerivedField,
                producerId: String(derived.producer_id),
                origin: String(derived.origin),
                ruleLineage: String(derived.rule_lineage),
                value: String(derived.value_text),
                state:
                  latestAssertionLifecycle(db, derivedAssertionId) ===
                  "withdrawn"
                    ? ("withdrawn" as const)
                    : ("supported" as const),
                commitSequence: Number(derived.commit_sequence),
                runId: idToString(derived.run_id),
                provenance: provenanceRows.map((provenanceRow) => ({
                  runId: idToString(provenanceRow.run_id),
                  coordinateId: idToString(provenanceRow.coordinate_id),
                })),
              };
            }),
            userAssertions: userRows.map((user) => {
              const userAssertionId = blob(user.assertion_id);
              const userProvenance = db
                .prepare(
                  `SELECT c.commit_sequence FROM assertion_provenance p JOIN canonical_commits c ON c.commit_id = p.commit_id WHERE p.assertion_id = ? ORDER BY c.commit_sequence`,
                )
                .all(userAssertionId) as Array<Record<string, unknown>>;
              return {
                id: idToString(userAssertionId),
                field: user.field_name as CathayUserAssertionField,
                userId: String(user.user_id),
                value: String(user.value_text),
                state:
                  latestAssertionLifecycle(db, userAssertionId) === "withdrawn"
                    ? ("withdrawn" as const)
                    : ("supported" as const),
                commitSequence: Number(user.commit_sequence),
                provenance: userProvenance.map((item) => ({
                  commitSequence: Number(item.commit_sequence),
                })),
              };
            }),
          } satisfies CathayCanonicalLineageEntry;
        });
        const result = {
          status: "ok",
          kind: "lineage",
          subject: request.subject,
          entries,
        } satisfies CathayCanonicalLineageQueryResult;
        return result;
      });
    } finally {
      db.close();
    }
  }
}

export function createCathayCanonicalFinancialQuery(
  ledgerDir: string,
): CathayCanonicalFinancialQuery {
  return createCanonicalFinancialQuery(ledgerDir, {
    integrationNamespace: CATHAY_INTEGRATION_NAMESPACE,
    postingRuleVersion: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  });
}

export function createCanonicalFinancialQuery(
  ledgerDir: string,
  profile: CanonicalFinancialQueryProfile,
): CanonicalFinancialQuery {
  return new CathayCanonicalFinancialQueryAdapter(ledgerDir, profile);
}

/** Generic, source-only evidence seam shared by integration adapters. */
export const CANONICAL_SOURCE_STAGE = "durable-source-evidence" as const;
export const CANONICAL_SOURCE_ADMISSION = "blocked" as const;
export const CANONICAL_SOURCE_SCHEMA_VERSION = CANONICAL_SCHEMA_VERSION;
const CANONICAL_SOURCE_RUNTIME_BRAND = Symbol(
  "canonical-source-runtime-validated-v8",
);
const OPAQUE_SOURCE_TOKEN = /^sha256:[A-Za-z0-9_-]+$/;
const SOURCE_DATE = /^\d{8}$/;
const FORBIDDEN_SOURCE_KEY =
  /raw|header|cookie|password|secret|credential|token/i;

export type CanonicalSourcePage = {
  pageOrdinal: number;
  responseCode: "200";
  rowCount: number;
  terminal: boolean;
  metadata: Record<string, unknown>;
};
export type CanonicalSourceRecord = {
  occurrenceKey: string;
  collisionKey?: string;
  providerKey: string;
  contentHash: string;
  compact: Record<string, unknown>;
};
export type CanonicalSourceAbsenceAuthority =
  "comparable-complete-range" | "provider-explicit-no-data";
export type CanonicalSourceEvidence = {
  captureId: string;
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  stream: string;
  recordKind: string;
  routeKey: string;
  contractVersion: string;
  subjectDigest: string;
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    kind: "bounded-range" | "point-in-time";
    completeness: "complete-range" | "single-page";
    ruleVersion: string;
    absenceAuthority?: CanonicalSourceAbsenceAuthority;
  };
  pages: CanonicalSourcePage[];
  records: CanonicalSourceRecord[];
};
export type CanonicalValidatedSourceEvidence = CanonicalSourceEvidence & {
  readonly __runtimeValidatedSourceEvidence: "canonical-source-v8";
};
export type CanonicalSourceStore = {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly commitClock: () => number;
  close(): void;
};
export type CanonicalSourceIdentityFence = {
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  stream: string;
  recordKind: string;
  subjectDigest: string;
};
export type CanonicalSourceObservation = CanonicalSourceRecord & {
  recordId: number;
  captureId: string;
  commitSequence: number;
  identity: CanonicalSourceIdentityFence;
};
type CanonicalSourceQueryBase = {
  status: typeof CANONICAL_SOURCE_STAGE;
  canonicalAdmission: typeof CANONICAL_SOURCE_ADMISSION;
  records: CanonicalSourceObservation[];
  observations: CanonicalSourceObservation[];
  provenanceCount: number;
};
export type CanonicalSourceCurrentQuery = CanonicalSourceQueryBase & {
  kind: "current";
};
export type CanonicalSourceHistoricalQuery = CanonicalSourceQueryBase & {
  kind: "historical";
  knowledgeAt: number;
  financialCutoffApplied: false;
};
export type CanonicalSourceLineageQuery = CanonicalSourceQueryBase & {
  kind: "lineage";
  occurrenceKey: string;
  identity: CanonicalSourceIdentityFence;
  provenance: Array<{ captureId: string; commitSequence: number }>;
  expectedObservationCount: number;
  provenanceComplete: boolean;
};
export type CanonicalSourceLineageRequest = CanonicalSourceIdentityFence & {
  occurrenceKey: string;
};
export type CanonicalSourceCommitResult = {
  status: typeof CANONICAL_SOURCE_STAGE;
  canonicalAdmission: typeof CANONICAL_SOURCE_ADMISSION;
  captureId: string;
  commitSequence: number;
  observationCount: number;
  provenanceCount: number;
};
export class CanonicalSourceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSourceConflictError";
  }
}

function requireSourceText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}
function requireSourceToken(value: unknown, label: string): string {
  const token = requireSourceText(value, label);
  if (!OPAQUE_SOURCE_TOKEN.test(token))
    throw new Error(`${label} must be an opaque token.`);
  return token;
}
function requireSourceDate(value: unknown, label: string): string {
  const text = requireSourceText(value, label);
  if (!SOURCE_DATE.test(text)) throw new Error(`${label} must be YYYYMMDD.`);
  const date = new Date(
    Date.UTC(
      Number(text.slice(0, 4)),
      Number(text.slice(4, 6)) - 1,
      Number(text.slice(6, 8)),
    ),
  );
  if (
    date.getUTCFullYear() !== Number(text.slice(0, 4)) ||
    date.getUTCMonth() !== Number(text.slice(4, 6)) - 1 ||
    date.getUTCDate() !== Number(text.slice(6, 8))
  ) {
    throw new Error(`${label} must be a calendar date.`);
  }
  return text;
}
function assertCompactSourceValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(`${path} contains a non-exact number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertCompactSourceValue(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_SOURCE_KEY.test(key))
        throw new Error(`${path}.${key} is not compact source evidence.`);
      assertCompactSourceValue(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains an unsupported value.`);
}
function stableSourceJson(value: Record<string, unknown>): string {
  const canonicalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonicalize)
      : entry !== null && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, canonicalize(nested)]),
          )
        : entry;
  return JSON.stringify(canonicalize(value));
}
function validateCanonicalSourceEvidence(
  evidence: CanonicalSourceEvidence,
): void {
  requireSourceText(evidence.captureId, "Capture ID");
  requireSourceText(evidence.integrationNamespace, "Integration namespace");
  requireSourceToken(evidence.sourceConnectionKey, "Source connection key");
  requireSourceToken(evidence.identityEpoch, "Identity epoch");
  requireSourceText(evidence.stream, "Stream");
  requireSourceText(evidence.recordKind, "Record kind");
  requireSourceText(evidence.routeKey, "Authority route");
  requireSourceText(evidence.contractVersion, "Contract version");
  requireSourceToken(evidence.subjectDigest, "Subject digest");
  if (!Number.isFinite(Date.parse(evidence.observedAt)))
    throw new Error("Observed at must be RFC3339.");
  const start = requireSourceDate(evidence.scope.startDate, "Scope start");
  const end = requireSourceDate(evidence.scope.endDate, "Scope end");
  if (start > end) throw new Error("Scope start must not be after scope end.");
  if (
    evidence.scope.kind !== "bounded-range" &&
    evidence.scope.kind !== "point-in-time"
  )
    throw new Error("Source scope kind is unsupported.");
  if (
    evidence.scope.absenceAuthority !== undefined &&
    evidence.scope.absenceAuthority !== "comparable-complete-range" &&
    evidence.scope.absenceAuthority !== "provider-explicit-no-data"
  )
    throw new Error("Source absence authority is unsupported.");
  requireSourceText(evidence.scope.ruleVersion, "Completeness rule version");
  if (!Array.isArray(evidence.pages) || evidence.pages.length === 0)
    throw new Error("At least one source page is required.");
  let rowCount = 0;
  evidence.pages.forEach((page, index) => {
    if (
      page.pageOrdinal !== index ||
      page.responseCode !== "200" ||
      page.terminal !== (index === evidence.pages.length - 1)
    ) {
      throw new Error(
        "Source page sequence/status/terminal marker is inconsistent.",
      );
    }
    if (!Number.isSafeInteger(page.rowCount) || page.rowCount < 0)
      throw new Error("Source page row count is invalid.");
    assertCompactSourceValue(page.metadata, `page[${index}].metadata`);
    rowCount += page.rowCount;
  });
  if (!Array.isArray(evidence.records) || rowCount !== evidence.records.length)
    throw new Error("Source page counts do not match compact records.");
  const occurrences = new Set<string>();
  evidence.records.forEach((record, index) => {
    requireSourceToken(record.occurrenceKey, `Record ${index} occurrence key`);
    if (record.collisionKey !== undefined)
      requireSourceToken(record.collisionKey, `Record ${index} collision key`);
    requireSourceToken(record.providerKey, `Record ${index} provider key`);
    requireSourceToken(record.contentHash, `Record ${index} content hash`);
    if (occurrences.has(record.occurrenceKey))
      throw new CanonicalSourceConflictError(
        "Duplicate occurrence in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    if (
      !record.compact ||
      typeof record.compact !== "object" ||
      Array.isArray(record.compact)
    )
      throw new Error(`Record ${index} compact payload must be an object.`);
    assertCompactSourceValue(record.compact, `record[${index}].compact`);
  });
}
function hasCanonicalSourceBrand(
  evidence: CanonicalSourceEvidence,
): evidence is CanonicalValidatedSourceEvidence {
  return (
    (
      evidence as CanonicalSourceEvidence & {
        [CANONICAL_SOURCE_RUNTIME_BRAND]?: true;
      }
    )[CANONICAL_SOURCE_RUNTIME_BRAND] === true
  );
}
export function admitCanonicalSourceEvidence(
  evidence: CanonicalSourceEvidence,
): CanonicalValidatedSourceEvidence {
  validateCanonicalSourceEvidence(evidence);
  Object.defineProperty(evidence, CANONICAL_SOURCE_RUNTIME_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return evidence as CanonicalValidatedSourceEvidence;
}

function openCanonicalDatabasePath(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    configureCanonicalRuntime(db, { busyTimeoutMs: 30_000 });
    applySchemaMigration(db);
    ensureCanonicalFinancialRevisionSchema(db);
    ensureCanonicalTimeObservationSchema(db);
    ensureFinancialAccountCurrencySchema(db);
    ensureForeignCurrencyConversionSchema(db);
    configureCanonicalRuntime(db, { busyTimeoutMs: 30_000 });
    if (path !== ":memory:") verifyCanonicalRuntime(db);
    validateV8SourceEvidenceSchema(db);
    validateCanonicalCompatibilityViews(db);
    validateCanonicalLoanExtensionSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export type CanonicalSourceStoreOptions = { commitClock?: () => number };
export function createCanonicalSourceStore(
  databasePath: string,
  options: CanonicalSourceStoreOptions = {},
): CanonicalSourceStore {
  const path = requireSourceText(databasePath, "Canonical SQLite path");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = openCanonicalDatabasePath(path);
  const commitClock = options.commitClock ?? currentUtcMicros;
  let closed = false;
  return {
    db,
    databasePath: path,
    commitClock,
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}
export function validateCanonicalSourceStore(
  store: CanonicalSourceStore,
): void {
  const version = Number(
    (store.db.prepare("PRAGMA user_version").get() as { user_version?: number })
      .user_version ?? 0,
  );
  if (version !== CANONICAL_SCHEMA_VERSION)
    throw new Error("Canonical source schema version is invalid.");
  validateV8SourceEvidenceSchema(store.db);
  validateCanonicalCompatibilityViews(store.db);
  validateCanonicalLoanExtensionSchema(store.db);
  const integrity = String(
    (
      store.db.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: unknown;
      }
    ).integrity_check ?? "",
  );
  if (
    integrity !== "ok" ||
    store.db.prepare("PRAGMA foreign_key_check").all().length > 0
  )
    throw new Error("Canonical source store integrity failed.");
}
function sourceCommitSequence(db: DatabaseSync): number {
  return (
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? 0,
    ) + 1
  );
}
function sourceIdFor(...parts: string[]): Buffer {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest()
    .subarray(0, 16);
}
function nextSourceKnowledgeTime(store: CanonicalSourceStore): number {
  const candidate = store.commitClock();
  if (!Number.isSafeInteger(candidate) || candidate < 0)
    throw new Error(
      "Canonical source commit clock returned an invalid UTC microsecond value.",
    );
  const latest = Number(
    (
      store.db
        .prepare(
          "SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits",
        )
        .get() as { value?: number }
    ).value ?? -1,
  );
  return Math.max(candidate, latest + 1);
}
function commitCanonicalSourceEvidenceOnce(
  store: CanonicalSourceStore,
  evidence: CanonicalValidatedSourceEvidence,
  transactionBoundary = true,
): CanonicalSourceCommitResult {
  if (!hasCanonicalSourceBrand(evidence))
    throw new CanonicalSourceConflictError(
      "Source evidence is not runtime-validated.",
    );
  validateCanonicalSourceEvidence(evidence);
  const db = store.db;
  if (transactionBoundary) db.exec("BEGIN IMMEDIATE");
  try {
    if (
      db
        .prepare("SELECT 1 FROM source_captures WHERE capture_key = ?")
        .get(evidence.captureId)
    )
      throw new CanonicalSourceConflictError("Capture overwrite is forbidden.");
    for (const record of evidence.records) {
      if (record.collisionKey !== undefined) {
        const collisions = db
          .prepare(
            `SELECT record.occurrence_key FROM source_records record
            JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
            JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
            JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
            WHERE connection.integration_namespace = ? AND connection.source_connection_key = ?
              AND epoch.epoch_key = ? AND subject.stream = ? AND subject.record_kind = ?
              AND subject.subject_digest = ? AND record.collision_key = ?`,
          )
          .all(
            evidence.integrationNamespace,
            evidence.sourceConnectionKey,
            evidence.identityEpoch,
            evidence.stream,
            evidence.recordKind,
            evidence.subjectDigest,
            record.collisionKey,
          ) as Array<{ occurrence_key?: unknown }>;
        if (
          collisions.some(
            (row) => String(row.occurrence_key) !== record.occurrenceKey,
          )
        ) {
          throw new CanonicalSourceConflictError(
            "Source collision key maps to another occurrence; overwrite is forbidden.",
          );
        }
      }
      const rows = db
        .prepare(
          `SELECT record.provider_key, record.content_hash, record.payload_json
          FROM source_records record
          JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
          JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
          JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
          WHERE connection.integration_namespace = ? AND connection.source_connection_key = ?
            AND epoch.epoch_key = ? AND subject.stream = ? AND subject.record_kind = ?
            AND subject.subject_digest = ? AND record.occurrence_key = ?`,
        )
        .all(
          evidence.integrationNamespace,
          evidence.sourceConnectionKey,
          evidence.identityEpoch,
          evidence.stream,
          evidence.recordKind,
          evidence.subjectDigest,
          record.occurrenceKey,
        ) as Array<Record<string, unknown>>;
      for (const row of rows)
        if (
          String(row.provider_key) !== record.providerKey ||
          String(row.content_hash) !== record.contentHash ||
          String(row.payload_json) !== stableSourceJson(record.compact)
        ) {
          throw new CanonicalSourceConflictError(
            "Source occurrence conflict; overwrite is forbidden.",
          );
        }
    }
    const sequence = sourceCommitSequence(db);
    const commitId = uuidV7();
    const connectionId = sourceIdFor(
      "connection",
      evidence.integrationNamespace,
      evidence.sourceConnectionKey,
    );
    const epochId = sourceIdFor(
      "epoch",
      evidence.integrationNamespace,
      evidence.sourceConnectionKey,
      evidence.identityEpoch,
    );
    const subjectId = sourceIdFor(
      "subject",
      evidence.integrationNamespace,
      evidence.sourceConnectionKey,
      evidence.identityEpoch,
      evidence.stream,
      evidence.recordKind,
      evidence.subjectDigest,
    );
    const captureId = uuidV7();
    const scopeId = uuidV7();
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'source_capture')",
    ).run(
      commitId,
      sequence,
      nextSourceKnowledgeTime(store),
      evidence.routeKey,
    );
    db.prepare(
      "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(authority_route) DO NOTHING",
    ).run(
      evidence.routeKey,
      evidence.integrationNamespace,
      evidence.stream,
      evidence.contractVersion,
      commitId,
    );
    const route = db
      .prepare(
        "SELECT integration_namespace, stream, contract_version FROM source_authority_routes WHERE authority_route = ?",
      )
      .get(evidence.routeKey) as Record<string, unknown>;
    if (
      String(route.integration_namespace) !== evidence.integrationNamespace ||
      String(route.stream) !== evidence.stream ||
      String(route.contract_version) !== evidence.contractVersion
    )
      throw new CanonicalSourceConflictError(
        "Authority route contract drifted.",
      );
    db.prepare(
      "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?) ON CONFLICT(integration_namespace, source_connection_key) DO NOTHING",
    ).run(
      connectionId,
      evidence.integrationNamespace,
      evidence.sourceConnectionKey,
      commitId,
    );
    const connection = db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
      )
      .get(evidence.integrationNamespace, evidence.sourceConnectionKey) as {
      source_connection_id?: unknown;
    };
    const actualConnectionId = blob(connection.source_connection_id);
    db.prepare(
      "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?) ON CONFLICT(source_connection_id, epoch_key) DO NOTHING",
    ).run(epochId, actualConnectionId, evidence.identityEpoch, commitId);
    const epoch = db
      .prepare(
        "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
      )
      .get(actualConnectionId, evidence.identityEpoch) as {
      identity_epoch_id?: unknown;
    };
    const actualEpochId = blob(epoch.identity_epoch_id);
    db.prepare(
      "INSERT INTO source_route_bindings(authority_route, source_connection_id, created_commit_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).run(evidence.routeKey, actualConnectionId, commitId);
    db.prepare(
      "INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest) DO NOTHING",
    ).run(
      subjectId,
      actualConnectionId,
      actualEpochId,
      evidence.stream,
      evidence.recordKind,
      evidence.subjectDigest,
      commitId,
    );
    const subject = db
      .prepare(
        "SELECT source_subject_id FROM source_subjects WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND record_kind = ? AND subject_digest = ?",
      )
      .get(
        actualConnectionId,
        actualEpochId,
        evidence.stream,
        evidence.recordKind,
        evidence.subjectDigest,
      ) as { source_subject_id?: unknown };
    const actualSubjectId = blob(subject.source_subject_id);
    db.prepare(
      `INSERT INTO source_captures(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route, source_subject_id, stream, record_kind, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'contract-versioned-source-evidence', ?, ?)`,
    ).run(
      captureId,
      evidence.captureId,
      actualConnectionId,
      actualEpochId,
      evidence.routeKey,
      actualSubjectId,
      evidence.stream,
      evidence.recordKind,
      evidence.observedAt,
      evidence.scope.startDate,
      evidence.scope.endDate,
      evidence.scope.completeness,
      evidence.scope.ruleVersion,
      commitId,
    );
    const contractFingerprint = createHash("sha256")
      .update(`${evidence.routeKey}\u0000${evidence.contractVersion}`)
      .digest("hex");
    const preflightFingerprint = createHash("sha256")
      .update(`${evidence.subjectDigest}\u0000${evidence.scope.ruleVersion}`)
      .digest("hex");
    db.prepare(
      `INSERT INTO capture_scopes(scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, source_subject_id, account_no, stream, scope_start, scope_end, scope_kind, completeness, completeness_basis, completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id)
      VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 'contract-versioned-source-evidence', ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      scopeId,
      captureId,
      actualConnectionId,
      actualEpochId,
      actualSubjectId,
      evidence.stream,
      evidence.scope.startDate,
      evidence.scope.endDate,
      evidence.scope.kind,
      evidence.scope.completeness,
      evidence.scope.ruleVersion,
      evidence.scope.absenceAuthority ?? null,
      contractFingerprint,
      preflightFingerprint,
      evidence.pages.length,
      commitId,
    );
    for (const page of evidence.pages) {
      const metadata = stableSourceJson(page.metadata);
      const digest = createHash("sha256").update(metadata).digest("hex");
      db.prepare(
        `INSERT INTO capture_scope_pages(scope_page_id, scope_id, page_ordinal, response_code, terminal, row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, metadata_json, commit_id)
        VALUES (?, ?, ?, '200', ?, ?, ?, 'contract-versioned-source-evidence', ?, ?, ?, ?)`,
      ).run(
        uuidV7(),
        scopeId,
        page.pageOrdinal,
        page.terminal ? 1 : 0,
        page.rowCount,
        digest,
        contractFingerprint,
        preflightFingerprint,
        metadata,
        commitId,
      );
    }
    for (const record of evidence.records) {
      const sourceRecordId = uuidV7();
      db.prepare(
        `INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        sourceRecordId,
        captureId,
        actualSubjectId,
        commitId,
        evidence.recordKind,
        record.providerKey,
        record.providerKey,
        record.contentHash,
        record.occurrenceKey,
        record.collisionKey ?? null,
        stableSourceJson(record.compact),
      );
      db.prepare(
        "INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, source_subject_id, sequence_lexeme, occurrence_key, commit_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
      ).run(
        sourceRecordId,
        scopeId,
        captureId,
        actualSubjectId,
        record.providerKey,
        record.occurrenceKey,
        commitId,
      );
      db.prepare(
        "INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id) VALUES (?, ?, ?)",
      ).run(sourceRecordId, captureId, commitId);
    }
    if (transactionBoundary) db.exec("COMMIT");
    return {
      status: CANONICAL_SOURCE_STAGE,
      canonicalAdmission: CANONICAL_SOURCE_ADMISSION,
      captureId: evidence.captureId,
      commitSequence: sequence,
      observationCount: evidence.records.length,
      provenanceCount: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS value FROM source_captures WHERE record_kind = ?",
            )
            .get(evidence.recordKind) as { value?: number }
        ).value ?? 0,
      ),
    };
  } catch (error) {
    if (transactionBoundary) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
    }
    throw error;
  }
}
export function commitCanonicalSourceEvidence(
  store: CanonicalSourceStore,
  evidence: CanonicalValidatedSourceEvidence,
): Promise<CanonicalSourceCommitResult> {
  return withCanonicalWriterQueue(store.databasePath, () =>
    commitCanonicalSourceEvidenceOnce(store, evidence),
  );
}

/** Commit several already-admitted source captures as one visibility unit.
 * Every capture is validated and written under the same SQLite transaction, so
 * a later conflict or storage error leaves no earlier capture durable. */
export function commitCanonicalSourceEvidenceBatch(
  store: CanonicalSourceStore,
  evidences: readonly CanonicalValidatedSourceEvidence[],
): Promise<CanonicalSourceCommitResult[]> {
  if (evidences.length === 0)
    throw new Error("Canonical source evidence batch cannot be empty.");
  return withCanonicalWriterQueue(store.databasePath, () => {
    const db = store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const results = evidences.map((evidence) =>
        commitCanonicalSourceEvidenceOnce(store, evidence, false),
      );
      db.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  });
}
function canonicalSourceObservationRows(
  store: CanonicalSourceStore,
  knowledgeAt?: number,
  lineage?: CanonicalSourceLineageRequest,
): CanonicalSourceObservation[] {
  const clauses = ["capture.record_kind <> 'cathay-domestic-deposit'"];
  const parameters: Array<number | string> = [];
  if (knowledgeAt !== undefined) {
    clauses.push("commit_row.commit_sequence <= ?");
    parameters.push(knowledgeAt);
  }
  if (lineage !== undefined) {
    clauses.push(
      "connection.integration_namespace = ?",
      "connection.source_connection_key = ?",
      "epoch.epoch_key = ?",
      "subject.stream = ?",
      "subject.record_kind = ?",
      "subject.subject_digest = ?",
      "record.occurrence_key = ?",
    );
    parameters.push(
      lineage.integrationNamespace,
      lineage.sourceConnectionKey,
      lineage.identityEpoch,
      lineage.stream,
      lineage.recordKind,
      lineage.subjectDigest,
      lineage.occurrenceKey,
    );
  }
  const rows = store.db
    .prepare(
      `SELECT record.rowid AS record_id, capture.capture_key, commit_row.commit_sequence,
      connection.integration_namespace, connection.source_connection_key, epoch.epoch_key,
      subject.stream, subject.record_kind AS subject_record_kind, subject.subject_digest,
      record.occurrence_key, record.collision_key, record.provider_key, record.content_hash, record.payload_json
    FROM source_records record JOIN source_captures capture ON capture.capture_id = record.capture_id
    JOIN source_record_provenance provenance
      ON provenance.source_record_id = record.source_record_id
     AND provenance.capture_id = record.capture_id
     AND provenance.commit_id = record.commit_id
    JOIN canonical_commits commit_row ON commit_row.commit_id = record.commit_id
    JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
    JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
    JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
    WHERE ${clauses.join(" AND ")} ORDER BY commit_row.commit_sequence, record.rowid`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    recordId: Number(row.record_id),
    captureId: String(row.capture_key),
    commitSequence: Number(row.commit_sequence),
    identity: {
      integrationNamespace: String(row.integration_namespace),
      sourceConnectionKey: String(row.source_connection_key),
      identityEpoch: String(row.epoch_key),
      stream: String(row.stream),
      recordKind: String(row.subject_record_kind),
      subjectDigest: String(row.subject_digest),
    },
    occurrenceKey: String(row.occurrence_key),
    ...(row.collision_key === null || row.collision_key === undefined
      ? {}
      : { collisionKey: String(row.collision_key) }),
    providerKey: String(row.provider_key),
    contentHash: String(row.content_hash),
    compact: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
  }));
}
function currentCanonicalSourceRows(
  observations: CanonicalSourceObservation[],
): CanonicalSourceObservation[] {
  const latest = new Map<string, CanonicalSourceObservation>();
  for (const observation of observations) {
    const identity = observation.identity;
    latest.set(
      [
        identity.integrationNamespace,
        identity.sourceConnectionKey,
        identity.identityEpoch,
        identity.stream,
        identity.recordKind,
        identity.subjectDigest,
        observation.occurrenceKey,
      ].join("\u0000"),
      observation,
    );
  }
  return [...latest.values()].sort(
    (left, right) => left.recordId - right.recordId,
  );
}
function canonicalSourceQueryBase(
  store: CanonicalSourceStore,
  knowledgeAt?: number,
): CanonicalSourceQueryBase {
  const observations = canonicalSourceObservationRows(store, knowledgeAt);
  const provenanceCount = Number(
    (
      store.db
        .prepare(
          `SELECT COUNT(*) AS value FROM source_captures capture
    JOIN canonical_commits commit_row ON commit_row.commit_id = capture.commit_id
    WHERE capture.record_kind <> 'cathay-domestic-deposit'${knowledgeAt === undefined ? "" : " AND commit_row.commit_sequence <= ?"}`,
        )
        .get(...(knowledgeAt === undefined ? [] : [knowledgeAt])) as {
        value?: number;
      }
    ).value ?? 0,
  );
  return {
    status: CANONICAL_SOURCE_STAGE,
    canonicalAdmission: CANONICAL_SOURCE_ADMISSION,
    records: currentCanonicalSourceRows(observations),
    observations,
    provenanceCount,
  };
}
export function queryCanonicalSourceCurrent(
  store: CanonicalSourceStore,
): CanonicalSourceCurrentQuery {
  return withCanonicalSnapshot(store.db, () => ({
    kind: "current",
    ...canonicalSourceQueryBase(store),
  }));
}
export function queryCanonicalSourceHistorical(
  store: CanonicalSourceStore,
  request: { knowledgeAt?: number; effectiveAt?: string } = {},
): CanonicalSourceHistoricalQuery {
  if (request.effectiveAt !== undefined)
    throw new Error("Financial/effective-time source query is unsupported.");
  return withCanonicalSnapshot(store.db, () => {
    const latest = Number(
      (
        store.db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? 0,
    );
    const knowledgeAt = request.knowledgeAt ?? latest;
    if (
      !Number.isSafeInteger(knowledgeAt) ||
      knowledgeAt < 0 ||
      knowledgeAt > latest
    )
      throw new Error("Historical knowledge cutoff is invalid.");
    return {
      kind: "historical",
      knowledgeAt,
      financialCutoffApplied: false,
      ...canonicalSourceQueryBase(store, knowledgeAt),
    };
  });
}
export function queryCanonicalSourceLineage(
  store: CanonicalSourceStore,
  request: CanonicalSourceLineageRequest,
): CanonicalSourceLineageQuery {
  const lineage: CanonicalSourceLineageRequest = {
    integrationNamespace: requireSourceText(
      request.integrationNamespace,
      "Integration namespace",
    ),
    sourceConnectionKey: requireSourceToken(
      request.sourceConnectionKey,
      "Source connection key",
    ),
    identityEpoch: requireSourceToken(request.identityEpoch, "Identity epoch"),
    stream: requireSourceText(request.stream, "Source stream"),
    recordKind: requireSourceText(request.recordKind, "Source record kind"),
    subjectDigest: requireSourceToken(request.subjectDigest, "Subject digest"),
    occurrenceKey: requireSourceToken(request.occurrenceKey, "Occurrence key"),
  };
  return withCanonicalSnapshot(store.db, () => {
    const observations = canonicalSourceObservationRows(
      store,
      undefined,
      lineage,
    );
    const provenance = observations.map(({ captureId, commitSequence }) => ({
      captureId,
      commitSequence,
    }));
    const integrity = store.db
      .prepare(
        `SELECT COUNT(*) AS expected_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_provenance exact_link
            WHERE exact_link.source_record_id = record.source_record_id
              AND exact_link.capture_id = record.capture_id
              AND exact_link.commit_id = record.commit_id)), 0) AS exact_link_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_provenance any_link
            WHERE any_link.source_record_id = record.source_record_id)), 0) AS total_link_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_scopes exact_scope
            WHERE exact_scope.source_record_id = record.source_record_id
              AND exact_scope.capture_id = record.capture_id
              AND exact_scope.source_subject_id = record.source_subject_id
              AND exact_scope.occurrence_key = record.occurrence_key
              AND exact_scope.commit_id = record.commit_id)), 0) AS exact_scope_count,
          COALESCE(SUM((SELECT COUNT(*) FROM source_record_scopes any_scope
            WHERE any_scope.source_record_id = record.source_record_id)), 0) AS total_scope_count
         FROM source_records record
         JOIN source_captures capture ON capture.capture_id = record.capture_id
         JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
         JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
         JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
         WHERE connection.integration_namespace = ?
           AND connection.source_connection_key = ?
           AND epoch.epoch_key = ?
           AND subject.stream = ?
           AND subject.record_kind = ?
           AND subject.subject_digest = ?
           AND record.occurrence_key = ?`,
      )
      .get(
        lineage.integrationNamespace,
        lineage.sourceConnectionKey,
        lineage.identityEpoch,
        lineage.stream,
        lineage.recordKind,
        lineage.subjectDigest,
        lineage.occurrenceKey,
      ) as {
      expected_count?: number;
      exact_link_count?: number;
      total_link_count?: number;
      exact_scope_count?: number;
      total_scope_count?: number;
    };
    const occurrenceScopeLinks = Number(
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS value
             FROM source_record_scopes link
             JOIN source_subjects subject ON subject.source_subject_id = link.source_subject_id
             JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
             JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
             WHERE connection.integration_namespace = ?
               AND connection.source_connection_key = ?
               AND epoch.epoch_key = ?
               AND subject.stream = ?
               AND subject.record_kind = ?
               AND subject.subject_digest = ?
               AND link.occurrence_key = ?`,
          )
          .get(
            lineage.integrationNamespace,
            lineage.sourceConnectionKey,
            lineage.identityEpoch,
            lineage.stream,
            lineage.recordKind,
            lineage.subjectDigest,
            lineage.occurrenceKey,
          ) as { value?: number }
      ).value ?? 0,
    );
    const persistedObservationCount = Number(integrity.expected_count ?? 0);
    const expectedObservationCount = Math.max(
      persistedObservationCount,
      occurrenceScopeLinks,
    );
    const exactLinkCount = Number(integrity.exact_link_count ?? 0);
    const totalLinkCount = Number(integrity.total_link_count ?? 0);
    const exactScopeCount = Number(integrity.exact_scope_count ?? 0);
    const totalScopeCount = Number(integrity.total_scope_count ?? 0);
    const provenanceComplete =
      expectedObservationCount > 0 &&
      persistedObservationCount === expectedObservationCount &&
      occurrenceScopeLinks === expectedObservationCount &&
      observations.length === expectedObservationCount &&
      provenance.length === expectedObservationCount &&
      exactLinkCount === expectedObservationCount &&
      totalLinkCount === expectedObservationCount &&
      exactScopeCount === expectedObservationCount &&
      totalScopeCount === expectedObservationCount;
    return {
      kind: "lineage",
      occurrenceKey: lineage.occurrenceKey,
      identity: {
        integrationNamespace: lineage.integrationNamespace,
        sourceConnectionKey: lineage.sourceConnectionKey,
        identityEpoch: lineage.identityEpoch,
        stream: lineage.stream,
        recordKind: lineage.recordKind,
        subjectDigest: lineage.subjectDigest,
      },
      status: CANONICAL_SOURCE_STAGE,
      canonicalAdmission: CANONICAL_SOURCE_ADMISSION,
      records: currentCanonicalSourceRows(observations),
      observations,
      provenanceCount: provenance.length,
      provenance,
      expectedObservationCount,
      provenanceComplete,
    };
  });
}
