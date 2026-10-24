import { RUN_EVENT_SIGNALS } from "./run-event.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../../ledger/pglite/workflow-run.ts";
import type { WorkflowContext, WorkflowContextWith } from "./workflow-executor.ts";
import type { ProductCollectionInterruptedError } from "./product-collection.ts";
import type { runFubonAllStatementsWorkflow as runFubonAllStatementsWorkflowType } from "../../workflows/fubon-all-statements.ts";
import { strictSourceText } from "./source-text.ts";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-fubon-workflow-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const loaded = await server
  .ssrLoadModule("/src/workflows/fubon-all-statements.ts")
  .finally(() => server.close());
const runFubonAllStatementsWorkflow = loaded.runFubonAllStatementsWorkflow as typeof runFubonAllStatementsWorkflowType;

const [depositSource, cardSource, loanSource] = await Promise.all([
  readFile(new URL("../../workflows/fubon-statements.ts", import.meta.url), "utf8"),
  readFile(new URL("../../workflows/fubon-credit-card-statements.ts", import.meta.url), "utf8"),
  readFile(new URL("../../workflows/fubon-loan-statements.ts", import.meta.url), "utf8"),
]);
const depositRun = depositSource.slice(depositSource.indexOf("export async function runFubonStatements"));
const cardRun = cardSource.slice(cardSource.indexOf("export async function runFubonCreditCardStatements"));
const loanRun = loanSource.slice(loanSource.indexOf("export async function runFubonLoanStatements"));
for (const [name, source, run] of [
  ["deposit", depositSource, depositRun],
  ["card", cardSource, cardRun],
  ["loan", loanSource, loanRun],
] as const) {
  assert.doesNotMatch(source, /from ["']node:fs|writeFile\(|mkdir\(/u, `${name} provider must not write source or output files`);
  assert.doesNotMatch(source, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/u, `${name} provider must not commit outside the App port`);
  assert.match(run, /deferredCommitItems\.push/u, `${name} provider must return prepared items to the injected App commit`);
}

const temp = await mkdtemp(join(tmpdir(), "fubon-typed-workflow-"));
const originalCwd = process.cwd();
process.chdir(temp);

function item(product: string, value = "complete"): PGliteWorkflowRunItem {
  return {
    provider: "fubon",
    product,
    itemKey: `${product}-1`,
    command: {
      kind: "financial.deposit.commit",
      request: { value },
    } as unknown as PGliteWorkflowRunItem["command"],
  };
}

function context(
  signal: AbortSignal,
  calls: string[],
  text = strictSourceText,
  commitBatches: PGliteWorkflowRunItem[][] = [],
): WorkflowContextWith<"financialCommit" | "accountIdentity"> {
  return {
    runId: "fubon-test-run",
    signal,
    now: () => "2026-09-25T00:00:00.000Z",
    browser: {
      withPage: async <T>(run: (page: Page) => Promise<T>) => run({
        context: () => ({
          clearCookies: async ({ domain }: { domain: RegExp }) => {
            assert.equal(domain.test("ebank.taipeifubon.com.tw"), true);
            assert.equal(domain.test("unrelated.example"), false);
            calls.push("cookies-cleared");
          },
        }),
      } as unknown as Page),
    },
    text,
    humanAssistance: {
      request: async (contract: { stageId?: string }, receivedSignal: AbortSignal) => {
        assert.equal(receivedSignal, signal);
        calls.push(`human:${contract.stageId}`);
        return "verified" as const;
      },
    },
    accountIdentity: { continuity: async () => ({ status: "unseen" }) },
    financialCommit: {
      execute: async (runItems: Iterable<PGliteWorkflowRunItem>) => {
        const collected = [...runItems];
        commitBatches.push(collected);
        calls.push("commit");
        return {
          status: "completed" as const,
          items: collected.map((entry) => ({
            itemKey: entry.itemKey,
            provider: entry.provider,
            product: entry.product,
            status: "committed" as const,
            admissionSummaries: [],
            value: null,
            relationWarnings: [],
          })),
          diagnostics: [],
          committedCount: collected.length,
          failedCount: 0,
        };
      },
    },
    event: async (stage, _outcome, code) => {
      calls.push(`event:${stage}:${code}`);
    },
    signalEvent: async (signal) => {
      calls.push(`event:${RUN_EVENT_SIGNALS[signal].stage}:${signal}`);
    },
  };
}

const input = {
  managedIdentitySecret: "synthetic-fubon-managed-secret",
  statementTypes: ["deposit", "credit_card", "loan"] as const,
  credentials: {
    fubon_user_id: "synthetic-id",
    fubon_account: "synthetic-account",
    fubon_password: "synthetic-password",
  },
};

try {
  {
    const calls: string[] = [];
    const commitBatches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, strictSourceText, commitBatches);
    const result = await runFubonAllStatementsWorkflow(workflowContext, input, {
      authenticate: async (_page, _credentials, receivedContext) => {
        const status = await receivedContext.humanAssistance.request({
          stageId: "fubon-login-captcha",
        } as never, receivedContext.signal);
        assert.equal(status, "verified");
        calls.push("authenticated");
      },
      assertSession: async () => undefined,
      startSessionKeepAlive: () => () => { calls.push("keepalive-stopped"); },
      signOut: async () => { calls.push("signed-out"); },
      collectDeposit: async (_page, _input, _context, _identity, items) => {
        calls.push("deposit-collected");
        items.push(item("deposit"));
        return {
          sourceCount: 1,
          rowCount: 2,
          itemCount: 1,
          financialAdmissionCount: 1,
          currentBalanceExclusions: [
            { reason: "account-number-evidence-missing", unlinkedStatementAccountShapes: ["AAAAAAAAA-AAAAA-A"] },
          ],
          statementExclusions: [
            {
              reason: "account-currency-unproven",
              accountShape: ["999", "9".repeat(16), "AAA", "99"].join("-"),
              reconciliation: "running-balance-mismatch",
            },
            {
              reason: "account-identity-ambiguous",
              accountShape: ["999", "9".repeat(16), "AAA", "99"].join("-"),
              accountCount: 2,
            },
          ],
        };
      },
      collectCreditCard: async (_page, _input, _context, _identity, items) => {
        calls.push("card-collected");
        items.push(item("credit-card"));
        return { sourceCount: 1, rowCount: 3, itemCount: 1, financialAdmissionCount: 1 };
      },
      collectLoan: async (_page, _input, _context, _identity, items) => {
        calls.push("loan-collected");
        items.push(item("loan"));
        return { sourceCount: 1, rowCount: 4, itemCount: 1 };
      },
    });
    assert.deepEqual(result, {
      counts: {
        sourceCaptureCount: 3,
        rowCount: 9,
        itemCount: 3,
        committedCount: 3,
        skippedProductCount: 0,
      },
      products: [
        { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
        { typeId: "credit_card", status: "success", itemCount: 1, committedCount: 1 },
        { typeId: "loan", status: "success", itemCount: 1, committedCount: 1 },
      ],
      status: "financial-admitted",
    });
    assert.ok(calls.indexOf("deposit-collected") < calls.indexOf("commit"));
    assert.ok(calls.indexOf("card-collected") > calls.indexOf("deposit-collected"));
    assert.ok(calls.indexOf("loan-collected") > calls.indexOf("card-collected"));
    assert.equal(commitBatches.length, 3, "each selected product receives its own commit");
    assert.deepEqual(commitBatches.map((batch) => batch.map(({ product, itemKey }) => [product, itemKey])), [
      [["deposit", "deposit-1"]],
      [["credit-card", "credit-card-1"]],
      [["loan", "loan-1"]],
    ]);
    assert.ok(calls.indexOf("commit") < calls.indexOf("signed-out"));
    assert.ok(calls.indexOf("cookies-cleared") >= 0);
    assert.ok(calls.indexOf("cookies-cleared") < calls.indexOf("authenticated"));
    assert.ok(calls.includes("human:fubon-login-captcha"));
    assert.ok(calls.includes("event:authentication:authentication-started"));
    assert.ok(calls.includes("event:authentication:authentication-completed"));
    assert.ok(
      calls.indexOf("event:collection:deposit-current-balance-excluded-account-number-evidence-missing")
        > calls.indexOf("deposit-collected"),
      "an excluded balance row is reported as an operational event",
    );
    assert.ok(
      calls.indexOf("event:collection:deposit-statement-excluded-account-currency-unproven")
        > calls.indexOf("deposit-collected"),
      "a statement account excluded for unproven currency is reported as an operational event",
    );
    assert.ok(
      calls.indexOf("event:collection:deposit-statement-excluded-account-identity-ambiguous")
        > calls.indexOf("deposit-collected"),
      "a statement account excluded for an ambiguous identity is reported as an operational event",
    );
    assert.deepEqual(await readdir(temp), [], "typed provider path must not write source or log files");
  }

  {
    const calls: string[] = [];
    const commitBatches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, strictSourceText, commitBatches);
    const result = await runFubonAllStatementsWorkflow(workflowContext, input, {
        authenticate: async () => undefined,
        assertSession: async () => undefined,
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, _identity, items) => {
          calls.push("deposit-collected");
          items.push(item("deposit"));
          return { sourceCount: 1, rowCount: 2, itemCount: 1, financialAdmissionCount: 1 };
        },
        collectCreditCard: async () => {
          calls.push("card-failed-after-deposit");
          throw new Error("Fubon credit-card source failed completeness admission.");
        },
        collectLoan: async () => ({ sourceCount: 1, rowCount: 0, itemCount: 0, noDataEvidence: true }),
      });
    assert.ok(calls.indexOf("deposit-collected") < calls.indexOf("card-failed-after-deposit"));
    assert.equal(commitBatches.length, 1, "the complete deposit product remains committed");
    assert.deepEqual(result.products!.map((product) => [product.typeId, product.status]), [
      ["deposit", "success"], ["credit_card", "failed"], ["loan", "no_data"],
    ]);
    assert.equal(result.status, "partial");
    assert.equal(result.counts.committedCount, 1);
  }

  {
    const calls: string[] = [];
    const commitBatches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, strictSourceText, commitBatches);
    await assert.rejects(
      runFubonAllStatementsWorkflow(workflowContext, input, {
        authenticate: async () => undefined,
        assertSession: async () => undefined,
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, _identity, items) => {
          items.push(item("deposit", "bad\uFFFDsource"));
          return { sourceCount: 1, rowCount: 1, itemCount: 1, financialAdmissionCount: 0 };
        },
        collectCreditCard: async () => ({ sourceCount: 0, rowCount: 0, itemCount: 0, financialAdmissionCount: 0 }),
        collectLoan: async () => ({ sourceCount: 0, rowCount: 0, itemCount: 0 }),
      }),
      (error: unknown) => {
        // The workflow is SSR-loaded, so its error class is not this module's.
        const interrupted = error as ProductCollectionInterruptedError;
        assert.equal(interrupted.name, "ProductCollectionInterruptedError");
        assert.equal(interrupted.errorCode, "source-collection-failed");
        assert.equal(interrupted.summary.status, "failed");
        assert.equal(interrupted.summary.committedCount, 0);
        assert.equal(interrupted.summary.products.find((product) => product.typeId === "deposit")?.status, "failed");
        return true;
      },
    );
    assert.equal(calls.includes("commit"), false, "malformed product text must fail before its commit");
  }

  {
    const calls: string[] = [];
    const commitBatches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, strictSourceText, commitBatches);
    await assert.rejects(
      runFubonAllStatementsWorkflow(workflowContext, input, {
        authenticate: async () => undefined,
        assertSession: async () => undefined,
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, _identity, items) => {
          items.push(item("deposit"));
          throw new Error("Fubon source lacks terminal pagination evidence.");
        },
        collectCreditCard: async () => ({ sourceCount: 0, rowCount: 0, itemCount: 0, financialAdmissionCount: 0 }),
        collectLoan: async () => ({ sourceCount: 0, rowCount: 0, itemCount: 0 }),
      }),
      (error: unknown) => {
        const interrupted = error as ProductCollectionInterruptedError;
        assert.equal(interrupted.name, "ProductCollectionInterruptedError");
        assert.equal(interrupted.errorCode, "source-collection-failed");
        assert.equal(interrupted.summary.committedCount, 0);
        assert.equal(interrupted.summary.products.find((product) => product.typeId === "deposit")?.status, "failed");
        return true;
      },
    );
    assert.equal(calls.includes("commit"), false, "incomplete selected sources must fail before commit");
    assert.ok(calls.includes("event:validation:deposit-source-validation-rejected"));
  }

  {
    const calls: string[] = [];
    const commitBatches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, strictSourceText, commitBatches);
    await assert.rejects(
      runFubonAllStatementsWorkflow(workflowContext, input, {
        authenticate: async () => undefined,
        assertSession: async () => undefined,
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, _identity, items) => {
          items.push(item("deposit"));
          return { sourceCount: 1, rowCount: 1, itemCount: 1, financialAdmissionCount: 0 };
        },
        collectCreditCard: async () => {
          controller.abort(new Error("cancelled"));
          return { sourceCount: 1, rowCount: 1, itemCount: 0, financialAdmissionCount: 0 };
        },
        collectLoan: async () => ({ sourceCount: 0, rowCount: 0, itemCount: 0 }),
      }),
      (error: unknown) => {
        const summary = (error as { summary?: { products?: readonly { typeId: string; status: string; committedCount: number }[] } }).summary;
        assert.deepEqual(summary?.products?.map(({ typeId, status, committedCount }) => [typeId, status, committedCount]), [
          ["deposit", "success", 1],
          ["credit_card", "failed", 0],
          ["loan", "skipped", 0],
        ]);
        return true;
      },
    );
    assert.equal(commitBatches.length, 1, "an already committed product receipt survives later cancellation");
  }

  {
    const calls: string[] = [];
    const commitBatches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, strictSourceText, commitBatches);
    const result = await runFubonAllStatementsWorkflow(workflowContext, {
      ...input,
      statementTypes: ["credit_card"],
    }, {
      authenticate: async () => undefined,
      assertSession: async () => undefined,
      startSessionKeepAlive: () => () => undefined,
      signOut: async () => undefined,
      collectDeposit: async () => { calls.push("deposit-called"); throw new Error("unselected"); },
      collectCreditCard: async () => {
        calls.push("card-called");
        return { sourceCount: 1, rowCount: 0, itemCount: 0, financialAdmissionCount: 0, noDataEvidence: true };
      },
      collectLoan: async () => { calls.push("loan-called"); throw new Error("unselected"); },
    });
    assert.deepEqual(calls.filter((call) => call.endsWith("-called")), ["card-called"]);
    assert.deepEqual(result.products!.map(({ typeId, status, skipReason }) => [typeId, status, skipReason]), [
      ["deposit", "skipped", "not_selected"],
      ["credit_card", "no_data", undefined],
      ["loan", "skipped", "not_selected"],
    ]);
    assert.equal(result.status, "no-data");
    assert.equal(commitBatches.length, 0);
  }
} finally {
  process.chdir(originalCwd);
  await rm(temp, { recursive: true, force: true });
}
