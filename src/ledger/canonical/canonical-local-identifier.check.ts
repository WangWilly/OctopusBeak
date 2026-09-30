import assert from "node:assert/strict";
import test from "node:test";
import {
  blob,
  canonicalIdsEqual,
  idFromString,
  idToString,
  uuidV7,
} from "./canonical-local-identifier.ts";

test("canonical local identifiers keep UUID encoding independent of schema lifecycle", () => {
  const id = uuidV7();
  const text = idToString(id);
  const roundTripped = idFromString(text);

  assert.match(text, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(id.length, 16);
  assert.equal(idToString(roundTripped), text);
  assert.equal(canonicalIdsEqual(id, roundTripped), true);
  assert.equal(canonicalIdsEqual(id, Buffer.alloc(16)), false);
  assert.deepEqual(blob(id), id);
  assert.notStrictEqual(blob(id), id);
});

test("canonical local identifier parsing fails closed", () => {
  assert.throws(() => idFromString("not-a-uuid"), /Canonical ID must be a UUID string/);
  assert.throws(() => idToString(Buffer.alloc(15)), /Canonical ID must be a 16-byte UUID blob/);
  assert.throws(() => blob(Buffer.alloc(15)), /Expected a 16-byte canonical ID blob/);
});
