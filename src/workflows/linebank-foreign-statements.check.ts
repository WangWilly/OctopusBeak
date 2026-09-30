import assert from "node:assert/strict";
import {
  buildLinebankForeignCurrencyCaptureInput,
  linebankEpochMillisecondsFromSourceDateTime,
} from "./linebank-statements.ts";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.ts";

const account = {
  acctNbr: "14101800082221",
  arrId: "ARR-133",
  acctNick: "外幣活存",
  currCd: "USD",
};
const txDtm = linebankEpochMillisecondsFromSourceDateTime("20260802", "091011");
const input = buildLinebankForeignCurrencyCaptureInput({
  account,
  dateRange: { startDate: "20260801", endDate: "20260824" },
  pages: [
    {
      pageNbr: 1,
      pageCnt: 1,
      totTxCnt: 1,
      txCnt: 1,
      rows: [
        {
          txSeqNbr: "1",
          txDt: "20260802",
          txTm: "091011",
          txDtm,
          dpstWdrwDsCd: "1",
          txAmt: "10.25",
          afTxBal: "100.25",
          crrnDpstNthCnt: 1,
          bizTxFuncTpNm: "foreign deposit",
        },
      ],
      source: { acctNbr: "14101800082221", arrId: "ARR-133", opnDtm: 133 },
      responseCode: "200",
    },
  ],
  captureOccurrenceId: "linebank-foreign-check-observation-1",
});
assert.equal(input.records[0]!.currencyEvidence.currency, "USD");
assert.equal(input.records[0]!.direction, "inflow");
assert.deepEqual(input.accountNumber, {
  value: "14101800082221",
  kind: "depository-account",
  evidenceVersion: "linebank/foreign-account/account-number-v1",
  sourceField:
    "GET /v1/account/common/payables content.dpstAcctList[].acctNbr",
});
assert.equal(
  admitForeignCurrencyDepositCapture(input).records[0]!.currency,
  "USD",
);
const laterTxDtm = linebankEpochMillisecondsFromSourceDateTime(
  "20260802",
  "091012",
);
const distinctLinebankOccurrence = buildLinebankForeignCurrencyCaptureInput({
  account,
  dateRange: { startDate: "20260801", endDate: "20260824" },
  pages: [{
    pageNbr: 1,
    pageCnt: 1,
    totTxCnt: 1,
    txCnt: 1,
    rows: [{
      txSeqNbr: "1",
      txDt: "20260802",
      txTm: "091012",
      txDtm: laterTxDtm,
      dpstWdrwDsCd: "1",
      txAmt: "10.25",
      afTxBal: "100.25",
      crrnDpstNthCnt: 1,
      bizTxFuncTpNm: "foreign deposit",
    }],
    source: { acctNbr: "14101800082221", arrId: "ARR-133", opnDtm: 133 },
    responseCode: "200",
  }],
  captureOccurrenceId: "linebank-foreign-check-distinct-txdtm",
});
assert.notEqual(
  distinctLinebankOccurrence.records[0]!.sourceKey,
  input.records[0]!.sourceKey,
);
for (const directionCode of ["1", "2"] as const) {
  assert.throws(
    () =>
      buildLinebankForeignCurrencyCaptureInput({
      account,
      dateRange: { startDate: "20260801", endDate: "20260824" },
      pages: [{
        pageNbr: 1,
        pageCnt: 1,
        totTxCnt: 1,
        txCnt: 1,
        rows: [{
          txSeqNbr: "2",
          txDt: "20260802",
          txTm: "091011",
          txDtm,
          dpstWdrwDsCd: directionCode,
          txAmt: "-10.25",
          afTxBal: "100.25",
          crrnDpstNthCnt: 1,
          bizTxFuncTpNm: "invalid signed inflow",
        }],
        source: { acctNbr: "14101800082221", arrId: "ARR-133", opnDtm: 133 },
        responseCode: "200",
      }],
      captureOccurrenceId: "linebank-foreign-sign-conflict",
      }),
    /sign|direction|negative|unsigned/i,
  );
}
assert.throws(
  () =>
    buildLinebankForeignCurrencyCaptureInput({
      account,
      dateRange: { startDate: "20260801", endDate: "20260824" },
      pages: [{ ...inputPagesWithoutEpoch() }],
    }),
  /identity epoch|source account identity/i,
);

function inputPagesWithoutEpoch() {
  return {
    pageNbr: 1,
    pageCnt: 1,
    totTxCnt: 0,
    txCnt: 0,
    rows: [],
  };
}

const emptyLinebankPage = {
  pageNbr: 1,
  pageCnt: 1000,
  totTxCnt: 0,
  txCnt: 0,
  source: { acctNbr: "LINE-FOREIGN-EMPTY-133", arrId: "arr-empty-133", opnDtm: 133 },
  responseCode: "200",
  rows: [],
};
const emptyLinebankInput = buildLinebankForeignCurrencyCaptureInput({
  account: { acctNbr: "LINE-FOREIGN-EMPTY-133", arrId: "arr-empty-133", currCd: "USD" },
  dateRange: { startDate: "20260801", endDate: "20260824" },
  pages: [emptyLinebankPage],
  captureOccurrenceId: "linebank-foreign-check-empty-observation",
});
assert.equal(emptyLinebankInput.records.length, 0);
const ambiguousLinebankPage = { ...emptyLinebankPage, totTxCnt: 1 };
assert.throws(
  () =>
    buildLinebankForeignCurrencyCaptureInput({
      account: { acctNbr: "LINE-FOREIGN-EMPTY-133", arrId: "arr-empty-133", currCd: "USD" },
      dateRange: { startDate: "20260801", endDate: "20260824" },
      pages: [ambiguousLinebankPage],
      captureOccurrenceId: "linebank-foreign-check-ambiguous-empty",
    }),
  /total|complete|empty|terminal/i,
);
