import { createHash } from "node:crypto";
import type {
  LineBankAccount,
  LineBankTransactionPage,
  LineBankTransactionRow,
} from "../../workflows/linebank-statements.ts";

/**
 * This is intentionally a preflight contract, not a canonical writer.  The
 * live evidence identifies the source fields and response envelope, but it
 * does not establish direction, posting, effective-time, cancellation, or
 * cross-query identity semantics.  Keeping the contract version explicit
 * prevents a best-effort CSV projection from becoming financial truth.
 */
export const LINEBANK_INTEGRATION_NAMESPACE = "linebank";
export const LINEBANK_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
export const LINEBANK_DOMESTIC_DEPOSIT_AUTHORITY =
  "linebank/domestic-deposit/preflight-v4";
export const LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION = "preflight-v4";
export const LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";
export const LINEBANK_DOMESTIC_DEPOSIT_READINESS = "preflight-only" as const;
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
  note: "The latest redacted response preserved source envelope and nullable linkage fields; official public product text supports TWD only for the explicit domestic-main-account scope, duplicate txSeqNbr evidence remains in the versioned fixture, response semantics remain unresolved, and no canonical write is exposed.",
} as const;

/** One observed UI correlation only; this is not a complete direction enum. */
export const LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE = {
  sourceCode: "1",
  uiLabel: "存入",
  scope: "single-observed-response",
  completeMapping: false,
} as const;

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

/**
 * Sanitized shape evidence from one live response. Every value below is
 * synthetic; it preserves only the response invariants needed by preflight.
 * In particular, the two rows deliberately share txSeqNbr while differing in
 * other source fields, so the current candidate occurrence key is rejected.
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
            txDtm: 1700000000000,
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
            txDtm: 1700000001000,
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
              txDtm: 1700000200000,
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
              txDtm: 1700000300000,
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
              txDtm: 1700000200000,
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
  | "identity-continuity-unproven"
  | "direction-missing"
  | "direction-unknown"
  | "direction-mapping-incomplete"
  | "direction-semantics-unproven"
  | "amount-missing"
  | "amount-invalid"
  | "transaction-date-invalid"
  | "transaction-time-invalid"
  | "transaction-effective-time-invalid"
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

  // The live observation has not established these semantics.  Keep these as
  // explicit diagnostics on every result, including an empty response, so a
  // future evidence update must change the contract deliberately before
  // canonical admission can be added.
  push(diagnostics, "identity-continuity-unproven");
  push(diagnostics, "direction-mapping-incomplete");
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

  const seenPages = new Set<number>();
  const seenTransactions = new Set<string>();
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
        push(diagnostics, "source-account-identity-incomplete", page.pageNbr);
      } else {
        if (sourceIdentity !== undefined && sourceIdentity !== sourceKey) {
          push(diagnostics, "source-account-identity-mismatch", page.pageNbr);
        }
        if (candidateKey && candidateKey !== sourceKey) {
          push(diagnostics, "source-account-identity-mismatch", page.pageNbr);
        }
        sourceIdentity = sourceKey;
      }
    }
    collectedRowCount += page.rows.length;

    for (const [rowIndex, row] of page.rows.entries()) {
      const sequence = transactionKey(row);
      if (!sequence)
        push(diagnostics, "transaction-key-missing", page.pageNbr, rowIndex);
      else if (seenTransactions.has(sequence))
        push(diagnostics, "transaction-key-duplicate", page.pageNbr, rowIndex);
      else seenTransactions.add(sequence);

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
      else if (decimalLexeme(row.txAmt) === null)
        push(diagnostics, "amount-invalid", page.pageNbr, rowIndex);
      if (!validDate(row.txDt))
        push(diagnostics, "transaction-date-invalid", page.pageNbr, rowIndex);
      if (!validTime(row.txTm))
        push(diagnostics, "transaction-time-invalid", page.pageNbr, rowIndex);
      if (
        row.txDtm !== undefined &&
        !validTransactionEffectiveTime(row.txDtm)
      ) {
        push(
          diagnostics,
          "transaction-effective-time-invalid",
          page.pageNbr,
          rowIndex,
        );
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
