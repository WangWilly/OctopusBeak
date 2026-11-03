import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { withBoundProducts } from "../lib/automation/product-collection.fixtures.ts";
import { CATHAY_SOURCE } from "../lib/automation/server/sources/cathay.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  validateCathayDomesticDepositSyncInputForPGlite,
} from "../ledger/pglite/cathay-domestic-admission.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "../ledger/pglite/cathay-domestic-adapter.ts";
import { CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "../ledger/canonical/foreign-currency-deposit.fixtures.ts";
import type { ForeignCurrencyDepositCaptureInput } from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import { runVerifiedEntry } from "../lib/automation/server/verified-entry.ts";
import { cathayAllWorkflow } from "./cathay-all-statements.ts";
import {
  cathayDomesticOverviewBody,
  cathayForeignOverviewBody,
  cathayOverviewPage,
} from "./cathay-current-deposit-balances.fixtures.ts";
import { assertDepositCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";

const domesticA = ["9990", "0000", "0001"].join("");
const domesticB = ["9990", "0000", "0002"].join("");
const domesticUnadmitted = ["9990", "0000", "0003"].join("");
const foreignA = ["9991", "0000", "0001"].join("");
const foreignB = ["9991", "0000", "0002"].join("");
const foreignUnadmitted = ["9991", "0000", "0003"].join("");

const systemTime = "2026-09-25T20:00:00.0000000+08:00";
const httpDate = "Fri, 25 Sep 2026 12:00:30 GMT";

const input = {
  credentials: {
    cathay_user_id: "synthetic-user",
    cathay_account: "synthetic-account",
    cathay_password: "synthetic-password",
  },
  statementTypes: ["domestic", "foreign_currency"],
};

/** Cathay's signed-in home, so the run's sign-in keeps the existing session. */
const signedInHome = {
  url: () => "https://www.cathaybk.com.tw/OnlineBanking/Home",
  getByText: () => ({ first: () => ({ isVisible: async () => true }) }),
};

function domesticRequests() {
  const page = (number: string) => ({
    accountNo: number,
    currency: "TWD" as const,
    scope: { startDate: "2025-08-17", endDate: "2026-08-17" },
    pageOrdinal: 0,
    requestPageToken: null,
    nextPageToken: null,
    rawResponse: CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace("SYNTHETIC-ACCOUNT-001", number),
    contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
    preflightFingerprint: "cathay/domestic-deposit/collection-v1",
    absenceAuthority: "comparable-complete-range" as const,
  });
  return buildCathayDomesticFinancialRequestsForPGlite(validateCathayDomesticDepositSyncInputForPGlite({
    sourceConnectionId: "synthetic-cathay-connection",
    identityEpoch: "cathay-domestic-deposit-v1",
    authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
    stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
    syncState: { cursor: null },
    observedAt: "2026-08-17T12:00:00+08:00",
    pages: [page(domesticA), page(domesticB)],
  }));
}

function foreignCapture(number: string, currency: string): ForeignCurrencyDepositCaptureInput {
  const fixture = CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1;
  return {
    ...fixture,
    accountNo: number,
    captureCurrencyScope: { kind: "currency", currency },
    records: fixture.records.map((record) => ({
      ...record,
      currencyEvidence: { kind: "row", currency },
      originalAmount: { amount: record.amount, currency },
    })),
  };
}

test("Cathay domestic and foreign accounts commit statements beside their current balances", async () => {
  const recorder = recordDepositCommit();
  const page = cathayOverviewPage(signedInHome, {
    domestic: {
      body: cathayDomesticOverviewBody(systemTime, [
        { ui: domesticA, ledger: "12500.00", available: "12000.50" },
        { ui: domesticUnadmitted, ledger: "1.00", available: "1.00" },
        { ui: domesticB, ledger: "300", available: "0" },
      ]),
      date: httpDate,
      uiAccounts: [domesticA, domesticUnadmitted, domesticB],
    },
    foreign: {
      body: cathayForeignOverviewBody(systemTime, [
        { number: foreignA, details: [{ currency: "USD", balance: "100.25" }, { currency: "JPY", balance: "5000" }] },
        { number: foreignUnadmitted, details: [{ currency: "USD", balance: "1" }] },
        { number: foreignB, details: [{ currency: "EUR", balance: "0.10" }] },
      ]),
      date: httpDate,
    },
  });
  const captures = [foreignCapture(foreignA, "USD"), foreignCapture(foreignA, "JPY"), foreignCapture(foreignB, "EUR")];
  const requests = domesticRequests();
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "run-cathay-golden",
    signal: new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: { withPage: async (body) => body(page) },
    text: strictSourceText,
    verification: {
      async complete() {
        throw new Error("A signed-in synthetic session needs no assistance.");
      },
    },
    financialCommit: recorder.financialCommit,
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
  const workflow = cathayAllWorkflow({
    createSession: async () => ({ jwtToken: "synthetic-token", customerId: "synthetic", idType: "synthetic" }),
    collectDomestic: async () => ({ requests, captureCount: requests.length, rowCount: 6 }),
    collectForeign: async () => ({
      captures,
      selectedStatementCount: captures.length,
      rowCount: captures.length,
      accountKeys: [foreignA, foreignB],
    }),
  });
  const output = await runVerifiedEntry(CATHAY_SOURCE, workflow, withBoundProducts(context, CATHAY_SOURCE, input), input);
  assert.equal(output.status, "financial-admitted");
  assert.deepEqual(
    output.products!.map((product) => [product.typeId, product.status]),
    [["domestic", "success"], ["foreign_currency", "success"]],
  );
  await assertDepositCommitGolden("cathay-domestic-and-foreign-current-balances", recorder.recorded());
});
