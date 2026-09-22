import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withCanonicalWriterQueue } from "./canonical-runtime.ts";
import {
  CanonicalWriterLeaseCancelledError,
  CanonicalWriterLeaseTimeoutError,
  withCanonicalWriterLease,
} from "./canonical-writer-lease.ts";

test("the in-process writer turn remains held until an async operation settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-writer-turn-"));
  const path = join(directory, "canonical.sqlite");
  try {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const first = withCanonicalWriterQueue(path, async () => {
      entered += 1;
      await barrier;
      return "first";
    });
    while (entered === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = withCanonicalWriterQueue(path, () => {
      entered += 1;
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(entered, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.equal(entered, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pre-transaction lease wait has typed timeout and cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-writer-wait-"));
  const path = join(directory, "canonical.sqlite");
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withCanonicalWriterLease(path, async () => {
    entered();
    await barrier;
  });
  try {
    await active;
    await assert.rejects(
      () => withCanonicalWriterLease(path, () => "never", { waitTimeoutMs: 20 }),
      CanonicalWriterLeaseTimeoutError,
    );
    const controller = new AbortController();
    const cancelled = withCanonicalWriterLease(path, () => "never", {
      signal: controller.signal,
      waitTimeoutMs: 1_000,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => cancelled, CanonicalWriterLeaseCancelledError);
  } finally {
    release();
    await holder;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the writer queue never replays an asynchronous failed transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-writer-no-replay-"));
  try {
    let calls = 0;
    await assert.rejects(
      () => withCanonicalWriterQueue(join(directory, "canonical.sqlite"), async () => {
        calls += 1;
        throw new Error("SQLite database is locked after transaction work");
      }, { maxAttempts: 3, initialBackoffMs: 1 }),
      /locked after transaction work/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
