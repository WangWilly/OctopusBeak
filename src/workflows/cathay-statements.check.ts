import assert from "node:assert/strict";
import { navigateToCathayLoginForm } from "./cathay-login.ts";

const calls: unknown[][] = [];
await navigateToCathayLoginForm({
  goto: async (...args: unknown[]) => {
    calls.push(["goto", ...args]);
  },
  locator: (...args: unknown[]) => {
    calls.push(["locator", ...args]);
    return {
      waitFor: async (...waitForArgs: unknown[]) => {
        calls.push(["waitFor", ...waitForArgs]);
      },
    };
  },
} as never);

assert.deepEqual(calls, [
  ["goto", "https://www.cathaybk.com.tw/MyBank/", { waitUntil: "commit" }],
  ["locator", "#CustID"],
  ["waitFor", { state: "visible", timeout: 60_000 }],
]);
