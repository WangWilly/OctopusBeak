import assert from "node:assert/strict";
import test from "node:test";
import { awaitingFirstData } from "./first-data.ts";

test("a ledger awaits its first data until an account appears, unless reads failed", () => {
  assert.equal(awaitingFirstData({ availability: "empty", accounts: [] }), true);
  assert.equal(awaitingFirstData({ availability: "awaiting", accounts: [] }), true, "configured sources not collected yet");
  assert.equal(awaitingFirstData({ availability: "awaiting", accounts: [{}] }), false);
  assert.equal(awaitingFirstData({ availability: "available", accounts: [{}] }), false);
  assert.equal(awaitingFirstData({ availability: "unavailable", accounts: [] }), false);
});
