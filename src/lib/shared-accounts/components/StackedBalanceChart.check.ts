import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appCss = readFileSync(new URL("../../../app.css", import.meta.url), "utf8");

test("balance chart tooltips can escape the chart padding", () => {
  assert.match(appCss, /\.balance-chart\s*\{[^}]*overflow:\s*visible;/);
});
