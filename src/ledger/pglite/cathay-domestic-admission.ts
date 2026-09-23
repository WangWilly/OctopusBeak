import { createHash } from "node:crypto";
import {
  validateCanonicalSourceAccountNumber,
  type CanonicalSourceAccountNumber,
} from "../canonical/canonical-source-evidence.ts";
import { parseExactDecimalLexeme } from "../canonical/exact-decimal-lexeme.ts";
import type { ExactDecimal } from "../canonical/exact-decimal-lexeme.ts";
import type { CathayValidatedDomesticSync } from "./cathay-domestic-adapter.ts";

export { parseExactDecimalLexeme } from "../canonical/exact-decimal-lexeme.ts";
export type { ExactDecimal } from "../canonical/exact-decimal-lexeme.ts";

export const CATHAY_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit" as const;
export const CATHAY_DOMESTIC_DEPOSIT_AUTHORITY =
  "cathay/domestic-deposit/v1" as const;

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
  /** Explicit provider field evidence; never inferred from the source key. */
  accountNumber?: CanonicalSourceAccountNumber | null;
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
  accountNumber?: CanonicalSourceAccountNumber | null;
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

export const MAX_CANONICAL_SCALE = 9007199254740991n;

export function canonicalStoredInteger(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value))
    return value.toString();
  return null;
}

export function isCanonicalStoredExactAmount(
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

export type LosslessJsonNumber = { kind: "number"; lexeme: string };

export type LosslessJsonValue =
  | null
  | boolean
  | string
  | LosslessJsonNumber
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue };

export class LosslessJsonParser {
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

export function asObject(
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

export function asArray(
  value: LosslessJsonValue | undefined,
  label: string,
): LosslessJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

export function requiredString(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Missing required string ${key}.`);
  return value;
}

export function isLosslessJsonNumber(
  value: LosslessJsonValue | undefined,
): value is LosslessJsonNumber {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.kind === "number",
  );
}

export function requiredNumber(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string {
  const value = object[key];
  if (!isLosslessJsonNumber(value))
    throw new Error(`Missing required JSON number ${key}.`);
  return value.lexeme;
}

export function nullableNumber(
  object: { [key: string]: LosslessJsonValue },
  key: string,
): string | null {
  const value = object[key];
  if (value === null) return null;
  if (!isLosslessJsonNumber(value))
    throw new Error(`${key} must be a JSON number or null.`);
  return value.lexeme;
}

export function requireDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`${label} must be a valid calendar date.`);
  return value;
}

export function normalizeCathayAccountDate(
  value: string,
  label: string,
): string {
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

export function normalizeCathayResponseDate(
  value: string,
  expected: string,
): string {
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

export function requireDateTime(value: string, label: string): string {
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

export function parseRfc3339UtcMicros(value: string, label: string): number {
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
      `${label} microseconds exceed the safe integer range.`,
    );
  return Number(micros);
}

export function localDateTimeToUtcMicros(value: string): number {
  return parseRfc3339UtcMicros(`${value}+08:00`, "Cathay local date-time");
}

export function localDateToUtcMicros(value: string): number {
  return localDateTimeToUtcMicros(`${value}T00:00:00`);
}

export type ValidatedCathayRow = {
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

export type ValidatedCathayCapture = {
  accountNo: string;
  accountNumber: CanonicalSourceAccountNumber | null;
  startDate: string;
  endDate: string;
  posting: typeof CATHAY_POSTING_MAPPING;
  completeness: typeof CATHAY_COMPLETENESS_PROOF;
  rows: ValidatedCathayRow[];
};

export type ValidatedCathayScope = {
  accountNo: string;
  accountNumber: CanonicalSourceAccountNumber | null;
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

export type ValidatedCathaySync = {
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  syncState: { cursor?: string | null };
  observedAt: string;
  scopes: ValidatedCathayScope[];
};

export function cathayPostingMapping(
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

export function validateCapture(
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
  const accountNumber = input.accountNumber ?? null;
  try {
    validateCanonicalSourceAccountNumber(accountNumber);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "Cathay account number evidence is invalid.",
    );
  }
  if (
    accountNumber &&
    (accountNumber.kind !== "depository-account" ||
      !/^\d{6,24}$/u.test(accountNumber.value) ||
      accountNumber.value !== accountNo)
  )
    throw new Error(
      "Cathay account number evidence must match the complete provider account field.",
    );
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
    accountNumber,
    startDate,
    endDate,
    posting,
    completeness: CATHAY_COMPLETENESS_PROOF,
    rows,
  };
}

export function responseDigest(rawResponse: string): string {
  return createHash("sha256").update(rawResponse, "utf8").digest("hex");
}

export function validateSyncInput(
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
      const firstAccountNumber = pages[0]!.accountNumber ?? null;
      const pageAccountNumber = page.accountNumber ?? null;
      if (
        (firstAccountNumber?.value ?? null) !==
          (pageAccountNumber?.value ?? null) ||
        (firstAccountNumber?.kind ?? null) !==
          (pageAccountNumber?.kind ?? null) ||
        (firstAccountNumber?.evidenceVersion ?? null) !==
          (pageAccountNumber?.evidenceVersion ?? null) ||
        (firstAccountNumber?.sourceField ?? null) !==
          (pageAccountNumber?.sourceField ?? null)
      )
        throw new Error(
          "Cathay account number evidence drifted within one account.",
        );
      const requestPageToken = page.requestPageToken ?? null;
      if (requestPageToken !== expectedRequestToken)
        throw new Error("Cathay page continuation token is not contiguous.");
      const validated = validateCapture({
        rawResponse: page.rawResponse,
        sourceConnectionId: input.sourceConnectionId,
        identityEpoch: input.identityEpoch,
        accountNo,
        accountNumber: page.accountNumber ?? null,
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
      accountNumber: pages[0]!.accountNumber ?? null,
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

export function validateCathayDomesticDepositSyncInput(
  input: CathayDomesticDepositSyncInput,
): void {
  validateSyncInput(input);
}

export function validateCathayDomesticDepositSyncInputForPGlite(
  input: CathayDomesticDepositSyncInput,
): CathayValidatedDomesticSync {
  return validateSyncInput(input);
}
