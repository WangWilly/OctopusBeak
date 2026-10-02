import assert from "node:assert/strict";
import test from "node:test";
import { createSpendingPageReader } from "./page-reader.ts";

test("concurrent stale reads refresh once and never retry a blocked version", async () => {
  let refreshes = 0;
  let finish!: () => void;
  const reader = createSpendingPageReader(() => {
    refreshes += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  reader.observe(1);
  const first = reader.read(1, async () => ({ stale: true as const, knowledgeAt: 2 }));
  const second = reader.read(1, async () => ({ stale: true as const, knowledgeAt: 2 }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  let requests = 0;
  assert.equal(await reader.read(1, async () => { requests += 1; return { rows: [] }; }), null);
  assert.equal(requests, 0);
  reader.observe(2);
  finish();
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.deepEqual(await reader.read(2, async () => ({ rows: ["new"] })), { rows: ["new"] });
});

test("a newer live summary suppresses obsolete responses and unnecessary recovery", async () => {
  let refreshes = 0;
  const reader = createSpendingPageReader(async () => { refreshes += 1; });
  reader.observe(1);
  let finish!: (value: { rows: string[] }) => void;
  const pending = reader.read<{ rows: string[] }>(1, () => new Promise((resolve) => { finish = resolve; }));
  reader.observe(2);
  finish({ rows: ["old"] });
  assert.equal(await pending, null);
  assert.equal(refreshes, 0);
});

test("unexpected errors propagate and recovery failure cannot spin on the old version", async () => {
  const reader = createSpendingPageReader(async () => { throw new Error("refresh failed"); });
  reader.observe(1);
  await assert.rejects(reader.read(1, async () => { throw new Error("query failed"); }), /query failed/);
  await assert.rejects(reader.read(1, async () => ({ stale: true as const, knowledgeAt: 2 })), /refresh failed/);
  assert.equal(await reader.read(1, async () => { throw new Error("must not run"); }), null);
});
