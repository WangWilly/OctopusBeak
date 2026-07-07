import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./fubon-statements.ts", import.meta.url),
  "utf8",
);
const waitForSignedInState = source.match(
  /async function waitForSignedInState[\s\S]*?\n}/,
)?.[0];

assert.ok(waitForSignedInState);
assert.match(waitForSignedInState, /waitForFrame\(page, "frame1"\)/);
assert.match(waitForSignedInState, /#header_form\\\\:header_logout/);
assert.doesNotMatch(waitForSignedInState, /depositRows/);
