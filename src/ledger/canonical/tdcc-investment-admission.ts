import { createHash } from "node:crypto";
import {
  admitCanonicalInvestmentCapture,
  type InvestmentCaptureInput,
  type InvestmentExactAmount,
  type InvestmentSecurityType,
  type InvestmentValidatedCapture,
  type PassbookMovementAction,
} from "./investment-financial-admission.ts";
import { TDCC_INVESTMENT_CONTRACT, TDCC_INVESTMENT_ROUTE } from "./tdcc-investment-contract.ts";
import { institutionForBrokerBranch, type InstitutionKey } from "../../lib/institutions/institutions.ts";

/** A TR001 or TR002 response that breaks the investment contract. The whole attempted capture is cancelled. */
export class TdccInvestmentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TdccInvestmentContractError";
  }
}

export type TdccInvestmentConnection = Readonly<{
  sourceConnectionKey: string;
  identityEpochKey: string;
}>;

/** A TR001 broker securities account whose branch code resolves in the Institution catalog. */
export type TdccBrokerAccount = Readonly<{
  brokerNo: string;
  brokerAccount: string;
  institutionKey: InstitutionKey;
  /** One TDCC investment account per broker branch and account number. */
  accountKey: string;
}>;

/** A reported account that this contract does not admit. Nothing is dropped without one. */
export type TdccInvestmentExclusion = Readonly<{
  reason: "unknown-institution-code";
  product: "securities";
  brokerNo: string;
  accountNoSuffix: string;
}>;

export type TdccBrokerAccounts = Readonly<{
  accounts: readonly TdccBrokerAccount[];
  exclusions: readonly TdccInvestmentExclusion[];
}>;

/**
 * TDCC reports domestic securities, and refTWDValue reports funds, in TWD, so
 * every TDCC investment account reports in TWD. Each Security keeps the
 * currency its own row reports.
 */
const TDCC_REPORTING_CURRENCY = "TWD";

/** TR002 txnCode values and the quantity direction each one reports. Any other code rejects the capture. */
const PASSBOOK_MOVEMENT_CODES: Readonly<Record<string, PassbookMovementAction>> = {
  "113": "buy",
  "123": "sell",
};

/** TR002 stockType values. Any other value rejects the capture. */
const STOCK_TYPES: Readonly<Record<string, InvestmentSecurityType>> = {
  "00": "equity",
  "12": "mutual_fund",
};

/** TWSE and TPEx assign ETF codes the `00` prefix; it outranks the stockType a row reports. */
const ETF_SYMBOL_PREFIX = "00";

const TR002_SLOT_COUNT = 23;
const TR002_SLOT = {
  postDate: 0,
  txnSerNo: 1,
  symbol: 2,
  name: 3,
  stockType: 8,
  txnDate: 9,
  txnCode: 10,
  quantity: 12,
  currency: 20,
} as const;

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function reject(message: string): never {
  throw new TdccInvestmentContractError(message);
}

const digest = (...parts: readonly string[]): string =>
  `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) reject(`${label} must be an array.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") reject(`${label} must be a string.`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  const trimmed = text(value, label).trim();
  if (!trimmed) reject(`${label} must not be empty.`);
  return trimmed;
}

function decimal(value: unknown, label: string): InvestmentExactAmount {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(text(value, label));
  if (!match) reject(`${label} must be a plain non-negative decimal.`);
  const [, whole, fraction = ""] = match;
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "");
  return { coefficient: digits, scale: fraction.length };
}

function currency(value: unknown, label: string): string {
  const code = text(value, label);
  if (!ISO_CURRENCIES.has(code)) reject(`${label} must be an ISO 4217 code.`);
  return code;
}

/** TR002 dates are ROC `0YYYMMDD`, so `01120109` is 2023-01-09. Any other shape rejects the capture. */
export function tdccRocDate(value: unknown, label: string): string {
  const match = /^0(\d{3})(\d{2})(\d{2})$/u.exec(text(value, label));
  const rocYear = match ? Number(match[1]) : 0;
  const iso = match ? `${String(rocYear + 1911).padStart(4, "0")}-${match[2]}-${match[3]}` : "";
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!match || rocYear < 1 || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== iso)
    reject(`${label} must be an ROC 0YYYMMDD date.`);
  return iso;
}

const accountNoSuffix = (accountNo: string) => accountNo.slice(-4);

/** Resolves a broker branch code through the catalog, or reports the account as excluded. */
export function tdccBrokerAccount(brokerNo: string, brokerAccount: string): TdccBrokerAccount | TdccInvestmentExclusion {
  const institutionKey = institutionForBrokerBranch(brokerNo);
  if (!institutionKey)
    return { reason: "unknown-institution-code", product: "securities", brokerNo, accountNoSuffix: accountNoSuffix(brokerAccount) };
  return { brokerNo, brokerAccount, institutionKey, accountKey: digest("tdcc-broker-account-v1", brokerNo, brokerAccount) };
}

const isExclusion = (value: TdccBrokerAccount | TdccInvestmentExclusion): value is TdccInvestmentExclusion =>
  "reason" in value;

/** Reads the TR001 broker accounts into admissible accounts and typed exclusions. */
export function readTdccBrokerAccounts(body: unknown): TdccBrokerAccounts {
  const root = object(body, "TR001 response");
  const accounts: TdccBrokerAccount[] = [];
  const exclusions: TdccInvestmentExclusion[] = [];
  const keys = new Set<string>();
  for (const [index, value] of list(root.accounts, "TR001 accounts").entries()) {
    const row = object(value, `TR001 account ${index}`);
    const brokerNo = nonEmpty(row.brokerNo, `TR001 account ${index} brokerNo`);
    const brokerAccount = nonEmpty(row.brokerAccount, `TR001 account ${index} brokerAccount`);
    const resolved = tdccBrokerAccount(brokerNo, brokerAccount);
    if (isExclusion(resolved)) {
      exclusions.push(resolved);
      continue;
    }
    if (keys.has(resolved.accountKey)) reject(`TR001 account ${index} repeats a broker account.`);
    keys.add(resolved.accountKey);
    accounts.push(resolved);
  }
  return { accounts, exclusions };
}

type Security = InvestmentCaptureInput["securities"][number];
type Movement = NonNullable<InvestmentCaptureInput["passbookMovements"]>[number];

function securityType(symbol: string, stockType: string, label: string): InvestmentSecurityType {
  if (!Object.hasOwn(STOCK_TYPES, stockType)) reject(`${label} stockType is not an admitted value.`);
  return symbol.startsWith(ETF_SYMBOL_PREFIX) ? "ETF" : STOCK_TYPES[stockType]!;
}

/** Collects each Security once; a Security whose rows disagree on its evidence rejects the capture. */
function securityCollector() {
  const securities = new Map<string, Security>();
  return {
    add(security: Security, label: string): string {
      const prior = securities.get(security.securityKey);
      if (prior && JSON.stringify(prior) !== JSON.stringify(security)) reject(`${label} disagrees with another row about its Security.`);
      securities.set(security.securityKey, security);
      return security.securityKey;
    },
    values: () => [...securities.values()],
  };
}

function security(symbol: string, name: string, type: InvestmentSecurityType, securityCurrency: string): Security {
  return {
    securityKey: `tdcc:${symbol}`,
    producerSecurityId: symbol,
    name,
    currency: securityCurrency,
    securityType: type,
    identityEvidence: { kind: "producer-security-id", contractVersion: TDCC_INVESTMENT_CONTRACT },
  };
}

function movementRow(
  account: TdccBrokerAccount,
  value: unknown,
  label: string,
  securities: ReturnType<typeof securityCollector>,
): Movement {
  const row = list(value, label);
  if (row.length !== TR002_SLOT_COUNT) reject(`${label} must have ${TR002_SLOT_COUNT} slots.`);
  const slot = (name: keyof typeof TR002_SLOT) => row[TR002_SLOT[name]];
  const txnCode = text(slot("txnCode"), `${label} txnCode`);
  if (!Object.hasOwn(PASSBOOK_MOVEMENT_CODES, txnCode)) reject(`${label} txnCode is not an admitted movement code.`);
  const postDate = text(slot("postDate"), `${label} postDate`);
  const txnDate = text(slot("txnDate"), `${label} txnDate`);
  const txnSerNo = nonEmpty(slot("txnSerNo"), `${label} txnSerNo`);
  const quantity = decimal(slot("quantity"), `${label} quantity`);
  if (/^0+$/u.test(quantity.coefficient)) reject(`${label} must move a non-zero quantity.`);
  const symbol = nonEmpty(slot("symbol"), `${label} symbol`);
  const securityKey = securities.add(
    security(
      symbol,
      nonEmpty(slot("name"), `${label} name`),
      securityType(symbol, text(slot("stockType"), `${label} stockType`), label),
      currency(slot("currency"), `${label} currency`),
    ),
    label,
  );
  const movementKey = digest("tdcc-passbook-movement-v1", account.accountKey, txnDate, postDate, txnSerNo);
  return {
    sourceRecordKey: movementKey,
    movementKey,
    securityKey,
    action: PASSBOOK_MOVEMENT_CODES[txnCode]!,
    quantity,
    tradeOn: tdccRocDate(txnDate, `${label} txnDate`),
    postedOn: tdccRocDate(postDate, `${label} postDate`),
  };
}

export type TdccInvestmentCaptureInput = Readonly<{
  captureId: string;
  observedAt: string;
  connection: TdccInvestmentConnection;
  account: TdccBrokerAccount;
}>;

function taipeiDate(instant: string): string {
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) reject("Observation time must be an instant.");
  return new Date(epoch + 8 * 3_600_000).toISOString().slice(0, 10);
}

function identity(input: TdccInvestmentCaptureInput): InvestmentCaptureInput["identity"] {
  return {
    sourceConnectionKey: input.connection.sourceConnectionKey,
    identityEpochKey: input.connection.identityEpochKey,
    accountKey: input.account.accountKey,
    accountNumber: {
      value: input.account.brokerAccount,
      kind: "brokerage-account",
      evidenceVersion: TDCC_INVESTMENT_CONTRACT,
      sourceField: "brokerAccount",
    },
    accountType: "investment",
    reportingCurrency: TDCC_REPORTING_CURRENCY,
    institutionKey: input.account.institutionKey,
  };
}

/**
 * One complete-range Passbook movement capture per broker account from every
 * TR002 page the client walked back to D0002, which is all history TDCC
 * holds. The range ends on the collection day in Asia/Taipei because no later
 * movement can exist yet, and starts at the oldest movement.
 */
export function tdccPassbookMovementCapture(
  input: TdccInvestmentCaptureInput & Readonly<{ pages: readonly unknown[] }>,
): InvestmentValidatedCapture {
  const { account } = input;
  const securities = securityCollector();
  const movements: Movement[] = [];
  for (const [pageIndex, value] of input.pages.entries()) {
    const page = object(value, `TR002 page ${pageIndex}`);
    if (text(page.brokerNo, `TR002 page ${pageIndex} brokerNo`) !== account.brokerNo ||
        text(page.brokerAccount, `TR002 page ${pageIndex} brokerAccount`) !== account.brokerAccount)
      reject(`TR002 page ${pageIndex} belongs to another broker account.`);
    for (const [rowIndex, row] of list(page.items, `TR002 page ${pageIndex} items`).entries())
      movements.push(movementRow(account, row, `TR002 ${pageIndex}:${rowIndex}`, securities));
  }
  const endDate = taipeiDate(input.observedAt);
  const startDate = movements.flatMap((movement) => [movement.tradeOn, movement.postedOn]).reduce((oldest, day) => day < oldest ? day : oldest, endDate);
  return admitCanonicalInvestmentCapture({
      captureId: input.captureId,
      sourceId: "tdcc",
      authorityRoute: TDCC_INVESTMENT_ROUTE,
      contractVersion: TDCC_INVESTMENT_CONTRACT,
      observedAt: input.observedAt,
      identity: identity(input),
      scope: { effectiveOn: endDate, complete: true, transactionHistory: { startDate, endDate, complete: true } },
      securities: securities.values(),
      holdings: [],
      transactions: [],
      passbookMovements: movements,
    });
}
