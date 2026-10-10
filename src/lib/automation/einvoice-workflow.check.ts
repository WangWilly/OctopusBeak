import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { einvoicePersonalInvoicesWorkflow } from "./einvoice-workflow.ts";
import { strictSourceText } from "./source-text.ts";
import type { WorkflowContext, WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import {
  assertEinvoiceCaptureAdmissible,
  buildCanonicalEInvoiceCaptureFromApp,
  runEinvoiceProviderWorkflow,
} from "../../workflows/einvoice-personal-invoices.ts";
import type {
  EinvoiceAppSource,
  EinvoiceAppClient,
} from "../../workflows/einvoice-app-transport.ts";
import type { EInvoiceAppSession } from "../../workflows/einvoice-app-protocol.ts";

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

// The admissible check still rejects an incomplete capture.
{
  const capture = buildCanonicalEInvoiceCaptureFromApp({
    records: [{
      month: { year: 2026, month: 9 },
      listPageIndex: 0,
      entry: { token: "row", invoiceNumber: "AA00000001", invoiceStrStatus: "開立已確認" },
      header: { invoiceDate: "2026-09-10", sellerId: "11112222", totalAmount: "10", invoiceStrStatus: "開立已確認" },
      items: [{ item: "item", quantity: "1", unitPrice: null, amount: "10" }],
      itemCompleteness: "incomplete",
    }],
    pages: [{ month: { year: 2026, month: 9 }, pageIndex: 0, rowCount: 1 }],
    months: ["2026-09"],
  }, credentials, { captureId: "incomplete-capture" });
  assert.throws(() => assertEinvoiceCaptureAdmissible(capture), /source is incomplete/u);
}

// The workflow definition still points at the entry point.
assert.equal(einvoicePersonalInvoicesWorkflow.id, "einvoice-personal-invoices");
assert.equal(einvoicePersonalInvoicesWorkflow.requiresFinancialCommit, true);
