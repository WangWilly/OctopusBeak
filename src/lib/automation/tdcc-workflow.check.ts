import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPGliteChildRpcServer, requirePGliteChildRpcClientFromEnv } from "../../../electron/pglite-child-rpc.ts";
import { createPGliteFinancialRegistry } from "../../../electron/pglite-financial-registry.ts";
import { createBaselinePGlite } from "../../ledger/pglite/baseline-test-template.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../ledger/pglite/transaction.ts";
import { TDCC_BASE_URL } from "../../workflows/tdcc-epassbook-client.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import { createTdccSecretStore } from "./server/tdcc-secret-store.ts";
import { createTdccSessionHost } from "./server/tdcc-session-host.ts";
import { classifyTypedWorkflowFailure, summarizeTypedWorkflowOutput } from "./server/typed-workflow-outcome.ts";
import { createTdccWorkflow } from "./tdcc-workflow.ts";
import { strictSourceText } from "./source-text.ts";
import { createWorkflowExecutor, type WorkflowRunEvent } from "./workflow-executor.ts";
import { createWorkflowFinancialCommitPort } from "./workflow-financial-commit.ts";
import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { runSupervisedAppWorkflow, type AppWorkflowWorkerHandle } from "./server/app-workflow-worker-supervisor.ts";
import { runAppWorkflowWorker } from "./server/app-workflow-worker-runtime.ts";
import { parseAppWorkflowWorkerOutboundFrame } from "./server/app-workflow-worker-protocol.ts";

// Built at runtime so the repository privacy and secret scanners do not read fixtures as real accounts.
const USER_ID = ["Q", "2", "87654321"].join("");
const BROKER_ACCOUNT = ["98", "76543"].join("");
const UNKNOWN_BROKER_ACCOUNT = ["98", "76544"].join("");
const TWD_ACCOUNT = ["2001", "2345678"].join("");
const HIDDEN_ACCOUNT = ["2001", "2345611"].join("");
const NAN_ACCOUNT = ["2001", "2345680"].join("");
const UNKNOWN_BANK_ACCOUNT = ["3001", "2345678"].join("");
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

type FakeOptions = {
  /** The token TDCC still accepts before any sign-in; null means the saved session has expired. */
  acceptedToken?: string | null;
  trustDevice?: boolean;
  funds?: readonly unknown[];
  /** Endpoint path that answers with a version message instead of data. */
  protocolOutdatedAt?: string;
  /** Endpoint path that answers HTTP 500. */
  httpFailureAt?: string;
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
        return reply({
          tspAccountInfos: [
            {
              bankId: "812",
              tspAccount: [settlementRow(TWD_ACCOUNT, "TWD"), settlementRow(HIDDEN_ACCOUNT, "TWD", false), settlementRow(NAN_ACCOUNT, "NAN")],
              tspTimeAccounts: [{}],
            },
            { bankId: "999", tspAccount: [settlementRow(UNKNOWN_BANK_ACCOUNT, "TWD")], tspTimeAccounts: [] },
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
  run(input: unknown, fake: ReturnType<typeof fakeTdcc>): Promise<Record<string, unknown>>;
  secrets: ReturnType<typeof createTdccSecretStore>;
  pgliteRpc: Readonly<{ endpoint: string; token: string }>;
  count(sql: string): Promise<number>;
  events: WorkflowRunEvent[];
}>;

async function withHarness(body: (harness: Harness) => Promise<void>, registered = true) {
  const root = await mkdtemp(join(tmpdir(), "tdcc-workflow-"));
  const database = await createBaselinePGlite({ dataDir: join(root, "pglite") });
  const store = new PGliteStore(database);
  await applyPgliteOperationalBaseline(store);
  const operational = createPgliteOperationalProvider(store);
  const server = createPGliteChildRpcServer({
    provider: { operational, financial: createPGliteFinancialRegistry(store, operational.exchangeRates) },
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
      async run(input, fake) {
        runs += 1;
        const host = createTdccSessionHost(secrets);
        const executor = createWorkflowExecutor([createTdccWorkflow({ fetch: fake.fetch })], {
          browser: { withPage: async () => { throw new Error("TDCC does not use a browser."); } },
          text: strictSourceText,
          humanAssistance: { request: async () => { throw new Error("TDCC never requests assistance."); } },
          financialCommit: createWorkflowFinancialCommitPort(childRpc.workflow),
          tdcc: {
            session: {
              open: async () => host.open(),
              signInDetails: async () => host.signInDetails(),
              saveSession: (session) => host.saveSession(session),
            },
            admittedFundAccounts: (connection) => childRpc.financial.listTdccFundAccounts(connection),
          },
          events: { append: async (event) => { events.push(event); } },
          now: () => NOW,
        });
        return await executor.run("sync-tdcc", `tdcc-run-${runs}`, input, new AbortController().signal) as Record<string, unknown>;
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
  await withHarness(async ({ run, secrets, count }) => {
    const fake = fakeTdcc();
    const result = await run(ALL, fake);
    assert.equal(fake.calls.includes("AU001"), false, "a valid saved session needs no sign-in");
    assert.deepEqual(products(result), { securities: "success", fund: "success", settlement: "success" });
    assert.equal(result.status, "financial-admitted");
    assert.deepEqual(summarizeTypedWorkflowOutput(result)?.counts, {
      committedCount: 5,
      excludedNonIsoCurrencyCount: 1,
      excludedTimeDepositCount: 1,
      excludedUnknownInstitutionCount: 3,
      hiddenAccountCount: 1,
      itemCount: 5,
      rowCount: 4,
      sourceCaptureCount: 5,
    });
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

/** The App worker runtime on a MessageChannel instead of a thread, so the supervisor and runtime exchange real frames. */
function inProcessWorker(workerData: unknown, fetch: ReturnType<typeof fakeTdcc>["fetch"]): AppWorkflowWorkerHandle {
  const channel = new MessageChannel();
  const worker = new EventEmitter() as EventEmitter & AppWorkflowWorkerHandle;
  channel.port2.on("message", (value: unknown) => {
    worker.emit("message", value);
    const { kind } = parseAppWorkflowWorkerOutboundFrame(value);
    if (kind === "completed" || kind === "failed" || kind === "cancelled") {
      channel.port2.close();
      worker.emit("exit", 0);
    }
  });
  Object.assign(worker, {
    postMessage: (frame: unknown) => channel.port2.postMessage(frame),
    terminate: () => {
      channel.port1.close();
      worker.emit("exit", 1);
      return 1;
    },
  });
  setImmediate(() => {
    worker.emit("online");
    void runAppWorkflowWorker({
      port: channel.port1,
      workerData,
      resolveDefinition: () => createTdccWorkflow({ fetch }),
    });
  });
  return worker;
}

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
      requestHumanAssistance: async () => "failed",
      tdccSession: createTdccSessionHost(secrets),
      workerFactory: (_path, options) => inProcessWorker(options.workerData, fake.fetch),
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "source-unavailable");
    assert.deepEqual(fake.calls, ["tsp/TSP006", "CM001", "AU001", "tsp/TSP006", "tsp/TSP007"]);
    assert.equal(secrets.read().session?.tokenId, "rotated-3", "the token TSP006 rotated reached credentials.json through the worker frames");
    assert.equal(JSON.stringify(outcome).includes("fixture-password"), false);
  });
});
