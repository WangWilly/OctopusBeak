import assert from "node:assert/strict";
import type { LineBankTransactionSourceEnvelope } from "../../workflows/linebank-statements.ts";
import {
  LINEBANK_DOMESTIC_DEPOSIT_AUTHORITY,
  LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR,
  LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_CANDIDATE_FIELDS,
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE,
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE,
  LINEBANK_DOMESTIC_DEPOSIT_DIRECTION_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_DIRECTION_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_TIME_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_PROVENANCE,
  LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  LINEBANK_DOMESTIC_DEPOSIT_REPEAT_CAPTURE_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_REPEAT_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  LINEBANK_DOMESTIC_DEPOSIT_TIME_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE_VERSION,
  linebankCompareZeroResultCaptures,
  linebankSummarizeCrossWindowEvidence,
  linebankBuildSourceOccurrenceKey,
  linebankCompareSourceOccurrenceCaptures,
  validateLineBankCanonicalCapture,
  linebankValidateSourceOccurrenceCapture,
  linebankValidateZeroResultPage,
  preflightLineBankDomesticDeposit,
} from "./linebank-domestic-deposit.ts";
import {
  commitCanonicalDomesticDeposit,
  createDomesticDepositStore,
  queryCurrent,
} from "./domestic-deposit-store.ts";

assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_AUTHORITY,
  "linebank/domestic-deposit/preflight-v4",
);
assert.equal(LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION, "preflight-v4");
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE_VERSION,
  "clean-headed-v6",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE_VERSION,
  "result-ui-v12",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_DIRECTION_EVIDENCE_VERSION,
  "historical-v7",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE_VERSION,
  "historical-revalidation-v9",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
  "occurrence-v1",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_TIME_EVIDENCE_VERSION,
  "observed-time-v1",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION,
  "domestic-main-twd-v1",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_VERSION,
  "cross-window-v3",
);
assert.equal(LINEBANK_DOMESTIC_DEPOSIT_REPEAT_EVIDENCE_VERSION, "repeat-v5");
assert.equal(LINEBANK_DOMESTIC_DEPOSIT_READINESS, "preflight-only");
assert.equal(LINEBANK_DOMESTIC_DEPOSIT_PROVENANCE.liveResponseRetained, false);
assert.equal(LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR, "acctNbr+arrId");

assert.deepEqual(LINEBANK_DOMESTIC_DEPOSIT_REPEAT_CAPTURE_EVIDENCE, {
  evidenceVersion: "repeat-v5",
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
});
assert.equal(
  JSON.stringify(LINEBANK_DOMESTIC_DEPOSIT_REPEAT_CAPTURE_EVIDENCE).includes(
    "SYNTHETIC",
  ),
  false,
);

assert.deepEqual(LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_DIRECTION_EVIDENCE, {
  evidenceVersion: "historical-v7",
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
});
assert.equal(
  JSON.stringify(
    LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_DIRECTION_EVIDENCE,
  ).includes("SYNTHETIC"),
  false,
);
assert.deepEqual(LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_TIME_EVIDENCE, {
  evidenceVersion: "observed-time-v1",
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
});

assert.deepEqual(LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE, {
  evidenceVersion: "clean-headed-v6",
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
  readiness: "preflight-only",
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
});
assert.equal(
  JSON.stringify(LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE).includes(
    "acctNbr",
  ),
  false,
);
assert.equal(
  JSON.stringify(LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE).includes(
    "txAmt",
  ),
  false,
);

assert.deepEqual(LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE, {
  evidenceVersion: "result-ui-v12",
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
  readiness: "preflight-only",
  remainingBlockers: {
    providerIdentityGuarantee: true,
    postingSemantics: true,
    effectiveTimeSemantics: true,
    cancellationSemantics: true,
    completenessSemantics: true,
    canonicalWriter: true,
    queryCompleteness: true,
  },
});
const resultUiJson = JSON.stringify(
  LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE,
);
for (const forbidden of [
  "acctNbr",
  "arrId",
  "txAmt",
  "afTxBal",
  "txDtm",
  "NT$",
  "2026",
]) {
  assert.equal(resultUiJson.includes(forbidden), false);
}
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE.canonicalAdmission,
  "blocked",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE.readiness,
  "preflight-only",
);
assert.ok(
  Object.values(
    LINEBANK_DOMESTIC_DEPOSIT_RESULT_UI_EVIDENCE.remainingBlockers,
  ).every(Boolean),
);

assert.deepEqual(LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE, {
  evidenceVersion: "historical-revalidation-v9",
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
    evidenceVersion: "observed-time-v1",
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
  readiness: "preflight-only",
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
});
const revalidationJson = JSON.stringify(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE,
);
assert.equal(revalidationJson.includes("acctNbr"), false);
assert.equal(revalidationJson.includes("txAmt"), false);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE.canonicalAdmission,
  "blocked",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE.readiness,
  "preflight-only",
);
assert.ok(
  Object.values(
    LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE.remainingBlockers,
  ).every(Boolean),
);

const page = {
  pageNbr: 1,
  pageCnt: 1000,
  totTxCnt: 1,
  txCnt: 1,
  rows: [
    {
      txSeqNbr: "1",
      crrnDpstNthCnt: 1,
      txDt: "20260705",
      txTm: "143738",
      txDtm: 1783233458000,
      dpstWdrwDsCd: "1",
      txAmt: "1000",
      afTxBal: "1005",
      cncdTxYn: "N",
      cnclTxYn: "N",
    },
  ],
};

// Green transport preflight: one page is complete and its source sequence is unique.
const valid = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  pages: [
    {
      ...page,
      source: {
        acctNbr: "synthetic-account",
        arrId: "synthetic-arrangement",
        pdNm: "synthetic-domestic-main-account",
        opnDtm: 1700000000000,
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
});
assert.equal(valid.status, "blocked");
assert.equal(valid.pageCount, 1);
assert.equal(valid.reportedRowCount, 1);
assert.equal(valid.collectedRowCount, 1);
assert.equal(
  valid.accountKey,
  LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR,
);
assert.deepEqual(valid.directionCodes, ["1"]);
assert.deepEqual(
  valid.directionEvidence,
  LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE,
);
assert.equal(valid.cancellationFlagsObserved, false);
assert.deepEqual(valid.currencyEvidence, {
  status: "supported",
  currency: "TWD",
  scope: "domestic-main-account-demand-savings",
});
assert.equal(
  valid.diagnostics.some((item) => item.code === "currency-scope-unproven"),
  false,
);
assert.equal(
  valid.diagnostics.some((item) => item.code === "currency-scope-unsupported"),
  false,
);
assert.equal(
  valid.diagnostics.some(
    (item) => item.code === "direction-mapping-incomplete",
  ),
  false,
);
assert.ok(
  valid.diagnostics.some(
    (item) => item.code === "direction-semantics-unproven",
  ),
);
assert.ok(
  valid.diagnostics.some((item) => item.code === "posting-semantics-unproven"),
);
assert.ok(
  valid.diagnostics.some(
    (item) => item.code === "effective-time-semantics-unproven",
  ),
);
assert.ok(
  valid.diagnostics.some(
    (item) => item.code === "completeness-semantics-unproven",
  ),
);
assert.ok(
  valid.diagnostics.some(
    (item) => item.code === "authority-semantics-unproven",
  ),
);

const missingSourceEnvelope = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  pages: [page],
});
assert.deepEqual(missingSourceEnvelope.currencyEvidence, {
  status: "unsupported",
  currency: null,
  reason: "scope-unproven",
});
assert.ok(
  missingSourceEnvelope.diagnostics.some(
    (item) => item.code === "currency-scope-unproven",
  ),
);

// The sanitized live shape preserves one complete page and matching counts.
// Repeated txSeqNbr values are accepted only when the empirical occurrence
// tuple is complete and unique; canonical admission remains blocked.
const liveEvidence = preflightLineBankDomesticDeposit(
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE,
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]?.source?.pdCd,
  "SYNTHETIC-PRODUCT-CODE",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]?.source
    ?.jntAcctMbrTpCd,
  "SYNTHETIC-ROLE",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]?.rows[0]
    ?.ctptCustLineUid,
  "SYNTHETIC-LINE-UID-A",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]?.rows[0]?.fxsTxId,
  null,
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]?.rows[0]
    ?.rltvTxArrId,
  null,
);
assert.equal(liveEvidence.status, "blocked");
assert.equal(liveEvidence.readiness, "preflight-only");
assert.equal(liveEvidence.pageCount, 1);
assert.equal(liveEvidence.reportedRowCount, 2);
assert.equal(liveEvidence.collectedRowCount, 2);
assert.deepEqual(liveEvidence.directionCodes, ["1"]);
assert.equal(liveEvidence.cancellationFlagsObserved, false);
assert.equal(
  liveEvidence.accountKey,
  LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR,
);
assert.equal(liveEvidence.directionEvidence.completeMapping, true);
assert.deepEqual(liveEvidence.currencyEvidence, {
  status: "unsupported",
  currency: null,
  reason: "scope-unproven",
});
assert.equal(JSON.stringify(liveEvidence).includes("SYNTHETIC"), false);
assert.equal(JSON.stringify(liveEvidence).includes("SYNTHETIC-ACCOUNT"), false);
assert.equal(
  JSON.stringify(liveEvidence).includes("SYNTHETIC-ARRANGEMENT"),
  false,
);
assert.equal(
  JSON.stringify(liveEvidence).includes("SYNTHETIC-LINE-UID-A"),
  false,
);
assert.equal(
  JSON.stringify(liveEvidence).includes("SYNTHETIC-PRODUCT-CODE"),
  false,
);
assert.equal(
  liveEvidence.diagnostics.some(
    (item) =>
      item.code === "transaction-key-duplicate" ||
      item.code === "occurrence-duplicate" ||
      item.code === "occurrence-base-time-conflict",
  ),
  false,
);
assert.ok(
  liveEvidence.diagnostics.some(
    (item) => item.code === "currency-scope-unproven",
  ),
);
assert.ok(
  liveEvidence.diagnostics.some(
    (item) => item.code === "identity-continuity-unproven",
  ),
);
assert.ok(
  liveEvidence.diagnostics.some(
    (item) => item.code === "direction-semantics-unproven",
  ),
);
assert.ok(
  liveEvidence.diagnostics.some(
    (item) => item.code === "posting-semantics-unproven",
  ),
);
assert.ok(
  liveEvidence.diagnostics.some(
    (item) => item.code === "effective-time-semantics-unproven",
  ),
);
assert.equal(
  liveEvidence.diagnostics.some(
    (item) => item.code === "page-row-count-mismatch",
  ),
  false,
);
assert.equal(
  liveEvidence.diagnostics.some((item) => item.code === "total-count-mismatch"),
  false,
);
assert.equal(
  liveEvidence.diagnostics.some((item) => item.code === "page-number-gap"),
  false,
);

const crossWindow = linebankSummarizeCrossWindowEvidence(
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE,
);
assert.equal(crossWindow.evidenceVersion, "cross-window-v3");
assert.equal(crossWindow.accountCompositeEqual, true);
assert.equal(crossWindow.envelopeStable, true);
assert.equal(crossWindow.fullRawRowEqualityCount, 1);
assert.equal(crossWindow.candidateTupleOverlapCount, 1);
assert.equal(crossWindow.longWindowTxSeqDuplicateGroupCount, 1);
assert.equal(crossWindow.longWindowTxSeqCrrnEmpiricallyUnique, true);
assert.equal(crossWindow.longWindowTxSeqDtmEmpiricallyUnique, true);
assert.equal(crossWindow.longWindowProviderTupleEmpiricallyUnique, true);
assert.equal(crossWindow.candidateUsesAmount, false);
assert.equal(crossWindow.candidateUsesDescription, false);
assert.equal(crossWindow.candidateUsesBalance, false);
assert.equal(crossWindow.candidateUsesContentHash, false);
assert.equal(crossWindow.candidateUsesRowOrder, false);
assert.equal(crossWindow.nullableLinkageCanIdentify, false);
assert.equal(crossWindow.identityStatus, "observed-not-provider-guaranteed");
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_CANDIDATE_FIELDS.some((field) =>
    /Amt|Bal|Memo|Rmk|FuncTpNm|hash|order/i.test(field),
  ),
  false,
);
assert.equal(JSON.stringify(crossWindow).includes("SYNTHETIC"), false);

const crossLong =
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE.longWindow;
const reorderedCrossWindow = linebankSummarizeCrossWindowEvidence({
  ...LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE,
  longWindow: {
    ...crossLong,
    pages: [
      {
        ...crossLong.pages[0],
        rows: [...(crossLong.pages[0]?.rows ?? [])].reverse(),
      },
    ],
  },
});
assert.deepEqual(
  [
    reorderedCrossWindow.fullRawRowEqualityCount,
    reorderedCrossWindow.candidateTupleOverlapCount,
  ],
  [crossWindow.fullRawRowEqualityCount, crossWindow.candidateTupleOverlapCount],
);
const crossLongPreflight = preflightLineBankDomesticDeposit(
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE.longWindow,
);
const crossShortPreflight = preflightLineBankDomesticDeposit(
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE.shortWindow,
);
assert.equal(crossLongPreflight.status, "blocked");
assert.equal(crossShortPreflight.status, "blocked");
assert.equal(
  crossShortPreflight.diagnostics.some(
    (item) =>
      item.code === "transaction-key-duplicate" ||
      item.code === "occurrence-duplicate" ||
      item.code === "occurrence-base-time-conflict",
  ),
  false,
);
assert.equal(
  crossLongPreflight.diagnostics.some(
    (item) =>
      item.code === "transaction-key-duplicate" ||
      item.code === "occurrence-duplicate" ||
      item.code === "occurrence-base-time-conflict",
  ),
  false,
);
assert.ok(
  crossLongPreflight.diagnostics.some(
    (item) => item.code === "identity-continuity-unproven",
  ),
);
assert.ok(
  crossShortPreflight.diagnostics.some(
    (item) => item.code === "identity-continuity-unproven",
  ),
);

assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE.providerGuaranteed,
  false,
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE.matchingRuleVersion,
  "occurrence-v1",
);
assert.equal(
  (
    LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE.matchingFields as readonly string[]
  ).includes("txAmt"),
  false,
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE.excludedFromMatching.includes(
    "txAmt",
  ),
  true,
);

const occurrenceContext = {
  namespace: "linebank" as const,
  sourceConnection: "accessibility.linebank.com.tw" as const,
  stream: "domestic-deposit" as const,
  contractVersion: "preflight-v4",
  identityEpoch: 1700000000000,
  account: {
    acctNbr: "synthetic-occurrence-account",
    arrId: "synthetic-occurrence-arrangement",
  },
};
const occurrenceRow = {
  ...page.rows[0]!,
  crrnDpstNthCnt: 1,
};
const occurrenceKey = linebankBuildSourceOccurrenceKey(
  occurrenceContext,
  occurrenceRow,
);
assert.ok(occurrenceKey);
assert.match(occurrenceKey.tupleDigest, /^[a-f0-9]{64}$/);
assert.match(occurrenceKey.baseDigest, /^[a-f0-9]{64}$/);
assert.match(occurrenceKey.changeFingerprint, /^[a-f0-9]{64}$/);
assert.equal(
  JSON.stringify(occurrenceKey).includes("synthetic-occurrence-account"),
  false,
);

const stableRepeat = linebankCompareSourceOccurrenceCaptures(
  {
    context: occurrenceContext,
    rows: [occurrenceRow],
    comparableCompleteness: true,
  },
  {
    context: occurrenceContext,
    rows: [{ ...occurrenceRow }],
    comparableCompleteness: true,
  },
);
assert.deepEqual(
  {
    status: stableRepeat.status,
    overlapCount: stableRepeat.overlapCount,
    stableObservationCount: stableRepeat.stableObservationCount,
    conflictCount: stableRepeat.conflictCount,
    withdrawalAuthorized: stableRepeat.withdrawalAuthorized,
  },
  {
    status: "stable",
    overlapCount: 1,
    stableObservationCount: 1,
    conflictCount: 0,
    withdrawalAuthorized: false,
  },
);

const changedFinancialValue = linebankCompareSourceOccurrenceCaptures(
  {
    context: occurrenceContext,
    rows: [occurrenceRow],
    comparableCompleteness: true,
  },
  {
    context: occurrenceContext,
    rows: [{ ...occurrenceRow, txAmt: "2000" }],
    comparableCompleteness: true,
  },
);
assert.equal(changedFinancialValue.status, "conflict");
assert.equal(changedFinancialValue.overlapCount, 1);
assert.equal(changedFinancialValue.conflictCount, 1);
assert.equal(changedFinancialValue.withdrawalAuthorized, false);
assert.deepEqual(changedFinancialValue.diagnostics, ["source-conflict"]);

const exactTupleCollision = linebankValidateSourceOccurrenceCapture({
  context: occurrenceContext,
  rows: [occurrenceRow, { ...occurrenceRow }],
  comparableCompleteness: true,
});
assert.equal(exactTupleCollision.status, "blocked");
assert.equal(exactTupleCollision.keys.length, 0);
assert.ok(
  exactTupleCollision.diagnostics.some(
    (item) => item.code === "occurrence-duplicate",
  ),
);

const baseTimeCollision = linebankValidateSourceOccurrenceCapture({
  context: occurrenceContext,
  rows: [
    occurrenceRow,
    { ...occurrenceRow, txDtm: occurrenceRow.txDtm! + 1000 },
  ],
  comparableCompleteness: true,
});
assert.equal(baseTimeCollision.status, "blocked");
assert.equal(baseTimeCollision.keys.length, 0);
assert.ok(
  baseTimeCollision.diagnostics.some(
    (item) => item.code === "occurrence-base-time-conflict",
  ),
);
const comparedBaseTimeCollision = linebankCompareSourceOccurrenceCaptures(
  {
    context: occurrenceContext,
    rows: [occurrenceRow],
    comparableCompleteness: true,
  },
  {
    context: occurrenceContext,
    rows: [{ ...occurrenceRow, txDtm: occurrenceRow.txDtm! + 1000 }],
    comparableCompleteness: true,
  },
);
assert.equal(comparedBaseTimeCollision.status, "conflict");
assert.equal(comparedBaseTimeCollision.overlapCount, 0);
assert.equal(comparedBaseTimeCollision.conflictCount, 1);
assert.deepEqual(comparedBaseTimeCollision.diagnostics, [
  "source-base-conflict",
]);

const missingOccurrenceField = linebankValidateSourceOccurrenceCapture({
  context: occurrenceContext,
  rows: [{ ...occurrenceRow, crrnDpstNthCnt: undefined }],
  comparableCompleteness: true,
});
assert.equal(missingOccurrenceField.status, "blocked");
assert.equal(missingOccurrenceField.keys.length, 0);
assert.ok(
  missingOccurrenceField.diagnostics.some(
    (item) => item.code === "occurrence-key-missing",
  ),
);

const historicalFiveRows = Array.from({ length: 5 }, (_, index) => ({
  ...occurrenceRow,
  txSeqNbr: String((index % 3) + 1),
  crrnDpstNthCnt: index + 1,
  txDtm: occurrenceRow.txDtm! + index * 1000,
}));
const historicalFiveValidation = linebankValidateSourceOccurrenceCapture({
  context: occurrenceContext,
  rows: historicalFiveRows,
  comparableCompleteness: true,
});
assert.equal(historicalFiveValidation.status, "valid");
assert.equal(historicalFiveValidation.keys.length, 5);
assert.equal(
  new Set(historicalFiveValidation.keys.map((key) => key.tupleDigest)).size,
  5,
);

const backfill = linebankCompareSourceOccurrenceCaptures(
  {
    context: occurrenceContext,
    rows: [occurrenceRow],
    comparableCompleteness: true,
  },
  {
    context: occurrenceContext,
    rows: [{ ...occurrenceRow, crrnDpstNthCnt: 2 }],
    comparableCompleteness: true,
  },
);
assert.equal(backfill.status, "no-overlap");
assert.equal(backfill.absenceWithoutComparableCompleteness, false);
assert.equal(backfill.withdrawalAuthorized, false);

const incompleteAbsence = linebankCompareSourceOccurrenceCaptures(
  {
    context: occurrenceContext,
    rows: [occurrenceRow],
    comparableCompleteness: true,
  },
  {
    context: occurrenceContext,
    rows: [],
    comparableCompleteness: false,
  },
);
assert.equal(incompleteAbsence.status, "no-overlap");
assert.equal(incompleteAbsence.absenceWithoutComparableCompleteness, true);
assert.equal(incompleteAbsence.withdrawalAuthorized, false);
assert.deepEqual(incompleteAbsence.diagnostics, ["absence-incomparable"]);

for (const separatedContext of [
  {
    ...occurrenceContext,
    account: {
      acctNbr: "synthetic-other-account",
      arrId: "synthetic-other-arrangement",
    },
  },
  { ...occurrenceContext, identityEpoch: occurrenceContext.identityEpoch + 1 },
  { ...occurrenceContext, contractVersion: "preflight-v5" },
]) {
  const separated = linebankCompareSourceOccurrenceCaptures(
    {
      context: occurrenceContext,
      rows: [occurrenceRow],
      comparableCompleteness: true,
    },
    {
      context: separatedContext,
      rows: [occurrenceRow],
      comparableCompleteness: true,
    },
  );
  assert.equal(separated.status, "no-overlap");
  assert.equal(separated.overlapCount, 0);
  assert.equal(separated.withdrawalAuthorized, false);
}

// Red transport preflight: page gaps, count drift, unknown direction, and
// cancellation flags must be visible before any legacy/canonical write.
const invalid = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      pageNbr: 3,
      totTxCnt: 2,
      rows: [{ ...page.rows[0], dpstWdrwDsCd: "9", cncdTxYn: "Y" }],
    },
    page,
  ],
});
assert.ok(invalid.diagnostics.some((item) => item.code === "page-number-gap"));
assert.ok(
  invalid.diagnostics.some((item) => item.code === "total-count-drift"),
);
assert.ok(
  invalid.diagnostics.some((item) => item.code === "direction-unknown"),
);
assert.ok(
  invalid.diagnostics.some((item) => item.code === "unsupported-cancellation"),
);

const observedWithdrawal = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      rows: [{ ...page.rows[0], dpstWdrwDsCd: "2", txAmt: "250" }],
    },
  ],
});
assert.deepEqual(observedWithdrawal.directionCodes, ["2"]);
assert.equal(
  observedWithdrawal.diagnostics.some(
    (item) => item.code === "direction-unknown",
  ),
  false,
);
assert.equal(
  observedWithdrawal.diagnostics.some(
    (item) => item.code === "amount-sign-conflict",
  ),
  false,
);

const missingDirection = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      rows: [{ ...page.rows[0], dpstWdrwDsCd: undefined }],
    },
  ],
});
assert.ok(
  missingDirection.diagnostics.some(
    (item) => item.code === "direction-missing",
  ),
);

const negativeDirectionAmount = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      rows: [{ ...page.rows[0], dpstWdrwDsCd: "2", txAmt: "-250" }],
    },
  ],
});
assert.ok(
  negativeDirectionAmount.diagnostics.some(
    (item) => item.code === "amount-sign-conflict",
  ),
);

const mismatchedCurrencyScope = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  sourceScopeEvidence: {
    ...LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    currency: "USD",
  },
  pages: [
    {
      ...page,
      source: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
    },
  ],
});
assert.deepEqual(mismatchedCurrencyScope.currencyEvidence, {
  status: "unsupported",
  currency: null,
  reason: "scope-mismatch",
});
assert.ok(
  mismatchedCurrencyScope.diagnostics.some(
    (item) => item.code === "currency-scope-unsupported",
  ),
);
assert.equal(JSON.stringify(mismatchedCurrencyScope).includes("USD"), false);

const foreignCurrencyScope = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  sourceScopeEvidence: {
    ...LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    productDescriptor: "foreign-currency-account",
    currency: "USD",
  },
  pages: [
    {
      ...page,
      source: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
    },
  ],
});
assert.deepEqual(foreignCurrencyScope.currencyEvidence, {
  status: "unsupported",
  currency: null,
  reason: "scope-mismatch",
});
assert.ok(
  foreignCurrencyScope.diagnostics.some(
    (item) => item.code === "currency-scope-unsupported",
  ),
);
assert.equal(
  JSON.stringify(foreignCurrencyScope).includes("foreign-currency-account"),
  false,
);

const invalidEffectiveTime = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      rows: [{ ...page.rows[0], txDtm: -1 }],
    },
  ],
});
assert.ok(
  invalidEffectiveTime.diagnostics.some(
    (item) => item.code === "transaction-effective-time-invalid",
  ),
);

const mismatchedSourceTime = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      rows: [{ ...page.rows[0], txDtm: 1783233458001 }],
    },
  ],
});
assert.ok(
  mismatchedSourceTime.diagnostics.some(
    (item) => item.code === "transaction-source-time-mismatch",
  ),
);

const invalidSourceCalendar = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      rows: [{ ...page.rows[0], txDt: "20260230" }],
    },
  ],
});
assert.ok(
  invalidSourceCalendar.diagnostics.some(
    (item) => item.code === "transaction-date-invalid",
  ),
);

const invalidSourceClock = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      rows: [{ ...page.rows[0], txTm: "246000" }],
    },
  ],
});
assert.ok(
  invalidSourceClock.diagnostics.some(
    (item) => item.code === "transaction-time-invalid",
  ),
);

const mismatchedSource = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [
    {
      ...page,
      source: { acctNbr: "other-account", arrId: "other-arrangement" },
    },
  ],
});
assert.ok(
  mismatchedSource.diagnostics.some(
    (item) => item.code === "source-account-identity-mismatch",
  ),
);

const reversedScope = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260706", endDate: "20260705" },
  pages: [page],
});
assert.ok(
  reversedScope.diagnostics.some((item) => item.code === "scope-invalid"),
);

const invalidCalendarScope = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260231", endDate: "20260301" },
  pages: [page],
});
assert.ok(
  invalidCalendarScope.diagnostics.some(
    (item) => item.code === "scope-invalid",
  ),
);

const emptyResponse = preflightLineBankDomesticDeposit({
  account: { acctNbr: "synthetic-account", arrId: "synthetic-arrangement" },
  scope: { startDate: "20260705", endDate: "20260705" },
  pages: [],
});
assert.ok(
  emptyResponse.diagnostics.some((item) => item.code === "pages-missing"),
);
assert.ok(
  emptyResponse.diagnostics.some(
    (item) => item.code === "completeness-semantics-unproven",
  ),
);
assert.ok(
  emptyResponse.diagnostics.some(
    (item) => item.code === "authority-semantics-unproven",
  ),
);

assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE_VERSION,
  "zero-result-v11",
);
assert.deepEqual(LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE, {
  evidenceVersion: "zero-result-v11",
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
  readiness: "preflight-only",
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
});
assert.equal(
  JSON.stringify(LINEBANK_DOMESTIC_DEPOSIT_ZERO_RESULT_EVIDENCE).includes(
    "acctNbr",
  ),
  false,
);

const zeroPage = {
  pageNbr: 1,
  pageCnt: 1000,
  totTxCnt: 0,
  txCnt: 0,
  rows: [],
  responseCode: "200",
  source: {
    acctNbr: "synthetic-zero-account",
    arrId: "synthetic-zero-arrangement",
    opnDtm: 1700000000000,
  },
};
assert.deepEqual(linebankValidateZeroResultPage(zeroPage), {
  status: "accepted",
  diagnostics: [],
});
const zeroPreflight = preflightLineBankDomesticDeposit({
  account: {
    acctNbr: "synthetic-zero-account",
    arrId: "synthetic-zero-arrangement",
  },
  scope: { startDate: "20250701", endDate: "20250701" },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  pages: [zeroPage],
});
assert.equal(zeroPreflight.status, "blocked");
assert.equal(zeroPreflight.reportedRowCount, 0);
assert.equal(zeroPreflight.collectedRowCount, 0);
assert.deepEqual(zeroPreflight.directionCodes, []);
assert.equal(
  zeroPreflight.diagnostics.some(
    (item) =>
      item.code === "pages-missing" ||
      item.code === "page-row-count-mismatch" ||
      item.code === "total-count-mismatch" ||
      item.code === "occurrence-context-invalid",
  ),
  false,
);
for (const invalidZeroPage of [
  { ...zeroPage, totTxCnt: 1 },
  { ...zeroPage, txCnt: 1 },
  { ...zeroPage, rows: [{ ...page.rows[0] }] },
  { ...zeroPage, responseCode: "500" },
  { ...zeroPage, pageNbr: 2 },
]) {
  const result = linebankValidateZeroResultPage(invalidZeroPage);
  assert.equal(result.status, "blocked");
  assert.ok(result.diagnostics.length > 0);
}

const zeroContext = {
  account: {
    acctNbr: "synthetic-zero-account",
    arrId: "synthetic-zero-arrangement",
  },
  identityEpoch: 1700000000000,
  contractVersion: "preflight-v4",
  scope: {
    startDate: "20250701",
    endDate: "20250701",
    accountFilter: "synthetic-main-account",
    currencyFilter: "TWD",
  },
};
const stableZero = linebankCompareZeroResultCaptures(
  { ...zeroContext, page: zeroPage, comparableCompleteness: true },
  { ...zeroContext, page: { ...zeroPage }, comparableCompleteness: true },
);
assert.deepEqual(stableZero, {
  status: "stable",
  providerGuaranteed: false,
  absenceWithoutComparableCompleteness: false,
  withdrawalAuthorized: false,
  revisionAuthorized: false,
  diagnostics: [],
});
const incompleteZeroAbsence = linebankCompareZeroResultCaptures(
  { ...zeroContext, page: zeroPage, comparableCompleteness: true },
  { ...zeroContext, page: { ...zeroPage }, comparableCompleteness: false },
);
assert.equal(incompleteZeroAbsence.status, "not-comparable");
assert.equal(incompleteZeroAbsence.withdrawalAuthorized, false);
assert.equal(incompleteZeroAbsence.revisionAuthorized, false);
assert.equal(incompleteZeroAbsence.absenceWithoutComparableCompleteness, true);
const zeroScopeDrift = linebankCompareZeroResultCaptures(
  { ...zeroContext, page: zeroPage, comparableCompleteness: true },
  {
    ...zeroContext,
    scope: { ...zeroContext.scope, startDate: "20250702" },
    page: { ...zeroPage },
    comparableCompleteness: true,
  },
);
assert.equal(zeroScopeDrift.status, "not-comparable");
assert.deepEqual(zeroScopeDrift.diagnostics, ["scope-separated"]);
const zeroMetadataDrift = linebankCompareZeroResultCaptures(
  { ...zeroContext, page: zeroPage, comparableCompleteness: true },
  {
    ...zeroContext,
    page: { ...zeroPage, pageCnt: 500 },
    comparableCompleteness: true,
  },
);
assert.equal(zeroMetadataDrift.status, "not-comparable");
assert.deepEqual(zeroMetadataDrift.diagnostics, ["page-metadata-drift"]);
const wrongZeroSourcePage = {
  ...zeroPage,
  source: {
    ...zeroPage.source,
    acctNbr: "synthetic-wrong-account",
  },
};
const bothWrongZeroSource = linebankCompareZeroResultCaptures(
  { ...zeroContext, page: wrongZeroSourcePage, comparableCompleteness: true },
  {
    ...zeroContext,
    page: { ...wrongZeroSourcePage },
    comparableCompleteness: true,
  },
);
assert.equal(bothWrongZeroSource.status, "not-comparable");
assert.deepEqual(bothWrongZeroSource.diagnostics, ["source-identity-invalid"]);
const oneWrongZeroSource = linebankCompareZeroResultCaptures(
  { ...zeroContext, page: zeroPage, comparableCompleteness: true },
  {
    ...zeroContext,
    page: wrongZeroSourcePage,
    comparableCompleteness: true,
  },
);
assert.equal(oneWrongZeroSource.status, "not-comparable");
assert.deepEqual(oneWrongZeroSource.diagnostics, ["source-identity-invalid"]);
const oneMissingZeroSource = linebankCompareZeroResultCaptures(
  { ...zeroContext, page: zeroPage, comparableCompleteness: true },
  {
    ...zeroContext,
    page: { ...zeroPage, source: undefined },
    comparableCompleteness: true,
  },
);
assert.equal(oneMissingZeroSource.status, "not-comparable");
assert.deepEqual(oneMissingZeroSource.diagnostics, ["source-identity-invalid"]);

const malformedZeroPreflight = preflightLineBankDomesticDeposit({
  account: {
    acctNbr: "synthetic-zero-account",
    arrId: "synthetic-zero-arrangement",
  },
  scope: { startDate: "20250701", endDate: "20250701" },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  pages: [{ ...zeroPage, responseCode: "500" }],
});
assert.ok(
  malformedZeroPreflight.diagnostics.some(
    (item) => item.code === "zero-response-status-invalid",
  ),
);
const contradictoryZeroPreflight = preflightLineBankDomesticDeposit({
  account: {
    acctNbr: "synthetic-zero-account",
    arrId: "synthetic-zero-arrangement",
  },
  scope: { startDate: "20250701", endDate: "20250701" },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  pages: [{ ...zeroPage, txCnt: 1 }],
});
assert.ok(
  contradictoryZeroPreflight.diagnostics.some(
    (item) => item.code === "zero-row-count-nonzero",
  ),
);
assert.ok(
  contradictoryZeroPreflight.diagnostics.some(
    (item) => item.code === "zero-page-row-mismatch",
  ),
);
const missingZeroSourcePreflight = preflightLineBankDomesticDeposit({
  account: {
    acctNbr: "synthetic-zero-account",
    arrId: "synthetic-zero-arrangement",
  },
  scope: { startDate: "20250701", endDate: "20250701" },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  pages: [{ ...zeroPage, source: undefined }],
});
assert.ok(
  missingZeroSourcePreflight.diagnostics.some(
    (item) => item.code === "source-account-identity-incomplete",
  ),
);
const mismatchedZeroSourcePreflight = preflightLineBankDomesticDeposit({
  account: {
    acctNbr: "synthetic-zero-account",
    arrId: "synthetic-zero-arrangement",
  },
  scope: { startDate: "20250701", endDate: "20250701" },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  pages: [
    {
      ...zeroPage,
      source: {
        ...zeroPage.source,
        acctNbr: "synthetic-other-account",
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
});
assert.ok(
  mismatchedZeroSourcePreflight.diagnostics.some(
    (item) => item.code === "source-account-identity-mismatch",
  ),
);

// The strict public seam admits only compact source records. It never claims
// that LINE Bank rows are posted canonical Financial Transactions.
const canonicalInput = {
  ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE,
  account: {
    ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.account,
    currCd: "TWD",
  },
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  captureId: "synthetic-capture-admission-1",
  sourceConnection: "accessibility.linebank.com.tw" as const,
  identityEpoch: 1700000000000,
  observedAt: "2026-01-03T00:00:00.000Z",
  pages: [
    {
      ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!,
      responseCode: "200",
      source: {
        ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.source,
        jntAcctMbrTpCd: "personal-main-account",
        jntMbrListCnt: 0,
        totJntAcctMbrCnt: 0,
        isSecuAcctBndg: false,
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
};
const admittedSourceCapture = validateLineBankCanonicalCapture(canonicalInput);
assert.equal(admittedSourceCapture.status, "source-record-admissible");
assert.equal(admittedSourceCapture.stage, "source-record-only");
assert.equal(admittedSourceCapture.canonicalAdmission, "blocked");
assert.ok(admittedSourceCapture.capture);
assert.equal(admittedSourceCapture.capture?.records.length, 2);
assert.ok(
  admittedSourceCapture.financialAdmissionBlockers.includes(
    "posting-semantics-unproven",
  ),
);
assert.equal(
  JSON.stringify(admittedSourceCapture).includes("SYNTHETIC-ACCOUNT"),
  false,
);
const actualAuthorityFieldNames = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-authority-long-field-names",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      source: {
        ...canonicalInput.pages[0]!.source,
        jntAcctMbrTpCd: "personal-main-account",
        jntMbrListCnt: undefined,
        totJntAcctMbrCnt: undefined,
        jntAcctMbrCnt: 0,
        jntAcctMbrDpstCnt: 0,
        isSecuAcctBndg: false,
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
});
assert.equal(actualAuthorityFieldNames.status, "source-record-admissible");
const missingAuthorityEnvelope = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-authority-missing",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      source: {
        ...canonicalInput.pages[0]!.source,
        jntAcctMbrTpCd: undefined,
        jntMbrListCnt: undefined,
        totJntAcctMbrCnt: undefined,
        jntAcctMbrCnt: undefined,
        jntAcctMbrDpstCnt: undefined,
        isSecuAcctBndg: undefined,
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
});
assert.equal(missingAuthorityEnvelope.status, "rejected");
assert.ok(
  missingAuthorityEnvelope.diagnostics.some(
    (item) => item.code === "authority-envelope-missing",
  ),
);
const sharedAuthority = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-authority-shared",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      source: {
        ...canonicalInput.pages[0]!.source,
        jntAcctMbrCnt: 1,
        jntAcctMbrDpstCnt: 1,
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
});
assert.equal(sharedAuthority.status, "rejected");
assert.ok(
  sharedAuthority.diagnostics.some(
    (item) => item.code === "authority-shared-account",
  ),
);
const unknownAuthority = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-authority-unknown",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      source: {
        ...canonicalInput.pages[0]!.source,
        jntAcctMbrTpCd: "unclassified-role",
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
});
assert.equal(unknownAuthority.status, "rejected");
assert.ok(
  unknownAuthority.diagnostics.some(
    (item) => item.code === "authority-role-unknown",
  ),
);
const linkedAuthority = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-authority-security-linked",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      source: {
        ...canonicalInput.pages[0]!.source,
        isSecuAcctBndg: true,
      } as unknown as LineBankTransactionSourceEnvelope,
    },
  ],
});
assert.equal(linkedAuthority.status, "rejected");
assert.ok(
  linkedAuthority.diagnostics.some(
    (item) => item.code === "authority-security-linked",
  ),
);
const inconsistentBalance = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-balance-inconsistent",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      rows: [
        canonicalInput.pages[0]!.rows[0]!,
        { ...canonicalInput.pages[0]!.rows[1]!, afTxBal: "13000" },
      ],
    },
  ],
});
assert.equal(inconsistentBalance.status, "rejected");
assert.ok(
  inconsistentBalance.diagnostics.some(
    (item) => item.code === "balance-transition-inconsistent",
  ),
);
const isolatedBalance = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-balance-isolated",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      rows: [canonicalInput.pages[0]!.rows[0]!],
      txCnt: 1,
      totTxCnt: 1,
    },
  ],
});
assert.equal(isolatedBalance.status, "rejected");
assert.ok(
  isolatedBalance.diagnostics.some(
    (item) => item.code === "balance-transition-insufficient",
  ),
);
const linebankStore = createDomesticDepositStore(":memory:");
const linebankCommit = await commitCanonicalDomesticDeposit(
  linebankStore,
  admittedSourceCapture.capture!,
);
assert.equal(linebankCommit.status, "source-record-only");
assert.equal(linebankCommit.canonicalAdmission, "blocked");
assert.equal(queryCurrent(linebankStore).records.length, 2);
assert.equal(
  (
    linebankStore.db
      .prepare(
        "SELECT COUNT(*) AS count FROM source_captures WHERE record_kind = 'linebank-domestic-deposit-source-record'",
      )
      .get() as { count?: number }
  ).count,
  1,
);
assert.equal(
  (
    linebankStore.db
      .prepare("SELECT COUNT(*) AS count FROM source_records")
      .get() as { count?: number }
  ).count,
  2,
);
assert.equal(
  (
    linebankStore.db
      .prepare("SELECT COUNT(*) AS count FROM source_subjects")
      .get() as { count?: number }
  ).count,
  1,
);
assert.equal(
  (
    linebankStore.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'domestic_deposit_%'",
      )
      .get() as { count?: number }
  ).count,
  0,
);
assert.deepEqual(
  {
    ...linebankStore.db
      .prepare(
        "SELECT scope_kind, completeness, absence_authority FROM capture_scopes",
      )
      .get(),
  },
  {
    scope_kind: "bounded-range",
    completeness: "single-page",
    absence_authority: null,
  },
);

const zeroCanonicalInput = {
  ...canonicalInput,
  captureId: "synthetic-capture-admission-zero-1",
  scope: { startDate: "20250701", endDate: "20250701" },
  pages: [
    {
      pageNbr: 1,
      pageCnt: 1000,
      totTxCnt: 0,
      txCnt: 0,
      rows: [],
      responseCode: "200",
      source: {
        acctNbr: "SYNTHETIC-ACCOUNT",
        arrId: "SYNTHETIC-ARRANGEMENT",
        opnDtm: 1700000000000,
        jntAcctMbrTpCd: "personal-main-account",
        jntMbrListCnt: 0,
        totJntAcctMbrCnt: 0,
        isSecuAcctBndg: false,
      },
    },
  ],
};
const zeroSourceCapture = validateLineBankCanonicalCapture(zeroCanonicalInput);
assert.equal(zeroSourceCapture.status, "source-record-admissible");
assert.equal(zeroSourceCapture.capture?.records.length, 0);
const zeroStore = createDomesticDepositStore(":memory:");
await commitCanonicalDomesticDeposit(zeroStore, zeroSourceCapture.capture!);
assert.equal(queryCurrent(zeroStore).records.length, 0);
assert.deepEqual(
  {
    ...zeroStore.db
      .prepare(
        "SELECT scope_kind, completeness, absence_authority FROM capture_scopes",
      )
      .get(),
  },
  {
    scope_kind: "bounded-range",
    completeness: "single-page",
    absence_authority: null,
  },
);
const zeroRepeat = validateLineBankCanonicalCapture({
  ...zeroCanonicalInput,
  captureId: "synthetic-capture-admission-zero-2",
});
await commitCanonicalDomesticDeposit(zeroStore, zeroRepeat.capture!);
assert.equal(queryCurrent(zeroStore).records.length, 0);
assert.equal(queryCurrent(zeroStore).provenanceCount, 2);
linebankStore.close();
zeroStore.close();

const unknownDirection = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-admission-unknown-direction",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      rows: [{ ...canonicalInput.pages[0]!.rows[0]!, dpstWdrwDsCd: "9" }],
      txCnt: 1,
      totTxCnt: 1,
    },
  ],
});
assert.equal(unknownDirection.status, "rejected");
assert.equal(unknownDirection.capture, null);
assert.ok(
  unknownDirection.diagnostics.some(
    (item) => item.code === "direction-unknown",
  ),
);

const missingBalance = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-admission-missing-balance",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      rows: [{ ...canonicalInput.pages[0]!.rows[0]!, afTxBal: undefined }],
      txCnt: 1,
      totTxCnt: 1,
    },
  ],
});
assert.equal(missingBalance.status, "rejected");
assert.ok(
  missingBalance.diagnostics.some((item) => item.code === "balance-missing"),
);

const changedCancellation = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-admission-cancelled",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      rows: [{ ...canonicalInput.pages[0]!.rows[0]!, cnclTxYn: "Y" }],
      txCnt: 1,
      totTxCnt: 1,
    },
  ],
});
assert.equal(changedCancellation.status, "rejected");
assert.ok(
  changedCancellation.diagnostics.some(
    (item) => item.code === "cancellation-not-explicit-n",
  ),
);

const negativeAmount = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-admission-negative-amount",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      rows: [{ ...canonicalInput.pages[0]!.rows[0]!, txAmt: "-1" }],
      txCnt: 1,
      totTxCnt: 1,
    },
  ],
});
assert.equal(negativeAmount.status, "rejected");
assert.ok(
  negativeAmount.diagnostics.some(
    (item) => item.code === "amount-sign-conflict",
  ),
);

const mismatchedEnvelope = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-admission-envelope-mismatch",
  pages: [
    {
      ...canonicalInput.pages[0]!,
      source: {
        ...canonicalInput.pages[0]!.source,
        acctNbr: "SYNTHETIC-OTHER-ACCOUNT",
      },
    },
  ],
});
assert.equal(mismatchedEnvelope.status, "rejected");
assert.ok(
  mismatchedEnvelope.diagnostics.some(
    (item) => item.code === "source-account-identity-mismatch",
  ),
);

const missingResponseStatus = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-admission-missing-status",
  pages: [{ ...canonicalInput.pages[0]!, responseCode: undefined }],
});
assert.equal(missingResponseStatus.status, "rejected");
assert.ok(
  missingResponseStatus.diagnostics.some(
    (item) => item.code === "response-status-invalid",
  ),
);

const canonicalReversedScope = validateLineBankCanonicalCapture({
  ...canonicalInput,
  captureId: "synthetic-capture-admission-reversed-scope",
  scope: { startDate: "20260102", endDate: "20260101" },
});
assert.equal(canonicalReversedScope.status, "rejected");
assert.ok(
  canonicalReversedScope.diagnostics.some(
    (item) => item.code === "scope-invalid",
  ),
);
