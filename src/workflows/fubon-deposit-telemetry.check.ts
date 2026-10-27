import assert from "node:assert/strict";
import { chromium } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import {
  captureFubonDepositTelemetry,
  fetchFubonDepositStatementViaUi,
  inspectFubonDepositResponseMetadata,
  type FubonDepositTelemetryRunDependencies,
  type ParsedDepositStatementPage,
  type FubonParsedDepositStatement,
} from "./fubon-statements.ts";
import { reconcileFubonTelemetryAuthentication } from "./fubon-deposit-telemetry.ts";
import { FUBON_EBANK_ENTRY_URL, fubonEbankSite } from "./fubon-ebank-site.ts";

let authenticateCalls = 0;
const authRaceResult = await reconcileFubonTelemetryAuthentication(
  async () => {
    authenticateCalls += 1;
    throw new Error(
      "Timed out waiting for the Fubon login document to become ready.",
    );
  },
  async () => authenticateCalls > 0,
);
assert.equal(authRaceResult, "authenticated-after-auth-race");
assert.equal(authenticateCalls, 1);

const sensitiveAccount = "987654321098";
const sensitiveDescription = "PRIVATE DESCRIPTION 44";
const sensitiveAmount = "7654321";
const sensitiveNote = "PRIVATE NOTE 99";
const metadata = inspectFubonDepositResponseMetadata(`
  <form>
    <input type="hidden" name="javax.faces.ViewState" value="secret-view-state">
    <input name="txnSeqNbr" value="${sensitiveAccount}">
    <input name="resultGrid:dataGridCurrentPage" value="2">
    <input name="resultGrid:totalCount" value="4">
  </form>
  <table>
    <tr><th>帳務日期</th><th>交易時間</th><th>摘要</th><th>支出金額</th>
    <th>存入金額</th><th>即時餘額</th><th>附註</th></tr>
    <tr><td>2026/01/02</td><td>09:10:11</td><td>${sensitiveDescription}</td>
    <td>${sensitiveAmount}</td><td></td><td>100</td><td>${sensitiveNote}</td></tr>
  </table>
`);
assert.deepEqual(metadata.fieldNames, [
  "javax.faces.ViewState",
  "resultGrid:dataGridCurrentPage",
  "resultGrid:totalCount",
  "txnSeqNbr",
]);
assert.deepEqual(metadata.pagination, [
  { name: "resultGrid:dataGridCurrentPage", value: 2 },
  { name: "resultGrid:totalCount", value: 4 },
]);
assert.deepEqual(metadata.candidateProviderKeyNames, ["txnSeqNbr"]);
assert.equal(metadata.candidateProviderKeyDigests.length, 1);
const metadataJson = JSON.stringify(metadata);
assert.doesNotMatch(metadataJson, new RegExp(sensitiveAccount));
assert.doesNotMatch(metadataJson, new RegExp(sensitiveDescription));
assert.doesNotMatch(metadataJson, new RegExp(sensitiveAmount));
assert.doesNotMatch(metadataJson, new RegExp(sensitiveNote));
assert.match(metadataJson, /^\{.*sha256:/);

const statement = (empty: boolean): FubonParsedDepositStatement => ({
  account: `${sensitiveAccount} (012)`,
  accountId: sensitiveAccount,
  queryPeriod: "2026/01/01~2026/01/31",
  branchName: "012",
  rows: empty
    ? []
    : [
        [
          "2026/01/02",
          "09:10:11",
          sensitiveDescription,
          sensitiveAmount,
          "",
          "100",
          sensitiveNote,
        ],
      ],
  pages: [
    {
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      queryRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
      selectedAccount: {
        value: sensitiveAccount,
        label: `${sensitiveAccount} (012)`,
        branchName: "012",
      },
      rows: [],
      zeroObservation: empty ? "empty-page" : "non-empty-page",
    },
  ],
  accountOption: {
    value: sensitiveAccount,
    label: `${sensitiveAccount} (012)`,
    branchName: "012",
  },
});

const uiPageStatement = (
  range: string,
  empty: boolean,
): ParsedDepositStatementPage => {
  const evidenceRows = empty
    ? []
    : [
        {
          rowOrdinal: 0,
          cells: ["2026/01/02", "09:10:11", "safe", "", "1", "1", ""] as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ],
        },
      ];
  return {
    account: "masked (012)",
    accountId: "masked",
    queryPeriod: `${range}~${range}`,
    branchName: "012",
    rows: evidenceRows.map((row) => [...row.cells]),
    nextPage: null,
    pageFieldName: null,
    pageOrdinal: 0,
    responseSequence: 1,
    terminal: true,
    startDate: "2026/01/02",
    endDate: "2026/01/02",
    selectedAccountValue: "masked",
    selectedAccountLabel: "masked (012)",
    evidenceRows,
    responseMetadata: {
      fieldNames: ["form1:comboAccount"],
      fields: [{ name: "form1:comboAccount", type: "select" }],
      candidateProviderKeyNames: [],
      candidateProviderKeyDigests: [],
      statusFieldNames: [],
      correctionFieldNames: [],
      transactionTimeFieldNames: [],
      accountScopeFieldNames: ["form1:comboAccount"],
      pagination: [],
    },
    bodyLength: 1,
    bodySha256: "sha256:ui-fixture",
  };
};

const QUERY_PATH = "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces";
const queryForm = (result: string) => `<form id="form1" method="post" action="${QUERY_PATH}">
  <select id="form1:comboAccount" name="form1:comboAccount"><option value="masked">masked (012)</option></select>
  <input type="radio" id="form1:rdoDay180" name="form1:rdoGroup3" value="180">
  <input type="radio" id="form1:rdoDay1" name="form1:rdoGroup3" value="1">
  <input type="hidden" name="form1:doValidateAndSubmit" value="form1:doValidateAndSubmit">
  <a id="form1:doValidateAndSubmit" href="javascript:void(0)" onclick="document.getElementById('form1').submit()">查詢</a>
</form>${result}`;
const resultTable = `<table><tr><th>帳務日期</th><th>交易時間</th><th>即時餘額</th></tr></table>`;
const siteContext = { signal: new AbortController().signal, text: strictSourceText };

const browser = await chromium.launch({ headless: true });
try {
  const overridePage = await browser.newPage();
  await overridePage.setContent(queryForm(""));
  const output = await captureFubonDepositTelemetry(
    fubonEbankSite(overridePage, siteContext),
    { repeatDateRange: "180", zeroDateRange: "1" },
    {
      openTransactionDetailForAccountIndex: async () => "********1098",
      readDepositAccountOptions: async () => [
        { value: sensitiveAccount, label: `${sensitiveAccount} (012)` },
      ],
      selectDepositAccount: async () => undefined,
      fetchDepositStatement: async (_site, range) =>
        range === "1" ? statement(true) : statement(false),
    },
  );
  await overridePage.close();
  assert.equal(output.records.length, 3);
  assert.equal(output.records[0]?.queryId, "A1");
  assert.equal(output.records[1]?.queryId, "A2");
  assert.equal(output.records[2]?.queryId, "B");
  assert.equal(output.comparison.repeatStability, "observed-stable");
  assert.equal(output.zeroResultAuthority, "empty-result-table");
  const outputJson = JSON.stringify(output);
  assert.doesNotMatch(outputJson, new RegExp(sensitiveAccount));
  assert.doesNotMatch(outputJson, new RegExp(sensitiveDescription));
  assert.doesNotMatch(outputJson, new RegExp(sensitiveAmount));
  assert.doesNotMatch(outputJson, new RegExp(sensitiveNote));

  // The UI path submits the visible form and reads the bank's reply strictly.
  const uiPage = await browser.newPage();
  const markers = ["ui-response-a1", "ui-response-a2", "ui-response-b"];
  const posted: string[] = [];
  await uiPage.route(`${new URL(FUBON_EBANK_ENTRY_URL).origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = new URLSearchParams(request.postData() ?? "");
      posted.push(body.get("form1:rdoGroup3") ?? "");
      return await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `${queryForm(resultTable)}${markers[posted.length - 1] ?? "unexpected"}`,
      });
    }
    return await route.fulfill({ contentType: "text/html; charset=utf-8", body: queryForm("") });
  });
  await uiPage.goto(new URL(QUERY_PATH, FUBON_EBANK_ENTRY_URL).toString());
  const uiRanges: string[] = [];
  const uiBodies: string[] = [];
  const uiStatement: NonNullable<
    FubonDepositTelemetryRunDependencies["fetchDepositStatement"]
  > = async (site, range, account) => {
    uiRanges.push(range);
    return await fetchFubonDepositStatementViaUi(site, range, account, {
      accountAlreadySelected: true,
      parsePage: async (_page, html) => {
        uiBodies.push(html.match(/ui-response-\w+$/u)?.[0] ?? html);
        return uiPageStatement(range, html.endsWith("b") || range === "1");
      },
    });
  };

  const uiOutput = await captureFubonDepositTelemetry(
    fubonEbankSite(uiPage, siteContext),
    { repeatDateRange: "180", zeroDateRange: "1" },
    {
      openTransactionDetailForAccountIndex: async () => "masked",
      readDepositAccountOptions: async () => [
        { label: "masked (012)", value: "masked" },
      ],
      fetchDepositStatement: uiStatement,
    },
  );
  await uiPage.close();
  assert.deepEqual(uiRanges, ["180", "180", "1"]);
  assert.deepEqual(posted, ["180", "180", "1"], "each query submits the form with its range picked");
  assert.deepEqual(uiBodies, markers, "each query reads the bank's reply to its own submit");
  assert.equal(uiOutput.records.length, 3);
  assert.equal(uiOutput.records[0]?.observed.rowCount, 1);
  assert.equal(uiOutput.records[1]?.observed.rowCount, 1);
  assert.equal(uiOutput.records[2]?.observed.zeroResult, true);
} finally {
  await browser.close();
}

console.log("fubon-deposit-telemetry.check passed");
