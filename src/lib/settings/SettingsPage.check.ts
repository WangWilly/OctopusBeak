import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SettingsPage.svelte", import.meta.url), "utf8");

assert.match(source, /stableFinancialErrorCode\(error\)/);
assert.doesNotMatch(source, /error instanceof Error \? error\.message/);
assert.doesNotMatch(source, /String\(error\)/);

