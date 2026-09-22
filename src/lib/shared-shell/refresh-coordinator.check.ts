import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshCoordinator, RefreshLoadError } from "./refresh-coordinator.ts";

test("refreshes the current page first, fans out the rest, and shares one snapshot", async () => {
  const events: string[] = [];
  const snapshots: unknown[] = [];
  let releaseCurrent!: () => void;
  const currentReleased = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  let snapshotReads = 0;
  let acknowledgements = 0;
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => {
      snapshotReads += 1;
      return { version: 7, stale: true, changedAt: "2026-09-19T00:00:00.000Z" };
    },
    acknowledgeSnapshot: async (version) => {
      assert.equal(version, 7);
      acknowledgements += 1;
      return true;
    },
    loaders: {
      overview: async (snapshot) => {
        events.push("overview:start");
        snapshots.push(snapshot);
        await currentReleased;
        events.push("overview:end");
        return "overview-data";
      },
      assets: async (snapshot) => {
        events.push("assets:start");
        snapshots.push(snapshot);
        return "assets-data";
      },
      spending: async (snapshot) => {
        events.push("spending:start");
        snapshots.push(snapshot);
        throw new Error("spending unavailable");
      },
    },
  });

  const first = coordinator.refresh("overview");
  const duplicate = coordinator.refresh("overview");
  assert.strictEqual(duplicate, first, "in-flight refreshes are deduplicated");
  await Promise.resolve();
  assert.deepEqual(events, ["overview:start"]);

  releaseCurrent();
  const result = await first;
  assert.deepEqual(events, [
    "overview:start",
    "overview:end",
    "assets:start",
    "spending:start",
  ]);
  assert.equal(snapshotReads, 2, "a partial round checks whether its snapshot became outdated");
  assert.equal(new Set(snapshots).size, 1, "all loaders receive the same snapshot");
  assert.deepEqual(result.successful, ["overview", "assets"]);
  assert.deepEqual(result.failed, ["spending"]);
  assert.equal(result.status, "partial");
  assert.equal(acknowledgements, 0, "partial refreshes stay stale");
});

test("a successful refresh acknowledges its snapshot and can run again afterwards", async () => {
  let calls = 0;
  let snapshotReads = 0;
  let acknowledgements = 0;
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => {
      snapshotReads += 1;
      return { version: snapshotReads, stale: true, changedAt: null };
    },
    acknowledgeSnapshot: async () => {
      acknowledgements += 1;
      return true;
    },
    loaders: {
      overview: async () => {
        calls += 1;
        return calls;
      },
    },
  });

  assert.equal((await coordinator.refresh("overview")).status, "complete");
  assert.equal((await coordinator.refresh("overview")).status, "complete");
  assert.equal(calls, 2);
  assert.equal(snapshotReads, 2);
  assert.equal(acknowledgements, 2);
});

test("one refresh click finishes on the latest version when data changes mid-refresh", async () => {
  let currentVersion = 1;
  let stale = true;
  const loadedVersions: number[] = [];
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => ({ version: currentVersion, stale, changedAt: null }),
    acknowledgeSnapshot: async (version) => {
      if (version !== currentVersion) return false;
      stale = false;
      return true;
    },
    loaders: {
      overview: async (snapshot) => {
        loadedVersions.push(snapshot.version);
        if (snapshot.version === 1) currentVersion = 2;
        return `overview-${snapshot.version}`;
      },
    },
  });

  const result = await coordinator.refresh("overview");
  assert.equal(result.status, "complete");
  assert.equal(stale, false, "refresh completion should clear the stale prompt");
  assert.deepEqual(loadedVersions, [1, 2], "the click should reload the newest generation");
  assert.equal(result.values.overview, "overview-2");
});

test("a version change during a failed read retries instead of leaving a stale partial result", async () => {
  let currentVersion = 1;
  let stale = true;
  const loadedVersions: number[] = [];
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => ({ version: currentVersion, stale, changedAt: null }),
    acknowledgeSnapshot: async (version) => {
      if (version !== currentVersion) return false;
      stale = false;
      return true;
    },
    loaders: {
      overview: async (snapshot) => {
        loadedVersions.push(snapshot.version);
        if (snapshot.version === 1) {
          currentVersion = 2;
          throw new Error("Data version advanced while reading");
        }
        return "latest-overview";
      },
    },
  });

  const result = await coordinator.refresh("overview");
  assert.equal(result.status, "complete");
  assert.equal(result.acknowledged, true);
  assert.deepEqual(loadedVersions, [1, 2]);
  assert.equal(result.values.overview, "latest-overview");
});

test("continuous invalidation stops after a bounded number of rounds", async () => {
  let version = 1;
  const loadedVersions: number[] = [];
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => ({ version, stale: true, changedAt: null }),
    acknowledgeSnapshot: async () => false,
    loaders: {
      overview: async (snapshot) => {
        loadedVersions.push(snapshot.version);
        version += 1;
        return snapshot.version;
      },
    },
  });

  const result = await coordinator.refresh("overview");
  assert.deepEqual(loadedVersions, [1, 2, 3]);
  assert.equal(result.acknowledged, false);
  assert.equal(result.snapshot.version, 3);
});

test("a route loader can keep refresh pending until all independent blocks settle", async () => {
  let releaseBlock!: () => void;
  const blockSettled = new Promise<void>((resolve) => { releaseBlock = resolve; });
  let settled = false;
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => ({ version: 3, stale: true, changedAt: null }),
    acknowledgeSnapshot: async () => true,
    loaders: {
      overview: async () => {
        await blockSettled;
        settled = true;
        return "route-and-blocks";
      },
    },
  });

  const pending = coordinator.refresh("overview");
  await Promise.resolve();
  assert.equal(settled, false, "the refresh promise must include the slow block");
  releaseBlock();
  assert.equal((await pending).status, "complete");
  assert.equal(settled, true);
});

test("a failed block is surfaced as a partial refresh without hiding sibling data", async () => {
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => ({ version: 4, stale: true, changedAt: null }),
    acknowledgeSnapshot: async () => true,
    loaders: {
      overview: async () => {
        throw new RefreshLoadError("chart failed", ["overview:chart"]);
      },
      assets: async () => "assets-ready",
    },
  });

  const result = await coordinator.refresh("overview");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.failed, ["overview", "overview:chart"]);
  assert.deepEqual(result.values.assets, "assets-ready");
});
