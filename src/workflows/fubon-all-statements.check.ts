import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./fubon-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /function signOutFubon/);
assert.match(source, /activateControlWithoutPointer/);
assert.match(source, /logoutNow/);
assert.match(source, /finally \{[\s\S]*?stopSessionKeepAlive\(\);[\s\S]*?signOutFubon\(page\)/);
