import assert from "node:assert/strict";
import test from "node:test";
import type { DataVersionStore } from "../shared-shell/data-version.ts";
import { resetLedger, type CollectionControl, type LedgerResetPart, type LedgerResetSteps } from "./data-erasure.ts";

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

function recordingSteps(events: string[], failing: LedgerResetPart | null = null): LedgerResetSteps {
  const step = (part: LedgerResetPart, event: string) => async () => {
    if (part === failing) throw new Error(`${part} failed`);
    events.push(event);
  };
  return {
    financial: step("financial", "store reset"),
    preview: step("preview", "preview data deleted"),
    manual: step("manual", "manual assets deleted"),
    "sign-in": step("sign-in", "sign-in details erased"),
  };
}

const recordingVersions = (events: string[]): Pick<DataVersionStore, "markStale"> => ({
  markStale: (reason) => {
    events.push(reason);
    return { version: 1, reason, changedAt: "" };
  },
});

test("every part runs in the fixed order, with collection stopped once around all of them", async () => {
  const events: string[] = [];
  const result = await resetLedger(
    recordingCollection(events),
    recordingSteps(events),
    recordingVersions(events),
    new Set(["sign-in", "manual", "preview"] as const),
  );
  assert.deepEqual(events, [
    "schedules paused",
    "runs cancelled and terminal",
    "preview data deleted",
    "preview-data-changed",
    "manual assets deleted",
    "sign-in details erased",
    "sign-in-data-cleared",
    "runs may start",
    "schedules resumed",
  ]);
  assert.deepEqual(result, { done: ["preview", "manual", "sign-in"], failed: null, notRun: [] });
});

test("the Canonical Reset already deletes preview data, so preview data asked for beside it is not deleted again", async () => {
  const events: string[] = [];
  const result = await resetLedger(
    recordingCollection(events),
    recordingSteps(events),
    recordingVersions(events),
    new Set(["preview", "financial"] as const),
  );
  assert.deepEqual(events, [
    "schedules paused",
    "runs cancelled and terminal",
    "store reset",
    "financial-data-deleted",
    "runs may start",
    "schedules resumed",
  ]);
  assert.deepEqual(result, { done: ["financial", "preview"], failed: null, notRun: [] });
});

test("a part that fails stops the rest; what finished stays marked stale and collection resumes", async () => {
  const events: string[] = [];
  const result = await resetLedger(
    recordingCollection(events),
    recordingSteps(events, "manual"),
    recordingVersions(events),
    new Set(["financial", "preview", "manual", "sign-in"] as const),
  );
  assert.deepEqual(result, { done: ["financial", "preview"], failed: "manual", notRun: ["sign-in"] });
  assert.deepEqual(events, [
    "schedules paused",
    "runs cancelled and terminal",
    "store reset",
    "financial-data-deleted",
    "runs may start",
    "schedules resumed",
  ], "sign-in data is not erased, and no view is marked stale for what did not finish");
});

test("a first part that fails reports nothing done", async () => {
  const events: string[] = [];
  const result = await resetLedger(
    recordingCollection(events),
    recordingSteps(events, "financial"),
    recordingVersions(events),
    new Set(["financial", "preview"] as const),
  );
  assert.deepEqual(result, { done: [], failed: "financial", notRun: ["preview"] });
  assert.deepEqual(events, ["schedules paused", "runs cancelled and terminal", "runs may start", "schedules resumed"]);
});

test("collection that cannot be stopped deletes nothing and still resumes the schedules", async () => {
  const events: string[] = [];
  const collection: CollectionControl = {
    pauseSchedules: () => () => events.push("schedules resumed"),
    whileStopped: async () => { throw new Error("a run did not end"); },
  };
  await assert.rejects(
    resetLedger(collection, recordingSteps(events), recordingVersions(events), new Set(["financial"] as const)),
    /a run did not end/u,
  );
  assert.deepEqual(events, ["schedules resumed"]);
});
