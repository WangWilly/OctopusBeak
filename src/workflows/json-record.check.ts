import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "./json-record.ts";

test("isRecord accepts any non-null, non-array object", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ code: "200" }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord(new Date(0)), true, "the prototype is not checked");
  assert.equal(isRecord(new Map()), true);
});

test("isRecord refuses null, arrays, functions and primitives", () => {
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([{}]), false);
  assert.equal(isRecord(() => ({})), false);
  assert.equal(isRecord("{}"), false);
  assert.equal(isRecord(0), false);
});
