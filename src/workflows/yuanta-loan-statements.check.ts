import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import {
  assertYuantaLoanCaptureAccountNumberEvidence,
  buildYuantaLoanCapture,
} from "../ledger/canonical/yuanta-loan-admission.ts";
import {
  YUANTA_LOAN_PAGINATION_FIXTURES_V1,
  YUANTA_LOAN_PAGINATION_FIXTURES_V2,
} from "./yuanta-loan-statements.fixtures.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { fixedPeriod, yuantaCollectionContext, yuantaStagingHandle } from "./yuanta-collection.fixtures.ts";
import { collectionPeriod, taipeiToday } from "../lib/automation/collection-period.ts";
import { YUANTA_SOURCE } from "../lib/automation/server/sources/yuanta.ts";
import { chromium } from "playwright";
import { YUANTA_EBANK_ORIGIN, yuantaEbankSite } from "./yuanta-ebank-site.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./yuanta-statements.js") {
      return nextResolve("./yuanta-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  readYuantaLoanAccountOptions,
  readYuantaLoanSource,
  yuantaLoanStatementsInputSchema,
  yuantaLoanQueryRange,
  parseYuantaLoanStatementRows,
  runYuantaLoanStatements,
  stageYuantaLoan,
  deriveYuantaLoanAccountNumberEvidence,
  yuantaLoanSelectorAccountEvidence,
} =
  await import("./yuanta-loan-statements.ts");

assert.deepEqual(
  yuantaLoanSelectorAccountEvidence({
    value: "12345678901234",
    label: "秀朗 - 信貸中放 - 12345678901234",
  }),
  {
    rowOrdinal: 0,
    accountValue: "12345678901234",
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "loan_contract",
    evidenceKind: "repayment-mandate",
    sourceField: "貸款帳號",
    contractVersion: "yuanta/loan-statement-selector-account/v1",
  },
);
assert.deepEqual(
  deriveYuantaLoanAccountNumberEvidence({
    value: "12345678901234",
    label: "秀朗 - 信貸中放 - 12345678901234",
  }),
  {
    value: "12345678901234",
    kind: "loan-account",
    evidenceVersion: "yuanta/loan/account-number-v1",
    sourceField: "#acctno option.value",
  },
);
assert.equal(
  deriveYuantaLoanAccountNumberEvidence({
    value: "12345678901234",
    label: "秀朗 - 信貸中放 - ******1234",
  }),
  null,
);
for (const account of [
  { value: "opaque-query-token", label: "房屋貸款" },
  { value: "12345678901234", label: "房屋貸款 ******1234" },
  { value: "12345678901234", label: "房屋貸款 99999999999999" },
  {
    value: "12345678901234foo",
    label: "房屋貸款 12345678901234",
  },
  {
    value: "12-345678901234",
    label: "房屋貸款 12345678901234",
  },
  {
    value: "12345678901234",
    label: "房屋貸款 123456789012345",
  },
]) {
  assert.throws(
    () => yuantaLoanSelectorAccountEvidence(account),
    /one matching full 14-digit account/u,
  );
}
const { parseYuantaLoanPaginationSignal } = await import(
  "./yuanta-loan-statements.ts"
);

test("Yuanta exported loan run fails closed without caller Source Connection identity", async () => {
  await assert.rejects(
    () =>
      runYuantaLoanStatements(
        {} as Parameters<typeof runYuantaLoanStatements>[0],
        {} as Parameters<typeof runYuantaLoanStatements>[1],
        yuantaCollectionContext(),
        yuantaStagingHandle([]),
      ),
    /stable caller-supplied Source Connection scope and key/u,
  );
});
const { assembleYuantaLoanStatement } = await import(
  "./yuanta-loan-statements.ts"
);
const { StatementComponentAbsentError } =
  await import("../lib/automation/product-collection.ts");

const loanSource = await readFile(
  new URL("./yuanta-loan-statements.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  loanSource,
  /from\s+["']libretto["']|LibrettoWorkflowContext|from\s+["']node:fs\/promises["']|writeFile\(|outputDir|requirePGliteChildRpcClient|executePGliteWorkflowRun|export\s+default\s+workflow/u,
  "the App-owned provider must not retain a separate runner or persistence path",
);
assert.match(loanSource, /sourceText\??\.assertIntact/u);
assert.doesNotMatch(loanSource, /RepaymentRouteInventory/);
assert.match(loanSource, /PGLITE_CANONICAL_LOAN_COMMIT_COMMAND/u);
assert.match(loanSource, /PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND/u);
assert.doesNotMatch(
  loanSource,
  /canonicalLoanCaptureSpines|persistCanonicalLoanCaptureExtensions|commitCanonicalFinancialDepositCaptureBatchInTransaction/u,
  "the workflow must not coordinate internal loan spines or low-level deposit batches",
);

/** A Yuanta eBank site over a fake page whose only scope is the page itself. */
function loanOptionsPage(
  options: Array<{ value: string; label: string }>,
) {
  const optionLocator = {
    first: () => ({
      waitFor: async ({ state }: { state: "attached" }) => {
        assert.equal(state, "attached");
      },
    }),
    count: async () => options.length,
    nth: (index: number) => ({
      getAttribute: async (name: string) =>
        name === "value" ? (options[index]?.value ?? null) : null,
      textContent: async () => options[index]?.label ?? null,
    }),
    filter: () => optionLocator,
  };
  const page = {
    mainFrame: () => null,
    frames: () => [],
    locator: (selector: string) => {
      if (selector === "#acctno") return optionLocator;
      if (selector === "#acctno option") return optionLocator;
      if (selector === "#duration a") return optionLocator;
      throw new Error(`Unexpected selector ${selector}`);
    },
  };
  return yuantaEbankSite(page as never, { signal: new AbortController().signal, text: strictSourceText });
}

await assert.rejects(
  readYuantaLoanAccountOptions(
    loanOptionsPage([{ value: "0", label: "請選擇貸款帳戶" }]),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaLoanAccountOptions(
    loanOptionsPage([
      { value: "0", label: "請選擇貸款帳戶" },
      { value: "loan-1", label: "房屋貸款" },
      { value: "loan-2", label: "信用貸款" },
    ]),
  ),
  [
    { value: "loan-1", label: "房屋貸款" },
    { value: "loan-2", label: "信用貸款" },
  ],
);

test("Yuanta loan typed collection admits complete source without writing or committing", async () => {
  const deferred: PGliteWorkflowRunItem[] = [];
  const testLoanAccount = "1234".repeat(3) + "12";
  const account = { label: `房屋貸款 - ${testLoanAccount}`, value: testLoanAccount };
  const collection = await stageYuantaLoan(
    {
      range: { startDate: "2026-01-01", endDate: "2026-01-31" },
      accounts: [{
        account,
        observedAt: "2026-02-01T00:00:00.000Z",
        statement: {
          rows: [{
            accountLabel: "房屋貸款", transactionDate: "2026/01/15", postingDate: "2026/01/15",
            paymentItem: "LOAN-PAYMENT", interestStartDate: "", interestEndDate: "",
            transactionAmount: "12500.00", balanceAfterTransaction: "87500.00",
            overpayment: "0.00", sortTime: Date.parse("2026-01-15T00:00:00+08:00"),
          }],
          completeness: { pageCount: 1, terminal: true, proofKind: "source-declared-terminal-range" },
          pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 1, proofKind: "source-declared-terminal-range" }],
        },
      }],
    },
    {
      loanAccountFilters: [],
      sourceConnectionScope: "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
      sourceConnectionKey: deriveSourceConnectionIdentityKey(
        "yuanta",
        "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
      ),
    },
    yuantaCollectionContext({ now: "2026-02-01T00:00:00.000Z" }),
    yuantaStagingHandle(deferred),
  );
  assert.deepEqual(collection, { sourceCaptureCount: 1, rowCount: 1 });
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0]?.product, "loan");
});

test("Yuanta loan typed collection rejects an incomplete source before yielding items", async () => {
  const loanAccountNumber = ["1234567", "8901234"].join("");
  const deferred: PGliteWorkflowRunItem[] = [];
  await assert.rejects(
    stageYuantaLoan(
      {
        range: { startDate: "2025-09-25", endDate: "2026-09-25" },
        accounts: [{
          account: { label: `房屋貸款 - ${loanAccountNumber}`, value: loanAccountNumber },
          observedAt: "2026-09-25T00:00:00.000Z",
          statement: {
            rows: [],
            completeness: null,
            pages: [{ pageOrdinal: 0, responseCode: "200", terminal: false, rowCount: 0, proofKind: "source-declared-terminal-range" }],
          },
        }],
      },
      {
        loanAccountFilters: [],
        sourceConnectionScope: "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
        sourceConnectionKey: deriveSourceConnectionIdentityKey(
          "yuanta",
          "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
        ),
      },
      yuantaCollectionContext(),
      yuantaStagingHandle(deferred),
    ),
    /explicit complete terminal page evidence/u,
  );
  assert.deepEqual(deferred, []);
});

test("builds and validates a canonical Yuanta loan capture from source rows", () => {
  const capture = buildYuantaLoanCapture({
    accountValue: "yuanta-option-test",
    accountNumber: {
      value: "12345678901234",
      kind: "loan-account",
      evidenceVersion: "yuanta/loan/account-number-v1",
      sourceField: "#acctno option.value",
    } as const,
    sourceConnectionScope: "yuanta-connection-test",
    observedAt: "2026-02-01T00:00:00.000Z",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v1.yuanta",
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
        postingDate: "2026/01/06",
        paymentItem: "LOAN-DISBURSEMENT",
        transactionAmount: "100000.00",
        balanceAfterTransaction: "100000.00",
      },
    ],
  });

  assertYuantaLoanCaptureAccountNumberEvidence(capture);
  assert.equal(capture.sourceId, "yuanta");
  assert.equal(capture.relationCoverage, "not-asserted");
  assert.equal(capture.records.length, 1);
  assert.match(capture.identity.accountNo, /^sha256:/u);
  assert.deepEqual(capture.identity.accountNumber, {
    value: "12345678901234",
    kind: "loan-account",
    evidenceVersion: "yuanta/loan/account-number-v1",
    sourceField: "#acctno option.value",
  });
});

test("Yuanta complete loan captures preserve duplicate-group slots and reject changed claims on one source anchor", () => {
  const build = (rows: Parameters<typeof buildYuantaLoanCapture>[0]["rows"]) =>
    buildYuantaLoanCapture({
      accountValue: "yuanta-duplicate-group-account",
      sourceConnectionScope: "yuanta-duplicate-group-connection",
      observedAt: "2026-02-01T00:00:00.000Z",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      scope: {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        completeness: "complete-range",
        completenessBasis: "source-declared-terminal-range",
        completenessRuleVersion: "loan/canonical/v1.yuanta",
        pageCount: 1,
        terminal: true,
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: rows.length,
        proofKind: "source-declared-terminal-range",
      }],
      counterpartTransactions: [],
      relations: [],
      relationCoverage: "not-asserted",
      rows,
    });
  const first = {
    transactionDate: "2026/01/05",
    postingDate: "2026/01/06",
    paymentItem: "LOAN-PAYMENT",
    transactionAmount: "1000.00",
    balanceAfterTransaction: "9000.00",
  };
  const duplicateCapture = build([first, first]);
  assert.deepEqual(duplicateCapture.records.map((record) => record.occurrenceIndex), [1, 2]);
  assert.notEqual(duplicateCapture.records[0]?.sourceRecordKey, duplicateCapture.records[1]?.sourceRecordKey);
  assert.deepEqual(duplicateCapture.records.map((record) => record.sourceSequenceIndex), [1, 2]);
  const insertedUnrelatedRow = build([{
    transactionDate: "2026/01/04",
    postingDate: "2026/01/04",
    paymentItem: "LOAN-FEE",
    transactionAmount: "100.00",
    balanceAfterTransaction: "9100.00",
  }, first, first]);
  assert.deepEqual(
    insertedUnrelatedRow.records.slice(1).map((record) => record.sourceRecordKey),
    duplicateCapture.records.map((record) => record.sourceRecordKey),
  );
  assert.throws(
    () => build([first, { ...first, transactionAmount: "1200.00" }]),
    /contradictory transaction claims/u,
  );
});

test("fails closed when a Yuanta result row does not have six source cells", () => {
  assert.throws(
    () =>
      parseYuantaLoanStatementRows("masked-loan", [
        ["2026/01/01", "LOAN-PAYMENT", "", "10", "90"],
      ]),
    /unexpected Yuanta loan result row/i,
  );
});

test("Yuanta pagination derives terminal/page evidence from provider controls", () => {
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.activePage,
    ),
    {
      nextPageTarget: "page:2",
      terminal: false,
      evidence: "next-page",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.activePageWithoutExplicitAriaState,
    ),
    {
      nextPageTarget: "page:2",
      terminal: false,
      evidence: "next-page",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.terminalPage,
    ),
    {
      nextPageTarget: null,
      terminal: true,
      evidence: "terminal-no-next",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V1.ambiguousTable,
    ),
    {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    },
  );
  for (const fixture of [
    YUANTA_LOAN_PAGINATION_FIXTURES_V1.unrelatedPagerOnly,
    YUANTA_LOAN_PAGINATION_FIXTURES_V1.unrelatedPagerOutsideResult,
  ]) {
    assert.deepEqual(parseYuantaLoanPaginationSignal(fixture), {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    });
  }
});

test("Yuanta v2 terminal rule accepts the live six-column result shape only", () => {
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V2.providerResultTerminalWithoutPager,
      1,
    ),
    {
      nextPageTarget: null,
      terminal: true,
      evidence: "terminal-no-next",
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V2.providerResultWithoutRows,
      0,
    ),
    {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    },
  );
  assert.deepEqual(
    parseYuantaLoanPaginationSignal(
      YUANTA_LOAN_PAGINATION_FIXTURES_V2.providerResultWrongHeaderShape,
      1,
    ),
    {
      nextPageTarget: null,
      terminal: false,
      evidence: null,
    },
  );
});

test("Yuanta multi-page traversal preserves page ordinals and terminal evidence", () => {
  const parsed = assembleYuantaLoanStatement([
    {
      rows: [
        {
          accountLabel: "masked-loan",
          transactionDate: "2026/01/05",
          postingDate: "2026/01/06",
          paymentItem: "LOAN-DISBURSEMENT",
          interestStartDate: "",
          interestEndDate: "",
          transactionAmount: "100000.00",
          balanceAfterTransaction: "100000.00",
          overpayment: "",
          sortTime: 1,
        },
      ],
      pageOrdinal: 0,
      pagination: {
        nextPageTarget: "page:2",
        terminal: false,
        evidence: "next-page",
      },
    },
    {
      rows: [
        {
          accountLabel: "masked-loan",
          transactionDate: "2026/01/31",
          postingDate: "2026/02/01",
          paymentItem: "LOAN-PAYMENT",
          interestStartDate: "",
          interestEndDate: "",
          transactionAmount: "12500.00",
          balanceAfterTransaction: "87500.00",
          overpayment: "",
          sortTime: 2,
        },
      ],
      pageOrdinal: 1,
      pagination: {
        nextPageTarget: null,
        terminal: true,
        evidence: "terminal-no-next",
      },
    },
  ]);

  assert.equal(parsed.completeness?.pageCount, 2);
  assert.deepEqual(
    parsed.pages.map((page) => [page.pageOrdinal, page.rowCount, page.terminal]),
    [
      [0, 1, false],
      [1, 1, true],
    ],
  );
  assert.equal(parsed.rows.length, 2);
});

assert.deepEqual(
  await readYuantaLoanAccountOptions(
    loanOptionsPage([
      { value: "loan-1", label: "房屋貸款" },
      { value: "loan-2", label: "信用貸款" },
    ]),
    ["missing"],
  ),
  [
    { value: "loan-1", label: "房屋貸款" },
    { value: "loan-2", label: "信用貸款" },
  ],
);

test("Yuanta loans query the 一年 link for one year and one day ending on the run's Taipei date", () => {
  const declaration = YUANTA_SOURCE.statementSelection!.products.find(({ id }) => id === "loan")!.collectionPeriod!;
  // 16:30Z on Feb 28 is 00:30 on Feb 29 in Taipei; a year back clamps to Feb 28.
  assert.deepEqual(
    yuantaLoanQueryRange(collectionPeriod({ today: taipeiToday("2028-02-28T16:30:00.000Z"), ...declaration })),
    { quickLabel: "一年", startDate: "2027-02-28", endDate: "2028-02-29" },
  );
});

// The read half against a synthetic signed-in frameset (ADR 0066): the site
// opens the loan route in fmain, each account is queried over the custom
// range, and a paged result is followed to its terminal page.
test("Yuanta loan source reads every account through the loantransactiondetails route", async () => {
  const SHELL_CID = "synthetic-loan-cid";
  const loanAccounts = [
    { value: "12345678901234", label: "房屋貸款 - 12345678901234" },
    { value: "12345678901235", label: "信用貸款 - 12345678901235" },
  ];
  const loanInput = {
    ...yuantaLoanStatementsInputSchema.parse({}),
    sourceConnectionScope: "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
    sourceConnectionKey: deriveSourceConnectionIdentityKey(
      "yuanta",
      "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001",
    ),
  };

  const browser = await chromium.launch({ headless: true });
  async function readThroughShell(
    options: Readonly<{ signal?: AbortSignal; holdQuery?: () => void; paymentItem?: string }> = {},
  ) {
    const page = await browser.newPage();
    const served: string[] = [];
    const queried: string[] = [];
    const activities: string[] = [];
    const html = (body: string) => ({ contentType: "text/html; charset=utf-8", body });
    const recordPick = "parent.picked = [...(parent.picked ?? []), this.textContent]; return false;";
    const form = (selected: string, result: string, range = { sdate: "", edate: "" }) => `<form name="jform" method="post" action="/nib/tx/loantransactiondetails">
      <input type="hidden" name="cid" value="${SHELL_CID}">
      <input type="hidden" name="page" value="1">
      <select id="acctno" name="acctno">
        <option value="0">請選擇貸款帳戶</option>
        ${loanAccounts.map((account) => `<option value="${account.value}"${account.value === selected ? " selected" : ""}>${account.label}</option>`).join("")}
      </select>
      <div id="duration">${["三個月", "六個月", "一年", "自訂"].map((label) => `<a href="#" onclick="${recordPick}">${label}</a>`).join("")}</div>
      <input id="sdate" name="sdate" value="${range.sdate}"><input id="edate" name="edate" value="${range.edate}">
      <button id="submitbutton" type="submit">查詢</button>
    </form>
    <script>function goPage(page) { document.jform.page.value = String(page); document.jform.submit(); }</script>${result}`;
    const table = (rows: string[][]) => `<table class="normalTable"><thead><tr><th>交易日期</th><th>繳款項目</th><th>計息期間</th><th>交易金額</th><th>本金餘額</th><th>溢繳款</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    const paymentItem = options.paymentItem ?? "本息攤還";
    const result = (account: string, pageNumber: string) => {
      if (account === loanAccounts[0]!.value && pageNumber === "1") {
        return `<div id="resultdiv"><input name="currentPage" value="1">${table([["2026/01/05 2026/01/05", paymentItem, "2025/12/05 2026/01/04", "12,500", "987,500", "0"]])}
          <div class="pagination"><span>第 1 頁</span><a class="pager" href="javascript:goPage(2)">下一頁</a></div></div>`;
      }
      if (account === loanAccounts[0]!.value) {
        return `<div id="resultdiv"><input name="currentPage" value="2">${table([["2026/01/20 2026/01/20", "部分還本", "", "50,000", "937,500", "0"]])}
          <div class="pagination"><span>第 2 頁</span><a class="pager disabled" aria-disabled="true">下一頁</a></div></div>`;
      }
      return `<div id="resultdiv">${table([["2026/01/10 2026/01/10", "本息攤還", "2025/12/10 2026/01/09", "3,000", "297,000", "0"]])}</div>`;
    };
    try {
      await page.route(`${YUANTA_EBANK_ORIGIN}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        served.push(`${request.method()} ${url.pathname}${url.search}`);
        if (url.pathname === "/nib/shell.jsp") {
          return await route.fulfill(html(`<iframe name="fmenu" src="/nib/menu.jsp"></iframe><iframe name="fmain" src="/nib/tx/home?type=page&cid=${SHELL_CID}"></iframe>`));
        }
        if (url.pathname === "/nib/tx/loantransactiondetails" && request.method() === "POST") {
          const fields = new URLSearchParams(request.postData() ?? "");
          const account = fields.get("acctno") ?? "";
          const pageNumber = fields.get("page") ?? "1";
          queried.push([account, pageNumber, fields.get("sdate"), fields.get("edate")].join(" "));
          if (options.holdQuery) {
            options.holdQuery();
            return;
          }
          return await route.fulfill(html(form(account, result(account, pageNumber), {
            sdate: fields.get("sdate") ?? "",
            edate: fields.get("edate") ?? "",
          })));
        }
        if (url.pathname === "/nib/tx/loantransactiondetails" && url.searchParams.get("cid") === SHELL_CID) {
          return await route.fulfill(html(form("", "")));
        }
        return await route.fulfill(html(`<p>${url.pathname}</p>`));
      });
      await page.goto(`${YUANTA_EBANK_ORIGIN}/nib/shell.jsp?cid=${SHELL_CID}`, { waitUntil: "load" });
      const snapshot = await readYuantaLoanSource(
        page,
        loanInput,
        yuantaCollectionContext({ signal: options.signal, now: "2026-02-01T00:00:00.000Z" }),
        // January matches no quick link, so the query enters its dates under 自訂.
        yuantaStagingHandle([], activities, fixedPeriod("2026-01-01", "2026-01-31")),
      );
      const picked = await page.evaluate(() => (window as { picked?: string[] }).picked ?? []);
      return { snapshot, served, queried, activities, picked };
    } finally {
      await page.close();
    }
  }

  try {
    const shellRead = await readThroughShell();
    assert.ok(
      shellRead.served.includes(`GET /nib/tx/loantransactiondetails?type=page&cid=${SHELL_CID}`),
      "the loan page opens through the loantransactiondetails route with the session's cid",
    );
    assert.deepEqual(
      shellRead.queried,
      [
        `${loanAccounts[0]!.value} 1 2026/01/01 2026/01/31`,
        `${loanAccounts[0]!.value} 2 2026/01/01 2026/01/31`,
        `${loanAccounts[1]!.value} 1 2026/01/01 2026/01/31`,
      ],
      "every account is queried in order over the custom range, and the next page is followed",
    );
    assert.deepEqual(shellRead.picked, ["自訂", "自訂"], "the custom range link is picked for each query");
    assert.deepEqual(shellRead.activities, ["query", "query", "query", "query"]);
    assert.deepEqual(shellRead.snapshot.range, { startDate: "2026-01-01", endDate: "2026-01-31" });
    assert.deepEqual(shellRead.snapshot.accounts.map((read) => read.account), loanAccounts);
    const [paged, single] = shellRead.snapshot.accounts.map((read) => read.statement);
    assert.deepEqual(
      paged!.rows.map((row) => [row.transactionDate, row.paymentItem, row.interestStartDate, row.transactionAmount]),
      [["2026/01/05", "本息攤還", "2025/12/05", "12,500"], ["2026/01/20", "部分還本", "", "50,000"]],
      "the rows of both result pages are read in page order",
    );
    assert.deepEqual(paged!.completeness, { pageCount: 2, terminal: true, proofKind: "source-declared-terminal-range" });
    assert.deepEqual(
      single!.completeness,
      { pageCount: 1, terminal: true, proofKind: "source-declared-terminal-range" },
      "a single six-column result without a pager is the provider's terminal page",
    );
    assert.equal(single!.rows.length, 1);
    assert.equal(single!.rows[0]!.accountLabel, "信用貸款 - **********1235");

    await assert.rejects(
      readThroughShell({ paymentItem: "本息\uFFFD攤還" }),
      SourceTextIntegrityError,
      "a result page with a replacement character fails the read",
    );

    const shellCancellation = new AbortController();
    await assert.rejects(
      readThroughShell({
        signal: shellCancellation.signal,
        holdQuery: () => shellCancellation.abort(new Error("loan read cancelled")),
      }),
      /loan read cancelled/u,
      "a run cancelled mid-query stops inside its wait",
    );
  } finally {
    await browser.close();
  }
});
