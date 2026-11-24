/**
 * Synthetic re-syncs for the growth check and the compaction planner check.
 * Each mode commits `records` rows again and again, each time under a new
 * capture id and a window that starts and ends a day later, as a collection
 * window does, so the oldest rows age out.
 *
 * `deposit` and `card-route` go through the generic commit; `card-route` uses
 * a credit-card route and bucket coverage, one bucket per day so a day leaves
 * the inventory with the window. `card-command` drives the credit-card
 * command on the same records, with an instrument, statements and each
 * purchase's card details and lifecycle. `einvoice`, `investment` and `loan`
 * drive those domain commands on records in the same moving window:
 * invoices; investment transactions with named securities and two holdings;
 * loan payments with three repayment deposits linked to them.
 *
 * With `reuseSourceRecords: false` every record is stored again, as before
 * ADR 0152, through the reuse check's "any" arm.
 */
import { createHash } from "node:crypto";
import { assignOccurrenceSlots } from "../canonical/occurrence-groups.ts";
import { encodeCreditCardQueryBucket } from "../canonical/credit-card-query-inventory.ts";
import {
  admitPGliteCanonicalFinancialCaptureInTransaction,
  commitPGliteCanonicalFinancialCapture,
  refreshPGliteAdmittedFinancialProjection,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import {
  commitPGliteCanonicalCreditCardCapture,
  type PGliteCanonicalCreditCardCaptureRequest,
  type PGliteCanonicalCreditCardStatement,
} from "./credit-card.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
  PGLITE_EINVOICE_CONTRACT_VERSION,
  PGLITE_EINVOICE_CURRENCY_AUTHORITY,
  PGLITE_EINVOICE_ROUTE,
} from "./einvoice.ts";
import { commitPGliteCanonicalInvestmentCapture, type PGliteCanonicalInvestmentCommitRequest } from "./investment.ts";
import { commitPGliteCanonicalLoanCapture, type PGliteCanonicalLoanCommitRequest } from "./loan.ts";
import type { CanonicalEInvoiceCaptureInput } from "../canonical/einvoice-contract.ts";
import { canonicalLoanOccurrenceScopeKey } from "../canonical/loan-admission.ts";
import type { PGliteStore } from "./transaction.ts";

export const RESYNC_MODES = ["deposit", "card-route", "card-command", "einvoice", "investment", "loan"] as const;
export type ResyncMode = (typeof RESYNC_MODES)[number];
type Mode = ResyncMode;

const token = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);

/**
 * One bucket per day. The credit-card command reads its buckets, so it gets
 * a statement bucket for the day, which promises Billed Monotonicity (ADR 0062).
 */
const bucketKey = (mode: Mode, date: string): string =>
  mode === "card-command" ? encodeCreditCardQueryBucket({ kind: "statement", period: date }) : date;

/** One complete bounded capture of the `rowCount` synthetic rows inside the window, which moves a day per sync. */
function capture(rowCount: number, mode: Mode, sync: number): PGliteCanonicalFinancialCommitRequest {
  const captureId = `${mode}-capture-${sync}`;
  const startDate = day(sync - 1);
  const endDate = day(180 + sync);
  const card = mode !== "deposit";
  const scopeKey = token("scope");
  const routeKey = card ? "fubon/credit-card/human-attested-v2" : "fubon/domestic-deposit/human-attested-v1";
  const contractVersion = card ? routeKey : "human-attested-v1";
  // Every tenth row repeats the one before it, so some occurrence groups have two members.
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    index,
    date: day((index % 10 === 9 ? index - 1 : index) % 180),
    fingerprint: token(`row-${index % 10 === 9 ? index - 1 : index}`),
  })).filter((row) => row.date >= startDate).map((row) => ({ ...row, bucketKey: card ? bucketKey(mode, row.date) : undefined }));
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => row.fingerprint,
    partitionDate: (row) => row.date,
  });
  const records = slots.map(({ row, occurrenceKey, collisionKey, group }) => ({
    occurrenceKey,
    collisionKey,
    sequenceLexeme: `${row.date}/${row.fingerprint}/${group.ordinal}`,
    providerKey: "human-attested:no-provider-key",
    contentHash: token(JSON.stringify([row.date, row.fingerprint])),
    compact: {
      amount: { coefficient: String(1000 + row.index), scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postedOn: row.date,
      description: `SYNTHETIC MERCHANT ${row.index}`,
      balance: { coefficient: String(500_000 - row.index), scale: 0 },
    },
    occurrenceGroup: group,
    ...(row.bucketKey === undefined ? {} : { occurrenceGroupBucketKey: row.bucketKey }),
  }));
  const bucketKeys = card ? [...new Set(rows.map((row) => row.bucketKey!))] : undefined;
  return {
    capture: {
      captureId,
      integrationNamespace: "fubon",
      sourceConnectionKey: token("connection"),
      identityEpoch: token("epoch"),
      stream: card ? "credit-card" : "domestic-deposit",
      recordKind: card ? "fubon-credit-card-transaction" : "fubon-domestic-deposit",
      routeKey,
      contractVersion,
      subjectDigest: token("subject"),
      observedAt: "2026-09-30T00:00:00.000Z",
      accountNumber: {
        value: "123456",
        kind: card ? "credit-portfolio-account" : "depository-account",
        evidenceVersion: "synthetic-v1",
        sourceField: "accountNumber",
      },
      scope: {
        startDate,
        endDate,
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: "full-bounded-range",
        ruleVersion: routeKey,
        sourceAccountKey: "checking-account",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { pageCount: 1 } }],
      records,
      occurrenceGroupCoverage: [{
        scopeKey,
        startDate,
        endDate,
        contractVersion,
        ...(bucketKeys ? { bucketKeys } : {}),
      }],
    },
    account: {
      sourceAccountKey: "checking-account",
      accountNo: "123456",
      accountType: card ? "credit" : "depository",
      currency: "TWD",
    },
    transactions: slots.map(({ row, occurrenceKey, group }) => ({
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: `${row.date}-${row.fingerprint}-${group.ordinal}`,
      amount: { coefficient: String(1000 + row.index), scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: routeKey,
      description: `SYNTHETIC MERCHANT ${row.index}`,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: routeKey,
      effectiveOn: row.date,
      transactionDateTimeLocal: `${row.date}T00:00:00+08:00`,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: routeKey,
      utcInstantUtcUs: Date.parse(`${row.date}T00:00:00.000+08:00`) * 1000,
    })),
    withdrawalPolicy: "never-infer",
  };
}

/** Days a statement spans; a statement is listed while the window holds all of its days. */
const STATEMENT_DAYS = 10;

/**
 * The same capture through the credit-card command: one instrument, every
 * purchase billed on the statement of its ten-day block, and that statement's
 * summary. A statement whose first day the window has passed is no longer
 * listed, as its members leave the window with it.
 */
function cardCommandCapture(rowCount: number, sync: number): PGliteCanonicalCreditCardCaptureRequest {
  const generic = capture(rowCount, "card-command", sync);
  const instrumentOccurrence = token("instrument");
  const firstDay = Date.UTC(2026, 0, 1);
  const statementKeyOf = (date: string) =>
    `statement-${Math.floor((Date.parse(`${date}T00:00:00Z`) - firstDay) / 86_400_000 / STATEMENT_DAYS)}`;
  const factDates = new Map(generic.transactions.map((fact) => [fact.sourceOccurrenceKey, fact.effectiveOn]));
  const members = new Map<string, string[]>();
  for (const fact of generic.transactions) {
    const key = statementKeyOf(fact.effectiveOn);
    members.set(key, [...(members.get(key) ?? []), fact.sourceOccurrenceKey]);
  }
  const statements: PGliteCanonicalCreditCardStatement[] = [...members]
    .filter(([key]) => {
      const block = Number(key.slice("statement-".length));
      return day(block * STATEMENT_DAYS) >= generic.capture.scope.startDate;
    })
    .map(([statementKey, occurrences]) => ({
      statementKey,
      revisionKey: `${statementKey}-revision-1`,
      cycleStart: factDates.get(occurrences[0]!)!,
      cycleEnd: factDates.get(occurrences.at(-1)!)!,
      issueDate: factDates.get(occurrences.at(-1)!)!,
      dueDate: factDates.get(occurrences.at(-1)!)!,
      currency: "TWD",
      balance: { coefficient: String(occurrences.length * 1000), scale: 0 },
      minimumPayment: { coefficient: "100", scale: 0 },
      transactionSourceOccurrenceKeys: occurrences,
      evidenceSourceOccurrenceKey: token(statementKey),
    }));
  const records = [
        ...generic.capture.records,
        {
          occurrenceKey: instrumentOccurrence,
          providerKey: token("instrument-provider"),
          contentHash: token("instrument-content"),
          compact: { kind: "instrument", instrumentKey: "primary" },
        },
        ...statements.map((statement) => ({
          occurrenceKey: statement.evidenceSourceOccurrenceKey,
          providerKey: token(`${statement.statementKey}-provider`),
          contentHash: token(`${statement.statementKey}-content`),
          compact: { kind: "statement", statementKey: statement.statementKey },
        })),
  ];
  return {
    capture: {
      ...generic.capture,
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { pageCount: 1 } }],
      records,
    },
    account: generic.account,
    identity: { accountNaturalKey: token("card-account"), identityMethod: "opaque-provider-account" },
    instruments: [{ instrumentKey: "primary", cardMask: "****4281", role: "primary", lifecycle: "active", evidenceSourceOccurrenceKey: instrumentOccurrence }],
    transactions: generic.transactions.map((fact) => ({
      ...fact,
      instrumentKey: "primary",
      billingStatus: "billed" as const,
      consumeDate: fact.effectiveOn,
      postingDate: fact.effectiveOn,
      effectiveDateBasis: "consume-date" as const,
      statementKey: statementKeyOf(fact.effectiveOn),
    })),
    statements,
  };
}

/** The synthetic rows inside a sync's window: one a day over 180 days, oldest first. */
function windowRows(rowCount: number, sync: number): readonly Readonly<{ index: number; date: string }>[] {
  const startDate = day(sync - 1);
  return Array.from({ length: rowCount }, (_, index) => ({ index, date: day(index % 180) }))
    .filter((row) => row.date >= startDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
}

const window = (sync: number) => ({ startDate: day(sync - 1), endDate: day(180 + sync) });

/** The invoices inside the window, one issued revision each. */
function einvoiceCapture(rowCount: number, sync: number): CanonicalEInvoiceCaptureInput {
  const money = (coefficient: string) => ({ coefficient, scale: 0, currency: "TWD" as const, currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY });
  const invoices = windowRows(rowCount, sync).map(({ index, date }) => ({
    stableInvoiceKey: `AB${String(10_000_000 + index)}:${date}`,
    sourceRevisionKey: `invoice-${index}-revision-1`,
    revisionNumber: 1,
    revisionKind: "issued" as const,
    sourceIdentifiers: { invoiceNumber: `AB${String(10_000_000 + index)}`, randomNumber: "2468" },
    seller: { taxId: "12345678", name: `SYNTHETIC SELLER ${index % 10}` },
    total: money(String(100 + index)),
    occurrence: { value: date, precision: "date" as const, timeZone: "Asia/Taipei", origin: "source-reported" as const },
    items: [{
      sequence: 1,
      completeness: "complete" as const,
      name: `SYNTHETIC ITEM ${index}`,
      quantity: { coefficient: "1", scale: 0 },
      unitPrice: money(String(100 + index)),
      amount: money(String(100 + index)),
    }],
    authority: { routeKey: PGLITE_EINVOICE_ROUTE, contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION },
    provenance: { kind: "provider-record" as const, reference: `provider/invoice/${index}`, sourceField: "invoiceList" },
    revocationReason: null,
  }));
  return {
    captureId: `einvoice-capture-${sync}`,
    sourceConnectionKey: token("einvoice-connection"),
    identityEpoch: token("einvoice-epoch"),
    subjectDigest: token("einvoice-subject"),
    observedAt: "2026-09-30T00:00:00Z",
    scope: {
      ...window(sync),
      kind: "bounded-range",
      completeness: "complete-range",
      invoiceCompleteness: "complete",
      itemCompleteness: "complete",
      absenceAuthority: "comparable-complete-range",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: invoices.length, terminal: true, metadata: { pageCount: 1 } }],
    invoices,
  };
}

const INVESTMENT_CONTRACT = "yuanta-fund/investment/canonical-v1";
const INVESTMENT_SECURITIES = 5;

/**
 * Investment transactions inside the window, over five securities, each
 * named by its latest transaction, and a holding in each of the first two
 * securities. A holding is a measurement as of the collection date, which
 * moves with the window, so its record and observation are new each sync
 * (ADR 0008).
 */
function investmentCapture(rowCount: number, sync: number): PGliteCanonicalInvestmentCommitRequest {
  const { startDate, endDate } = window(sync);
  const scopeKey = token("investment-transaction-scope");
  const observedAt = `${endDate}T01:00:00.000Z`;
  const rows = windowRows(rowCount, sync);
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => token(`investment-row-${row.index}`),
    partitionDate: (row) => row.date,
  });
  const securityKey = (index: number) => `yuanta-fund:FUND${index % INVESTMENT_SECURITIES}`;
  const transactions = slots.map(({ row, occurrenceKey, group }) => ({
    sourceRecordKey: occurrenceKey,
    occurrenceGroup: group,
    transactionKey: token(`investment-transaction-${row.index}`),
    securityKey: securityKey(row.index),
    action: "buy" as const,
    quantity: { coefficient: "5", scale: 0 },
    cashEffect: { coefficient: String(1000 + row.index), scale: 0, currency: "TWD" },
    effectiveOn: row.date,
    description: `SYNTHETIC FUND BUY ${row.index}`,
    fundingEvidence: { kind: "unresolved" as const, sourceRecordKey: occurrenceKey },
  }));
  const holdings = [0, 1].map((security) => {
    const sourceRecordKey = token(`investment-holding-${security}-${endDate}`);
    return {
      measurementKey: token(`investment-holding-measurement-${sync}-${security}`),
      measurementSubjectKey: token(`investment-holding-subject-${security}-${endDate}`),
      sourceRecordKey,
      securityKey: securityKey(security),
      quantity: { coefficient: "50", scale: 0 },
      valuation: { coefficient: "12500", scale: 0, currency: "TWD" },
      effectiveOn: endDate,
      observedAt,
      effectiveTimeEvidence: { kind: "source-reported-as-of" as const, sourceRecordKey, sourceField: "asOfDate", value: endDate, contractVersion: INVESTMENT_CONTRACT },
      lineage: { page: 1, row: security + 1, contractVersion: INVESTMENT_CONTRACT },
    };
  });
  const securities = Array.from({ length: INVESTMENT_SECURITIES }, (_, security) => ({
    securityKey: securityKey(security),
    producerSecurityId: `FUND${security}`,
    name: `Synthetic Fund ${security}`,
    currency: "TWD",
    securityType: "mutual_fund" as const,
    identityEvidence: { kind: "producer-security-id" as const, contractVersion: INVESTMENT_CONTRACT },
    nameEvidence: {
      contractVersion: "yuanta-fund/security-name/source-reported-v1",
      sourceRecordKey: transactions.findLast((transaction) => transaction.securityKey === securityKey(security))!.sourceRecordKey,
    },
  }));
  return {
    capture: {
      captureId: `investment-capture-${sync}`,
      sourceId: "yuanta-fund",
      authorityRoute: INVESTMENT_CONTRACT,
      contractVersion: INVESTMENT_CONTRACT,
      observedAt,
      identity: {
        sourceConnectionKey: token("investment-connection"),
        identityEpochKey: token("investment-epoch"),
        accountKey: token("investment-account"),
        accountType: "investment",
        reportingCurrency: "TWD",
      },
      scope: { effectiveOn: endDate, complete: true, transactionHistory: { startDate, endDate, complete: true } },
      occurrenceGroupCoverage: [{ scopeKey, startDate, endDate, contractVersion: INVESTMENT_CONTRACT }],
      securities,
      holdings,
      transactions,
    },
  };
}

const LOAN_CONTRACT = "loan/canonical/v2.fubon";
const COUNTERPART_CONTRACT = "loan/counterpart/v1.fubon";
const LOAN_COUNTERPARTS = 3;

/**
 * Loan payments inside the window. The three latest are repaid from a
 * deposit account, each through its own counterpart capture and a relation
 * whose evidence is the deposit record. Each payment takes its position in
 * the window as its source sequence index, as the Fubon and Yuanta adapters
 * do, so a row that ages out renumbers the rows after it.
 */
function loanCapture(rowCount: number, sync: number): PGliteCanonicalLoanCommitRequest {
  const { startDate, endDate } = window(sync);
  const accountKey = token("loan-account");
  const scopeKey = canonicalLoanOccurrenceScopeKey("fubon", accountKey);
  const rows = windowRows(rowCount, sync);
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => token(`loan-row-${row.index}`),
    partitionDate: (row) => row.date,
  });
  const records = slots.map(({ row, occurrenceKey, group }, position) => ({
    sourceRecordKey: occurrenceKey,
    occurrenceIndex: group.ordinal,
    sourceSequenceIndex: position + 1,
    occurrenceGroup: group,
    occurrenceCollisionKey: token(`loan-collision-${row.index}`),
    effectiveOn: row.date,
    sourceTime: { localTime: "12:00:00", precision: "second" as const, timeOrigin: "source_reported" as const },
    postingStatus: "posted" as const,
    eventKind: "payment" as const,
    eventEvidence: { kind: "source-coded-loan-event" as const, sourceRecordKey: occurrenceKey, sourceCode: "LOAN-PAYMENT", contractVersion: LOAN_CONTRACT },
    direction: "inflow" as const,
    amount: { coefficient: String(1000 + row.index), scale: 0 },
    currency: "TWD" as const,
    description: `SYNTHETIC LOAN PAYMENT ${row.index}`,
  }));
  const repaid = records.slice(-LOAN_COUNTERPARTS);
  const counterpartAccountKey = token("loan-repayment-account");
  const counterpartTransactions = repaid.map((record, index) => {
    const sourceRecordKey = token(`loan-counterpart-${record.sourceRecordKey}`);
    return {
      captureId: `loan-counterpart-capture-${sync}-${index}`,
      sourceRecordKey,
      occurrenceIndex: 1,
      sourceConnectionKey: token("loan-connection"),
      identityEpochKey: token("loan-epoch"),
      accountKey: counterpartAccountKey,
      subjectDigest: token("loan-counterpart-subject"),
      accountNo: token("loan-counterpart-number"),
      accountType: "depository" as const,
      stream: "domestic-deposit" as const,
      recordKind: "fubon-loan-counterpart-deposit",
      authorityRoute: "fubon/loan/counterpart-deposit-v1",
      contractVersion: COUNTERPART_CONTRACT,
      effectiveOn: record.effectiveOn,
      sourceTime: record.sourceTime,
      postingStatus: "posted" as const,
      direction: "outflow" as const,
      amount: record.amount,
      currency: "TWD" as const,
      description: "SYNTHETIC REPAYMENT",
      sourceEvidence: { kind: "source-linked-counterpart" as const, sourceRecordKey, relationId: token(`loan-relation-${sourceRecordKey}`), contractVersion: COUNTERPART_CONTRACT },
    };
  });
  return {
    capture: {
      captureId: `loan-capture-${sync}`,
      sourceId: "fubon",
      authorityRoute: "fubon/loan/canonical-v2",
      contractVersion: LOAN_CONTRACT,
      identity: {
        sourceConnectionKey: token("loan-connection"),
        identityEpochKey: token("loan-epoch"),
        accountKey,
        subjectDigest: token("loan-subject"),
        accountType: "loan",
        accountNo: token("loan-display-identity"),
        stream: "loan",
        recordKind: "fubon-loan-transaction",
        currency: "TWD",
      },
      observedAt: "2026-09-30T00:00:00.000Z",
      scope: {
        startDate,
        endDate,
        completeness: "complete-range",
        completenessBasis: "source-declared-terminal-range",
        completenessRuleVersion: LOAN_CONTRACT,
        pageCount: 1,
        terminal: true,
      },
      semantics: { status: "posted", effectiveTimeBasis: "source-reported", effectiveTimeRuleVersion: LOAN_CONTRACT, timeZone: "Asia/Taipei" },
      pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: records.length, proofKind: "source-declared-terminal-range" }],
      occurrenceGroupCoverage: [{ scopeKey, startDate, endDate, contractVersion: LOAN_CONTRACT }],
      records,
      counterpartTransactions,
      balanceObservations: [],
      relations: repaid.map((record, index) => ({
        kind: "transfer_counterpart" as const,
        fromSourceRecordKey: record.sourceRecordKey,
        toSourceRecordKey: counterpartTransactions[index]!.sourceRecordKey,
        fromAccountKey: accountKey,
        toAccountKey: counterpartAccountKey,
        fromDirection: "inflow" as const,
        toDirection: "outflow" as const,
        evidence: {
          kind: "explicit-source-linkage" as const,
          sourceRecordKey: counterpartTransactions[index]!.sourceRecordKey,
          relationId: counterpartTransactions[index]!.sourceEvidence.relationId,
          contractVersion: LOAN_CONTRACT,
        },
      })),
      relationCoverage: "source-linked-complete",
    },
  };
}

export type ResyncOptions = Readonly<{
  /** Synthetic rows before the window starts moving; at least 20. */
  rowCount: number;
  /** `false` stores every record again, as before ADR 0152. */
  reuseSourceRecords?: false;
}>;

/** Commit sync number `sync` of `mode`, the first being 1. */
export async function commitResync(store: PGliteStore, mode: ResyncMode, sync: number, options: ResyncOptions): Promise<void> {
  const { rowCount } = options;
  const domain = options.reuseSourceRecords === false ? { reuseSourceRecords: false as const } : {};
  switch (mode) {
    case "card-command": await commitPGliteCanonicalCreditCardCapture(store, cardCommandCapture(rowCount, sync), domain); return;
    case "einvoice": await commitPGliteCanonicalEInvoiceCapture(store, einvoiceCapture(rowCount, sync), domain); return;
    case "investment": await commitPGliteCanonicalInvestmentCapture(store, investmentCapture(rowCount, sync), domain); return;
    case "loan": await commitPGliteCanonicalLoanCapture(store, loanCapture(rowCount, sync), domain); return;
    case "deposit":
    case "card-route": {
      const request = capture(rowCount, mode, sync);
      if (options.reuseSourceRecords !== false) {
        await commitPGliteCanonicalFinancialCapture(store, request);
        return;
      }
      await store.transaction(async (transaction) => {
        const admitted = await admitPGliteCanonicalFinancialCaptureInTransaction(transaction, request, {}, "any");
        await refreshPGliteAdmittedFinancialProjection(transaction, [admitted], {});
      });
    }
  }
}

