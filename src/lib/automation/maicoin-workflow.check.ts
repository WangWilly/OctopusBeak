import assert from "node:assert/strict";
import test from "node:test";
import { createMaicoinWorkflow } from "./maicoin-workflow.ts";
import { strictSourceText } from "./source-text.ts";
import {
  createWorkflowExecutor,
  type WorkflowExecutorPorts,
  type WorkflowRunEvent,
} from "./workflow-executor.ts";
import { taskById } from "./server/tasks.ts";

const PROVIDER_DATE = "Wed, 02 Sep 2026 04:05:06 GMT";

function response(body: unknown, date: string | null = PROVIDER_DATE) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: date === null ? {} : { Date: date },
  });
}

function validMaxFetch(options: { missingWalletDate?: "spot" | "m" } = {}) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/api/v3/info") {
      return response({ email: "owner@example.test", m_wallet_enabled: true });
    }
    if (url.pathname === "/api/v3/markets") {
      return response([
        { id: "btctwd", base_unit: "btc", quote_unit: "twd", status: "enabled" },
      ]);
    }
    if (url.pathname === "/api/v3/tickers") {
      return response([{ market: "btctwd", at: 1_788_333_906, last: "2500000" }]);
    }
    const account = url.pathname.match(/^\/api\/v3\/wallet\/(spot|m)\/accounts$/u);
    if (account) {
      const missingDate = options.missingWalletDate === account[1];
      return response([
        { currency: "BTC", balance: "1.25", locked: "0", staked: "0" },
      ], missingDate ? null : PROVIDER_DATE);
    }
    if (url.pathname.endsWith("/trades")
      || url.pathname.startsWith("/api/v3/fund_transactions/")
      || url.pathname === "/api/v3/rewards"
      || url.pathname === "/api/v3/converts") {
      return response([]);
    }
    throw new Error(`Unexpected MAX endpoint: ${url.pathname}`);
  };
}

function ports(options: {
  events: WorkflowRunEvent[];
  commits: unknown[][];
  records: { started: unknown[]; snapshots: unknown[]; statements: unknown[]; finished: unknown[] };
}): WorkflowExecutorPorts {
  return {
    browser: { withPage: async () => { throw new Error("MaiCoin must not use a browser."); } },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("MaiCoin must not request assistance."); } },
    financialCommit: {
      async execute(items, commitOptions) {
        const received = [];
        for await (const item of items) received.push(item);
        options.commits.push(received);
        commitOptions?.signal?.throwIfAborted();
        return {
          status: "completed",
          items: received.map((item) => ({
            itemKey: item.itemKey,
            provider: item.provider,
            product: item.product,
            status: "committed" as const,
            admissionSummaries: [],
            value: {},
            relationWarnings: [],
          })),
          diagnostics: [],
          committedCount: received.length,
          failedCount: 0,
        };
      },
    },
    maicoinPersistence: {
      async startRun(value) { options.records.started.push(value); },
      async appendSnapshots(value) { options.records.snapshots.push(...value); },
      async appendStatementRows(value) { options.records.statements.push(...value); },
      async finishRun(value) { options.records.finished.push(value); },
    },
    events: { async append(event) { options.events.push(event); } },
    now: () => "2026-09-25T00:00:00.000Z",
  };
}

function createRun(executorPorts: WorkflowExecutorPorts) {
  return createWorkflowExecutor([createMaicoinWorkflow()], executorPorts);
}

test("MaiCoin executes through injected commit and operational ports without file outputs", async () => {
  const originalFetch = globalThis.fetch;
  const state = {
    events: [] as WorkflowRunEvent[],
    commits: [] as unknown[][],
    records: { started: [], snapshots: [], statements: [], finished: [] } as {
      started: unknown[]; snapshots: unknown[]; statements: unknown[]; finished: unknown[];
    },
  };
  try {
    globalThis.fetch = validMaxFetch() as typeof fetch;
    const executor = createRun(ports(state));
    const result = await executor.run("sync-maicoin", "maicoin-run-1", {
      credentials: {
        accessKey: "secret-access",
        secretKey: "secret-key",
        subAccount: "main",
      },
    }, new AbortController().signal) as Record<string, unknown>;

    assert.equal(result.status, "completed");
    assert.equal(result.statementRows, 0);
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0]?.length, 2);
    assert.equal(state.records.started.length, 1);
    assert.equal(state.records.snapshots.length, 2);
    assert.equal(state.records.finished.length, 1);
    assert.deepEqual(state.events.map((event) => event.code), [
      "run-started",
      "authenticating",
      "collecting-wallets",
      "wallets-collected",
      "collecting-statements",
      "statements-collected",
      "source-complete",
      "canonical-commit-started",
      "canonical-commit-completed",
      "operational-records-persisted",
      "run-completed",
    ]);
    assert.equal(JSON.stringify(state.records).includes("secret-access"), false);
    assert.equal(JSON.stringify(state.records).includes("secret-key"), false);
    assert.deepEqual(taskById("sync-maicoin")?.command, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incomplete MAX wallet source is rejected before Canonical Financial Commit", async () => {
  const originalFetch = globalThis.fetch;
  const state = {
    events: [] as WorkflowRunEvent[],
    commits: [] as unknown[][],
    records: { started: [], snapshots: [], statements: [], finished: [] } as {
      started: unknown[]; snapshots: unknown[]; statements: unknown[]; finished: unknown[];
    },
  };
  try {
    globalThis.fetch = validMaxFetch({ missingWalletDate: "m" }) as typeof fetch;
    await assert.rejects(() => createRun(ports(state)).run(
      "sync-maicoin",
      "maicoin-run-incomplete",
      { credentials: { accessKey: "a", secretKey: "b", subAccount: "main" } },
      new AbortController().signal,
    ));
    assert.equal(state.commits.length, 0);
    assert.equal(state.records.snapshots.length, 0);
    assert.equal(state.records.finished.length, 1);
    assert.equal(state.events.some((event) => event.code === "source-rejected"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canonical commit errors are reduced to a stable code in operational state and events", async () => {
  const originalFetch = globalThis.fetch;
  const state = {
    events: [] as WorkflowRunEvent[],
    commits: [] as unknown[][],
    records: { started: [], snapshots: [], statements: [], finished: [] } as {
      started: unknown[]; snapshots: unknown[]; statements: unknown[]; finished: unknown[];
    },
  };
  try {
    globalThis.fetch = validMaxFetch() as typeof fetch;
    const executorPorts: WorkflowExecutorPorts = {
      ...ports(state),
      financialCommit: {
        async execute() {
          throw new Error("sensitive provider response");
        },
      },
    };
    await assert.rejects(() => createRun(executorPorts).run(
      "sync-maicoin",
      "maicoin-run-commit-failure",
      { credentials: { accessKey: "a", secretKey: "b", subAccount: "main" } },
      new AbortController().signal,
    ));
    assert.equal(state.records.snapshots.length, 0);
    assert.deepEqual(
      (state.records.finished[0] as { record: { errorCode: string } }).record.errorCode,
      "canonical-commit-failed",
    );
    assert.equal(state.events.some((event) => event.code === "canonical-commit-failed"), true);
    assert.equal(JSON.stringify(state.records).includes("sensitive provider response"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MaiCoin cancellation aborts MAX requests, skips commit, and records cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const state = {
    events: [] as WorkflowRunEvent[],
    commits: [] as unknown[][],
    records: { started: [], snapshots: [], statements: [], finished: [] } as {
      started: unknown[]; snapshots: unknown[]; statements: unknown[]; finished: unknown[];
    },
  };
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  try {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/v3/info") return response({ email: "owner@example.test" });
      if (url.pathname === "/api/v3/wallet/spot/accounts") {
        requestStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return response([]);
    }) as typeof fetch;
    const running = createRun(ports(state)).run("sync-maicoin", "maicoin-run-cancel", {
      credentials: { accessKey: "a", secretKey: "b", subAccount: "main" },
    }, controller.signal);
    await started;
    controller.abort(new Error("test cancellation"));
    await assert.rejects(running);
    assert.equal(state.commits.length, 0);
    assert.deepEqual((state.records.finished[0] as { record: { status: string } }).record.status, "cancelled");
    assert.equal(state.events.some((event) => event.code === "run-cancelled"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
