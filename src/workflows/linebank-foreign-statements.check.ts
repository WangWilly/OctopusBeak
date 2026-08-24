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
      source: { opnDtm: 133 },
      responseCode: "200",
    },
  ],
});
assert.equal(input.records[0]!.currencyEvidence.currency, "USD");
assert.equal(input.records[0]!.direction, "inflow");

const directory = await mkdtemp(join(tmpdir(), "linebank-foreign-133-"));
try {
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  await commitForeignCurrencyDepositCapture(store, input);
  assert.equal(queryForeignCurrencyDepositCurrent(store).transactions.length, 1);
  store.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

