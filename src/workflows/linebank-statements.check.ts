import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINEBANK_LOGIN_TIMEOUT_MS,
  linebankAccountCurrency,
  linebankAccountKey,
  linebankApiRowsToStatementRows,
  linebankEnsureTransactionPage,
  linebankEpochMillisecondsFromSourceDateTime,
  linebankIsSignedIn,
  linebankHumanAttestedCapture,
  linebankQueryWindows,
  linebankSortStatementRows,
  linebankSignIn,
  linebankStatementRowsToCsv,
  linebankTransactionPageFromResponse,
  linebankValidateSourceOccurrenceFields,
  linebankValidateTransactionTime,
  linebankValidateTransactionPageSequence,
  linebankAutoDismissApprovedAlert,
  buildLinebankForeignCurrencyCaptureInput,
} from "./linebank-statements.ts";
import { LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE } from "../ledger/canonical/linebank-domestic-deposit.ts";

assert.deepEqual(
  linebankQueryWindows({ startDate: "20250706", endDate: "20260705" }),
  [{ startDate: "20250706", endDate: "20260705" }],
);

assert.deepEqual(
  linebankQueryWindows({ startDate: "20240101", endDate: "20260705" }),
  [
    { startDate: "20250706", endDate: "20260705" },
    { startDate: "20240706", endDate: "20250705" },
    { startDate: "20240101", endDate: "20240705" },
  ],
);

assert.throws(
  () => linebankQueryWindows({ startDate: "20260231", endDate: "20260301" }),
  /Invalid calendar date/,
);
assert.throws(
  () => linebankQueryWindows({ startDate: "20260706", endDate: "20260705" }),
  /startDate must be on or before endDate/,
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
const canonicalDirectory = await mkdtemp(
  join(tmpdir(), "linebank-workflow-canonical-check-"),
);
try {
  const {
    commitCanonicalLineBankFinancialCaptureBatch,
    createDomesticDepositStore,
    queryCurrent,
  } = await import("../ledger/canonical/domestic-deposit-store.ts");
  const store = createDomesticDepositStore(
    join(canonicalDirectory, "canonical.sqlite"),
  );
  try {
    const committed = await commitCanonicalLineBankFinancialCaptureBatch(
      store,
      [canonicalCapture!],
    );
    assert.equal(committed.length, 1);
    assert.equal(committed[0]?.transactionCount, 2);
    assert.equal(queryCurrent(store).transactions.length, 2);
  } finally {
    store.close();
  }
} finally {
  await rm(canonicalDirectory, { recursive: true, force: true });
}
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
assert.equal(await linebankIsSignedIn(rootPage), true);

const loginPageWithNavigationLink = {
  url: () => "https://accessibility.linebank.com.tw/login",
  getByRole: () => rootLinkLocator,
} as never;
assert.equal(await linebankIsSignedIn(loginPageWithNavigationLink), false);

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
assert.equal(await linebankIsSignedIn(transactionPage), true);

const signInEvents: string[] = [];
let signInUrl = "https://accessibility.linebank.com.tw/";
let signedIn = false;
const signInLinkLocator = {
  async count() {
    return 1;
  },
  nth() {
    return {
      async isVisible() {
        return signedIn;
      },
    };
  },
};
const noDialogLocator = {
  async count() {
    return 0;
  },
};
const credentialField = (selector: string) => ({
  async fill(value: string) {
    signInEvents.push(`fill:${selector}:${value}`);
  },
});
const signInButton = {
  async isVisible() {
    return true;
  },
  async click() {
    signInEvents.push("click:login");
    signInUrl = "https://accessibility.linebank.com.tw/";
    signedIn = true;
  },
};
const signInButtonLocator = {
  async count() {
    return 1;
  },
  first() {
    return signInButton;
  },
};
const signInPage = {
  url: () => signInUrl,
  locator: (selector: string) => credentialField(selector),
  getByRole: (role: string) => {
    if (role === "alertdialog") return noDialogLocator;
    if (role === "button") return signInButtonLocator;
    return signInLinkLocator;
  },
  async goto(url: string) {
    signInEvents.push(`goto:${url}`);
    signInUrl = url;
  },
  async waitForTimeout(timeout: number) {
    signInEvents.push(`wait:${timeout}`);
  },
} as never;
await linebankSignIn(signInPage, {
  linebank_user_id: "synthetic-national-id",
  linebank_account: "synthetic-user-id",
  linebank_password: "synthetic-password",
});
assert.deepEqual(signInEvents, [
  "goto:https://accessibility.linebank.com.tw/login",
  "fill:#nationalId:synthetic-national-id",
  "fill:#userId:synthetic-user-id",
  "fill:#pw:synthetic-password",
  "click:login",
]);

signInEvents.length = 0;
signInUrl = "https://accessibility.linebank.com.tw/";
signedIn = true;
await linebankSignIn(signInPage, {
  linebank_user_id: "synthetic-national-id",
  linebank_account: "synthetic-user-id",
  linebank_password: "synthetic-password",
});
assert.deepEqual(signInEvents, []);

const alreadyTransactionPage = {
  url: () => "https://accessibility.linebank.com.tw/transaction",
  locator: (selector: string) => {
    assert.equal(selector, "#account-dropdown");
    return transactionDropdown;
  },
} as never;
signedIn = false;
signInUrl = "https://accessibility.linebank.com.tw/login";
await assert.rejects(
  () =>
    linebankSignIn(signInPage, {
      linebank_user_id: "synthetic-national-id",
      linebank_account: "",
      linebank_password: "synthetic-password",
    }),
  /linebank_account credential is required/,
);

const noAlertLocator = {
  async count() {
    return 0;
  },
};
const noAlertPage = {
  getByRole: () => noAlertLocator,
} as never;
await linebankAutoDismissApprovedAlert(noAlertPage);

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
await linebankAutoDismissApprovedAlert(approvedAlertPage);
await linebankEnsureTransactionPage(approvedAlertPage);
assert.equal(approvedButtonClicks, 1);
assert.equal(approvedNavigationUrl.endsWith("/transaction"), true);

dialogVisible = false;
await linebankAutoDismissApprovedAlert(approvedAlertPage);
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
  () => linebankAutoDismissApprovedAlert(unknownButtonPage),
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
  () => linebankAutoDismissApprovedAlert(multipleButtonPage),
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
  () => linebankAutoDismissApprovedAlert(multipleDialogPage),
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
  await linebankAutoDismissApprovedAlert(persistentAlertPage);
  await linebankEnsureTransactionPage(persistentAlertPage);
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
await linebankEnsureTransactionPage(navigationPage);
assert.deepEqual(navigationEvents, [
  "click-transaction-link",
  "wait-dropdown:120000",
]);

navigationEvents.length = 0;
navigationUrl = "https://accessibility.linebank.com.tw/transaction";
await linebankEnsureTransactionPage(navigationPage);
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
await linebankEnsureTransactionPage(fallbackPage);
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

assert.equal(
  linebankStatementRowsToCsv(rows),
  "帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註,匯率\n2026/07/05,2026/07/05,14:37:38,轉帳,,1000,1005,匯入 備註,\n",
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
assert.equal(linebankSortStatementRows(repeatedSourceRows).length, 2);

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
