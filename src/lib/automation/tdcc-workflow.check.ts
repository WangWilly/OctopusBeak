import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { TDCC_BASE_URL } from "../../workflows/tdcc-epassbook-client.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import { createTdccSecretStore } from "./server/tdcc-secret-store.ts";
import { createTdccSessionHost } from "./server/tdcc-session-host.ts";
import {
  classifyTypedWorkflowFailure,
  summarizeInterruptedProductCollection,
} from "./server/typed-workflow-outcome.ts";
import { createTdccWorkflow } from "./tdcc-workflow.ts";
import { strictSourceText } from "./source-text.ts";
import { createWorkflowExecutor } from "./workflow-executor.ts";
import type { WorkflowRunEvent } from "./run-event.ts";
import { createWorkflowFinancialCommitPort } from "./workflow-financial-commit.ts";
import { runSupervisedAppWorkflow } from "./server/app-workflow-worker-supervisor.ts";
import { inProcessAppWorkflowWorker } from "./server/task-run-check-support.ts";

// Built at runtime so the repository privacy and secret scanners do not read fixtures as real accounts.
const USER_ID = ["Q", "2", "87654321"].join("");
const BROKER_ACCOUNT = ["98", "76543"].join("");
const UNKNOWN_BROKER_ACCOUNT = ["98", "76544"].join("");
const TWD_ACCOUNT = ["2001", "2345678"].join("");
const HIDDEN_ACCOUNT = ["2001", "2345611"].join("");
const NAN_ACCOUNT = ["2001", "2345680"].join("");
const UNKNOWN_BANK_ACCOUNT = ["3001", "2345678"].join("");
const INTENTIONAL_HIDDEN_ACCOUNT = ["4001", "2345681"].join("");
const MIXED_VALID_ACCOUNT = ["5001", "2345682"].join("");
const MIXED_UNKNOWN_ACCOUNT = ["6001", "2345683"].join("");
const NOW = "2026-10-09T02:31:00.000Z";
const SAVED_TOKEN = "saved-session-token";

const codec = {
  encrypt: (text: string) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload: string) => Buffer.from(payload, "base64").toString("utf8"),
};

function holdingItem(): string[] {
  const row = Array.from({ length: 22 }, () => "");
  Object.assign(row, { 0: "2330  ", 1: "台積電", 6: "00", 7: "1000", 17: "585.5", 19: "TWD" });
  return row;
}

function movementRow(): string[] {
  return [
    "01150805", "00012", "2330  ", "台積電", "0", "0", "0", "0", "00", "01150801",
    "113", "買　　進          ", "1000.000000000000000000", "0E-18", "1", "0", "", "", "1", "01150801",
    "TWD", "中", "",
  ];
}

const brokerRow = (brokerNo: string, brokerAccount: string, items: readonly unknown[]) => ({
  brokerAccount, brokerNo, items, accountName: "", accountStatus: "0", isTisa: "N",
});

const settlementRow = (accountNo: string, currency: string, isShow = true) => ({
  accountNo, accountType: "活期存款", availableBalance: "15000", balanceAmt: "15200", currency, isShow, remark: "",
});

const fundRow = (saleOrgCode: string, fundNo: string) => ({
  currAlias: "USD", fundCHName: "測試全球股票基金", fundNo, fundSHR: "120.5", refORIValue: "1500.25", refTWDValue: "48230", saleOrgCode,
});

function settlementSnapshot(infos: readonly unknown[]) {
  return { tspAccountInfos: infos, updateTime: "20261009103000" };
}

function updatedBank(bankId: string, accounts: readonly unknown[], timeAccounts: readonly unknown[] = []) {
  return { bankId, execStatue: "0000", tspAccount: accounts, tspTimeAccounts: timeAccounts };
}

function problematicSettlementSnapshot() {
  return settlementSnapshot([
    updatedBank("999", [settlementRow(UNKNOWN_BANK_ACCOUNT, "TWD")]),
  ]);
}

function mixedSettlementSnapshot() {
  return settlementSnapshot([
    updatedBank("812", [settlementRow(MIXED_VALID_ACCOUNT, "TWD")]),
    updatedBank("999", [settlementRow(MIXED_UNKNOWN_ACCOUNT, "TWD")]),
  ]);
}

type FakeOptions = {
  /** The token TDCC still accepts before any sign-in; null means the saved session has expired. */
  acceptedToken?: string | null;
  trustDevice?: boolean;
  funds?: readonly unknown[];
  /** Endpoint path that answers with a version message instead of data. */
  protocolOutdatedAt?: string;
  /** Endpoint path that answers HTTP 500. */
  httpFailureAt?: string;
  /** Explicit TSP006 response fixture. */
  settlementSnapshot?: Record<string, unknown>;
  /** Cooperative cancellation trigger for a synthetic in-flight endpoint. */
  abortAt?: string;
  abortController?: AbortController;
};

function fakeTdcc(options: FakeOptions = {}) {
  const calls: string[] = [];
  let validToken = options.acceptedToken === undefined ? SAVED_TOKEN : options.acceptedToken;
  let rotation = 0;
  const reply = (body: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    rotation += 1;
    validToken = typeof body.tokenID === "string" ? body.tokenID : `rotated-${rotation}`;
    return Response.json({ responseHeader: { returnCode: "0000", tokenID: validToken, ...header }, responseBody: body });
  };
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.slice(TDCC_BASE_URL.length);
    calls.push(path);
    if (path === options.abortAt) {
      options.abortController?.abort(new Error("synthetic cooperative cancellation"));
      throw new Error("synthetic in-flight request cancellation");
    }
    const request = JSON.parse(String(init.body)) as { requestHeader: { tokenID: string | null }; requestBody: Record<string, unknown> };
    if (path === options.httpFailureAt) return new Response("", { status: 500 });
    if (path === options.protocolOutdatedAt) {
      return Response.json({ responseHeader: { returnCode: "E0001", returnMsg: "請更新 App 版本" }, responseBody: {} });
    }
    switch (path) {
      case "CM001":
        return reply({ tokenID: "initial-token" });
      case "AU001":
        return options.trustDevice === false
          ? Response.json({ responseHeader: { returnCode: "D0005", returnMsg: "new device" }, responseBody: {} })
          : reply({ tokenID: "signed-in-token", richUrl: "https://rich.example/p?sid=1", isDiffDevice: "N" });
      case "AU013":
      case "AU014":
      case "AU015":
        throw new Error(`a sync run must never request or verify a one-time code (${path})`);
    }
    if (request.requestHeader.tokenID !== validToken) {
      return Response.json({ responseHeader: { returnCode: "D0007", returnMsg: "session expired" }, responseBody: {} });
    }
    switch (path) {
      case "TR001":
        return reply({
          accounts: [brokerRow("1020", BROKER_ACCOUNT, [holdingItem()]), brokerRow("ZZZZ", UNKNOWN_BROKER_ACCOUNT, [])],
          lastServerTime: "20261009103000",
        });
      case "TR002":
        return request.requestBody.txnSerNo
          ? reply({}, { returnCode: "D0002", returnMsg: "end" })
          : reply({ brokerNo: "1020", brokerAccount: BROKER_ACCOUNT, items: [movementRow()], lastServerTime: "20261009103000" });
      case "TR051V1":
        return reply({ fundDetails: options.funds ?? [fundRow("004", "ABC123"), fundRow("QQ", "XYZ999")], updateTime: "20261009103000" });
      case "tsp/TSP006":
        return reply(options.settlementSnapshot ?? {
          tspAccountInfos: [
            {
              bankId: "812",
              execStatue: "0000",
              tspAccount: [settlementRow(TWD_ACCOUNT, "TWD"), settlementRow(HIDDEN_ACCOUNT, "TWD", false), settlementRow(NAN_ACCOUNT, "NAN")],
              tspTimeAccounts: [{}],
            },
            { bankId: "999", execStatue: "0000", tspAccount: [settlementRow(UNKNOWN_BANK_ACCOUNT, "TWD")], tspTimeAccounts: [] },
            { bankId: "808", execStatue: "9999", execMsg: "因系統關係，資料並未更新成功，請稍後再點選更新", tspAccount: null, tspTimeAccounts: null },
          ],
          updateTime: "20261009103000",
        });
      case "tsp/TSP007":
        return reply({
          accountNo: request.requestBody.accountNo,
          startDate: "20260710",
          endDate: "20261009",
          isComplete: true,
          totalCount: 1,
          transactionDetails: [{
            balance: "15200.0", currency: "TWD", hcode: "", memo: "", stan: "000000123456", summary: "交割款",
            transferInAccountNo: "", transferInAmount: "15200.0", transferInBankId: "",
            transferOutAccountNo: "", transferOutAmount: "0.0", transferOutBankId: "", txnDateTime: "20260801090000",
          }],
        });
      default:
        throw new Error(`unexpected TDCC path ${path}`);
    }
  };
  return { fetch, calls };
}

type Harness = Readonly<{
  run(input: unknown, fake: ReturnType<typeof fakeTdcc>, options?: Readonly<{
    signal?: AbortSignal;
    onEvent?: (event: WorkflowRunEvent) => void;
    loseCommitReplyFor?: "settlement";
  }>): Promise<Record<string, unknown>>;
  secrets: ReturnType<typeof createTdccSecretStore>;
  pgliteRpc: Readonly<{ endpoint: string; token: string }>;
  count(sql: string): Promise<number>;
  events: WorkflowRunEvent[];
}>;

async function withHarness(body: (harness: Harness) => Promise<void>, registered = true) {
  const root = await mkdtemp(join(tmpdir(), "tdcc-workflow-"));
  const database = await createTestPGlite("ledger+operational", { dataDir: join(root, "pglite") });
  const store = new PGliteStore(database);
  const operational = createPgliteOperationalProvider(store);
  const server = createPGliteChildRpcServer({
    provider: { operational, financial: createPGliteFinancialLocalPort(createPGliteFinancialRegistry(store, operational.exchangeRates)) },
  });
  const previous = { ...process.env };
  let child: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  const secrets = createTdccSecretStore(join(root, "credentials.json"), codec);
  secrets.write({
    userId: USER_ID,
    password: "fixture-password",
    ...(registered ? { device: { userId: USER_ID, deviceId: "00112233aabbccdd", devType: "Android:14", devModel: "SM-G991B" } } : {}),
    session: { tokenId: SAVED_TOKEN, richUrl: null, issuedAt: "2026-10-08T00:00:00.000Z" },
  });
  const events: WorkflowRunEvent[] = [];
  let runs = 0;
  try {
    await server.ready;
    Object.assign(process.env, server.env);
    child = requirePGliteChildRpcClientFromEnv();
    await child.ready;
    const childRpc = child;
    await body({
      secrets,
      events,
      pgliteRpc: { endpoint: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT!, token: server.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN! },
      async count(sql) {
        return (await store.query<{ count: number }>(sql)).rows[0]!.count;
      },
      async run(input, fake, runOptions = {}) {
        runs += 1;
        const host = createTdccSessionHost(secrets);
        const executor = createWorkflowExecutor([createTdccWorkflow({ fetch: fake.fetch })], {
          browser: { withPage: async () => { throw new Error("TDCC does not use a browser."); } },
          text: strictSourceText,
          humanAssistance: { request: async () => { throw new Error("TDCC never requests assistance."); } },
          financialCommit: {
            async execute(items, options) {
              const result = await createWorkflowFinancialCommitPort(childRpc.workflow).execute(items, options);
              if (runOptions.loseCommitReplyFor !== undefined && runOptions.loseCommitReplyFor === options?.product) {
                throw new Error("synthetic lost commit reply");
              }
              return result;
            },
          },
          tdcc: {
            session: {
              open: async () => host.open(),
              signInDetails: async () => host.signInDetails(),
              saveSession: (session) => host.saveSession(session),
            },
            admittedFundAccounts: (connection) => childRpc.financial.request("financial.tdccFundAccounts.list", [connection]),
          },
          commitAttempts: { record: async () => undefined },
          events: { append: async (event) => { events.push(event); runOptions.onEvent?.(event); } },
          now: () => NOW,
        });
        return await executor.run("sync-tdcc", `tdcc-run-${runs}`, input, runOptions.signal ?? new AbortController().signal) as Record<string, unknown>;
      },
    });
  } finally {
    for (const key of Object.keys(server.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    child?.close();
    await server.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const ALL = { statementTypes: ["securities", "fund", "settlement"] };
const products = (result: Record<string, unknown>) =>
  Object.fromEntries((result.products as { typeId: string; status: string; skipReason?: string }[])
    .map(({ typeId, status, skipReason }) => [typeId, skipReason ? `${status}:${skipReason}` : status]));

async function interruption(promise: Promise<unknown>): Promise<ProductCollectionInterruptedError | Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  assert.fail("the run should have stopped");
}

test("a run reuses the saved session, commits every selected product, and reports exclusions only as counts", async () => {
  await withHarness(async ({ run, secrets, count, events }) => {
    const fake = fakeTdcc();
    const result = await run(ALL, fake);
    const codes = events.map((event) => `${event.stage} ${event.outcome} ${event.code}`);
    assert.ok(codes.indexOf("preparation completed input-validated") >= 0
      && codes.indexOf("preparation completed input-validated") < codes.indexOf("authentication started authentication-started"),
    "a TDCC run reports its valid input before it opens a session");
    assert.equal(fake.calls.includes("AU001"), false, "a valid saved session needs no sign-in");
    assert.deepEqual(products(result), { securities: "success", fund: "success", settlement: "success" });
    assert.equal(result.status, "partial", "problematic TDCC exclusions make a run partial even when all admitted groups commit");
    assert.deepEqual(result.counts, {
      committedCount: 5,
      excludedBankNotUpdatedCount: 1,
      excludedEmptyNonIsoCurrencyCount: 0,
      excludedNonIsoCurrencyCount: 1,
      excludedNonNumericAccountCount: 0,
      excludedTimeDepositCount: 1,
      excludedUnknownInstitutionCount: 3,
      hiddenAccountCount: 1,
      itemCount: 5,
      rowCount: 4,
      sourceCaptureCount: 5,
    });
    assert.deepEqual((result.products as { typeId: string; collection?: { status: string } }[])
      .map(({ typeId, collection }) => [typeId, collection?.status]), [
      ["securities", "incomplete"], ["fund", "incomplete"], ["settlement", "incomplete"],
    ]);
    const reported = JSON.stringify(result);
    for (const accountNumber of [BROKER_ACCOUNT, UNKNOWN_BROKER_ACCOUNT, TWD_ACCOUNT, HIDDEN_ACCOUNT, NAN_ACCOUNT, UNKNOWN_BANK_ACCOUNT])
      assert.equal(reported.includes(accountNumber), false, "the run result carries no account number");
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'investment'"), 1);
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'investment-fund'"), 1);
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'domestic-deposit'"), 1);
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM investment_passbook_movements"), 1);
    assert.equal(secrets.read().session?.tokenId, `rotated-${fake.calls.length}`, "the last rotated token is saved");
  });
});

test("intentional hidden-account and time-deposit exclusions complete without implying absence", async () => {
  await withHarness(async ({ run }) => {
    const result = await run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: settlementSnapshot([
        updatedBank("812", [settlementRow(INTENTIONAL_HIDDEN_ACCOUNT, "TWD", false)], [{}]),
      ]),
    }));
    const settlement = (result.products as {
      typeId: string; status: string; itemCount: number; committedCount: number;
      collection?: { status: string; exclusionCounts: Record<string, number> };
    }[]).find(({ typeId }) => typeId === "settlement");
    assert.equal(result.status, "completed");
    assert.equal(settlement?.status, "success");
    assert.equal(settlement?.itemCount, 0);
    assert.equal(settlement?.committedCount, 0);
    assert.deepEqual(settlement?.collection, {
      status: "complete_with_exclusions",
      exclusionCounts: { excludedTimeDepositCount: 1, hiddenAccountCount: 1 },
    });
    assert.notEqual(result.status, "no-data");
  });
});

test("problematic exclusions with zero admitted items fail without claiming absence", async () => {
  await withHarness(async ({ run, count }) => {
    const stopped = await interruption(run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: problematicSettlementSnapshot(),
    })));
    assert.ok(stopped instanceof ProductCollectionInterruptedError, "a run without durable data throws its summary");
    assert.equal(stopped.errorCode, "source-collection-failed");
    const result = stopped.summary;
    const settlement = result.products.find(({ typeId }) => typeId === "settlement");
    assert.equal(result.status, "failed");
    assert.equal(settlement?.status, "failed");
    assert.equal(settlement?.committedCount, 0);
    assert.deepEqual(settlement?.collection, {
      status: "incomplete",
      exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    });
    assert.notEqual(result.status, "no-data");
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'domestic-deposit'"), 0);
  });
});

test("each problematic settlement exclusion reason with zero admitted items remains incomplete", async () => {
  await withHarness(async ({ run, secrets }) => {
    const nonIsoCurrencyAccount = settlementRow(["7001", "2345684"].join(""), "NAN");
    const emptyNonIsoCurrencyAccount = {
      ...settlementRow(["7001", "2345685"].join(""), "NAN"),
      balanceAmt: "0",
      availableBalance: "0",
    };
    const cases = [
      {
        name: "unknown institution",
        snapshot: problematicSettlementSnapshot(),
        countName: "excludedUnknownInstitutionCount",
      },
      {
        name: "non-ISO currency",
        snapshot: settlementSnapshot([updatedBank("812", [nonIsoCurrencyAccount])]),
        countName: "excludedNonIsoCurrencyCount",
      },
      {
        name: "unsupported account identifier",
        snapshot: settlementSnapshot([updatedBank("812", [settlementRow("ACCOUNT-TOKEN", "TWD")])]),
        countName: "excludedNonNumericAccountCount",
      },
      {
        name: "bank not updated",
        snapshot: settlementSnapshot([{
          bankId: "812", execStatue: "9999", tspAccount: null, tspTimeAccounts: null,
        }]),
        countName: "excludedBankNotUpdatedCount",
      },
      {
        name: "empty non-ISO currency",
        snapshot: settlementSnapshot([updatedBank("812", [emptyNonIsoCurrencyAccount])]),
        countName: "excludedEmptyNonIsoCurrencyCount",
      },
    ] as const;
    for (const scenario of cases) {
      const stopped = await interruption(run({ statementTypes: ["settlement"] }, fakeTdcc({
        acceptedToken: secrets.read().session?.tokenId,
        settlementSnapshot: scenario.snapshot,
      })));
      assert.ok(stopped instanceof ProductCollectionInterruptedError, `${scenario.name} throws its summary`);
      const result = stopped.summary;
      const settlement = result.products.find(({ typeId }) => typeId === "settlement");
      assert.equal(result.status, "failed", `${scenario.name} must not be reported as absence`);
      assert.equal(settlement?.status, "failed", `${scenario.name} leaves no complete collection evidence`);
      assert.equal(settlement?.committedCount, 0, `${scenario.name} admits no commit items`);
      assert.deepEqual(settlement?.collection, {
        status: "incomplete",
        exclusionCounts: { [scenario.countName]: 1 },
      }, `${scenario.name} count survives on the product result`);
    }
  });
});

test("a completed provider response with no reported settlement accounts remains explicit not-held evidence", async () => {
  await withHarness(async ({ run }) => {
    const result = await run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: settlementSnapshot([updatedBank("812", [])]),
    }));
    const settlement = (result.products as {
      typeId: string; status: string; collection?: { status: string };
    }[]).find(({ typeId }) => typeId === "settlement");
    assert.equal(result.status, "no-data");
    assert.equal(settlement?.status, "not_held");
    assert.equal(settlement?.collection?.status, "complete");
  });
});

test("valid settlement accounts commit intact beside problematic exclusions and mark the run partial", async () => {
  await withHarness(async ({ run, count }) => {
    const result = await run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: mixedSettlementSnapshot(),
    }));
    const settlement = (result.products as {
      typeId: string; status: string; itemCount: number; committedCount: number;
      collection?: { status: string; exclusionCounts: Record<string, number> };
    }[]).find(({ typeId }) => typeId === "settlement");
    assert.equal(result.status, "partial");
    assert.equal(settlement?.status, "success");
    assert.equal(settlement?.itemCount, 2);
    assert.equal(settlement?.committedCount, 2);
    assert.deepEqual(settlement?.collection, {
      status: "incomplete",
      exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    });
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'domestic-deposit'"), 1);
  });
});

test("validated exclusions survive a later request failure in the typed interrupted summary", async () => {
  await withHarness(async ({ run, events }) => {
    const error = await interruption(run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: mixedSettlementSnapshot(),
      httpFailureAt: "tsp/TSP007",
    })));
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "source-unavailable");
    const settlement = error.summary.products.find(({ typeId }) => typeId === "settlement");
    assert.deepEqual(settlement?.collection, {
      status: "incomplete",
      exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    });
    assert.equal(summarizeInterruptedProductCollection(error)?.counts.excludedUnknownInstitutionCount, 1);
    assert.equal(classifyTypedWorkflowFailure(error, events), "source-unavailable");
  });
});

test("cooperative cancellation during a later account request retains validated exclusions", async () => {
  await withHarness(async ({ run }) => {
    const controller = new AbortController();
    const error = await interruption(run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: mixedSettlementSnapshot(),
      abortAt: "tsp/TSP007",
      abortController: controller,
    }), { signal: controller.signal }));
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "cancelled");
    assert.equal(error.summary.committedCount, 0);
    assert.deepEqual(error.summary.products.find(({ typeId }) => typeId === "settlement")?.collection, {
      status: "incomplete",
      exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    });
  });
});

test("cooperative cancellation at commit start retains collection exclusions and any receipts", async () => {
  await withHarness(async ({ run }) => {
    const controller = new AbortController();
    const error = await interruption(run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: mixedSettlementSnapshot(),
    }), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.code === "canonical-commit-started" && event.statementType === "settlement") controller.abort();
      },
    }));
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "cancelled");
    assert.equal(error.summary.committedCount, 0, "the commit did not return a durable receipt");
    assert.deepEqual(error.summary.products.find(({ typeId }) => typeId === "settlement")?.collection, {
      status: "incomplete",
      exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    });
  });
});

test("a later product failure retains earlier durable receipts and exclusion evidence", async () => {
  await withHarness(async ({ run, events }) => {
    const error = await interruption(run({ statementTypes: ["securities", "settlement"] }, fakeTdcc({
      settlementSnapshot: mixedSettlementSnapshot(),
      httpFailureAt: "tsp/TSP007",
    })));
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "source-unavailable");
    assert.equal(error.summary.committedCount, 2, "the prior securities group remains durably committed");
    assert.equal(error.summary.status, "partial");
    assert.equal(error.summary.products.find(({ typeId }) => typeId === "securities")?.committedCount, 2);
    assert.equal(error.summary.products.find(({ typeId }) => typeId === "settlement")?.collection?.status, "incomplete");
    assert.equal(classifyTypedWorkflowFailure(error, events), "source-unavailable");
  });
});

test("a lost commit reply retains collection evidence and only previously acknowledged receipts", async () => {
  await withHarness(async ({ run, count, events }) => {
    const error = await interruption(run({ statementTypes: ["securities", "settlement"] }, fakeTdcc({
      settlementSnapshot: mixedSettlementSnapshot(),
    }), { loseCommitReplyFor: "settlement" }));
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "commit-outcome-unknown");
    assert.equal(error.summary.committedCount, 2, "only the earlier securities receipts are known");
    const settlement = error.summary.products.find(({ typeId }) => typeId === "settlement");
    assert.equal(settlement?.committedCount, 0, "a lost reply never establishes a receipt");
    assert.deepEqual(settlement?.collection, {
      status: "incomplete", exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    });
    assert.equal(await count(`SELECT COUNT(*)::int AS count FROM financial_accounts WHERE stream = 'domestic-deposit' AND source_account_key = '812-${MIXED_VALID_ACCOUNT}-TWD'`), 1,
      "the store committed even though the caller cannot know it from a reply");
    assert.equal(classifyTypedWorkflowFailure(error, events), "commit-outcome-unknown");
    const summary = summarizeInterruptedProductCollection(error);
    assert.equal(summary?.counts.committedCount, 2);
    assert.equal(summary?.counts.excludedUnknownInstitutionCount, 2, "securities and settlement each reported one exclusion");
  });
});

test("late cooperative cancellation retains TDCC exclusion observations and receipts", async () => {
  await withHarness(async ({ run }) => {
    const controller = new AbortController();
    const error = await interruption(run({ statementTypes: ["settlement"] }, fakeTdcc({
      settlementSnapshot: mixedSettlementSnapshot(),
    }), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.stage === "finalization" && event.code === "run-completed") controller.abort();
      },
    }));
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "cancelled");
    assert.equal(error.summary.committedCount, 2);
    assert.equal(error.summary.status, "partial");
    assert.deepEqual(error.summary.products.find(({ typeId }) => typeId === "settlement")?.collection, {
      status: "incomplete",
      exclusionCounts: { excludedUnknownInstitutionCount: 1 },
    });
  });
});

test("an expired session signs in once and the run continues with the new token", async () => {
  await withHarness(async ({ run, secrets }) => {
    const fake = fakeTdcc({ acceptedToken: null });
    const result = await run({ statementTypes: ["settlement"] }, fake);
    assert.deepEqual(fake.calls.slice(0, 4), ["tsp/TSP006", "CM001", "AU001", "tsp/TSP006"]);
    assert.deepEqual(products(result), { securities: "skipped:not_selected", fund: "skipped:not_selected", settlement: "success" });
    assert.equal(secrets.read().session?.issuedAt, NOW, "a fresh sign-in restarts the session age");
  });
});

test("an untrusted device ends the run as device-registration-required without asking for a one-time code", async () => {
  await withHarness(async ({ run, events }) => {
    const fake = fakeTdcc({ acceptedToken: null, trustDevice: false });
    const error = await interruption(run(ALL, fake));
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "device-registration-required");
    assert.equal(classifyTypedWorkflowFailure(error, events), "device-registration-required");
    assert.deepEqual(fake.calls, ["TR001", "CM001", "AU001"]);
    assert.equal(fake.calls.some((path) => path === "AU013" || path === "AU014" || path === "AU015"), false);
    assert.deepEqual(error.summary.products.map(({ typeId, status }) => [typeId, status]), [
      ["securities", "failed"], ["fund", "skipped"], ["settlement", "skipped"],
    ]);
  });
});

test("a run without a registered device stops before calling TDCC", async () => {
  await withHarness(async ({ run, events }) => {
    const fake = fakeTdcc();
    const error = await interruption(run(ALL, fake));
    assert.equal(classifyTypedWorkflowFailure(error, events), "device-registration-required");
    assert.deepEqual(fake.calls, []);
  }, false);
});

test("a protocol change ends the run as provider-protocol-outdated", async () => {
  await withHarness(async ({ run, events }) => {
    const error = await interruption(run(ALL, fakeTdcc({ protocolOutdatedAt: "TR001" })));
    assert.equal(classifyTypedWorkflowFailure(error, events), "provider-protocol-outdated");
  });
});

test("a rotated token is saved when the run fails part way", async () => {
  await withHarness(async ({ run, secrets, events }) => {
    const fake = fakeTdcc({ httpFailureAt: "tsp/TSP007" });
    const error = await interruption(run({ statementTypes: ["settlement"] }, fake));
    assert.equal(classifyTypedWorkflowFailure(error, events), "source-unavailable");
    assert.equal(secrets.read().session?.tokenId, "rotated-1", "the token TSP006 rotated survives the failed run");
  });
});

test("a fund account TDCC no longer lists commits an empty holding snapshot", async () => {
  await withHarness(async ({ run, count }) => {
    await run({ statementTypes: ["fund"] }, fakeTdcc({ funds: [fundRow("004", "ABC123"), fundRow("812", "DEF456")] }));
    const result = await run({ statementTypes: ["fund"] }, fakeTdcc({ funds: [fundRow("004", "ABC123")] }));
    const fund = (result.products as { typeId: string; status: string; committedCount: number }[]).find(({ typeId }) => typeId === "fund");
    assert.deepEqual(fund && { status: fund.status, committedCount: fund.committedCount }, { status: "success", committedCount: 2 });
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM investment_holding_snapshots"), 4);
    assert.equal(await count(
      `SELECT COUNT(*)::int AS count FROM investment_holding_snapshots snapshot
        WHERE NOT EXISTS (SELECT 1 FROM investment_holding_observations holding WHERE holding.capture_id = snapshot.capture_id)`,
    ), 1, "only the absent sale organisation's latest snapshot is empty");
  });
});

test("through the supervised worker frames, a rotated token is saved when the run fails part way", async () => {
  await withHarness(async ({ secrets, pgliteRpc }) => {
    const fake = fakeTdcc({ acceptedToken: null, httpFailureAt: "tsp/TSP007" });
    const outcome = await runSupervisedAppWorkflow({
      runId: "tdcc-worker-run",
      workflowId: "sync-tdcc",
      input: { statementTypes: ["settlement"] },
      pgliteRpc,
      signal: new AbortController().signal,
      appendEvent: async () => undefined,
      recordCommitAttempt: async () => undefined,
      requestHumanAssistance: async () => "failed",
      tdccSession: createTdccSessionHost(secrets),
      workerFactory: (_path, options) => inProcessAppWorkflowWorker(options.workerData, { resolveDefinition: () => createTdccWorkflow({ fetch: fake.fetch }) }),
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "source-unavailable");
    assert.equal(outcome.summary?.counts.excludedUnknownInstitutionCount, 1);
    assert.deepEqual(outcome.summary?.products?.find(({ typeId }) => typeId === "settlement")?.collection, {
      status: "incomplete",
      exclusionCounts: {
        excludedBankNotUpdatedCount: 1,
        excludedNonIsoCurrencyCount: 1,
        excludedTimeDepositCount: 1,
        excludedUnknownInstitutionCount: 1,
        hiddenAccountCount: 1,
      },
    });
    assert.deepEqual(fake.calls, ["tsp/TSP006", "CM001", "AU001", "tsp/TSP006", "tsp/TSP007"]);
    assert.equal(secrets.read().session?.tokenId, "rotated-3", "the token TSP006 rotated reached credentials.json through the worker frames");
    assert.equal(JSON.stringify(outcome).includes("fixture-password"), false);
    for (const accountNumber of [TWD_ACCOUNT, HIDDEN_ACCOUNT, NAN_ACCOUNT, UNKNOWN_BANK_ACCOUNT])
      assert.equal(JSON.stringify(outcome).includes(accountNumber), false, "worker transport retains counts but no account identifiers");
  });
});
