import assert from "node:assert/strict";
import test from "node:test";
import {
  createDataVersionStore,
  DataVersionMismatchError,
  withExpectedDataVersion,
} from "./data-version.ts";

test("data version advances monotonically and notifies subscribers", () => {
  const store = createDataVersionStore({
    now: () => new Date("2026-09-19T00:00:00.000Z"),
  });
  const events: unknown[] = [];
  const unsubscribe = store.subscribe((event) => events.push(event));

  assert.deepEqual(store.snapshot(), {
    version: 0,
    stale: false,
    changedAt: null,
  });
  const first = store.markStale("automation-completed");
  const second = store.markStale("automation-completed");

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(store.snapshot().version, 2);
  assert.equal(store.snapshot().stale, true);
  assert.deepEqual(events, [first, second]);

  unsubscribe();
  store.markStale("automation-completed");
  assert.equal(events.length, 2);
});

test("acknowledging an old version cannot hide a newer invalidation", () => {
  const store = createDataVersionStore();
  const first = store.markStale("automation-completed");

  assert.equal(store.acknowledge(first.version), true);
  assert.equal(store.snapshot().stale, false);

  const second = store.markStale("automation-completed");
  assert.equal(store.acknowledge(first.version), false);
  assert.equal(store.snapshot().version, second.version);
  assert.equal(store.snapshot().stale, true);
  assert.equal(store.acknowledge(second.version), true);
  assert.equal(store.snapshot().stale, false);
});

test("a renderer can query a missed invalidation after it reconnects", () => {
  const store = createDataVersionStore();
  const initial = store.snapshot();
  store.markStale("automation-completed");

  const afterReconnect = store.snapshot();
  assert.equal(afterReconnect.version > initial.version, true);
  assert.equal(afterReconnect.stale, true);
});

test("a read is rejected when its expected generation advances during the read", async () => {
  let version = 4;

  await assert.rejects(
    withExpectedDataVersion(
      4,
      () => ({
        version,
        stale: version !== 4,
        changedAt: version === 4 ? null : "2026-09-19T00:00:01.000Z",
      }),
      async () => {
        version = 5;
        return { version: 4 };
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof DataVersionMismatchError);
      assert.equal(error.expectedVersion, 4);
      assert.equal(error.actualVersion, 5);
      return true;
    },
  );
});
