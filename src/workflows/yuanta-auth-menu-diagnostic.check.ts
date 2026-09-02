import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import {
  buildAuthMenuDiagnosticEvent,
  YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
} from "./auth-menu-diagnostic.ts";
import { YUANTA_AUTH_MENU_DIAGNOSTIC_FIXTURE } from "./auth-menu-diagnostic.fixtures.ts";
import {
  hasReadyYuantaMenu,
  hasVisibleYuantaMenuAnchor,
  runYuantaAuthMenuDiagnostic,
} from "./yuanta-auth-menu-diagnostic.ts";

const source = await readFile(
  new URL("./yuanta-auth-menu-diagnostic.ts", import.meta.url),
  "utf8",
);
assert.match(source, /authenticateYuantaBank/);
assert.match(source, /credentials:\s*\["yuanta_user_id",\s*"yuanta_account",\s*"yuanta_password"\]/);
assert.match(source, /executeAuthMenuDiagnostic/);
assert.match(source, /overrides\.authenticate\s*\?\?\s*authenticateYuantaBank/u);
assert.doesNotMatch(source, /runYuanta(?:Statements|LoanStatements|CreditCardStatements|FundStatements)/);
assert.doesNotMatch(source, /createCanonicalSourceStore|canonicalSqlitePath/);
assert.doesNotMatch(source, /page\.goto|fetch\(|evaluate\(/);
assert.match(
  source,
  /expandApprovedMenu:\s*z\.literal\("function-overview"\)\.optional\(\)/u,
);

function fakePage() {
  return {
    frames: () => [],
    waitForTimeout: async () => undefined,
  } as unknown as Page;
}

test("Yuanta auth-only diagnostic uses shared authentication and fmenu readiness", async () => {
  const calls: string[] = [];
  const result = await runYuantaAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    {
      credentials: {
        yuanta_user_id: "user-fixture",
        yuanta_account: "account-fixture",
        yuanta_password: "password-fixture",
      },
    },
    {
      authenticate: async () => calls.push("authenticate"),
      isAuthenticated: async () => {
        calls.push("fmenu-fmain-readiness");
        return true;
      },
      collect: async () => {
        calls.push("collect");
        return buildAuthMenuDiagnosticEvent(
          "yuanta",
          YUANTA_AUTH_MENU_DIAGNOSTIC_FIXTURE,
          YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
        );
      },
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/yuanta-auth-menu.png";
      },
    },
  );
  assert.deepEqual(calls, [
    "authenticate",
    "fmenu-fmain-readiness",
    "collect",
    "screenshot",
  ]);
  assert.equal(result.authentication, "succeeded");
  assert.equal(result.readiness, "ready");
  assert.equal(result.provider, "yuanta");
  assert.equal(result.candidates.length, 2);
});

test("Yuanta authentication failure does not inspect frames or screenshot", async () => {
  const calls: string[] = [];
  const result = await runYuantaAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    { credentials: {} },
    {
      authenticate: async () => {
        calls.push("authenticate");
        throw new Error("provider rejected otp=fixture");
      },
      isAuthenticated: async () => {
        calls.push("readiness");
        return true;
      },
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/should-not-exist.png";
      },
    },
  );
  assert.deepEqual(calls, ["authenticate"]);
  assert.equal(result.authentication, "failed");
  assert.equal(result.readiness, "not-checked");
  assert.equal(result.screenshotPath, null);
  assert.equal(JSON.stringify(result).includes("fixture"), false);
});

test("Yuanta expands function overview only when explicitly requested", async () => {
  const calls: string[] = [];
  await runYuantaAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    { credentials: {}, expandApprovedMenu: "function-overview" },
    {
      authenticate: async () => calls.push("authenticate"),
      isAuthenticated: async () => {
        calls.push("readiness");
        return true;
      },
      expandApprovedMenu: async () => {
        calls.push("expand-function-overview");
      },
      collect: async () => {
        calls.push("collect");
        return buildAuthMenuDiagnosticEvent(
          "yuanta",
          YUANTA_AUTH_MENU_DIAGNOSTIC_FIXTURE,
          YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
        );
      },
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/yuanta-approved-menu.png";
      },
    },
  );
  assert.deepEqual(calls, [
    "authenticate",
    "readiness",
    "expand-function-overview",
    "collect",
    "screenshot",
  ]);
});

function visibleAnchorFrame(visible: boolean) {
  return {
    locator: (selector: string) => {
      assert.equal(selector, "a");
      return {
        count: async () => 1,
        nth: () => ({ isVisible: async () => visible }),
      };
    },
  };
}

test("Yuanta signed-in marker alone is not diagnostic readiness", async () => {
  const frames: Record<string, object> = {
    fmenu: visibleAnchorFrame(false),
    fmain: visibleAnchorFrame(false),
  };
  const page = {
    frame: ({ name }: { name: string }) => frames[name] ?? null,
    url: () => "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
    frames: () => [],
  } as unknown as Page;
  // The lower-level probe is independently useful to callers and explicitly
  // proves that an attached but empty shell does not count as ready.
  assert.equal(await hasVisibleYuantaMenuAnchor(page), false);
});

test("Yuanta readiness requires a visible anchor in fmenu or fmain", async () => {
  const frames: Record<string, object> = {
    fmenu: visibleAnchorFrame(true),
    fmain: visibleAnchorFrame(false),
  };
  const page = {
    frame: ({ name }: { name: string }) => frames[name] ?? null,
    url: () => "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
    frames: () => [],
  } as unknown as Page;
  assert.equal(await hasVisibleYuantaMenuAnchor(page), true);
});

function yuantaReadyProbePage(visibleAnchor: boolean) {
  const makeFrame = (name: string) => ({
    name: () => name,
    url: () => "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
    locator: (selector: string) => ({
      count: async () => (selector === "a" ? 1 : 1),
      nth: () => ({ isVisible: async () => visibleAnchor }),
    }),
  });
  const fmenu = makeFrame("fmenu");
  const fmain = makeFrame("fmain");
  const frames: Record<string, object> = { fmenu, fmain };
  return {
    frame: ({ name }: { name: string }) => frames[name] ?? null,
    frames: () => [fmenu, fmain],
    url: () => "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
  } as unknown as Page;
}

test("Yuanta ready probe rejects attached signed-in shell without visible anchors", async () => {
  assert.equal(await hasReadyYuantaMenu(yuantaReadyProbePage(false)), false);
  assert.equal(await hasReadyYuantaMenu(yuantaReadyProbePage(true)), true);
});

test("Yuanta readiness timeout still captures an authenticated incomplete page", async () => {
  const calls: string[] = [];
  const result = await runYuantaAuthMenuDiagnostic(
    { page: fakePage(), session: "session-fixture" },
    { credentials: {} },
    {
      authenticate: async () => calls.push("authenticate"),
      isAuthenticated: async () => false,
      captureScreenshot: async () => {
        calls.push("screenshot");
        return "/private/tmp/yuanta-incomplete.png";
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
    },
  );
  assert.deepEqual(calls, ["authenticate", "screenshot"]);
  assert.equal(result.authentication, "succeeded");
  assert.equal(result.readiness, "timed-out");
  assert.equal(result.evidenceStopReason, "menu-incomplete");
  assert.equal(result.screenshotPath, "/private/tmp/yuanta-incomplete.png");
  assert.equal(result.screenshotStatus, "captured");
});
