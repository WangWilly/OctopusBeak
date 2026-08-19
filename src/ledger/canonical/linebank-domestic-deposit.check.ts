import assert from "node:assert/strict";
import {
  LINEBANK_DOMESTIC_DEPOSIT_AUTHORITY,
  LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_KEY_DESCRIPTOR,
  LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_CANDIDATE_FIELDS,
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_FIXTURE,
  LINEBANK_DOMESTIC_DEPOSIT_CROSS_WINDOW_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE,
  LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_DIRECTION_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_PROVENANCE,
  LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  LINEBANK_DOMESTIC_DEPOSIT_REPEAT_CAPTURE_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_REPEAT_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  linebankSummarizeCrossWindowEvidence,
  preflightLineBankDomesticDeposit,
} from "./linebank-domestic-deposit.ts";

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

const page = {
  pageNbr: 1,
  pageCnt: 1000,
  totTxCnt: 1,
  txCnt: 1,
  rows: [
    {
      txSeqNbr: "1",
      txDt: "20260705",
      txTm: "143738",
      txDtm: 1700000000000,
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
      },
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
assert.ok(
  valid.diagnostics.some(
    (item) => item.code === "direction-mapping-incomplete",
  ),
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

// The sanitized live shape preserves one complete page and matching counts,
// but repeats txSeqNbr across two distinct rows.  That proves the current
// occurrence key is insufficient and must remain blocked before any write.
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
assert.equal(liveEvidence.directionEvidence.completeMapping, false);
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
assert.ok(
  liveEvidence.diagnostics.some(
    (item) => item.code === "transaction-key-duplicate",
  ),
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
assert.ok(
  crossLongPreflight.diagnostics.some(
    (item) => item.code === "transaction-key-duplicate",
  ),
);
assert.equal(
  crossShortPreflight.diagnostics.some(
    (item) => item.code === "transaction-key-duplicate",
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
