import { createHash } from "node:crypto";
import type {
  LineBankAccount,
  LineBankTransactionPage,
  LineBankTransactionRow,
} from "../../workflows/linebank-statements.ts";
import {
  LINEBANK_OBSERVED_TIME_EVIDENCE_VERSION,
  linebankEpochMillisecondsFromSourceDateTime,
} from "../../workflows/linebank-statements.ts";
import {
  DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
  DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
  DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE,
  admitLineBankHumanAttestedV13Capture,
  admitDomesticDepositCapture,
  type DomesticDepositCapture,
  type DomesticDepositExactAmount,
  type DomesticDepositSourceRecord,
  type DomesticDepositSourceTime,
  type DomesticDepositValidatedCapture,
  type LineBankHumanAttestedV13ValidatedCapture,
} from "./domestic-deposit-store.ts";

/** Shared source-record writer/query seams for source adapters and callers. */
export {
  commitCanonicalLineBankFinancialCapture,
  commitCanonicalDomesticDeposit,
  createDomesticDepositStore,
  queryCurrent,
  queryHistorical,
  queryLineage,
} from "./domestic-deposit-store.ts";

/**
 * This is intentionally a preflight contract, not a canonical writer.  The
 * live evidence identifies the source fields and response envelope, the
 * historical-v7 slice adds an observed-only direction projection, and
 * occurrence-v1 adds an opaque empirical source-occurrence comparison seam.
 * None establishes provider direction, posting, effective-time, cancellation,
 * revision, authority, or provider-backed identity semantics. Keeping the
 * contract version explicit prevents a best-effort CSV projection from
 * becoming financial truth.
 */
export const LINEBANK_INTEGRATION_NAMESPACE = "linebank";
export const LINEBANK_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
export const LINEBANK_DOMESTIC_DEPOSIT_AUTHORITY =
  "linebank/domestic-deposit/preflight-v4";
export const LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION = "preflight-v4";
export const LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";
export const LINEBANK_DOMESTIC_DEPOSIT_READINESS = "preflight-only" as const;
export const LINEBANK_DOMESTIC_DEPOSIT_TIME_EVIDENCE_VERSION =
  LINEBANK_OBSERVED_TIME_EVIDENCE_VERSION;
/** Returned instead of the source account values so diagnostics remain safe to log. */
export const LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR =
  "acctNbr+arrId" as const;

/**
 * Public evidence narrows currency only for the explicitly staged domestic
 * main-account route. No provider product code is claimed here: the
 * descriptor is the versioned adapter contract that a future workflow seam
 * must supply after establishing the source scope.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION =
  "domestic-main-twd-v1" as const;
export const LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION,
  route: "/transaction",
  productDescriptor: "domestic-main-account-demand-savings",
  accountRole: "main-account",
  currency: "TWD",
} as const;
export const LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_SOURCES = [
  "https://event.linebank.com.tw/marketing/cobrandcards/",
  "https://www.linebank.com.tw/board-rate/deposit-rate",
  "https://www.linebank.com.tw/products",
] as const;

export const LINEBANK_DOMESTIC_DEPOSIT_PROVENANCE = {
  source: "LINE Bank accessibility internet banking",
  values: "synthetic-or-redacted",
  liveResponseRetained: false,
  readiness: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  note: "The latest redacted responses preserve source envelope and nullable linkage fields; historical-v7 records an observed-only direction mapping for codes 1 and 2, observed-time-v1 records exact source timestamp reconstruction without claiming posting time, occurrence-v1 adds only an opaque empirical source-occurrence comparison rule with providerGuaranteed false, zero-result-v11 records provider-explicit empty-page structure without inferring withdrawal or revision, official public product text supports TWD only for the explicit domestic-main-account scope, other response semantics remain unresolved, and no canonical Financial Transaction write is exposed.",
} as const;

export const LINEBANK_DOMESTIC_DEPOSIT_DIRECTION_EVIDENCE_VERSION =
  "historical-v7" as const;

/**
 * Versioned empirical mapping for the observed source codes.  It is usable by
 * the source projection only; provider guarantees and canonical readiness
 * remain blocked.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_DIRECTION_EVIDENCE_VERSION,
  status: "observed-versioned",
  mappings: {
    "1": {
      direction: "inflow",
      amountSign: "absolute-non-negative",
      uiLabelCorrelation: "存入",
      evidence: "ui-correlation-and-balance-arithmetic",
    },
    "2": {
      direction: "outflow",
      amountSign: "absolute-non-negative",
      uiLabelCorrelation: null,
      evidence: "balance-arithmetic-only",
    },
  },
  unknownOrMissingCode: "reject",
  negativeAmountConflict: "reject",
  providerGuaranteed: false,
  completeMapping: true,
} as const;

/** Aggregate-only direction evidence from the historical validation. */
export const LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_DIRECTION_EVIDENCE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_DIRECTION_EVIDENCE_VERSION,
  rowCount: 5,
  directionCounts: { code1: 4, code2: 1 },
  amounts: {
    allNumericNonNegative: true,
    negativeRowCount: 0,
    signIsNotDirectionEvidence: true,
  },
  afterBalanceTransitions: {
    code1PlusExact: 3,
    code2MinusExact: 1,
    inconsistent: 0,
    indeterminate: 0,
  },
  classificationSetsDisjoint: true,
  code2UiLabelCorrelation: false,
  distinctCaseCodeCount: 3,
  distinctBusinessFunctionCount: 3,
  cancellationFlags: ["N"],
  candidateIdentity: {
    txSeqPresent: 5,
    txSeqDistinct: 3,
    txSeqCrrnDistinct: 5,
    txSeqDtmDistinct: 5,
    nullableLinkagePresentRows: 1,
  },
  mappingStatus: "observed-versioned",
  providerGuaranteed: false,
  unknownOrMissingCodesReject: true,
} as const;

/** Aggregate-only observed source-time evidence; this is not posting time. */
export const LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_TIME_EVIDENCE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_TIME_EVIDENCE_VERSION,
  rowsObserved: 5,
  exactTaipeiEpochMillisecondsMatches: 5,
  safeIntegerMilliseconds: 5,
  utcOrSecondsMatches: 0,
  ambiguityOrMismatch: 0,
  chronology: "descending",
  sameTimeCollisionCount: 0,
  semanticStatus: "observed-versioned",
  representsPostingOrAccountingTime: false,
  providerGuaranteed: false,
} as const;

export const LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION =
  "occurrence-v1" as const;

/**
 * This is an empirical source-occurrence rule, not a provider identity claim.
 * The tuple digest uses only the source namespace/connection/stream, contract
 * version, account epoch/composite, txDtm, txSeqNbr and crrnDpstNthCnt. The
 * change fingerprint is comparison-only and never participates in matching.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE = {
  matchingRuleVersion:
    LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
  providerGuaranteed: false,
  matchingFields: [
    "namespace",
    "sourceConnection",
    "stream",
    "contractVersion",
    "identityEpoch",
    "accountComposite",
    "txDtm",
    "txSeqNbr",
    "crrnDpstNthCnt",
  ],
  excludedFromMatching: [
    "txAmt",
    "afTxBal",
    "bizTxFuncTpCd",
    "bizTxFuncTpNm",
    "txRmkCont",
    "txMemoVal",
    "rowOrder",
    "ctptCustLineUid",
    "fxsTxId",
    "rltvTxArrId",
  ],
  repeatSameTupleSameSource: "stable-observation",
  repeatSameTupleChangedSource: "conflict-no-overwrite",
  missingOrInvalidFields: "reject-capture",
  duplicateFullTuple: "reject-capture",
  baseTupleWithDifferentTime: "reject-capture",
  windowAbsenceWithoutComparableCompleteness: "no-withdrawal",
} as const;

export const LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE_VERSION =
  "zero-result-v11" as const;

/** Aggregate-only evidence for a provider-explicit empty transaction page. */
export const LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE_VERSION,
  providerExplicit: true,
  responseCode: "200",
  aggregate: {
    pageNbr: 1,
    pageCnt: 1000,
    totTxCnt: 0,
    txCnt: 0,
    rowCount: 0,
  },
  repeat: "stable-observation",
  absence: {
    comparableCompletenessRequired: true,
    withdrawalAuthorized: false,
    revisionAuthorized: false,
  },
  canonicalAdmission: "blocked",
  readiness: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  remainingBlockers: {
    providerIdentityGuarantee: true,
    postingSemantics: true,
    effectiveTimeSemantics: true,
    cancellationSemantics: true,
    completenessSemantics: true,
    authoritySemantics: true,
    revisionSemantics: true,
    canonicalWriter: true,
  },
} as const;

export type LineBankZeroResultDiagnosticCode =
  | "zero-response-status-invalid"
  | "zero-page-number-invalid"
  | "zero-page-count-invalid"
  | "zero-total-count-nonzero"
  | "zero-row-count-nonzero"
  | "zero-page-row-mismatch";

export type LineBankZeroResultValidationResult = {
  status: "accepted" | "blocked";
  diagnostics: LineBankZeroResultDiagnosticCode[];
};

export type LineBankZeroResultCapture = {
  account: LineBankAccount;
  identityEpoch: number;
  contractVersion: string;
  scope: {
    startDate: string;
    endDate: string;
    accountFilter: string;
    currencyFilter: string;
  };
  page: LineBankTransactionPage;
  comparableCompleteness: boolean;
};

export type LineBankZeroResultComparison = {
  status: "stable" | "not-comparable";
  providerGuaranteed: false;
  absenceWithoutComparableCompleteness: boolean;
  withdrawalAuthorized: false;
  revisionAuthorized: false;
  diagnostics: (
    | "capture-invalid"
    | "source-identity-invalid"
    | "context-separated"
    | "scope-separated"
    | "page-metadata-drift"
    | "absence-incomparable"
  )[];
};

export type LineBankOccurrenceCaptureContext = {
  namespace: typeof LINEBANK_INTEGRATION_NAMESPACE;
  sourceConnection: "accessibility.linebank.com.tw";
  stream: typeof LINEBANK_DOMESTIC_DEPOSIT_STREAM;
  /** Contract versions are part of the key so migrations cannot collide. */
  contractVersion: string;
  identityEpoch: number;
  account: LineBankAccount;
};

export type LineBankSourceOccurrenceKey = {
  matchingRuleVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION;
  /** Opaque SHA-256 digest; raw account and row fields never leave the helper. */
  tupleDigest: string;
  /** Opaque digest without txDtm, used only to detect time collisions. */
  baseDigest: string;
  /** Opaque comparison fingerprint; never used as an identity key. */
  changeFingerprint: string;
};

export type LineBankOccurrenceValidationDiagnosticCode =
  | "occurrence-context-missing"
  | "occurrence-context-invalid"
  | "occurrence-key-missing"
  | "occurrence-duplicate"
  | "occurrence-base-time-conflict";

export type LineBankOccurrenceValidationResult = {
  matchingRuleVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION;
  providerGuaranteed: false;
  status: "valid" | "blocked";
  keys: LineBankSourceOccurrenceKey[];
  diagnostics: {
    code: LineBankOccurrenceValidationDiagnosticCode;
    rowIndex?: number;
  }[];
};

export type LineBankOccurrenceCapture = {
  context: LineBankOccurrenceCaptureContext;
  rows: readonly LineBankTransactionRow[];
  comparableCompleteness: boolean;
};

export type LineBankOccurrenceComparison = {
  matchingRuleVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION;
  providerGuaranteed: false;
  status: "stable" | "conflict" | "no-overlap" | "not-comparable";
  overlapCount: number;
  stableObservationCount: number;
  conflictCount: number;
  absenceWithoutComparableCompleteness: boolean;
  withdrawalAuthorized: false;
  diagnostics: (
    | "capture-invalid"
    | "source-conflict"
    | "source-base-conflict"
    | "absence-incomparable"
  )[];
};

export const LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_VERSION =
  "cross-window-v3" as const;
export const LINEBANK_DOMESTIC_DEPOSIT_REPEAT_EVIDENCE_VERSION =
  "repeat-v5" as const;

export const LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_CANDIDATE_FIELDS = [
  "txSeqNbr",
  "crrnDpstNthCnt",
  "ctptCustLineUid",
  "fxsTxId",
  "rltvTxArrId",
  "txCaseCd",
  "bizTxFuncTpCd",
  "txDtm",
] as const;

export type LineBankCrossWindowEvidence = {
  longWindow: LineBankDomesticDepositPreflightInput;
  shortWindow: LineBankDomesticDepositPreflightInput;
};

export type LineBankCrossWindowEvidenceSummary = {
  evidenceVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_VERSION;
  accountCompositeEqual: boolean;
  envelopeStable: boolean;
  fullRawRowEqualityCount: number;
  candidateTupleOverlapCount: number;
  longWindowTxSeqDuplicateGroupCount: number;
  longWindowTxSeqCrrnEmpiricallyUnique: boolean;
  longWindowTxSeqDtmEmpiricallyUnique: boolean;
  longWindowProviderTupleEmpiricallyUnique: boolean;
  candidateUsesAmount: false;
  candidateUsesDescription: false;
  candidateUsesBalance: false;
  candidateUsesContentHash: false;
  candidateUsesRowOrder: false;
  nullableLinkageCanIdentify: false;
  identityStatus: "observed-not-provider-guaranteed";
};

export type LineBankRepeatCaptureEvidenceSummary = {
  evidenceVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_REPEAT_EVIDENCE_VERSION;
  httpStatus: { old: 200; repeat: 200 };
  postCount: 1;
  requestShapeEqual: true;
  accountCompositeEqual: true;
  windowEqual: true;
  responseEnvelopeStable: true;
  aggregate: {
    old: { pageNbr: 1; pageCnt: 30; totTxCnt: 1; txCnt: 1; rowCount: 1 };
    repeat: { pageNbr: 1; pageCnt: 30; totTxCnt: 1; txCnt: 1; rowCount: 1 };
  };
  fullRawRowEqualityCount: 1;
  providerTupleOverlapCount: 1;
  rowStability: {
    txSeqNbr: true;
    crrnDpstNthCnt: true;
    ctptCustLineUid: true;
    fxsTxId: true;
    rltvTxArrId: true;
    txCaseCd: true;
    bizTxFuncTpCd: true;
    txDtm: true;
  };
  directionCodes: { old: ["1"]; repeat: ["1"] };
  cancellationFlags: { old: ["N"]; repeat: ["N"] };
  txDtm: { oldPresent: true; repeatPresent: true; stable: true };
  drift: {
    requestShape: false;
    account: false;
    window: false;
    responseEnvelope: false;
    aggregate: false;
    providerTuple: false;
  };
  identityStatus: "observed-not-provider-guaranteed";
};

/**
 * Aggregate-only evidence from the prior semantics capture and the completed
 * repeat capture. No account, date, amount, description, or raw timestamp is
 * retained; repeated stability remains empirical and not provider-guaranteed.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_REPEAT_CAPTURE_EVIDENCE: LineBankRepeatCaptureEvidenceSummary =
  {
    evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_REPEAT_EVIDENCE_VERSION,
    httpStatus: { old: 200, repeat: 200 },
    postCount: 1,
    requestShapeEqual: true,
    accountCompositeEqual: true,
    windowEqual: true,
    responseEnvelopeStable: true,
    aggregate: {
      old: { pageNbr: 1, pageCnt: 30, totTxCnt: 1, txCnt: 1, rowCount: 1 },
      repeat: { pageNbr: 1, pageCnt: 30, totTxCnt: 1, txCnt: 1, rowCount: 1 },
    },
    fullRawRowEqualityCount: 1,
    providerTupleOverlapCount: 1,
    rowStability: {
      txSeqNbr: true,
      crrnDpstNthCnt: true,
      ctptCustLineUid: true,
      fxsTxId: true,
      rltvTxArrId: true,
      txCaseCd: true,
      bizTxFuncTpCd: true,
      txDtm: true,
    },
    directionCodes: { old: ["1"], repeat: ["1"] },
    cancellationFlags: { old: ["N"], repeat: ["N"] },
    txDtm: { oldPresent: true, repeatPresent: true, stable: true },
    drift: {
      requestShape: false,
      account: false,
      window: false,
      responseEnvelope: false,
      aggregate: false,
      providerTuple: false,
    },
    identityStatus: "observed-not-provider-guaranteed",
  };

export const LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE_VERSION =
  "clean-headed-v6" as const;

/**
 * Aggregate-only evidence from the clean headed validation.  This records
 * workflow/authentication behavior and transport shape, not financial values
 * or source identifiers.  Manual-auth navigation is complete, while source
 * semantics and canonical admission remain explicitly blocked.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE_VERSION,
  cleanStart: {
    noOpenSessions: true,
    freshHeadedSession: true,
  },
  manualAuthNavigation: {
    liveValidation: "complete",
    humanCompletedLoginAndCaptcha: true,
    authenticatedRootReached: true,
    transactionRouteReached: true,
    alertGate: "no-visible-dialog",
  },
  accountMatchCount: 1,
  historyPost: { count: 1, status: 200 },
  aggregate: {
    pageNbr: 1,
    pageCnt: 1000,
    totTxCnt: 1,
    txCnt: 1,
    rowCount: 1,
  },
  directionCodes: ["1"],
  cancellationFlags: ["N"],
  occurrence: {
    txSeqNbrPresent: true,
    txSeqNbrUniqueWithinSample: true,
  },
  fieldTypes: {
    txDt: "string",
    txTm: "string",
    txDtm: "number",
    amount: "number",
  },
  automationProgress: [25, 100],
  sessionClosed: true,
  canonicalAdmission: "blocked",
  readiness: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  remainingBlockers: {
    identityProviderGuarantee: true,
    fullDirectionMapping: true,
    postingSemantics: true,
    effectiveTimeSemantics: true,
    cancellationSemantics: true,
    completenessSemantics: true,
    authoritySemantics: true,
    canonicalWriter: true,
    queryCompleteness: true,
  },
} as const;

export const LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE_VERSION =
  "result-ui-v12" as const;

/**
 * UI-only boundary evidence from one user-submitted query. It records the
 * rendered result contract without retaining row values or the response body.
 * Missing labels are deliberately evidence of absence from this rendered
 * page, not proof that the provider never supports those semantics.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE_VERSION,
  route: "/transaction",
  userSubmittedQueryCount: 1,
  agentMutation: false,
  responseBodyRetained: false,
  visibleColumnHeaders: ["時間", "摘要", "金額"],
  missingSemanticLabels: [
    "date-basis",
    "posting/accounting/effective-time",
    "direction",
    "balance",
    "status",
    "cancellation/correction",
    "provider-transaction-id",
    "total/page",
    "period",
    "download",
  ],
  rowDetails: {
    visibleInteractiveControls: 0,
    ariaExpandedControls: 0,
    ariaHaspopupControls: 0,
  },
  canonicalAdmission: "blocked",
  readiness: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  remainingBlockers: {
    providerIdentityGuarantee: true,
    postingSemantics: true,
    effectiveTimeSemantics: true,
    cancellationSemantics: true,
    completenessSemantics: true,
    canonicalWriter: true,
    queryCompleteness: true,
  },
} as const;

export const LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE_VERSION =
  "historical-revalidation-v9" as const;

/**
 * Aggregate-only evidence from the completed historical revalidation.  The
 * source transport and observed direction projection are live-complete for
 * this capture; canonical admission remains blocked because evidence does
 * not prove provider identity or accounting semantics.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE = {
  evidenceVersion:
    LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE_VERSION,
  cleanStart: {
    noOpenSessions: true,
    freshHeadedSession: true,
  },
  manualAuthNavigation: {
    liveValidation: "complete",
    humanCompletedLoginAndCaptcha: true,
    authenticatedRootReached: true,
    transactionRouteReached: true,
  },
  accountMatchCount: 1,
  historyPost: { count: 1, status: 200 },
  aggregate: {
    pageNbr: 1,
    pageCnt: 1000,
    totTxCnt: 5,
    txCnt: 5,
    rowCount: 5,
  },
  direction: {
    codes: ["1", "2"],
    counts: { code1: 4, code2: 1 },
    allRowsAccepted: true,
  },
  cancellationFlags: ["N"],
  occurrence: {
    txSeqNbrPresent: 5,
    txSeqNbrDistinct: 3,
    txSeqCrrnDistinct: 5,
    txSeqDtmDistinct: 5,
  },
  amount: {
    numericNonNegativeRows: 5,
  },
  sourceTime: {
    evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_TIME_EVIDENCE_VERSION,
    rowsObserved: 5,
    exactTaipeiEpochMillisecondsMatches: 5,
    utcOrSecondsMatches: 0,
    ambiguityOrMismatch: 0,
    chronology: "descending",
    sameTimeCollisionCount: 0,
  },
  fieldTypes: {
    txDt: "string",
    txTm: "string",
    txDtm: "number",
    amount: "number",
  },
  validation: {
    transport: "complete",
    direction: "complete",
  },
  automationProgress: [25, 100],
  commandExitCode: 0,
  sessionClosed: true,
  canonicalAdmission: "blocked",
  readiness: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  remainingBlockers: {
    identityProviderGuarantee: true,
    postingSemantics: true,
    effectiveTimeSemantics: true,
    cancellationSemantics: true,
    completenessSemantics: true,
    authoritySemantics: true,
    canonicalWriter: true,
    queryCompleteness: true,
  },
} as const;

/**
 * Sanitized shape evidence from one live response. Every value below is
 * synthetic; it preserves only the response invariants needed by preflight.
 * In particular, the two rows deliberately share txSeqNbr while differing in
 * other source fields; occurrence-v1 requires crrnDpstNthCnt and txDtm as
 * additional empirical tuple components, while provider identity remains
 * unproven.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE: LineBankDomesticDepositPreflightInput =
  {
    account: { acctNbr: "SYNTHETIC-ACCOUNT", arrId: "SYNTHETIC-ARRANGEMENT" },
    scope: { startDate: "20260101", endDate: "20260102" },
    pages: [
      {
        pageNbr: 1,
        pageCnt: 1000,
        totTxCnt: 2,
        txCnt: 2,
        source: {
          acctNbr: "SYNTHETIC-ACCOUNT",
          arrId: "SYNTHETIC-ARRANGEMENT",
          acctNick: "SYNTHETIC-ACCOUNT-LABEL",
          acctBal: 10000,
          wdrwAvblAmt: 9000,
          acctColrTpCd: "SYNTHETIC-COLOR-CODE",
          acctColrTpVal: "SYNTHETIC-COLOR-VALUE",
          acctCardImgUrl: null,
          pdCd: "SYNTHETIC-PRODUCT-CODE",
          pdNm: "SYNTHETIC-PRODUCT-NAME",
          simpAcctTpCd: null,
          jntAcctMbrTpCd: "SYNTHETIC-ROLE",
          isSecuAcctBndg: false,
          debitCardFundBlcknYn: "N",
          txBlcknYn: "N",
          opnDtm: 1700000000000,
          jntMbrListCnt: 0,
          totJntAcctMbrCnt: 0,
          rcntTxfrListCnt: 0,
        },
        rows: [
          {
            txSeqNbr: "1",
            txDt: "20260101",
            txTm: "010203",
            txDtm: 1767200523000,
            dpstWdrwDsCd: "1",
            bizTxFuncTpCd: "SYNTHETIC-FUNCTION-CODE-A",
            crrnDpstNthCnt: 1,
            ctptCustLineUid: "SYNTHETIC-LINE-UID-A",
            fxsTxId: null,
            rltvTxArrId: null,
            txCaseCd: "SYNTHETIC-CASE-A",
            txAmt: "1000",
            afTxBal: "10000",
            cncdTxYn: "N",
            cnclTxYn: "N",
            bizTxFuncTpNm: "SYNTHETIC-EVENT-A",
            txRmkCont: "SYNTHETIC-NOTE-A",
          },
          {
            txSeqNbr: "1",
            txDt: "20260102",
            txTm: "020304",
            txDtm: 1767290584000,
            dpstWdrwDsCd: "1",
            bizTxFuncTpCd: "SYNTHETIC-FUNCTION-CODE-B",
            crrnDpstNthCnt: 2,
            ctptCustLineUid: "SYNTHETIC-LINE-UID-B",
            fxsTxId: null,
            rltvTxArrId: null,
            txCaseCd: "SYNTHETIC-CASE-B",
            txAmt: "2000",
            afTxBal: "12000",
            cncdTxYn: "N",
            cnclTxYn: "N",
            bizTxFuncTpNm: "SYNTHETIC-EVENT-B",
            txRmkCont: "SYNTHETIC-NOTE-B",
          },
        ],
      },
    ],
  };

/**
 * Fully synthetic cross-window evidence. The long window deliberately has two
 * rows with one txSeqNbr collision; the short window repeats exactly one of
 * those rows. The comparison helper below reports only counts and booleans.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE: LineBankCrossWindowEvidence =
  {
    longWindow: {
      account: {
        acctNbr: "SYNTHETIC-CROSS-ACCOUNT",
        arrId: "SYNTHETIC-CROSS-ARRANGEMENT",
      },
      scope: { startDate: "20250101", endDate: "20251231" },
      pages: [
        {
          pageNbr: 1,
          pageCnt: 1000,
          totTxCnt: 2,
          txCnt: 2,
          source: {
            acctNbr: "SYNTHETIC-CROSS-ACCOUNT",
            arrId: "SYNTHETIC-CROSS-ARRANGEMENT",
            acctNick: "SYNTHETIC-CROSS-LABEL",
            acctBal: 10000,
            wdrwAvblAmt: 9000,
            pdCd: "SYNTHETIC-CROSS-PRODUCT",
            pdNm: "SYNTHETIC-CROSS-PRODUCT-NAME",
            simpAcctTpCd: null,
            jntAcctMbrTpCd: "SYNTHETIC-CROSS-ROLE",
            isSecuAcctBndg: false,
            debitCardFundBlcknYn: "N",
            txBlcknYn: "N",
            opnDtm: 1700000100000,
          },
          rows: [
            {
              txSeqNbr: "1",
              txDt: "20251215",
              txTm: "010203",
              txDtm: 1765731723000,
              dpstWdrwDsCd: "1",
              bizTxFuncTpCd: "SYNTHETIC-CROSS-FUNCTION-A",
              crrnDpstNthCnt: 1,
              ctptCustLineUid: "SYNTHETIC-CROSS-LINE-A",
              fxsTxId: null,
              rltvTxArrId: null,
              txCaseCd: "SYNTHETIC-CROSS-CASE-A",
              txAmt: "1000",
              afTxBal: "10000",
              cncdTxYn: "N",
              cnclTxYn: "N",
              bizTxFuncTpNm: "SYNTHETIC-CROSS-DESCRIPTION-A",
              txRmkCont: "SYNTHETIC-CROSS-NOTE-A",
              txMemoVal: null,
            },
            {
              txSeqNbr: "1",
              txDt: "20250601",
              txTm: "020304",
              txDtm: 1748714584000,
              dpstWdrwDsCd: "1",
              bizTxFuncTpCd: "SYNTHETIC-CROSS-FUNCTION-B",
              crrnDpstNthCnt: 2,
              ctptCustLineUid: "SYNTHETIC-CROSS-LINE-B",
              fxsTxId: null,
              rltvTxArrId: null,
              txCaseCd: "SYNTHETIC-CROSS-CASE-B",
              txAmt: "2000",
              afTxBal: "12000",
              cncdTxYn: "N",
              cnclTxYn: "N",
              bizTxFuncTpNm: "SYNTHETIC-CROSS-DESCRIPTION-B",
              txRmkCont: "SYNTHETIC-CROSS-NOTE-B",
              txMemoVal: null,
            },
          ],
        },
      ],
    },
    shortWindow: {
      account: {
        acctNbr: "SYNTHETIC-CROSS-ACCOUNT",
        arrId: "SYNTHETIC-CROSS-ARRANGEMENT",
      },
      scope: { startDate: "20251201", endDate: "20251231" },
      pages: [
        {
          pageNbr: 1,
          pageCnt: 30,
          totTxCnt: 1,
          txCnt: 1,
          source: {
            acctNbr: "SYNTHETIC-CROSS-ACCOUNT",
            arrId: "SYNTHETIC-CROSS-ARRANGEMENT",
            acctNick: "SYNTHETIC-CROSS-LABEL",
            acctBal: 10000,
            wdrwAvblAmt: 9000,
            pdCd: "SYNTHETIC-CROSS-PRODUCT",
            pdNm: "SYNTHETIC-CROSS-PRODUCT-NAME",
            simpAcctTpCd: null,
            jntAcctMbrTpCd: "SYNTHETIC-CROSS-ROLE",
            isSecuAcctBndg: false,
            debitCardFundBlcknYn: "N",
            txBlcknYn: "N",
            opnDtm: 1700000100000,
          },
          rows: [
            {
              txSeqNbr: "1",
              txDt: "20251215",
              txTm: "010203",
              txDtm: 1765731723000,
              dpstWdrwDsCd: "1",
              bizTxFuncTpCd: "SYNTHETIC-CROSS-FUNCTION-A",
              crrnDpstNthCnt: 1,
              ctptCustLineUid: "SYNTHETIC-CROSS-LINE-A",
              fxsTxId: null,
              rltvTxArrId: null,
              txCaseCd: "SYNTHETIC-CROSS-CASE-A",
              txAmt: "1000",
              afTxBal: "10000",
              cncdTxYn: "N",
              cnclTxYn: "N",
              bizTxFuncTpNm: "SYNTHETIC-CROSS-DESCRIPTION-A",
              txRmkCont: "SYNTHETIC-CROSS-NOTE-A",
              txMemoVal: null,
            },
          ],
        },
      ],
    },
  };

export type LineBankPreflightDiagnosticCode =
  | "account-key-missing"
  | "scope-invalid"
  | "pages-missing"
  | "page-number-invalid"
  | "page-number-duplicate"
  | "page-number-gap"
  | "page-size-invalid"
  | "page-row-count-mismatch"
  | "total-count-drift"
  | "total-count-mismatch"
  | "transaction-key-missing"
  | "transaction-key-duplicate"
  | "occurrence-context-invalid"
  | "occurrence-context-missing"
  | "occurrence-key-missing"
  | "occurrence-duplicate"
  | "occurrence-base-time-conflict"
  | "occurrence-identity-epoch-mismatch"
  | "zero-response-status-invalid"
  | "zero-page-number-invalid"
  | "zero-page-count-invalid"
  | "zero-total-count-nonzero"
  | "zero-row-count-nonzero"
  | "zero-page-row-mismatch"
  | "identity-continuity-unproven"
  | "direction-missing"
  | "direction-unknown"
  | "direction-mapping-incomplete"
  | "direction-semantics-unproven"
  | "amount-missing"
  | "amount-invalid"
  | "amount-sign-conflict"
  | "transaction-date-invalid"
  | "transaction-time-invalid"
  | "transaction-effective-time-invalid"
  | "transaction-source-time-missing"
  | "transaction-source-time-mismatch"
  | "effective-time-semantics-unproven"
  | "posting-semantics-unproven"
  | "completeness-semantics-unproven"
  | "authority-semantics-unproven"
  | "currency-scope-unproven"
  | "currency-scope-unsupported"
  | "unsupported-cancellation"
  | "source-account-identity-incomplete"
  | "source-account-identity-mismatch";

export type LineBankPreflightDiagnostic = {
  code: LineBankPreflightDiagnosticCode;
  pageNbr?: number;
  rowIndex?: number;
};

export type LineBankDomesticDepositPreflightInput = {
  account: LineBankAccount;
  scope: { startDate: string; endDate: string };
  pages: LineBankTransactionPage[];
  /**
   * Explicit staged evidence from the source adapter. It is separate from
   * provider `pdCd`/`pdNm` values because no public source contract maps
   * those values to a product identity yet.
   */
  sourceScopeEvidence?: LineBankDomesticDepositScopeEvidence;
};

export type LineBankDomesticDepositScopeEvidence = {
  evidenceVersion: string;
  route: string;
  productDescriptor: string;
  accountRole: string;
  currency: string;
};

export type LineBankDomesticDepositCurrencyEvidence =
  | {
      status: "supported";
      currency: "TWD";
      scope: typeof LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.productDescriptor;
    }
  | {
      status: "unsupported";
      currency: null;
      reason: "scope-unproven" | "scope-mismatch";
    };

export type LineBankDomesticDepositPreflightResult = {
  status: "blocked";
  readiness: typeof LINEBANK_DOMESTIC_DEPOSIT_READINESS;
  contractVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION;
  /** A redacted descriptor; raw acctNbr/arrId values never leave preflight. */
  accountKey: typeof LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR | "";
  pageCount: number;
  reportedRowCount: number | null;
  collectedRowCount: number;
  directionCodes: string[];
  directionEvidence: typeof LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE;
  currencyEvidence: LineBankDomesticDepositCurrencyEvidence;
  cancellationFlagsObserved: boolean;
  diagnostics: LineBankPreflightDiagnostic[];
};

/**
 * The strict adapter input for the shared Source Capture/Record writer.  The
 * input intentionally carries the staged page only long enough to project
 * compact Source Records; the writer never stores the response envelope.
 */
export type LineBankCanonicalCaptureInput =
  LineBankDomesticDepositPreflightInput & {
    captureId: string;
    sourceConnection: "accessibility.linebank.com.tw";
    identityEpoch: number;
    observedAt: string;
  };

export type LineBankCanonicalAdmissionDiagnosticCode =
  | "capture-id-missing"
  | "source-connection-invalid"
  | "identity-epoch-invalid"
  | "observed-at-invalid"
  | "scope-invalid"
  | "scope-evidence-missing"
  | "scope-evidence-mismatch"
  | "account-currency-unproven"
  | "pages-not-single"
  | "response-status-invalid"
  | "page-number-invalid"
  | "page-count-invalid"
  | "page-row-count-mismatch"
  | "total-count-mismatch"
  | "source-account-identity-incomplete"
  | "source-account-identity-mismatch"
  | "identity-epoch-missing"
  | "identity-epoch-mismatch"
  | "occurrence-invalid"
  | "direction-missing"
  | "direction-unknown"
  | "amount-missing"
  | "amount-invalid"
  | "amount-sign-conflict"
  | "balance-missing"
  | "balance-invalid"
  | "balance-sign-conflict"
  | "balance-transition-insufficient"
  | "balance-transition-ambiguous"
  | "balance-transition-inconsistent"
  | "source-time-invalid"
  | "cancellation-not-explicit-n"
  | "authority-envelope-missing"
  | "authority-role-unknown"
  | "authority-shared-account"
  | "authority-security-linked";

export type LineBankCanonicalAdmissionDiagnostic = {
  code: LineBankCanonicalAdmissionDiagnosticCode;
  pageNbr?: number;
  rowIndex?: number;
};

export type LineBankCanonicalCaptureValidationResult = {
  status: "source-record-admissible" | "rejected";
  stage: typeof DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE;
  canonicalAdmission: typeof DOMESTIC_DEPOSIT_CANONICAL_ADMISSION;
  accountKey: typeof LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR | "";
  capture: DomesticDepositValidatedCapture | null;
  financialAdmissionBlockers: typeof DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS;
  diagnostics: LineBankCanonicalAdmissionDiagnostic[];
};

export const LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION =
  "human-attested-v13" as const;
export const LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_AUTHORITY =
  "linebank/domestic-deposit/human-attested-v13" as const;
export const LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_READINESS =
  "canonical-live" as const;

/**
 * Human-attested integration evidence is an explicit versioned fence. It is
 * not a claim that LINE Bank publicly guarantees these semantics; the
 * attestation is the authority for this first internal admission version.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE = {
  evidenceVersion:
    LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION,
  providerGuaranteed: false,
  postedHistory: true,
  timeBasis: "transaction-time",
  timeZone: LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE,
  occurrenceRule: "txSeqNbr+crrnDpstNthCnt+txDtm",
  directionCodes: { "1": "inflow", "2": "outflow" },
  cancellationRule: "exact-N-N-only",
  completenessRule: "requested-scope-all-pages-stable-totals",
  sharedMemberRule:
    "future-membership-effective-date-required-source-unavailable-v1",
} as const;

export type LineBankHumanAttestedV13Authority = {
  kind: "personal-main";
  membershipEffectiveDate: null;
};
export type LineBankHumanAttestedV13FutureSharedAuthority = {
  kind: "shared-member";
  membershipEffectiveDate: string;
};

export type LineBankHumanAttestedV13Record = {
  sourceOccurrenceKey: string;
  baseOccurrenceKey: string;
  sourceChangeFingerprint: string;
  sourceSequence: string;
  occurrenceCounter: number;
  sourceTime: DomesticDepositSourceTime;
  direction: "inflow" | "outflow";
  sourceDirectionCode: "1" | "2";
  amount: DomesticDepositExactAmount;
  balanceAfter: DomesticDepositExactAmount | null;
  currency: "TWD";
  cancellationFlags: { cncdTxYn: "N"; cnclTxYn: "N" };
};

export type LineBankHumanAttestedV13Capture = {
  captureId: string;
  sourceConnection: "accessibility.linebank.com.tw";
  stream: typeof LINEBANK_DOMESTIC_DEPOSIT_STREAM;
  contractVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION;
  identityEpoch: number;
  accountKey: string;
  scope: { startDate: string; endDate: string };
  pages: LineBankTransactionPage[];
  records: LineBankHumanAttestedV13Record[];
  authority: LineBankHumanAttestedV13Authority;
  humanAttestation: typeof LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE;
  postingStatus: "posted";
  effectiveTimeBasis: "transaction-time";
  timeZone: typeof LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE;
  completeness: "complete-range";
  providerGuaranteed: false;
  sourceScopeEvidence: typeof LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE;
  observedAt: string;
  totalCount: number;
  pageCount: number;
  readiness: "canonical-live";
  liveValidation: "complete";
  canonicalAdmission: "admitted";
  financialAdmissionBlockers: readonly [];
};

export type LineBankHumanAttestedV13Input = LineBankCanonicalCaptureInput & {
  humanAttestation?:
    typeof LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE | undefined;
  authority?:
    | LineBankHumanAttestedV13Authority
    | LineBankHumanAttestedV13FutureSharedAuthority;
};

export type LineBankHumanAttestedV13Diagnostic =
  | "human-attestation-missing"
  | "human-attestation-mismatch"
  | "scope-invalid"
  | "pages-missing"
  | "page-sequence-invalid"
  | "page-count-drift"
  | "totals-drift"
  | "page-row-count-mismatch"
  | "terminal-page-missing"
  | "source-account-identity-incomplete"
  | "source-account-identity-mismatch"
  | "identity-epoch-mismatch"
  | "authority-role-unknown"
  | "authority-shared-account"
  | "authority-membership-date-missing"
  | "member-effective-date-before-transaction"
  | "occurrence-invalid"
  | "occurrence-collision"
  | "direction-unknown"
  | "amount-invalid"
  | "source-time-invalid"
  | "unsupported-cancellation"
  | "transaction-order-ambiguous"
  | "currency-scope-invalid";

export type LineBankHumanAttestedV13ValidationResult = {
  status: "admissible" | "rejected";
  capture: LineBankHumanAttestedV13ValidatedCapture | null;
  diagnostics: LineBankHumanAttestedV13Diagnostic[];
  readiness: "canonical-live" | "blocked";
  liveValidation: "complete" | "failed";
  financialAdmissionBlockers:
    readonly [] | typeof DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS;
};

function v13Diagnostic(
  diagnostics: LineBankHumanAttestedV13Diagnostic[],
  code: LineBankHumanAttestedV13Diagnostic,
): void {
  if (!diagnostics.includes(code)) diagnostics.push(code);
}

export function linebankHumanAttestedV13AuthorityKind(
  source: LineBankTransactionPage["source"],
): "personal-main" | "shared-member" | null {
  if (!source || typeof source.jntAcctMbrTpCd !== "string") return null;
  if (source.jntAcctMbrTpCd === "personal-main-account") return "personal-main";
  if (source.jntAcctMbrTpCd === "shared-member") return "shared-member";
  if (
    source.jntAcctMbrTpCd === "" &&
    source.jntMbrListCnt === 0 &&
    source.totJntAcctMbrCnt === 0 &&
    source.isSecuAcctBndg === false
  ) {
    return "personal-main";
  }
  return null;
}

function exactPersonalMainAuthority(
  value: unknown,
): value is LineBankHumanAttestedV13Authority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join("\u0000") ===
      "kind\u0000membershipEffectiveDate" &&
    record.kind === "personal-main" &&
    record.membershipEffectiveDate === null
  );
}

function futureSharedAuthority(
  value: unknown,
): value is LineBankHumanAttestedV13FutureSharedAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join("\u0000") ===
      "kind\u0000membershipEffectiveDate" &&
    record.kind === "shared-member" &&
    typeof record.membershipEffectiveDate === "string"
  );
}

function v13OpaqueDigest(value: unknown): string {
  return `sha256:${opaqueFingerprint(value)}`;
}

/**
 * Validate the human-attested v13 financial-admission seam.  The returned
 * capture contains only compact typed records and structural page metadata;
 * the response pages and account values never cross this boundary.
 */
export function validateLineBankHumanAttestedV13Capture(
  input: LineBankHumanAttestedV13Input,
): LineBankHumanAttestedV13ValidationResult {
  const diagnostics: LineBankHumanAttestedV13Diagnostic[] = [];
  const accountComposite = candidateAccountKey(input.account);
  const accountKey = canonicalOpaqueAccountKey(input.account);
  if (
    !input.humanAttestation ||
    input.humanAttestation !==
      LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE
  ) {
    v13Diagnostic(
      diagnostics,
      input.humanAttestation
        ? "human-attestation-mismatch"
        : "human-attestation-missing",
    );
  }
  if (
    input.sourceConnection !== "accessibility.linebank.com.tw" ||
    !clean(input.captureId)
  ) {
    v13Diagnostic(diagnostics, "scope-invalid");
  }
  if (!Number.isSafeInteger(input.identityEpoch) || input.identityEpoch < 0) {
    v13Diagnostic(diagnostics, "identity-epoch-mismatch");
  }
  if (!accountComposite || !accountKey) {
    v13Diagnostic(diagnostics, "source-account-identity-incomplete");
  }
  if (
    !validDate(input.scope.startDate) ||
    !validDate(input.scope.endDate) ||
    clean(input.scope.startDate) > clean(input.scope.endDate)
  ) {
    v13Diagnostic(diagnostics, "scope-invalid");
  }
  if (
    !canonicalScopeMatches(input.sourceScopeEvidence) ||
    input.sourceScopeEvidence?.currency !== "TWD"
  ) {
    v13Diagnostic(diagnostics, "currency-scope-invalid");
  }
  if (
    !clean(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt))
  ) {
    v13Diagnostic(diagnostics, "scope-invalid");
  }
  const authorityValue: unknown = input.authority;
  const authority = exactPersonalMainAuthority(authorityValue)
    ? authorityValue
    : null;
  const sharedAuthority = futureSharedAuthority(authorityValue)
    ? authorityValue
    : null;
  if (sharedAuthority) {
    v13Diagnostic(diagnostics, "authority-shared-account");
    if (!validDate(sharedAuthority.membershipEffectiveDate))
      v13Diagnostic(diagnostics, "authority-membership-date-missing");
    else if (
      clean(input.scope.startDate) < sharedAuthority.membershipEffectiveDate
    )
      v13Diagnostic(diagnostics, "member-effective-date-before-transaction");
  } else if (!authority) {
    v13Diagnostic(diagnostics, "authority-role-unknown");
  }

  const pages = input.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    v13Diagnostic(diagnostics, "pages-missing");
  }
  const firstPage = pages[0];
  const expectedPageCapacity = firstPage?.pageCnt;
  const expectedTotal = firstPage?.totTxCnt;
  if (
    !firstPage ||
    !Number.isSafeInteger(expectedPageCapacity) ||
    expectedPageCapacity < 1 ||
    !Number.isSafeInteger(expectedTotal) ||
    expectedTotal < 0
  ) {
    v13Diagnostic(diagnostics, "page-count-drift");
  }
  const rows: Array<{
    row: LineBankTransactionRow;
    page: LineBankTransactionPage;
    rowIndex: number;
  }> = [];
  const seenTuple = new Set<string>();
  const seenBase = new Map<string, string>();
  let totalRows = 0;
  for (const [pageIndex, page] of pages.entries()) {
    if (
      page.responseCode !== "200" ||
      page.pageNbr !== pageIndex + 1 ||
      page.pageCnt !== expectedPageCapacity
    ) {
      v13Diagnostic(diagnostics, "page-sequence-invalid");
    }
    if (page.pageCnt !== expectedPageCapacity)
      v13Diagnostic(diagnostics, "page-count-drift");
    if (page.totTxCnt !== expectedTotal)
      v13Diagnostic(diagnostics, "totals-drift");
    if (
      !Number.isSafeInteger(page.txCnt) ||
      page.txCnt !== page.rows.length ||
      page.txCnt > page.pageCnt ||
      (pageIndex < pages.length - 1 && page.txCnt !== page.pageCnt)
    )
      v13Diagnostic(diagnostics, "page-row-count-mismatch");
    totalRows += page.rows.length;
    if (page.source === undefined) {
      v13Diagnostic(diagnostics, "source-account-identity-incomplete");
      v13Diagnostic(diagnostics, "authority-role-unknown");
    } else {
      const sourceStatus = sourceAccountIdentityStatus(
        input.account,
        page.source,
      );
      if (sourceStatus === "missing")
        v13Diagnostic(diagnostics, "source-account-identity-incomplete");
      if (sourceStatus === "mismatch")
        v13Diagnostic(diagnostics, "source-account-identity-mismatch");
      if (
        !Number.isSafeInteger(page.source.opnDtm) ||
        page.source.opnDtm !== input.identityEpoch
      ) {
        v13Diagnostic(diagnostics, "identity-epoch-mismatch");
      }
      const role = linebankHumanAttestedV13AuthorityKind(page.source);
      if (role === null) v13Diagnostic(diagnostics, "authority-role-unknown");
      if (role === "shared-member")
        v13Diagnostic(diagnostics, "authority-shared-account");
      if (page.source.isSecuAcctBndg !== false)
        v13Diagnostic(diagnostics, "authority-role-unknown");
      if (
        authority &&
        (role !== "personal-main" ||
          page.source.jntMbrListCnt !== 0 ||
          page.source.totJntAcctMbrCnt !== 0)
      ) {
        v13Diagnostic(diagnostics, "authority-shared-account");
      }
      if (sharedAuthority && role !== "shared-member")
        v13Diagnostic(diagnostics, "authority-shared-account");
    }
    for (const [rowIndex, row] of page.rows.entries()) {
      rows.push({ row, page, rowIndex });
      const direction = clean(row.dpstWdrwDsCd);
      if (direction !== "1" && direction !== "2")
        v13Diagnostic(diagnostics, "direction-unknown");
      const amount = exactDomesticAmount(row.txAmt);
      if (amount === null) v13Diagnostic(diagnostics, "amount-invalid");
      if (exactDomesticAmount(row.afTxBal) === null)
        v13Diagnostic(diagnostics, "amount-invalid");
      const epoch = occurrenceEpoch(row.txDtm);
      const sequence = occurrenceSequence(row.txSeqNbr);
      const counter = occurrenceCounter(row.crrnDpstNthCnt);
      if (!epoch || !sequence || !counter) {
        v13Diagnostic(diagnostics, "occurrence-invalid");
      } else {
        const key = linebankBuildSourceOccurrenceKey(
          {
            namespace: LINEBANK_INTEGRATION_NAMESPACE,
            sourceConnection: input.sourceConnection,
            stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
            contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
            identityEpoch: input.identityEpoch,
            account: input.account,
          },
          row,
        );
        if (!key) v13Diagnostic(diagnostics, "occurrence-invalid");
        else {
          if (seenTuple.has(key.tupleDigest))
            v13Diagnostic(diagnostics, "occurrence-collision");
          const priorTuple = seenBase.get(key.baseDigest);
          if (priorTuple !== undefined && priorTuple !== key.tupleDigest)
            v13Diagnostic(diagnostics, "occurrence-collision");
          seenTuple.add(key.tupleDigest);
          seenBase.set(key.baseDigest, key.tupleDigest);
        }
      }
      if (row.cncdTxYn !== "N" || row.cnclTxYn !== "N")
        v13Diagnostic(diagnostics, "unsupported-cancellation");
      if (
        !validDate(row.txDt) ||
        !validTime(row.txTm) ||
        !validTransactionEffectiveTime(row.txDtm)
      ) {
        v13Diagnostic(diagnostics, "source-time-invalid");
      } else {
        try {
          if (
            linebankEpochMillisecondsFromSourceDateTime(row.txDt, row.txTm) !==
            row.txDtm
          )
            v13Diagnostic(diagnostics, "source-time-invalid");
        } catch {
          v13Diagnostic(diagnostics, "source-time-invalid");
        }
      }
      if (
        validDate(row.txDt) &&
        (clean(row.txDt) < clean(input.scope.startDate) ||
          clean(row.txDt) > clean(input.scope.endDate))
      )
        v13Diagnostic(diagnostics, "scope-invalid");
      if (
        sharedAuthority &&
        validDate(row.txDt) &&
        clean(row.txDt) < sharedAuthority.membershipEffectiveDate
      ) {
        v13Diagnostic(diagnostics, "member-effective-date-before-transaction");
      }
    }
  }
  const requiredPageCount =
    expectedTotal === undefined || expectedPageCapacity === undefined
      ? 0
      : Math.max(1, Math.ceil(expectedTotal / expectedPageCapacity));
  if (
    requiredPageCount !== pages.length ||
    pages.at(-1)?.pageNbr !== pages.length
  )
    v13Diagnostic(diagnostics, "terminal-page-missing");
  if (expectedTotal !== totalRows) v13Diagnostic(diagnostics, "totals-drift");

  const prepared = rows
    .map(({ row, page, rowIndex }) => ({
      row,
      page,
      rowIndex,
      amount: exactDomesticAmount(row.txAmt),
      balance: exactDomesticAmount(row.afTxBal),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        amount: DomesticDepositExactAmount;
        balance: DomesticDepositExactAmount;
      } => entry.amount !== null && entry.balance !== null,
    )
    .sort((left, right) => (left.row.txDtm ?? 0) - (right.row.txDtm ?? 0));
  const transactionTimes = new Set<number>();
  for (const current of prepared) {
    if (
      current.row.txDtm !== undefined &&
      transactionTimes.has(current.row.txDtm)
    )
      v13Diagnostic(diagnostics, "transaction-order-ambiguous");
    if (current.row.txDtm !== undefined)
      transactionTimes.add(current.row.txDtm);
  }
  for (let index = 1; index < prepared.length; index += 1) {
    const previous = prepared[index - 1]!;
    const current = prepared[index]!;
    if (current.row.txDtm === previous.row.txDtm) continue;
    const scale = Math.max(
      previous.balance.scale,
      current.balance.scale,
      current.amount.scale,
    );
    const scaled = (value: DomesticDepositExactAmount) =>
      BigInt(value.coefficient) * 10n ** BigInt(scale - value.scale);
    const delta = scaled(current.balance) - scaled(previous.balance);
    const magnitude = scaled(current.amount);
    const expected = current.row.dpstWdrwDsCd === "2" ? -magnitude : magnitude;
    if (
      (current.row.dpstWdrwDsCd === "1" || current.row.dpstWdrwDsCd === "2") &&
      delta !== expected
    ) {
      v13Diagnostic(diagnostics, "amount-invalid");
    }
  }
  if (expectedTotal !== undefined && expectedTotal !== totalRows)
    v13Diagnostic(diagnostics, "totals-drift");
  if (diagnostics.length > 0)
    return {
      status: "rejected",
      capture: null,
      diagnostics,
      readiness: "blocked",
      liveValidation: "failed",
      financialAdmissionBlockers: DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
    };

  const records: LineBankHumanAttestedV13Record[] = [];
  for (const { row } of rows) {
    const key = linebankBuildSourceOccurrenceKey(
      {
        namespace: LINEBANK_INTEGRATION_NAMESPACE,
        sourceConnection: input.sourceConnection,
        stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
        contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        identityEpoch: input.identityEpoch,
        account: input.account,
      },
      row,
    )!;
    const amount = exactDomesticAmount(row.txAmt)!;
    const balanceAfter = exactDomesticAmount(row.afTxBal);
    records.push({
      sourceOccurrenceKey: v13OpaqueDigest(key.tupleDigest),
      baseOccurrenceKey: v13OpaqueDigest(key.baseDigest),
      sourceChangeFingerprint: v13OpaqueDigest(key.changeFingerprint),
      sourceSequence: occurrenceSequence(row.txSeqNbr)!,
      occurrenceCounter: Number(occurrenceCounter(row.crrnDpstNthCnt)!),
      sourceTime: {
        localDate: row.txDt!,
        localTime: row.txTm!,
        timeZone: LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE,
        epochMilliseconds: row.txDtm!,
        basis: "source_observed",
      },
      direction: row.dpstWdrwDsCd === "1" ? "inflow" : "outflow",
      sourceDirectionCode: row.dpstWdrwDsCd as "1" | "2",
      amount,
      balanceAfter,
      currency: "TWD",
      cancellationFlags: { cncdTxYn: "N", cnclTxYn: "N" },
    });
  }
  const capture = admitLineBankHumanAttestedV13Capture({
    captureId: input.captureId,
    sourceConnection: input.sourceConnection,
    stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
    contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
    identityEpoch: input.identityEpoch,
    accountKey,
    scope: {
      startDate: clean(input.scope.startDate),
      endDate: clean(input.scope.endDate),
    },
    pages: pages.map((page) => ({
      pageNbr: page.pageNbr,
      pageCnt: page.pageCnt,
      totTxCnt: page.totTxCnt,
      txCnt: page.txCnt,
      rows: [],
    })),
    records,
    authority: { ...authority! } as LineBankHumanAttestedV13Authority,
    humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
    postingStatus: "posted",
    effectiveTimeBasis: "transaction-time",
    timeZone: LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE,
    completeness: "complete-range",
    providerGuaranteed: false,
    sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    observedAt: input.observedAt,
    totalCount: expectedTotal!,
    pageCount: requiredPageCount,
    readiness: "canonical-live",
    liveValidation: "complete",
    canonicalAdmission: "admitted",
    financialAdmissionBlockers: [],
  });
  return {
    status: "admissible",
    capture,
    diagnostics,
    readiness: "canonical-live",
    liveValidation: "complete",
    financialAdmissionBlockers: [],
  };
}

/** De-identified executable fixture used by the advertised readiness gate. */
export function validateLineBankHumanAttestedV13Fixture(): LineBankHumanAttestedV13ValidationResult {
  const source = {
    ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.source,
    opnDtm: 1700000000000,
    jntAcctMbrTpCd: "personal-main-account",
    jntMbrListCnt: 0,
    totJntAcctMbrCnt: 0,
    isSecuAcctBndg: false,
  } as LineBankTransactionPage["source"];
  const template =
    LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.rows[0]!;
  return validateLineBankHumanAttestedV13Capture({
    account: {
      ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.account,
      currCd: "TWD",
    },
    sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    captureId: "synthetic-human-attested-v13-readiness",
    sourceConnection: "accessibility.linebank.com.tw",
    identityEpoch: 1700000000000,
    scope: { startDate: "20260701", endDate: "20260731" },
    observedAt: "2026-07-06T00:00:00.000Z",
    humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
    authority: { kind: "personal-main", membershipEffectiveDate: null },
    pages: [
      {
        pageNbr: 1,
        pageCnt: 1000,
        totTxCnt: 2,
        txCnt: 2,
        responseCode: "200",
        source,
        rows: [
          {
            ...template,
            txSeqNbr: "10",
            crrnDpstNthCnt: 1,
            txDt: "20260705",
            txTm: "143738",
            txDtm: 1783233458000,
            dpstWdrwDsCd: "1",
            txAmt: "100",
            afTxBal: "1000",
            cncdTxYn: "N",
            cnclTxYn: "N",
          },
          {
            ...template,
            txSeqNbr: "10",
            crrnDpstNthCnt: 2,
            txDt: "20260705",
            txTm: "143739",
            txDtm: 1783233459000,
            dpstWdrwDsCd: "2",
            txAmt: "100",
            afTxBal: "900",
            cncdTxYn: "N",
            cnclTxYn: "N",
          },
        ],
      },
    ],
  });
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const TIME_RE = /^(\d{2})(\d{2})(\d{2})$/;
const DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const KNOWN_DIRECTION_CODES = new Set(["1", "2"]);
const NON_CANCELLED_FLAGS = new Set(["", "0", "N", "n", "false", "FALSE"]);

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function candidateAccountKey(account: LineBankAccount): string {
  const acctNbr = clean(account.acctNbr);
  const arrId = clean(account.arrId);
  return acctNbr && arrId ? `${acctNbr}:${arrId}` : "";
}

type SourceAccountIdentityStatus = "match" | "missing" | "mismatch";

function sourceAccountIdentityStatus(
  account: LineBankAccount,
  source: LineBankTransactionPage["source"],
): SourceAccountIdentityStatus {
  const expected = candidateAccountKey(account);
  const actual = source ? candidateAccountKey(source) : "";
  if (!expected || !actual) return "missing";
  return expected === actual ? "match" : "mismatch";
}

const PROVIDER_LOOKING_CANDIDATE_FIELDS = [
  "txSeqNbr",
  "ctptCustLineUid",
  "fxsTxId",
  "rltvTxArrId",
  "txCaseCd",
  "bizTxFuncTpCd",
] as const;

const ENVELOPE_COMPARISON_FIELDS = [
  "acctNbr",
  "arrId",
  "acctNick",
  "pdCd",
  "pdNm",
  "simpAcctTpCd",
  "jntAcctMbrTpCd",
  "isSecuAcctBndg",
  "debitCardFundBlcknYn",
  "txBlcknYn",
  "opnDtm",
] as const;

function opaqueFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function occurrenceSequence(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const normalized = value.trim();
  return BigInt(normalized) > 0n ? BigInt(normalized).toString() : null;
}

function occurrenceCounter(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function occurrenceEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function occurrenceContextParts(
  context: LineBankOccurrenceCaptureContext,
): [string, string, string, string, string, string, string] | null {
  const accountComposite = candidateAccountKey(context.account);
  const identityEpoch = occurrenceEpoch(context.identityEpoch);
  if (
    context.namespace !== LINEBANK_INTEGRATION_NAMESPACE ||
    context.sourceConnection !== "accessibility.linebank.com.tw" ||
    context.stream !== LINEBANK_DOMESTIC_DEPOSIT_STREAM ||
    !clean(context.contractVersion) ||
    !accountComposite ||
    identityEpoch === null
  ) {
    return null;
  }
  return [
    LINEBANK_INTEGRATION_NAMESPACE,
    "accessibility.linebank.com.tw",
    LINEBANK_DOMESTIC_DEPOSIT_STREAM,
    clean(context.contractVersion),
    String(identityEpoch),
    accountComposite,
    LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
  ];
}

/**
 * Build an opaque occurrence key.  This helper never returns source values;
 * null means the capture must be rejected by the caller.
 */
export function linebankBuildSourceOccurrenceKey(
  context: LineBankOccurrenceCaptureContext,
  row: LineBankTransactionRow,
): LineBankSourceOccurrenceKey | null {
  const contextParts = occurrenceContextParts(context);
  const txDtm = occurrenceEpoch(row.txDtm);
  const txSeqNbr = occurrenceSequence(row.txSeqNbr);
  const crrnDpstNthCnt = occurrenceCounter(row.crrnDpstNthCnt);
  if (
    contextParts === null ||
    txDtm === null ||
    txSeqNbr === null ||
    crrnDpstNthCnt === null
  ) {
    return null;
  }
  const baseParts = [...contextParts, txSeqNbr, crrnDpstNthCnt];
  const tupleParts = [...baseParts, String(txDtm)];
  return {
    matchingRuleVersion:
      LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
    baseDigest: opaqueFingerprint(baseParts),
    tupleDigest: opaqueFingerprint(tupleParts),
    changeFingerprint: opaqueFingerprint([
      row.txDt ?? null,
      row.txTm ?? null,
      row.dpstWdrwDsCd ?? null,
      row.txAmt ?? null,
      row.afTxBal ?? null,
      row.cncdTxYn ?? null,
      row.cnclTxYn ?? null,
    ]),
  };
}

/** Validate one capture atomically; blocked captures return no usable keys. */
export function linebankValidateSourceOccurrenceCapture(
  capture: LineBankOccurrenceCapture,
): LineBankOccurrenceValidationResult {
  const diagnostics: LineBankOccurrenceValidationResult["diagnostics"] = [];
  if (occurrenceContextParts(capture.context) === null) {
    diagnostics.push({ code: "occurrence-context-invalid" });
  }
  const keys: LineBankSourceOccurrenceKey[] = [];
  const seenTuples = new Set<string>();
  const seenBases = new Map<string, string>();
  for (const [rowIndex, row] of capture.rows.entries()) {
    const key = linebankBuildSourceOccurrenceKey(capture.context, row);
    if (key === null) {
      diagnostics.push({ code: "occurrence-key-missing", rowIndex });
      continue;
    }
    if (seenTuples.has(key.tupleDigest)) {
      diagnostics.push({ code: "occurrence-duplicate", rowIndex });
    }
    const previousTime = seenBases.get(key.baseDigest);
    if (previousTime !== undefined && previousTime !== key.tupleDigest) {
      diagnostics.push({ code: "occurrence-base-time-conflict", rowIndex });
    }
    seenTuples.add(key.tupleDigest);
    seenBases.set(key.baseDigest, key.tupleDigest);
    keys.push(key);
  }
  return {
    matchingRuleVersion:
      LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
    providerGuaranteed: false,
    status: diagnostics.length === 0 ? "valid" : "blocked",
    keys: diagnostics.length === 0 ? keys : [],
    diagnostics,
  };
}

/**
 * Compare captures without exposing raw rows.  A same tuple with changed
 * financial/source fields is a conflict, never an overwrite or revision.
 */
export function linebankCompareSourceOccurrenceCaptures(
  previous: LineBankOccurrenceCapture,
  current: LineBankOccurrenceCapture,
): LineBankOccurrenceComparison {
  const previousValidation = linebankValidateSourceOccurrenceCapture(previous);
  const currentValidation = linebankValidateSourceOccurrenceCapture(current);
  const diagnostics: LineBankOccurrenceComparison["diagnostics"] = [];
  if (
    previousValidation.status === "blocked" ||
    currentValidation.status === "blocked"
  ) {
    diagnostics.push("capture-invalid");
  }
  const previousByTuple = new Map(
    previousValidation.keys.map((key) => [key.tupleDigest, key]),
  );
  const previousByBase = new Map(
    previousValidation.keys.map((key) => [key.baseDigest, key]),
  );
  let overlapCount = 0;
  let stableObservationCount = 0;
  let conflictCount = 0;
  for (const currentKey of currentValidation.keys) {
    const previousKey = previousByTuple.get(currentKey.tupleDigest);
    if (!previousKey) {
      const previousBaseKey = previousByBase.get(currentKey.baseDigest);
      if (
        previousBaseKey &&
        previousBaseKey.tupleDigest !== currentKey.tupleDigest
      ) {
        conflictCount += 1;
        diagnostics.push("source-base-conflict");
      }
      continue;
    }
    overlapCount += 1;
    if (previousKey.changeFingerprint === currentKey.changeFingerprint) {
      stableObservationCount += 1;
    } else {
      conflictCount += 1;
      diagnostics.push("source-conflict");
    }
  }
  const absenceWithoutComparableCompleteness =
    overlapCount === 0 &&
    !(previous.comparableCompleteness && current.comparableCompleteness);
  if (absenceWithoutComparableCompleteness) {
    diagnostics.push("absence-incomparable");
  }
  const status = diagnostics.includes("capture-invalid")
    ? "not-comparable"
    : conflictCount > 0
      ? "conflict"
      : overlapCount > 0
        ? "stable"
        : "no-overlap";
  return {
    matchingRuleVersion:
      LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
    providerGuaranteed: false,
    status,
    overlapCount,
    stableObservationCount,
    conflictCount,
    absenceWithoutComparableCompleteness,
    withdrawalAuthorized: false,
    diagnostics: [...new Set(diagnostics)],
  };
}

/** Accept only the provider-explicit structural shape of an empty page. */
export function linebankValidateZeroResultPage(
  page: LineBankTransactionPage,
): LineBankZeroResultValidationResult {
  const diagnostics: LineBankZeroResultDiagnosticCode[] = [];
  if (page.responseCode !== "200")
    diagnostics.push("zero-response-status-invalid");
  if (page.pageNbr !== 1) diagnostics.push("zero-page-number-invalid");
  if (!Number.isInteger(page.pageCnt) || page.pageCnt < 1)
    diagnostics.push("zero-page-count-invalid");
  if (page.totTxCnt !== 0) diagnostics.push("zero-total-count-nonzero");
  if (page.txCnt !== 0) diagnostics.push("zero-row-count-nonzero");
  if (page.rows.length !== 0) diagnostics.push("zero-row-count-nonzero");
  if (page.txCnt !== page.rows.length)
    diagnostics.push("zero-page-row-mismatch");
  return {
    status: diagnostics.length === 0 ? "accepted" : "blocked",
    diagnostics: [...new Set(diagnostics)],
  };
}

function zeroResultIdentityFingerprint(
  capture: LineBankZeroResultCapture,
): string | null {
  const accountComposite = candidateAccountKey(capture.account);
  if (
    !accountComposite ||
    occurrenceEpoch(capture.identityEpoch) === null ||
    !clean(capture.contractVersion)
  ) {
    return null;
  }
  return opaqueFingerprint([
    LINEBANK_INTEGRATION_NAMESPACE,
    "accessibility.linebank.com.tw",
    LINEBANK_DOMESTIC_DEPOSIT_STREAM,
    clean(capture.contractVersion),
    String(capture.identityEpoch),
    accountComposite,
  ]);
}

function zeroResultScopeFingerprint(
  capture: LineBankZeroResultCapture,
): string | null {
  const values = [
    clean(capture.scope.startDate),
    clean(capture.scope.endDate),
    clean(capture.scope.accountFilter),
    clean(capture.scope.currencyFilter).toUpperCase(),
  ];
  return values.every(Boolean) ? opaqueFingerprint(values) : null;
}

function zeroResultPageMetadataFingerprint(
  page: LineBankTransactionPage,
): string {
  return opaqueFingerprint([
    page.responseCode ?? null,
    page.pageNbr,
    page.pageCnt,
    page.totTxCnt,
    page.txCnt,
    page.rows.length,
  ]);
}

/** Compare empty captures without treating a narrow-window absence as a delete. */
export function linebankCompareZeroResultCaptures(
  previous: LineBankZeroResultCapture,
  current: LineBankZeroResultCapture,
): LineBankZeroResultComparison {
  const diagnostics: LineBankZeroResultComparison["diagnostics"] = [];
  if (
    linebankValidateZeroResultPage(previous.page).status === "blocked" ||
    linebankValidateZeroResultPage(current.page).status === "blocked" ||
    zeroResultIdentityFingerprint(previous) === null ||
    zeroResultIdentityFingerprint(current) === null ||
    zeroResultScopeFingerprint(previous) === null ||
    zeroResultScopeFingerprint(current) === null
  ) {
    diagnostics.push("capture-invalid");
  } else if (
    sourceAccountIdentityStatus(previous.account, previous.page.source) !==
      "match" ||
    sourceAccountIdentityStatus(current.account, current.page.source) !==
      "match"
  ) {
    diagnostics.push("source-identity-invalid");
  } else if (
    zeroResultIdentityFingerprint(previous) !==
    zeroResultIdentityFingerprint(current)
  ) {
    diagnostics.push("context-separated");
  } else if (
    zeroResultScopeFingerprint(previous) !== zeroResultScopeFingerprint(current)
  ) {
    diagnostics.push("scope-separated");
  } else if (
    zeroResultPageMetadataFingerprint(previous.page) !==
    zeroResultPageMetadataFingerprint(current.page)
  ) {
    diagnostics.push("page-metadata-drift");
  }
  const absenceWithoutComparableCompleteness = !(
    previous.comparableCompleteness && current.comparableCompleteness
  );
  if (absenceWithoutComparableCompleteness)
    diagnostics.push("absence-incomparable");
  return {
    status: diagnostics.length === 0 ? "stable" : "not-comparable",
    providerGuaranteed: false,
    absenceWithoutComparableCompleteness,
    withdrawalAuthorized: false,
    revisionAuthorized: false,
    diagnostics: [...new Set(diagnostics)],
  };
}

function rowFingerprint(
  row: LineBankTransactionRow,
  fields: readonly string[] = Object.keys(row).sort(),
): string {
  const record = row as Record<string, unknown>;
  return opaqueFingerprint(
    fields.map((field) => [field, record[field] ?? null]),
  );
}

function rowMultisetOverlap(
  left: readonly LineBankTransactionRow[],
  right: readonly LineBankTransactionRow[],
  fields?: readonly string[],
): number {
  const counts = new Map<string, number>();
  for (const row of left) {
    const fingerprint = rowFingerprint(row, fields);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  let overlap = 0;
  for (const row of right) {
    const fingerprint = rowFingerprint(row, fields);
    const count = counts.get(fingerprint) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(fingerprint, count - 1);
    }
  }
  return overlap;
}

function duplicateGroupCount(
  rows: readonly LineBankTransactionRow[],
  fields: readonly string[],
): { uniqueCount: number; duplicateGroupCount: number } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const fingerprint = rowFingerprint(row, fields);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return {
    uniqueCount: counts.size,
    duplicateGroupCount: [...counts.values()].filter((count) => count > 1)
      .length,
  };
}

function envelopeFingerprint(
  source: LineBankTransactionPage["source"],
): string | null {
  if (!source) return null;
  const record = source as Record<string, unknown>;
  return opaqueFingerprint(
    ENVELOPE_COMPARISON_FIELDS.map((field) => [field, record[field] ?? null]),
  );
}

/**
 * Compare two already-captured windows without returning candidate values.
 * Fingerprints are local opaque intermediates only; this summary is not an
 * identity assertion and cannot authorize a writer or readiness promotion.
 */
export function linebankSummarizeCrossWindowEvidence(
  evidence: LineBankCrossWindowEvidence,
): LineBankCrossWindowEvidenceSummary {
  const longRows = evidence.longWindow.pages.flatMap((page) => page.rows);
  const shortRows = evidence.shortWindow.pages.flatMap((page) => page.rows);
  const txSeqSummary = duplicateGroupCount(longRows, ["txSeqNbr"]);
  const txSeqCrrnSummary = duplicateGroupCount(longRows, [
    "txSeqNbr",
    "crrnDpstNthCnt",
  ]);
  const txSeqDtmSummary = duplicateGroupCount(longRows, ["txSeqNbr", "txDtm"]);
  const providerSummary = duplicateGroupCount(
    longRows,
    PROVIDER_LOOKING_CANDIDATE_FIELDS,
  );
  const longSource = evidence.longWindow.pages[0]?.source;
  const shortSource = evidence.shortWindow.pages[0]?.source;
  return {
    evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_VERSION,
    accountCompositeEqual:
      candidateAccountKey(evidence.longWindow.account) !== "" &&
      candidateAccountKey(evidence.longWindow.account) ===
        candidateAccountKey(evidence.shortWindow.account),
    envelopeStable:
      envelopeFingerprint(longSource) !== null &&
      envelopeFingerprint(longSource) === envelopeFingerprint(shortSource),
    fullRawRowEqualityCount: rowMultisetOverlap(longRows, shortRows),
    candidateTupleOverlapCount: rowMultisetOverlap(
      longRows,
      shortRows,
      LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_CANDIDATE_FIELDS,
    ),
    longWindowTxSeqDuplicateGroupCount: txSeqSummary.duplicateGroupCount,
    longWindowTxSeqCrrnEmpiricallyUnique:
      txSeqCrrnSummary.uniqueCount === longRows.length &&
      txSeqCrrnSummary.duplicateGroupCount === 0,
    longWindowTxSeqDtmEmpiricallyUnique:
      txSeqDtmSummary.uniqueCount === longRows.length &&
      txSeqDtmSummary.duplicateGroupCount === 0,
    longWindowProviderTupleEmpiricallyUnique:
      providerSummary.uniqueCount === longRows.length &&
      providerSummary.duplicateGroupCount === 0,
    candidateUsesAmount: false,
    candidateUsesDescription: false,
    candidateUsesBalance: false,
    candidateUsesContentHash: false,
    candidateUsesRowOrder: false,
    nullableLinkageCanIdentify: false,
    identityStatus: "observed-not-provider-guaranteed",
  };
}

function validDate(value: unknown): boolean {
  const match = clean(value).match(DATE_RE);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function validTime(value: unknown): boolean {
  const match = clean(value).match(TIME_RE);
  return Boolean(
    match &&
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    Number(match[3]) < 60,
  );
}

function validTransactionEffectiveTime(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decimalLexeme(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const lexeme = value.trim();
  return DECIMAL_RE.test(lexeme) ? lexeme : null;
}

function exactDomesticAmount(
  value: unknown,
): DomesticDepositExactAmount | null {
  const lexeme = decimalLexeme(value);
  if (lexeme === null || lexeme.startsWith("-")) return null;
  const [whole, fraction = ""] = lexeme.split(".");
  const coefficient = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return { coefficient, scale: fraction.length };
}

function canonicalOpaqueAccountKey(account: LineBankAccount): string {
  const composite = candidateAccountKey(account);
  return composite
    ? `sha256:${opaqueFingerprint([LINEBANK_INTEGRATION_NAMESPACE, "account", composite])}`
    : "";
}

function canonicalScopeMatches(
  scope: LineBankDomesticDepositScopeEvidence | undefined,
): boolean {
  return Boolean(
    scope &&
    scope.evidenceVersion ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.evidenceVersion &&
    scope.route === LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.route &&
    scope.productDescriptor ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.productDescriptor &&
    scope.accountRole ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.accountRole &&
    scope.currency === LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.currency,
  );
}

function canonicalDiagnostic(
  diagnostics: LineBankCanonicalAdmissionDiagnostic[],
  code: LineBankCanonicalAdmissionDiagnosticCode,
  pageNbr?: number,
  rowIndex?: number,
): void {
  diagnostics.push({
    code,
    ...(pageNbr === undefined ? {} : { pageNbr }),
    ...(rowIndex === undefined ? {} : { rowIndex }),
  });
}

function canonicalSourceRecord(
  input: LineBankCanonicalCaptureInput,
  row: LineBankTransactionRow,
  key: LineBankSourceOccurrenceKey,
  accountKey: string,
): DomesticDepositSourceRecord | null {
  const amount = exactDomesticAmount(row.txAmt);
  const balanceAfter = exactDomesticAmount(row.afTxBal);
  const sourceSequence = occurrenceSequence(row.txSeqNbr);
  const rawCounter = occurrenceCounter(row.crrnDpstNthCnt);
  if (
    !amount ||
    !balanceAfter ||
    !sourceSequence ||
    !rawCounter ||
    !row.txDt ||
    !row.txTm ||
    row.txDtm === undefined
  )
    return null;
  const direction =
    row.dpstWdrwDsCd === "1"
      ? "inflow"
      : row.dpstWdrwDsCd === "2"
        ? "outflow"
        : null;
  if (!direction || row.cncdTxYn !== "N" || row.cnclTxYn !== "N") return null;
  return {
    sourceOccurrenceKey: `sha256:${key.tupleDigest}`,
    baseOccurrenceKey: `sha256:${key.baseDigest}`,
    sourceChangeFingerprint: `sha256:${key.changeFingerprint}`,
    accountKey,
    sourceConnection: input.sourceConnection,
    stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
    contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
    identityEpoch: input.identityEpoch,
    sourceSequence,
    occurrenceCounter: Number(rawCounter),
    sourceSequenceKey: `sha256:${key.baseDigest}`,
    sourceTime: {
      localDate: row.txDt,
      localTime: row.txTm,
      timeZone: LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE,
      epochMilliseconds: row.txDtm,
      basis: "source_observed",
    },
    direction,
    sourceDirectionCode: row.dpstWdrwDsCd as "1" | "2",
    amount,
    balanceAfter,
    currency: "TWD",
    cancellation: "N",
    cancellationFlags: { cncdTxYn: "N", cnclTxYn: "N" },
    provenance: {
      captureId: input.captureId,
      matchingRuleVersion: key.matchingRuleVersion,
    },
  };
}

function validateSourceAuthority(
  page: LineBankTransactionPage,
  diagnostics: LineBankCanonicalAdmissionDiagnostic[],
): void {
  const source = page.source;
  const sourceFields = (source ?? {}) as Record<string, unknown>;
  const role = clean(source?.jntAcctMbrTpCd).toLowerCase();
  // Both short aliases and the longer response names have appeared in the
  // staged source envelope. Their only admitted shape is an explicit zero.
  const memberCount = sourceFields.jntAcctMbrCnt ?? sourceFields.jntMbrListCnt;
  const totalMemberCount =
    sourceFields.jntAcctMbrDpstCnt ?? sourceFields.totJntAcctMbrCnt;
  const securityLinked = source?.isSecuAcctBndg;
  if (
    !role ||
    typeof memberCount !== "number" ||
    !Number.isSafeInteger(memberCount) ||
    memberCount < 0 ||
    typeof totalMemberCount !== "number" ||
    !Number.isSafeInteger(totalMemberCount) ||
    totalMemberCount < 0 ||
    typeof securityLinked !== "boolean"
  ) {
    canonicalDiagnostic(
      diagnostics,
      "authority-envelope-missing",
      page.pageNbr,
    );
    return;
  }
  if (
    role.includes("joint") ||
    role.includes("shared") ||
    role.includes("共同") ||
    memberCount !== 0 ||
    totalMemberCount !== 0
  ) {
    canonicalDiagnostic(diagnostics, "authority-shared-account", page.pageNbr);
  } else if (!(
    (role.includes("personal") && role.includes("main")) ||
    (role.includes("個人") && role.includes("主"))
  )) {
    canonicalDiagnostic(diagnostics, "authority-role-unknown", page.pageNbr);
  }
  if (securityLinked) {
    canonicalDiagnostic(diagnostics, "authority-security-linked", page.pageNbr);
  }
}

function validateBalanceTransitions(
  page: LineBankTransactionPage,
  diagnostics: LineBankCanonicalAdmissionDiagnostic[],
): void {
  if (page.rows.length === 0) return;
  if (page.rows.length === 1) {
    canonicalDiagnostic(
      diagnostics,
      "balance-transition-insufficient",
      page.pageNbr,
      0,
    );
    return;
  }
  const prepared = page.rows.map((row, rowIndex) => ({
    row,
    rowIndex,
    amount: exactDomesticAmount(row.txAmt),
    balance: exactDomesticAmount(row.afTxBal),
    txDtm: row.txDtm,
  }));
  if (
    prepared.some(
      (item) =>
        !item.amount ||
        !item.balance ||
        !validTransactionEffectiveTime(item.txDtm),
    )
  ) {
    return;
  }
  const ordered = [...prepared].sort(
    (left, right) => left.txDtm! - right.txDtm!,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.txDtm === previous.txDtm) {
      canonicalDiagnostic(
        diagnostics,
        "balance-transition-ambiguous",
        page.pageNbr,
        current.rowIndex,
      );
      continue;
    }
    const scale = Math.max(
      previous.balance!.scale,
      current.balance!.scale,
      current.amount!.scale,
    );
    const power = (value: DomesticDepositExactAmount) =>
      BigInt(value.coefficient) * 10n ** BigInt(scale - value.scale);
    const delta = power(current.balance!) - power(previous.balance!);
    const expectedMagnitude = power(current.amount!);
    const expected =
      current.row.dpstWdrwDsCd === "2" ? -expectedMagnitude : expectedMagnitude;
    if (current.row.dpstWdrwDsCd !== "1" && current.row.dpstWdrwDsCd !== "2") {
      continue;
    }
    if (delta !== expected) {
      canonicalDiagnostic(
        diagnostics,
        "balance-transition-inconsistent",
        page.pageNbr,
        current.rowIndex,
      );
    }
  }
}

/**
 * Validate the narrow Source Capture/Record boundary for LINE Bank. A valid
 * result is still explicitly blocked for Financial Transaction admission: the
 * source does not prove provider identity, posting/effective-time meaning,
 * complete-range authority, cancellation lifecycle, or shared-account
 * authority. This seam therefore enables safe compact evidence persistence
 * without manufacturing a posted canonical transaction.
 */
export function validateLineBankCanonicalCapture(
  input: LineBankCanonicalCaptureInput,
): LineBankCanonicalCaptureValidationResult {
  const diagnostics: LineBankCanonicalAdmissionDiagnostic[] = [];
  const accountKey = candidateAccountKey(input.account)
    ? LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR
    : "";
  const opaqueAccountKey = canonicalOpaqueAccountKey(input.account);
  if (!clean(input.captureId))
    canonicalDiagnostic(diagnostics, "capture-id-missing");
  if (input.sourceConnection !== "accessibility.linebank.com.tw")
    canonicalDiagnostic(diagnostics, "source-connection-invalid");
  if (!Number.isSafeInteger(input.identityEpoch) || input.identityEpoch < 0)
    canonicalDiagnostic(diagnostics, "identity-epoch-invalid");
  if (
    !clean(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt))
  )
    canonicalDiagnostic(diagnostics, "observed-at-invalid");
  if (!canonicalScopeMatches(input.sourceScopeEvidence)) {
    canonicalDiagnostic(
      diagnostics,
      input.sourceScopeEvidence
        ? "scope-evidence-mismatch"
        : "scope-evidence-missing",
    );
  }
  const explicitCurrency = clean(
    input.account.currCd ??
      input.account.ccyCd ??
      input.account.crncyCd ??
      input.account.currency,
  ).toUpperCase();
  if (explicitCurrency !== "TWD")
    canonicalDiagnostic(diagnostics, "account-currency-unproven");
  if (
    !validDate(input.scope.startDate) ||
    !validDate(input.scope.endDate) ||
    clean(input.scope.startDate) > clean(input.scope.endDate)
  )
    canonicalDiagnostic(diagnostics, "scope-invalid");
  if (input.pages.length !== 1)
    canonicalDiagnostic(diagnostics, "pages-not-single");

  const page = input.pages[0];
  const pageNbr = page?.pageNbr;
  if (!page) {
    canonicalDiagnostic(diagnostics, "pages-not-single");
  } else {
    if (page.responseCode !== "200")
      canonicalDiagnostic(diagnostics, "response-status-invalid", pageNbr);
    if (page.pageNbr !== 1)
      canonicalDiagnostic(diagnostics, "page-number-invalid", pageNbr);
    if (!Number.isInteger(page.pageCnt) || page.pageCnt < 1)
      canonicalDiagnostic(diagnostics, "page-count-invalid", pageNbr);
    if (page.txCnt !== page.rows.length)
      canonicalDiagnostic(diagnostics, "page-row-count-mismatch", pageNbr);
    if (page.totTxCnt !== page.txCnt)
      canonicalDiagnostic(diagnostics, "total-count-mismatch", pageNbr);
    const sourceStatus = sourceAccountIdentityStatus(
      input.account,
      page.source,
    );
    if (sourceStatus === "missing")
      canonicalDiagnostic(
        diagnostics,
        "source-account-identity-incomplete",
        pageNbr,
      );
    if (sourceStatus === "mismatch")
      canonicalDiagnostic(
        diagnostics,
        "source-account-identity-mismatch",
        pageNbr,
      );
    if (!page.source?.opnDtm)
      canonicalDiagnostic(diagnostics, "identity-epoch-missing", pageNbr);
    else if (page.source.opnDtm !== input.identityEpoch)
      canonicalDiagnostic(diagnostics, "identity-epoch-mismatch", pageNbr);
    validateSourceAuthority(page, diagnostics);

    const zeroResult =
      page.totTxCnt === 0 ? linebankValidateZeroResultPage(page) : null;
    if (zeroResult?.status === "blocked")
      canonicalDiagnostic(diagnostics, "total-count-mismatch", pageNbr);
    const occurrenceValidation = linebankValidateSourceOccurrenceCapture({
      context: {
        namespace: LINEBANK_INTEGRATION_NAMESPACE,
        sourceConnection: "accessibility.linebank.com.tw",
        stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
        contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        identityEpoch: input.identityEpoch,
        account: input.account,
      },
      rows: page.rows,
      comparableCompleteness: false,
    });
    if (occurrenceValidation.status === "blocked")
      canonicalDiagnostic(diagnostics, "occurrence-invalid", pageNbr);

    const records: DomesticDepositSourceRecord[] = [];
    if (occurrenceValidation.status === "valid") {
      for (const [rowIndex, row] of page.rows.entries()) {
        const direction = clean(row.dpstWdrwDsCd);
        if (!direction)
          canonicalDiagnostic(
            diagnostics,
            "direction-missing",
            pageNbr,
            rowIndex,
          );
        else if (!KNOWN_DIRECTION_CODES.has(direction))
          canonicalDiagnostic(
            diagnostics,
            "direction-unknown",
            pageNbr,
            rowIndex,
          );
        const amount = exactDomesticAmount(row.txAmt);
        if (
          row.txAmt === undefined ||
          row.txAmt === null ||
          clean(row.txAmt) === ""
        )
          canonicalDiagnostic(diagnostics, "amount-missing", pageNbr, rowIndex);
        else if (!amount)
          canonicalDiagnostic(
            diagnostics,
            decimalLexeme(row.txAmt)?.startsWith("-")
              ? "amount-sign-conflict"
              : "amount-invalid",
            pageNbr,
            rowIndex,
          );
        const balance = exactDomesticAmount(row.afTxBal);
        if (
          row.afTxBal === undefined ||
          row.afTxBal === null ||
          clean(row.afTxBal) === ""
        )
          canonicalDiagnostic(
            diagnostics,
            "balance-missing",
            pageNbr,
            rowIndex,
          );
        else if (!balance)
          canonicalDiagnostic(
            diagnostics,
            decimalLexeme(row.afTxBal)?.startsWith("-")
              ? "balance-sign-conflict"
              : "balance-invalid",
            pageNbr,
            rowIndex,
          );
        if (
          !validDate(row.txDt) ||
          !validTime(row.txTm) ||
          !validTransactionEffectiveTime(row.txDtm)
        )
          canonicalDiagnostic(
            diagnostics,
            "source-time-invalid",
            pageNbr,
            rowIndex,
          );
        else {
          try {
            if (
              linebankEpochMillisecondsFromSourceDateTime(
                row.txDt,
                row.txTm,
              ) !== row.txDtm
            )
              canonicalDiagnostic(
                diagnostics,
                "source-time-invalid",
                pageNbr,
                rowIndex,
              );
          } catch {
            canonicalDiagnostic(
              diagnostics,
              "source-time-invalid",
              pageNbr,
              rowIndex,
            );
          }
        }
        if (row.cncdTxYn !== "N" || row.cnclTxYn !== "N")
          canonicalDiagnostic(
            diagnostics,
            "cancellation-not-explicit-n",
            pageNbr,
            rowIndex,
          );
        const key = occurrenceValidation.keys[rowIndex];
        if (key) {
          const record = canonicalSourceRecord(
            input,
            row,
            key,
            opaqueAccountKey,
          );
          if (record) records.push(record);
        }
      }
      validateBalanceTransitions(page, diagnostics);
    }

    if (diagnostics.length === 0) {
      const capture: DomesticDepositCapture = {
        captureId: input.captureId,
        sourceConnection: input.sourceConnection,
        stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
        contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        identityEpoch: input.identityEpoch,
        accountKey: opaqueAccountKey,
        scope: {
          startDate: clean(input.scope.startDate),
          endDate: clean(input.scope.endDate),
          completeness: "transport-exact-single-page",
          evidenceVersion:
            input.sourceScopeEvidence?.evidenceVersion ??
            LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION,
        },
        transport: {
          responseCode: "200",
          pageNbr: 1,
          pageCapacity: page.pageCnt,
          reportedRowCount: page.totTxCnt,
          collectedRowCount: page.rows.length,
          terminal: true,
        },
        ruleVersions: {
          contract: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
          matching: LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
          direction: LINEBANK_DOMESTIC_DEPOSIT_DIRECTION_EVIDENCE_VERSION,
          time: LINEBANK_DOMESTIC_DEPOSIT_TIME_EVIDENCE_VERSION,
        },
        observedAt: input.observedAt,
        canonicalAdmission: DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
        financialAdmissionBlockers:
          DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
        records,
      };
      const validatedCapture = admitDomesticDepositCapture(capture);
      return {
        status: "source-record-admissible",
        stage: DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE,
        canonicalAdmission: DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
        accountKey,
        capture: validatedCapture,
        financialAdmissionBlockers:
          DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
        diagnostics,
      };
    }
  }
  return {
    status: "rejected",
    stage: DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE,
    canonicalAdmission: DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
    accountKey,
    capture: null,
    financialAdmissionBlockers: DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
    diagnostics,
  };
}

function transactionKey(row: LineBankTransactionRow): string {
  const value = row.txSeqNbr;
  if (value === undefined || value === null) return "";
  const key = String(value).trim();
  return /^\d+$/.test(key) && BigInt(key) > 0n ? key : "";
}

function push(
  diagnostics: LineBankPreflightDiagnostic[],
  code: LineBankPreflightDiagnosticCode,
  pageNbr?: number,
  rowIndex?: number,
): void {
  diagnostics.push({
    code,
    ...(pageNbr === undefined ? {} : { pageNbr }),
    ...(rowIndex === undefined ? {} : { rowIndex }),
  });
}

type LineBankCurrencyResolution = {
  evidence: LineBankDomesticDepositCurrencyEvidence;
  diagnostic: "currency-scope-unproven" | "currency-scope-unsupported" | null;
};

/**
 * Currency is admitted only when a staged source envelope and the explicit
 * versioned scope descriptor agree. Missing or unknown product evidence never
 * falls back to TWD, even though the legacy workflow historically did so.
 */
function resolveCurrencyEvidence(
  input: LineBankDomesticDepositPreflightInput,
): LineBankCurrencyResolution {
  const scope = input.sourceScopeEvidence;
  const expectedAccountKey = candidateAccountKey(input.account);
  const hasProvenSourceEnvelope =
    expectedAccountKey !== "" &&
    input.pages.length > 0 &&
    input.pages.every((page) => {
      const sourceKey = page.source ? candidateAccountKey(page.source) : "";
      return sourceKey !== "" && sourceKey === expectedAccountKey;
    });
  if (!scope || !hasProvenSourceEnvelope) {
    return {
      evidence: {
        status: "unsupported",
        currency: null,
        reason: "scope-unproven",
      },
      diagnostic: "currency-scope-unproven",
    };
  }
  const matchesSupportedScope =
    scope.evidenceVersion ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.evidenceVersion &&
    scope.route === LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.route &&
    scope.productDescriptor ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.productDescriptor &&
    scope.accountRole ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.accountRole &&
    scope.currency === LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.currency;
  if (!matchesSupportedScope) {
    return {
      evidence: {
        status: "unsupported",
        currency: null,
        reason: "scope-mismatch",
      },
      diagnostic: "currency-scope-unsupported",
    };
  }
  return {
    evidence: {
      status: "supported",
      currency: "TWD",
      scope: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.productDescriptor,
    },
    diagnostic: null,
  };
}

/**
 * Validate the source envelope before any legacy or canonical write.  The
 * return type deliberately has no accepted-row output: the unresolved source
 * semantics are an explicit blocker even when all transport invariants pass.
 */
export function preflightLineBankDomesticDeposit(
  input: LineBankDomesticDepositPreflightInput,
): LineBankDomesticDepositPreflightResult {
  const diagnostics: LineBankPreflightDiagnostic[] = [];
  const currencyResolution = resolveCurrencyEvidence(input);
  if (currencyResolution.diagnostic)
    push(diagnostics, currencyResolution.diagnostic);
  const candidateKey = candidateAccountKey(input.account);
  if (!candidateKey) push(diagnostics, "account-key-missing");
  const accountKey = candidateKey
    ? LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR
    : "";
  const startDate = clean(input.scope.startDate);
  const endDate = clean(input.scope.endDate);
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    push(diagnostics, "scope-invalid");
  }

  // Direction codes 1 and 2 now have an observed-versioned projection mapping,
  // but provider semantics are still not guaranteed. Keep the remaining
  // semantic diagnostics on every result, including an empty response, so
  // canonical admission cannot be inferred from this empirical mapping.
  push(diagnostics, "identity-continuity-unproven");
  push(diagnostics, "direction-semantics-unproven");
  push(diagnostics, "posting-semantics-unproven");
  push(diagnostics, "effective-time-semantics-unproven");
  push(diagnostics, "completeness-semantics-unproven");
  push(diagnostics, "authority-semantics-unproven");

  if (input.pages.length === 0) {
    push(diagnostics, "pages-missing");
    return {
      status: "blocked",
      readiness: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
      contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
      accountKey,
      pageCount: 0,
      reportedRowCount: null,
      collectedRowCount: 0,
      directionCodes: [],
      directionEvidence: LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE,
      currencyEvidence: currencyResolution.evidence,
      cancellationFlagsObserved: false,
      diagnostics,
    };
  }

  const zeroCandidate =
    input.pages.length === 1 && input.pages[0]?.totTxCnt === 0;
  if (zeroCandidate) {
    const zeroPage = input.pages[0]!;
    const zeroValidation = linebankValidateZeroResultPage(zeroPage);
    for (const diagnostic of zeroValidation.diagnostics) {
      push(diagnostics, diagnostic, zeroPage.pageNbr);
    }
    const zeroSourceIdentity = sourceAccountIdentityStatus(
      input.account,
      zeroPage.source,
    );
    if (zeroSourceIdentity === "missing") {
      push(diagnostics, "source-account-identity-incomplete", zeroPage.pageNbr);
    } else if (zeroSourceIdentity === "mismatch") {
      push(diagnostics, "source-account-identity-mismatch", zeroPage.pageNbr);
    }
  }

  const identityEpochs = input.pages.map((page) =>
    occurrenceEpoch(page.source?.opnDtm),
  );
  const identityEpoch = identityEpochs[0] ?? null;
  if (
    identityEpoch === null ||
    identityEpochs.some((epoch) => epoch === null)
  ) {
    push(diagnostics, "occurrence-context-invalid");
  } else if (identityEpochs.some((epoch) => epoch !== identityEpoch)) {
    push(diagnostics, "occurrence-identity-epoch-mismatch");
  } else {
    const occurrenceValidation = linebankValidateSourceOccurrenceCapture({
      context: {
        namespace: LINEBANK_INTEGRATION_NAMESPACE,
        sourceConnection: "accessibility.linebank.com.tw",
        stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
        contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        identityEpoch,
        account: input.account,
      },
      rows: input.pages.flatMap((page) => page.rows),
      comparableCompleteness: false,
    });
    for (const diagnostic of occurrenceValidation.diagnostics) {
      push(diagnostics, diagnostic.code);
    }
  }

  const seenPages = new Set<number>();
  const directionCodes = new Set<string>();
  let reportedRowCount: number | null = null;
  let collectedRowCount = 0;
  let cancellationFlagsObserved = false;
  let sourceIdentity: string | undefined;

  for (const page of input.pages) {
    if (!Number.isInteger(page.pageNbr) || page.pageNbr < 1) {
      push(diagnostics, "page-number-invalid", page.pageNbr);
    }
    if (seenPages.has(page.pageNbr))
      push(diagnostics, "page-number-duplicate", page.pageNbr);
    seenPages.add(page.pageNbr);
    if (!Number.isInteger(page.pageCnt) || page.pageCnt < 1)
      push(diagnostics, "page-size-invalid", page.pageNbr);
    if (page.txCnt !== page.rows.length)
      push(diagnostics, "page-row-count-mismatch", page.pageNbr);
    if (reportedRowCount === null) reportedRowCount = page.totTxCnt;
    if (reportedRowCount !== page.totTxCnt)
      push(diagnostics, "total-count-drift", page.pageNbr);
    if (page.source !== undefined) {
      const sourceKey = candidateAccountKey(page.source);
      if (!sourceKey) {
        if (!zeroCandidate) {
          push(diagnostics, "source-account-identity-incomplete", page.pageNbr);
        }
      } else {
        if (sourceIdentity !== undefined && sourceIdentity !== sourceKey) {
          push(diagnostics, "source-account-identity-mismatch", page.pageNbr);
        }
        if (candidateKey && candidateKey !== sourceKey && !zeroCandidate) {
          push(diagnostics, "source-account-identity-mismatch", page.pageNbr);
        }
        sourceIdentity = sourceKey;
      }
    }
    collectedRowCount += page.rows.length;

    for (const [rowIndex, row] of page.rows.entries()) {
      const direction = clean(row.dpstWdrwDsCd);
      if (!direction)
        push(diagnostics, "direction-missing", page.pageNbr, rowIndex);
      else {
        directionCodes.add(direction);
        if (!KNOWN_DIRECTION_CODES.has(direction))
          push(diagnostics, "direction-unknown", page.pageNbr, rowIndex);
      }
      if (
        row.txAmt === undefined ||
        row.txAmt === null ||
        clean(row.txAmt) === ""
      )
        push(diagnostics, "amount-missing", page.pageNbr, rowIndex);
      else {
        const amount = decimalLexeme(row.txAmt);
        if (amount === null)
          push(diagnostics, "amount-invalid", page.pageNbr, rowIndex);
        else if (amount.startsWith("-"))
          push(diagnostics, "amount-sign-conflict", page.pageNbr, rowIndex);
      }
      if (!validDate(row.txDt))
        push(diagnostics, "transaction-date-invalid", page.pageNbr, rowIndex);
      if (!validTime(row.txTm))
        push(diagnostics, "transaction-time-invalid", page.pageNbr, rowIndex);
      if (!validTransactionEffectiveTime(row.txDtm)) {
        push(
          diagnostics,
          "transaction-effective-time-invalid",
          page.pageNbr,
          rowIndex,
        );
      }
      if (
        !clean(row.txDt) ||
        !clean(row.txTm) ||
        row.txDtm === undefined ||
        row.txDtm === null
      ) {
        push(
          diagnostics,
          "transaction-source-time-missing",
          page.pageNbr,
          rowIndex,
        );
      } else if (
        validDate(row.txDt) &&
        validTime(row.txTm) &&
        validTransactionEffectiveTime(row.txDtm)
      ) {
        try {
          if (
            linebankEpochMillisecondsFromSourceDateTime(row.txDt, row.txTm) !==
            row.txDtm
          ) {
            push(
              diagnostics,
              "transaction-source-time-mismatch",
              page.pageNbr,
              rowIndex,
            );
          }
        } catch {
          push(
            diagnostics,
            "transaction-source-time-mismatch",
            page.pageNbr,
            rowIndex,
          );
        }
      }
      if (clean(row.txDtm) === "")
        push(
          diagnostics,
          "effective-time-semantics-unproven",
          page.pageNbr,
          rowIndex,
        );
      const cancellation = [row.cncdTxYn, row.cnclTxYn]
        .map(clean)
        .filter(Boolean);
      if (cancellation.some((value) => !NON_CANCELLED_FLAGS.has(value))) {
        cancellationFlagsObserved = true;
        push(diagnostics, "unsupported-cancellation", page.pageNbr, rowIndex);
      }
    }
  }

  const orderedPages = [...seenPages].sort((left, right) => left - right);
  orderedPages.forEach((pageNbr, index) => {
    if (pageNbr !== index + 1) push(diagnostics, "page-number-gap", pageNbr);
  });
  if (reportedRowCount === null || collectedRowCount !== reportedRowCount)
    push(diagnostics, "total-count-mismatch");

  return {
    status: "blocked",
    readiness: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
    contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
    accountKey,
    pageCount: input.pages.length,
    reportedRowCount,
    collectedRowCount,
    directionCodes: [...directionCodes].sort(),
    directionEvidence: LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE,
    currencyEvidence: currencyResolution.evidence,
    cancellationFlagsObserved,
    diagnostics,
  };
}
