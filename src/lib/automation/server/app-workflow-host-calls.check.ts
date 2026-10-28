import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createHostCallClient,
  createHostCallDispatcher,
  HOST_CALL_CONTRACTS,
  HostCallRefusal,
  type HostCallHandlers,
} from "./app-workflow-host-calls.ts";
import {
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  type HostCallFrame,
  type HostCallReplyFrame,
} from "./app-workflow-worker-protocol.ts";

const RUN_ID = "host-call-run";
const event = {
  runId: RUN_ID,
  stage: "collection",
  outcome: "advanced",
  code: "progress-update",
  occurredAt: "2026-10-28T00:00:00.000Z",
} as const;
const attempt = { phase: "started", attemptId: "attempt-1", product: null, total: 1 } as const;
const session = { tokenId: "token", richUrl: null, issuedAt: "2026-10-28T00:00:00Z" } as const;

const call = (method: string, request: unknown, callId: string = randomUUID()): HostCallFrame => ({
  protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION, kind: "call", callId, method, request,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function dispatcher(handlers: HostCallHandlers) {
  const stop = new AbortController();
  const replies: HostCallReplyFrame[] = [];
  let failures = 0;
  let settled = false;
  const channel = createHostCallDispatcher({
    handlers,
    signal: stop.signal,
    stopping: () => stop.signal.aborted,
    settled: () => settled,
    post: (frame) => replies.push(frame),
    protocolFailure: () => { failures += 1; },
  });
  return {
    channel,
    replies,
    stop: () => stop.abort(),
    settle: () => { settled = true; },
    failures: () => failures,
  };
}

test("every request contract names a lane and a cap, and only acknowledgements answer with a failure code", () => {
  for (const [method, contract] of Object.entries(HOST_CALL_CONTRACTS)) {
    if (contract.kind === "notify") continue;
    assert.ok(contract.maxPerRun > 0, `${method} has a cap`);
    if (contract.failureCode) assert.equal(contract.lane, "acknowledged", `${method} acknowledges`);
  }
  assert.equal(HOST_CALL_CONTRACTS.commitAttempt.kind === "request" && HOST_CALL_CONTRACTS.commitAttempt.duringStop, "answer");
});

test("an event is answered only after its handler resolves", async () => {
  const persisted = deferred();
  const host = dispatcher({ event: () => persisted.promise });
  const frame = call("event", { event });
  host.channel.receive(frame);
  await settle();
  assert.deepEqual(host.replies, []);
  assert.equal(host.channel.idle(), false);
  persisted.resolve();
  await settle();
  assert.deepEqual(host.replies, [{ protocolVersion: 3, kind: "reply", callId: frame.callId, ok: true, result: null }]);
  assert.equal(host.channel.idle(), true);
});

test("a failed acknowledgement answers with its failure code; a refused or code-less one is a protocol failure", async () => {
  const host = dispatcher({
    event: async () => { throw new Error("database down"); },
    tdccSession: () => { throw new Error("store unavailable"); },
  });
  const frame = call("event", { event });
  host.channel.receive(frame);
  await settle();
  assert.deepEqual(host.replies, [{ protocolVersion: 3, kind: "reply", callId: frame.callId, ok: false, code: "event-persistence-failed" }]);
  host.channel.receive(call("tdccSession", { operation: "open" }));
  await settle();
  assert.equal(host.failures(), 1);

  const refusing = dispatcher({ event: () => { throw new HostCallRefusal(); } });
  refusing.channel.receive(call("event", { event }));
  await settle();
  assert.equal(refusing.failures(), 1);
  assert.deepEqual(refusing.replies, []);
});

test("an invalid request, an unknown method, a repeated call id or a method without a handler is a protocol failure", async () => {
  const host = dispatcher({ event: async () => undefined });
  host.channel.receive(call("event", { event: { ...event, code: "Not A Code" } }));
  host.channel.receive(call("launchMissiles", {}));
  host.channel.receive(call("humanAssistance", { contract: {} }));
  host.channel.receive(call("tdccSession", { operation: "open" }));
  const frame = call("event", { event });
  host.channel.receive(frame);
  await settle();
  host.channel.receive(frame);
  assert.equal(host.failures(), 5);
  assert.equal(host.replies.length, 1);
});

test("a call in a busy lane, or past its method's cap, is a protocol failure", async () => {
  const persisted = deferred();
  const host = dispatcher({ event: () => persisted.promise, commitAttempt: async () => undefined, tdccSession: () => ({ status: "device-registration-required" }) });
  host.channel.receive(call("event", { event }));
  host.channel.receive(call("commitAttempt", { attempt }));
  assert.equal(host.failures(), 1, "event and commit attempt share the acknowledged lane");
  persisted.resolve();
  await settle();
  for (let index = 0; index < 9; index += 1) {
    host.channel.receive(call("tdccSession", { operation: "open" }));
    await settle();
  }
  assert.equal(host.failures(), 2, "the ninth TDCC session request passes the cap");
});

test("a stop abandons a drop call unanswered and frees its lane, while a commit attempt is still answered", async () => {
  const persisted = deferred();
  const recorded = deferred();
  const host = dispatcher({ event: () => persisted.promise, commitAttempt: () => recorded.promise });
  host.channel.receive(call("event", { event }));
  host.stop();
  host.channel.receive(call("event", { event }));
  const commit = call("commitAttempt", { attempt });
  host.channel.receive(commit);
  persisted.resolve();
  recorded.resolve();
  await settle();
  assert.equal(host.failures(), 0);
  assert.deepEqual(host.replies, [{ protocolVersion: 3, kind: "reply", callId: commit.callId, ok: true, result: null }]);
});

test("an answer that fails its contract is never sent", async () => {
  const host = dispatcher({
    tdccSession: () => ({ status: "ready", details: { userId: "user", password: "secret", extra: "leak" } }) as never,
  });
  host.channel.receive(call("tdccSession", { operation: "sign-in-details" }));
  await settle();
  assert.deepEqual(host.replies, []);
  assert.equal(host.failures(), 1);
});

test("nothing is answered once the run is settled", async () => {
  const recorded = deferred();
  const host = dispatcher({ commitAttempt: () => recorded.promise });
  host.channel.receive(call("commitAttempt", { attempt }));
  host.settle();
  recorded.resolve();
  await settle();
  assert.deepEqual(host.replies, []);
});

test("a notification keeps only the newest value and is written at close even when the run stops first", async () => {
  const saved: unknown[] = [];
  const host = dispatcher({ tdccSessionRotated: ({ session: rotated }) => { saved.push(rotated.tokenId); } });
  host.channel.receive(call("tdccSessionRotated", { session: { ...session, tokenId: "first" } }));
  host.channel.receive(call("tdccSessionRotated", { session: { ...session, tokenId: "second" } }));
  host.stop();
  host.channel.receive(call("tdccSessionRotated", { session: { ...session, tokenId: "third" } }));
  host.channel.close();
  assert.deepEqual(saved, ["third"]);
  assert.deepEqual(host.replies, []);
});

function client() {
  const controller = new AbortController();
  const sent: HostCallFrame[] = [];
  let failures = 0;
  const channel = createHostCallClient({
    post: (frame) => sent.push(frame),
    signal: controller.signal,
    abortError: () => new Error("cancelled"),
    protocolFailure: () => { failures += 1; },
  });
  const reply = (frame: HostCallFrame, result: unknown = null) =>
    channel.receive({ protocolVersion: 3, kind: "reply", callId: frame.callId, ok: true, result });
  return { channel, sent, reply, abort: () => controller.abort(), failures: () => failures };
}

test("the client sends calls in one lane one at a time, and other lanes beside them", async () => {
  const worker = client();
  const first = worker.channel.call("event", { event });
  const second = worker.channel.call("commitAttempt", { attempt });
  const lease = worker.channel.call("tdccSession", { operation: "open" });
  await settle();
  assert.deepEqual(worker.sent.map(({ method }) => method), ["event", "tdccSession"]);
  worker.reply(worker.sent[0]!);
  await first;
  await settle();
  assert.deepEqual(worker.sent.map(({ method }) => method), ["event", "tdccSession", "commitAttempt"]);
  worker.reply(worker.sent[2]!);
  worker.reply(worker.sent[1]!, { status: "device-registration-required" });
  await second;
  assert.deepEqual(await lease, { status: "device-registration-required" });
});

test("a failure code rejects the call with that code", async () => {
  const worker = client();
  const pending = worker.channel.call("event", { event });
  await settle();
  worker.channel.receive({ protocolVersion: 3, kind: "reply", callId: worker.sent[0]!.callId, ok: false, code: "event-persistence-failed" });
  await assert.rejects(pending, /event-persistence-failed/u);
  assert.equal(worker.failures(), 0);
});

test("an uncorrelated reply, an invalid result or a foreign failure code is a protocol failure", async () => {
  const worker = client();
  worker.channel.receive({ protocolVersion: 3, kind: "reply", callId: randomUUID(), ok: true, result: null });
  const lease = worker.channel.call("tdccSession", { operation: "sign-in-details" });
  const assistance = worker.channel.call("humanAssistance", { contract: {} as never });
  await settle();
  worker.reply(worker.sent[0]!, { status: "ready", details: { userId: "" } });
  worker.channel.receive({ protocolVersion: 3, kind: "reply", callId: worker.sent[1]!.callId, ok: false, code: "event-persistence-failed" });
  await assert.rejects(lease);
  await assert.rejects(assistance);
  assert.equal(worker.failures(), 3);
});

test("an abort rejects drop calls at once but a commit attempt waits until the client closes", async () => {
  const worker = client();
  const assistance = worker.channel.call("humanAssistance", { contract: {} as never });
  const commit = worker.channel.call("commitAttempt", { attempt });
  await settle();
  worker.abort();
  await assert.rejects(assistance, /cancelled/u);
  let commitSettled = false;
  void commit.finally(() => { commitSettled = true; }).catch(() => undefined);
  await assert.rejects(worker.channel.call("tdccSession", { operation: "open" }), /cancelled/u);
  await settle();
  assert.equal(commitSettled, false);
  worker.channel.close();
  await assert.rejects(commit, /cancelled/u);
});
