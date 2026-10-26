import { RUN_EVENT_SIGNALS } from "./run-event.ts";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../../ledger/pglite/workflow-run.ts";
import type { WorkflowContext, WorkflowContextWith } from "./workflow-executor.ts";
import type {
  ProductCollectionHandle,
  ProductCollectionInterruptedError,
  ProductStageRequest,
} from "./product-collection.ts";
import type { runYuantaAllStatementsWorkflow as runYuantaAllStatementsWorkflowType } from "../../workflows/yuanta-all-statements.ts";
import { strictSourceText } from "./source-text.ts";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-yuanta-workflow-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const loaded = await server
  .ssrLoadModule("/src/workflows/yuanta-all-statements.ts")
  .finally(() => server.close());
const runYuantaAllStatementsWorkflow = loaded.runYuantaAllStatementsWorkflow as typeof runYuantaAllStatementsWorkflowType;

function item(product: string, value = "complete"): ProductStageRequest {
  return {
    product,
    itemKey: `${product}-capture-1`,
    command: {
      kind: "financial.deposit.commit",
      request: { value },
    } as unknown as ProductStageRequest["command"],
  };
}

/** A page already signed in to Yuanta Bank, as the shared signed-in probe reads it. */
function signedInPage(): Page {
  const frame = (name: string) => ({
    name: () => name,
    url: () => "https://ebank.yuantabank.com.tw/nib/tx/home",
    locator: () => ({ count: async () => 1 }),
  });
  const frames = [frame("fmenu"), frame("fmain")];
  return {
    url: () => "https://ebank.yuantabank.com.tw/nib/tx/home",
    frames: () => frames,
    frame: ({ name }: { name: string }) => frames.find((candidate) => candidate.name() === name) ?? null,
  } as unknown as Page;
}

function context(
  signal: AbortSignal,
  calls: string[],
  commitBatches: PGliteWorkflowRunItem[][] = [],
): WorkflowContextWith<"financialCommit"> {
  return {
    runId: "yuanta-test-run",
    signal,
    now: () => "2026-09-25T00:00:00.000Z",
    browser: {
      withPage: async <T>(run: (page: Page) => Promise<T>) => run(signedInPage()),
    },
    text: strictSourceText,
    verification: {
      complete: async (stage) => {
        calls.push(`human:${stage.stageId}`);
      },
    },
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
    event: async (stage, _outcome, code) => { calls.push(`event:${stage}:${code}`); },
    signalEvent: async (signal) => { calls.push(`event:${RUN_EVENT_SIGNALS[signal].stage}:${signal}`); },
  };
}

const input = {
  managedIdentitySecret: "synthetic-yuanta-managed-secret",
  statementTypes: ["deposit", "foreign_currency", "credit_card", "loan", "fund"] as const,
  credentials: {
    yuanta_user_id: "synthetic-id",
    yuanta_account: "synthetic-account",
    yuanta_password: "synthetic-password",
  },
};

function collector(label: string, calls: string[]) {
  return async (_page: Page, _input: unknown, _context: WorkflowContext, product: ProductCollectionHandle) => {
    calls.push(`${label}-collected`);
    product.stage(item(label));
    return { sourceCaptureCount: 1, rowCount: 2 };
  };
}

const products = ["deposit", "foreign-currency-deposit", "credit-card", "loan", "investment"];
const productTypes = ["deposit", "foreign_currency", "credit_card", "loan", "fund"];

function collectors(calls: string[]) {
  return {
    collectDeposit: collector(products[0]!, calls),
    collectForeignCurrency: collector(products[1]!, calls),
    collectCreditCard: collector(products[2]!, calls),
    collectLoan: collector(products[3]!, calls),
    collectFund: collector(products[4]!, calls),
    signOut: async () => { calls.push("signed-out"); },
  };
}

const temp = await mkdtemp(join(tmpdir(), "yuanta-typed-workflow-"));
const originalCwd = process.cwd();
process.chdir(temp);
try {
  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const result = await runYuantaAllStatementsWorkflow(
      context(controller.signal, calls, batches),
      input,
      collectors(calls),
    );
    assert.deepEqual(result, {
      counts: {
        sourceCaptureCount: 5,
        rowCount: 10,
        itemCount: 5,
        committedCount: 5,
        skippedProductCount: 0,
      },
      products: productTypes.map((typeId) => ({ typeId, status: "success", itemCount: 1, committedCount: 1 })),
      status: "financial-admitted",
    });
    assert.equal(batches.length, 5, "Yuanta commits each selected product independently");
    assert.deepEqual(
      batches.map((batch) => batch.map(({ product, itemKey }) => [product, itemKey])),
      products.map((product) => [[product, `${product}-capture-1`]]),
      "each commit contains only its product's completed evidence",
    );
    assert.ok(
      batches.flat().every((entry) => entry.provider === "yuanta"),
      "every product, fund included, commits under the yuanta provider",
    );
    assert.deepEqual(
      calls.filter((call) => call.startsWith("event:authentication:")),
      ["event:authentication:authentication-started", "event:authentication:authentication-completed"],
    );
    assert.ok(calls.includes("event:validation:source-validation-completed"));
    assert.ok(calls.indexOf("investment-collected") < calls.lastIndexOf("commit"));
  }

  {
    const calls: string[] = [];
    const inputs: Record<string, Record<string, unknown>> = {};
    const capture = (label: string) =>
      async (_page: Page, productInput: unknown, _context: WorkflowContext, product: ProductCollectionHandle) => {
        inputs[label] = productInput as Record<string, unknown>;
        product.stage(item(label));
        return { sourceCaptureCount: 1, rowCount: 1 };
      };
    await runYuantaAllStatementsWorkflow(context(new AbortController().signal, calls), input, {
      ...collectors(calls),
      collectDeposit: capture("deposit"),
      collectForeignCurrency: capture("foreign-currency-deposit"),
      collectCreditCard: capture("credit-card"),
      collectLoan: capture("loan"),
      collectFund: capture("investment"),
    });
    const deposit = inputs.deposit!;
    assert.equal(deposit.dateRange, "three_months", "an omitted component input still gets its schema defaults");
    assert.equal(typeof deposit.sourceConnectionKey, "string");
    assert.deepEqual(
      [inputs.loan!.sourceConnectionScope, inputs.loan!.sourceConnectionKey],
      [deposit.sourceConnectionScope, deposit.sourceConnectionKey],
      "deposit and loan share one Source Connection identity",
    );
    const card = inputs["credit-card"]!;
    assert.equal(card.instrumentFingerprintSecret, input.managedIdentitySecret);
    assert.equal(
      (card.canonicalHumanAttestation as { sourceConnectionKey: string }).sourceConnectionKey,
      deposit.sourceConnectionKey,
    );
    assert.equal(inputs["foreign-currency-deposit"]!.yuantaUserId, input.credentials.yuanta_user_id);
    assert.deepEqual(
      [inputs.investment!.yuantaUserId, inputs.investment!.yuantaAccount],
      [input.credentials.yuanta_user_id, input.credentials.yuanta_account],
    );
    assert.ok(
      Object.values(inputs).every((productInput) => !("credentials" in productInput)),
      "no product receives the login password",
    );
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const result = await runYuantaAllStatementsWorkflow(
        context(controller.signal, calls, batches),
        input,
        {
          ...collectors(calls),
          collectDeposit: async (_page, _input, _context, product) => {
            calls.push("deposit-collected");
            product.stage(item("deposit"));
            return { sourceCaptureCount: 1, rowCount: 1 };
          },
          collectForeignCurrency: async () => {
            calls.push("foreign-currency-failed-after-deposit");
            throw new Error("foreign-currency export is incomplete");
          },
        },
      );
    assert.ok(calls.indexOf("deposit-collected") < calls.indexOf("foreign-currency-failed-after-deposit"));
    assert.equal(batches.length, 4, "a product error does not block later complete products");
    assert.deepEqual(result.products!.map(({ typeId, status }) => [typeId, status]), [
      ["deposit", "success"], ["foreign_currency", "failed"], ["credit_card", "success"],
      ["loan", "success"], ["fund", "success"],
    ]);
    assert.equal(result.status, "partial");
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const result = await runYuantaAllStatementsWorkflow(context(controller.signal, calls, batches), input, {
        ...collectors(calls),
        collectDeposit: async (_page, _input, _context, product) => {
          product.stage(item("deposit", "bad\uFFFDsource"));
          return { sourceCaptureCount: 1, rowCount: 1 };
        },
      });
    assert.equal(batches.length, 4, "a malformed product staging group does not leak or block other products");
    const deposit = result.products!.find((product) => product.typeId === "deposit");
    assert.deepEqual([deposit?.status, deposit?.errorCode], ["failed", "source-integrity-failed"]);
    assert.equal(result.status, "partial");
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const workflowContext = context(controller.signal, calls, batches);
    await assert.rejects(
      runYuantaAllStatementsWorkflow(workflowContext, input, {
        ...collectors(calls),
        collectDeposit: async (_page, _input, _context, product) => {
          product.stage(item("deposit"));
          return { sourceCaptureCount: 1, rowCount: 1 };
        },
        collectForeignCurrency: async () => {
          controller.abort(new Error("cancelled"));
          return { sourceCaptureCount: 1, rowCount: 1 };
        },
      }),
      (error: unknown) => {
        const summary = (error as { summary?: { products?: readonly { typeId: string; status: string; committedCount: number }[] } }).summary;
        assert.deepEqual(summary?.products?.map(({ typeId, status, committedCount }) => [typeId, status, committedCount]), [
          ["deposit", "success", 1],
          ["foreign_currency", "failed", 0],
          ["credit_card", "skipped", 0],
          ["loan", "skipped", 0],
          ["fund", "skipped", 0],
        ]);
        return true;
      },
    );
    assert.equal(batches.length, 1, "receipts for a completed product are retained before cancellation");
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    const result = await runYuantaAllStatementsWorkflow(
      context(controller.signal, calls, batches),
      { ...input, statementTypes: ["fund"] },
      {
        ...collectors(calls),
        collectDeposit: async () => { calls.push("deposit-called"); throw new Error("unselected"); },
        collectForeignCurrency: async () => { calls.push("foreign-called"); throw new Error("unselected"); },
        collectCreditCard: async () => { calls.push("card-called"); throw new Error("unselected"); },
        collectLoan: async () => { calls.push("loan-called"); throw new Error("unselected"); },
        collectFund: async (_page, _input, _context, product) => {
          calls.push("fund-called");
          product.stage(item("investment"));
          return { sourceCaptureCount: 1, rowCount: 2 };
        },
      },
    );
    assert.deepEqual(calls.filter((call) => call.endsWith("-called")), ["fund-called"]);
    assert.deepEqual(result.products!.map(({ typeId, status, skipReason }) => [typeId, status, skipReason]), [
      ["deposit", "skipped", "not_selected"],
      ["foreign_currency", "skipped", "not_selected"],
      ["credit_card", "skipped", "not_selected"],
      ["loan", "skipped", "not_selected"],
      ["fund", "success", undefined],
    ]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.[0]?.product, "investment");
  }

  {
    const calls: string[] = [];
    const batches: PGliteWorkflowRunItem[][] = [];
    const controller = new AbortController();
    await assert.rejects(
      runYuantaAllStatementsWorkflow(
        context(controller.signal, calls, batches),
        { ...input, statementTypes: ["fund"] },
        {
          ...collectors(calls),
          collectFund: async () => { throw new Error("fund export is incomplete"); },
        },
      ),
      (error: unknown) => {
        // The workflow is SSR-loaded, so its error class is not this module's.
        const interrupted = error as ProductCollectionInterruptedError;
        assert.equal(interrupted.name, "ProductCollectionInterruptedError");
        assert.equal(interrupted.errorCode, "source-collection-failed");
        assert.equal(interrupted.summary.status, "failed");
        assert.equal(interrupted.summary.committedCount, 0);
        assert.equal(interrupted.summary.products.find((product) => product.typeId === "fund")?.status, "failed");
        return true;
      },
    );
    assert.equal(batches.length, 0, "a run with no durable product commits nothing");
  }

  assert.deepEqual(await readdir(temp), [], "typed Yuanta workflow must not write downloads or logs");
} finally {
  process.chdir(originalCwd);
  await rm(temp, { recursive: true, force: true });
}
