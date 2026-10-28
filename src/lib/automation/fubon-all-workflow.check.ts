import { RUN_EVENT_SIGNALS } from "./run-event.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../../ledger/pglite/workflow-run.ts";
import type { WorkflowContextWith } from "./workflow-executor.ts";
import type { ProductCollectionInterruptedError, ProductStageRequest } from "./product-collection.ts";
import type { runFubonAllStatementsWorkflow as runFubonAllStatementsWorkflowType } from "../../workflows/fubon-all-statements.ts";
import { strictSourceText } from "./source-text.ts";
import type { withBoundProducts as withBoundProductsType } from "./product-collection.fixtures.ts";
import type { VerifiedSource } from "./server/sources/verified-source.ts";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-fubon-workflow-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
// The bound Product collection run loads in the workflow's own module graph, as the executor's does.
const [loaded, fixtures, sources] = await Promise.all([
  server.ssrLoadModule("/src/workflows/fubon-all-statements.ts"),
  server.ssrLoadModule("/src/lib/automation/product-collection.fixtures.ts"),
  server.ssrLoadModule("/src/lib/automation/server/sources/fubon.ts"),
]).finally(() => server.close());
const runFubonAllStatementsWorkflowUnbound = loaded.runFubonAllStatementsWorkflow as typeof runFubonAllStatementsWorkflowType;
const withBoundProducts = fixtures.withBoundProducts as typeof withBoundProductsType;
const FUBON_SOURCE = sources.FUBON_SOURCE as VerifiedSource;

/** Runs Fubon as the executor does: the Product collection run bound to FUBON_SOURCE and this input. */
function runFubonAllStatementsWorkflow(
  context: WorkflowContextWith<"financialCommit" | "accountIdentity">,
  input: unknown,
  overrides?: Parameters<typeof runFubonAllStatementsWorkflowType>[2],
) {
  return runFubonAllStatementsWorkflowUnbound(withBoundProducts(context, FUBON_SOURCE, input), input, overrides);
}

const [depositSource, cardSource, loanSource] = await Promise.all([
  readFile(new URL("../../workflows/fubon-statements.ts", import.meta.url), "utf8"),
  readFile(new URL("../../workflows/fubon-credit-card-statements.ts", import.meta.url), "utf8"),
  readFile(new URL("../../workflows/fubon-loan-statements.ts", import.meta.url), "utf8"),
]);
for (const [name, source] of [
  ["deposit", depositSource],
  ["card", cardSource],
  ["loan", loanSource],
] as const) {
  assert.doesNotMatch(source, /from ["']node:fs|writeFile\(|mkdir\(/u, `${name} provider must not write source or output files`);
  assert.doesNotMatch(source, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/u, `${name} provider must not commit outside the App port`);
}

const temp = await mkdtemp(join(tmpdir(), "fubon-typed-workflow-"));
const originalCwd = process.cwd();
process.chdir(temp);

function item(product: string, value = "complete"): ProductStageRequest {
  return {
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
    verification: {
      complete: async (stage) => {
        calls.push(`human:${stage.stageId}`);
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
        await receivedContext.verification.complete({ stageId: "fubon-login-captcha" } as never);
        calls.push("authenticated");
        return { usedExistingSession: false };
      },
      startSessionKeepAlive: () => () => { calls.push("keepalive-stopped"); },
      signOut: async () => { calls.push("signed-out"); },
      collectDeposit: async (_page, _input, _context, product) => {
        calls.push("deposit-collected");
        product.stage(item("deposit"));
        return { sourceCaptureCount: 1, rowCount: 2 };
      },
      collectCreditCard: async (_page, _input, _context, product) => {
        calls.push("card-collected");
        product.stage(item("credit-card"));
        return { sourceCaptureCount: 1, rowCount: 3 };
      },
      collectLoan: async (_page, _input, _context, product) => {
        calls.push("loan-collected");
        product.stage(item("loan"));
        return { sourceCaptureCount: 1, rowCount: 4 };
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
    assert.deepEqual(await readdir(temp), [], "typed provider path must not write source or log files");
  }

  {
    const calls: string[] = [];
    const commitBatches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, strictSourceText, commitBatches);
    const result = await runFubonAllStatementsWorkflow(workflowContext, input, {
        authenticate: async () => ({ usedExistingSession: false }),
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, product) => {
          calls.push("deposit-collected");
          product.stage(item("deposit"));
          return { sourceCaptureCount: 1, rowCount: 2 };
        },
        collectCreditCard: async () => {
          calls.push("card-failed-after-deposit");
          throw new Error("Fubon credit-card source failed completeness admission.");
        },
        collectLoan: async () => ({ sourceCaptureCount: 1, rowCount: 0, noDataEvidence: true }),
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
        authenticate: async () => ({ usedExistingSession: false }),
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, product) => {
          product.stage(item("deposit", "bad\uFFFDsource"));
          return { sourceCaptureCount: 1, rowCount: 1 };
        },
        collectCreditCard: async () => ({ sourceCaptureCount: 0, rowCount: 0 }),
        collectLoan: async () => ({ sourceCaptureCount: 0, rowCount: 0 }),
      }),
      (error: unknown) => {
        // The workflow is SSR-loaded, so its error class is not this module's.
        const interrupted = error as ProductCollectionInterruptedError;
        assert.equal(interrupted.name, "ProductCollectionInterruptedError");
        assert.equal(interrupted.errorCode, "source-integrity-failed");
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
        authenticate: async () => ({ usedExistingSession: false }),
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, product) => {
          product.stage(item("deposit"));
          throw new Error("Fubon source lacks terminal pagination evidence.");
        },
        collectCreditCard: async () => ({ sourceCaptureCount: 0, rowCount: 0 }),
        collectLoan: async () => ({ sourceCaptureCount: 0, rowCount: 0 }),
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
        authenticate: async () => ({ usedExistingSession: false }),
        startSessionKeepAlive: () => () => undefined,
        signOut: async () => undefined,
        collectDeposit: async (_page, _input, _context, product) => {
          product.stage(item("deposit"));
          return { sourceCaptureCount: 1, rowCount: 1 };
        },
        collectCreditCard: async () => {
          controller.abort(new Error("cancelled"));
          return { sourceCaptureCount: 1, rowCount: 1 };
        },
        collectLoan: async () => ({ sourceCaptureCount: 0, rowCount: 0 }),
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
      authenticate: async () => ({ usedExistingSession: false }),
      startSessionKeepAlive: () => () => undefined,
      signOut: async () => undefined,
      collectDeposit: async () => { calls.push("deposit-called"); throw new Error("unselected"); },
      collectCreditCard: async () => {
        calls.push("card-called");
        return { sourceCaptureCount: 1, rowCount: 0, noDataEvidence: true };
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
