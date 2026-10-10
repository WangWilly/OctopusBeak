import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { einvoicePersonalInvoicesWorkflow } from "./einvoice-workflow.ts";
import { strictSourceText } from "./source-text.ts";
import type { WorkflowContext, WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import {
  runEinvoiceProviderWorkflow,
} from "../../workflows/einvoice-personal-invoices.ts";
import type {
  EinvoiceAppSource,
  EinvoiceAppClient,
} from "../../workflows/einvoice-app-transport.ts";
import type { EInvoiceAppSession } from "../../workflows/einvoice-app-protocol.ts";
import { ProviderProtocolOutdatedError } from "./source-access.ts";

const workflowSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "einvoice-personal-invoices.ts"),
  "utf8",
);
assert.doesNotMatch(workflowSource, /from\s+["']libretto["']|export\s+default\s+workflow\s*\(/u);
assert.doesNotMatch(workflowSource, /librettoAuthenticate|\bpause\(|npx libretto|emitAutomationProgress/u);
assert.doesNotMatch(workflowSource, /node:fs|writeFile|appendFile|createWriteStream|process\.env|console\.(?:log|error)|logPath/u);
assert.match(workflowSource, /runEinvoiceProviderWorkflow/u);
assert.match(workflowSource, /financialCommit\.execute/u);

const credentials = {
  einvoice_phone_number: "0900000000",
  einvoice_password: "test-only-secret",
};

const session: EInvoiceAppSession = {
  sid: "s",
  token: "t",
  appid: "a",
  ssme: "s",
  liat: 1,
  carrierCode: "/AB+123",
};

const emptyHeaders = { code: "200", msg: "執行成功", details: [] as const };
const emptyDetail = { code: "200", msg: "執行成功", details: [] as const };

function sourceWith(overrides: Partial<EinvoiceAppClient>): EinvoiceAppSource {
  return {
    async open(_page: Page) {
      return {
        client: {
          login: async () => session,
          queryHeaders: async () => emptyHeaders,
          queryDetail: async () => emptyDetail,
          ...overrides,
        },
        close: async () => {},
      };
    },
  };
}

function makeCommit(commits: unknown[]): WorkflowFinancialCommitPort {
  return {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      commits.push(...received);
      const capture = (received[0]?.command as unknown as { request: { captureId: string; invoices: unknown[] } }).request;
      const value = {
        status: "committed",
        captureId: capture.captureId,
        knowledgeAt: 1,
        sourceRecordIds: [],
        invoiceCount: capture.invoices.length,
        insertedInvoiceCount: capture.invoices.length,
        insertedRevisionCount: capture.invoices.length,
        observedDuplicateCount: 0,
        itemCount: 0,
      };
      return {
        status: "completed",
        items: [{ itemKey: "einvoice-test", provider: "einvoice", product: "personal-invoice", status: "committed", admissionSummaries: [], value, relationWarnings: [] }],
        diagnostics: [],
        committedCount: 1,
        failedCount: 0,
      };
    },
  };
}

function makeContext(overrides: Partial<WorkflowContext> & { commits?: unknown[]; events?: Array<{ stage: string; code: string }> }): {
  context: WorkflowContext;
  commits: unknown[];
  events: Array<{ stage: string; code: string }>;
} {
  const commits = overrides.commits ?? [];
  const events: Array<{ stage: string; code: string }> = overrides.events ?? [];
  const context: WorkflowContext = {
    runId: "einvoice-test-run",
    signal: new AbortController().signal,
    now: () => new Date().toISOString(),
    browser: { withPage: async (run) => await run({} as Page) },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("Unexpected human assistance request"); } },
    financialCommit: makeCommit(commits),
    event: async (stage, code) => {
      events.push({ stage, code });
    },
    ...overrides,
  };
  return { context, commits, events };
}

// A successful empty collection still commits with zero invoices.
{
  const { context, commits, events } = makeContext({});
  const output = await runEinvoiceProviderWorkflow(context, { credentials }, sourceWith({}));
  assert.equal(output.usedExistingSession, false);
  assert.equal(output.invoiceCount, 0);
  assert.ok(events.some((event) => event.code === "authentication-completed"));
  assert.ok(events.some((event) => event.code === "month-completed"));
  assert.ok(events.some((event) => event.code === "canonical-commit-completed"));
  assert.equal(commits.length, 1);
}

// The header query takes YYYY/MM/DD dates; the live server answers dashed
// dates with a top-level 903 參數錯誤.
{
  const ranges: Array<[string, string]> = [];
  const { context } = makeContext({});
  await runEinvoiceProviderWorkflow(context, { credentials }, sourceWith({
    queryHeaders: async (_session, startDate, endDate) => {
      ranges.push([startDate, endDate]);
      return emptyHeaders;
    },
  }));
  assert.ok(ranges.length > 0);
  for (const [startDate, endDate] of ranges) {
    assert.match(startDate, /^\d{4}\/\d{2}\/01$/u);
    assert.match(endDate, /^\d{4}\/\d{2}\/\d{2}$/u);
  }
}

// Paging ends only at an empty page. A server that never returns one (for
// example by ignoring `page`) must fail the run, not loop or commit.
{
  let headerCalls = 0;
  const { context, commits } = makeContext({});
  await assert.rejects(
    runEinvoiceProviderWorkflow(context, { credentials }, sourceWith({
      queryHeaders: async () => {
        headerCalls += 1;
        if (headerCalls > 1000) throw new Error("unbounded paging");
        return { ...emptyHeaders, details: [{ invNum: "AB12345678" }] };
      },
    })),
    ProviderProtocolOutdatedError,
  );
  assert.equal(commits.length, 0);
}

type CommittedCapture = {
  scope: { itemCompleteness: string };
  invoices: Array<{ items: Array<{ completeness: string; unitPrice: unknown }> }>;
};

function committedCapture(commits: unknown[]): CommittedCapture {
  return (commits[0] as { command: { request: CommittedCapture } }).command.request;
}

const issuedHeader = {
  invNum: "AB12345678",
  sellerBan: "12345678",
  sellerName: "測試商店",
  amount: "120",
  invStatus: "開立已確認",
  invoiceTime: "12:30:00",
  invDate: { year: "2026", month: "9", date: "15" },
};

function oneInvoiceSource(
  header: Record<string, unknown>,
  items: ReadonlyArray<Record<string, unknown>>,
): EinvoiceAppSource {
  let served = false;
  return sourceWith({
    queryHeaders: async () => {
      if (served) return emptyHeaders;
      served = true;
      return { ...emptyHeaders, details: [header] };
    },
    queryDetail: async () => ({ ...emptyDetail, details: items }),
  });
}

// An invoice status outside the admitted vocabulary (the void string is not
// yet observed) cannot be guessed and cannot be skipped, so the run fails as
// an outdated protocol mapping and commits nothing.
{
  const { context, commits } = makeContext({});
  await assert.rejects(
    runEinvoiceProviderWorkflow(context, { credentials }, oneInvoiceSource(
      { ...issuedHeader, invStatus: "未觀察過的狀態" },
      [{ rowNum: "1", description: "咖啡", quantity: "1", unitPrice: "120", amount: "120" }],
    )),
    ProviderProtocolOutdatedError,
  );
  assert.equal(commits.length, 0);
}

// An item missing a fact is admitted as incomplete instead of failing the run.
{
  const { context, commits } = makeContext({});
  await runEinvoiceProviderWorkflow(context, { credentials }, oneInvoiceSource(issuedHeader, [
    { rowNum: "1", description: "咖啡", quantity: "1", amount: "120" },
  ]));
  const capture = committedCapture(commits);
  assert.equal(capture.scope.itemCompleteness, "incomplete");
  assert.deepEqual(capture.invoices[0]!.items.map((item) => item.completeness), ["incomplete"]);
}

// An item number that is not a decimal is recorded as missing, not fatal.
{
  const { context, commits } = makeContext({});
  await runEinvoiceProviderWorkflow(context, { credentials }, oneInvoiceSource(issuedHeader, [
    { rowNum: "1", description: "咖啡", quantity: "1", unitPrice: "—", amount: "120" },
  ]));
  const item = committedCapture(commits).invoices[0]!.items[0]!;
  assert.equal(item.completeness, "incomplete");
  assert.equal(item.unitPrice, null);
}

// A login rejection propagates and never reaches commit.
{
  const { context, commits } = makeContext({});
  await assert.rejects(
    runEinvoiceProviderWorkflow(context, { credentials }, sourceWith({
      login: async () => { throw new Error("E-Invoice App login rejected (result -151)."); },
    })),
    /login rejected \(result -151\)/,
  );
  assert.equal(commits.length, 0);
}

// A cancelled run stops before opening the provider page.
{
  const aborted = new AbortController();
  aborted.abort();
  let opened = false;
  const { context } = makeContext({
    signal: aborted.signal,
    browser: { withPage: async () => { opened = true; throw new Error("Page should not be opened"); } },
  });
  await assert.rejects(
    runEinvoiceProviderWorkflow(context, { credentials }, sourceWith({})),
    /AbortError|aborted/,
  );
  assert.equal(opened, false);
}

// The workflow definition still points at the entry point.
assert.equal(einvoicePersonalInvoicesWorkflow.id, "einvoice-personal-invoices");
assert.equal(einvoicePersonalInvoicesWorkflow.requiresFinancialCommit, true);
