import assert from "node:assert/strict";
import test from "node:test";
import {
  createPGliteFinancialRpcClient,
  createPGliteFinancialRpcServer,
  PGliteFinancialError,
  type PGliteFinancialRegistry,
} from "./pglite-financial-registry.ts";

type Listener = (value: unknown) => void;

class MemoryPort {
  peer: MemoryPort | undefined;
  readonly listeners = new Set<Listener>();

  on(_event: "message", listener: Listener): void {
    this.listeners.add(listener);
  }

  off(_event: "message", listener: Listener): void {
    this.listeners.delete(listener);
  }

  postMessage(value: unknown): void {
    const peer = this.peer;
    if (!peer) throw new Error("memory port is disconnected");
    queueMicrotask(() => {
      for (const listener of peer.listeners) listener(value);
    });
  }
}

function memoryPair(): readonly [MemoryPort, MemoryPort] {
  const left = new MemoryPort();
  const right = new MemoryPort();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function sourceRequest(): Record<string, unknown> {
  return {
    capture: {
      captureId: "cancel-race-capture",
      integrationNamespace: "synthetic",
      sourceConnectionKey: "synthetic-connection",
      identityEpoch: "synthetic-epoch",
      stream: "synthetic-stream",
      recordKind: "synthetic-record",
      routeKey: "test",
      contractVersion: "synthetic-v1",
      subjectDigest: "synthetic-subject",
      observedAt: "2026-09-22T00:00:00.000Z",
      scope: {},
      pages: [],
      records: [],
    },
    account: {},
    transactions: [],
  };
}

test("financial cancellation waits for the terminal response and preserves commit wins", async () => {
  const [clientPort, serverPort] = memoryPair();
  let mode: "abort" | "commit" = "abort";
  let enteredResolve!: () => void;
  let entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseCommit!: () => void;
  let commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const committed = {
    status: "canonical-live",
    captureId: "cancel-race-capture",
    accountId: "account",
    commitSequence: 7,
    transactions: [],
  };
  const registry = {
    sourceCommit: async (_request: unknown, options?: { signal?: AbortSignal }) => {
      enteredResolve();
      if (mode === "abort") {
        await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("rolled back")), { once: true });
        });
      }
      else await commitGate;
      return committed;
    },
  } as unknown as PGliteFinancialRegistry;
  const server = createPGliteFinancialRpcServer(serverPort, registry);
  const client = createPGliteFinancialRpcClient(clientPort);
  try {
    const abortController = new AbortController();
    const abortRequest = client.registry.sourceCommit(sourceRequest() as never, { signal: abortController.signal });
    await entered;
    let settled = false;
    void abortRequest.then(() => { settled = true; }, () => { settled = true; });
    abortController.abort();
    await Promise.resolve();
    assert.equal(settled, false, "abort must wait for the worker's terminal response");
    await assert.rejects(
      abortRequest,
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as { code?: unknown }).code === "cancelled",
    );

    mode = "commit";
    entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const commitController = new AbortController();
    const commitRequest = client.registry.sourceCommit(sourceRequest() as never, { signal: commitController.signal });
    await entered;
    commitController.abort();
    releaseCommit();
    assert.deepEqual(await commitRequest, committed, "a commit that wins the worker race must return its receipt");
  }
  finally {
    client.close();
    await server.close();
  }
});

test("unknown financial failures remain fatal across the worker boundary", async () => {
  const [clientPort, serverPort] = memoryPair();
  const registry = {
    sourceCommit: async () => {
      throw new Error("account table missing");
    },
  } as unknown as PGliteFinancialRegistry;
  const server = createPGliteFinancialRpcServer(serverPort, registry);
  const client = createPGliteFinancialRpcClient(clientPort);
  try {
    await assert.rejects(
      client.registry.sourceCommit(sourceRequest() as never),
      (error: unknown) => error instanceof PGliteFinancialError
        && error.code === "operation-failed"
        && error.category === "fatal",
    );
  }
  finally {
    client.close();
    await server.close();
  }
});

test("an account identity continuity read crosses the workflow port only in its exact request shape", async () => {
  const evidencedNumber = "12345678901234";
  const request = {
    integrationNamespace: "fubon",
    sourceConnectionKey: `sha256:${"C".repeat(43)}`,
    identityEpochKey: `sha256:${"E".repeat(43)}`,
    stream: "domestic-deposit",
    identifier: { kind: "depository-account" as const, value: evidencedNumber },
  };
  const continued = { status: "continued", sourceAccountKey: `sha256:${"K".repeat(43)}` };
  const served: unknown[] = [];
  const registry = {
    accountIdentityContinuity: async (input: unknown) => {
      served.push(input);
      return continued;
    },
  } as unknown as PGliteFinancialRegistry;
  const [clientPort, serverPort] = memoryPair();
  const server = createPGliteFinancialRpcServer(serverPort, registry, () => undefined);
  const client = createPGliteFinancialRpcClient(clientPort);
  try {
    const { identifier: _identifier, ...withoutIdentifier } = request;
    for (const malformed of [
      withoutIdentifier,
      { ...request, identifier: { kind: "depository-account", value: "" } },
      { ...request, identifier: { ...request.identifier, label: "extra" } },
      { ...request, stream: undefined },
      { ...request, accountLabel: "extra" },
    ]) {
      await assert.rejects(
        client.registry.accountIdentityContinuity(malformed as never),
        (error: unknown) => error instanceof PGliteFinancialError && error.code === "invalid-request",
      );
    }
    assert.deepEqual(served, [], "a malformed request never reaches the store read");
    assert.deepEqual(await client.registry.accountIdentityContinuity(request), continued);
    assert.deepEqual(served, [request]);
  }
  finally {
    client.close();
    await server.close();
  }
});
