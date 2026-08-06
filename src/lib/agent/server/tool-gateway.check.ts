import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashBytes, stableStringify } from "../../../ledger/content-hash.ts";
import {
  createFinancialOverviewToolGateway,
  createReadFinancialOverviewProposal,
  readFinancialOverviewResult,
  AGENT_TOOL_RESOURCE_LIMITS,
  validateAgentToolProposal,
  validateAgentToolResult,
  type AgentToolResult,
  type AgentToolSubmission,
} from "./tool-gateway.ts";
import {
  createAgentHarnessService,
  createInMemoryAgentRunStore,
  type AgentProvider,
} from "./harness.ts";
import { createSqliteAgentRunStore } from "./store.ts";

function runningStore() {
  const store = createInMemoryAgentRunStore();
  store.createRun({
    runId: "run-tool-1",
    analysisId: null,
    phase: "running",
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: null,
    output: "",
    failureReason: null,
  });
  return store;
}

function result(): AgentToolResult {
  const data: AgentToolResult["data"] = {
    aggregateVersion: "financial-overview.aggregate.v1",
    snapshot: {
      snapshotId: "financial-overview.aggregate.v1:snapshot",
      importedAt: "2026-08-04T00:00:00.000Z",
      snapshotDate: "2026-08-04",
    },
    totalsByCurrency: { TWD: { assets: 100, liabilities: 20, net: 80 } },
    overview: {
      cashAssets: { TWD: 100 },
      foreignAssets: {},
      investmentAssets: {},
      unbilledCreditCard: {},
      loans: { TWD: 20 },
      netAssets: { TWD: 80 },
    },
    counts: {
      normalizedTransactions: 3,
      assetPositions: 2,
      includedPositions: 2,
      assetSnapshots: 1,
    },
    quality: { status: "pass", issueCount: 0 },
  };
  return {
    resultVersion: "agent-tool-result.v1",
    toolName: "read_financial_overview",
    data,
    reference: {
      referenceVersion: "immutable-result-ref.v1",
      value: `immutable-result-ref.v1:${hashBytes(stableStringify(data))}`,
    },
    secretFields: [],
  };
}

function alternatingAccessorResult(): AgentToolResult {
  const candidate = result();
  const variantA = structuredClone(candidate.data);
  const variantB = structuredClone(candidate.data);
  variantA.totalsByCurrency.TWD!.assets = 101;
  variantA.totalsByCurrency.TWD!.net = 81;
  variantB.totalsByCurrency.TWD!.assets = 202;
  variantB.totalsByCurrency.TWD!.net = 182;
  let reads = 0;
  Object.defineProperty(candidate.data, "totalsByCurrency", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads % 2 === 0 ? variantB.totalsByCurrency : variantA.totalsByCurrency;
    },
  });
  candidate.reference.value = `immutable-result-ref.v1:${hashBytes(stableStringify(variantB))}`;
  return candidate;
}

function symbolBearingResult(): AgentToolResult {
  const candidate = result();
  Object.defineProperty(candidate.data, Symbol("hostile-result-key"), {
    configurable: true,
    enumerable: true,
    value: "must-not-be-persisted",
  });
  return candidate;
}

function throwingProxyResult(): AgentToolResult {
  const candidate = result();
  return new Proxy(candidate, {
    ownKeys() {
      throw new Error("hostile-own-keys");
    },
  });
}

function nonPlainResult(): AgentToolResult {
  const candidate = result();
  candidate.data = Object.assign(new Date("2026-08-04T00:00:00.000Z"), candidate.data) as unknown as AgentToolResult["data"];
  return candidate;
}

test("proposal validation is strict and rejects unknown, malformed, and credential-bearing requests", () => {
  const valid = createReadFinancialOverviewProposal("run-tool-1", "request-1");
  assert.equal(validateAgentToolProposal(valid).reason, null);
  assert.equal(
    validateAgentToolProposal({ ...valid, extra: true }).reason,
    "malformed-proposal",
  );
  assert.equal(
    validateAgentToolProposal({ ...valid, toolName: "read_credentials" }).reason,
    "tool-not-allowlisted",
  );
  assert.equal(
    validateAgentToolProposal({ ...valid, input: { token: "do-not-dispatch" } }).reason,
    "credential-boundary",
  );
  assert.equal(
    validateAgentToolProposal({ ...valid, runAuthority: "other-run" }).reason,
    null,
    "run authority is checked by the host with the active run, not by schema parsing",
  );
});

test("v1 financial result currency keys accept only UNKNOWN or exactly three ASCII uppercase letters", () => {
  const validKeys = ["TWD", "USD", "JPY", "EUR", "HKD", "CNY", "BTC", "UNKNOWN"];
  for (const currency of validKeys) {
    const candidate = result();
    candidate.data.totalsByCurrency = {
      [currency]: { assets: 1, liabilities: 0, net: 1 },
    };
    candidate.data.overview = {
      cashAssets: { [currency]: 1 },
      foreignAssets: { [currency]: 1 },
      investmentAssets: { [currency]: 1 },
      unbilledCreditCard: { [currency]: 1 },
      loans: { [currency]: 1 },
      netAssets: { [currency]: 1 },
    };
    candidate.reference.value = `immutable-result-ref.v1:${hashBytes(stableStringify(candidate.data))}`;
    assert.equal(validateAgentToolResult(candidate), true, currency);
  }
  for (const currency of ["usd", "美金", "", "$", "1234567890", "USDT"]) {
    const candidate = result();
    candidate.data.totalsByCurrency = {
      [currency]: { assets: 1, liabilities: 0, net: 1 },
    };
    candidate.reference.value = `immutable-result-ref.v1:${hashBytes(stableStringify(candidate.data))}`;
    assert.equal(validateAgentToolResult(candidate), false, currency);
  }
});

test("secret-bearing currency object keys fail closed after one adapter call without persistence", async () => {
  for (const [index, secretCurrency] of ["ABC", "USD"].entries()) {
    const proposal = createReadFinancialOverviewProposal("run-tool-1", `request-secret-currency-${index}`);
    assert.equal(JSON.stringify(proposal).includes(secretCurrency), false);

    const controlStore = runningStore();
    const controlCandidate = result();
    let controlCalls = 0;
    const controlGateway = createFinancialOverviewToolGateway({
      runStore: controlStore,
      adapter: async () => {
        controlCalls += 1;
        return controlCandidate;
      },
    });
    const control = await controlGateway.submit(proposal);
    assert.equal(controlCalls, 1);
    assert.equal(control.outcome, "completed");

    const store = runningStore();
    let calls = 0;
    const candidate = result();
    candidate.data.totalsByCurrency = {
      [secretCurrency]: { assets: 1, liabilities: 0, net: 1 },
    };
    candidate.reference.value = `immutable-result-ref.v1:${hashBytes(stableStringify(candidate.data))}`;
    const gateway = createFinancialOverviewToolGateway({
      runStore: store,
      secretValues: [secretCurrency],
      adapter: async () => {
        calls += 1;
        return candidate;
      },
    });
    const submission = await gateway.submit(proposal);
    assert.equal(calls, 1);
    assert.equal(submission.outcome, "outcome-unknown");
    assert.equal(submission.result, null);
    assert.equal(submission.resultReference, null);
    assert.equal(JSON.stringify(submission).includes(secretCurrency), false);
    assert.equal(
      JSON.stringify(store.listToolRequests?.("run-tool-1")).includes(secretCurrency),
      false,
    );
  }
});

test("host gates permission, sensitivity, resource, and run authority before dispatch with bounded reasons", async () => {
  const store = runningStore();
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      return result();
    },
  });
  const base = createReadFinancialOverviewProposal("run-tool-1", "request-gates");
  for (const [field, value, reason] of [
    ["permission", "filesystem.read", "permission-denied"],
    ["sensitivity", "raw-financial", "sensitivity-denied"],
    ["resource", "filesystem", "resource-denied"],
  ] as const) {
    const submission = await gateway.submit({ ...base, requestId: `${field}-request`, [field]: value });
    assert.equal(submission.outcome, "not-dispatched");
    assert.equal(submission.decision.reason, reason);
  }
  const noAuthority = await gateway.submit({ ...base, requestId: "authority-request", runAuthority: "other-run" });
  assert.equal(noAuthority.outcome, "not-dispatched");
  assert.equal(noAuthority.decision.reason, "run-authority-denied");
  assert.equal(calls, 0);
});

test("credential material in an otherwise schema-valid proposal is rejected before dispatch", async () => {
  const store = runningStore();
  let calls = 0;
  const canary = "authentication-canary-tool-request";
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    secretValues: [canary],
    adapter: async () => {
      calls += 1;
      return result();
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", canary);
  const submission = await gateway.submit(proposal);
  assert.equal(submission.decision.reason, "credential-boundary");
  assert.equal(submission.outcome, "not-dispatched");
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(submission).includes(canary), false);
});

test("read_financial_overview returns a deterministic safe aggregate and immutable reference", async () => {
  const store = runningStore();
  const expected = result();
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => expected,
  });
  const first = await gateway.submit(createReadFinancialOverviewProposal("run-tool-1", "request-safe"));
  assert.equal(first.outcome, "completed");
  assert.deepEqual(first.result, expected);
  assert.equal(JSON.stringify(first).includes("accountId"), false);
  assert.equal(JSON.stringify(first).includes("transaction"), false);
  assert.equal(JSON.stringify(first).includes("credential"), false);
  assert.equal(first.resultReference?.referenceVersion, "immutable-result-ref.v1");
  assert.equal(first.settlement, "normal");
});

test("completed requests replay the persisted result and unknown outcomes never retry", async () => {
  const store = runningStore();
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      return result();
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", "request-replay");
  const completed = await gateway.submit(proposal);
  const replay = await gateway.submit(proposal);
  assert.deepEqual(replay, completed);
  assert.equal(calls, 1);

  const unknownGateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      throw new Error("dispatch lost");
    },
  });
  const unknownProposal = createReadFinancialOverviewProposal("run-tool-1", "request-unknown");
  const unknown = await unknownGateway.submit(unknownProposal);
  const unknownReplay = await unknownGateway.submit(unknownProposal);
  assert.equal(unknown.outcome, "outcome-unknown");
  assert.deepEqual(unknownReplay, unknown);
  assert.equal(calls, 2);
});

test("completed replay requires the same canonical proposal and an active run", async () => {
  const store = runningStore();
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      return result();
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", "request-identity");
  const completed = await gateway.submit(proposal);
  assert.equal(completed.outcome, "completed");

  const changed = await gateway.submit({ ...proposal, runAuthority: "run-tool-other" });
  assert.equal(changed.requestId, "request-identity");
  assert.equal(changed.decision.reason, "run-authority-denied");
  assert.equal(changed.outcome, "not-dispatched");
  assert.equal(changed.result, null);
  const malformedChanged = await gateway.submit({ ...proposal, input: { unexpected: true } });
  assert.equal(malformedChanged.outcome, "not-dispatched");
  assert.equal(malformedChanged.decision.reason, "schema-invalid");
  assert.equal(malformedChanged.result, null);
  assert.equal(calls, 1);

  store.updateRun("run-tool-1", {
    phase: "cancelled",
    finishedAt: "2026-08-04T00:00:02.000Z",
  });
  const cancelled = await gateway.submit(proposal);
  assert.equal(cancelled.outcome, "not-dispatched");
  assert.equal(cancelled.decision.reason, "run-authority-denied");
  assert.equal(cancelled.result, null);
  assert.equal(calls, 1);
});

test("a mismatched duplicate never replaces a completed durable record or its canonical replay", async () => {
  const store = runningStore();
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      return result();
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", "request-monotonicity");
  const completed = await gateway.submit(proposal);
  assert.equal(completed.outcome, "completed");
  const durableBefore = store.getToolRequest?.("run-tool-1", "request-monotonicity");
  assert.equal(durableBefore?.outcome, "completed");
  assert.deepEqual(durableBefore?.result, completed.result);

  const changed = await gateway.submit({ ...proposal, runAuthority: "run-tool-other" });
  assert.equal(changed.outcome, "not-dispatched");
  assert.equal(changed.result, null);
  assert.equal(changed.resultReference, null);
  assert.equal(calls, 1);
  assert.equal(store.getToolRequest?.("run-tool-1", "request-monotonicity")?.outcome, "completed");

  const malformed = await gateway.submit({ ...proposal, input: { unexpected: true } });
  assert.equal(malformed.outcome, "not-dispatched");
  assert.equal(malformed.result, null);
  assert.equal(malformed.resultReference, null);
  assert.equal(calls, 1);
  assert.equal(store.getToolRequest?.("run-tool-1", "request-monotonicity")?.outcome, "completed");

  const replay = await gateway.submit(proposal);
  assert.deepEqual(replay, completed);
  assert.equal(replay.outcome, "completed");
  assert.deepEqual(store.getToolRequest?.("run-tool-1", "request-monotonicity")?.result, completed.result);
  assert.equal(calls, 1);
});

test("a fresh durable terminal record supersedes a stale nonterminal cache across gateways", async () => {
  const store = runningStore();
  let gatewayACalls = 0;
  let gatewayBCalls = 0;
  const gatewayA = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      gatewayACalls += 1;
      return result();
    },
  });
  const gatewayB = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      gatewayBCalls += 1;
      return result();
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", "request-shared-store");

  const denied = await gatewayA.submit({ ...proposal, runAuthority: "wrong-authority" });
  assert.equal(denied.outcome, "not-dispatched");
  assert.equal(store.getToolRequest?.("run-tool-1", "request-shared-store")?.outcome, "not-dispatched");

  const completed = await gatewayB.submit(proposal);
  assert.equal(completed.outcome, "completed");
  assert.equal(gatewayBCalls, 1);
  assert.equal(store.getToolRequest?.("run-tool-1", "request-shared-store")?.outcome, "completed");

  const replay = await gatewayA.submit(proposal);
  assert.deepEqual(replay, completed);
  assert.equal(replay.outcome, "completed");
  assert.equal(gatewayACalls, 0);
  assert.equal(gatewayBCalls, 1);
});

test("a not-dispatched request is revalidated and dispatches after authority becomes valid", async () => {
  const store = runningStore();
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      return result();
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", "request-revalidate");
  const denied = await gateway.submit({ ...proposal, runAuthority: "wrong-authority" });
  assert.equal(denied.outcome, "not-dispatched");
  const completed = await gateway.submit(proposal);
  assert.equal(completed.outcome, "completed");
  assert.equal(calls, 1);
});

test("concurrent same-identity submissions dispatch the adapter once", async () => {
  const store = runningStore();
  let calls = 0;
  let release!: (value: AgentToolResult) => void;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      return new Promise<AgentToolResult>((resolve) => { release = resolve; });
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", "request-concurrent");
  const first = gateway.submit(proposal);
  const second = gateway.submit({ ...proposal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(result());
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two);
  assert.equal(one.outcome, "completed");
});

test("accessor-bearing adapter results fail closed in memory and replay a stable unknown outcome", async () => {
  const store = runningStore();
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      calls += 1;
      return alternatingAccessorResult();
    },
  });
  const proposal = createReadFinancialOverviewProposal("run-tool-1", "request-accessor-memory");
  const first = await gateway.submit(proposal);
  assert.equal(first.outcome, "outcome-unknown");
  assert.equal(first.result, null);
  assert.equal(first.resultReference, null);
  assert.equal(calls, 1);
  const replay = await gateway.submit(proposal);
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.equal(store.getToolRequest?.("run-tool-1", proposal.requestId)?.outcome, "outcome-unknown");
  assert.equal(store.getToolRequest?.("run-tool-1", proposal.requestId)?.result, null);
});

test("accessor-bearing adapter results fail closed in SQLite without an invalid completed row", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-accessor-sqlite-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-accessor-sqlite",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    let calls = 0;
    const gateway = createFinancialOverviewToolGateway({
      ledgerDir: root,
      runStore: store,
      adapter: async () => {
        calls += 1;
        return alternatingAccessorResult();
      },
    });
    const proposal = createReadFinancialOverviewProposal("run-accessor-sqlite", "request-accessor-sqlite");
    const first = await gateway.submit(proposal);
    assert.equal(first.outcome, "outcome-unknown");
    assert.equal(first.result, null);
    assert.equal(first.resultReference, null);
    assert.equal(calls, 1);
    const replay = await gateway.submit(proposal);
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
    const durable = store.getToolRequest?.("run-accessor-sqlite", proposal.requestId);
    assert.equal(durable?.outcome, "outcome-unknown");
    assert.equal(durable?.result, null);
    assert.equal(durable?.resultReference, null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbol-bearing, proxy, and non-plain adapter results fail closed and replay without retry", async () => {
  const variants: Array<[string, () => AgentToolResult]> = [
    ["symbol", symbolBearingResult],
    ["proxy", throwingProxyResult],
    ["non-plain", nonPlainResult],
  ];
  for (const [name, hostileResult] of variants) {
    const store = runningStore();
    let calls = 0;
    const gateway = createFinancialOverviewToolGateway({
      runStore: store,
      adapter: async () => {
        calls += 1;
        return hostileResult();
      },
    });
    const proposal = createReadFinancialOverviewProposal("run-tool-1", `request-hostile-${name}`);
    const first = await gateway.submit(proposal);
    assert.equal(first.outcome, "outcome-unknown", name);
    assert.equal(first.result, null, name);
    assert.equal(first.resultReference, null, name);
    const replay = await gateway.submit(proposal);
    assert.deepEqual(replay, first, name);
    assert.equal(calls, 1, name);
  }
});

test("direct malformed unknown-run proposals fail closed without an invalid foreign-key insert", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-malformed-direct-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    const gateway = createFinancialOverviewToolGateway({ runStore: store, adapter: async () => result() });
    const submission = await gateway.submit({ runId: "unknown", requestId: "bad", executable: { shell: "no" } });
    assert.equal(submission.outcome, "not-dispatched");
    assert.equal(submission.decision.reason, "malformed-proposal");
    assert.equal(store.getToolRequest?.("unknown", "bad"), null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hostile cyclic proposals fail closed into sanitized bounded denial", async () => {
  const store = runningStore();
  const gateway = createFinancialOverviewToolGateway({ runStore: store, adapter: async () => result() });
  const hostile: Record<string, unknown> = createReadFinancialOverviewProposal(
    "run-tool-1",
    "request-hostile",
  );
  hostile.input = hostile;
  const submission = await gateway.submit(hostile);
  assert.equal(submission.outcome, "not-dispatched");
  assert.equal(submission.result, null);
  assert.equal(JSON.stringify(submission).includes("hostile"), false);
});

test("pre-dispatch ledger byte bounds reject an oversized SQLite file before the adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-ledger-bound-"));
  try {
    writeFileSync(join(root, "ledger.sqlite"), "");
    truncateSync(join(root, "ledger.sqlite"), 64 * 1024 * 1024 + 1);
    const store = runningStore();
    let calls = 0;
    const gateway = createFinancialOverviewToolGateway({
      ledgerDir: root,
      runStore: store,
      adapter: async () => {
        calls += 1;
        return result();
      },
    });
    const submission = await gateway.submit(
      createReadFinancialOverviewProposal("run-tool-1", "request-ledger-bytes"),
    );
    assert.equal(submission.outcome, "not-dispatched");
    assert.equal(submission.decision.reason, "resource-denied");
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-dispatch ledger byte bounds include SQLite WAL and shared-memory sidecars", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-ledger-footprint-bound-"));
  const store = createSqliteAgentRunStore(root, { secretValues: [] });
  try {
    store.createRun({
      runId: "run-tool-1",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    writeFileSync(
      `${join(root, "ledger.sqlite")}-shm`,
      Buffer.alloc(AGENT_TOOL_RESOURCE_LIMITS.maxLedgerBytes),
    );
    let calls = 0;
    const gateway = createFinancialOverviewToolGateway({
      ledgerDir: root,
      runStore: store,
      adapter: async () => {
        calls += 1;
        return result();
      },
    });
    const submission = await gateway.submit(
      createReadFinancialOverviewProposal("run-tool-1", "request-ledger-footprint"),
    );
    assert.equal(submission.outcome, "not-dispatched");
    assert.equal(submission.decision.reason, "resource-denied");
    assert.equal(calls, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed proposals are durably sanitized before persistence", async () => {
  const store = runningStore();
  const canary = "credential-canary-not-persisted";
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    secretValues: [canary],
    adapter: async () => result(),
  });
  const submission = await gateway.submit({
    runId: canary,
    requestId: canary,
    toolName: "read_financial_overview",
    extra: { accountId: canary, password: canary },
  });
  assert.equal(submission.outcome, "not-dispatched");
  assert.equal(submission.decision.reason, "credential-boundary");
  assert.equal(store.getToolRequest?.("redacted", "redacted"), null);
  assert.equal(JSON.stringify(submission).includes(canary), false);
});

test("serialized malformed canaries in runId or requestId are redacted before persistence", async () => {
  const store = runningStore();
  const runIdCanary = "serialized-run-id-secret-canary";
  const requestIdCanary = "serialized-request-id-secret-canary";
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    secretValues: [runIdCanary, requestIdCanary],
    adapter: async () => {
      calls += 1;
      return result();
    },
  });

  for (const proposal of [
    {
      runId: runIdCanary,
      requestId: "safe-request-id",
      malformedExtra: "unknown-field",
    },
    {
      runId: "run-tool-1",
      requestId: requestIdCanary,
      malformedExtra: "unknown-field",
    },
  ]) {
    const submission = await gateway.submit(proposal);
    assert.equal(submission.decision.reason, "credential-boundary");
    assert.equal(submission.outcome, "not-dispatched");
    assert.equal(submission.result, null);
    assert.equal(submission.resultReference, null);
    assert.equal(JSON.stringify(submission).includes(runIdCanary), false);
    assert.equal(JSON.stringify(submission).includes(requestIdCanary), false);
    assert.equal(JSON.stringify(store.listToolRequests?.("run-tool-1")).includes(runIdCanary), false);
    assert.equal(JSON.stringify(store.listToolRequests?.("run-tool-1")).includes(requestIdCanary), false);
  }
  assert.equal(calls, 0);
});

test("raw escaped identifier canaries are redacted before persistence", async () => {
  const store = runningStore();
  const runIdCanary = "escaped\nrun-id-secret\\\"";
  const requestIdCanary = "escaped\nrequest-id-secret\\\"";
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    secretValues: [runIdCanary, requestIdCanary],
    adapter: async () => {
      calls += 1;
      return result();
    },
  });

  for (const proposal of [
    { runId: runIdCanary, requestId: "safe-request-id", malformedExtra: "unknown-field" },
    { runId: "run-tool-1", requestId: requestIdCanary, malformedExtra: "unknown-field" },
  ]) {
    const submission = await gateway.submit(proposal);
    assert.equal(submission.decision.reason, "credential-boundary");
    assert.equal(submission.outcome, "not-dispatched");
    assert.equal(submission.result, null);
    assert.equal(submission.resultReference, null);
    assert.equal(JSON.stringify(submission).includes(runIdCanary), false);
    assert.equal(JSON.stringify(submission).includes(requestIdCanary), false);
    assert.equal(JSON.stringify(store.listToolRequests?.("run-tool-1")).includes(runIdCanary), false);
    assert.equal(JSON.stringify(store.listToolRequests?.("run-tool-1")).includes(requestIdCanary), false);
  }
  assert.equal(calls, 0);
});

test("unserializable malformed extras still redact secret identifiers before persistence", async () => {
  const store = runningStore();
  const runIdCanary = "unserializable-run-id-secret";
  const requestIdCanary = "unserializable-request-id-secret";
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    secretValues: [runIdCanary, requestIdCanary],
    adapter: async () => {
      calls += 1;
      return result();
    },
  });

  for (const proposal of [
    { runId: runIdCanary, requestId: "safe-request-id", malformedExtra: 1n },
    { runId: "run-tool-1", requestId: requestIdCanary, malformedExtra: 1n },
  ]) {
    const submission = await gateway.submit(proposal);
    assert.equal(submission.decision.reason, "credential-boundary");
    assert.equal(submission.outcome, "not-dispatched");
    assert.equal(submission.result, null);
    assert.equal(submission.resultReference, null);
    assert.equal(JSON.stringify(submission).includes(runIdCanary), false);
    assert.equal(JSON.stringify(submission).includes(requestIdCanary), false);
    assert.equal(JSON.stringify(store.listToolRequests?.("run-tool-1")).includes(runIdCanary), false);
    assert.equal(JSON.stringify(store.listToolRequests?.("run-tool-1")).includes(requestIdCanary), false);
  }
  assert.equal(calls, 0);
});

test("quantitative resource limits deny an oversized ledger before dispatch", async () => {
  const store = runningStore();
  let calls = 0;
  const gateway = createFinancialOverviewToolGateway({
    ledgerDir: "x".repeat(AGENT_TOOL_RESOURCE_LIMITS.maxLedgerPathBytes + 1),
    runStore: store,
    adapter: async () => {
      calls += 1;
      return result();
    },
  });
  const submission = await gateway.submit(
    createReadFinancialOverviewProposal("run-tool-1", "request-resource-limit"),
  );
  assert.equal(submission.outcome, "not-dispatched");
  assert.equal(submission.decision.reason, "resource-denied");
  assert.equal(calls, 0);
});

test("financial model processing rejects an over-limit model before projection", async () => {
  await assert.rejects(
    () => readFinancialOverviewResult("data/ledger", async () => ({
      counts: {
        normalizedTransactions: AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount + 1,
        assetPositions: 0,
        includedPositions: 0,
        duplicateNormalizedTransactions: 0,
        assetSnapshots: 0,
        auditOnlyRows: 0,
        unsupportedRows: 0,
      },
    } as never)),
    /tool-resource-limit-exceeded/,
  );
});

test("provider proposal capability has no direct execute, ledger, filesystem, network, shell, or credential authority", async () => {
  const store = runningStore();
  const gateway = createFinancialOverviewToolGateway({ runStore: store, adapter: async () => result() });
  const providerCapability = { submit: gateway.submit };
  assert.deepEqual(Object.keys(providerCapability), ["submit"]);
  assert.equal(Object.hasOwn(providerCapability, "execute"), false);
  assert.equal(Object.hasOwn(providerCapability, "readLedger"), false);
  assert.equal(Object.hasOwn(providerCapability, "readCredentials"), false);
});

test("provider capability is bound to the host run and denies wrong-run proposals in active-run lineage", async () => {
  const store = createInMemoryAgentRunStore();
  let capability: { submit(proposal: unknown): Promise<unknown> } | null = null;
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ toolGateway: toolCapability }) {
      capability = toolCapability;
    },
    cancel() {},
  };
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: createFinancialOverviewToolGateway({
      runStore: store,
      adapter: async () => result(),
    }),
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-host-a",
  });
  await service.activate();
  service.start({});
  assert.ok(capability);
  const boundCapability = capability as { submit(proposal: unknown): Promise<unknown> };
  const submission = await boundCapability.submit(
    createReadFinancialOverviewProposal("run-host-b", "wrong-run-request"),
  );
  assert.equal((submission as { outcome: string }).outcome, "not-dispatched");
  assert.equal((submission as { decision: { reason: string } }).decision.reason, "run-authority-denied");
  assert.equal(store.getToolRequest?.("run-host-b", "wrong-run-request"), null);
  const activeLineage = service.lineage("run-host-a");
  assert.deepEqual(activeLineage.map((event) => event.kind), [
    "run.started", "tool.proposal", "tool.decision", "tool.outcome",
  ]);
  assert.equal(activeLineage[1]?.runId, "run-host-a");
  assert.equal(JSON.stringify(activeLineage).includes("run-host-b"), false);
});

test("credential-bearing provider proposals are durably denied with redacted active-run lineage", async () => {
  const store = createInMemoryAgentRunStore();
  const canary = "provider-credential-canary";
  let capability: { submit(proposal: unknown): Promise<unknown> } | null = null;
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ toolGateway: toolCapability }) {
      capability = toolCapability;
    },
    cancel() {},
  };
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: createFinancialOverviewToolGateway({
      runStore: store,
      secretValues: [canary],
      adapter: async () => result(),
    }),
    secretValues: [canary],
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-provider-secret",
  });
  await service.activate();
  service.start({});
  assert.ok(capability);
  const boundCapability = capability as { submit(proposal: unknown): Promise<unknown> };
  const submission = await boundCapability.submit(
    createReadFinancialOverviewProposal("run-provider-secret", canary),
  );
  assert.equal((submission as { outcome: string }).outcome, "not-dispatched");
  assert.equal(store.getToolRequest?.("run-provider-secret", "redacted")?.outcome, "not-dispatched");
  assert.equal(JSON.stringify(service.lineage("run-provider-secret")).includes(canary), false);
});

test("outcome-unknown terminalizes the active run and records proposal, decision, and outcome lineage", async () => {
  const store = runningStore();
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => { throw new Error("dispatch lost"); },
  });
  let observedRunId = "";
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ runId, toolGateway: capability, onComplete }) {
      observedRunId = runId;
      void capability.submit(createReadFinancialOverviewProposal(runId, "request-terminal"))
        .then(() => onComplete());
    },
    cancel() {},
  };
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: gateway,
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-tool-terminal",
  });
  await service.activate();
  service.start({});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observedRunId, "run-tool-terminal");
  assert.equal(service.status(observedRunId).phase, "failed");
  assert.equal(service.status(observedRunId).toolState?.outcome, "outcome-unknown");
  assert.deepEqual(service.lineage(observedRunId).map((event) => event.kind), [
    "run.started", "tool.proposal", "tool.decision", "tool.outcome", "run.failed",
  ]);
  const toolLineage = service.lineage(observedRunId).filter((event) => event.kind.startsWith("tool."));
  assert.equal(toolLineage[0]?.tool?.proposal?.proposalVersion, "agent-tool-proposal.v1");
  assert.equal(toolLineage[1]?.tool?.decision?.decisionVersion, "agent-tool-decision.v1");
  assert.equal(toolLineage[2]?.tool?.resultReference, null);
  assert.equal(service.lineage(observedRunId).at(-1)?.transitionReason, "tool-outcome-unknown");
});

test("an in-flight completion settles after cancellation without completing or consuming the cancelled run", async () => {
  const store = createInMemoryAgentRunStore();
  let release!: (value: AgentToolResult) => void;
  let dispatchStarted!: () => void;
  const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
  let submissionDone!: () => void;
  const done = new Promise<void>((resolve) => { submissionDone = resolve; });
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ runId, toolGateway: toolCapability }) {
      void toolCapability.submit(createReadFinancialOverviewProposal(runId, "request-late-completion"))
        .finally(submissionDone);
    },
    cancel() {},
  };
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      dispatchStarted();
      return new Promise<AgentToolResult>((resolve) => { release = resolve; });
    },
  });
  const diagnostics: Array<{ kind: string }> = [];
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: gateway,
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record(event) { diagnostics.push(event); } },
    idFactory: () => "run-late-completion",
  });
  await service.activate();
  service.start({});
  await started;
  assert.equal(service.cancel("run-late-completion").phase, "cancelled");
  release(result());
  await done;
  assert.equal(service.status("run-late-completion").phase, "cancelled");
  assert.equal(service.status("run-late-completion").output, "");
  assert.equal(store.getToolRequest?.("run-late-completion", "request-late-completion")?.outcome, "completed");
  assert.deepEqual(service.lineage("run-late-completion").map((event) => event.kind), [
    "run.started", "tool.proposal", "run.cancelled", "tool.decision", "tool.outcome",
  ]);
  assert.equal(diagnostics.filter((event) => event.kind === "tool.outcome").length, 1);
  assert.equal(service.lineage("run-late-completion").some((event) => event.kind === "run.completed"), false);
});

test("a completed settlement after cancellation is withheld from the provider while durable lineage keeps its reference", async () => {
  const store = createInMemoryAgentRunStore();
  let release!: (value: AgentToolResult) => void;
  let submit!: Promise<AgentToolSubmission>;
  let resolveDispatch!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => { resolveDispatch = resolve; });
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ runId, toolGateway: toolCapability }) {
      submit = toolCapability.submit(createReadFinancialOverviewProposal(runId, "request-withhold"));
    },
    cancel() {},
  };
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => {
      resolveDispatch();
      return new Promise<AgentToolResult>((resolve) => { release = resolve; });
    },
  });
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: gateway,
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-withhold",
  });
  await service.activate();
  service.start({});
  await dispatchStarted;
  service.cancel("run-withhold");
  release(result());
  const providerSubmission = await submit;
  assert.equal((providerSubmission as { result: unknown }).result, null);
  assert.notEqual((providerSubmission as { outcome: string }).outcome, "completed");
  assert.equal((providerSubmission as { settlement: string }).settlement, "cancelled-in-flight");
  assert.equal(store.getToolRequest?.("run-withhold", "request-withhold")?.outcome, "completed");
  assert.equal(store.getToolRequest?.("run-withhold", "request-withhold")?.resultReference?.value.startsWith("immutable-result-ref.v1:"), true);
});

test("early provider completion waits for a pending tool and unknown settlement fails the run", async () => {
  const store = createInMemoryAgentRunStore();
  let rejectDispatch!: (error: Error) => void;
  let submission!: Promise<unknown>;
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ runId, toolGateway: toolCapability, onComplete }) {
      submission = toolCapability.submit(createReadFinancialOverviewProposal(runId, "request-early-complete"));
      onComplete();
    },
    cancel() {},
  };
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    adapter: async () => new Promise<AgentToolResult>((_, reject) => { rejectDispatch = reject; }),
  });
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: gateway,
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-early-complete",
  });
  await service.activate();
  service.start({});
  assert.equal(service.status("run-early-complete").phase, "running");
  rejectDispatch(new Error("dispatch lost"));
  await submission;
  assert.equal(service.status("run-early-complete").phase, "failed");
  assert.equal(service.status("run-early-complete").toolState?.outcome, "outcome-unknown");
});

test("host diagnostics carry bounded tool metadata without proposal or result payloads", async () => {
  const store = runningStore();
  const diagnostics: Array<Record<string, unknown>> = [];
  const gateway = createFinancialOverviewToolGateway({ runStore: store, adapter: async () => result() });
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ runId, toolGateway: toolCapability }) {
      void toolCapability.submit(createReadFinancialOverviewProposal(runId, "request-diagnostic"));
    },
    cancel() {},
  };
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: gateway,
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record(event) { diagnostics.push(event as unknown as Record<string, unknown>); } },
    idFactory: () => "run-diagnostic-metadata",
  });
  await service.activate();
  service.start({});
  await new Promise<void>((resolve) => setImmediate(resolve));
  const toolDiagnostic = diagnostics.find((event) => event.kind === "tool.outcome");
  assert.deepEqual(toolDiagnostic?.tool, {
    requestId: "request-diagnostic",
    toolName: "read_financial_overview",
    decision: { decisionVersion: "agent-tool-decision.v1", allowed: true, reason: "allowed" },
    outcome: "completed",
    resultReference: store.getToolRequest?.("run-diagnostic-metadata", "request-diagnostic")?.resultReference?.value,
    settlement: "normal",
  });
  assert.equal(JSON.stringify(toolDiagnostic).includes("proposal"), false);
  assert.equal(JSON.stringify(toolDiagnostic).includes("totalsByCurrency"), false);
});

test("concurrent ledger mutation is rejected after the actual adapter read", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-ledger-toctou-"));
  try {
    const store = createSqliteAgentRunStore(root, { secretValues: [] });
    store.createRun({
      runId: "run-toctou",
      analysisId: null,
      phase: "running",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: null,
      output: "",
      failureReason: null,
    });
    const gateway = createFinancialOverviewToolGateway({
      ledgerDir: root,
      runStore: store,
      adapter: async () => {
        appendFileSync(join(root, "ledger.sqlite"), "concurrent-change");
        return result();
      },
    });
    const submission = await gateway.submit(createReadFinancialOverviewProposal("run-toctou", "request-toctou"));
    assert.equal(submission.outcome, "outcome-unknown");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a never-settling adapter reaches bounded outcome-unknown after cancellation and releases late output", async () => {
  const store = createInMemoryAgentRunStore();
  let stream!: (content: string) => void;
  let dispatchStarted!: () => void;
  const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
  let submission!: Promise<unknown>;
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ runId, toolGateway: toolCapability, onStream }) {
      stream = onStream;
      submission = toolCapability.submit(createReadFinancialOverviewProposal(runId, "request-timeout"));
    },
    cancel() {},
  };
  const gateway = createFinancialOverviewToolGateway({
    runStore: store,
    executionTimeoutMs: 10,
    adapter: async () => {
      dispatchStarted();
      return new Promise<AgentToolResult>(() => {});
    },
  });
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: gateway,
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record() {} },
    idFactory: () => "run-timeout",
  });
  await service.activate();
  service.start({});
  await started;
  assert.equal(service.cancel("run-timeout").phase, "cancelled");
  stream("late continuation must be ignored");
  await submission;
  assert.equal(store.getToolRequest?.("run-timeout", "request-timeout")?.outcome, "outcome-unknown");
  assert.equal(service.status("run-timeout").phase, "cancelled");
  assert.equal(service.status("run-timeout").output, "");
});

test("a pre-submit sanitization exception still releases pending authority", async () => {
  const store = createInMemoryAgentRunStore();
  const diagnostics: unknown[] = [];
  const canary = "cyclic-provider-secret";
  let stream!: (content: string) => void;
  let submit!: (proposal: unknown) => Promise<unknown>;
  const provider: AgentProvider = {
    async activate() {
      return { availability: "available", providerIdentity: "test-provider", osBuild: "test" };
    },
    start({ toolGateway: toolCapability, onStream }) {
      submit = toolCapability.submit;
      stream = onStream;
    },
    cancel() {},
  };
  const service = createAgentHarnessService({
    helper: { launch(input) { input.provider.start(input); }, cancel() {} },
    provider,
    runStore: store,
    toolGateway: createFinancialOverviewToolGateway({
      runStore: store,
      secretValues: [canary],
      adapter: async () => result(),
    }),
    clock: { now: () => "2026-08-04T00:00:00.000Z" },
    diagnosticsSink: { record(event) { diagnostics.push(event); } },
    idFactory: () => "run-pre-submit-error",
    secretValues: [canary],
  });
  await service.activate();
  service.start({});
  const circular: Record<string, unknown> = createReadFinancialOverviewProposal(
    "run-pre-submit-error",
    "request-circular",
  );
  circular.input = circular;
  circular.runAuthority = canary;
  const submission = await submit(circular) as {
    outcome: string;
    result: unknown;
    decision: { reason: string };
  };
  assert.equal(submission.outcome, "not-dispatched");
  assert.equal(submission.result, null);
  assert.equal(submission.decision.reason, "malformed-proposal");
  const lineage = service.lineage("run-pre-submit-error");
  const proposalEvent = lineage.find((event) => event.kind === "tool.proposal");
  assert.equal(proposalEvent?.tool?.requestId, "redacted");
  assert.equal(Object.hasOwn(proposalEvent?.tool?.proposal ?? {}, "input"), false);
  assert.equal(JSON.stringify(lineage).includes(canary), false);
  assert.ok(JSON.stringify(lineage).length < 4_096);
  assert.equal(JSON.stringify(diagnostics).includes(canary), false);
  assert.ok(diagnostics.length <= 2);
  assert.equal(service.cancel("run-pre-submit-error").phase, "cancelled");
  assert.equal(service.complete("run-pre-submit-error").phase, "cancelled");
  stream("late output after pre-submit error");
  assert.equal(service.status("run-pre-submit-error").output, "");
});
