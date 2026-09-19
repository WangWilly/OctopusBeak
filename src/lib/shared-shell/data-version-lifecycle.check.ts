import assert from "node:assert/strict";
import test from "node:test";
import type { DataInvalidationEvent, DataVersionSnapshot } from "./data-version.ts";
import { installDataVersionLifecycle } from "./data-version-lifecycle.ts";

class FakeEventTarget {
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const staleSnapshot: DataVersionSnapshot = {
  version: 2,
  stale: true,
  changedAt: "2026-09-19T00:00:02.000Z",
};

const invalidation: DataInvalidationEvent = {
  version: 2,
  reason: "automation-completed",
  changedAt: staleSnapshot.changedAt!,
};

test("subscribes before the initial version query and cleans up lifecycle listeners", async () => {
  const events: string[] = [];
  let notify: ((event: DataInvalidationEvent) => void) | undefined;
  let resolveQuery!: (snapshot: DataVersionSnapshot) => void;
  const query = new Promise<DataVersionSnapshot>((resolve) => {
    resolveQuery = resolve;
  });
  const source = new FakeEventTarget();
  const snapshots: DataVersionSnapshot[] = [];

  const lifecycle = installDataVersionLifecycle({
    resumeTarget: source,
    visibilityTarget: source,
    isVisible: () => true,
    data: {
      onInvalidated(listener) {
        events.push("subscribe");
        notify = listener;
        return () => events.push("unsubscribe");
      },
      getVersion() {
        events.push("query");
        return query;
      },
    },
    onInvalidated: () => {},
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  assert.deepEqual(events.slice(0, 2), ["subscribe", "query"]);
  notify?.(invalidation);
  resolveQuery(staleSnapshot);
  await lifecycle.check();
  assert.deepEqual(snapshots, [staleSnapshot]);

  lifecycle.dispose();
  source.emit("focus");
  source.emit("visibilitychange");
  assert.deepEqual(events, ["subscribe", "query", "unsubscribe"]);
});

test("dedupes focus and visible checks while a version query is pending", async () => {
  const source = new FakeEventTarget();
  let resolveQuery!: (snapshot: DataVersionSnapshot) => void;
  let queryCount = 0;
  const snapshots: DataVersionSnapshot[] = [];
  const lifecycle = installDataVersionLifecycle({
    resumeTarget: source,
    visibilityTarget: source,
    isVisible: () => true,
    data: {
      onInvalidated: () => () => {},
      getVersion: () => {
        queryCount += 1;
        return new Promise<DataVersionSnapshot>((resolve) => {
          resolveQuery = resolve;
        });
      },
    },
    onInvalidated: () => {},
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  source.emit("focus");
  source.emit("pageshow");
  source.emit("visibilitychange");
  assert.equal(queryCount, 1);
  resolveQuery(staleSnapshot);
  await lifecycle.check();
  assert.deepEqual(snapshots, [staleSnapshot]);

  lifecycle.dispose();
});

test("visibility checks do not run while hidden but resume checks do not fetch route data", async () => {
  const source = new FakeEventTarget();
  let visible = false;
  let queryCount = 0;
  const snapshots: DataVersionSnapshot[] = [];
  const lifecycle = installDataVersionLifecycle({
    resumeTarget: source,
    visibilityTarget: source,
    isVisible: () => visible,
    data: {
      onInvalidated: () => () => {},
      getVersion: async () => {
        queryCount += 1;
        return staleSnapshot;
      },
    },
    onInvalidated: () => {},
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  await lifecycle.check();
  assert.equal(queryCount, 1);
  source.emit("visibilitychange");
  await Promise.resolve();
  assert.equal(queryCount, 1);
  visible = true;
  source.emit("visibilitychange");
  await lifecycle.check();
  assert.equal(queryCount, 2);
  assert.equal(snapshots.every((snapshot) => snapshot.stale), true);

  lifecycle.dispose();
});
