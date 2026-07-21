import assert from "node:assert/strict";
import { sourceVersionKey } from "./source-version.ts";

const first = sourceVersionKey("fictional-bank", "loan-statements", "file-hash-a");
assert.match(first, /^[a-f0-9]{64}$/);
assert.equal(first, sourceVersionKey("fictional-bank", "loan-statements", "file-hash-a"));
assert.notEqual(first, sourceVersionKey("fictional-bank", "loan-statements", "file-hash-b"));
assert.notEqual(first, sourceVersionKey("fictional-bank", "card-statements", "file-hash-a"));
assert.notEqual(first, sourceVersionKey("other-bank", "loan-statements", "file-hash-a"));
assert.notEqual(
  sourceVersionKey("a|b", "c", "d"),
  sourceVersionKey("a", "b|c", "d"),
);
