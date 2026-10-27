import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import {
  createPGliteChildRpcServer,
  type PGliteChildProvider,
} from "../../electron/pglite-child-rpc.ts";
import { requirePGliteChildRpcClientFromEnv } from "../../electron/pglite-child-rpc-client.ts";
import { createPGliteViewWorkerClient } from "../../electron/pglite-view-worker-client.ts";
import {
  PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import { executePGliteWorkflowRun } from "../ledger/pglite/workflow-run.ts";
import {
  FUBON_LOAN_PAGINATION_FIXTURES_V1,
  FUBON_LOAN_PAGINATION_FIXTURES_V2,
} from "./fubon-loan-statements.fixtures.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import type { ProductStageRequest } from "../lib/automation/product-collection.ts";
import { FUBON_EBANK_ENTRY_URL, fubonEbankSite, type FubonEbankSite } from "./fubon-ebank-site.ts";

const { runFubonLoanStatements, fubonLoanStatementsInputSchema } = await import("./fubon-loan-statements.ts");
const { buildFubonLoanCapture, assertFubonLoanCaptureAccountNumberEvidence } =
  await import("../ledger/canonical/fubon-loan-admission.ts");
const { FUBON_LOAN_CONTRACT_VERSION } =
  await import("../ledger/canonical/loan-admission.ts");
const { deriveFubonSourceConnectionKey, fubonStableLoginScope } =
  await import("./fubon-source-connection.ts");

const syntheticFubonLoanAccountNumber = ["0123", "4567", "8901", "23"].join("");

const source = await readFile(
  new URL("./fubon-loan-statements.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /from ["']libretto["']|export default workflow\(/u);
assert.doesNotMatch(source, /openFubonLoginForm|fubonLogin\(/u);
assert.match(source, /StatementComponentAbsentError/);
assert.match(source, /No Fubon loan account is available/);
assert.doesNotMatch(source, /pageCount:\s*1/);
assert.match(source, /relationCoverage:\s*["']not-asserted["']/);
const runSource = source.slice(
  source.indexOf("export async function runFubonLoanStatements"),
);
assert.match(runSource, /PGLITE_CANONICAL_LOAN_COMMIT_COMMAND/);
assert.match(runSource, /PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND/);
assert.match(runSource, /relationCommands: \(\) => \[/);
assert.doesNotMatch(
  source,
  /loanPaymentMatchCandidates|matchLoanPaymentsToDepositOutflows/u,
  "date+amount loan payment candidates must not be emitted or stored",
);
assert.match(
  source,
  /FUBON_LOAN_TERMINAL_RULE_VERSION\s*=\s*["']fubon-loan-terminal-v2["']/u,
  "the live-verified static result terminal rule must be versioned",
);
const loanCommitMarker = runSource.indexOf(
  "PGLITE_CANONICAL_LOAN_COMMIT_COMMAND",
);
const loanResolverMarker = runSource.indexOf(
  "PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND",
);
assert.ok(
  loanCommitMarker >= 0 && loanResolverMarker > loanCommitMarker,
  "loan relation resolution must be emitted with the PGlite capture item",
);
assert.doesNotMatch(
  source,
  /canonicalLoanCaptureSpines|persistCanonicalLoanCaptureExtensions|commitCanonicalFinancialDepositCaptureBatchInTransaction/u,
  "the workflow must not coordinate internal loan spines or low-level deposit batches",
);
assert.doesNotMatch(
  source,
  /resolveLoanRelationsAfterCapture|resolveLoanRepaymentRelations/u,
);

test("Fubon exported loan run fails closed without caller Source Connection identity", async () => {
  await assert.rejects(
    () =>
      runFubonLoanStatements(
        {} as Page,
        { downloadFormat: "EXCEL" } as Parameters<
          typeof runFubonLoanStatements
        >[1],
        {} as Parameters<typeof runFubonLoanStatements>[2],
        {} as Parameters<typeof runFubonLoanStatements>[3],
      ),
    /stable caller-supplied Source Connection scope and key/u,
  );
});

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-fubon-loan-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const module = await server
  .ssrLoadModule("/src/workflows/fubon-loan-statements.ts")
  .finally(() => server.close());
const parseFubonLoanStatementRows = module.parseFubonLoanStatementRows as (
  rows: readonly string[][],
) => string[][];
const parseFubonLoanPaginationSignal =
  module.parseFubonLoanPaginationSignal as (html: string) => unknown;
const parseFubonLoanStatementForCollection = module.parseFubonLoanStatementForCollection as (
  site: FubonEbankSite,
  html: string,
  account: { label: string; value: string },
  input: {
    loanAccountLabels: string[];
    queryItems: Array<"TRANSACTION_DETAIL_QUERY">;
    quickMonths: "1" | "3" | "6";
    downloadFormat: "EXCEL";
    dateRange: { startDate: string; endDate: string };
  },
  sourceText: { assertIntact(value: string): void },
) => Promise<{ completeness: { terminal: true } | null }>;
const assembleFubonLoanStatement = module.assembleFubonLoanStatement as (
  pages: ReadonlyArray<{
    accountType: string;
    branchName: string;
    currency: string;
    rows: string[][];
    pageOrdinal: number;
    pagination: {
      nextPage: string | null;
      pageFieldName: string | null;
      terminal: boolean;
      evidence: "next-page" | "terminal-no-next" | null;
    };
  }>,
  account: { label: string; value: string },
  input: {
    loanAccountLabels: string[];
    queryItems: Array<"TRANSACTION_DETAIL_QUERY">;
    quickMonths: "1" | "3" | "6";
    downloadFormat: "EXCEL";
    dateRange: { startDate: string; endDate: string };
  },
) => {
  accountNumber?: {
    value: string;
    kind: "loan-account";
    evidenceVersion: "fubon/loan/account-number-v1";
    sourceField: "form1:loanAccountCombo option.text";
  };
  completeness: { pageCount: number; terminal: true } | null;
  pages: ReadonlyArray<{
    pageOrdinal: number;
    terminal: boolean;
    rowCount: number;
  }>;
  rows: string[][];
};
const extractFubonLoanAccountEvidence =
  module.extractFubonLoanAccountEvidence as (
    optionValue: string,
    optionLabel: string,
  ) => string | null;
const deriveFubonLoanAccountNumberEvidence =
  module.deriveFubonLoanAccountNumberEvidence as (account: {
    label: string;
    value: string;
  }) =>
    | {
        value: string;
        kind: "loan-account";
        evidenceVersion: "fubon/loan/account-number-v1";
      sourceField: "form1:loanAccountCombo option.text";
    }
    | null;

test("typed Fubon loan parser returns complete evidence without CSV/JSON files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fubon-loan-typed-no-files-"));
  const originalCwd = process.cwd();
  process.chdir(temp);
  try {
    const page = {
      evaluate: async () => ({
        accountType: "synthetic-loan",
        branchName: "synthetic-branch",
        currency: "TWD",
        rows: [[
          "2026/01/31",
          "SYNTHETIC-LOAN-ROW",
          "12500.00",
          "1.50",
          "2026/01/31",
          "2026/02/28",
          "87500.00",
          "",
        ]],
      }),
    } as unknown as Page;
    const fixtureHtml = FUBON_LOAN_PAGINATION_FIXTURES_V2.providerResultTerminalWithoutPager;
    const result = await parseFubonLoanStatementForCollection(
      fubonEbankSite(page, { signal: new AbortController().signal, text: strictSourceText }),
      fixtureHtml,
      {
        label: `${syntheticFubonLoanAccountNumber} (synthetic-loan)`,
        value: "opaque-synthetic-loan-option",
      },
      {
        loanAccountLabels: [],
        queryItems: ["TRANSACTION_DETAIL_QUERY"],
        quickMonths: "6",
        downloadFormat: "EXCEL",
        dateRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
      },
      { assertIntact: (value) => assert.ok(value.length > 0) },
    );

    assert.deepEqual(await readdir(temp), [], "typed loan parsing must not create source, output, or log files");
    assert.equal(result.completeness?.terminal, true);
  } finally {
    process.chdir(originalCwd);
    await rm(temp, { recursive: true, force: true });
  }
});

test("extracts only a complete unmasked Fubon loan selector account", () => {
  assert.equal(
    extractFubonLoanAccountEvidence(
      "opaque-provider-option",
      `${syntheticFubonLoanAccountNumber} (學貸-留貸)`,
    ),
    syntheticFubonLoanAccountNumber,
  );
  assert.equal(
    extractFubonLoanAccountEvidence(syntheticFubonLoanAccountNumber, "masked"),
    null,
  );
  assert.equal(
    extractFubonLoanAccountEvidence(
      "opaque-provider-option",
      "**********0123 (學貸-留貸)",
    ),
    null,
  );
  assert.equal(
    extractFubonLoanAccountEvidence(
      "opaque-provider-option",
      `${syntheticFubonLoanAccountNumber} arbitrary suffix`,
    ),
    null,
  );
  assert.deepEqual(
    deriveFubonLoanAccountNumberEvidence({
      value: "opaque-provider-option",
      label: `${syntheticFubonLoanAccountNumber} (學貸-留貸)`,
    }),
    {
      value: syntheticFubonLoanAccountNumber,
      kind: "loan-account",
      evidenceVersion: "fubon/loan/account-number-v1",
      sourceField: "form1:loanAccountCombo option.text",
    },
  );
  assert.equal(
    deriveFubonLoanAccountNumberEvidence({
      value: "opaque-provider-option",
      label: "**********0123 (學貸-留貸)",
    }),
    null,
  );
});

test("fails closed when a Fubon result contains an unexpected non-header row", () => {
  assert.throws(
    () => parseFubonLoanStatementRows([new Array(7).fill("unexpected")]),
    /unexpected Fubon loan result row/i,
  );
});

test("Fubon pagination derives terminal/page evidence from provider controls", () => {
  assert.deepEqual(
    parseFubonLoanPaginationSignal(
      FUBON_LOAN_PAGINATION_FIXTURES_V1.activePage,
    ),
    {
      nextPage: "2",
      pageFieldName: "form1:opaque_DataGrid:dataGridCurrentPage",
      terminal: false,
      evidence: "next-page",
    },
  );
  assert.deepEqual(
    parseFubonLoanPaginationSignal(
      FUBON_LOAN_PAGINATION_FIXTURES_V1.activePageWithoutExplicitAriaState,
    ),
    {
      nextPage: "2",
      pageFieldName: "form1:opaque_DataGrid:dataGridCurrentPage",
      terminal: false,
      evidence: "next-page",
    },
  );
  assert.deepEqual(
    parseFubonLoanPaginationSignal(
      FUBON_LOAN_PAGINATION_FIXTURES_V1.terminalPage,
    ),
    {
      nextPage: null,
      pageFieldName: null,
      terminal: true,
      evidence: "terminal-no-next",
    },
  );
  assert.deepEqual(
    parseFubonLoanPaginationSignal(
      FUBON_LOAN_PAGINATION_FIXTURES_V1.ambiguousTable,
    ),
    {
      nextPage: null,
      pageFieldName: null,
      terminal: false,
      evidence: null,
    },
  );
  for (const fixture of [
    FUBON_LOAN_PAGINATION_FIXTURES_V1.unrelatedPagerOnly,
    FUBON_LOAN_PAGINATION_FIXTURES_V1.unrelatedPagerOutsideResult,
  ]) {
    assert.deepEqual(parseFubonLoanPaginationSignal(fixture), {
      nextPage: null,
      pageFieldName: null,
      terminal: false,
      evidence: null,
    });
  }
});

test("Fubon live-verified provider result shape is a versioned terminal signal", () => {
  assert.deepEqual(
    parseFubonLoanPaginationSignal(
      FUBON_LOAN_PAGINATION_FIXTURES_V2.providerResultTerminalWithoutPager,
    ),
    {
      nextPage: null,
      pageFieldName: null,
      terminal: true,
      evidence: "terminal-no-next",
    },
  );
  assert.deepEqual(
    parseFubonLoanPaginationSignal(
      FUBON_LOAN_PAGINATION_FIXTURES_V2.providerResultWithoutRows,
    ),
    {
      nextPage: null,
      pageFieldName: null,
      terminal: false,
      evidence: null,
    },
  );
  for (const fixture of [
    FUBON_LOAN_PAGINATION_FIXTURES_V2.providerResultWithoutCurrentPageField,
    FUBON_LOAN_PAGINATION_FIXTURES_V2.unrelatedTable,
  ]) {
    assert.deepEqual(parseFubonLoanPaginationSignal(fixture), {
      nextPage: null,
      pageFieldName: null,
      terminal: false,
      evidence: null,
    });
  }
  assert.deepEqual(
    parseFubonLoanPaginationSignal(
      FUBON_LOAN_PAGINATION_FIXTURES_V2.providerResultWithActiveNext,
    ),
    {
      nextPage: "2",
      pageFieldName: "resultGrid:dataGridCurrentPage",
      terminal: false,
      evidence: "next-page",
    },
  );
});

test("Fubon multi-page traversal preserves page ordinals and terminal evidence", () => {
  const parsed = assembleFubonLoanStatement(
    [
      {
        accountType: "房屋貸款",
        branchName: "sanitized-branch",
        currency: "TWD",
        rows: [
          [
            "2026/01/05",
            "LOAN-DISBURSEMENT",
            "100000.00",
            "1.50",
            "2026/01/05",
            "2026/01/31",
            "100000.00",
            "",
          ],
        ],
        pageOrdinal: 0,
        pagination: {
          nextPage: "2",
          pageFieldName: "resultGrid:dataGridCurrentPage",
          terminal: false,
          evidence: "next-page",
        },
      },
      {
        accountType: "房屋貸款",
        branchName: "sanitized-branch",
        currency: "TWD",
        rows: [
          [
            "2026/01/31",
            "LOAN-PAYMENT",
            "12500.00",
            "1.50",
            "2026/01/31",
            "2026/02/28",
            "87500.00",
            "",
          ],
        ],
        pageOrdinal: 1,
        pagination: {
          nextPage: null,
          pageFieldName: null,
          terminal: true,
          evidence: "terminal-no-next",
        },
      },
    ],
    { label: `${syntheticFubonLoanAccountNumber} (學貸-留貸)`, value: "opaque-loan" },
    {
      loanAccountLabels: [],
      queryItems: ["TRANSACTION_DETAIL_QUERY"],
      quickMonths: "6",
      downloadFormat: "EXCEL",
      dateRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
    },
  );

  assert.equal(parsed.completeness?.pageCount, 2);
  assert.deepEqual(parsed.accountNumber, {
    value: syntheticFubonLoanAccountNumber,
    kind: "loan-account",
    evidenceVersion: "fubon/loan/account-number-v1",
    sourceField: "form1:loanAccountCombo option.text",
  });
  assert.deepEqual(
    parsed.pages.map((page) => [
      page.pageOrdinal,
      page.rowCount,
      page.terminal,
    ]),
    [
      [0, 1, false],
      [1, 1, true],
    ],
  );
  assert.equal(parsed.rows.length, 2);
});

test("commits and resolves one Fubon loan capture through authenticated PGlite RPC", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "fubon-loan-pglite-"));
  const worker = createPGliteViewWorkerClient(
    new Worker(new URL("../../electron/pglite-view-worker.ts", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
      workerData: { dataDir: join(runDir, "pglite") },
    }),
  );
  const server = createPGliteChildRpcServer({
    provider: {
      operational: worker.operationalProvider,
      financial: worker.financial,
    } as PGliteChildProvider,
  });
  const priorEnv = Object.fromEntries(
    Object.keys(server.env).map((key) => [key, process.env[key]]),
  );

  try {
    await server.ready;
    Object.assign(process.env, server.env);
    const client = requirePGliteChildRpcClientFromEnv();
    try {
      await client.ready;
      const capture = buildFubonLoanCapture({
        accountValue: "fubon-option-test",
        accountNumber: {
          value: syntheticFubonLoanAccountNumber,
          kind: "loan-account",
          evidenceVersion: "fubon/loan/account-number-v1",
          sourceField: "form1:loanAccountCombo option.text",
        },
        sourceConnectionScope: "fubon-connection-test",
        observedAt: "2026-02-01T00:00:00.000Z",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        scope: {
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          completeness: "complete-range",
          completenessBasis: "source-declared-terminal-range",
          completenessRuleVersion: FUBON_LOAN_CONTRACT_VERSION,
          pageCount: 1,
          terminal: true,
        },
        pages: [
          {
            pageOrdinal: 0,
            responseCode: "200",
            terminal: true,
            rowCount: 1,
            proofKind: "source-declared-terminal-range",
          },
        ],
        relationCoverage: "not-asserted",
        counterpartTransactions: [],
        relations: [],
        rows: [
          {
            transactionDate: "2026/01/05",
            transactionContent: "LOAN-DISBURSEMENT",
            transactionAmount: "100000.00",
            balanceAfterTransaction: "100000.00",
          },
        ],
      });
      assertFubonLoanCaptureAccountNumberEvidence(capture);
      assert.match(capture.identity.accountNo, /^sha256:/u);
      assert.deepEqual(capture.identity.accountNumber, {
        value: syntheticFubonLoanAccountNumber,
        kind: "loan-account",
        evidenceVersion: "fubon/loan/account-number-v1",
        sourceField: "form1:loanAccountCombo option.text",
      });
      const sourceRecord = capture.records[0];
      assert.ok(sourceRecord);

      const result = await executePGliteWorkflowRun({
        client: client.workflow,
        provider: "fubon",
        product: "loan",
        items: [
          {
            provider: "fubon",
            product: "loan",
            itemKey: capture.captureId,
            command: {
              kind: PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
              request: { capture },
            },
            relationCommands: () => [
              {
                kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
                request: {
                  sourceConnectionKey: capture.identity.sourceConnectionKey,
                  integrationNamespace: "fubon",
                  observedAt: capture.observedAt,
                  counterpartyEvidence: [
                    {
                      captureId: capture.captureId,
                      sourceRecordKey: sourceRecord.sourceRecordKey,
                      sourceConnectionKey: capture.identity.sourceConnectionKey,
                      identityEpochKey: capture.identity.identityEpochKey,
                      accountValue: syntheticFubonLoanAccountNumber,
                      role: "beneficiary",
                      purpose: "loan_repayment",
                      scope: "loan_contract",
                      evidenceKind: "repayment-mandate",
                      sourceField: "loan-account-selector",
                      contractVersion:
                        "fubon/loan-account-as-repayment-destination/v1",
                      effectiveStartDate: capture.scope.startDate,
                      effectiveEndDate: capture.scope.endDate,
                      accountKey: capture.identity.accountKey,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      assert.equal(result.status, "completed");
      assert.equal(result.items[0]?.status, "committed");
      assert.deepEqual(result.items[0]?.relationWarnings, []);
      assert.equal(
        (await worker.financial.request("financial.liabilities.current", [])).accounts.length,
        1,
      );
    } finally {
      client.close();
    }
  } finally {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server.close();
    await worker.close();
    await rm(runDir, { recursive: true, force: true });
  }
});

// The whole read against a synthetic signed-in frame1/txnFrame frameset served
// by route interception (ADR 0066): the 貸款服務 menu reveals the task link, the
// link is clicked in place, each account is selected behind the bank mask and
// queried over the custom range, and a two-page result is followed to its
// terminal page through form postbacks.
const SITE_ORIGIN = new URL(FUBON_EBANK_ENTRY_URL).origin;
const LOAN_QUERY_PATH = "/B2C/clnqu/clnqu001/CLNQU001_Home.faces";
const LOAN_DIRECT_PATH = "/B2C/clnqu/clnqu001/direct.faces";
const shellLoanAccounts = [
  { value: "opaque-loan-a", label: `${syntheticFubonLoanAccountNumber} (房屋貸款)` },
  { value: "opaque-loan-b", label: "**********4321 (信用貸款)" },
];
const shellLoanHeader = `<a id="menu_CLN" href="javascript:void(0)" onclick="openLoanMenu()">貸款服務</a><div id="cln"></div>
<script>
  function openLoanMenu() {
    parent.menuOpens = (parent.menuOpens ?? 0) + 1;
    document.getElementById("cln").innerHTML =
      '<a class="task_CLNQU001 menu_CLN02" href="${LOAN_DIRECT_PATH}" onclick="event.preventDefault(); parent.frames.txnFrame.location.href=\\'${LOAN_QUERY_PATH}\\'">貸款交易明細查詢</a>';
  }
</script>`;
const loanResultGrid = (rows: string[][], page: string, next: string) => `
  <table><tr><td>分行名稱</td><td>sanitized-branch</td><td>幣別</td><td>TWD</td></tr><tr><td>帳號類別</td><td>sanitized-loan</td></tr></table>
  <input type="hidden" name="resultGrid:dataGridCurrentPage" value="${page}">
  <table id="resultGrid" class="tb1 queryResult"><tbody>
    <tr>${["交易日期", "交易內容", "異動金額", "利率", "計息起日", "計息止日", "餘額", "備註"].map((header) => `<td>${header}</td>`).join("")}</tr>
    ${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}
  </tbody></table>${next}`;
const loanRow = (date: string, content: string, balance: string) =>
  [date, content, "100.00", "1.50", date, date, balance, ""];
const loanResultFor = (account: string, page: string) => {
  if (account === shellLoanAccounts[0]!.value && page === "1") {
    return loanResultGrid(
      [loanRow("2026/01/05", "還款", "900.00")],
      "1",
      `<a onclick="setDataGridCurrentPage('opaque', 2, 'resultGrid:dataGridCurrentPage')">下一頁</a>`,
    );
  }
  if (account === shellLoanAccounts[0]!.value) {
    return loanResultGrid([loanRow("2026/01/20", "繳息", "800.00")], "2", "");
  }
  return loanResultGrid([loanRow("2026/01/10", "LOAN-PAYMENT", "500.00")], "1", "");
};
const loanQueryForm = (selected: string, result: string) => `<form id="form1" method="post" action="${LOAN_QUERY_PATH}">
    <select id="form1:loanAccountCombo" name="form1:loanAccountCombo" onchange="showQueryItems()">
      <option value="none">請選擇</option>
      ${shellLoanAccounts.map((account) => `<option value="${account.value}"${account.value === selected ? " selected" : ""}>${account.label}</option>`).join("")}
    </select>
    <select id="form1:queryItemCombo" name="form1:queryItemCombo"></select>
    <input type="radio" class="queryPeriod" name="form1:queryPeriod" value="quick">
    <input type="radio" class="queryPeriod" name="form1:queryPeriod" value="custom">
    <input type="radio" class="quickKind" name="form1:quickKind" value="6">
    <input id="form1:startDate" name="form1:startDate" value="">
    <input id="form1:endDate" name="form1:endDate" value="">
    <a id="form1:doValidate" href="javascript:void(0)">查詢</a>
    ${result}
  </form>
  <script>
    function showQueryItems() {
      const mask = document.createElement("div");
      mask.className = "_mask";
      mask.style.cssText = "position:fixed;inset:0";
      document.body.appendChild(mask);
      setTimeout(() => {
        document.getElementById("form1:queryItemCombo").innerHTML =
          '<option value="TRANSACTION_DETAIL_QUERY">交易明細</option><option value="DATES_DETAIL_QUERY">日期明細</option>';
        mask.remove();
      }, 300);
    }
  </script>`;

async function readLoanThroughShell(
  options: Readonly<{ signal?: AbortSignal; holdAccount?: string; onHeld?: () => void; brokenAccount?: string }> = {},
) {
  const browser = await chromium.launch({ headless: true });
  const shellPage = await browser.newPage();
  const posted: Array<{ account: string; page: string; submit: boolean; period?: string; range?: string }> = [];
  const requested: string[] = [];
  const staged: ProductStageRequest[] = [];
  const activities: string[] = [];
  const html = (body: string) => ({ contentType: "text/html; charset=utf-8", body });
  try {
    await shellPage.route(`${SITE_ORIGIN}/**`, async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      requested.push(pathname);
      if (pathname === LOAN_QUERY_PATH && request.method() === "POST") {
        const body = new URLSearchParams(request.postData() ?? "");
        const account = body.get("form1:loanAccountCombo") ?? "";
        const submit = body.has("form1:doValidate");
        const page = submit ? "1" : body.get("resultGrid:dataGridCurrentPage") ?? "";
        // The query names its period; a next-page postback only names the page.
        posted.push({
          account,
          page,
          submit,
          ...(submit
            ? {
                period: body.get("form1:queryPeriod") ?? "",
                range: `${body.get("form1:startDate")}~${body.get("form1:endDate")}`,
              }
            : {}),
        });
        if (account === options.holdAccount) {
          options.onHeld?.();
          return;
        }
        if (account === options.brokenAccount) {
          return await route.fulfill({ contentType: "text/html", body: Buffer.from([0x3c, 0x70, 0x3e, 0xc3, 0x28]) });
        }
        return await route.fulfill(html(loanQueryForm(account, loanResultFor(account, page))));
      }
      switch (pathname) {
        case "/B2C/common/Index.faces":
          return await route.fulfill(html(`<iframe name="frame1" src="/B2C/header.faces"></iframe><iframe name="txnFrame" src="/B2C/home.faces"></iframe>`));
        case "/B2C/header.faces":
          return await route.fulfill(html(shellLoanHeader));
        case LOAN_QUERY_PATH:
          return await route.fulfill(html(loanQueryForm("", "")));
        default:
          return await route.fulfill(html(`<p>${pathname}</p>`));
      }
    });
    await shellPage.goto(FUBON_EBANK_ENTRY_URL, { waitUntil: "load" });
    const credentials = { fubon_user_id: "synthetic-user-id", fubon_account: "synthetic-user" };
    const summary = await runFubonLoanStatements(
      shellPage,
      {
        ...fubonLoanStatementsInputSchema.parse({
          dateRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
        }),
        sourceConnectionScope: fubonStableLoginScope(credentials)!,
        sourceConnectionKey: deriveFubonSourceConnectionKey(credentials)!,
      },
      {
        signal: options.signal ?? new AbortController().signal,
        text: strictSourceText,
        now: () => "2026-02-01T00:00:00.000Z",
      } as unknown as Parameters<typeof runFubonLoanStatements>[2],
      {
        stage: (...items: readonly ProductStageRequest[]) => { staged.push(...items); },
        reportActivity: async (activity: string) => { activities.push(activity); },
        event: async () => {},
      } as unknown as Parameters<typeof runFubonLoanStatements>[3],
    );
    const menuOpens = await shellPage.evaluate(() => (window as unknown as { menuOpens?: number }).menuOpens);
    return { summary, posted, requested, staged, activities, menuOpens };
  } finally {
    await browser.close();
  }
}

test("Fubon loan reads every account through the bank's own task link and pages to the terminal result", async () => {
  const read = await readLoanThroughShell();
  assert.equal(read.menuOpens, 1, "the task link is revealed through the 貸款服務 menu");
  assert.ok(!read.requested.includes(LOAN_DIRECT_PATH), "the task link's href is never navigated to directly");
  assert.deepEqual(
    read.posted,
    [
      { account: shellLoanAccounts[0]!.value, page: "1", submit: true, period: "custom", range: "2026/01/01~2026/01/31" },
      { account: shellLoanAccounts[0]!.value, page: "2", submit: false },
      { account: shellLoanAccounts[1]!.value, page: "1", submit: true, period: "custom", range: "2026/01/01~2026/01/31" },
    ],
    "each account is queried in order, and a next page is posted from the replaced document",
  );
  assert.deepEqual(read.summary, { sourceCaptureCount: 2, rowCount: 3 });
  assert.deepEqual(read.activities, ["query", "query", "query"]);
  assert.deepEqual(
    read.staged.map((item) => {
      const capture = (item.command.request as { capture: { scope: { pageCount: number }; records: unknown[] } }).capture;
      return [item.product, capture.scope.pageCount, capture.records.length];
    }),
    [["loan", 2, 2], ["loan", 1, 1]],
  );
});

test("Fubon loan fails a reply with malformed bytes as a source integrity failure", async () => {
  await assert.rejects(
    readLoanThroughShell({ brokenAccount: shellLoanAccounts[1]!.value }),
    SourceTextIntegrityError,
  );
});

test("Fubon loan stops inside a held query postback when the run is cancelled", async () => {
  const controller = new AbortController();
  await assert.rejects(
    readLoanThroughShell({
      signal: controller.signal,
      holdAccount: shellLoanAccounts[1]!.value,
      onHeld: () => controller.abort(new Error("loan query cancelled")),
    }),
    /loan query cancelled/u,
  );
});
