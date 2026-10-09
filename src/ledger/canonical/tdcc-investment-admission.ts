import { createHash } from "node:crypto";
import {
  admitCanonicalInvestmentCapture,
  type InvestmentCaptureInput,
  type InvestmentExactAmount,
  type InvestmentMoney,
  type InvestmentSecurityType,
  type InvestmentValidatedCapture,
  type PassbookMovementAction,
} from "./investment-financial-admission.ts";
import { TDCC_INVESTMENT_CONTRACT, TDCC_INVESTMENT_ROUTE } from "./tdcc-investment-contract.ts";
import { taipeiCompactTimeInstant } from "../pglite/current-deposit-admission.ts";
import {
  institutionForBankCode,
  institutionForBrokerBranch,
  type InstitutionKey,
} from "../../lib/institutions/institutions.ts";

/** A TR001, TR002, or TR051V1 response that breaks the investment contract. The whole attempted capture is cancelled. */
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

/** A TR051V1 fund account: the funds held through one catalog sale organisation. */
export type TdccFundAccount = Readonly<{
  saleOrgCode: string;
  institutionKey: InstitutionKey;
  accountKey: string;
}>;

/** A reported account that this contract does not admit. Nothing is dropped without one. */
export type TdccInvestmentExclusion =
  | Readonly<{ reason: "unknown-institution-code"; product: "securities"; brokerNo: string; accountNoSuffix: string }>
  | Readonly<{ reason: "unknown-institution-code"; product: "funds"; saleOrgCode: string; holdingCount: number }>;

type HoldingRow = Readonly<{
  symbol: string;
  name: string;
  securityType: InvestmentSecurityType;
  securityCurrency: string;
  quantity: InvestmentExactAmount;
  valuation: InvestmentMoney;
  /** The provider lexemes the record keeps, so a changed value is a new record. */
  lexemes: readonly string[];
}>;

/** TR001 as of its lastServerTime: admissible broker accounts with their holdings, and typed exclusions. */
export type TdccPositions = Readonly<{
  lastServerTime: string;
  effectiveOn: string;
  accounts: readonly (TdccBrokerAccount & Readonly<{ holdings: readonly HoldingRow[] }>)[];
  exclusions: readonly TdccInvestmentExclusion[];
}>;

/** TR051V1 as of its updateTime: admissible fund accounts with their holdings, and typed exclusions. */
export type TdccFunds = Readonly<{
  updateTime: string;
  effectiveOn: string;
  accounts: readonly (TdccFundAccount & Readonly<{ holdings: readonly HoldingRow[] }>)[];
  exclusions: readonly TdccInvestmentExclusion[];
}>;

/**
 * TDCC reports domestic securities, and refTWDValue reports funds, in TWD, so
 * every TDCC investment account reports in TWD. Each Security keeps the
 * currency its own row reports.
 */
const TDCC_REPORTING_CURRENCY = "TWD";

/** refTWDValue is a fund's reference value in TWD. */
const FUND_VALUATION_CURRENCY = "TWD";

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

const TR001_ITEM_SLOT = {
  symbol: 0,
  name: 1,
  stockType: 6,
  quantity: 7,
  price: 17,
  currency: 19,
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

/** The broker account when its branch code is in the catalog, else null. */
export function tdccBrokerAccount(brokerNo: string, brokerAccount: string): TdccBrokerAccount | null {
  const institutionKey = institutionForBrokerBranch(brokerNo);
  return institutionKey
    ? { brokerNo, brokerAccount, institutionKey, accountKey: digest("tdcc-broker-account-v1", brokerNo, brokerAccount) }
    : null;
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

/** TR001 lastServerTime and TR051V1 updateTime are Gregorian Asia/Taipei `YYYYMMDDhhmmss`, like TSP006 updateTime. */
function taipeiSystemDate(lexeme: string, label: string): string {
  if (!taipeiCompactTimeInstant(lexeme)) reject(`${label} must be a Gregorian Asia/Taipei YYYYMMDDhhmmss time.`);
  return `${lexeme.slice(0, 4)}-${lexeme.slice(4, 6)}-${lexeme.slice(6, 8)}`;
}

function multiply(left: InvestmentExactAmount, right: InvestmentExactAmount): InvestmentExactAmount {
  return { coefficient: (BigInt(left.coefficient) * BigInt(right.coefficient)).toString(), scale: left.scale + right.scale };
}

function uniqueSymbols(rows: readonly HoldingRow[], label: string): readonly HoldingRow[] {
  if (new Set(rows.map((row) => row.symbol)).size !== rows.length) reject(`${label} reports one Security twice.`);
  return rows;
}

/** Valuation is quantity times slot 17, an accepted risk until a live account confirms the slot (ADR 0042). */
function securitiesHolding(value: unknown, label: string): HoldingRow {
  const row = list(value, label);
  const slot = (name: keyof typeof TR001_ITEM_SLOT) => row[TR001_ITEM_SLOT[name]];
  const symbol = nonEmpty(slot("symbol"), `${label} symbol`);
  const quantity = decimal(slot("quantity"), `${label} quantity`);
  const price = decimal(slot("price"), `${label} price`);
  const securityCurrency = currency(slot("currency"), `${label} currency`);
  return {
    symbol,
    name: nonEmpty(slot("name"), `${label} name`),
    securityType: securityType(symbol, text(slot("stockType"), `${label} stockType`), label),
    securityCurrency,
    quantity,
    valuation: { ...multiply(quantity, price), currency: securityCurrency },
    lexemes: [text(slot("quantity"), label), text(slot("price"), label)],
  };
}

/** Reads TR001 into broker accounts with their holdings and typed exclusions. */
export function readTdccPositions(body: unknown): TdccPositions {
  const root = object(body, "TR001 response");
  const lastServerTime = text(root.lastServerTime, "TR001 lastServerTime");
  const effectiveOn = taipeiSystemDate(lastServerTime, "TR001 lastServerTime");
  const accounts: TdccPositions["accounts"][number][] = [];
  const exclusions: TdccInvestmentExclusion[] = [];
  const keys = new Set<string>();
  for (const [index, value] of list(root.accounts, "TR001 accounts").entries()) {
    const label = `TR001 account ${index}`;
    const row = object(value, label);
    const brokerNo = nonEmpty(row.brokerNo, `${label} brokerNo`);
    const brokerAccount = nonEmpty(row.brokerAccount, `${label} brokerAccount`);
    const items = list(row.items, `${label} items`);
    const resolved = tdccBrokerAccount(brokerNo, brokerAccount);
    if (!resolved) {
      exclusions.push({ reason: "unknown-institution-code", product: "securities", brokerNo, accountNoSuffix: brokerAccount.slice(-4) });
      continue;
    }
    if (keys.has(resolved.accountKey)) reject(`${label} repeats a broker account.`);
    keys.add(resolved.accountKey);
    const holdings = items.map((item, itemIndex) => securitiesHolding(item, `${label} item ${itemIndex}`));
    accounts.push({ ...resolved, holdings: uniqueSymbols(holdings, label) });
  }
  return { lastServerTime, effectiveOn, accounts, exclusions };
}

/**
 * A sale organisation is a bank (3-digit FISC code) or a broker (4-character
 * TWSE code). The code sets differ in length, so at most one lookup matches.
 * Null means the code is not in the catalog.
 */
export function tdccFundAccount(saleOrgCode: string): TdccFundAccount | null {
  const institutionKey = institutionForBankCode(saleOrgCode) ?? institutionForBrokerBranch(saleOrgCode);
  return institutionKey ? { saleOrgCode, institutionKey, accountKey: digest("tdcc-fund-account-v1", saleOrgCode) } : null;
}

/** Reads TR051V1 into fund accounts, one per catalog sale organisation, and typed exclusions. */
export function readTdccFunds(body: unknown): TdccFunds {
  const root = object(body, "TR051V1 response");
  const updateTime = text(root.updateTime, "TR051V1 updateTime");
  const effectiveOn = taipeiSystemDate(updateTime, "TR051V1 updateTime");
  const bySaleOrg = new Map<string, HoldingRow[]>();
  for (const [index, value] of list(root.fundDetails, "TR051V1 fundDetails").entries()) {
    const label = `TR051V1 fund ${index}`;
    const row = object(value, label);
    const saleOrgCode = nonEmpty(row.saleOrgCode, `${label} saleOrgCode`);
    const holding: HoldingRow = {
      symbol: nonEmpty(row.fundNo, `${label} fundNo`),
      name: nonEmpty(row.fundCHName, `${label} fundCHName`),
      securityType: "mutual_fund",
      // TR051V1 values a fund in TWD only, so its own pricing currency is not admitted.
      securityCurrency: "",
      quantity: decimal(row.fundSHR, `${label} fundSHR`),
      valuation: { ...decimal(row.refTWDValue, `${label} refTWDValue`), currency: FUND_VALUATION_CURRENCY },
      lexemes: [text(row.fundSHR, label), text(row.refTWDValue, label)],
    };
    bySaleOrg.set(saleOrgCode, [...(bySaleOrg.get(saleOrgCode) ?? []), holding]);
  }
  const accounts: TdccFunds["accounts"][number][] = [];
  const exclusions: TdccInvestmentExclusion[] = [];
  for (const [saleOrgCode, holdings] of bySaleOrg) {
    const account = tdccFundAccount(saleOrgCode);
    if (!account) exclusions.push({ reason: "unknown-institution-code", product: "funds", saleOrgCode, holdingCount: holdings.length });
    else accounts.push({ ...account, holdings: uniqueSymbols(holdings, `TR051V1 sale organisation ${saleOrgCode}`) });
  }
  return { updateTime, effectiveOn, accounts, exclusions };
}

type CaptureInput = Readonly<{
  captureId: string;
  observedAt: string;
  connection: TdccInvestmentConnection;
}>;

function taipeiDate(instant: string): string {
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) reject("Observation time must be an instant.");
  return new Date(epoch + 8 * 3_600_000).toISOString().slice(0, 10);
}

function identity(input: CaptureInput, account: TdccBrokerAccount | TdccFundAccount): InvestmentCaptureInput["identity"] {
  return {
    sourceConnectionKey: input.connection.sourceConnectionKey,
    identityEpochKey: input.connection.identityEpochKey,
    accountKey: account.accountKey,
    ...("brokerAccount" in account
      ? {
          accountNumber: {
            value: account.brokerAccount,
            kind: "brokerage-account" as const,
            evidenceVersion: TDCC_INVESTMENT_CONTRACT,
            sourceField: "brokerAccount",
          },
        }
      : {}),
    accountType: "investment",
    reportingCurrency: TDCC_REPORTING_CURRENCY,
    institutionKey: account.institutionKey,
  };
}

/**
 * One holding capture per account. Its holdings are the account's complete
 * inventory at the response time, so an account that holds nothing still
 * commits an empty snapshot and a later sale is not left current.
 */
function holdingCapture(
  input: CaptureInput,
  account: TdccBrokerAccount | TdccFundAccount,
  rows: readonly HoldingRow[],
  time: Readonly<{ sourceField: string; lexeme: string; effectiveOn: string }>,
): InvestmentValidatedCapture {
  const securities = securityCollector();
  const holdings = rows.map((row, index): InvestmentCaptureInput["holdings"][number] => {
    const label = `${time.sourceField} holding ${index}`;
    const securityKey = securities.add(security(row.symbol, row.name, row.securityType, row.securityCurrency), label);
    const sourceRecordKey = digest("tdcc-holding-record-v1", account.accountKey, row.symbol, time.lexeme, ...row.lexemes);
    return {
      measurementKey: digest("tdcc-holding-measurement-v1", input.captureId, account.accountKey, row.symbol),
      measurementSubjectKey: digest("tdcc-holding-subject-v1", account.accountKey, row.symbol, time.effectiveOn),
      sourceRecordKey,
      securityKey,
      quantity: row.quantity,
      valuation: row.valuation,
      effectiveOn: time.effectiveOn,
      observedAt: input.observedAt,
      effectiveTimeEvidence: {
        kind: "source-reported-as-of",
        sourceRecordKey,
        sourceField: time.sourceField,
        value: time.effectiveOn,
        contractVersion: TDCC_INVESTMENT_CONTRACT,
      },
      lineage: { page: 0, row: index, contractVersion: TDCC_INVESTMENT_CONTRACT },
    };
  });
  return admitCanonicalInvestmentCapture({
    captureId: input.captureId,
    sourceId: "tdcc",
    authorityRoute: TDCC_INVESTMENT_ROUTE,
    contractVersion: TDCC_INVESTMENT_CONTRACT,
    observedAt: input.observedAt,
    identity: identity(input, account),
    scope: {
      effectiveOn: time.effectiveOn,
      complete: true,
      holdingSnapshot: { sourceField: time.sourceField, value: time.effectiveOn, contractVersion: TDCC_INVESTMENT_CONTRACT },
    },
    securities: securities.values(),
    holdings,
    transactions: [],
  });
}

/** One TR001 holding snapshot for one broker account, effective at lastServerTime. */
export function tdccSecuritiesHoldingCapture(
  input: CaptureInput & Readonly<{ positions: TdccPositions; account: TdccPositions["accounts"][number] }>,
): InvestmentValidatedCapture {
  return holdingCapture(input, input.account, input.account.holdings, {
    sourceField: "lastServerTime",
    lexeme: input.positions.lastServerTime,
    effectiveOn: input.positions.effectiveOn,
  });
}

/**
 * One TR051V1 holding snapshot for one fund account, effective at updateTime.
 * An account the response no longer lists holds nothing, so the caller passes
 * every fund account it has admitted before and each absent one commits an
 * empty snapshot.
 */
export function tdccFundHoldingCapture(
  input: CaptureInput & Readonly<{ funds: TdccFunds; account: TdccFundAccount }>,
): InvestmentValidatedCapture {
  const holdings = input.funds.accounts.find((candidate) => candidate.accountKey === input.account.accountKey)?.holdings ?? [];
  return holdingCapture(input, input.account, holdings, {
    sourceField: "updateTime",
    lexeme: input.funds.updateTime,
    effectiveOn: input.funds.effectiveOn,
  });
}

/**
 * One complete-range Passbook movement capture per broker account from every
 * TR002 page the client walked back to D0002, which is all history TDCC
 * holds. The range ends on the collection day in Asia/Taipei because no later
 * movement can exist yet, and starts at the oldest movement.
 */
export function tdccPassbookMovementCapture(
  input: CaptureInput & Readonly<{ account: TdccBrokerAccount; pages: readonly unknown[] }>,
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
      identity: identity(input, account),
      scope: { effectiveOn: endDate, complete: true, transactionHistory: { startDate, endDate, complete: true } },
      securities: securities.values(),
      holdings: [],
      transactions: [],
      passbookMovements: movements,
    });
}
