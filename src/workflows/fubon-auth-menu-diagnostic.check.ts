import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import {
  buildAuthMenuDiagnosticEvent,
  FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
} from "./auth-menu-diagnostic.ts";
import {
  FUBON_AUTH_MENU_DIAGNOSTIC_FIXTURE,
} from "./auth-menu-diagnostic.fixtures.ts";
import {
  hasAuthenticatedFubonMenu,
  runFubonAuthMenuDiagnostic,
} from "./fubon-auth-menu-diagnostic.ts";

const source = await readFile(
  new URL("./fubon-auth-menu-diagnostic.ts", import.meta.url),
  "utf8",
);
const provenAllStatementsSource = await readFile(
  new URL("./fubon-all-statements.ts", import.meta.url),
  "utf8",
);
assert.match(source, /signInFubon/);
assert.match(source, /credentials:\s*\["fubon_user_id",\s*"fubon_account",\s*"fubon_password"\]/);
assert.match(source, /executeAuthMenuDiagnostic/);
assert.match(source, /overrides\.signIn\s*\?\?\s*signInFubon/u);
assert.doesNotMatch(source, /^\s*startUrl\s*:/mu);
assert.doesNotMatch(provenAllStatementsSource, /^\s*startUrl\s*:/mu);
assert.doesNotMatch(source, /runFubon(?:Statements|LoanStatements|CreditCardStatements)/);
assert.doesNotMatch(source, /createCanonicalSourceStore|canonicalSqlitePath/);
assert.doesNotMatch(source, /page\.goto|fetch\(|evaluate\(/);
assert.match(source, /expandApprovedMenu:\s*z\.literal\("loan"\)\.optional\(\)/u);

function fakePage() {
  return {
    frames: () => [],
    waitForTimeout: async () => undefined,
  } as unknown as Page;
}

test("Fubon auth-only diagnostic authenticates before readiness, collection and screenshot", async () => {
  const calls: string[] = [];
  const result = await runFubonAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    {
      credentials: {
        fubon_user_id: "user-fixture",
        fubon_account: "account-fixture",
        fubon_password: "password-fixture",
      },
    },
    {
      signIn: async () => {
        calls.push("authenticate");
      },
      isAuthenticated: async () => {
        calls.push("readiness");
        return true;
      },
      collect: async () => {
        calls.push("collect");
        return buildAuthMenuDiagnosticEvent(
          "fubon",
          FUBON_AUTH_MENU_DIAGNOSTIC_FIXTURE,
          FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
        );
      },
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/fubon-auth-menu.png";
      },
      keepBrowserWindowOutOfForeground: async () => {
        calls.push("keep-window-out-of-foreground");
      },
    },
  );
  assert.deepEqual(calls, [
    "authenticate",
    "keep-window-out-of-foreground",
    "readiness",
    "collect",
    "screenshot",
  ]);
  assert.equal(result.authentication, "succeeded");
  assert.equal(result.readiness, "ready");
  assert.equal(result.provider, "fubon");
  assert.equal(result.screenshotPath, "/private/tmp/fubon-auth-menu.png");
  assert.equal(result.screenshotStatus, "captured");
  assert.equal(result.candidates.length, 2);
});

test("Fubon authentication failure is fail-soft and does not inspect menu", async () => {
  const calls: string[] = [];
  const result = await runFubonAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    { credentials: {} },
    {
      signIn: async () => {
        calls.push("authenticate");
        throw new Error("provider rejected password=fixture");
      },
      isAuthenticated: async () => {
        calls.push("readiness");
        return true;
      },
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/should-not-exist.png";
      },
      keepBrowserWindowOutOfForeground: async () => {
        calls.push("keep-window-out-of-foreground");
      },
    },
  );
  assert.deepEqual(calls, ["authenticate"]);
  assert.equal(result.authentication, "failed");
  assert.equal(result.readiness, "not-checked");
  assert.equal(result.evidenceUsable, false);
  assert.equal(result.screenshotPath, null);
  assert.equal(JSON.stringify(result).includes("fixture"), false);
});

test("Fubon expands the approved loan menu only when explicitly requested", async () => {
  const calls: string[] = [];
  await runFubonAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    { credentials: {}, expandApprovedMenu: "loan" },
    {
      signIn: async () => {
        calls.push("authenticate");
      },
      keepBrowserWindowOutOfForeground: async () => {
        calls.push("window-guard");
      },
      isAuthenticated: async () => {
        calls.push("readiness");
        return true;
      },
      expandApprovedMenu: async () => {
        calls.push("expand-loan-menu");
      },
      collect: async () => {
        calls.push("collect");
        return buildAuthMenuDiagnosticEvent(
          "fubon",
          FUBON_AUTH_MENU_DIAGNOSTIC_FIXTURE,
          FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
        );
      },
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/fubon-approved-menu.png";
      },
    },
  );
  assert.deepEqual(calls, [
    "authenticate",
    "window-guard",
    "readiness",
    "expand-loan-menu",
    "collect",
    "screenshot",
  ]);
});

test("Fubon readiness timeout captures the authenticated incomplete landing page", async () => {
  const calls: string[] = [];
  const result = await runFubonAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    { credentials: {} },
    {
      signIn: async () => {
        calls.push("authenticate");
      },
      isAuthenticated: async () => {
        calls.push("readiness");
        return false;
      },
      collect: async () => {
        calls.push("collect");
        return buildAuthMenuDiagnosticEvent(
          "fubon",
          [],
          FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
        );
      },
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/should-not-exist.png";
      },
      keepBrowserWindowOutOfForeground: async () => {
        calls.push("keep-window-out-of-foreground");
      },
      timeoutMs: 5,
      pollIntervalMs: 1,
    },
  );
  // The production wait is bounded; timeout still captures the authenticated
  // landing page so an incomplete menu can be diagnosed from the artifact.
  assert.deepEqual(calls.slice(0, 2), [
    "authenticate",
    "keep-window-out-of-foreground",
  ]);
  assert.equal(result.authentication, "succeeded");
  assert.equal(result.readiness, "timed-out");
  assert.equal(result.screenshotPath, "/private/tmp/should-not-exist.png");
  assert.equal(result.screenshotStatus, "captured");
  assert.equal(calls.includes("collect"), false);
  assert.equal(calls.includes("screenshot"), true);
  assert.equal(result.evidenceStopReason, "menu-incomplete");
});

test("Fubon authenticated marker is read-only", async () => {
  const operations: string[] = [];
  const markerPage = {
    frames: () => [
      {
        locator: (selector: string) => {
          operations.push(`locator:${selector}`);
          return { count: async () => 1 };
        },
      },
    ],
    locator: () => ({ count: async () => 0 }),
  } as unknown as Page;
  assert.equal(await hasAuthenticatedFubonMenu(markerPage), true);
  assert.equal(operations.some((operation) => /click|goto|fetch|evaluate/iu.test(operation)), false);
});
