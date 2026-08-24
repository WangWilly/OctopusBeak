import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLinebankForeignCurrencyCaptureInput,
  linebankEpochMillisecondsFromSourceDateTime,
} from "./linebank-statements.ts";
import {
  commitForeignCurrencyDepositCapture,
  admitForeignCurrencyDepositCapture,
  queryForeignCurrencyDepositCurrent,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";

const account = {
  acctNbr: "LINE-FOREIGN-133",
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
      source: { acctNbr: "LINE-FOREIGN-133", arrId: "ARR-133", opnDtm: 133 },
      responseCode: "200",
    },
  ],
  captureOccurrenceId: "linebank-foreign-check-observation-1",
});
assert.equal(input.records[0]!.currencyEvidence.currency, "USD");
assert.equal(input.records[0]!.direction, "inflow");
assert.equal(
  admitForeignCurrencyDepositCapture(input).records[0]!.currency,
  "USD",
);
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

const directory = await mkdtemp(join(tmpdir(), "linebank-foreign-133-"));
try {
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  await commitForeignCurrencyDepositCapture(store, input);
  assert.equal(queryForeignCurrencyDepositCurrent(store).transactions.length, 1);
  store.close();
} finally {
  await rm(directory, { recursive: true, force: true });
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
const emptyLinebankDirectory = await mkdtemp(join(tmpdir(), "linebank-foreign-empty-133-"));
try {
  const store = createCanonicalSourceStore(join(emptyLinebankDirectory, "canonical.sqlite"));
  const result = await commitForeignCurrencyDepositCapture(
    store,
    admitForeignCurrencyDepositCapture(emptyLinebankInput),
  );
  assert.equal(result.transactionCount, 0);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get() as { count?: number }).count ?? 0),
    1,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get() as { count?: number }).count ?? 0),
    1,
  );
  store.close();
} finally {
  await rm(emptyLinebankDirectory, { recursive: true, force: true });
}
