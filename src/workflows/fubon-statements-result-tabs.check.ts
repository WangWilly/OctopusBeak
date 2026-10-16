import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  buildFubonDepositStatementEvidence,
  parseFubonDepositStatementResponses,
  runFubonStatements,
} from "./fubon-statements.ts";
import { deriveFubonSourceConnectionKey, fubonStableLoginScope } from "./fubon-source-connection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import {
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";

const accountDigits = "00987654321098";
const label = `${accountDigits} (013)`;
const usdCodedOption = { value: `013-00${accountDigits}-USD-02`, label };
const twdCodedOption = { value: `013-00${accountDigits}-TWD-01`, label };
const twdTab = "臺幣活期存款";
const fxTab = "外幣活期存款";

type TabStrip =
  | { kind: "none" }
  | { kind: "tabs"; active: "twd" | "fx" | "none"; marker: "class" | "aria" };

function resultPageHtml(
  option: Readonly<{ value: string; label: string }>,
  tabs: TabStrip,
  twdTableCurrencyColumn = false,
): string {
  const tab = (text: string, active: boolean) =>
    tabs.kind === "tabs" && tabs.marker === "aria"
      ? `<li><a href="#" role="tab" aria-selected="${active}">${text}</a></li>`
      : `<li${active ? ' class="active"' : ""}><a href="#">${text}</a></li>`;
  const tabStrip =
    tabs.kind === "none"
      ? ""
      : `<ul class="tabs" role="tablist">${tab(twdTab, tabs.active === "twd")}${tab(fxTab, tabs.active === "fx")}</ul>`;
  const fxTable = tabs.kind === "none"
    ? ""
    : `<div id="fxPanel"><table id="fxGrid" class="tb1 queryResult">
        <tr><th>帳務日期</th><th>交易時間</th><th>摘要</th><th>幣別</th><th>支出金額</th><th>存入金額</th><th>即時餘額</th><th>附註</th></tr>
        <tr><td>2026/01/03</td><td>10:00:00</td><td>FX-SYNTHETIC</td><td>美金</td><td></td><td>4,321.97</td><td>8,712.39</td><td></td></tr>
        <tr><td>2026/01/04</td><td>11:00:00</td><td>FX-SYNTHETIC</td><td>美金</td><td>1,203.58</td><td></td><td>7,508.81</td><td></td></tr>
      </table></div>`;
  const currencyHeader = twdTableCurrencyColumn ? "<th>幣別</th>" : "";
  const currencyCell = twdTableCurrencyColumn ? "<td>新臺幣</td>" : "";
  return `<!doctype html><html><body>
    <input id="form1:startDate" value="2026/01/01">
    <input id="form1:endDate" value="2026/01/31">
    <input name="resultGrid:dataGridCurrentPage" value="1">
    <input name="resultGrid:dataGridCurrentPageSize" value="10">
    <input name="resultGrid:totalCount" value="2">
    <form id="form1">
      <div class="queryResultArea">
        <h3>查詢結果</h3>
        ${tabStrip}
        ${fxTable}
        <div id="twdPanel"><table id="resultGrid" class="tb1 queryResult">
          <tr><th>帳務日期</th><th>交易時間</th><th>摘要</th><th>支出金額</th><th>存入金額</th><th>即時餘額</th><th>附註</th>${currencyHeader}</tr>
          <tr><td>2026/01/02</td><td>09:10:11</td><td>SYNTHETIC-IN</td><td></td><td>500</td><td>1,500</td><td></td>${currencyCell}</tr>
          <tr><td>2026/01/05</td><td>14:20:00</td><td>SYNTHETIC-OUT</td><td>200</td><td></td><td>1,300</td><td></td>${currencyCell}</tr>
        </table></div>
      </div>
    </form>
    <script>
      var comboAccountItems = [];
      comboAccountItems[0] = new Array("${option.label}", "${option.value}");
      function setupComboBox() {}
      setupComboBox("form1:comboAccount", "", "${option.value}");
    </script>
  </body></html>`;
}

const stableLogin = { fubon_user_id: "FUBON-USER-TABS", fubon_account: "FUBON-LOGIN-TABS" };
const sourceConnectionScope = fubonStableLoginScope(stableLogin)!;
const sourceConnectionKey = deriveFubonSourceConnectionKey(stableLogin)!;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const scenario = async (
    name: string,
    option: Readonly<{ value: string; label: string }>,
    tabs: TabStrip,
    twdTableCurrencyColumn = false,
  ) => {
    const html = resultPageHtml(option, tabs, twdTableCurrencyColumn);
    await page.setContent(html);
    const statement = await parseFubonDepositStatementResponses(page, [html], option);
    assert.deepEqual(
      statement.rows.map((row) => row[2]),
      ["SYNTHETIC-IN", "SYNTHETIC-OUT"],
      `${name}: the parser reads the seven-header 臺幣 table, never the 外幣 table`,
    );
    const [capture] = buildFubonDepositStatementEvidence([statement]);
    const items: PGliteWorkflowRunItem[] = [];
    const result = await runFubonStatements(
      {} as never,
      { dateRanges: ["30"], downloadFormat: "EXCEL" },
      {
        sourceConnectionScope,
        sourceConnectionKey,
        deferredCommitItems: items,
        sourceText: strictSourceText,
        signal: new AbortController().signal,
        readCurrentDepositBalances: async () => [],
        openTransactionDetailForAccountIndex: async () => "****0000",
        readDepositAccountOptions: async () => [option],
        selectDepositAccount: async () => undefined,
        fetchDepositStatement: async () => statement,
      },
    );
    for (const item of items) {
      assert.doesNotMatch(
        JSON.stringify(item.command),
        /美金|FX-SYNTHETIC|4,?321\.97|8,?712\.39|1,?203\.58|7,?508\.81|432197|871239|120358|750881/u,
        `${name}: the 外幣活期存款 table must not reach a ${item.command.kind} command`,
      );
    }
    const financial = items.filter((item) => item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND);
    const sourceOnly = items.filter((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND);
    return { statement, capture: capture!, result, financial, sourceOnly };
  };

  const assertSourceOnly = (
    name: string,
    run: Awaited<ReturnType<typeof scenario>>,
    currencyEvidence: unknown,
  ) => {
    assert.equal(run.capture.providerRouteEvidence?.currency, "unknown", `${name}: route currency`);
    assert.equal(run.capture.providerRouteEvidence?.currencySource, undefined, `${name}: no currency source`);
    assert.equal(run.financial.length, 0, `${name}: no financial deposit commit`);
    assert.equal(run.sourceOnly.length, 1, `${name}: the statement lands as source-only evidence`);
    assert.deepEqual(
      run.result.statementExclusions,
      [{
        reason: "account-currency-unproven",
        accountShape: run.statement.accountOption.value.replace(/\d/gu, "9").replace(/\p{L}/gu, "A"),
        currencyEvidenceByPage: [currencyEvidence],
      }],
      `${name}: the exclusion records what the result page showed`,
    );
  };

  const tabLabels = [twdTab, fxTab];

  for (const marker of ["class", "aria"] as const) {
    const name = `(a) active 臺幣 by ${marker} + USD-coded matching option`;
    const run = await scenario(name, usdCodedOption, { kind: "tabs", active: "twd", marker });
    assert.deepEqual(
      run.statement.pages.map((statementPage) => statementPage.currencyEvidence),
      [{ kind: "active-tab", label: twdTab, labels: tabLabels }],
      `${name}: the parser detects the active 臺幣活期存款 tab`,
    );
    assert.equal(run.capture.providerRouteEvidence?.currency, "TWD", `${name}: route currency`);
    assert.equal(run.capture.providerRouteEvidence?.currencySource, `active-tab:${twdTab}`, `${name}: currency source`);
    assert.equal(run.sourceOnly.length, 0, `${name}: nothing falls back to source-only`);
    assert.deepEqual(
      run.financial.map((item) =>
        item.command.kind === PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND
          ? item.command.request.capture.identity.accountNumber?.evidenceVersion
          : null,
      ),
      ["fubon/domestic-deposit/account-number-v3"],
      `${name}: the statement commits financially with V3 account-number evidence`,
    );
    assert.deepEqual(run.result.statementExclusions, [], `${name}: no exclusion`);
  }

  {
    const name = "(b) active 外幣 + USD-coded matching option";
    const run = await scenario(name, usdCodedOption, { kind: "tabs", active: "fx", marker: "class" });
    assertSourceOnly(name, run, { kind: "active-tab", label: fxTab, labels: tabLabels });
  }

  {
    const name = "(c) no tabs + TWD-coded option";
    const run = await scenario(name, twdCodedOption, { kind: "none" });
    assert.deepEqual(run.statement.pages.map((statementPage) => statementPage.currencyEvidence), [{ kind: "no-currency-tabs" }]);
    assert.equal(run.capture.providerRouteEvidence?.currency, "TWD", `${name}: route currency`);
    assert.equal(run.capture.providerRouteEvidence?.currencySource, "selector-option", `${name}: currency source`);
    assert.equal(run.financial.length, 1, `${name}: the statement commits financially`);
    assert.equal(run.sourceOnly.length, 0, `${name}: nothing falls back to source-only`);
    assert.deepEqual(run.result.statementExclusions, [], `${name}: no exclusion`);
  }

  {
    const name = "(d) no tabs + USD-coded option";
    const run = await scenario(name, usdCodedOption, { kind: "none" });
    assertSourceOnly(name, run, { kind: "no-currency-tabs" });
  }

  {
    const name = "(e) tabs with no active marker";
    const run = await scenario(name, usdCodedOption, { kind: "tabs", active: "none", marker: "class" });
    assertSourceOnly(name, run, { kind: "ambiguous", reason: "no-active-tab", labels: tabLabels });
  }

  {
    const name = "(f) active 臺幣 but the matched table carries a 幣別 column";
    const run = await scenario(name, usdCodedOption, { kind: "tabs", active: "twd", marker: "class" }, true);
    assertSourceOnly(name, run, { kind: "ambiguous", reason: "currency-column-present", labels: tabLabels });
  }

  {
    const name = "(g) active 外幣 + TWD-coded option";
    const run = await scenario(name, twdCodedOption, { kind: "tabs", active: "fx", marker: "aria" });
    assertSourceOnly(name, run, { kind: "active-tab", label: fxTab, labels: tabLabels });
  }
} finally {
  await browser.close();
}
