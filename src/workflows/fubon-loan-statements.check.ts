import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { Frame, Locator, Page } from "playwright";
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

const { runFubonLoanStatements } = await import("./fubon-loan-statements.ts");
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
const loginEntry = source.slice(
  source.indexOf("async function openLoanLoginForm"),
  source.indexOf("function loanForm"),
);
assert.match(loginEntry, /openFubonLoginForm\(page\)/);
assert.doesNotMatch(
  loginEntry,
  /#menu_CLN|menu_CLN02|task_CLNQU001|landingFrame\.goto|txnFrame\.goto/,
);
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
      ),
    /stable caller-supplied Source Connection scope and key/u,
  );
});

type FakeLocator = Locator & {
  selector: string;
  locator(selector: string): FakeLocator;
};

type FakeScope = {
  name: string;
  ready: boolean;
  readyOnNavigationClick?: number;
  linkPresent?: boolean;
  onNavigationClick?: () => void;
  navigationEvaluateHangs?: boolean;
  probeHangs?: boolean;
  busy: boolean;
  navigationClicks: number;
  dispatchCalls: number;
  aborts: number;
  probeAborts: number;
  gotoCalls: number;
  goto(): Promise<never>;
  locator(selector: string): FakeLocator;
};

type LoanNavigationOptions = {
  existingScopeTimeoutMs?: number;
  formReadyTimeoutMs?: number;
  retryFormReadyTimeoutMs?: number;
  navigationControlTimeoutMs?: number;
  navigationLinkTimeoutMs?: number;
  silent?: boolean;
};

class TestHTMLElement {
  click(): void {}
}

(globalThis as unknown as { HTMLElement: typeof TestHTMLElement }).HTMLElement =
  TestHTMLElement;

function fakeLocator(scope: FakeScope, selector: string): FakeLocator {
  const locator = {
    selector,
    locator(childSelector: string) {
      return fakeLocator(scope, `${selector} ${childSelector}`);
    },
    first() {
      return this;
    },
    filter() {
      return this;
    },
    count: async () => {
      if (scope.busy || scope.probeHangs) {
        return await new Promise<number>(() => undefined);
      }
      if (selector === "#form1\\:loanAccountCombo") {
        return scope.ready ? 1 : 0;
      }
      if (selector === "form#form1") {
        return scope.ready ? 1 : 0;
      }
      if (selector === "#menu_CLN") return 1;
      if (
        selector === "a.task_CLNQU001.menu_CLN02" ||
        selector === 'a:has-text("貸款交易明細查詢")'
      ) {
        const linkPresent = scope.linkPresent ?? !scope.ready;
        return linkPresent ? 1 : 0;
      }
      return 0;
    },
    async waitFor(options: {
      state: "attached";
      timeout?: number;
      signal?: AbortSignal;
    }) {
      if (scope.busy || scope.probeHangs) {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            scope.probeAborts += 1;
            reject(new Error("probe aborted"));
          };
          if (options.signal?.aborted) {
            abort();
            return;
          }
          options.signal?.addEventListener("abort", abort, { once: true });
        });
      }

      const present =
        (selector === "#form1\\:loanAccountCombo" ||
          selector === "form#form1" ||
          selector === "#form1\\:loanAccountCombo option") &&
        scope.ready;
      const linkPresent =
        selector === "a.task_CLNQU001.menu_CLN02" &&
        (scope.linkPresent ?? !scope.ready);
      if (present || linkPresent || selector === "#menu_CLN") return;

      await new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("probe timed out")),
          options.timeout ?? 0,
        );
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            scope.probeAborts += 1;
            reject(new Error("probe aborted"));
          },
          { once: true },
        );
      });
    },
    async getAttribute(name: string) {
      assert.equal(name, "href");
      return "/loan-statements";
    },
    async evaluate(callback: (element: HTMLElement) => unknown) {
      if (
        selector === "a.task_CLNQU001.menu_CLN02" &&
        scope.navigationEvaluateHangs
      ) {
        scope.busy = true;
        return await new Promise<never>(() => undefined);
      }

      const element = new TestHTMLElement();
      element.click = () => {
        if (selector === "a.task_CLNQU001.menu_CLN02") {
          scope.navigationClicks += 1;
          if (scope.readyOnNavigationClick === scope.navigationClicks) {
            scope.ready = true;
          }
        }
      };
      return callback(element as unknown as HTMLElement);
    },
    async dispatchEvent(
      type: string,
      _eventInit: unknown,
      options: { signal?: AbortSignal; timeout?: number },
    ) {
      assert.equal(type, "click");
      scope.dispatchCalls += 1;
      if (
        selector === "a.task_CLNQU001.menu_CLN02" &&
        scope.navigationEvaluateHangs
      ) {
        scope.busy = true;
        await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              scope.busy = false;
              scope.aborts += 1;
              reject(new Error("dispatch aborted"));
            },
            { once: true },
          );
        });
      }

      if (selector === "a.task_CLNQU001.menu_CLN02") {
        scope.navigationClicks += 1;
        if (scope.readyOnNavigationClick === scope.navigationClicks) {
          scope.ready = true;
        }
        scope.onNavigationClick?.();
      }
    },
  } as unknown as FakeLocator;
  return locator;
}

function fakeScope(name: string): FakeScope {
  const scope: FakeScope = {
    name,
    ready: false,
    readyOnNavigationClick: undefined,
    linkPresent: undefined,
    onNavigationClick: undefined,
    navigationEvaluateHangs: false,
    probeHangs: false,
    busy: false,
    navigationClicks: 0,
    dispatchCalls: 0,
    aborts: 0,
    probeAborts: 0,
    gotoCalls: 0,
    async goto() {
      scope.gotoCalls += 1;
      throw new Error("navigation timed out after 45s following HTTP 302");
    },
    locator(selector) {
      return fakeLocator(scope, selector);
    },
  };
  return scope;
}

function fakePage(scopes: FakeScope[]) {
  const pageScope = fakeScope("page");
  const page = {
    locator(selector: string) {
      const locator = pageScope.locator(selector);
      locator.count = async () => 0;
      locator.waitFor = async () => {
        throw new Error(
          "page scope does not contain a loan navigation control",
        );
      };
      return locator;
    },
    frame({ name }: { name: string }) {
      return scopes.find((scope) => scope.name === name) as unknown as Frame;
    },
    frames() {
      return scopes as unknown as Frame[];
    },
    async waitForTimeout() {},
  } as unknown as Page;
  return page;
}

const fastNavigation: LoanNavigationOptions = {
  existingScopeTimeoutMs: 10,
  formReadyTimeoutMs: 10,
  retryFormReadyTimeoutMs: 10,
  navigationControlTimeoutMs: 10,
  navigationLinkTimeoutMs: 10,
};

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
const navigateToLoanStatementsPage = module.navigateToLoanStatementsPage as (
  page: Page,
  options?: LoanNavigationOptions,
) => Promise<unknown>;
const parseFubonLoanStatementRows = module.parseFubonLoanStatementRows as (
  rows: readonly string[][],
) => string[][];
const parseFubonLoanPaginationSignal =
  module.parseFubonLoanPaginationSignal as (html: string) => unknown;
const writeLoanStatementFiles = module.writeLoanStatementFiles as (
  page: Page,
  html: string,
  account: { label: string; value: string },
  queryItem: "TRANSACTION_DETAIL_QUERY",
  input: {
    loanAccountLabels: string[];
    queryItems: Array<"TRANSACTION_DETAIL_QUERY">;
    quickMonths: "1" | "3" | "6";
    downloadFormat: "EXCEL";
    dateRange: { startDate: string; endDate: string };
  },
  options: { collectOnly: true; sourceText: { assertIntact(value: string): void } },
) => Promise<{ parsed: unknown }>;
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

test("typed Fubon loan source collection returns before CSV/JSON filesystem writes", async () => {
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
    const result = await writeLoanStatementFiles(
      page,
      fixtureHtml,
      {
        label: `${syntheticFubonLoanAccountNumber} (synthetic-loan)`,
        value: "opaque-synthetic-loan-option",
      },
      "TRANSACTION_DETAIL_QUERY",
      {
        loanAccountLabels: [],
        queryItems: ["TRANSACTION_DETAIL_QUERY"],
        quickMonths: "6",
        downloadFormat: "EXCEL",
        dateRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
      },
      { collectOnly: true, sourceText: { assertIntact: (value) => assert.ok(value.length > 0) } },
    );

    assert.deepEqual(await readdir(temp), [], "typed loan execution must not reach CSV/JSON writes");
    assert.equal((result.parsed as { completeness?: { terminal: boolean } }).completeness?.terminal, true);
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

test("uses an already-rendered loan form without navigation or goto", async () => {
  const scope = fakeScope("txnFrame");
  scope.ready = true;
  const page = fakePage([scope]);

  const result = await navigateToLoanStatementsPage(page, fastNavigation);

  assert.equal(result, scope);
  assert.equal(scope.navigationClicks, 0);
  assert.equal(scope.gotoCalls, 0);
});

test("uses the current DOM after a redirect-trigger timeout instead of goto", async () => {
  const legacyNavigation = fakeScope("legacy");
  await assert.rejects(
    legacyNavigation.goto(),
    /navigation timed out after 45s following HTTP 302/,
  );
  assert.equal(legacyNavigation.gotoCalls, 1);

  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.readyOnNavigationClick = 1;
  const page = fakePage([header, landing]);

  const result = await navigateToLoanStatementsPage(page, fastNavigation);

  assert.equal(result, landing);
  assert.equal(landing.gotoCalls, 0);
  assert.equal(landing.navigationClicks, 1);
});

test("allows exactly one controlled retry and preserves the bounded failure", async () => {
  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.readyOnNavigationClick = 2;
  const page = fakePage([header, landing]);

  const result = await navigateToLoanStatementsPage(page, fastNavigation);

  assert.equal(result, landing);
  assert.equal(landing.navigationClicks, 2);

  const absentHeader = fakeScope("frame1");
  const absentLanding = fakeScope("txnFrame");
  const absent = fakePage([absentHeader, absentLanding]);
  await assert.rejects(
    navigateToLoanStatementsPage(absent, fastNavigation),
    new Error("Could not navigate to the loan statement page."),
  );
  assert.equal(absentLanding.navigationClicks, 2);
  assert.equal(absentLanding.gotoCalls, 0);
});

test("fails closed when the loan navigation link is absent", async () => {
  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.linkPresent = false;
  const page = fakePage([header, landing]);

  await assert.rejects(
    navigateToLoanStatementsPage(page, fastNavigation),
    new Error("Could not navigate to the loan statement page."),
  );
  assert.equal(landing.navigationClicks, 0);
});

test("re-resolves the transaction frame after the first navigation replaces it", async () => {
  const header = fakeScope("frame1");
  const previousLanding = fakeScope("txnFrame");
  const replacementLanding = fakeScope("txnFrame");
  replacementLanding.ready = true;
  const scopes = [header, previousLanding];
  const page = fakePage(scopes);
  previousLanding.onNavigationClick = () => {
    scopes.splice(1, 1, replacementLanding);
  };

  const result = await navigateToLoanStatementsPage(page, fastNavigation);

  assert.equal(result, replacementLanding);
  assert.equal(previousLanding.navigationClicks, 1);
  assert.equal(replacementLanding.navigationClicks, 0);
});

test("aborts a stuck navigation action before probing the replaced frame", async () => {
  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.navigationEvaluateHangs = true;
  const page = fakePage([header, landing]);

  const boundedNavigation = Promise.race([
    navigateToLoanStatementsPage(page, {
      existingScopeTimeoutMs: 10,
      formReadyTimeoutMs: 10,
      retryFormReadyTimeoutMs: 10,
      navigationControlTimeoutMs: 5,
      navigationLinkTimeoutMs: 10,
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("navigation exceeded the test deadline")),
        250,
      );
    }),
  ]);

  await assert.rejects(
    boundedNavigation,
    new Error("Could not navigate to the loan statement page."),
  );
  assert.equal(landing.busy, false);
  assert.equal(landing.dispatchCalls, 2);
  assert.equal(landing.aborts, 2);
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

test("bounds a frame probe that never resolves and fails closed", async () => {
  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.probeHangs = true;
  const page = fakePage([header, landing]);

  const boundedNavigation = Promise.race([
    navigateToLoanStatementsPage(page, fastNavigation),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("navigation exceeded the test deadline")),
        250,
      );
    }),
  ]);

  await assert.rejects(
    boundedNavigation,
    new Error("Could not navigate to the loan statement page."),
  );
  assert.ok(landing.probeAborts > 0);
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
      financial: worker.financial.registry,
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
        (await worker.financial.registry.liabilitiesCurrent()).accounts.length,
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

test("emits non-sensitive bounded navigation stage telemetry", async () => {
  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.readyOnNavigationClick = 1;
  const page = fakePage([header, landing]);
  const originalLog = console.log;
  const events: Array<[stage: string, status: string]> = [];
  console.log = ((stage: unknown, payload: unknown) => {
    const status =
      typeof payload === "object" &&
      payload !== null &&
      "status" in payload &&
      typeof payload.status === "string"
        ? payload.status
        : "";
    events.push([String(stage), status]);
  }) as typeof console.log;

  try {
    await navigateToLoanStatementsPage(page, fastNavigation);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(events, [
    ["loan-existing-form-probe", "start"],
    ["loan-existing-form-probe", "timeout"],
    ["loan-menu-trigger", "start"],
    ["loan-menu-trigger", "success"],
    ["loan-link-resolve", "start"],
    ["loan-link-resolve", "success"],
    ["loan-form-ready", "start"],
    ["loan-form-ready", "success"],
  ]);
});

test("emits exactly one ordered link/readiness retry", async () => {
  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.readyOnNavigationClick = 2;
  const page = fakePage([header, landing]);
  const originalLog = console.log;
  const events: Array<[stage: string, status: string]> = [];
  console.log = ((stage: unknown, payload: unknown) => {
    const status =
      typeof payload === "object" &&
      payload !== null &&
      "status" in payload &&
      typeof payload.status === "string"
        ? payload.status
        : "";
    events.push([String(stage), status]);
  }) as typeof console.log;

  try {
    await navigateToLoanStatementsPage(page, fastNavigation);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(events, [
    ["loan-existing-form-probe", "start"],
    ["loan-existing-form-probe", "timeout"],
    ["loan-menu-trigger", "start"],
    ["loan-menu-trigger", "success"],
    ["loan-link-resolve", "start"],
    ["loan-link-resolve", "success"],
    ["loan-form-ready", "start"],
    ["loan-form-ready", "timeout"],
    ["loan-link-resolve", "start"],
    ["loan-link-resolve", "success"],
    ["loan-form-ready", "start"],
    ["loan-form-ready", "success"],
  ]);
});

test("typed collection suppresses raw loan navigation diagnostics", async () => {
  const header = fakeScope("frame1");
  const landing = fakeScope("txnFrame");
  landing.readyOnNavigationClick = 1;
  const page = fakePage([header, landing]);
  const originalLog = console.log;
  const logs: unknown[][] = [];
  console.log = ((...values: unknown[]) => logs.push(values)) as typeof console.log;
  try {
    await navigateToLoanStatementsPage(page, { ...fastNavigation, silent: true });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(logs, []);
});
