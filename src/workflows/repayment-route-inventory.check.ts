import assert from "node:assert/strict";
import {
  buildRepaymentRouteInventory,
  collectRepaymentRouteInventory,
  FUBON_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
  MAX_REPAYMENT_ROUTE_ANCHORS,
  MAX_REPAYMENT_ROUTE_ANCHORS_PER_SCOPE,
  MAX_REPAYMENT_ROUTE_CANDIDATES,
  MAX_REPAYMENT_ROUTE_SCOPES,
  REPAYMENT_ROUTE_INVENTORY_EVENT,
  YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
  type RepaymentRouteAnchorSnapshot,
} from "./repayment-route-inventory.ts";
import {
  FUBON_POST_AUTH_MENU_FIXTURE,
  YUANTA_FMENU_MENU_FIXTURE,
  YUANTA_POST_AUTH_MENU_FIXTURE,
} from "./repayment-route-inventory.fixtures.ts";

const fubon = buildRepaymentRouteInventory(
  "fubon",
  FUBON_POST_AUTH_MENU_FIXTURE,
  FUBON_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
assert.equal(fubon.event, REPAYMENT_ROUTE_INVENTORY_EVENT);
assert.equal(fubon.provider, "fubon");
assert.equal(
  fubon.contractVersion,
  FUBON_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
assert.equal(fubon.source, "post-authenticated-menu");
assert.equal(fubon.readMode, "dom-only");
assert.deepEqual(
  fubon.candidates.map(({ category, label }) => ({ category, label })),
  [
    { category: "autodebit", label: "自動扣繳設定" },
    { category: "loan", label: "貸款交易明細查詢" },
  ],
);
assert.ok(
  fubon.candidates.every(
    (candidate) =>
      candidate.pathname?.startsWith("/") || candidate.actionId !== null,
  ),
);

const yuanta = buildRepaymentRouteInventory(
  "yuanta",
  YUANTA_POST_AUTH_MENU_FIXTURE,
  YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
assert.equal(yuanta.provider, "yuanta");
assert.equal(
  yuanta.contractVersion,
  YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
assert.deepEqual(
  yuanta.candidates.map(({ category, label, actionId }) => ({
    category,
    label,
    actionId,
  })),
  [
    { category: "autodebit", label: "自動扣繳服務", actionId: "action:autodebit-menu" },
    { category: "detail", label: "基金交易明細", actionId: null },
    { category: "detail", label: "臺幣交易明細查詢", actionId: null },
    { category: "loan", label: "貸款繳款明細查詢", actionId: "handler:doAction" },
  ],
);

// Query strings, fragments, account-looking path segments, and onclick
// arguments never cross the telemetry boundary.
const sensitive = buildRepaymentRouteInventory(
  "yuanta",
  [
    {
      label: "貸款帳號 ******7890",
      href: "https://ebank.example/nib/tx/loantransactiondetails/12345678?cid=cid-123&account=12345678#secret",
      onclick:
        "doAction('/nib/tx/loantransactiondetails', 'cid-123', '12345678', 'otp-value')",
    },
    {
      label: "密碼設定",
      href: "/settings/password?account=12345678",
    },
    { label: "客服中心", href: "/service/contact" },
    { label: "隱藏貸款明細", href: "/loan/hidden", visible: false },
  ],
  YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
const sensitiveSerialized = JSON.stringify(sensitive);
assert.doesNotMatch(
  sensitiveSerialized,
  /cid|12345678|otp-value|secret|onclick|password|\*{2,}/iu,
);
assert.equal(sensitive.candidates.length, 1);
assert.equal(sensitive.candidates[0]?.maskedLabel, true);
assert.equal(sensitive.candidates[0]?.actionId, "handler:doAction");
assert.equal(sensitive.candidates[0]?.pathname, "/nib/tx/loantransactiondetails/:redacted");

// Dedupe and ordering are deterministic, and hidden/unrelated anchors are
// excluded using only the visible label.
const deterministicInputs: RepaymentRouteAnchorSnapshot[] = [
  { label: "交易明細", href: "/z-route" },
  { label: "貸款", href: "/loan-route" },
  { label: "交易明細", href: "/z-route" },
  { label: "自動扣繳", href: "/auto-route" },
  { label: "個人設定", href: "/loan-route" },
  { label: "隱藏貸款", href: "/hidden", visible: false },
];
const deterministic = buildRepaymentRouteInventory(
  "fubon",
  deterministicInputs,
  FUBON_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
const reversed = buildRepaymentRouteInventory(
  "fubon",
  [...deterministicInputs].reverse(),
  FUBON_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
assert.deepEqual(deterministic.candidates, reversed.candidates);
assert.equal(deterministic.candidates.length, 3);

const bounded = buildRepaymentRouteInventory(
  "fubon",
  Array.from({ length: MAX_REPAYMENT_ROUTE_ANCHORS + 10 }, (_, index) => {
    const first = String.fromCharCode(65 + (index % 26));
    const second = String.fromCharCode(
      65 + (Math.floor(index / 26) % 26),
    );
    const token = `${first}${second}`;
    return {
      label: `交易 Route-${token}`,
      href: `/route/route-${token}`,
    };
  }),
  FUBON_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
);
assert.equal(bounded.observedAnchorCount, MAX_REPAYMENT_ROUTE_ANCHORS);
assert.equal(bounded.truncated, true);
assert.equal(bounded.candidates.length, MAX_REPAYMENT_ROUTE_CANDIDATES);

function locatorFor(
  anchors: readonly RepaymentRouteAnchorSnapshot[],
  operations: string[],
) {
  return {
    count: async () => {
      operations.push("count");
      return anchors.length;
    },
    nth: (index: number) => {
      operations.push(`nth:${index}`);
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
          if (name === "href") return anchor.href ?? null;
          if (name === "onclick") return anchor.onclick ?? null;
          if (name === "data-action") return anchor.action ?? null;
          return null;
        },
      };
    },
  };
}

function frameFor(
  name: string,
  anchors: readonly RepaymentRouteAnchorSnapshot[],
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
const menuFrame = {
  locator: (selector: string) => {
    assert.equal(selector, "a");
    operations.push("locator:a");
    return locatorFor(YUANTA_POST_AUTH_MENU_FIXTURE, operations);
  },
};
const menuPage = {
  frames: () => [menuFrame],
  locator: (selector: string) => {
    assert.equal(selector, "a");
    operations.push("locator:a");
    return locatorFor(FUBON_POST_AUTH_MENU_FIXTURE, operations);
  },
};
const collected = await collectRepaymentRouteInventory(menuPage as never, {
  provider: "yuanta",
  contractVersion: YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
});
assert.equal(collected.provider, "yuanta");
assert.equal(collected.candidates.length, 6);
assert.ok(operations.length > 0);
assert.ok(
  operations.every((operation) =>
    !/^(?:click|goto|fetch|evaluate)(?::|$)/iu.test(operation),
  ),
);

// The authenticated Yuanta menu is nested below the top-level frame tree.
// Keep fmenu ahead of a large fmain document so the global budget cannot
// hide the repayment routes behind unrelated anchors.
const nestedOperations: string[] = [];
const nestedFmenu = frameFor(
  "fmenu",
  YUANTA_FMENU_MENU_FIXTURE,
  nestedOperations,
);
const nestedContainer = frameFor(
  "shell-container",
  [],
  nestedOperations,
  [nestedFmenu],
);
const largeFmain = frameFor(
  "fmain",
  Array.from(
    { length: MAX_REPAYMENT_ROUTE_ANCHORS_PER_SCOPE + 32 },
    (_, index) => ({
      label: `一般功能 ${index}`,
      href: `/nib/other/route-${index}`,
    }),
  ),
  nestedOperations,
);
const topLevelFrame = frameFor(
  "main",
  FUBON_POST_AUTH_MENU_FIXTURE,
  nestedOperations,
);
const frameAwarePage = {
  frames: () => [topLevelFrame, largeFmain, nestedContainer],
  mainFrame: () => topLevelFrame,
  locator: (selector: string) => {
    assert.equal(selector, "a");
    nestedOperations.push("page:locator:a");
    return locatorFor(FUBON_POST_AUTH_MENU_FIXTURE, nestedOperations);
  },
};
const frameAwareInventory = await collectRepaymentRouteInventory(
  frameAwarePage as never,
  {
    provider: "yuanta",
    contractVersion: YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
  },
);
assert.equal(frameAwareInventory.provider, "yuanta");
assert.equal(frameAwareInventory.truncated, true);
// The main Frame and Page represent the same top-level document. It must be
// traversed for descendants but not read as a second anchor source.
assert.equal(frameAwareInventory.observedAnchorCount, 135);
assert.ok(
  frameAwareInventory.candidates.some(
    (candidate) => candidate.label === "貸款繳款明細查詢",
  ),
);
assert.ok(
  frameAwareInventory.candidates.some(
    (candidate) => candidate.label === "自動扣繳服務",
  ),
);
assert.ok(
  frameAwareInventory.candidates.every(
    (candidate) => candidate.label !== "帳務總覽",
  ),
);
assert.ok(
  nestedOperations.every((operation) =>
    !/^(?:click|goto|fetch|evaluate)(?::|$)/iu.test(operation),
  ),
);
assert.ok(
  nestedOperations.filter((operation) => operation.includes("fmenu")).length > 0,
);
assert.ok(MAX_REPAYMENT_ROUTE_SCOPES > 1);

// Detached or cross-origin frames are best-effort inputs. The event must mark
// the inventory incomplete without serializing the browser's raw error text.
const failureOperations: string[] = [];
const detachedFrame = {
  name: () => "detached-frame",
  childFrames: () => {
    throw new Error("https://provider.invalid/private-cid=secret");
  },
  locator: () => {
    failureOperations.push("detached:locator");
    throw new Error("frame detached with account=12345678");
  },
};
const failureRoot = frameFor("main", [], failureOperations);
const failurePage = {
  frames: () => [failureRoot, detachedFrame],
  mainFrame: () => failureRoot,
  locator: (selector: string) => {
    assert.equal(selector, "a");
    failureOperations.push("page:locator:a");
    return locatorFor([], failureOperations);
  },
};
const failedFrameInventory = await collectRepaymentRouteInventory(
  failurePage as never,
  {
    provider: "yuanta",
    contractVersion: YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
  },
);
assert.equal(failedFrameInventory.truncated, true);
assert.equal(failedFrameInventory.candidates.length, 0);
assert.doesNotMatch(
  JSON.stringify(failedFrameInventory),
  /provider\.invalid|private-cid|12345678|account=|detached/iu,
);
