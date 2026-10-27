import type {
  LineBankAccount,
  LineBankTransactionPage,
} from "../../workflows/linebank-statements.ts";

/**
 * Sanitized shape evidence from one live response. Every value below is
 * synthetic; it preserves only the response invariants needed by the
 * LINE Bank deposit checks.
 * In particular, the two rows deliberately share txSeqNbr while differing in
 * other source fields; occurrence-v1 requires crrnDpstNthCnt and txDtm as
 * additional empirical tuple components, while provider identity remains
 * unproven.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE: {
  account: LineBankAccount;
  pages: LineBankTransactionPage[];
} =
  {
    account: { acctNbr: "SYNTHETIC-ACCOUNT", arrId: "SYNTHETIC-ARRANGEMENT" },
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
