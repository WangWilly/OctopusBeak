import assert from "node:assert/strict";
import test from "node:test";
import { estimateView, megabytes, runLedgerReclaim, type LedgerReclaimView } from "./ledger-reclaim.ts";

const MiB = 1024 * 1024;

test("the estimate shows what can be reclaimed, or why nothing will be", () => {
  assert.deepEqual(estimateView({ reclaimableBytes: 0, tableCount: 0, requiredFreeBytes: 0, freeBytes: null }), { kind: "nothing" });
  assert.deepEqual(
    estimateView({ reclaimableBytes: 300 * MiB, tableCount: 7, requiredFreeBytes: 200 * MiB, freeBytes: 50 * MiB }),
    { kind: "no-room", requiredFreeBytes: 200 * MiB, freeBytes: 50 * MiB },
  );
  assert.deepEqual(
    estimateView({ reclaimableBytes: 300 * MiB, tableCount: 7, requiredFreeBytes: 200 * MiB, freeBytes: null }),
    { kind: "estimated", reclaimableBytes: 300 * MiB },
    "an unreadable free space lets the worker decide",
  );
  assert.equal(megabytes(302.4 * MiB), "302");
  assert.equal(megabytes(0.37 * MiB), "0.4");
});

test("a reclaim shows its progress while it runs, then its result", async () => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const shown: LedgerReclaimView[] = [];
  const view = runLedgerReclaim({
    ledgerReclaimEstimate: async () => { throw new Error("not read"); },
    ledgerReclaimProgress: async () => ({ index: 2, count: 7, reclaimedBytes: 20 * MiB }),
    reclaimLedgerSpace: async () => {
      await finished;
      return { status: "stopped", tableCount: 2, reclaimedBytes: 20 * MiB };
    },
  }, (next) => shown.push(next), 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish();
  assert.deepEqual(await view, { kind: "stopped", reclaimedBytes: 20 * MiB });
  assert.deepEqual(shown[0], { kind: "running", progress: null });
  assert.ok(shown.some((next) => next.kind === "running" && next.progress?.index === 2));
  assert.deepEqual(shown.at(-1), { kind: "stopped", reclaimedBytes: 20 * MiB });
});

test("a reclaim the worker could not run shows as failed", async () => {
  const bridge = {
    ledgerReclaimEstimate: async () => { throw new Error("not read"); },
    ledgerReclaimProgress: async () => null,
  };
  assert.deepEqual(await runLedgerReclaim({ ...bridge, reclaimLedgerSpace: async () => { throw new Error("worker closed"); } }, () => {}), { kind: "failed" });
  assert.deepEqual(await runLedgerReclaim({ ...bridge, reclaimLedgerSpace: async () => ({ status: "failed", tableCount: 1, reclaimedBytes: 0 }) }, () => {}), { kind: "failed" });
});
