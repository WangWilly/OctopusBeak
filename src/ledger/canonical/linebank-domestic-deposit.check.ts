import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
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
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
  linebankCompareZeroResultCaptures,
  linebankSummarizeCrossWindowEvidence,
  linebankBuildSourceOccurrenceKey,
  linebankCompareSourceOccurrenceCaptures,
  validateLineBankCanonicalCapture,
  linebankValidateSourceOccurrenceCapture,
  linebankValidateZeroResultPage,
  preflightLineBankDomesticDeposit,
  validateLineBankHumanAttestedV13Capture,
  commitCanonicalLineBankFinancialCapture,
} from "./linebank-domestic-deposit.ts";
import {
  commitCanonicalDomesticDeposit,
  createDomesticDepositStore,
  queryHistorical,
  queryLineage,
  queryCurrent,
} from "./domestic-deposit-store.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCathayCanonicalFinancialQuery,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
} from "./canonical-source-store.ts";
import { createCanonicalSourceCaptureAdmission } from "./canonical-source-capture-admission.ts";

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

// Human-attested v13 financial admission is a separate, stricter seam. It
// admits only a complete source capture and never infers unsupported rows.
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION,
  "human-attested-v13",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE.providerGuaranteed,
  false,
);
const v13Source = {
  ...canonicalInput.pages[0]!.source,
  opnDtm: 1700000000000,
  jntAcctMbrTpCd: "personal-main-account",
  jntMbrListCnt: 0,
  totJntAcctMbrCnt: 0,
  isSecuAcctBndg: false,
} as unknown as LineBankTransactionSourceEnvelope;
const v13Rows = [
  {
    ...canonicalInput.pages[0]!.rows[0]!,
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
    ...canonicalInput.pages[0]!.rows[0]!,
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
];
const v13Input = {
  ...canonicalInput,
  captureId: "synthetic-v13-capture-1",
  sourceConnection: "accessibility.linebank.com.tw" as const,
  identityEpoch: 1700000000000,
  scope: { startDate: "20260701", endDate: "20260731" },
  observedAt: "2026-07-06T00:00:00.000Z",
  humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
  authority: {
    kind: "personal-main" as const,
    membershipEffectiveDate: null,
  },
  pages: [
    {
      ...canonicalInput.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 2,
      txCnt: 1,
      rows: [v13Rows[0]!],
      source: v13Source,
    },
    {
      ...canonicalInput.pages[0]!,
      pageNbr: 2,
      pageCnt: 1,
      totTxCnt: 2,
      txCnt: 1,
      rows: [v13Rows[1]!],
      source: v13Source,
    },
  ],
};
const admittedV13 = validateLineBankHumanAttestedV13Capture(v13Input);
assert.equal(admittedV13.status, "admissible");
assert.equal(admittedV13.capture?.records.length, 2);
assert.equal(admittedV13.capture?.completeness, "complete-range");
assert.equal(admittedV13.capture?.postingStatus, "posted");
assert.equal(admittedV13.capture?.effectiveTimeBasis, "transaction-time");
assert.equal(admittedV13.capture?.providerGuaranteed, false);
assert.equal(admittedV13.readiness, "canonical-live");
assert.equal(admittedV13.liveValidation, "complete");
assert.deepEqual(admittedV13.financialAdmissionBlockers, []);
assert.equal(JSON.stringify(admittedV13).includes("SYNTHETIC"), false);

const observedEmptyRoleV13 = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-observed-empty-role",
  pages: v13Input.pages.map((page) => ({
    ...page,
    source: {
      ...page.source,
      jntAcctMbrTpCd: "",
      jntMbrListCnt: 0,
      totJntAcctMbrCnt: 0,
      isSecuAcctBndg: false,
    },
  })),
});
assert.equal(observedEmptyRoleV13.status, "admissible");
assert.equal(observedEmptyRoleV13.capture?.records.length, 2);

const isolatedV13 = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-isolated-posted",
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 1,
      txCnt: 1,
      rows: [v13Rows[0]!],
    },
  ],
});
assert.equal(isolatedV13.status, "admissible");
assert.equal(isolatedV13.capture?.records.length, 1);

const inconsistentV13Balance = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-balance-inconsistent",
  pages: [
    v13Input.pages[0]!,
    {
      ...v13Input.pages[1]!,
      rows: [{ ...v13Rows[1]!, afTxBal: "950" }],
    },
  ],
});
assert.equal(inconsistentV13Balance.status, "rejected");
assert.ok(inconsistentV13Balance.diagnostics.includes("amount-invalid"));

const missingAttestation = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  humanAttestation: undefined,
});
assert.equal(missingAttestation.status, "rejected");
assert.ok(missingAttestation.diagnostics.includes("human-attestation-missing"));

const totalsDrift = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  pages: [v13Input.pages[0]!, { ...v13Input.pages[1]!, totTxCnt: 3 }],
});
assert.equal(totalsDrift.status, "rejected");
assert.ok(totalsDrift.diagnostics.includes("totals-drift"));

const unsupportedCancellation = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  pages: [
    {
      ...v13Input.pages[0]!,
      rows: [{ ...v13Rows[0]!, cnclTxYn: "Y" }],
    },
    v13Input.pages[1]!,
  ],
});
assert.equal(unsupportedCancellation.status, "rejected");
assert.ok(
  unsupportedCancellation.diagnostics.includes("unsupported-cancellation"),
);

const sharedBeforeJoin = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  authority: {
    kind: "shared-member" as const,
    membershipEffectiveDate: "20260706",
  },
  pages: v13Input.pages.map((page) => ({
    ...page,
    source: {
      ...page.source,
      jntAcctMbrTpCd: "shared-member",
      jntMbrListCnt: 1,
      totJntAcctMbrCnt: 2,
    } as unknown as LineBankTransactionSourceEnvelope,
  })),
});
assert.equal(sharedBeforeJoin.status, "rejected");
assert.ok(
  sharedBeforeJoin.diagnostics.includes(
    "member-effective-date-before-transaction",
  ),
);

const sharedAfterJoin = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  scope: { startDate: "20260705", endDate: "20260731" },
  authority: {
    kind: "shared-member" as const,
    membershipEffectiveDate: "20260705",
  },
  pages: v13Input.pages.map((page) => ({
    ...page,
    source: {
      ...page.source,
      jntAcctMbrTpCd: "shared-member",
      jntMbrListCnt: 1,
      totJntAcctMbrCnt: 2,
    } as unknown as LineBankTransactionSourceEnvelope,
  })),
});
assert.equal(sharedAfterJoin.status, "rejected");
assert.ok(sharedAfterJoin.diagnostics.includes("authority-shared-account"));

const callerLabelMismatch = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  scope: { startDate: "20260705", endDate: "20260731" },
  authority: {
    kind: "shared-member" as const,
    membershipEffectiveDate: "20260705",
  },
});
assert.equal(callerLabelMismatch.status, "rejected");
assert.ok(callerLabelMismatch.diagnostics.includes("authority-shared-account"));

const forgedAuthority = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  authority: {
    kind: "personal-main",
    membershipEffectiveDate: null,
    trustedByCaller: true,
  } as unknown as typeof v13Input.authority,
});
assert.equal(forgedAuthority.status, "rejected");
assert.ok(forgedAuthority.diagnostics.includes("authority-role-unknown"));

const unknownV13Authority = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  authority: {
    kind: "owner",
    membershipEffectiveDate: null,
  } as unknown as typeof v13Input.authority,
});
assert.equal(unknownV13Authority.status, "rejected");
assert.ok(unknownV13Authority.diagnostics.includes("authority-role-unknown"));

const plausibleEqualTime = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-equal-time-plausible",
  pages: [
    v13Input.pages[0]!,
    {
      ...v13Input.pages[1]!,
      rows: [
        {
          ...v13Rows[1]!,
          txTm: v13Rows[0]!.txTm,
          txDtm: v13Rows[0]!.txDtm,
        },
      ],
    },
  ],
});
assert.equal(plausibleEqualTime.status, "rejected");
assert.ok(
  plausibleEqualTime.diagnostics.includes("transaction-order-ambiguous"),
);

const inconsistentEqualTime = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-equal-time-inconsistent",
  pages: [
    v13Input.pages[0]!,
    {
      ...v13Input.pages[1]!,
      rows: [
        {
          ...v13Rows[1]!,
          txTm: v13Rows[0]!.txTm,
          txDtm: v13Rows[0]!.txDtm,
          afTxBal: "950",
        },
      ],
    },
  ],
});
assert.equal(inconsistentEqualTime.status, "rejected");
assert.ok(
  inconsistentEqualTime.diagnostics.includes("transaction-order-ambiguous"),
);
const ambiguousOrderStore = createDomesticDepositStore(":memory:");
await assert.rejects(
  () =>
    commitCanonicalLineBankFinancialCapture(
      ambiguousOrderStore,
      plausibleEqualTime.capture!,
    ),
  /runtime-validated|v13 seam/i,
);
assert.equal(
  ambiguousOrderStore.db
    .prepare("SELECT COUNT(*) AS count FROM canonical_commits")
    .get()?.count,
  0,
);
ambiguousOrderStore.close();

const zeroV13 = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-zero",
  scope: { startDate: "20260701", endDate: "20260701" },
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 0,
      txCnt: 0,
      rows: [],
    },
  ],
});
assert.equal(zeroV13.status, "admissible");
assert.equal(zeroV13.capture?.records.length, 0);

const v13Directory = await mkdtemp(join(tmpdir(), "linebank-v13-main-"));
const v13Store = createDomesticDepositStore(join(v13Directory, "canonical.sqlite"));
await assert.rejects(
  () =>
    commitCanonicalLineBankFinancialCapture(v13Store, {
      ...admittedV13.capture!,
      captureId: "synthetic-v13-fabricated",
    }),
  /runtime-validated|v13 seam/i,
);
const v13Commit = await commitCanonicalLineBankFinancialCapture(
  v13Store,
  admittedV13.capture!,
);
assert.equal(v13Commit.status, "canonical-live");
assert.equal(v13Commit.transactionCount, 2);
assert.equal(queryCurrent(v13Store).transactions?.length, 2);
const v13Repeat = await commitCanonicalLineBankFinancialCapture(
  v13Store,
  validateLineBankHumanAttestedV13Capture({
    ...v13Input,
    captureId: "synthetic-v13-capture-2",
    observedAt: "2026-07-07T00:00:00.000Z",
  }).capture!,
);
assert.equal(v13Repeat.transactionCount, 2);
assert.equal(queryCurrent(v13Store).transactions?.length, 2);
assert.equal(queryCurrent(v13Store).provenanceCount, 2);

// Before the v13 centralization, the compact payload included capture-local
// provenance.captureId. Existing immutable rows can therefore differ from a
// current recapture only by that field; the source occurrence remains stable.
const lineLegacySourceStore = createCanonicalSourceStore(":memory:");
try {
  const lineAdmission = createCanonicalSourceCaptureAdmission(
    lineLegacySourceStore,
  );
  const lineSourceRequest = (
    captureId: string,
    legacyCaptureProvenance: boolean,
  ) => ({
    captureId,
    integrationNamespace: "linebank",
    sourceConnectionKey: "sha256:linebank-v13-check-connection",
    identityEpoch: "sha256:linebank-v13-check-epoch",
    stream: "domestic-deposit",
    recordKind: "linebank-domestic-deposit-financial-v13",
    routeKey: "linebank/domestic-deposit/human-attested-v13",
    contractVersion: "human-attested-v13",
    subjectDigest: admittedV13.capture!.accountKey,
    observedAt: "2026-07-08T00:00:00.000Z",
    scope: {
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      dateFormat: "YYYY-MM-DD" as const,
      kind: "bounded-range" as const,
      completeness: "complete-range" as const,
      ruleVersion: "linebank/domestic-deposit/human-attested-v13",
    },
    pages: admittedV13.capture!.pages.map((page) => ({
      pageOrdinal: page.pageNbr - 1,
      responseCode: "200" as const,
      terminal: page.pageNbr === admittedV13.capture!.pageCount,
      rowCount: page.txCnt,
      metadata: { pageNbr: page.pageNbr, rowCount: page.txCnt },
    })),
    records: admittedV13.capture!.records.map((record) => {
      const compact = {
        sourceOccurrenceKey: record.sourceOccurrenceKey,
        baseOccurrenceKey: record.baseOccurrenceKey,
        sourceChangeFingerprint: record.sourceChangeFingerprint,
        accountKey: admittedV13.capture!.accountKey,
        sourceConnection: admittedV13.capture!.sourceConnection,
        stream: admittedV13.capture!.stream,
        contractVersion: admittedV13.capture!.contractVersion,
        identityEpoch: admittedV13.capture!.identityEpoch,
        sourceSequence: record.sourceSequence,
        occurrenceCounter: record.occurrenceCounter,
        sourceSequenceKey: record.sourceOccurrenceKey,
        sourceTime: record.sourceTime,
        direction: record.direction,
        sourceDirectionCode: record.sourceDirectionCode,
        amount: record.amount,
        balanceAfter: record.balanceAfter,
        currency: record.currency,
        cancellation: "N",
        cancellationFlags: record.cancellationFlags,
        provenance: {
          ...(legacyCaptureProvenance ? { captureId } : {}),
          matchingRuleVersion: "occurrence-v1",
        },
      };
      return {
        occurrenceKey: record.sourceOccurrenceKey,
        collisionKey: record.baseOccurrenceKey,
        providerKey: record.sourceOccurrenceKey,
        contentHash: record.sourceChangeFingerprint,
        compact,
        compactJson: JSON.stringify(compact),
      };
    }),
  });
  await lineAdmission.admit(lineSourceRequest("line-v13-legacy", true));
  await lineAdmission.admit(lineSourceRequest("line-v13-current", false));
  const lineCurrent = queryCanonicalSourceCurrent(lineLegacySourceStore);
  assert.equal(lineCurrent.records.length, 2);
  assert.equal(lineCurrent.observations.length, 4);
  assert.equal(lineCurrent.provenanceCount, 2);
} finally {
  lineLegacySourceStore.close();
}
const knowledgeOnlyV13 = queryHistorical(v13Store, {
  knowledgeAt: v13Commit.commitSequence,
});
assert.equal(knowledgeOnlyV13.status, "canonical-live");
assert.equal(knowledgeOnlyV13.transactions?.length, 2);
assert.equal(knowledgeOnlyV13.financialCutoffApplied, false);
assert.deepEqual(knowledgeOnlyV13.cutoff, {
  kind: "knowledge",
  knowledgeAt: v13Commit.commitSequence,
});
const beforeFinancialV13 = queryHistorical(v13Store, {
  knowledgeAt: v13Commit.commitSequence,
  financialAt: "2026-07-04",
});
assert.equal(beforeFinancialV13.status, "canonical-live");
assert.equal(beforeFinancialV13.transactions.length, 0);
assert.equal(beforeFinancialV13.financialCutoffApplied, true);
assert.deepEqual(beforeFinancialV13.cutoff, {
  kind: "both",
  knowledgeAt: v13Commit.commitSequence,
  financialAt: "2026-07-04",
});
const onFinancialV13 = queryHistorical(v13Store, {
  knowledgeAt: v13Commit.commitSequence,
  financialAt: "2026-07-05",
});
assert.equal(onFinancialV13.status, "canonical-live");
assert.equal(onFinancialV13.transactions.length, 2);
assert.equal(onFinancialV13.financialCutoffApplied, true);
const committedV13Lineage = queryLineage(v13Store, {
  sourceOccurrenceKey: admittedV13.capture!.records[0]!.sourceOccurrenceKey,
  sourceConnection: v13Input.sourceConnection,
  identityEpoch: v13Input.identityEpoch,
  stream: "domestic-deposit",
  accountKey: admittedV13.capture!.accountKey,
});
assert.equal(committedV13Lineage.status, "canonical-live");
assert.equal(committedV13Lineage.transactions?.length, 1);
assert.equal(committedV13Lineage.records.length, 1);
assert.equal(committedV13Lineage.observations.length, 2);
assert.equal(committedV13Lineage.provenance.length, 2);
assert.equal(committedV13Lineage.provenanceCount, 2);
assert.equal(committedV13Lineage.expectedObservationCount, 2);
assert.equal(committedV13Lineage.provenanceComplete, true);
assert.ok(
  committedV13Lineage.observations.every(
    (observation) =>
      observation.sourceOccurrenceKey ===
        admittedV13.capture!.records[0]!.sourceOccurrenceKey &&
      observation.provenance.captureId.length > 0,
  ),
);

const incompleteLineageStore = createDomesticDepositStore(":memory:");
await commitCanonicalLineBankFinancialCapture(
  incompleteLineageStore,
  admittedV13.capture!,
);
incompleteLineageStore.db.exec("DELETE FROM source_record_provenance");
const incompleteV13Lineage = queryLineage(incompleteLineageStore, {
  sourceOccurrenceKey: admittedV13.capture!.records[0]!.sourceOccurrenceKey,
  sourceConnection: v13Input.sourceConnection,
  identityEpoch: v13Input.identityEpoch,
  stream: "domestic-deposit",
  accountKey: admittedV13.capture!.accountKey,
});
assert.notEqual(incompleteV13Lineage.status, "canonical-live");
assert.equal(incompleteV13Lineage.records.length, 0);
assert.equal(incompleteV13Lineage.observations.length, 0);
assert.equal(incompleteV13Lineage.provenanceCount, 0);
assert.equal(incompleteV13Lineage.expectedObservationCount, 1);
assert.equal(incompleteV13Lineage.provenanceComplete, false);
incompleteLineageStore.close();

const repeatedLineageCaptures = [
  admittedV13.capture!,
  validateLineBankHumanAttestedV13Capture({
    ...v13Input,
    captureId: "synthetic-v13-lineage-repeat-2",
    observedAt: "2026-07-07T00:00:00.000Z",
  }).capture!,
  validateLineBankHumanAttestedV13Capture({
    ...v13Input,
    captureId: "synthetic-v13-lineage-repeat-3",
    observedAt: "2026-07-08T00:00:00.000Z",
  }).capture!,
];
const repeatedLineageRequest = {
  sourceOccurrenceKey: admittedV13.capture!.records[0]!.sourceOccurrenceKey,
  sourceConnection: v13Input.sourceConnection,
  identityEpoch: v13Input.identityEpoch,
  stream: "domestic-deposit",
  accountKey: admittedV13.capture!.accountKey,
};
for (const missingIndex of [0, 1, 2]) {
  const partialStore = createDomesticDepositStore(":memory:");
  for (const capture of repeatedLineageCaptures)
    await commitCanonicalLineBankFinancialCapture(partialStore, capture);
  const complete = queryLineage(partialStore, repeatedLineageRequest);
  assert.equal(complete.status, "canonical-live");
  assert.equal(complete.observations.length, 3);
  assert.equal(complete.provenance.length, 3);
  assert.equal(complete.expectedObservationCount, 3);
  assert.equal(complete.provenanceComplete, true);
  partialStore.db
    .prepare(
      `DELETE FROM source_record_provenance WHERE rowid = (
        SELECT provenance.rowid FROM source_record_provenance provenance
        JOIN source_records record ON record.source_record_id = provenance.source_record_id
        WHERE record.occurrence_key = ?
        ORDER BY provenance.rowid LIMIT 1 OFFSET ?
      )`,
    )
    .run(repeatedLineageRequest.sourceOccurrenceKey, missingIndex);
  const partial = queryLineage(partialStore, repeatedLineageRequest);
  assert.notEqual(partial.status, "canonical-live");
  assert.equal(partial.observations.length, 2);
  assert.equal(partial.provenance.length, 2);
  assert.equal(partial.expectedObservationCount, 3);
  assert.equal(partial.provenanceComplete, false);
  partialStore.close();
}

const extraLineageStore = createDomesticDepositStore(":memory:");
for (const capture of repeatedLineageCaptures)
  await commitCanonicalLineBankFinancialCapture(extraLineageStore, capture);
extraLineageStore.db
  .prepare(
    `INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id)
     SELECT first_record.source_record_id, second_record.capture_id, second_record.commit_id
     FROM source_records first_record
     JOIN source_records second_record
       ON second_record.occurrence_key = first_record.occurrence_key
      AND second_record.rowid > first_record.rowid
     WHERE first_record.occurrence_key = ?
     ORDER BY first_record.rowid, second_record.rowid LIMIT 1`,
  )
  .run(repeatedLineageRequest.sourceOccurrenceKey);
const extraLineage = queryLineage(extraLineageStore, repeatedLineageRequest);
assert.notEqual(extraLineage.status, "canonical-live");
assert.equal(extraLineage.observations.length, 3);
assert.equal(extraLineage.provenance.length, 3);
assert.equal(extraLineage.expectedObservationCount, 3);
assert.equal(extraLineage.provenanceComplete, false);
extraLineageStore.close();

const missingObservationLinkStore = createDomesticDepositStore(":memory:");
for (const capture of repeatedLineageCaptures)
  await commitCanonicalLineBankFinancialCapture(
    missingObservationLinkStore,
    capture,
  );
missingObservationLinkStore.db
  .prepare(
    `DELETE FROM source_record_scopes WHERE source_record_id = (
      SELECT record.source_record_id FROM source_records record
      WHERE record.occurrence_key = ?
      ORDER BY record.rowid LIMIT 1 OFFSET 1
    )`,
  )
  .run(repeatedLineageRequest.sourceOccurrenceKey);
const missingObservationLink = queryLineage(
  missingObservationLinkStore,
  repeatedLineageRequest,
);
assert.notEqual(missingObservationLink.status, "canonical-live");
assert.equal(missingObservationLink.observations.length, 3);
assert.equal(missingObservationLink.provenance.length, 3);
assert.equal(missingObservationLink.expectedObservationCount, 3);
assert.equal(missingObservationLink.provenanceComplete, false);
missingObservationLinkStore.close();

const absentSecond = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-absence",
  observedAt: "2026-07-08T00:00:00.000Z",
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 1,
      txCnt: 1,
      rows: [v13Rows[0]!],
    },
  ],
});
assert.equal(absentSecond.status, "admissible");
await commitCanonicalLineBankFinancialCapture(v13Store, absentSecond.capture!);
assert.equal(queryCurrent(v13Store).transactions.length, 1);
assert.equal(
  v13Store.db
    .prepare(
      "SELECT COUNT(*) AS count FROM assertion_transitions WHERE event_kind = 'withdrawn'",
    )
    .get()?.count,
  1,
);

const restoredV13 = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-restoration",
  observedAt: "2026-07-09T00:00:00.000Z",
});
await commitCanonicalLineBankFinancialCapture(v13Store, restoredV13.capture!);
assert.equal(queryCurrent(v13Store).transactions.length, 2);
assert.equal(
  v13Store.db
    .prepare(
      "SELECT COUNT(*) AS count FROM assertion_transitions WHERE event_kind = 'restored'",
    )
    .get()?.count,
  1,
);

const differentZero = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-different-zero",
  observedAt: "2026-08-02T00:00:00.000Z",
  scope: { startDate: "20260801", endDate: "20260801" },
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 0,
      txCnt: 0,
      rows: [],
    },
  ],
});
await commitCanonicalLineBankFinancialCapture(v13Store, differentZero.capture!);
assert.equal(queryCurrent(v13Store).transactions.length, 2);

const overwriteV13 = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-overwrite",
  observedAt: "2026-07-10T00:00:01.000Z",
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 1,
      txCnt: 1,
      rows: [{ ...v13Rows[0]!, txAmt: "200" }],
    },
  ],
});
assert.equal(overwriteV13.status, "admissible");
await assert.rejects(
  () =>
    commitCanonicalLineBankFinancialCapture(v13Store, overwriteV13.capture!),
  /content overwrite|overwrite/i,
);
assert.equal(queryCurrent(v13Store).transactions.length, 2);

const collisionV13 = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-collision",
  observedAt: "2026-07-10T00:00:00.000Z",
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 1,
      txCnt: 1,
      rows: [
        {
          ...v13Rows[0]!,
          txTm: "143740",
          txDtm: 1783233460000,
        },
      ],
    },
  ],
});
assert.equal(collisionV13.status, "admissible");
await assert.rejects(
  () =>
    commitCanonicalLineBankFinancialCapture(v13Store, collisionV13.capture!),
  /collision|overwrite/i,
);
assert.equal(queryCurrent(v13Store).transactions.length, 2);

const lateFailure = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-late-failure",
  observedAt: "2026-07-11T00:00:00.000Z",
});
assert.equal(lateFailure.status, "admissible");
const commitsBeforeLateFailure = v13Store.db
  .prepare("SELECT COUNT(*) AS count FROM canonical_commits")
  .get()?.count;
const lateFailureSchemaDb = new DatabaseSync(v13Store.databasePath);
lateFailureSchemaDb.exec(`CREATE TRIGGER inject_v13_late_failure
  BEFORE UPDATE ON source_sync_states
  BEGIN SELECT RAISE(ABORT, 'injected late v13 failure'); END`);
lateFailureSchemaDb.close();
await assert.rejects(
  () => commitCanonicalLineBankFinancialCapture(v13Store, lateFailure.capture!),
  /injected late v13 failure/i,
);
const cleanupLateFailureSchemaDb = new DatabaseSync(v13Store.databasePath);
cleanupLateFailureSchemaDb.exec("DROP TRIGGER inject_v13_late_failure");
cleanupLateFailureSchemaDb.close();
assert.equal(
  v13Store.db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()
    ?.count,
  commitsBeforeLateFailure,
);
assert.equal(
  v13Store.db
    .prepare("SELECT 1 FROM source_captures WHERE capture_key = ?")
    .get("synthetic-v13-late-failure"),
  undefined,
);

const crossEpochInput = {
  ...v13Input,
  captureId: "synthetic-v13-cross-epoch",
  identityEpoch: 1800000000000,
  observedAt: "2026-07-12T00:00:00.000Z",
  pages: v13Input.pages.map((page) => ({
    ...page,
    source: {
      ...page.source,
      opnDtm: 1800000000000,
    } as LineBankTransactionSourceEnvelope,
  })),
};
const crossEpoch = validateLineBankHumanAttestedV13Capture(crossEpochInput);
assert.equal(crossEpoch.status, "admissible");
await commitCanonicalLineBankFinancialCapture(v13Store, crossEpoch.capture!);
assert.equal(queryCurrent(v13Store).transactions.length, 4);
assert.equal(
  queryLineage(v13Store, {
    sourceOccurrenceKey: admittedV13.capture!.records[0]!.sourceOccurrenceKey,
    sourceConnection: v13Input.sourceConnection,
    identityEpoch: v13Input.identityEpoch,
    stream: "domestic-deposit",
    accountKey: admittedV13.capture!.accountKey,
  }).transactions.length,
  1,
);
assert.equal(
  queryLineage(v13Store, {
    sourceOccurrenceKey: crossEpoch.capture!.records[0]!.sourceOccurrenceKey,
    sourceConnection: crossEpochInput.sourceConnection,
    identityEpoch: crossEpochInput.identityEpoch,
    stream: "domestic-deposit",
    accountKey: crossEpoch.capture!.accountKey,
  }).transactions.length,
  1,
);
assert.equal(
  v13Store.db.prepare("SELECT COUNT(*) AS count FROM financial_accounts").get()
    ?.count,
  2,
);
assert.equal(
  v13Store.db
    .prepare(
      `SELECT COUNT(*) AS count FROM projection_generation_transactions projected
       JOIN active_projection_generation active
         ON active.generation_id = projected.generation_id`,
    )
    .get()?.count,
  4,
);
assert.equal(
  JSON.stringify(
    v13Store.db
      .prepare("SELECT payload_json FROM source_records WHERE record_kind = ?")
      .all("linebank-domestic-deposit-financial-v13"),
  ).includes("SYNTHETIC-ACCOUNT"),
  false,
);

const zeroFirstStore = createDomesticDepositStore(":memory:");
await commitCanonicalLineBankFinancialCapture(zeroFirstStore, zeroV13.capture!);
assert.equal(queryCurrent(zeroFirstStore).transactions.length, 0);
assert.equal(
  zeroFirstStore.db
    .prepare("SELECT COUNT(*) AS count FROM source_sync_states")
    .get()?.count,
  1,
);
assert.equal(
  zeroFirstStore.db
    .prepare("SELECT COUNT(*) AS count FROM current_projection_state")
    .get()?.count,
  1,
);
zeroFirstStore.close();

const backfillStore = createDomesticDepositStore(":memory:");
const laterOnly = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-backfill-later",
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 1,
      txCnt: 1,
      rows: [v13Rows[0]!],
    },
  ],
});
const laterCommit = await commitCanonicalLineBankFinancialCapture(
  backfillStore,
  laterOnly.capture!,
);
const olderRow = {
  ...v13Rows[0]!,
  txSeqNbr: "9",
  crrnDpstNthCnt: 1,
  txTm: "143737",
  txDtm: 1783233457000,
  txAmt: "50",
  afTxBal: "900",
};
const withBackfill = validateLineBankHumanAttestedV13Capture({
  ...v13Input,
  captureId: "synthetic-v13-backfill-complete",
  observedAt: "2026-07-07T00:00:00.000Z",
  pages: [
    {
      ...v13Input.pages[0]!,
      pageNbr: 1,
      pageCnt: 2,
      totTxCnt: 2,
      txCnt: 2,
      rows: [olderRow, v13Rows[0]!],
    },
  ],
});
assert.equal(withBackfill.status, "admissible");
await commitCanonicalLineBankFinancialCapture(
  backfillStore,
  withBackfill.capture!,
);
assert.equal(queryCurrent(backfillStore).transactions.length, 2);
assert.equal(
  queryHistorical(backfillStore, {
    knowledgeAt: laterCommit.commitSequence,
  }).transactions.length,
  1,
);
assert.equal(
  backfillStore.db
    .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
    .get()?.count,
  2,
);
backfillStore.close();

const persistentV13Directory = await mkdtemp(
  join(tmpdir(), "linebank-v13-persistent-"),
);
try {
  const path = join(persistentV13Directory, "canonical.sqlite");
  const persistent = createDomesticDepositStore(path);
  await commitCanonicalLineBankFinancialCapture(
    persistent,
    admittedV13.capture!,
  );
  await commitCanonicalLineBankFinancialCapture(
    persistent,
    absentSecond.capture!,
  );
  await commitCanonicalLineBankFinancialCapture(
    persistent,
    restoredV13.capture!,
  );
  persistent.close();
  const reopened = createDomesticDepositStore(path);
  assert.equal(queryCurrent(reopened).transactions.length, 2);
  assert.equal(queryCurrent(reopened).status, "canonical-live");
  assert.deepEqual(queryCurrent(reopened).financialAdmissionBlockers, []);
  reopened.close();
} finally {
  await rm(persistentV13Directory, { recursive: true, force: true });
}

const mixedV13Directory = await mkdtemp(join(tmpdir(), "linebank-v13-mixed-"));
try {
  await commitCathayDomesticDeposit(
    mixedV13Directory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const cathayBefore = await createCathayCanonicalFinancialQuery(
    mixedV13Directory,
  ).current({ kind: "current" });
  const mixed = createDomesticDepositStore(
    join(mixedV13Directory, "canonical.sqlite"),
  );
  await commitCanonicalLineBankFinancialCapture(mixed, admittedV13.capture!);
  assert.equal(queryCurrent(mixed).transactions.length, 2);
  mixed.close();
  const cathayAfter = await createCathayCanonicalFinancialQuery(
    mixedV13Directory,
  ).current({ kind: "current" });
  assert.equal(
    cathayAfter.transactions.length,
    cathayBefore.transactions.length,
  );
} finally {
  await rm(mixedV13Directory, { recursive: true, force: true });
}
v13Store.close();
await rm(v13Directory, { recursive: true, force: true });
