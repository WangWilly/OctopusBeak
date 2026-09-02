import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
  AUTH_MENU_DIAGNOSTIC_EVENT,
  AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS,
  AUTH_MENU_DIAGNOSTIC_MAX_CANDIDATES,
  AUTH_MENU_DIAGNOSTIC_MAX_SCOPES,
  authMenuDiagnosticOutputSchema,
  buildAuthMenuDiagnosticEvent,
  captureAuthMenuScreenshot,
  collectAuthMenuDiagnostic,
  executeAuthMenuDiagnostic,
  FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
  YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
  waitForAuthMenuReadiness,
  type AuthMenuAnchorSnapshot,
} from "./auth-menu-diagnostic.ts";
import {
  FUBON_AUTH_MENU_DIAGNOSTIC_FIXTURE,
  YUANTA_AUTH_MENU_DIAGNOSTIC_FIXTURE,
} from "./auth-menu-diagnostic.fixtures.ts";

const fubon = buildAuthMenuDiagnosticEvent(
  "fubon",
  FUBON_AUTH_MENU_DIAGNOSTIC_FIXTURE,
  FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
);
assert.equal(fubon.event, AUTH_MENU_DIAGNOSTIC_EVENT);
assert.equal(fubon.provider, "fubon");
assert.equal(fubon.source, "authenticated-menu");
assert.equal(fubon.readMode, "dom-only");
assert.equal(fubon.evidenceUsable, true);
assert.equal(fubon.evidenceStopReason, null);
assert.deepEqual(
  fubon.candidates.map((candidate) => ({
    category: candidate.category,
    label: candidate.label,
    pathname: candidate.pathname,
    query: candidate.query,
    action: candidate.action,
    frameName: candidate.frameName,
  })),
  [
    {
      category: "autodebit",
      label: "自動扣繳設定",
      pathname: null,
      query: [],
      action: {
        actionId: "autodebit-menu",
        handlerId: null,
        taskId: "autodebit-task",
        menuId: "loan-menu",
      },
      frameName: "frame1",
    },
    {
      category: "loan",
      label: "貸款交易明細查詢",
      pathname: "/B2C/lnq/lnq001/LoanTransaction.faces",
      query: [{ name: "type", value: "page" }],
      action: null,
      frameName: "frame1",
    },
  ],
);

const yuanta = buildAuthMenuDiagnosticEvent(
  "yuanta",
  YUANTA_AUTH_MENU_DIAGNOSTIC_FIXTURE,
  YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
);
assert.deepEqual(
  yuanta.candidates.map(({ category, label, action }) => ({
    category,
    label,
    action,
  })),
  [
    {
      category: "autodebit",
      label: "自動扣繳服務",
      action: {
        actionId: "autodebit-menu",
        handlerId: null,
        taskId: null,
        menuId: null,
      },
    },
    {
      category: "loan",
      label: "貸款繳款明細查詢",
      action: {
        actionId: null,
        handlerId: "doAction",
        taskId: null,
        menuId: "menu_loan",
      },
    },
  ],
);

// Suspicious query names/values and onclick arguments are omitted as a unit;
// their route labels remain available for a human to recognize the menu.
const suspicious = buildAuthMenuDiagnosticEvent(
  "yuanta",
  [
    {
      label: "貸款交易明細查詢",
      href: "/nib/tx/loantransactiondetails?cid=private-cid&safe=route",
      onclick: "doAction('/nib/tx/loantransactiondetails', 'otp-value')",
      frameName: "fmenu",
    },
    {
      label: "貸款帳號 ******7890",
      href: "/nib/tx/loantransactiondetails",
      frameName: "fmenu",
    },
  ],
  AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
);
const suspiciousSerialized = JSON.stringify(suspicious);
assert.doesNotMatch(
  suspiciousSerialized,
  /private-cid|otp-value|987890|cid=|\*{2,}|貸款帳號\s*\d/iu,
);
assert.equal(suspicious.maskedAccountObserved, true);
assert.equal(suspicious.evidenceUsable, false);
assert.equal(suspicious.evidenceStopReason, "masked-account-observed");
assert.equal(suspicious.candidates.length, 2);
assert.equal(
  suspicious.candidates[0]?.metadataOmittedReason,
  "sensitive-metadata-omitted",
);
assert.equal(suspicious.candidates[1]?.maskedLabel, true);

const unrelated = buildAuthMenuDiagnosticEvent(
  "fubon",
  [
    { label: "客服中心", href: "/service/contact" },
    { label: "隱藏貸款明細", href: "/loan/hidden", visible: false },
    { label: "貸款", href: "javascript:secret()" },
  ],
  AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
);
assert.equal(unrelated.candidates.length, 1);
assert.equal(unrelated.candidates[0]?.pathname, null);
assert.equal(unrelated.candidates[0]?.action, null);

const deterministicInputs: AuthMenuAnchorSnapshot[] = [
  { label: "交易明細", href: "/z-route", frameName: "fmain" },
  { label: "貸款", href: "/loan-route", frameName: "fmain" },
  { label: "交易明細", href: "/z-route", frameName: "fmain" },
  { label: "自動扣繳", href: "/auto-route", frameName: "fmenu" },
];
const deterministic = buildAuthMenuDiagnosticEvent(
  "fubon",
  deterministicInputs,
  AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
);
const reversed = buildAuthMenuDiagnosticEvent(
  "fubon",
  [...deterministicInputs].reverse(),
  AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
);
assert.deepEqual(deterministic.candidates, reversed.candidates);
assert.equal(deterministic.candidates.length, 3);

const bounded = buildAuthMenuDiagnosticEvent(
  "fubon",
  Array.from(
    { length: AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS + 10 },
    (_, index) => {
      const suffix = `${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(
        65 + (Math.floor(index / 26) % 26),
      )}`;
      return { label: `交易 Route-${suffix}`, href: `/route/${suffix}` };
    },
  ),
  AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
);
assert.equal(bounded.observedAnchorCount, AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS);
assert.equal(bounded.truncated, true);
assert.equal(bounded.candidates.length, AUTH_MENU_DIAGNOSTIC_MAX_CANDIDATES);

function locatorFor(
  anchors: readonly AuthMenuAnchorSnapshot[],
  operations: string[],
) {
  return {
    count: async () => anchors.length,
    nth: (index: number) => {
      const anchor = anchors[index] ?? {};
      return {
        isVisible: async () => {
          operations.push("isVisible");
          return anchor.visible !== false;
        },
        textContent: async () => {
          operations.push("textContent");
          return anchor.label ?? null;
        },
        getAttribute: async (name: string) => {
          operations.push(`getAttribute:${name}`);
          const values: Record<string, string | null | undefined> = {
          href: anchor.href,
          onclick: anchor.onclick,
          "aria-label": anchor.ariaLabel,
          title: anchor.title,
          "data-label": anchor.dataLabel,
          "data-menu-label": anchor.dataMenuLabel,
          "data-action": anchor.action,
            "data-task": anchor.task,
            "data-task-id": anchor.task,
            "data-menu": anchor.menu,
            "data-menu-id": anchor.menu,
            id: anchor.id,
          };
          return values[name] ?? null;
        },
      };
    },
  };
}

function frameFor(
  name: string,
  anchors: readonly AuthMenuAnchorSnapshot[],
  operations: string[],
  children: readonly object[] = [],
) {
  return {
    name: () => name,
    childFrames: () => children,
    locator: (selector: string) => {
      assert.equal(selector, "a");
      operations.push(`frame:${name}:locator:a`);
      return locatorFor(anchors, operations);
    },
  };
}

const operations: string[] = [];
const nestedFmenu = frameFor(
  "fmenu",
  YUANTA_AUTH_MENU_DIAGNOSTIC_FIXTURE,
  operations,
);
const nestedShell = frameFor("shell", [], operations, [nestedFmenu]);
const mainFrame = frameFor("main", [], operations);
const page = {
  frames: () => [mainFrame, nestedShell],
  mainFrame: () => mainFrame,
  locator: (selector: string) => {
    assert.equal(selector, "a");
    operations.push("page:locator:a");
    return locatorFor([], operations);
  },
};
const collected = await collectAuthMenuDiagnostic(page as never, {
  provider: "yuanta",
  contractVersion: YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
});
assert.equal(collected.candidates.length, 2);
assert.ok(collected.candidates.every((candidate) => candidate.frameName === "fmenu"));
assert.ok(
  operations.every(
    (operation) => !/^(?:click|goto|fetch|evaluate)(?::|$)/iu.test(operation),
  ),
);

const frameFailure = {
  name: () => "fmain",
  childFrames: () => {
    throw new Error("provider cid=private");
  },
  locator: () => {
    throw new Error("detached account=123456789");
  },
};
const failurePage = {
  frames: () => [frameFailure],
  mainFrame: () => frameFailure,
  locator: () => locatorFor([], []),
};
const failed = await collectAuthMenuDiagnostic(failurePage as never, {
  provider: "fubon",
  contractVersion: FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
});
assert.equal(failed.truncated, true);
assert.doesNotMatch(JSON.stringify(failed), /provider cid|123456789|account=|private-cid/iu);

test("auth menu collector keeps Fubon relation candidates beyond the old 128-anchor scope cap", async () => {
  const anchors = Array.from({ length: 144 }, (_, index) => ({
    label:
      index === 143
        ? "貸款交易明細查詢"
        : index === 142
          ? "自動扣繳設定"
          : `一般功能 ${index}`,
    href:
      index === 143
        ? "/B2C/lnq/lnq001/LoanTransaction.faces?type=page"
        : `/B2C/general/route-${index}`,
  }));
  const frame = frameFor("frame1", anchors, []);
  const main = frameFor("main", [], []);
  const page = {
    frames: () => [main, frame],
    mainFrame: () => main,
    locator: () => locatorFor([], []),
  };
  const event = await collectAuthMenuDiagnostic(page as never, {
    provider: "fubon",
    contractVersion: FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
  });
  assert.equal(event.truncated, false);
  assert.equal(event.observedAnchorCount, 144);
  assert.deepEqual(event.frameSummaries, [
    { frameName: "frame1", anchorCount: 144 },
    { frameName: "page", anchorCount: 0 },
  ]);
  assert.ok(event.candidates.some((candidate) => candidate.category === "loan"));
  assert.ok(
    event.candidates.some((candidate) => candidate.category === "autodebit"),
  );
});

test("auth menu collector reads Yuanta fmain anchors and retains static route identity", async () => {
  const anchors = Array.from({ length: 407 }, (_, index) => ({
    label: index === 406 ? null : `一般功能 ${index}`,
    ariaLabel: index === 406 ? null : undefined,
    href:
      index === 406
        ? "javascript:doAction('/nib/tx/loantransactiondetails?cid=private-cid&route=page')"
        : `/nib/other/route-${index}`,
    onclick:
      index === 406
        ? "doAction('/nib/tx/loantransactiondetails?type=page', 'cid=private-cid')"
        : null,
    dataLabel: index === 406 ? "" : undefined,
  }));
  // The last fmain anchor is intentionally label-less: its safe route and
  // onclick handler are the only candidate clues available from the shell.
  const fmain = frameFor("fmain", anchors, []);
  const fmenu = frameFor("fmenu", [], []);
  const main = frameFor("main", [], []);
  const page = {
    frames: () => [main, fmain, fmenu],
    mainFrame: () => main,
    locator: () => locatorFor([], []),
  };
  const event = await collectAuthMenuDiagnostic(page as never, {
    provider: "yuanta",
    contractVersion: YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
  });
  assert.equal(event.truncated, false);
  assert.equal(event.observedAnchorCount, 407);
  assert.ok(
    event.frameSummaries.some(
      (summary) => summary.frameName === "fmain" && summary.anchorCount === 407,
    ),
  );
  const loan = event.candidates.find((candidate) => candidate.category === "loan");
  assert.ok(loan);
  assert.equal(loan.label, "Loan route");
  assert.equal(loan.pathname, "/nib/tx/loantransactiondetails");
  assert.equal(loan.action?.handlerId, "doAction");
  assert.doesNotMatch(JSON.stringify(event), /private-cid|cid=|route=page/iu);
});

test("auth menu readiness is bounded and fail-soft", async () => {
  let probes = 0;
  const waits: number[] = [];
  const ready = await waitForAuthMenuReadiness(
    async () => ++probes >= 3,
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    { timeoutMs: 100, pollIntervalMs: 10 },
  );
  assert.equal(ready, true);
  assert.equal(probes, 3);
  assert.deepEqual(waits, [10, 10]);

  let failedProbes = 0;
  const timedOut = await waitForAuthMenuReadiness(
    async () => {
      failedProbes += 1;
      throw new Error("provider password leaked");
    },
    async () => undefined,
    { timeoutMs: 0 },
  );
  assert.equal(timedOut, false);
  assert.equal(failedProbes, 1);
});

test("auth menu screenshot is an absolute private artifact", async () => {
  const root = await mkdtemp(join("/private/tmp", "auth-menu-diagnostic-"));
  const directory = join(root, "nested", "private-artifacts");
  const fakePage = {
    screenshot: async ({ path }: { path: string }) => {
      await writeFile(path, "png-fixture", { mode: 0o600 });
    },
  };
  const filePath = await captureAuthMenuScreenshot(
    fakePage as never,
    "fubon",
    directory,
  );
  assert.equal(filePath.startsWith("/"), true);
  assert.equal((await stat(filePath)).isFile(), true);
  assert.equal(await readFile(filePath, "utf8"), "png-fixture");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("screenshot failures expose only a safe status", async () => {
  const page = {
    waitForTimeout: async () => undefined,
    screenshot: async () => {
      throw new Error("Target page has been closed; password=fixture");
    },
  };
  const output = await executeAuthMenuDiagnostic({
    page: page as never,
    provider: "fubon",
    contractVersion: FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION,
    authenticate: async () => undefined,
    isReady: async () => true,
    collect: async () => fubon,
  });
  assert.equal(output.screenshotPath, null);
  assert.equal(output.screenshotStatus, "page-unavailable");
  assert.doesNotMatch(JSON.stringify(output), /password|fixture/iu);
});

const parsed = authMenuDiagnosticOutputSchema.safeParse({
  ...fubon,
  authentication: "succeeded",
  readiness: "ready",
  screenshotPath: "/private/tmp/fubon.png",
  screenshotStatus: "captured",
});
assert.equal(parsed.success, true);
