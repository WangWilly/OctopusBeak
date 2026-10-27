import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPGliteChildRpcServer, requirePGliteChildRpcClientFromEnv } from "../../../electron/pglite-child-rpc.ts";
import {
  createPGliteFinancialLocalPort,
  createPGliteFinancialRegistry,
} from "../../../electron/pglite-financial-registry.ts";
import { createTestPGlite } from "../../ledger/pglite/baseline-test-template.ts";
import { createPgliteOperationalProvider } from "../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../ledger/pglite/transaction.ts";
import { createWorkflowFinancialCommitPort } from "./workflow-financial-commit.ts";
import type { Page, Response } from "playwright";
import type { WorkflowContext, WorkflowContextWith } from "./workflow-executor.ts";
import { signalRunEvent, type WorkflowRunEvent } from "./run-event.ts";
import { strictSourceText } from "./source-text.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import { assertStoppedRun, STOPPED_COMMITS, stoppedCommitPort } from "./single-product-run.fixtures.ts";
import {
  decodeCtbcSourceJson,
  readCtbcDepositSource,
  runCtbcProviderWorkflow,
  stageCtbcDeposit,
  type CtbcDepositRunner,
  type CtbcReadCurrentDepositBalances,
} from "../../workflows/ctbc-statements.ts";

/** The real deposit runner over the synthetic page, with current balances replaced. */
function withCurrentBalances(readCurrentBalances: CtbcReadCurrentDepositBalances): { collectDeposit: CtbcDepositRunner } {
  return {
    collectDeposit: async (page, input, context, product) =>
      await stageCtbcDeposit(
        await readCtbcDepositSource(page, input, context, product),
        input,
        context,
        product,
        readCurrentBalances,
      ),
  };
}

function currentBalanceRow() {
  return {
    source: "ctbc",
    stream: "domestic-deposit",
    accountNumber: accountId,
    sourceAccountKey: accountId,
    currency: "TWD",
    ledger: { coefficient: "13155", scale: 0, sourceLexeme: "13,155" },
    providerFields: {
      accountId,
      digiSvType: "",
      acctType: "01",
      accountNickName: "",
      openDt: "20200101",
      isRelaC: "N",
    },
    effectiveAt: "2026-09-09T02:09:43.601Z",
    providerServerTime: 1788919783601,
    providerDataTime: "2026/09/09 10:09:43",
    providerHttpDate: "Wed, 09 Sep 2026 02:09:43 GMT",
    observedAt: "2026-09-25T12:00:00.000Z",
    sourceEvidence: {
      endpoint: "/IB/api/adapters/IB_Adapter/resource/ebmwResource",
      requestResource: "/twrbc-deposit/qu001/010",
      status: 200,
      cacheControl: "no-cache, no-store, must-revalidate",
      contractVersion: "ctbc/current-deposit-balance-v1",
    },
  } as const;
}

const accountId = ["0000", "3145", "4055", "4100"].join("");
const bootstrapResource = "/twrbc-deposit/qu002/010";
const detailsResource = "/twrbc-deposit/qu002/011";
const endpoint = "https://www.ctbcbank.com/IB/api/adapters/IB_Adapter/resource/ebmwResource";

function response(resource: string, value: unknown): Response {
  const requestBody = JSON.stringify({ resource });
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    url: () => endpoint,
    status: () => 200,
    request: () => ({
      method: () => "POST",
      url: () => endpoint,
      postData: () => requestBody,
    }),
    body: async () => Buffer.from(bytes),
  } as unknown as Response;
}

function createPage(options: {
  expectedRanges?: number;
  detailResponse?: Response;
  signedIn?: boolean;
  signInAfterProbes?: number;
  precedingEmptyRange?: boolean;
} = {}): Page {
  const ranges = Array.from({ length: options.expectedRanges ?? 1 }, (_, index) => ({
    firstDateYYYYMMDD: `202608${String(index * 31 + 1).padStart(2, "0")}`,
    lastDateYYYYMMDD: `202608${String((index + 1) * 31).padStart(2, "0")}`,
  }));
  if (options.precedingEmptyRange) ranges.unshift({ firstDateYYYYMMDD: "20260701", lastDateYYYYMMDD: "20260731" });
  const responses = [
    response(bootstrapResource, {
      code: "0000",
      rsData: {
        accountInfoList: [{ accountId }],
        dateRanges: ranges,
      },
    }),
    ...(options.precedingEmptyRange ? [response(detailsResource, {
      code: "0000", rsData: { detailList: [], nextKey: "" },
    })] : []),
    options.detailResponse ?? response(detailsResource, {
      code: "0000",
      rsData: {
        detailList: [{
          actDtFull: "2026/08/03",
          trnDtFull: "2026/08/03",
          actDtTm: "2026-08-03-09.08.07.000000",
          sortActDtTm: "2026 08 03 09:08:07 000",
          memo1: "Synthetic salary",
          dbAmtDisplay: "0",
          crAmtDisplay: "1,234",
          balanceAmt: "5,678",
        }],
        nextKey: "",
      },
    }),
  ];
  let signedIn = options.signedIn ?? true;
  let probes = 0;
  const probeSignedIn = () => {
    probes += 1;
    if (options.signInAfterProbes !== undefined && probes >= options.signInAfterProbes) signedIn = true;
    return signedIn;
  };
  const locator = (selector: string) => ({
    first() { return this; },
    last() { return this; },
    nth() { return this; },
    filter() { return this; },
    isVisible: async () => selector.startsWith("form input") || (selector === "#btnHeaderLogout" && probeSignedIn()),
    waitFor: async () => undefined,
    count: async () => selector === "a.nav-link" ? (options.precedingEmptyRange ? 2 : 1) : 0,
    textContent: async () => "2026/08",
    click: async () => undefined,
    fill: async () => undefined,
    boundingBox: async () => ({ x: 1, y: 1, width: 640, height: 480 }),
  });
  return Object.assign({
    on: () => undefined,
    off: () => undefined,
    locator,
    keyboard: { press: async () => undefined },
    goto: async () => undefined,
    waitForURL: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForResponse: async (predicate: (candidate: Response) => boolean) => {
      const index = responses.findIndex(predicate);
      if (index < 0) throw new Error("No synthetic CTBC response matched.");
      return responses.splice(index, 1)[0]!;
    },
    getByText: () => locator("unavailable-prompt"),
    getByRole: () => ({
      click: async () => undefined,
      waitFor: async () => undefined,
    }),
    url: () => "https://www.ctbcbank.com/twrbc/twrbc-deposit/qu002/010",
  }, { setSignedIn(value: boolean) { signedIn = value; } }) as unknown as Page & { setSignedIn(value: boolean): void };
}

function createContext(options: {
  page?: Page;
  signal?: AbortSignal;
  onAssistance?: () => void;
} = {}) {
  const events: WorkflowRunEvent[] = [];
  const committed: unknown[][] = [];
  let browserCalls = 0;
  let assistanceCalls = 0;
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "run-ctbc-check",
    signal: options.signal ?? new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: {
      async withPage(run) {
        browserCalls += 1;
        return run(options.page ?? createPage());
      },
    },
    text: strictSourceText,
    verification: {
      async complete(stage) {
        assistanceCalls += 1;
        assert.equal(stage.stageId, "ctbc-login-verification");
        options.onAssistance?.();
      },
    },
    financialCommit: {
      async execute(items) {
        const materialized: unknown[] = [];
        for await (const item of items) materialized.push(item);
        committed.push(materialized);
        return {
          status: "completed",
          items: materialized.map((item) => ({ ...(item as object), status: "committed" })),
          diagnostics: [],
          committedCount: materialized.length,
          failedCount: 0,
        } as never;
      },
    },
    async event(stage, outcome, code, counts) {
      events.push({
        runId: "run-ctbc-check",
        stage,
        outcome,
        code,
        occurredAt: "2026-09-25T12:00:00.000Z",
        ...counts,
      });
    },
    async signalEvent(signal) {
      events.push(signalRunEvent(signal, { runId: "run-ctbc-check", occurredAt: "2026-09-25T12:00:00.000Z" }));
    },
  };
  return {
    context,
    events,
    committed,
    get browserCalls() { return browserCalls; },
    get assistanceCalls() { return assistanceCalls; },
  };
}

const input = {
  credentials: {
    ctbc_user_id: "synthetic-user",
    ctbc_account: "synthetic-account",
    ctbc_password: "synthetic-password",
  },
};

test("CTBC preserves exact duplicate deposits as stable occurrence-group slots through the real commit port", async () => {
  const database = await createTestPGlite("ledger+operational");
  const store = new PGliteStore(database);
  const operational = createPgliteOperationalProvider(store);
  const server = createPGliteChildRpcServer({ provider: {
    operational, financial: createPGliteFinancialLocalPort(createPGliteFinancialRegistry(store, operational.exchangeRates)),
  } });
  const previous = { ...process.env };
  let child: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  const original = {
    actDtFull: "2026/08/03", trnDtFull: "2026/08/03",
    actDtTm: "2026-08-03-09.08.07.000000", sortActDtTm: "2026 08 03 09:08:07 000",
    memo1: "Synthetic salary", dbAmtDisplay: "0", crAmtDisplay: "1,234", balanceAmt: "5,678",
  };
  try {
    await server.ready;
    Object.assign(process.env, server.env);
    child = requirePGliteChildRpcClientFromEnv();
    await child.ready;
    const commit = createWorkflowFinancialCommitPort(child.workflow);
    const later = {
      ...original, actDtFull: "2026/08/04", trnDtFull: "2026/08/04",
      actDtTm: "2026-08-04-09.08.07.000000", sortActDtTm: "2026 08 04 09:08:07 000",
      memo1: "Synthetic later transfer", crAmtDisplay: "100", balanceAmt: "5,778",
    };
    for (const [index, rows] of [
      [original, original],
      [later, original, original],
      [later, original, original],
    ].entries()) {
      const harness = createContext({ page: createPage({ precedingEmptyRange: index === 2, detailResponse: response(detailsResource, {
        code: "0000", rsData: { detailList: rows, nextKey: "" },
      }) }) });
      const result = await runCtbcProviderWorkflow({ ...harness.context, financialCommit: commit }, input, withCurrentBalances(async () => [currentBalanceRow()]));
      assert.equal(result.status, "financial-admitted");
    }
    const conflicting = createContext({ page: createPage({ detailResponse: response(detailsResource, {
      code: "0000", rsData: { detailList: [{ ...original, memo1: "Changed provider claim" }], nextKey: "" },
    }) }) });
    const conflicted = await runCtbcProviderWorkflow({ ...conflicting.context, financialCommit: commit }, input, withCurrentBalances(async () => [currentBalanceRow()]));
    assert.equal(conflicted.status, "partial");
    assert.deepEqual(conflicted.products, [
      { typeId: "deposit", status: "failed", itemCount: 2, committedCount: 1, errorCode: "canonical-commit-failed" },
    ]);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 3);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM transaction_revisions")).rows[0]?.count, 3);
  } finally {
    for (const key of Object.keys(server.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    child?.close();
    await server.close();
    await store.close();
  }
});

test("CTBC typed workflow collects a complete source in memory and uses the injected commit port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctbc-typed-workflow-"));
  const previousDirectory = process.cwd();
  try {
    process.chdir(directory);
    const harness = createContext();
    const result = await runCtbcProviderWorkflow(harness.context, input, withCurrentBalances(async () => {
      assert.equal(harness.committed.length, 0, "all sources are collected before commit");
      return [currentBalanceRow()];
    }));

    assert.deepEqual(result, {
      status: "financial-admitted",
      counts: { sourceCaptureCount: 1, rowCount: 1, itemCount: 2, committedCount: 2, count: 1 },
      products: [{ typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 }],
    });
    assert.equal(harness.committed.length, 1);
    assert.equal(harness.committed[0]?.length, 2);
    const item = harness.committed[0]?.[0] as { provider?: string; product?: string; command?: { kind?: string } };
    const balanceItem = harness.committed[0]?.[1] as { product?: string };
    assert.equal(item.provider, "ctbc");
    assert.equal(item.product, "domestic-deposit");
    assert.equal(item.command?.kind, "financial.mixed.commit");
    assert.equal(balanceItem.product, "current-balance");
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(
      harness.events.map(({ stage, code }) => [stage, code]),
      [
        ["preparation", "input-validated"],
        ["authentication", "authentication-started"],
        ["authentication", "authentication-completed"],
        ["collection", "deposit-collection-started"],
        ["decoding", "source-decoding-started"],
        ["collection", "account-collected"],
        ["validation", "source-validation-started"],
        ["validation", "canonical-admission-started"],
        ["validation", "canonical-admission-completed"],
        ["collection", "current-balance-collection-started"],
        ["decoding", "current-balance-decoding-started"],
        ["decoding", "current-balance-decoding-completed"],
        ["collection", "current-balance-collection-completed"],
        ["validation", "current-balance-validation-started"],
        ["validation", "current-balance-validation-completed"],
        ["collection", "deposit-collection-completed"],
        ["decoding", "deposit-source-decoding-completed"],
        ["validation", "deposit-source-validation-completed"],
        ["validation", "source-validation-completed"],
      ],
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("CTBC typed workflow rejects malformed and incomplete sources before commit", async () => {
  assert.throws(
    () => decodeCtbcSourceJson(new Uint8Array([0xc3, 0x28]), strictSourceText),
    /Source text integrity failed/u,
  );
  assert.throws(
    () => decodeCtbcSourceJson(new TextEncoder().encode('{"memo":"\\uFFFD"}'), strictSourceText),
    /Source text integrity failed/u,
  );

  const malformed = createContext({
    page: createPage({ detailResponse: {
      ...response(detailsResource, {}),
      body: async () => Buffer.from([0xc3, 0x28]),
    } as Response }),
  });
  await assert.rejects(runCtbcProviderWorkflow(malformed.context, input, withCurrentBalances(async () => [])),
    (error: unknown) => error instanceof ProductCollectionInterruptedError
    && error.errorCode === "source-integrity-failed");
  assert.equal(malformed.committed.length, 0);
  assert.ok(malformed.events.some((event) => event.code === "source-decoding-failed"));

  const incomplete = createContext({ page: createPage({ expectedRanges: 2 }) });
  await assert.rejects(runCtbcProviderWorkflow(incomplete.context, input, withCurrentBalances(async () => [])),
    (error: unknown) => error instanceof ProductCollectionInterruptedError
    && error.errorCode === "source-validation-failed"
    && /source admission blocked/u.test(String((error as { cause?: unknown }).cause)));
  assert.equal(incomplete.committed.length, 0);
  assert.ok(incomplete.events.some((event) => event.code === "source-validation-rejected"));
});

test("CTBC delayed automatic login does not request human assistance and honors cancellation", async () => {
  let signedIn = false;
  const page = createPage({ signedIn, signInAfterProbes: 3 }) as Page & { setSignedIn(value: boolean): void };
  const context = createContext({
    page,
    onAssistance: () => { signedIn = true; page.setSignedIn(true); },
  });
  let runError: unknown;
  await runCtbcProviderWorkflow(context.context, input, {
    collectDeposit: async (_page, parsedInput, productContext, product) => await stageCtbcDeposit(
      { output: { count: 1, rowCount: 0 }, captures: [] },
      parsedInput,
      productContext,
      product,
      async () => assert.fail("an empty source must not read current balances"),
    ),
  }).catch((error: unknown) => { runError = error; });
  assert.ok(runError instanceof Error, "An empty CTBC source must not be admitted.");
  assert.equal(context.assistanceCalls, 0, String(runError));
  assert.equal(context.committed.length, 0);

  const controller = new AbortController();
  controller.abort();
  const cancelled = createContext({ signal: controller.signal });
  await assert.rejects(runCtbcProviderWorkflow(cancelled.context, input));
  assert.equal(cancelled.browserCalls, 0);
  assert.equal(cancelled.committed.length, 0);
});

for (const { stop, errorCode } of STOPPED_COMMITS) {
  test(`CTBC names a ${stop} commit ${errorCode}`, async () => {
    const harness = createContext();
    await assert.rejects(runCtbcProviderWorkflow(
      { ...harness.context, financialCommit: stoppedCommitPort(stop) },
      input,
      withCurrentBalances(async () => [currentBalanceRow()]),
    ), assertStoppedRun("deposit", 2, errorCode));
  });
}
