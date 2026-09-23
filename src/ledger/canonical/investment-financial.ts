import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  admitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialNonTransactionRecord,
} from "./canonical-financial-deposit-writer.ts";
import { commitCanonicalFinancialAdmission } from "./canonical-financial-admission.ts";
import { runCanonicalInvestmentRelationFollowThrough } from "./canonical-relation-followthrough.ts";
import {
  createCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  validateCanonicalInvestmentExtensionSchema,
  validateCanonicalInvestmentFundingRelationSchema,
} from "./canonical-database.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { queryCanonicalInvestmentFundingRelationsInSnapshot } from "./investment-funding-relations.ts";
import {
  CanonicalInvestmentAdmissionError,
  isInvestmentCaptureValidated,
} from "./investment-financial-admission.ts";
import type {
  InvestmentCaptureInput,
  InvestmentFundingEvidence,
  InvestmentMoney,
  InvestmentTransactionAction,
  InvestmentValidatedCapture,
} from "./investment-financial-admission.ts";
import {
  admitCanonicalLoanCapture,
  canonicalLoanCaptureSpines,
  persistCanonicalLoanCaptureExtensions,
  type LoanValidatedCapture,
} from "./loan-financial.ts";

export {
  ADVERTISED_INVESTMENT_SOURCE_IDS,
  admitCanonicalInvestmentCapture,
  CanonicalInvestmentAdmissionError,
  deriveInvestmentHoldingCorrectionProofKey,
  INVESTMENT_CANONICAL_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION,
} from "./investment-financial-admission.ts";
export type {
  HoldingEffectiveTimeEvidence,
  InvestmentCaptureInput,
  InvestmentExactAmount,
  InvestmentFundingEvidence,
  InvestmentMoney,
  InvestmentSecurityType,
  InvestmentSourceId,
  InvestmentTransactionAction,
  InvestmentValidatedCapture,
} from "./investment-financial-admission.ts";
export type CanonicalInvestmentStore = CanonicalSourceStore;

const TOKEN = /^sha256:[A-Za-z0-9_-]+$/;
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function token(value: string, label: string) {
  if (!TOKEN.test(value))
    throw new CanonicalInvestmentAdmissionError(
      `${label} must be an opaque token.`,
    );
  return value;
}

function stableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(normalize)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, normalize(child)]),
          )
        : entry;
  return JSON.stringify(normalize(value));
}

function digest(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;
}

function uuidV7(): Buffer {
  const bytes = randomBytes(16);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1)
    bytes[i] = Number((now >> BigInt(40 - i * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

function sourceRecordEnvelope(
  capture: InvestmentCaptureInput,
  record: { sourceRecordKey: string; description?: string | null },
  compact: Record<string, unknown>,
  index: number,
) {
  return {
    occurrenceKey: record.sourceRecordKey,
    collisionKey: digest(
      capture.sourceId,
      capture.identity.accountKey,
      record.sourceRecordKey,
    ),
    providerKey: record.sourceRecordKey,
    contentHash: digest(stableJson(compact)),
    sequenceLexeme: String(index),
    compactJson: stableJson(compact),
    description: record.description ?? null,
  };
}

function holdingSourceRecord(
  capture: InvestmentCaptureInput,
  holding: InvestmentCaptureInput["holdings"][number],
  compact: Record<string, unknown>,
  index: number,
): CanonicalFinancialNonTransactionRecord {
  return {
    ...sourceRecordEnvelope(capture, holding, compact, index),
    recordType: "holding-observation",
  };
}

function spineRecord(
  capture: InvestmentCaptureInput,
  record: {
    sourceRecordKey: string;
    effectiveOn: string;
    description?: string | null;
  },
  compact: Record<string, unknown>,
  money: InvestmentMoney,
  direction: "inflow" | "outflow",
  index: number,
) {
  return {
    ...sourceRecordEnvelope(capture, record, compact, index),
    amount: { coefficient: money.coefficient, scale: money.scale },
    balanceAfter: null,
    currency: money.currency,
    direction,
    sourceTime: {
      localDate: record.effectiveOn,
      localTime: "00:00:00",
      timeZone: "Asia/Taipei",
      epochMilliseconds: Date.parse(`${record.effectiveOn}T00:00:00+08:00`),
      precision: "date",
      timeOrigin: "defaulted_local_midnight",
    },
    effectiveOn: record.effectiveOn,
    transactionDateTimeLocal: `${record.effectiveOn}T00:00:00`,
  } as const;
}

function financialSpineMoney(
  capture: InvestmentCaptureInput,
  money: InvestmentMoney,
): InvestmentMoney {
  // The shared financial spine is intentionally ISO-4217-only.  Investment
  // extension rows retain the provider cash currency (including crypto
  // units/settlement tokens); a non-ISO cash leg therefore gets a neutral
  // zero amount in the capture reporting currency instead of an invalid or
  // fabricated fiat conversion.
  return ISO_CURRENCIES.has(money.currency)
    ? money
    : {
        coefficient: "0",
        scale: 0,
        currency: capture.identity.reportingCurrency,
      };
}

function canonicalSpine(capture: InvestmentValidatedCapture) {
  const effectiveDates = [
    capture.scope.effectiveOn,
    ...capture.holdings.map(({ effectiveOn }) => effectiveOn),
    ...capture.transactions.map(({ effectiveOn }) => effectiveOn),
    ...(capture.margin?.kind === "embedded"
      ? [capture.margin.effectiveOn]
      : []),
  ].sort();
  const scopeStart = effectiveDates[0]!;
  const scopeEnd = effectiveDates.at(-1)!;
  const nonTransactionRecords = capture.holdings.map((holding, index) =>
    holdingSourceRecord(
      capture,
      holding,
      (() => {
        const { measurementKey, observedAt, lineage, ...sourceFact } = holding;
        // These are capture-local projection coordinates.  A Source Record
        // describes provider evidence, so recollection must not change its
        // content merely because this Capture has a new timestamp or row.
        return { kind: "holding-measurement", ...sourceFact };
      })(),
      index,
    ),
  );
  const records = [
    ...capture.transactions.map((transaction, index) =>
      spineRecord(
        capture,
        transaction,
        (() => {
          const { transactionKey, ...sourceFact } = transaction;
          // transactionKey is a canonical projection key, not provider
          // evidence.  Including it would make an otherwise identical source
          // occurrence appear overwritten on a later Capture.
          return { kind: "investment-transaction", ...sourceFact };
        })(),
        financialSpineMoney(capture, transaction.cashEffect),
        transaction.action === "buy" ||
          transaction.action === "corporate_action_out"
          ? "outflow"
          : "inflow",
        capture.holdings.length + index,
      ),
    ),
    ...(capture.margin?.kind === "embedded"
      ? [
          spineRecord(
            capture,
            capture.margin,
            { ...capture.margin, recordKind: "margin-balance" },
            capture.margin.amount,
            "outflow",
            capture.holdings.length + capture.transactions.length,
          ),
        ]
      : []),
  ];
  const sourceRecordCount = nonTransactionRecords.length + records.length;
  const financial: CanonicalFinancialDepositCapture = {
    captureId: capture.captureId,
    authorityRoute: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    identity: {
      integrationNamespace: capture.sourceId,
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      stream: "investment",
      recordKind: "investment-source-record",
      subjectDigest: digest(
        capture.sourceId,
        capture.identity.sourceConnectionKey,
        capture.identity.identityEpochKey,
        capture.identity.accountKey,
      ),
      accountNo: capture.identity.accountKey,
      sourceAccountKey: capture.identity.accountKey,
      accountNumber: capture.identity.accountNumber ?? null,
      accountType: "investment",
      currency: capture.identity.reportingCurrency,
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: scopeStart,
      endDate: scopeEnd,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "source-reported-complete-investment-snapshot",
      completenessRuleVersion: capture.contractVersion,
      absenceAuthority: null,
      contractFingerprint: digest(
        "investment-contract",
        capture.contractVersion,
      ),
      preflightFingerprint: digest("investment-capture", capture.captureId),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: capture.contractVersion,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: capture.contractVersion,
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: capture.contractVersion,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "source_reported",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: sourceRecordCount,
        responseDigest: digest("investment-page", capture.captureId),
        proofKind: "source-declared-terminal-grid",
        contractFingerprint: digest(
          "investment-contract",
          capture.contractVersion,
        ),
        preflightFingerprint: digest("investment-capture", capture.captureId),
        metadataJson: stableJson({
          startDate: scopeStart,
          endDate: scopeEnd,
          rowCount: sourceRecordCount,
          observedAt: capture.observedAt,
        }),
      },
    ],
    records,
    nonTransactionRecords,
  };
  return admitCanonicalFinancialDepositCapture(financial);
}

function canonicalMarginLoanCapture(
  capture: InvestmentValidatedCapture,
): LoanValidatedCapture | null {
  if (
    capture.margin?.kind !== "independent-account" ||
    capture.margin.accountType !== "loan"
  )
    return null;
  const margin = capture.margin;
  const contractVersion = "loan/canonical/v1.yuanta" as const;
  const balanceEvidence = {
    kind: "source-reported-balance" as const,
    balanceKind: "loan_outstanding" as const,
    balanceField: "balance-after-transaction" as const,
    balance: margin.amount,
    effectiveAtField: "transaction-date" as const,
    effectiveAt: margin.effectiveOn,
    effectiveAtPrecision: "date" as const,
    effectiveAtTimeOrigin: "source_reported" as const,
    storageAnchor: "effective-at-date-only" as const,
    contractVersion,
  };
  return admitCanonicalLoanCapture({
    captureId: `${capture.captureId}:margin`,
    sourceId: "yuanta",
    authorityRoute: "yuanta/loan/canonical-v1",
    contractVersion,
    identity: {
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      stream: "loan",
      recordKind: "yuanta-loan-transaction",
      subjectDigest: digest(
        "yuanta-margin-loan",
        capture.identity.sourceConnectionKey,
        capture.identity.identityEpochKey,
        margin.accountKey,
      ),
      accountKey: margin.accountKey,
      accountNo: digest(
        "yuanta-margin-account-number",
        margin.identityEvidence.producerAccountId,
      ),
      accountType: "loan",
      currency: "TWD",
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: margin.effectiveOn,
      endDate: margin.effectiveOn,
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: contractVersion,
      pageCount: 1,
      terminal: true,
    },
    semantics: {
      status: "posted",
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: contractVersion,
      timeZone: "Asia/Taipei",
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        proofKind: "source-declared-terminal-range",
      },
    ],
    records: [
      {
        sourceRecordKey: margin.sourceRecordKey,
        occurrenceIndex: 1,
        effectiveOn: margin.effectiveOn,
        sourceTime: {
          localTime: "00:00:00",
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        postingStatus: "posted",
        eventKind: "disbursement",
        eventEvidence: {
          kind: "source-coded-loan-event",
          sourceRecordKey: margin.sourceRecordKey,
          sourceCode: margin.sourceEventCode,
          contractVersion,
        },
        direction: "outflow",
        amount: margin.amount,
        currency: "TWD",
        balanceSourceEvidence: [balanceEvidence],
      },
    ],
    counterpartTransactions: [],
    balanceObservations: [
      {
        observationKey: digest(
          "yuanta-margin-balance",
          margin.sourceRecordKey,
          margin.effectiveOn,
        ),
        sourceRecordKey: margin.sourceRecordKey,
        balanceKind: "loan_outstanding",
        balance: margin.amount,
        currency: "TWD",
        effectiveAt: margin.effectiveOn,
        effectiveAtPrecision: "date",
        effectiveAtTimeOrigin: "source_reported",
        effectiveTimeBasis: "source-reported",
        effectiveTimeRuleVersion: contractVersion,
        effectiveTimeEvidence: {
          kind: "source-reported-balance-effective-time",
          sourceRecordKey: margin.sourceRecordKey,
          sourceField: "statement-as-of",
          sourceFieldRole: "transaction-date",
          value: margin.effectiveOn,
          precision: "date",
          timeOrigin: "source_reported",
          storageAnchor: "effective-at-date-only",
          contractVersion,
        },
      },
    ],
    relations: [],
    relationCoverage: "not-asserted",
  });
}

function canonicalMarginCreditSpine(
  capture: InvestmentValidatedCapture,
): ReturnType<typeof admitCanonicalFinancialDepositCapture> | null {
  if (
    capture.margin?.kind !== "independent-account" ||
    capture.margin.accountType !== "credit"
  )
    return null;
  const margin = capture.margin;
  const contractVersion = `${capture.sourceId}/investment/margin-credit-canonical-v1`;
  const record = spineRecord(
    capture,
    margin,
    { ...margin, recordKind: "independent-margin-credit" },
    margin.amount,
    "outflow",
    0,
  );
  return admitCanonicalFinancialDepositCapture({
    captureId: `${capture.captureId}:margin-credit`,
    authorityRoute: contractVersion,
    contractVersion,
    identity: {
      integrationNamespace: capture.sourceId,
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      stream: "investment-margin",
      recordKind: "investment-margin-credit",
      subjectDigest: digest(
        capture.sourceId,
        capture.identity.sourceConnectionKey,
        capture.identity.identityEpochKey,
        margin.accountKey,
      ),
      accountNo: margin.accountKey,
      accountType: "credit",
      currency: margin.amount.currency,
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: margin.effectiveOn,
      endDate: margin.effectiveOn,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "source-reported-independent-margin-balance",
      completenessRuleVersion: contractVersion,
      absenceAuthority: null,
      contractFingerprint: digest("investment-margin-credit", contractVersion),
      preflightFingerprint: digest(
        "investment-margin-credit",
        capture.captureId,
      ),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: contractVersion,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: contractVersion,
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: contractVersion,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "defaulted_local_midnight",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        responseDigest: digest(
          "investment-margin-credit-page",
          capture.captureId,
        ),
        proofKind: "source-reported-independent-margin-account",
        contractFingerprint: digest(
          "investment-margin-credit",
          contractVersion,
        ),
        preflightFingerprint: digest(
          "investment-margin-credit",
          capture.captureId,
        ),
        metadataJson: stableJson({ effectiveOn: margin.effectiveOn }),
      },
    ],
    records: [record],
  });
}
export function createCanonicalInvestmentStore(
  ledgerDir: string,
): CanonicalInvestmentStore {
  const store = createCanonicalSourceStore(ledgerDir);
  validateCanonicalInvestmentExtensionSchema(store.db);
  validateCanonicalInvestmentFundingRelationSchema(store.db);
  return store;
}
function extensionRows(db: DatabaseSync, capture: InvestmentValidatedCapture) {
  const spine = db
    .prepare(
      `SELECT c.capture_id AS captureId,c.commit_id AS commitId,c.source_connection_id AS connectionId,c.identity_epoch_id AS epochId,s.account_id AS accountId FROM source_captures c JOIN capture_scopes s ON s.capture_id=c.capture_id WHERE c.capture_key=?`,
    )
    .get(capture.captureId) as
    | {
        captureId: Uint8Array;
        commitId: Uint8Array;
        connectionId: Uint8Array;
        epochId: Uint8Array;
        accountId: Uint8Array;
      }
    | undefined;
  if (!spine) throw new Error("Canonical investment spine capture is missing.");
  db.prepare(
    "INSERT INTO investment_captures(capture_id,commit_id,source_id,contract_version) VALUES(?,?,?,?)",
  ).run(
    spine.captureId,
    spine.commitId,
    capture.sourceId,
    capture.contractVersion,
  );
  db.prepare(
    "INSERT INTO investment_accounts(account_id,source_connection_id,identity_epoch_id,source_id,account_key,account_type,account_subtype) VALUES(?,?,?,?,?,'investment',?) ON CONFLICT(account_id) DO NOTHING",
  ).run(
    spine.accountId,
    spine.connectionId,
    spine.epochId,
    capture.sourceId,
    capture.identity.accountKey,
    capture.identity.accountSubtype ?? null,
  );
  const securities = new Map<string, Uint8Array>();
  for (const security of capture.securities) {
    const prior = db
      .prepare(
        "SELECT security_id AS securityId,producer_security_id AS producerSecurityId,name,ticker,currency,security_type AS securityType FROM investment_securities WHERE source_id=? AND security_key=?",
      )
      .get(capture.sourceId, security.securityKey) as
      Record<string, unknown> | undefined;
    if (
      prior &&
      (prior.producerSecurityId !== security.producerSecurityId ||
        (!security.nameEvidence && prior.name !== (security.name ?? null)) ||
        prior.ticker !== (security.ticker ?? null) ||
        prior.currency !== security.currency ||
        prior.securityType !== (security.securityType ?? "other"))
    )
      throw new CanonicalInvestmentAdmissionError(
        "Immutable Security evidence changed; a versioned Security revision contract is required.",
      );
    const securityId = prior ? (prior.securityId as Uint8Array) : uuidV7();
    if (!prior)
      db.prepare(
        "INSERT INTO investment_securities(security_id,source_id,security_key,producer_security_id,name,ticker,currency,security_type) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        securityId,
        capture.sourceId,
        security.securityKey,
        security.producerSecurityId,
        security.name ?? null,
        security.ticker ?? null,
        security.currency,
        security.securityType ?? "other",
      );
    if (security.nameEvidence && security.name !== undefined) {
      const record = db
        .prepare(
          "SELECT source_record_id AS id FROM source_records WHERE capture_id=? AND occurrence_key=?",
        )
        .get(spine.captureId, security.nameEvidence.sourceRecordKey) as
        { id: Uint8Array } | undefined;
      if (!record)
        throw new CanonicalInvestmentAdmissionError(
          "Security name source record is missing.",
        );
      db.prepare(
        `INSERT INTO investment_security_name_observations
        (security_id,capture_id,commit_id,source_record_id,contract_version,name)
        VALUES(?,?,?,?,?,?)`,
      ).run(
        securityId,
        spine.captureId,
        spine.commitId,
        record.id,
        security.nameEvidence.contractVersion,
        security.name,
      );
    }
    securities.set(security.securityKey, securityId);
  }
  const sourceRecord = (key: string) =>
    db
      .prepare(
        "SELECT source_record_id AS id FROM source_records WHERE capture_id=? AND occurrence_key=?",
      )
      .get(spine.captureId, key) as { id: Uint8Array };
  const securityId = (key: string): Uint8Array => {
    const value = securities.get(key);
    if (!value)
      throw new CanonicalInvestmentAdmissionError(
        "Captured Security extension is missing.",
      );
    return value;
  };
  for (const holding of capture.holdings) {
    const coordinate =
      holding.correction?.ofMeasurementKey ?? holding.measurementKey;
    let prior:
      | {
          observationId: Uint8Array;
          revisionNumber: number;
          securityId: Uint8Array;
          effectiveOn: string;
          lineageJson: string;
          sourceRecordKey: string;
        }
      | undefined;
    if (holding.correction) {
      const candidates = db
        .prepare(
          `SELECT h.observation_id AS observationId,h.revision_number AS revisionNumber,
                  h.security_id AS securityId,h.effective_on AS effectiveOn,
                  h.lineage_json AS lineageJson,r.occurrence_key AS sourceRecordKey
             FROM investment_holding_observations h
             JOIN source_records r ON r.source_record_id=h.source_record_id
            WHERE h.account_id=? AND h.measurement_key=? AND h.is_current=1`,
        )
        .all(spine.accountId, holding.correction.ofMeasurementKey) as Array<
        NonNullable<typeof prior>
      >;
      if (candidates.length > 1)
        throw new CanonicalInvestmentAdmissionError(
          "Holding correction target is ambiguous across independent measurements.",
        );
      prior = candidates[0];
    }
    if (holding.correction && !prior)
      throw new CanonicalInvestmentAdmissionError(
        "Holding correction target was not found in prior canonical measurements.",
      );
    if (prior) {
      const priorLineage = JSON.parse(prior.lineageJson) as {
        measurementSubjectKey?: string;
      };
      const sameSecurity =
        Buffer.from(prior.securityId).toString("hex") ===
        Buffer.from(securityId(holding.securityKey)).toString("hex");
      if (
        !sameSecurity ||
        prior.effectiveOn !== holding.correction!.priorEffectiveOn ||
        prior.sourceRecordKey !== holding.correction!.targetSourceRecordKey ||
        priorLineage.measurementSubjectKey !== holding.measurementSubjectKey
      )
        throw new CanonicalInvestmentAdmissionError(
          "Holding correction proof does not identify the same account, Security, measurement subject, and effective identity.",
        );
    }
    if (prior)
      db.prepare(
        "UPDATE investment_holding_observations SET is_current=0 WHERE observation_id=?",
      ).run(prior.observationId);
    db.prepare(
      `INSERT INTO investment_holding_observations(
        observation_id,capture_id,commit_id,account_id,security_id,source_record_id,
        measurement_key,correction_of_observation_id,revision_number,is_current,
        quantity_coefficient,quantity_scale,valuation_coefficient,valuation_scale,
        valuation_currency,cost_coefficient,cost_scale,cost_currency,effective_on,
        observed_at,lineage_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uuidV7(),
      spine.captureId,
      spine.commitId,
      spine.accountId,
      securityId(holding.securityKey),
      sourceRecord(holding.sourceRecordKey).id,
      coordinate,
      prior?.observationId ?? null,
      (prior?.revisionNumber ?? 0) + 1,
      1,
      holding.quantity?.coefficient ?? null,
      holding.quantity?.scale ?? null,
      holding.valuation?.coefficient ?? null,
      holding.valuation?.scale ?? null,
      holding.valuation?.currency ?? null,
      holding.cost?.coefficient ?? null,
      holding.cost?.scale ?? null,
      holding.cost?.currency ?? null,
      holding.effectiveOn,
      holding.observedAt,
      stableJson({
        ...holding.lineage,
        measurementSubjectKey: holding.measurementSubjectKey,
        correctionProof: holding.correction ?? null,
        effectiveTimeEvidence: holding.effectiveTimeEvidence,
      }),
    );
  }
  for (const transaction of capture.transactions) {
    const row = db
      .prepare(
        "SELECT transaction_id AS transactionId FROM financial_transactions WHERE account_id=? AND source_sequence=?",
      )
      .get(spine.accountId, transaction.sourceRecordKey) as {
      transactionId: Uint8Array;
    };
    const extension = db
      .prepare(
        "SELECT security_id AS securityId,action,quantity_coefficient AS quantityCoefficient,quantity_scale AS quantityScale,cash_coefficient AS cashCoefficient,cash_scale AS cashScale,cash_currency AS cashCurrency,effective_on AS effectiveOn,funding_evidence_json AS fundingEvidenceJson FROM investment_transactions WHERE transaction_id=?",
      )
      .get(row.transactionId) as
      | {
          securityId: Uint8Array;
          action: string;
          quantityCoefficient: string;
          quantityScale: number;
          cashCoefficient: string;
          cashScale: number;
          cashCurrency: string;
          effectiveOn: string;
          fundingEvidenceJson: string;
        }
      | undefined;
    const expected = {
      securityId: securityId(transaction.securityKey),
      action: transaction.action,
      quantityCoefficient: transaction.quantity.coefficient,
      quantityScale: transaction.quantity.scale,
      cashCoefficient: transaction.cashEffect.coefficient,
      cashScale: transaction.cashEffect.scale,
      cashCurrency: transaction.cashEffect.currency,
      effectiveOn: transaction.effectiveOn,
      fundingEvidenceJson: stableJson(transaction.fundingEvidence),
    };
    if (extension) {
      const sameSecurity =
        Buffer.from(extension.securityId).toString("hex") ===
        Buffer.from(expected.securityId).toString("hex");
      if (
        !sameSecurity ||
        extension.action !== expected.action ||
        extension.quantityCoefficient !== expected.quantityCoefficient ||
        extension.quantityScale !== expected.quantityScale ||
        extension.cashCoefficient !== expected.cashCoefficient ||
        extension.cashScale !== expected.cashScale ||
        extension.cashCurrency !== expected.cashCurrency ||
        extension.effectiveOn !== expected.effectiveOn ||
        extension.fundingEvidenceJson !== expected.fundingEvidenceJson
      )
        throw new CanonicalInvestmentAdmissionError(
          "Investment transaction extension conflicts with prior canonical evidence.",
        );
      continue;
    }
    db.prepare(
      "INSERT INTO investment_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      row.transactionId,
      spine.captureId,
      spine.commitId,
      spine.accountId,
      expected.securityId,
      sourceRecord(transaction.sourceRecordKey).id,
      transaction.action,
      transaction.quantity.coefficient,
      transaction.quantity.scale,
      transaction.cashEffect.coefficient,
      transaction.cashEffect.scale,
      transaction.cashEffect.currency,
      transaction.effectiveOn,
      expected.fundingEvidenceJson,
    );
  }
  if (capture.margin?.kind === "embedded")
    db.prepare(
      "INSERT INTO investment_margin_balance_observations VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      uuidV7(),
      spine.captureId,
      spine.commitId,
      spine.accountId,
      sourceRecord(capture.margin.sourceRecordKey).id,
      "margin_loan",
      capture.margin.amount.coefficient,
      capture.margin.amount.scale,
      capture.margin.amount.currency,
      capture.margin.effectiveOn,
    );
}

/**
 * Build the complete investment admission in its canonical order: ordinary
 * investment captures, each independent margin-loan counterpart followed by
 * its loan spine, then independent margin-credit captures. The shared
 * admission boundary invokes this adapter so callers do not coordinate that
 * ordering themselves.
 */
export function canonicalInvestmentAdmissionSpines(
  captures: readonly InvestmentValidatedCapture[],
): readonly CanonicalFinancialDepositValidatedCapture[] {
  for (const capture of captures)
    if (!isInvestmentCaptureValidated(capture))
      throw new CanonicalInvestmentAdmissionError(
        "Investment capture must be admitted before commit.",
      );
  const marginLoans = captures
    .map(canonicalMarginLoanCapture)
    .filter((capture): capture is LoanValidatedCapture => capture !== null);
  const marginCredits = captures
    .map(canonicalMarginCreditSpine)
    .filter(
      (
        capture,
      ): capture is NonNullable<
        ReturnType<typeof canonicalMarginCreditSpine>
      > => capture !== null,
    );
  return [
    ...captures.map(canonicalSpine),
    ...marginLoans.flatMap(canonicalLoanCaptureSpines),
    ...marginCredits,
  ];
}

/** Persist investment and margin extensions in the same transaction as all
 * generic source spines. The shared admission owner calls this only after
 * every spine has been admitted successfully. */
export function persistCanonicalInvestmentAdmissionExtensions(
  db: DatabaseSync,
  captures: readonly InvestmentValidatedCapture[],
): void {
  assertValidatedCanonicalDatabase(db);
  for (const capture of captures)
    if (!isInvestmentCaptureValidated(capture))
      throw new CanonicalInvestmentAdmissionError(
        "Investment capture must be admitted before commit.",
      );
  const marginLoans = captures
    .map(canonicalMarginLoanCapture)
    .filter((capture): capture is LoanValidatedCapture => capture !== null);
  for (const capture of captures) extensionRows(db, capture);
  for (const marginLoan of marginLoans)
    persistCanonicalLoanCaptureExtensions(db, marginLoan);
}

export async function commitCanonicalInvestmentCapture(
  store: CanonicalInvestmentStore,
  capture: InvestmentValidatedCapture,
) {
  assertValidatedCanonicalDatabase(store.db);
  if (!isInvestmentCaptureValidated(capture))
    throw new CanonicalInvestmentAdmissionError(
      "Investment capture must be admitted before commit.",
    );
  const [result] = await commitCanonicalInvestmentCaptureBatch(store, [
    capture,
  ]);
  return result!;
}

export async function commitCanonicalInvestmentCaptureBatch(
  store: CanonicalInvestmentStore,
  captures: readonly InvestmentValidatedCapture[],
) {
  assertValidatedCanonicalDatabase(store.db);
  const results = await commitCanonicalFinancialAdmission(store, {
    kind: "investment",
    captures: [...captures],
  });
  // Relation resolution is a separate, fail-soft follow-through after the
  // full investment admission (including margin extensions) is durable.
  await runCanonicalInvestmentRelationFollowThrough(
    store,
    undefined,
    "canonical-investment-relation-resolution-failed",
  );
  return results;
}

function queryRows(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
  projectionRequest:
    "current" | Readonly<{ financialAt: string; knowledgeAt: number }> | null,
) {
  assertValidatedCanonicalDatabase(store.db);
  token(sourceConnectionKey, "Source connection key");
  return withCanonicalSnapshot(store.db, () => {
    const projection = projectionRequest
      ? createCanonicalProjectionRuntime(store.db).read({
          kind: projectionRequest === "current" ? "current" : "historical",
          families: [
            "investment-accounts",
            "investment-holdings",
            "investment-transactions",
            "investment-margin-balances",
            "investment-funding-relations",
          ],
          scope: { sourceConnectionKey },
          ...(projectionRequest === "current"
            ? {}
            : { cutoff: projectionRequest }),
        })
      : null;
    const accounts = projection
      ? projection.families["investment-accounts"]!.map((row) => ({
          sourceId: row.sourceId,
          accountKey: row.accountKey,
          accountSubtype: row.accountSubtype,
        }))
      : store.db
          .prepare(
            `SELECT a.source_id AS sourceId,a.account_key AS accountKey,a.account_subtype AS accountSubtype FROM investment_accounts a JOIN source_connections c ON c.source_connection_id=a.source_connection_id WHERE c.source_connection_key=? ORDER BY a.source_id,a.account_key`,
          )
          .all(sourceConnectionKey);
    const securityRows = store.db
      .prepare(
        `SELECT DISTINCT hex(s.security_id) AS runtimeSecurityId,s.source_id AS sourceId,s.security_key AS securityKey,s.producer_security_id AS producerSecurityId,
          COALESCE((SELECT n.name FROM investment_security_name_observations n
            JOIN canonical_commits nc ON nc.commit_id=n.commit_id
            WHERE n.security_id=s.security_id AND nc.commit_sequence <= ?
            ORDER BY nc.commit_sequence DESC,n.rowid DESC LIMIT 1),s.name) AS name,s.ticker,s.currency,s.security_type AS securityType
           FROM investment_securities s
          WHERE EXISTS (
            SELECT 1 FROM investment_holding_observations h
            JOIN investment_accounts a ON a.account_id=h.account_id
            JOIN source_connections c ON c.source_connection_id=a.source_connection_id
            WHERE h.security_id=s.security_id AND c.source_connection_key=?
          ) OR EXISTS (
            SELECT 1 FROM investment_transactions t
            JOIN investment_accounts a ON a.account_id=t.account_id
            JOIN source_connections c ON c.source_connection_id=a.source_connection_id
            WHERE t.security_id=s.security_id AND c.source_connection_key=?
          ) ORDER BY s.security_key`,
      )
      .all(
        projectionRequest && projectionRequest !== "current"
          ? projectionRequest.knowledgeAt
          : Number.MAX_SAFE_INTEGER,
        sourceConnectionKey,
        sourceConnectionKey,
      ) as Array<Record<string, unknown> & { runtimeSecurityId: string }>;
    const selectedSecurityIds = projection
      ? new Set([
          ...projection.families["investment-holdings"].map(
            (row) => row.securityId,
          ),
          ...projection.families["investment-transactions"].map(
            (row) => row.securityId,
          ),
        ])
      : null;
    const securities = securityRows.flatMap(
      ({ runtimeSecurityId, ...security }) =>
        selectedSecurityIds === null ||
        selectedSecurityIds.has(runtimeSecurityId.toLowerCase())
          ? [security]
          : [],
    );
    const holdings = projection
      ? projection.families["investment-holdings"]!.map((row) => ({
          measurementKey: row.measurementKey,
          revisionNumber: row.revisionNumber,
          isCurrent: row.isCurrent ? 1 : 0,
          securityKey: row.securityKey,
          quantityCoefficient: row.quantityCoefficient,
          quantityScale: row.quantityScale,
          valuationCoefficient: row.valuationCoefficient,
          valuationScale: row.valuationScale,
          valuationCurrency: row.valuationCurrency,
          costCoefficient: row.costCoefficient,
          costScale: row.costScale,
          costCurrency: row.costCurrency,
          effectiveOn: row.effectiveOn,
          observedAt: row.observedAt,
          lineageJson: row.lineageJson,
        }))
      : store.db
          .prepare(
            `SELECT * FROM (SELECT h.measurement_key AS measurementKey,h.revision_number AS revisionNumber,h.is_current AS isCurrent,s.security_key AS securityKey,h.quantity_coefficient AS quantityCoefficient,h.quantity_scale AS quantityScale,h.valuation_coefficient AS valuationCoefficient,h.valuation_scale AS valuationScale,h.valuation_currency AS valuationCurrency,h.cost_coefficient AS costCoefficient,h.cost_scale AS costScale,h.cost_currency AS costCurrency,h.effective_on AS effectiveOn,h.observed_at AS observedAt,h.lineage_json AS lineageJson,ROW_NUMBER() OVER (PARTITION BY h.account_id,h.security_id ORDER BY h.observed_at DESC,h.rowid DESC) AS selectionRank FROM investment_holding_observations h JOIN investment_accounts a ON a.account_id=h.account_id JOIN source_connections c ON c.source_connection_id=a.source_connection_id JOIN investment_securities s ON s.security_id=h.security_id WHERE c.source_connection_key=?) ORDER BY effectiveOn,observedAt,revisionNumber,securityKey`,
          )
          .all(sourceConnectionKey);
    const transactionRows = projection
      ? projection.families["investment-transactions"]!.map((row) => ({
          action: row.action as InvestmentTransactionAction,
          effectiveOn: row.effectiveOn,
          fundingEvidenceJson: row.fundingEvidenceJson,
        }))
      : (store.db
          .prepare(
            `SELECT t.action,t.effective_on AS effectiveOn,t.funding_evidence_json AS fundingEvidenceJson FROM investment_transactions t JOIN investment_accounts a ON a.account_id=t.account_id JOIN source_connections c ON c.source_connection_id=a.source_connection_id WHERE c.source_connection_key=? ORDER BY t.effective_on`,
          )
          .all(sourceConnectionKey) as Array<{
          action: InvestmentTransactionAction;
          effectiveOn: string;
          fundingEvidenceJson: string;
        }>);
    const transactions = transactionRows.map(
      ({ fundingEvidenceJson, ...row }) => ({
        ...row,
        fundingEvidence: JSON.parse(
          fundingEvidenceJson,
        ) as InvestmentFundingEvidence,
      }),
    );
    const marginBalances = projection
      ? projection.families["investment-margin-balances"]!.map((row) => ({
          balanceKind: row.balanceKind,
          coefficient: row.coefficient,
          scale: row.scale,
          currency: row.currency,
          effectiveOn: row.effectiveOn,
        }))
      : store.db
          .prepare(
            `SELECT m.balance_kind AS balanceKind,m.coefficient,m.scale,m.currency,m.effective_on AS effectiveOn FROM investment_margin_balance_observations m JOIN investment_accounts a ON a.account_id=m.account_id JOIN source_connections c ON c.source_connection_id=a.source_connection_id WHERE c.source_connection_key=? ORDER BY m.effective_on`,
          )
          .all(sourceConnectionKey);
    const independentMarginAccounts = store.db
      .prepare(
        `SELECT a.account_type AS accountType,a.currency
           FROM financial_accounts a
           JOIN source_connections c ON c.source_connection_id=a.source_connection_id
           JOIN canonical_commits account_commit ON account_commit.commit_id=a.created_commit_id
          WHERE c.source_connection_key=? AND a.stream='investment-margin'
            AND (? IS NULL OR account_commit.commit_sequence <= ?)
          ORDER BY a.account_type,a.currency`,
      )
      .all(
        sourceConnectionKey,
        projection?.knowledgePoint ?? null,
        projection?.knowledgePoint ?? null,
      );
    return {
      accounts,
      securities,
      holdings,
      transactions,
      marginBalances,
      independentMarginAccounts,
      relations: projection
        ? projection.families["investment-funding-relations"].map(
            (relation) => ({
              relationKey: relation.relationKey,
              settlementGroupKey: relation.settlementGroupKey,
              settlementEffectiveOn: relation.settlementEffectiveOn,
              settlementModel: relation.settlementModel,
              coefficient: relation.coefficient,
              scale: relation.scale,
              currency: relation.currency,
              direction: relation.direction,
              sourceLinkageKey: relation.sourceLinkageKey,
              investmentTransactionCount:
                relation.investmentTransactionCount,
            }),
          )
        : queryCanonicalInvestmentFundingRelationsInSnapshot(
            store,
            sourceConnectionKey,
          ),
    };
  });
}

export {
  deriveYuantaForeignSettlementLinkageKey,
  queryCanonicalInvestmentFundingRelations,
  resolveCanonicalInvestmentFundingRelations,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
} from "./investment-funding-relations.ts";
export function queryCanonicalInvestmentCurrent(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
) {
  return queryRows(store, sourceConnectionKey, "current");
}
export function queryCanonicalInvestmentHistorical(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
  cutoff: Readonly<{ financialAt: string; knowledgeAt: number }>,
) {
  return queryRows(store, sourceConnectionKey, cutoff);
}
export function queryCanonicalInvestmentLineage(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
  measurementKey: string,
) {
  const historical = queryRows(store, sourceConnectionKey, null);
  return {
    ...historical,
    holdings: historical.holdings.filter(
      (row) =>
        (row as { measurementKey: string }).measurementKey === measurementKey,
    ),
  };
}
