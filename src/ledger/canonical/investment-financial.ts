import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createCanonicalSourceStore,
  validateCanonicalInvestmentExtensionSchema,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";

export const INVESTMENT_CANONICAL_CONTRACT_VERSION = "investment/canonical/v1" as const;
export type InvestmentSourceId = "yuanta-fund" | "yuanta-trade";
export const ADVERTISED_INVESTMENT_SOURCE_IDS = ["yuanta-fund", "yuanta-trade"] as const;
export type InvestmentExactAmount = { coefficient: string; scale: number };
export type InvestmentMoney = InvestmentExactAmount & { currency: string };

/** Reserved evidence envelope for the later debit↔purchase relation ticket.
 * It is persisted verbatim as provenance, but never admits a relation. */
export type InvestmentFundingEvidence =
  | { kind: "unresolved"; sourceRecordKey: string }
  | { kind: "source-linked-account"; sourceRecordKey: string; fundingAccountKey: string; sourceLinkageKey: string; contractVersion: string };

export type InvestmentCaptureInput = {
  captureId: string;
  sourceId: InvestmentSourceId;
  authorityRoute: string;
  contractVersion: string;
  observedAt: string;
  identity: { sourceConnectionKey: string; identityEpochKey: string; accountKey: string; accountType: "investment" };
  scope: { effectiveOn: string; complete: true };
  securities: Array<{ securityKey: string; producerSecurityId: string; name?: string; ticker?: string; currency: string }>;
  holdings: Array<{ measurementKey: string; correctionOfMeasurementKey?: string; sourceRecordKey: string; securityKey: string; quantity?: InvestmentExactAmount; valuation?: InvestmentMoney; effectiveOn: string; observedAt: string; lineage: { page: number; row: number; contractVersion: string } }>;
  transactions: Array<{ sourceRecordKey: string; transactionKey: string; securityKey: string; action: "buy" | "sell"; quantity: InvestmentExactAmount; cashEffect: InvestmentMoney; effectiveOn: string; fundingEvidence: InvestmentFundingEvidence }>;
  margin?: { kind: "embedded"; amount: InvestmentMoney; effectiveOn: string; sourceRecordKey: string } | { kind: "independent-account"; accountKey: string };
};
export type InvestmentValidatedCapture = InvestmentCaptureInput & { readonly __investmentValidated: true };
export type CanonicalInvestmentStore = CanonicalSourceStore;

const TOKEN = /^sha256:[A-Za-z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const VALIDATED = new WeakSet<object>();
function required(value: string, label: string): string { if (!value?.trim()) throw new Error(`${label} is required.`); return value.trim(); }
function token(value: string, label: string): string { if (!TOKEN.test(value)) throw new Error(`${label} must be an opaque token.`); return value; }
function date(value: string, label: string): string { if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${label} must be a calendar date.`); return value; }
function amount(value: InvestmentExactAmount, label: string): void { if (!value || !INTEGER.test(value.coefficient) || !Number.isSafeInteger(value.scale) || value.scale < 0) throw new Error(`${label} must be exact.`); }
function id(...parts: string[]): Buffer { return createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }

export class CanonicalInvestmentAdmissionError extends Error { constructor(message: string) { super(message); this.name = "CanonicalInvestmentAdmissionError"; } }

export function admitCanonicalInvestmentCapture(capture: InvestmentCaptureInput): InvestmentValidatedCapture {
  required(capture.captureId, "Capture ID");
  if (!ADVERTISED_INVESTMENT_SOURCE_IDS.includes(capture.sourceId)) throw new CanonicalInvestmentAdmissionError("Investment source is not advertised.");
  required(capture.authorityRoute, "Authority route"); required(capture.contractVersion, "Contract version");
  if (!Number.isFinite(Date.parse(capture.observedAt))) throw new CanonicalInvestmentAdmissionError("Observation time must be RFC3339.");
  token(capture.identity.sourceConnectionKey, "Source connection key"); token(capture.identity.identityEpochKey, "Identity epoch key"); token(capture.identity.accountKey, "Account key");
  const effectiveOn = date(capture.scope.effectiveOn, "Scope effective time");
  const observedDate = capture.observedAt.slice(0, 10);
  if (effectiveOn === observedDate) throw new CanonicalInvestmentAdmissionError("Holding requires contract-established effective time; import time cannot be substituted.");
  const securityKeys = new Set<string>();
  for (const security of capture.securities) {
    required(security.producerSecurityId, "Producer security ID");
    if (!security.securityKey.startsWith(`${capture.sourceId}:`) || security.securityKey === security.name || security.securityKey === security.ticker) throw new CanonicalInvestmentAdmissionError("Security identity must use a producer-scoped key, not name or ticker.");
    if (securityKeys.has(security.securityKey)) throw new CanonicalInvestmentAdmissionError("Duplicate security key.");
    securityKeys.add(security.securityKey); required(security.currency, "Security currency");
  }
  const measurements = new Set(capture.holdings.map((holding) => holding.measurementKey));
  for (const holding of capture.holdings) {
    token(holding.measurementKey, "Measurement key"); token(holding.sourceRecordKey, "Holding source record key");
    if (!securityKeys.has(holding.securityKey)) throw new CanonicalInvestmentAdmissionError("Holding security is not captured.");
    if (!holding.quantity && !holding.valuation) throw new CanonicalInvestmentAdmissionError("Holding requires quantity or valuation.");
    if (holding.quantity) amount(holding.quantity, "Holding quantity"); if (holding.valuation) amount(holding.valuation, "Holding valuation");
    if (date(holding.effectiveOn, "Holding effective time") === observedDate) throw new CanonicalInvestmentAdmissionError("Holding requires contract-established effective time; import time cannot be substituted.");
    if (holding.effectiveOn !== effectiveOn || holding.observedAt !== capture.observedAt || holding.lineage.contractVersion !== capture.contractVersion) throw new CanonicalInvestmentAdmissionError("Holding effective/observation time and lineage must match the capture contract.");
    if (holding.correctionOfMeasurementKey && !measurements.has(holding.correctionOfMeasurementKey)) throw new CanonicalInvestmentAdmissionError("Holding correction target requires an explicit stable correction key in captured evidence.");
  }
  for (const transaction of capture.transactions) {
    if (transaction.action !== "buy" && transaction.action !== "sell") throw new CanonicalInvestmentAdmissionError("Investment transaction action must be buy or sell; ambiguous action is rejected.");
    token(transaction.sourceRecordKey, "Transaction source record key"); token(transaction.transactionKey, "Transaction key");
    if (!securityKeys.has(transaction.securityKey)) throw new CanonicalInvestmentAdmissionError("Transaction security is not captured.");
    amount(transaction.quantity, "Transaction quantity"); amount(transaction.cashEffect, "Transaction cash effect"); date(transaction.effectiveOn, "Transaction effective time");
    if (transaction.fundingEvidence.kind === "unresolved") token(transaction.fundingEvidence.sourceRecordKey, "Funding evidence source record key");
  }
  if (capture.margin?.kind === "embedded") { amount(capture.margin.amount, "Margin debt"); token(capture.margin.sourceRecordKey, "Margin source record key"); date(capture.margin.effectiveOn, "Margin effective time"); }
  freeze(capture); VALIDATED.add(capture); return capture as InvestmentValidatedCapture;
}

export function createCanonicalInvestmentStore(path: string): CanonicalInvestmentStore { const store = createCanonicalSourceStore(path); validateCanonicalInvestmentExtensionSchema(store.db); return store; }
function nextSequence(db: DatabaseSync): number { return Number((db.prepare("SELECT COALESCE(MAX(commit_sequence),0)+1 AS n FROM investment_captures").get() as { n: number }).n); }
function nextClock(store: CanonicalSourceStore): number { const latest = Number((store.db.prepare("SELECT COALESCE(MAX(recorded_at_utc_us),0) AS n FROM investment_captures").get() as { n: number }).n); return Math.max(store.commitClock(), latest + 1); }

export async function commitCanonicalInvestmentCapture(store: CanonicalInvestmentStore, capture: InvestmentValidatedCapture): Promise<{ status: "committed"; captureId: string; commitSequence: number }> {
  if (!VALIDATED.has(capture)) throw new CanonicalInvestmentAdmissionError("Investment capture must be admitted before commit.");
  const db = store.db; db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT 1 FROM investment_captures WHERE capture_id=?").get(capture.captureId);
    if (existing) { db.exec("ROLLBACK"); throw new CanonicalInvestmentAdmissionError("Investment capture ID already exists."); }
    const sequence = nextSequence(db);
    db.prepare("INSERT INTO investment_captures VALUES(?,?,?,?,?,?,?,?,?,?)").run(capture.captureId, capture.sourceId, capture.identity.sourceConnectionKey, capture.identity.identityEpochKey, capture.authorityRoute, capture.contractVersion, capture.observedAt, capture.scope.effectiveOn, sequence, nextClock(store));
    const accountId = id("investment-account", capture.sourceId, capture.identity.sourceConnectionKey, capture.identity.accountKey);
    db.prepare("INSERT OR IGNORE INTO investment_accounts VALUES(?,?,?,?,?)").run(accountId, capture.sourceId, capture.identity.sourceConnectionKey, capture.identity.accountKey, "investment");
    for (const security of capture.securities) db.prepare("INSERT INTO investment_securities VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,security_key) DO UPDATE SET producer_security_id=excluded.producer_security_id,name=excluded.name,ticker=excluded.ticker,currency=excluded.currency").run(id("security", capture.sourceId, security.securityKey), capture.sourceId, security.securityKey, security.producerSecurityId, security.name ?? null, security.ticker ?? null, security.currency);
    for (const holding of capture.holdings) db.prepare("INSERT INTO investment_holding_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id("holding", capture.captureId, holding.measurementKey), capture.captureId, accountId, id("security", capture.sourceId, holding.securityKey), holding.measurementKey, holding.correctionOfMeasurementKey ?? null, holding.sourceRecordKey, holding.quantity?.coefficient ?? null, holding.quantity?.scale ?? null, holding.valuation?.coefficient ?? null, holding.valuation?.scale ?? null, holding.valuation?.currency ?? null, holding.effectiveOn, holding.observedAt, JSON.stringify(holding.lineage));
    for (const transaction of capture.transactions) db.prepare("INSERT INTO investment_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id("investment-transaction", capture.captureId, transaction.transactionKey), capture.captureId, accountId, id("security", capture.sourceId, transaction.securityKey), transaction.transactionKey, transaction.sourceRecordKey, transaction.action, transaction.quantity.coefficient, transaction.quantity.scale, transaction.cashEffect.coefficient, transaction.cashEffect.scale, transaction.cashEffect.currency, transaction.effectiveOn, JSON.stringify(transaction.fundingEvidence));
    if (capture.margin?.kind === "embedded") db.prepare("INSERT INTO investment_margin_balance_observations VALUES(?,?,?,?,?,?,?,?,?)").run(id("margin", capture.captureId, capture.margin.sourceRecordKey), capture.captureId, accountId, capture.margin.sourceRecordKey, "margin_loan", capture.margin.amount.coefficient, capture.margin.amount.scale, capture.margin.amount.currency, capture.margin.effectiveOn);
    db.exec("COMMIT"); return { status: "committed", captureId: capture.captureId, commitSequence: sequence };
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}

export function queryCanonicalInvestmentCurrent(store: CanonicalInvestmentStore, sourceConnectionKey: string) {
  token(sourceConnectionKey, "Source connection key");
  const accounts = store.db.prepare("SELECT source_id AS sourceId,source_connection_key AS sourceConnectionKey,account_key AS accountKey,account_type AS accountType FROM investment_accounts WHERE source_connection_key=? ORDER BY source_id,account_key").all(sourceConnectionKey);
  const securities = store.db.prepare("SELECT DISTINCT s.source_id AS sourceId,s.security_key AS securityKey,s.producer_security_id AS producerSecurityId,s.name,s.ticker,s.currency FROM investment_securities s JOIN investment_holding_observations h ON h.security_id=s.security_id JOIN investment_accounts a ON a.account_id=h.account_id WHERE a.source_connection_key=? ORDER BY s.security_key").all(sourceConnectionKey);
  const holdings = store.db.prepare("SELECT h.measurement_key AS measurementKey,h.correction_of_measurement_key AS correctionOfMeasurementKey,h.source_record_key AS sourceRecordKey,h.quantity_coefficient AS quantityCoefficient,h.quantity_scale AS quantityScale,h.valuation_coefficient AS valuationCoefficient,h.valuation_scale AS valuationScale,h.valuation_currency AS valuationCurrency,h.effective_on AS effectiveOn,h.observed_at AS observedAt,h.lineage_json AS lineageJson FROM investment_holding_observations h JOIN investment_accounts a ON a.account_id=h.account_id WHERE a.source_connection_key=? ORDER BY h.observed_at,h.measurement_key").all(sourceConnectionKey);
  const transactionRows = store.db.prepare("SELECT t.transaction_key AS transactionKey,t.source_record_key AS sourceRecordKey,t.action,t.effective_on AS effectiveOn,t.funding_evidence_json AS fundingEvidenceJson FROM investment_transactions t JOIN investment_accounts a ON a.account_id=t.account_id WHERE a.source_connection_key=? ORDER BY t.effective_on,t.transaction_key").all(sourceConnectionKey) as Array<{ transactionKey: string; sourceRecordKey: string; action: "buy" | "sell"; effectiveOn: string; fundingEvidenceJson: string }>;
  const transactions = transactionRows.map(({ fundingEvidenceJson, ...row }) => ({ ...row, fundingEvidence: JSON.parse(fundingEvidenceJson) as InvestmentFundingEvidence }));
  const marginBalances = store.db.prepare("SELECT m.source_record_key AS sourceRecordKey,m.balance_kind AS balanceKind,m.coefficient,m.scale,m.currency,m.effective_on AS effectiveOn FROM investment_margin_balance_observations m JOIN investment_accounts a ON a.account_id=m.account_id WHERE a.source_connection_key=? ORDER BY m.effective_on").all(sourceConnectionKey);
  return { accounts, securities, holdings, transactions, marginBalances, relations: [] as never[] };
}
