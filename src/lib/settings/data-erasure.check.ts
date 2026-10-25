import assert from "node:assert/strict";
import test from "node:test";
import { clearAllSignInData, deleteAllFinancialData, type CollectionControl } from "./data-erasure.ts";

function recordingCollection(events: string[]): CollectionControl {
  return {
    pauseSchedules() {
      events.push("schedules paused");
      return () => events.push("schedules resumed");
    },
    async whileStopped(work) {
      events.push("runs cancelled and terminal");
      try {
        return await work();
      } finally {
        events.push("runs may start");
      }
    },
  };
}

test("financial data is deleted only while schedules are paused and every run is stopped", async () => {
  const events: string[] = [];
  await deleteAllFinancialData(
    recordingCollection(events),
    { reset: async () => { events.push("store reset"); } },
    { markStale: (reason) => { events.push(reason); return { version: 1, reason, changedAt: "" }; } },
  );
  assert.deepEqual(events, [
    "schedules paused",
    "runs cancelled and terminal",
    "store reset",
    "financial-data-deleted",
    "runs may start",
    "schedules resumed",
  ]);
});

test("a failed reset still resumes collection and reports no change", async () => {
  const events: string[] = [];
  await assert.rejects(deleteAllFinancialData(
    recordingCollection(events),
    { reset: async () => { throw new Error("worker closed"); } },
    { markStale: (reason) => { events.push(reason); return { version: 1, reason, changedAt: "" }; } },
  ), /worker closed/u);
  assert.deepEqual(events, ["schedules paused", "runs cancelled and terminal", "runs may start", "schedules resumed"]);
});

test("sign-in data is erased while every run is stopped, then the credential state is reread", async () => {
  const events: string[] = [];
  await clearAllSignInData(
    recordingCollection(events),
    {
      cancelRegistrations: async () => { events.push("device registrations cancelled"); },
      erase: () => { events.push("sign-in details erased"); },
      refresh: async () => { events.push("credential state reread"); },
    },
    { markStale: (reason) => { events.push(reason); return { version: 1, reason, changedAt: "" }; } },
  );
  assert.deepEqual(events, [
    "schedules paused",
    "runs cancelled and terminal",
    "device registrations cancelled",
    "sign-in details erased",
    "credential state reread",
    "sign-in-data-cleared",
    "runs may start",
    "schedules resumed",
  ]);
});
