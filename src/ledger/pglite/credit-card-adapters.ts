import { createHash } from "node:crypto";
import type { CanonicalFinancialDepositCapture } from "../canonical/canonical-financial-deposit-writer.ts";
import type { CanonicalCreditCardPersistenceCapture } from "../canonical/canonical-credit-card-persistence.ts";
import type { FubonCreditCardValidatedCapture } from "../canonical/fubon-credit-card.ts";
import {
  sourceEvidenceFromCreditCardCurrentBalanceCapture,
  type CreditCardCurrentBalanceValidatedCapture,
} from "../canonical/credit-card-current-balance-admission.ts";
import type {
  PGliteCanonicalCreditCardBalanceCaptureRequest,
  PGliteCanonicalCreditCardCaptureRequest,
  PGliteCanonicalCreditCardIdentity,
} from "./credit-card.ts";
import {
  financialFactsFromCapture,
  financialSourceEvidenceFromCapture,
} from "./deposit.ts";

/** Keep provider admission and source ordering; translate only the writer seam. */
export function creditCardCommandRequestFromCanonicalCapture(
  spine: CanonicalFinancialDepositCapture,
  extension: CanonicalCreditCardPersistenceCapture,
): PGliteCanonicalCreditCardCaptureRequest {
  if (spine.identity.accountType !== "credit" || spine.identity.stream !== "credit-card")
    throw new Error("Credit-card adapter requires an admitted credit-card spine.");
  if (spine.captureId !== extension.captureId)
    throw new Error("Credit-card source and extension captures differ.");
  const sourceEvidence = financialSourceEvidenceFromCapture(spine);
  const providerRowCount = sourceEvidence.pages.reduce((sum, page) => sum + page.rowCount, 0);
  const statementEvidenceCount = sourceEvidence.records.length - providerRowCount;
  if (statementEvidenceCount < 0 || statementEvidenceCount !== (spine.nonTransactionRecords?.length ?? 0))
    throw new Error("Credit-card source page counts contradict statement evidence.");
  // The provider grid pages count transaction rows. Statement summaries are
  // separate source assertions, represented as an explicit derived page.
  const source = statementEvidenceCount === 0 ? sourceEvidence : {
    ...sourceEvidence,
    pages: [...sourceEvidence.pages, {
      pageOrdinal: sourceEvidence.pages.length,
      responseCode: "200" as const,
      terminal: true,
      rowCount: statementEvidenceCount,
      responseDigest: `sha256:${createHash("sha256").update(JSON.stringify(
        spine.nonTransactionRecords?.map((record) => [record.occurrenceKey, record.contentHash]),
      )).digest("base64url")}`,
      proofKind: "derived-statement-summary-evidence",
      contractFingerprint: sourceEvidence.scope.contractFingerprint,
      preflightFingerprint: sourceEvidence.scope.preflightFingerprint,
      metadata: { source: "statement-summary-evidence", providerPage: false },
    }],
  };
  const facts = financialFactsFromCapture(spine);
  const extensions = new Map(extension.transactions.map((transaction) => [
    transaction.sourceRecordKey,
    transaction,
  ]));
  if (extensions.size !== facts.length)
    throw new Error("Credit-card extension transaction count differs from the source capture.");
  const transactions = facts.map((fact) => {
    const transaction = extensions.get(fact.sourceOccurrenceKey);
    if (!transaction) throw new Error("Credit-card extension transaction lacks source evidence.");
    return {
      ...fact,
      instrumentKey: transaction.instrumentKey,
      billingStatus: transaction.billingStatus,
      consumeDate: transaction.consumeDate,
      postingDate: transaction.postingDate,
      effectiveDateBasis: transaction.effectiveDateBasis,
      statementKey: transaction.statementKey ?? null,
    };
  });
  return {
    capture: source,
    account: {
      sourceAccountKey: source.scope.sourceAccountKey ?? source.scope.accountNo ?? spine.identity.accountNo,
      accountType: "credit",
      currency: spine.identity.currency,
    },
    identity: {
      accountNaturalKey: extension.identity.accountNaturalKey,
      identityMethod: extension.identity.identityMethod,
    },
    instruments: extension.instruments.map((instrument) => ({
      instrumentKey: instrument.instrumentKey,
      cardMask: instrument.cardMask,
      role: instrument.role,
      lifecycle: instrument.lifecycle ?? null,
      evidenceSourceOccurrenceKey: instrument.evidence.sourceRecordKey,
    })),
    transactions,
    statements: extension.statements.map((statement) => ({
      statementKey: statement.statementKey,
      revisionKey: statement.revisionKey,
      cycleStart: statement.cycleStart,
      cycleEnd: statement.cycleEnd,
      issueDate: statement.issueDate,
      dueDate: statement.dueDate,
      currency: statement.currency,
      balance: statement.balance,
      minimumPayment: statement.minimumPayment,
      transactionSourceOccurrenceKeys: statement.transactionSourceKeys,
      evidenceSourceOccurrenceKey: statement.evidence.sourceRecordKey,
    })),
    relations: (extension.relations ?? []).map((relation) => ({
      kind: relation.kind,
      fromSourceOccurrenceKey: relation.fromSourceRecordKey,
      toSourceOccurrenceKey: relation.toSourceRecordKey,
      evidenceSourceOccurrenceKey: relation.evidence.sourceRecordKey,
    })),
  };
}

export function creditCardBalanceCommandRequest(
  capture: CreditCardCurrentBalanceValidatedCapture,
  identity: PGliteCanonicalCreditCardIdentity,
): PGliteCanonicalCreditCardBalanceCaptureRequest {
  if (capture.observations.length !== 1)
    throw new Error("Credit-card current balance capture must contain one observation.");
  const observation = capture.observations[0]!;
  return {
    capture: sourceEvidenceFromCreditCardCurrentBalanceCapture(capture),
    account: {
      sourceAccountKey: capture.identity.sourceAccountKey,
      accountType: "credit",
      currency: observation.currency,
    },
    identity,
    balance: {
      observation: {
        observationKey: observation.observationKey,
        balanceKind: observation.balanceKind,
        balance: observation.balance,
        currency: observation.currency,
        effectiveAt: observation.time.effectiveAt,
        effectiveTimeBasis: observation.time.effectiveTimeBasis,
        effectiveTimeRuleVersion: observation.time.effectiveTimeRuleVersion,
        evidenceSourceRecordKey: observation.sourceRecordKey,
        evidenceSourceField: observation.time.sourceField,
        evidenceSourceValue: observation.time.sourceValue,
        evidenceContractVersion: observation.time.contractVersion,
        sourceOccurrenceKey: observation.sourceRecordKey,
        evidenceEndpoint: capture.providerResponse.endpoint,
        evidenceResponseStatus: capture.providerResponse.status,
        evidenceCachePolicy: capture.providerResponse.cacheControl ?? "provider-contract",
      },
      estimate: observation.estimate,
    },
  };
}

export function fubonCreditCardCommandRequest(
  capture: FubonCreditCardValidatedCapture,
  spine: CanonicalFinancialDepositCapture,
): PGliteCanonicalCreditCardCaptureRequest {
  const sourceKeyByRecord = new Map(capture.transactions.map((transaction) => [
    transaction.sourceRecordKey, transaction.sourceKey,
  ]));
  const sourceKey = (recordKey: string): string => {
    const key = sourceKeyByRecord.get(recordKey);
    if (!key) throw new Error("Fubon card evidence references an unknown transaction.");
    return key;
  };
  const extension: CanonicalCreditCardPersistenceCapture = {
    integrationNamespace: "fubon",
    captureId: capture.captureId,
    identity: {
      accountNaturalKey: capture.identity.accountNaturalKey,
      identityMethod: capture.identity.identityMethod,
    },
    instruments: capture.instruments.map((instrument) => ({
      instrumentKey: instrument.instrumentKey,
      cardMask: instrument.cardMask,
      role: instrument.role,
      lifecycle: instrument.lifecycle,
      evidence: { sourceRecordKey: sourceKey(instrument.evidence?.sourceRecordKey ?? "") },
    })),
    transactions: capture.transactions.map((transaction) => ({
      sourceRecordKey: transaction.sourceKey,
      sourceKey: transaction.sourceKey,
      instrumentKey: transaction.instrumentKey,
      billingStatus: transaction.billingStatus,
      consumeDate: transaction.consumeDate,
      postingDate: transaction.postingDate,
      effectiveDateBasis: transaction.effectiveDateBasis,
      statementKey: transaction.statementKey ?? undefined,
    })),
    statements: capture.statements.map((statement) => ({
      statementKey: statement.statementKey,
      revisionKey: statement.revisionKey,
      cycleStart: statement.cycleStart,
      cycleEnd: statement.cycleEnd,
      issueDate: statement.issueDate,
      dueDate: statement.dueDate,
      currency: statement.currency,
      balance: statement.balance,
      minimumPayment: statement.minimumPayment,
      transactionSourceKeys: statement.transactionSourceKeys.map(sourceKey),
      evidence: statement.evidence,
    })),
    relations: capture.relations.map((relation) => {
      if (!("sourceRecordKey" in relation.evidence)
        || typeof relation.evidence.sourceRecordKey !== "string")
        throw new Error("Fubon card relation is missing source evidence.");
      return {
        kind: relation.kind,
        fromSourceRecordKey: sourceKey(relation.fromSourceRecordKey),
        toSourceRecordKey: sourceKey(relation.toSourceRecordKey),
        evidence: { sourceRecordKey: sourceKey(relation.evidence.sourceRecordKey) },
      };
    }),
  };
  const request = creditCardCommandRequestFromCanonicalCapture(spine, extension);
  return {
    ...request,
    reconcileLifecycle: "fubon",
    transactions: request.transactions.map((transaction) => ({
      ...transaction,
      sourceSequence: transaction.sourceOccurrenceKey,
    })),
  };
}
