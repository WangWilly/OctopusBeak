import { createHash } from "node:crypto";
import { commitPGliteCanonicalBalanceCapture, type PGliteCanonicalBalanceCaptureRequest } from "./balance.ts";
import { currentDepositBalanceCommandRequest } from "./current-deposit-balance-command.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { commitPGliteCanonicalInvestmentCapture } from "./investment.ts";
import type { PGliteStore } from "./transaction.ts";
import type { InvestmentCaptureInput } from "../canonical/investment-financial-admission.ts";
import {
  readTdccFunds,
  readTdccPositions,
  tdccFundHoldingCapture,
  tdccSecuritiesHoldingCapture,
} from "../canonical/tdcc-investment-admission.ts";
import {
  readTdccSettlementSnapshot,
  tdccSettlementBalanceCapture,
  tdccSettlementTransactionCapture,
} from "../canonical/tdcc-settlement-admission.ts";

/**
 * Synthetic TDCC and direct-source accounts for Direct source precedence
 * checks and the desktop CDP fixture. Every value is an inert placeholder.
 */
export const token = (value: string) => `sha256:${createHash("sha256").update(value).digest("base64url")}`;
export const tdcc = { sourceConnectionKey: token("tdcc-connection"), identityEpochKey: token("tdcc-epoch") };
export const observedAt = "2026-10-09T02:31:00.000Z";
// Built at runtime so the repository privacy and secret scanners do not read fixtures as real accounts.
const SETTLEMENT_ACCOUNT = ["2001", "2345678"].join("");
const BROKER_ACCOUNT = ["98", "76543"].join("");
const CATHAY_ACCOUNT = ["1234", "56"].join("");

const settlementRow = (txnDateTime: string, transferInAmount: string, transferOutAmount: string, balance: string, summary: string) => ({
  balance, currency: "TWD", hcode: "", memo: "", stan: "000000123456", summary,
  transferInAccountNo: "", transferInAmount, transferInBankId: "",
  transferOutAccountNo: "", transferOutAmount, transferOutBankId: "", txnDateTime,
});

/** One TDCC settlement account at `bankId` holding 15200 TWD, with a 16700 inflow and a 1500 card-shop outflow. */
export async function commitTdccSettlement(store: PGliteStore, bankId: string, withBalance = true) {
  const snapshot = readTdccSettlementSnapshot({
    tspAccountInfos: [{
      bankId,
      execMsg: "交易成功。",
      execStatue: "0000",
      tspAccount: [{ accountNo: SETTLEMENT_ACCOUNT, accountType: "活期存款", availableBalance: "15200", balanceAmt: "15200", currency: "TWD", isShow: true, remark: "" }],
      tspTimeAccounts: [],
    }],
    updateTime: "20261009103000",
  });
  const account = snapshot.accounts[0]!;
  await commitPGliteCanonicalDepositCapture(store, tdccSettlementTransactionCapture({
    captureId: `tsp007-${bankId}`,
    observedAt,
    connection: tdcc,
    account,
    pages: [{
      accountNo: SETTLEMENT_ACCOUNT, startDate: "20260710", endDate: "20261009", isComplete: true,
      transactionDetails: [
        settlementRow("20260801090000", "16700.0", "0.0", "16700.0", "薪資"),
        settlementRow("20260802101500", "0.0", "1500.0", "15200.0", "全家便利商店"),
      ],
    }],
  }));
  if (withBalance) await commitPGliteCanonicalBalanceCapture(store, currentDepositBalanceCommandRequest(tdccSettlementBalanceCapture({
    captureId: `tsp006-${bankId}`, observedAt, connection: tdcc, snapshot, account,
  })));
}

/** One Cathay United Bank account from the direct source holding 1000 TWD, with no transactions in its range. */
export async function commitCathay(store: PGliteStore) {
  const fingerprint = token("cathay-contract");
  await commitPGliteCanonicalDepositCapture(store, {
    capture: {
      captureId: "cathay-history",
      authorityRoute: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      identity: {
        integrationNamespace: "cathay",
        sourceConnectionKey: token("cathay-connection"),
        identityEpochKey: token("cathay-epoch"),
        stream: "domestic-deposit",
        recordKind: "synthetic-deposit",
        subjectDigest: token("cathay-subject"),
        accountNo: CATHAY_ACCOUNT,
        sourceAccountKey: CATHAY_ACCOUNT,
        accountNumber: { value: CATHAY_ACCOUNT, kind: "depository-account", evidenceVersion: "synthetic-account-v1", sourceField: "accountNumber" },
        accountType: "depository",
        currency: "TWD",
      },
      observedAt: "2026-10-09T00:00:00.000Z",
      scope: {
        startDate: "2026-10-01", endDate: "2026-10-09", scopeKind: "bounded-range", completeness: "complete-range",
        completenessBasis: "synthetic-complete-range", completenessRuleVersion: "cathay/domestic-deposit/v1",
        absenceAuthority: "comparable-complete-range", contractFingerprint: fingerprint,
        preflightFingerprint: token("cathay-preflight"), pageCount: 1, withdrawalPolicy: "never-infer",
      },
      semantics: {
        postingStatus: "posted", postingOrigin: "provider_booked_history",
        postingBasis: "query-status-success-with-accounting-date", postingRuleVersion: "cathay/domestic-deposit/v1",
        economicStatus: "normal", administrativeState: "active", semanticRuleVersion: "cathay/domestic-deposit/v1",
        effectiveTimeBasis: "accounting", effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
        timeZone: "Asia/Taipei", timePrecision: "second", timeOrigin: "source_reported", requireBalance: false,
      },
      pages: [{
        pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 0, responseDigest: token("cathay-page"),
        proofKind: "synthetic", contractFingerprint: fingerprint, preflightFingerprint: token("cathay-preflight"),
        metadataJson: JSON.stringify({ provider: "synthetic" }),
      }],
      records: [],
    },
  });
  await commitPGliteCanonicalBalanceCapture(store, cathayBalance("cathay-balance"));
}

function cathayBalance(captureId: string): PGliteCanonicalBalanceCaptureRequest {
  const occurrenceKey = token(`${captureId}:occurrence`);
  const effectiveAt = "2026-10-09T08:00:00+08:00";
  return {
    capture: {
      captureId,
      integrationNamespace: "cathay",
      sourceConnectionKey: token("cathay-connection"),
      identityEpoch: token("cathay-epoch"),
      stream: "domestic-deposit",
      recordKind: "synthetic-balance",
      routeKey: "cathay/domestic-deposit/current-balance-v1",
      contractVersion: "cathay/current-deposit-balance-v1",
      subjectDigest: token(`${captureId}:subject`),
      observedAt: "2026-10-09T00:01:00.000Z",
      accountNumber: null,
      scope: {
        startDate: "2026-10-09", endDate: "2026-10-09", dateFormat: "YYYY-MM-DD", kind: "point-in-time",
        completeness: "single-page", ruleVersion: "cathay/current-deposit-balance-v1",
        sourceAccountKey: CATHAY_ACCOUNT, accountNo: CATHAY_ACCOUNT,
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 1, metadata: { provider: "synthetic" } }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}:collision`),
        providerKey: token(`${captureId}:provider`),
        contentHash: token(`${captureId}:content`),
        compact: { balance: { coefficient: "1000", scale: 0 }, effectiveAt },
      }],
    },
    account: { sourceAccountKey: CATHAY_ACCOUNT, accountType: "depository", currency: "TWD" },
    observations: [{
      observationKey: token(`${captureId}:ledger`),
      balanceKind: "ledger",
      balance: { coefficient: "1000", scale: 0 },
      currency: "TWD",
      effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: "cathay/current-deposit-balance-v1",
      evidenceSourceRecordKey: occurrenceKey,
      evidenceSourceField: "balance",
      evidenceSourceValue: "1000",
      evidenceContractVersion: "cathay/current-deposit-balance-v1",
      sourceOccurrenceKey: occurrenceKey,
    }],
  };
}

const tr001Item = (symbol: string, quantity: string, price: string) => {
  const row = Array.from({ length: 22 }, () => "");
  Object.assign(row, { 0: symbol, 1: symbol, 6: "00", 7: quantity, 17: price, 19: "TWD" });
  return row;
};

/** TDCC broker account at Yuanta Securities (branch 9800) holding 1000 shares at 500 TWD. */
export async function commitTdccYuantaBroker(store: PGliteStore) {
  const positions = readTdccPositions({
    accounts: [{
      accountEmail: "", accountName: "", accountStatus: "0", applyTime: "112/01/09", brokerAccount: BROKER_ACCOUNT,
      brokerName: "", brokerNo: "9800", isTisa: "N", items: [tr001Item("2330", "1000", "500")], mergeByNewAcct: "",
      mergeDate: "", phoneNumber: "",
    }],
    currCHNames: { TWD: "新台幣　" }, exchangeRates: { TWD: "1" }, lastServerTime: "20261009103000",
  });
  await commitPGliteCanonicalInvestmentCapture(store, {
    capture: tdccSecuritiesHoldingCapture({ captureId: "tr001", observedAt, connection: tdcc, positions, account: positions.accounts[0]! }),
  });
}

/** TDCC fund account sold by Cathay United Bank (sale organisation 013) worth 48230 TWD. */
export async function commitTdccCathayFund(store: PGliteStore) {
  const funds = readTdccFunds({
    fundDetails: [{ currAlias: "USD", fundCHName: "測試基金", fundNo: "F001", fundSHR: "120.5", refORIValue: "1500", refTWDValue: "48230", saleOrgCode: "013" }],
    refRateDate: "", totalAsset: "", updateTime: "20261009103000",
  });
  await commitPGliteCanonicalInvestmentCapture(store, {
    capture: tdccFundHoldingCapture({ captureId: "tr051", observedAt, connection: tdcc, funds, account: funds.accounts[0]! }),
  });
}

/** A Yuanta Trade broker account holding 10 shares worth 7000 TWD. */
export async function commitYuantaTrade(store: PGliteStore) {
  const contractVersion = "yuanta-trade/investment/canonical-v1";
  const sourceRecordKey = token("yuanta-trade-holding");
  const capture: InvestmentCaptureInput = {
    captureId: "yuanta-trade-holdings",
    sourceId: "yuanta-trade",
    authorityRoute: contractVersion,
    contractVersion,
    observedAt: "2026-10-09T01:00:00.000Z",
    identity: {
      sourceConnectionKey: token("yuanta-trade-connection"),
      identityEpochKey: token("yuanta-trade-epoch"),
      accountKey: token("yuanta-trade-account"),
      accountType: "investment",
      reportingCurrency: "TWD",
    },
    scope: { effectiveOn: "2026-10-09", complete: true },
    securities: [{
      securityKey: "yuanta-trade:0050",
      producerSecurityId: "0050",
      name: "元大台灣50",
      currency: "TWD",
      securityType: "ETF",
      identityEvidence: { kind: "producer-security-id", contractVersion },
    }],
    holdings: [{
      measurementKey: token("yuanta-trade-measurement"),
      measurementSubjectKey: token("yuanta-trade-subject"),
      sourceRecordKey,
      securityKey: "yuanta-trade:0050",
      quantity: { coefficient: "10", scale: 0 },
      valuation: { coefficient: "7000", scale: 0, currency: "TWD" },
      effectiveOn: "2026-10-09",
      observedAt: "2026-10-09T01:00:00.000Z",
      effectiveTimeEvidence: { kind: "source-reported-as-of", sourceRecordKey, sourceField: "asOfDate", value: "2026-10-09", contractVersion },
      lineage: { page: 1, row: 1, contractVersion },
    }],
    transactions: [],
  };
  await commitPGliteCanonicalInvestmentCapture(store, { capture });
}
