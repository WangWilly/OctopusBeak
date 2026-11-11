import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import { createTestPGlite } from "../ledger/pglite/baseline-test-template.ts";
import { commitPGliteCanonicalDepositCapture } from "../ledger/pglite/deposit.ts";
import { PGliteStore } from "../ledger/pglite/transaction.ts";
import { productCollectionHandle } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import {
  LINEBANK_LOGIN_TIMEOUT_MS,
  LineBankApiClient,
  linebankApiRowsToStatementRows,
  linebankEnsureTransactionPage,
  linebankIsSignedIn,
  linebankHumanAttestedCapture,
  linebankTransactionPageFromResponse,
  linebankValidateSourceOccurrenceFields,
  linebankValidateTransactionTime,
  linebankValidateTransactionPageSequence,
  linebankAccountKey,
  linebankAutoDismissApprovedAlert,
  buildLinebankForeignCurrencyCaptureInput,
} from "./linebank-statements.ts";
import { linebankAccountCurrency } from "./linebank-current-deposit-balances.ts";
import { frameScope } from "./frame-scope.ts";
import { LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE } from "../ledger/canonical/linebank-domestic-deposit.fixture.ts";
import {
  linebankEpochMillisecondsFromSourceDateTime,
  normalizeLineBankFinancialCapture,
} from "../ledger/canonical/linebank-domestic-deposit.ts";

const readScope = (page: never) => frameScope(page, new AbortController().signal);

const accountSnapshotEndpoint =
  "https://accessibility.linebank.com.tw/v1/account/common/payables?featureTypeCode=01";
const accountSnapshotBody = JSON.stringify({
  code: "200",
  message: "success",
  content: {
    dpstAcctList: [
      {
        acctNbr: "012345678901",
        arrId: "arr-main",
        acctNick: "main",
        pdNm: "LINE Bank account",
        currCd: "TWD",
        wdrwAvblAmt: "100.00",
      },
    ],
  },
});
const accountSnapshotHeaders = {
  date: "Thu, 01 Jan 1970 10:00:01 GMT",
  "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
  "content-type": "application/json;charset=UTF-8",
};

const accountSnapshotPage = {
  async evaluate(
    _expression: unknown,
    argument: { path: string; body?: unknown },
  ) {
    assert.equal(argument.path, "/v1/account/common/payables?featureTypeCode=01");
    return {
      bodyBytes: Array.from(new TextEncoder().encode(accountSnapshotBody)),
      url: accountSnapshotEndpoint,
      status: 200,
      method: "GET",
      headers: accountSnapshotHeaders,
    };
  },
};

const readClient = (page: unknown) => new LineBankApiClient(readScope(page as never), productCollectionHandle({
  now: () => "2026-09-25T20:00:00+08:00",
  text: strictSourceText,
  signal: new AbortController().signal,
  event: async () => undefined,
  stage: () => undefined,
  reportActivity: async () => undefined,
  collectionPeriod: () => { throw new Error("This check supplies no collection period."); },
}));

const accountSnapshot = await readClient(accountSnapshotPage).fetchAccountSnapshot();
assert.deepEqual(
  accountSnapshot.currentBalance.evidence.bytes,
  new TextEncoder().encode(accountSnapshotBody),
  "the snapshot module receives the account-list bytes the statements read",
);

const linebankWorkflowSource = await readFile(
  new URL("./linebank-statements.ts", import.meta.url),
  "utf8",
);
assert.match(linebankWorkflowSource, /fetchAccountSnapshot\(/u);
assert.match(linebankWorkflowSource, /linebankCurrentBalanceSnapshot\(accounts, domesticCaptures\)/u);
assert.match(linebankWorkflowSource, /stageCanonicalDeposits\(/u);
assert.match(linebankWorkflowSource, /export const lineBankWorkflow/u);
assert.match(linebankWorkflowSource, /observedAt:\s*accountSnapshotAt/u);
assert.doesNotMatch(
  linebankWorkflowSource,
  /from\s+["']libretto["']|export\s+default\s+workflow\s*\(|librettoAuthenticate|LibrettoWorkflowContext/u,
);
assert.doesNotMatch(
  linebankWorkflowSource,
  /node:fs\/promises|writeFile|outputDir|downloadSchema|outputSchema|writeStatementFiles|linebankStatementRowsToCsv|downloadLineBankStatements/u,
);
assert.doesNotMatch(
  linebankWorkflowSource,
  /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun|pglite-child-rpc-client/u,
);

await assert.rejects(
  () =>
    readClient({
      async evaluate() {
        return {
          bodyBytes: [0xff],
          url: accountSnapshotEndpoint,
          status: 200,
          method: "GET",
          headers: accountSnapshotHeaders,
        };
      },
    }).fetchAccountSnapshot(),
  /Source text integrity failed: invalid-encoding/u,
);

await assert.rejects(
  () =>
    readClient({
      async evaluate() {
        return {
          bodyBytes: Array.from(new TextEncoder().encode(accountSnapshotBody)),
          url: accountSnapshotEndpoint,
          status: 500,
          method: "GET",
          headers: accountSnapshotHeaders,
        };
      },
    }).fetchAccountSnapshot(),
  (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "response-status",
  "an account list that is not a 200 reply is refused",
);

await assert.rejects(
  () =>
    readClient({
      async evaluate(_expression: unknown, argument: { path: string }) {
        assert.equal(argument.path, "/v1/account/history/transactions");
        return {
          bodyBytes: Array.from(new TextEncoder().encode(JSON.stringify({ code: "200", content: {} }))),
          url: "https://accessibility.linebank.com.tw/v1/account/history/other",
          status: 200,
          method: "POST",
          headers: accountSnapshotHeaders,
        };
      },
    }).fetchTransactionPages(
      { acctNbr: "012345678901", arrId: "arr-main" },
      { startDate: "20260701", endDate: "20260731" },
    ),
  (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "response-endpoint",
  "a transaction reply from an undeclared endpoint is refused",
);

assert.equal(linebankAccountCurrency({ acctNbr: "1" }), "TWD");
assert.equal(linebankAccountCurrency({ acctNbr: "1", currCd: "usd" }), "USD");
assert.equal(linebankAccountKey({ acctNbr: "12", arrId: "3" }), "12:3");
assert.equal(linebankAccountKey({ acctNbr: "12" }), "");

assert.equal(LINEBANK_LOGIN_TIMEOUT_MS, 120_000);

const canonicalTemplate =
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.rows[0]!;
const canonicalCapture = await linebankHumanAttestedCapture({
  account: {
    ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.account,
    currCd: "TWD",
  },
  dateRange: { startDate: "20260701", endDate: "20260731" },
  captureId: "synthetic-linebank-workflow-capture",
  observedAt: "2026-08-24T13:00:00.000Z",
  pages: [
    {
      pageNbr: 1,
      pageCnt: 1000,
      totTxCnt: 2,
      txCnt: 2,
      responseCode: "200",
      source: {
        ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.source,
        opnDtm: 1700000000000,
        jntAcctMbrTpCd: "personal-main-account",
        jntMbrListCnt: 0,
        totJntAcctMbrCnt: 0,
        isSecuAcctBndg: false,
      },
      rows: [
        {
          ...canonicalTemplate,
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
          ...canonicalTemplate,
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
      ],
    },
  ],
});
assert.equal(canonicalCapture?.canonicalAdmission, "admitted");
assert.equal(canonicalCapture?.records.length, 2);
const observedEmptyRoleCapture = await linebankHumanAttestedCapture({
  account: {
    ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.account,
    currCd: "TWD",
  },
  dateRange: { startDate: "20260701", endDate: "20260731" },
  captureId: "synthetic-linebank-observed-empty-role",
  observedAt: "2026-08-24T13:00:00.000Z",
  pages: canonicalCapture
    ? [
        {
          ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!,
          pageNbr: 1,
          pageCnt: 1000,
          responseCode: "200",
          source: {
            ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.source,
            opnDtm: 1700000000000,
            jntAcctMbrTpCd: "",
            jntMbrListCnt: 0,
            totJntAcctMbrCnt: 0,
            isSecuAcctBndg: false,
          },
          rows: canonicalCapture.records.map((record, index) => ({
            ...canonicalTemplate,
            txSeqNbr: String(index + 1),
            crrnDpstNthCnt: index + 1,
            txDt: record.sourceTime.localDate,
            txTm: record.sourceTime.localTime,
            txDtm: record.sourceTime.epochMilliseconds,
            dpstWdrwDsCd: record.sourceDirectionCode,
            txAmt: record.amount.coefficient,
            afTxBal: record.balanceAfter!.coefficient,
            cncdTxYn: "N",
            cnclTxYn: "N",
          })),
          txCnt: canonicalCapture.records.length,
          totTxCnt: canonicalCapture.records.length,
        },
      ]
    : [],
});
assert.equal(observedEmptyRoleCapture?.canonicalAdmission, "admitted");
assert.equal(
  await linebankHumanAttestedCapture({
    account: LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.account,
    dateRange: { startDate: "20260701", endDate: "20260731" },
    captureId: "synthetic-linebank-shared-skip",
    observedAt: "2026-08-24T13:00:00.000Z",
    pages: [
      {
        ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!,
        source: {
          ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.source,
          jntAcctMbrTpCd: "shared-member",
        },
      },
    ],
  }),
  null,
);

const rootLinkNodes = [false, true];
const rootLinkLocator = {
  async count() {
    return rootLinkNodes.length;
  },
  nth(index: number) {
    return {
      async isVisible() {
        return rootLinkNodes[index] === true;
      },
    };
  },
};
const rootPage = {
  url: () => "https://accessibility.linebank.com.tw/",
  getByRole: () => rootLinkLocator,
} as never;
assert.equal(await linebankIsSignedIn(readScope(rootPage)), true);

const loginPageWithNavigationLink = {
  url: () => "https://accessibility.linebank.com.tw/login",
  getByRole: () => rootLinkLocator,
} as never;
assert.equal(await linebankIsSignedIn(readScope(loginPageWithNavigationLink)), false);

const transactionDropdown = {
  async count() {
    return 1;
  },
  nth() {
    return {
      async isVisible() {
        return true;
      },
    };
  },
};
const transactionPage = {
  url: () => "https://accessibility.linebank.com.tw/transaction",
  locator: (selector: string) => {
    assert.equal(selector, "#account-dropdown");
    return transactionDropdown;
  },
} as never;
assert.equal(await linebankIsSignedIn(readScope(transactionPage)), true);

const alreadyTransactionPage = {
  url: () => "https://accessibility.linebank.com.tw/transaction",
  locator: (selector: string) => {
    assert.equal(selector, "#account-dropdown");
    return transactionDropdown;
  },
} as never;
const noAlertLocator = {
  async count() {
    return 0;
  },
};
const noAlertPage = {
  getByRole: () => noAlertLocator,
} as never;
await linebankAutoDismissApprovedAlert(readScope(noAlertPage));

let dialogVisible = true;
let approvedButtonClicks = 0;
const approvedButton = {
  async count() {
    return 1;
  },
  nth() {
    return {
      async isVisible() {
        return true;
      },
      async click() {
        approvedButtonClicks += 1;
        dialogVisible = false;
      },
    };
  },
};
let dialogButtonLocator = approvedButton;
const dialogLocator = {
  async count() {
    return 2;
  },
  nth(index: number) {
    return {
      async isVisible() {
        return index === 1 && dialogVisible;
      },
      async waitFor(options: { state?: string; timeout?: number }) {
        assert.equal(options.state, "hidden");
        assert.equal(options.timeout, LINEBANK_LOGIN_TIMEOUT_MS);
        assert.equal(dialogVisible, false);
      },
      getByRole: () => dialogButtonLocator,
    };
  },
  getByRole: () => dialogButtonLocator,
};
let approvedNavigationUrl = "https://accessibility.linebank.com.tw/";
const approvedNavigationLink = {
  async count() {
    return 1;
  },
  nth() {
    return {
      async isVisible() {
        return true;
      },
      async click() {
        approvedNavigationUrl =
          "https://accessibility.linebank.com.tw/transaction";
      },
    };
  },
};
const approvedDropdown = {
  async waitFor() {
    return undefined;
  },
};
const approvedAlertPage = {
  url: () => approvedNavigationUrl,
  getByRole: (role: string) => {
    if (role === "alertdialog") return dialogLocator;
    if (role === "button") return approvedButton;
    return approvedNavigationLink;
  },
  locator: () => approvedDropdown,
  async waitForURL(predicate: (url: URL) => boolean) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(predicate(new URL(approvedNavigationUrl)), true);
  },
} as never;
await linebankAutoDismissApprovedAlert(readScope(approvedAlertPage));
await linebankEnsureTransactionPage(readScope(approvedAlertPage));
assert.equal(approvedButtonClicks, 1);
assert.equal(approvedNavigationUrl.endsWith("/transaction"), true);

dialogVisible = false;
await linebankAutoDismissApprovedAlert(readScope(approvedAlertPage));
assert.equal(approvedButtonClicks, 1);

const unknownButtonPage = {
  getByRole: (role: string) =>
    role === "alertdialog" ? dialogLocator : approvedNavigationLink,
} as never;
dialogVisible = true;
dialogButtonLocator = {
  async count() {
    return 0;
  },
  nth() {
    return {
      async isVisible() {
        return false;
      },
      async click() {},
    };
  },
};
await assert.rejects(
  () => linebankAutoDismissApprovedAlert(readScope(unknownButtonPage)),
  /exactly one approved dismissal button/,
);
assert.equal(approvedButtonClicks, 1);

const multipleButtonPage = {
  getByRole: (role: string) =>
    role === "alertdialog" ? dialogLocator : approvedNavigationLink,
} as never;
dialogButtonLocator = {
  async count() {
    return 2;
  },
  nth() {
    return {
      async isVisible() {
        return true;
      },
      async click() {},
    };
  },
};
await assert.rejects(
  () => linebankAutoDismissApprovedAlert(readScope(multipleButtonPage)),
  /exactly one approved dismissal button/,
);
assert.equal(approvedButtonClicks, 1);

const multipleDialogPage = {
  getByRole: (role: string) =>
    role === "alertdialog"
      ? {
          async count() {
            return 2;
          },
          nth() {
            return {
              async isVisible() {
                return true;
              },
            };
          },
        }
      : approvedNavigationLink,
} as never;
dialogButtonLocator = approvedButton;
await assert.rejects(
  () => linebankAutoDismissApprovedAlert(readScope(multipleDialogPage)),
  /exactly one visible alert dialog/,
);

const persistentDialog = {
  ...dialogLocator,
  async count() {
    return 1;
  },
  nth() {
    return {
      async isVisible() {
        return true;
      },
      async waitFor() {
        throw new Error("Timeout 120000ms exceeded");
      },
      getByRole: () => dialogButtonLocator,
    };
  },
};
let persistentNavigationClicks = 0;
const persistentNavigationLink = {
  async count() {
    return 1;
  },
  nth() {
    return {
      async isVisible() {
        return true;
      },
      async click() {
        persistentNavigationClicks += 1;
      },
    };
  },
};
const persistentAlertPage = {
  getByRole: (role: string) =>
    role === "alertdialog" ? persistentDialog : persistentNavigationLink,
} as never;
await assert.rejects(async () => {
  await linebankAutoDismissApprovedAlert(readScope(persistentAlertPage));
  await linebankEnsureTransactionPage(readScope(persistentAlertPage));
}, /Timeout 120000ms exceeded/);
assert.equal(approvedButtonClicks, 2);
assert.equal(persistentNavigationClicks, 0);

const navigationEvents: string[] = [];
let navigationUrl = "https://accessibility.linebank.com.tw/";
const transactionLink = {
  async count() {
    return 2;
  },
  nth(index: number) {
    return {
      async isVisible() {
        return index === 1;
      },
      async click() {
        assert.equal(index, 1);
        navigationEvents.push("click-transaction-link");
        navigationUrl = "https://accessibility.linebank.com.tw/transaction";
      },
    };
  },
};
const accountDropdown = {
  async waitFor(options: { timeout?: number }) {
    navigationEvents.push(`wait-dropdown:${options.timeout}`);
  },
};
const navigationPage = {
  url: () => navigationUrl,
  locator: () => accountDropdown,
  getByRole: () => transactionLink,
  async waitForURL(predicate: (url: URL) => boolean) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(predicate(new URL(navigationUrl)), true);
  },
  async goto(url: string) {
    navigationEvents.push(`goto:${url}`);
    navigationUrl = url;
  },
} as never;
await linebankEnsureTransactionPage(readScope(navigationPage));
assert.deepEqual(navigationEvents, [
  "click-transaction-link",
  "wait-dropdown:120000",
]);

navigationEvents.length = 0;
navigationUrl = "https://accessibility.linebank.com.tw/transaction";
await linebankEnsureTransactionPage(readScope(navigationPage));
assert.deepEqual(navigationEvents, ["wait-dropdown:120000"]);

navigationEvents.length = 0;
navigationUrl = "https://accessibility.linebank.com.tw/";
const noMenuLink = {
  async count() {
    return 2;
  },
  nth() {
    return {
      async isVisible() {
        return false;
      },
    };
  },
};
const fallbackPage = {
  url: () => navigationUrl,
  locator: () => accountDropdown,
  getByRole: () => noMenuLink,
  async goto(url: string) {
    navigationEvents.push(`goto:${url}`);
    navigationUrl = url;
  },
} as never;
await linebankEnsureTransactionPage(readScope(fallbackPage));
assert.deepEqual(navigationEvents, [
  "goto:https://accessibility.linebank.com.tw/transaction",
  "wait-dropdown:120000",
]);

const sourceResponse = linebankTransactionPageFromResponse({
  code: "200",
  message: "success",
  content: {
    acctNbr: "synthetic-account",
    arrId: "synthetic-arrangement",
    acctNick: "synthetic-account-label",
    acctBal: 100,
    wdrwAvblAmt: 90,
    pdCd: "synthetic-product-code",
    pdNm: "synthetic-product-name",
    simpAcctTpCd: null,
    jntAcctMbrTpCd: "synthetic-role",
    txBlcknYn: "N",
    pageNbr: 1,
    pageCnt: 30,
    totTxCnt: 1,
    txCnt: 1,
    txLst: [
      {
        txSeqNbr: 1,
        txDt: "20260705",
        txTm: "143738",
        txDtm: 1783233458000,
        dpstWdrwDsCd: "1",
        bizTxFuncTpCd: "synthetic-function-code",
        bizTxFuncTpNm: "synthetic-function-name",
        crrnDpstNthCnt: 1,
        ctptCustLineUid: "synthetic-line-uid",
        fxsTxId: null,
        rltvTxArrId: null,
        txCaseCd: "synthetic-case",
        txAmt: 10,
        afTxBal: 100,
        cncdTxYn: "N",
        cnclTxYn: "N",
        txMemoVal: null,
      },
    ],
  },
});
assert.equal(sourceResponse.responseCode, "200");
assert.equal(sourceResponse.responseMessage, "success");
assert.equal(sourceResponse.source?.acctNbr, "synthetic-account");
assert.equal(sourceResponse.source?.pdCd, "synthetic-product-code");
assert.equal(sourceResponse.source?.jntAcctMbrTpCd, "synthetic-role");
assert.equal(sourceResponse.rows[0]?.bizTxFuncTpCd, "synthetic-function-code");
assert.equal(sourceResponse.rows[0]?.crrnDpstNthCnt, 1);
assert.equal(sourceResponse.rows[0]?.ctptCustLineUid, "synthetic-line-uid");
assert.equal(sourceResponse.rows[0]?.fxsTxId, null);
assert.equal(sourceResponse.rows[0]?.rltvTxArrId, null);
assert.equal(sourceResponse.rows[0]?.txCaseCd, "synthetic-case");
assert.equal(typeof sourceResponse.rows[0]?.txDtm, "number");
assert.equal(
  linebankEpochMillisecondsFromSourceDateTime("20260705", "143738"),
  1783233458000,
);
assert.equal(
  linebankEpochMillisecondsFromSourceDateTime("20260329", "000000"),
  Date.UTC(2026, 2, 28, 16, 0, 0),
);
linebankValidateTransactionTime(sourceResponse.rows[0]!);
linebankValidateSourceOccurrenceFields(sourceResponse.rows[0]!);
assert.throws(
  () =>
    linebankValidateSourceOccurrenceFields({
      ...sourceResponse.rows[0]!,
      crrnDpstNthCnt: undefined,
    }),
  /crrnDpstNthCnt must be a positive integer/,
);
assert.throws(
  () =>
    linebankTransactionPageFromResponse({
      code: "200",
      content: {
        pageNbr: 1,
        pageCnt: 30,
        totTxCnt: 1,
        txCnt: 1,
        txLst: [{ ...sourceResponse.rows[0]!, txSeqNbr: "0" }],
      },
    }),
  /txSeqNbr must be a positive integer/,
);
assert.throws(
  () =>
    linebankTransactionPageFromResponse({
      code: "200",
      content: {
        pageNbr: 1,
        pageCnt: 30,
        totTxCnt: 1,
        txCnt: 1,
        txLst: [{ ...sourceResponse.rows[0]!, crrnDpstNthCnt: 0 }],
      },
    }),
  /crrnDpstNthCnt must be a positive integer/,
);
for (const [txDt, txTm] of [
  ["20260230", "143738"],
  ["20260705", "246000"],
] as const) {
  assert.throws(
    () => linebankEpochMillisecondsFromSourceDateTime(txDt, txTm),
    /source date\/time is invalid/,
  );
}
assert.throws(
  () =>
    linebankValidateTransactionTime({
      txDt: "20260705",
      txTm: "143738",
      txDtm: Math.floor(1783233458000 / 1000),
    }),
  /does not match txDt\+txTm/,
);
assert.throws(
  () =>
    linebankValidateTransactionTime({
      txDt: "20260705",
      txTm: "143738",
      txDtm: Date.UTC(2026, 6, 5, 14, 37, 38),
    }),
  /does not match txDt\+txTm/,
);
assert.throws(
  () =>
    linebankValidateTransactionTime({
      txDt: "20260705",
      txTm: "143738",
      txDtm: 1783233458001,
    }),
  /does not match txDt\+txTm/,
);
assert.throws(
  () => linebankValidateTransactionTime({ txDt: "20260705", txTm: "143738" }),
  /source time is incomplete/,
);
assert.throws(
  () =>
    linebankTransactionPageFromResponse({
      code: "200",
      content: {
        pageNbr: 1,
        pageCnt: 30,
        totTxCnt: 2,
        txCnt: 2,
        txLst: [
          sourceResponse.rows[0]!,
          { ...sourceResponse.rows[0]!, txSeqNbr: 2, txDtm: 1783233458001 },
        ],
      },
    }),
  /does not match txDt\+txTm/,
);
linebankValidateTransactionPageSequence([sourceResponse], {
  requireComplete: true,
  expectedAccount: {
    acctNbr: "synthetic-account",
    arrId: "synthetic-arrangement",
  },
});
assert.throws(
  () =>
    linebankValidateTransactionPageSequence([sourceResponse], {
      expectedAccount: {
        acctNbr: "requested-account",
        arrId: "requested-arrangement",
      },
    }),
  /does not match requested account/,
);
assert.throws(
  () =>
    linebankValidateTransactionPageSequence(
      [
        {
          ...sourceResponse,
          source: undefined,
        },
      ],
      {
        expectedAccount: {
          acctNbr: "synthetic-account",
          arrId: "synthetic-arrangement",
        },
      },
    ),
  /metadata is missing for requested account/,
);
assert.throws(
  () =>
    linebankTransactionPageFromResponse({
      code: "200",
      content: {
        pageNbr: 1,
        pageCnt: 30,
        totTxCnt: 1,
        txCnt: 1,
        txLst: [
          {
            txSeqNbr: 1,
            crrnDpstNthCnt: 1,
            txDt: "20260705",
            txTm: "143738",
            txDtm: "1700000000000" as unknown as number,
          },
        ],
      },
    }),
  /safe epoch-millisecond integer/,
);
assert.throws(
  () =>
    linebankValidateTransactionPageSequence([
      sourceResponse,
      {
        ...sourceResponse,
        pageNbr: 2,
        source: { acctNbr: "other-account", arrId: "other-arrangement" },
      },
    ]),
  /source account identity drift/,
);
assert.throws(
  () =>
    linebankValidateTransactionPageSequence([
      { ...sourceResponse, source: { acctNbr: "only-account" } },
    ]),
  /source account identity metadata is incomplete/,
);

const rows = linebankApiRowsToStatementRows([
  {
    txDt: "20260705",
    txTm: "143738",
    dpstWdrwDsCd: "1",
    bizTxFuncTpNm: "轉帳",
    txAmt: 1000,
    afTxBal: 1005,
    txRmkCont: "匯入",
    txMemoVal: "備註",
  },
]);

assert.deepEqual(
  rows.map((row) => row.values),
  [
    [
      "2026/07/05",
      "2026/07/05",
      "14:37:38",
      "轉帳",
      "",
      "1000",
      "1005",
      "匯入 備註",
      "",
    ],
  ],
);


const withdrawalRows = linebankApiRowsToStatementRows([
  {
    txDt: "20260705",
    txTm: "143739",
    dpstWdrwDsCd: "2",
    bizTxFuncTpNm: "轉帳",
    txAmt: "250",
    afTxBal: "755",
  },
]);
assert.deepEqual(withdrawalRows[0]?.values.slice(4, 7), ["250", "", "755"]);

assert.throws(
  () =>
    linebankApiRowsToStatementRows([
      {
        txDt: "20260705",
        txTm: "143738",
        dpstWdrwDsCd: "1",
        txAmt: 12.5,
      },
    ]),
  /Invalid LINE Bank transaction amount/,
);

const linebankForeignPage = {
  pageNbr: 1,
  pageCnt: 1,
  totTxCnt: 1,
  txCnt: 1,
  source: { acctNbr: "LINE-FOREIGN-133", arrId: "arr-133", opnDtm: 1700000000000 },
  rows: [
    {
      txSeqNbr: "1",
      crrnDpstNthCnt: 1,
      txDt: "20260823",
      txTm: "091000",
      txDtm: linebankEpochMillisecondsFromSourceDateTime("20260823", "091000"),
      dpstWdrwDsCd: "1",
      txAmt: "10.00",
      afTxBal: "110.00",
    },
  ],
};
const linebankForeignCapture = buildLinebankForeignCurrencyCaptureInput({
  account: { acctNbr: "LINE-FOREIGN-133", arrId: "arr-133", currCd: "USD" },
  dateRange: { startDate: "20260801", endDate: "20260823" },
  pages: [linebankForeignPage],
  observedAt: "2026-08-24T12:00:00+08:00",
  captureOccurrenceId: "linebank-foreign-check-observation-2",
});
assert.equal(linebankForeignCapture.accountType, "depository");
assert.equal(linebankForeignCapture.records[0]!.currencyEvidence.currency, "USD");
assert.throws(
  () =>
    buildLinebankForeignCurrencyCaptureInput({
      account: { acctNbr: "LINE-FOREIGN-133", arrId: "arr-133", currCd: "USD" },
      dateRange: { startDate: "20260801", endDate: "20260823" },
      pages: [
        {
          ...linebankForeignPage,
          rows: [{ ...linebankForeignPage.rows[0]!, txAmt: 10 }],
        },
      ],
    }),
  /exact decimal string/i,
);
assert.throws(
  () =>
    linebankTransactionPageFromResponse({
      code: "200",
      content: {
        acctBal: 12.5,
        wdrwAvblAmt: 100,
        pageNbr: 1,
        pageCnt: 30,
        totTxCnt: 1,
        txCnt: 1,
        txLst: [
          {
            txSeqNbr: 1,
            crrnDpstNthCnt: 1,
            txDt: "20260705",
            txTm: "143738",
            txDtm: 1783233458000,
            dpstWdrwDsCd: "1",
            txAmt: 100,
            afTxBal: 100,
          },
        ],
      },
    }),
  /Invalid LINE Bank transaction amount/,
);

for (const direction of ["9", undefined]) {
  assert.throws(
    () =>
      linebankApiRowsToStatementRows([
        {
          txDt: "20260705",
          txTm: "143738",
          dpstWdrwDsCd: direction,
          txAmt: 250,
        },
      ]),
    /Unsupported LINE Bank transaction direction/,
  );
}
assert.throws(
  () =>
    linebankApiRowsToStatementRows([
      {
        txDt: "20260705",
        txTm: "143738",
        dpstWdrwDsCd: "1",
        txAmt: -250,
      },
    ]),
  /conflicts with deposit direction/,
);
assert.throws(
  () =>
    linebankApiRowsToStatementRows([
      {
        txDt: "20260705",
        txTm: "143738",
        dpstWdrwDsCd: "2",
        txAmt: -250,
      },
    ]),
  /conflicts with withdrawal direction/,
);
assert.throws(
  () =>
    linebankApiRowsToStatementRows([
      {
        txDt: "20260705",
        txTm: "143738",
        dpstWdrwDsCd: "1",
        txAmt: 100,
      },
      {
        txDt: "20260705",
        txTm: "143739",
        dpstWdrwDsCd: "2",
        txAmt: -50,
      },
    ]),
  /conflicts with withdrawal direction/,
);
assert.throws(
  () =>
    linebankTransactionPageFromResponse({
      code: "200",
      content: {
        pageNbr: 1,
        pageCnt: 30,
        totTxCnt: 1,
        txCnt: 1,
        txLst: [
          {
            txSeqNbr: 1,
            crrnDpstNthCnt: 1,
            txDt: "20260705",
            txTm: "143738",
            txDtm: 1783233458000,
            dpstWdrwDsCd: "1",
            txAmt: 12.5,
            afTxBal: 100,
          },
        ],
      },
    }),
  /Invalid LINE Bank transaction amount/,
);
assert.throws(
  () =>
    linebankTransactionPageFromResponse({
      code: "200",
      content: {
        pageNbr: 1,
        pageCnt: 30,
        totTxCnt: 1,
        txCnt: 1,
        txLst: [
          {
            txSeqNbr: 1,
            crrnDpstNthCnt: 1,
            txDt: "20260705",
            txTm: "143738",
            txDtm: 1783233458000,
            dpstWdrwDsCd: "1",
            txAmt: 100,
            afTxBal: 12.5,
          },
        ],
      },
    }),
  /Invalid LINE Bank transaction amount/,
);

assert.throws(
  () =>
    linebankApiRowsToStatementRows([
      {
        txDt: "20260705",
        txTm: "143738",
        dpstWdrwDsCd: "1",
        txAmt: "1,000",
      },
    ]),
  /Invalid LINE Bank transaction amount/,
);
assert.throws(
  () =>
    linebankApiRowsToStatementRows([
      {
        txDt: "20260705",
        txTm: "143738",
        dpstWdrwDsCd: "1",
        txAmt: "not-a-decimal",
      },
    ]),
  /Invalid LINE Bank transaction amount/,
);
assert.throws(
  () =>
    linebankApiRowsToStatementRows([
      {
        txDt: "20260705",
        txTm: "143738",
        dpstWdrwDsCd: "1",
        txAmt: Number.MAX_SAFE_INTEGER + 1,
      },
    ]),
  /Invalid LINE Bank transaction amount/,
);

const repeatedSourceRows = linebankApiRowsToStatementRows([
  {
    txDt: "20260705",
    txTm: "143738",
    dpstWdrwDsCd: "1",
    txAmt: "1000",
    bizTxFuncTpNm: "同一顯示列",
  },
  {
    txDt: "20260705",
    txTm: "143738",
    dpstWdrwDsCd: "1",
    txAmt: "1000",
    bizTxFuncTpNm: "同一顯示列",
  },
]);
assert.equal(repeatedSourceRows.length, 2);

const pageOne = {
  pageNbr: 1,
  pageCnt: 1000,
  totTxCnt: 2,
  txCnt: 1,
  rows: [{ txSeqNbr: "1" }],
};
const pageTwo = {
  pageNbr: 2,
  pageCnt: 1000,
  totTxCnt: 2,
  txCnt: 1,
  rows: [{ txSeqNbr: "2" }],
};
linebankValidateTransactionPageSequence([pageOne, pageTwo], {
  requireComplete: true,
});
assert.throws(
  () =>
    linebankValidateTransactionPageSequence([
      pageOne,
      { ...pageTwo, totTxCnt: 3 },
    ]),
  /totTxCnt drift/,
);
assert.throws(
  () =>
    linebankValidateTransactionPageSequence([
      pageOne,
      { ...pageTwo, pageCnt: 500 },
    ]),
  /pageCnt drift/,
);
assert.throws(
  () =>
    linebankValidateTransactionPageSequence([{ ...pageOne, totTxCnt: 3 }], {
      requireComplete: true,
    }),
  /total row count mismatch/,
);

const pglite = await createTestPGlite("ledger");
const pgliteStore = new PGliteStore(pglite);
try {
  const normalizedDomestic = normalizeLineBankFinancialCapture(canonicalCapture!);
  const domestic = await commitPGliteCanonicalDepositCapture(
    pgliteStore,
    { capture: normalizedDomestic },
  );
  assert.equal(domestic.transactions.length, normalizedDomestic.records.length);
  const foreign = await commitPGliteCanonicalDepositCapture(
    pgliteStore,
    { capture: admitForeignCurrencyDepositCapture(linebankForeignCapture) },
  );
  assert.equal(foreign.transactions.length, 1);
} finally {
  await pglite.close();
}
