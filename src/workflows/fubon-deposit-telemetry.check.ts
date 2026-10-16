import assert from "node:assert/strict";
import {
  captureFubonDepositTelemetry,
  fetchFubonDepositStatementViaUi,
  inspectFubonDepositResponseMetadata,
  type FubonStatementsRunDependencies,
  type ParsedDepositStatementPage,
  type FubonParsedDepositStatement,
} from "./fubon-statements.ts";
import { reconcileFubonTelemetryAuthentication } from "./fubon-deposit-telemetry.ts";

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

class FakeLocator {
  private readonly countValue: number;

  constructor(countValue: number) {
    this.countValue = countValue;
  }
  async count() {
    return this.countValue;
  }
  locator() {
    return new FakeLocator(0);
  }
  nth() {
    return new FakeLocator(0);
  }
  async getAttribute() {
    return null;
  }
}

class FakePage {
  private listener: ((response: unknown) => void) | undefined;
  on(_event: string, listener: (response: unknown) => void) {
    this.listener = listener;
  }
  off(_event: string, listener: (response: unknown) => void) {
    if (this.listener === listener) this.listener = undefined;
  }
  locator(selector: string) {
    return new FakeLocator(
      selector === 'a[id="form1:doValidateAndSubmit"]' ? 1 : 0,
    );
  }
  frames() {
    return [];
  }
  async waitForTimeout() {}
}

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

const output = await captureFubonDepositTelemetry(
  new FakePage() as never,
  { repeatDateRange: "180", zeroDateRange: "1" },
  {
    openTransactionDetailForAccountIndex: async () => "********1098",
    readDepositAccountOptions: async () => [
      { value: sensitiveAccount, label: `${sensitiveAccount} (012)` },
    ],
    selectDepositAccount: async () => undefined,
    fetchDepositStatement: async (_page, range) =>
      range === "1" ? statement(true) : statement(false),
  },
);
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

console.log("fubon-deposit-telemetry.check passed");

class UiFakeLocator {
  private readonly page: UiFakePage;
  private readonly selector: string;
  private readonly countValue: number;

  constructor(page: UiFakePage, selector: string, countValue = 1) {
    this.page = page;
    this.selector = selector;
    this.countValue = countValue;
  }

  async count() {
    return this.countValue;
  }

  first() {
    return this;
  }

  filter() {
    return this;
  }

  locator(selector: string) {
    return new UiFakeLocator(this.page, selector, this.countValue);
  }

  async waitFor() {}

  async click() {
    if (this.selector.includes("doValidateAndSubmit")) {
      this.page.submitClicks += 1;
    }
  }

  async selectOption() {
    this.page.accountSelections += 1;
  }

  async getAttribute() {
    return null;
  }
}

class UiFakeResponse {
  private readonly body: string;

  constructor(body: string) {
    this.body = body;
  }

  request() {
    return { method: () => "POST" };
  }

  url() {
    return "https://ebank.taipeifubon.com.tw/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces";
  }

  async finished() {}

  async text() {
    return this.body;
  }
}

class UiFakePage {
  submitClicks = 0;
  accountSelections = 0;
  private readonly responseQueue = [
    new UiFakeResponse("ui-response-a1"),
    new UiFakeResponse("ui-response-a2"),
    new UiFakeResponse("ui-response-b"),
  ];

  on() {}
  off() {}

  locator(selector: string) {
    if (selector === "a") return new UiFakeLocator(this, selector, 0);
    if (selector === "table") return new UiFakeLocator(this, selector, 1);
    if (selector === "input,select,textarea") {
      return new UiFakeLocator(this, selector, 0);
    }
    return new UiFakeLocator(this, selector, 1);
  }

  frames() {
    return [];
  }

  async waitForTimeout() {}

  async waitForResponse() {
    const response = this.responseQueue.shift();
    if (!response) throw new Error("Unexpected extra UI query.");
    return response;
  }
}

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

const uiPage = new UiFakePage();
const uiRanges: string[] = [];
const uiStatement: NonNullable<
  FubonStatementsRunDependencies["fetchDepositStatement"]
> = async (page, range, account) => {
  uiRanges.push(range);
  return await fetchFubonDepositStatementViaUi(page, range, account, {
    accountAlreadySelected: true,
    parsePage: async (_page, html) =>
      uiPageStatement(range, html.endsWith("b") || range === "1"),
  });
};

const uiOutput = await captureFubonDepositTelemetry(
  uiPage as unknown as Parameters<typeof captureFubonDepositTelemetry>[0],
  { repeatDateRange: "180", zeroDateRange: "1" },
  {
    openTransactionDetailForAccountIndex: async () => "masked",
    readDepositAccountOptions: async () => [
      { label: "masked (012)", value: "masked" },
    ],
    fetchDepositStatement: uiStatement,
  },
);
assert.deepEqual(uiRanges, ["180", "180", "1"]);
assert.equal(uiPage.submitClicks, 3);
assert.equal(uiOutput.records.length, 3);
assert.equal(uiOutput.records[0]?.observed.rowCount, 1);
assert.equal(uiOutput.records[1]?.observed.rowCount, 1);
assert.equal(uiOutput.records[2]?.observed.zeroResult, true);
