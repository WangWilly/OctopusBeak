import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { DashboardBlockKey } from "../lib/shared-shell/block-load-state.ts";
import type { DashboardBlockPayload } from "../lib/shared-shell/dashboard-blocks.ts";
import type { DataReadOptions } from "../lib/shared-shell/data-version.ts";
import { RefreshLoadError } from "../lib/shared-shell/refresh-coordinator.ts";
import { automationRouteModel, createAutomationRouteLoader } from "./automation-route-loader.ts";

type Call = { key: DashboardBlockKey; options: DataReadOptions | undefined; resolve(payload: DashboardBlockPayload): void; reject(error: Error): void };

function payload(block: DashboardBlockKey, tag: string, revision = 1): DashboardBlockPayload {
  return {
    route: "automation",
    block,
    data: {
      automation: { tag },
      credentialGroups: block === "summary" ? undefined : [{ id: `${tag}-group` }],
      runtimeSessionId: "session-1",
      runtimeRevision: revision,
    },
  } as unknown as DashboardBlockPayload;
}

function harness(revision = 1) {
  const calls: Call[] = [];
  let currentRevision = revision;
  const loader = createAutomationRouteLoader({
    loadBlock: (key, options) => new Promise((resolve, reject) => { calls.push({ key, options, resolve, reject }); }),
    runtime: () => ({ sessionId: "session-1", revision: currentRevision }) as never,
  });
  const resolveAll = (tag: string, from = 0, revisionOf = () => 1) => {
    for (const call of calls.slice(from)) call.resolve(payload(call.key, tag, revisionOf()));
  };
  return { loader, calls, resolveAll, setRevision: (next: number) => { currentRevision = next; } };
}

const flush = () => new Promise((done) => setImmediate(done));
const tagOf = (model: unknown) => (model as { automation: { tag: string } } | undefined)?.automation.tag;

test("a first read loads every block, renders them as they arrive, and caches the route", async () => {
  const { loader, calls } = harness();
  const loading = loader.load();
  assert.deepEqual(calls.map((call) => call.key), ["summary", "list", "details"]);
  calls[0]!.resolve(payload("summary", "summary"));
  await flush();
  assert.equal(tagOf(automationRouteModel(get(loader.state))), "summary", "the summary renders before the others arrive");
  calls[1]!.resolve(payload("list", "list"));
  calls[2]!.resolve(payload("details", "details"));
  assert.equal(tagOf(await loading), "details", "details win over list and summary");
  assert.equal(get(loader.state).view.status, "ready");
  assert.equal(tagOf(await loader.load()), "details");
  assert.equal(calls.length, 3, "an unforced read reuses the cached route");
});

test("a newer read drops an older read's late blocks", async () => {
  const { loader, calls } = harness();
  const older = loader.load();
  // A forced read while the route read is pending joins it, so both settle with the older read.
  const newer = loader.load({ force: true });
  calls.slice(3).forEach((call) => call.resolve(payload(call.key, "new")));
  await flush();
  calls.slice(0, 3).forEach((call) => call.resolve(payload(call.key, "old")));
  await Promise.all([older, newer]);
  await flush();
  for (const key of ["summary", "list", "details"]) {
    const state = get(loader.state).blocks[key];
    assert.equal(state && "data" in state ? tagOf(state.data?.data) : null, "new", key);
  }
});

test("an unforced read joins the block read already in flight instead of starting another", async () => {
  const { loader, calls, resolveAll } = harness();
  const first = loader.load();
  const second = loader.load();
  assert.equal(calls.length, 3);
  resolveAll("only");
  assert.equal(tagOf(await first), "only");
  assert.equal(tagOf(await second), "only");
});

test("a block older than the runtime starts one refresh after its read settles, and that refresh's stale blocks start none", async () => {
  const { loader, calls } = harness(5);
  const loading = loader.load();
  calls.slice(0, 3).forEach((call) => call.resolve(payload(call.key, "stale", 4)));
  await loading;
  await flush();
  assert.equal(calls.length, 6, "the stale read is followed by one refresh of every block");
  calls.slice(3).forEach((call) => call.resolve(payload(call.key, "still-stale", 4)));
  await flush();
  await flush();
  assert.ok(calls.length <= 9, "at most one trailing read follows");
  calls.slice(6).forEach((call) => call.resolve(payload(call.key, "still-stale", 4)));
  await flush();
  await flush();
  assert.ok(calls.length <= 9, "a trailing read's stale blocks start no further read");
});

test("a block as new as the runtime starts no refresh", async () => {
  const { loader, calls } = harness(5);
  const loading = loader.load();
  calls.forEach((call) => call.resolve(payload(call.key, "fresh", 5)));
  await loading;
  await flush();
  assert.equal(calls.length, 3);
});

test("a refresh read carries the snapshot's version and asks for fresh credentials", async () => {
  const { loader, calls, resolveAll } = harness();
  const loading = loader.load({ force: true, refreshCredentials: true, snapshot: { version: 7 } as never });
  resolveAll("v7");
  await loading;
  assert.deepEqual(calls.map((call) => call.options), Array(3).fill({ expectedVersion: 7, refreshCredentials: true }));
});

test("awaiting the blocks rejects with the failed block keys and leaves the route in error", async () => {
  const { loader, calls } = harness();
  const loading = loader.load({ force: true, awaitBlocks: true, rethrow: true });
  calls[0]!.resolve(payload("summary", "s"));
  calls[1]!.reject(new Error("list down"));
  calls[2]!.resolve(payload("details", "d"));
  await assert.rejects(loading, (error: unknown) =>
    error instanceof RefreshLoadError && (error as RefreshLoadError & { failedKeys: string[] }).failedKeys.join() === "automation:list");
  assert.equal(get(loader.state).view.status, "error");
  assert.equal(get(loader.state).blocks.list?.status, "error");
});

test("a failed read resolves undefined unless asked to rethrow", async () => {
  const { loader, calls } = harness();
  const loading = loader.load();
  calls.forEach((call) => call.reject(new Error("down")));
  assert.equal(await loading, undefined);
  assert.equal(get(loader.state).view.status, "error");
});

test("retry rereads the whole route before it has loaded, and only its block afterwards", async () => {
  const { loader, calls, resolveAll } = harness();
  loader.retry("list");
  assert.deepEqual(calls.map((call) => call.key), ["summary", "list", "details"], "nothing loaded yet");
  resolveAll("first");
  await flush();
  await flush();
  loader.retry("details");
  assert.deepEqual(calls.slice(3).map((call) => [call.key, call.options]), [["details", { refreshCredentials: true }]]);
  loader.retry("summary");
  assert.deepEqual(calls.slice(4).map((call) => [call.key, call.options]), [["summary", undefined]]);
});
