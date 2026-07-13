import assert from "node:assert/strict";
import { migrateLedgerBeforeWindow } from "./startup-ledger.ts";

const events: string[] = [];
migrateLedgerBeforeWindow(undefined, {
  open: () => ({ close: () => events.push("close") }),
  beforeOpen: () => events.push("open"),
});
events.push("window");
assert.deepEqual(events, ["open", "close", "window"]);

const failedEvents: string[] = [];
assert.throws(
  () => migrateLedgerBeforeWindow(undefined, {
    open: () => {
      throw new Error("migration failed");
    },
    beforeOpen: () => failedEvents.push("open"),
  }),
  /migration failed/,
);
assert.deepEqual(failedEvents, ["open"]);
