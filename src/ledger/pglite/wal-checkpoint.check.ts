import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGliteStore } from "./transaction.ts";
import {
  checkpointPgliteWalBacklog,
  pgliteWalBacklogBytes,
  startPgliteWalCheckpoints,
} from "./wal-checkpoint.ts";

const MIB = 1024 * 1024;

async function storeWithBacklog(megabytes: number): Promise<PGliteStore> {
  const store = new PGliteStore(await PGlite.create());
  await store.exec("CREATE TABLE padding (pad text)");
  // Each row is about 1 KiB of heap, so the WAL grows by at least `megabytes`.
  await store.exec(
    `INSERT INTO padding SELECT repeat(md5(g::text), 32) FROM generate_series(1, ${megabytes * 1024}) g`,
  );
  return store;
}

test("a WAL backlog past the threshold is checkpointed away", async () => {
  const store = await storeWithBacklog(8);
  try {
    assert.ok(await pgliteWalBacklogBytes(store) > 4 * MIB);
    assert.equal(await checkpointPgliteWalBacklog(store, 4 * MIB), true);
    assert.ok(await pgliteWalBacklogBytes(store) < MIB);
  } finally {
    await store.close();
  }
});

test("a WAL backlog under the threshold is left alone", async () => {
  const store = await storeWithBacklog(1);
  try {
    const before = await pgliteWalBacklogBytes(store);
    assert.equal(await checkpointPgliteWalBacklog(store, 16 * MIB), false);
    assert.ok(await pgliteWalBacklogBytes(store) >= before);
  } finally {
    await store.close();
  }
});

test("periodic checkpoints keep the replay a crash would need bounded", async () => {
  // PGlite has no checkpointer process, so without these the WAL since the last
  // checkpoint grows to max_wal_size and a launch after an unclean exit replays
  // all of it before any page can load.
  const store = await storeWithBacklog(8);
  const checkpoints = startPgliteWalCheckpoints(store, { intervalMs: 10, thresholdBytes: 4 * MIB });
  try {
    const deadline = Date.now() + 5_000;
    while (await pgliteWalBacklogBytes(store) > 4 * MIB && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(await pgliteWalBacklogBytes(store) <= 4 * MIB);
  } finally {
    await checkpoints.stop();
    await store.close();
  }
});

test("stopping the checkpoints waits for one in flight and schedules no more", async () => {
  const store = await storeWithBacklog(1);
  let ticks = 0;
  const checkpoints = startPgliteWalCheckpoints(store, {
    intervalMs: 5,
    thresholdBytes: 0,
    onCheckpoint: () => { ticks += 1; },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await checkpoints.stop();
  const settled = ticks;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ticks, settled);
  await store.close();
});
