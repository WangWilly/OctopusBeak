import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./TransactionModal.svelte", import.meta.url), "utf8");

test("date sorting uses the timestamp displayed by the transaction table", () => {
  assert.match(source, /if \(key === "date"\) return row\.occurredAtUtc \?\? row\.date;/);
  assert.match(source, /formatUtcDate\(row\.occurredAtUtc \?\? row\.date,/);
});
