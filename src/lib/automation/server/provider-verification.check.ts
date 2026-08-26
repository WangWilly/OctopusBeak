import assert from "node:assert/strict";
import test from "node:test";
import type {
  HumanAssistanceContract,
  HumanVerificationRect,
} from "../human-assistance.ts";
import {
  normalizeHumanVerificationInput,
} from "./automation-viewer.ts";
import {
  createProviderVerificationHost,
  shouldAutoResumeProviderVerification,
  shouldCheckProviderVerificationCompletion,
  type ProviderVerificationPageRunner,
} from "./provider-verification.ts";
import {
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
} from "../sinopac-captcha.ts";
import {
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
} from "../yuanta-trade-captcha.ts";

const targetRect: HumanVerificationRect = { x: 10, y: 20, width: 100, height: 40 };

function contract(
  semanticId: string,
  overrides: Partial<HumanAssistanceContract> = {},
): HumanAssistanceContract {
  return {
    schemaVersion: 1,
    version: 3,
    stageId: "verification",
    title: "Complete verification",
    targets: [{
      id: "verification-target",
      label: "Verification target",
      semanticId,
      modes: ["click", "type"],
      rect: targetRect,
    }],
    contextRegions: [],
    completion: {
      mode: "inline",
      targetIds: ["verification-target"],
      status: "pending",
    },
    focus: { targetId: "verification-target", contextRegionIds: [] },
    ...overrides,
  };
}

type FakeLocatorOptions = {
  count?: number;
  visible?: boolean;
  rect?: HumanVerificationRect | null;
  node?: unknown;
  child?: (selector: string) => FakeLocator;
  onClick?: () => void;
  onFill?: (value: string) => void;
};

type FakeLocator = {
  first(): FakeLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  boundingBox(): Promise<HumanVerificationRect | null>;
  locator(selector: string): FakeLocator;
  evaluate(callback: (node: unknown) => unknown): Promise<unknown>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
};

function fakeLocator(options: FakeLocatorOptions = {}): FakeLocator {
  const locator: FakeLocator = {
    first: () => locator,
    count: async () => options.count ?? 1,
    isVisible: async () => options.visible ?? true,
    boundingBox: async () => options.rect ?? targetRect,
    locator: (selector) => options.child?.(selector) ?? locator,
    evaluate: async (callback) => callback(options.node),
    click: async () => options.onClick?.(),
    fill: async (value) => options.onFill?.(value),
  };
  return locator;
}

function fakePage(locators: Record<string, FakeLocator>) {
  return {
    locator(selector: string) {
      const locator = locators[selector];
      assert.ok(locator, `unexpected selector: ${selector}`);
      return locator;
    },
  } as never;
}

function pageRunner(page: never): ProviderVerificationPageRunner {
  return async (_session, action) => action(page);
}

class FakeInputElement {
  checked = true;
  classList = { contains: () => false };
  parentElement = null;

  getAttribute(name: string) {
    return name === "aria-checked" ? "true" : null;
  }
}

async function withFakeInputElement<T>(action: () => Promise<T>) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.HTMLInputElement;
  globals.HTMLInputElement = FakeInputElement;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete globals.HTMLInputElement;
    else globals.HTMLInputElement = previous;
  }
}

function metadata() {
  return {
    challengeKind: "text-captcha" as const,
    challengeImageRegion: {
      id: "challenge-image",
      label: "Challenge image",
      semanticId: "verification.challenge-image",
      rect: { x: 100, y: 200, width: 120, height: 48 },
    },
    charset: "digits" as const,
    imagePreprocessing: ["remove-interference-lines"] as const,
    ocrPageSegmentationMode: "single-word" as const,
    solverConfidenceThreshold: 0.8,
    expectedAnswerLength: 5,
    prompt: "Enter the digits shown.",
  };
}

test("the host routes completion checks to the provider adapter", () => {
  assert.equal(
    shouldCheckProviderVerificationCompletion(
      "click",
      "yuanta-trade.login.captcha-checkbox",
    ),
    true,
  );
  assert.equal(
    shouldCheckProviderVerificationCompletion(
      "click",
      "yuanta-trade.login.challenge-submit",
    ),
    true,
  );
  assert.equal(
    shouldCheckProviderVerificationCompletion(
      "type",
      "yuanta-trade.login.challenge-submit",
    ),
    false,
  );
  assert.equal(
    shouldCheckProviderVerificationCompletion(
      "click",
      "cathay.login.email-otp-input",
    ),
    false,
  );
  assert.equal(
    shouldCheckProviderVerificationCompletion(
      "click",
      "sinopac.login.captcha-input",
    ),
    false,
  );
});

test("only the independent provider stage can auto-resume after verification", () => {
  assert.equal(
    shouldAutoResumeProviderVerification(
      contract("yuanta-trade.login.captcha-checkbox", {
        stageId: "yuanta-trade-captcha-checkbox",
        completion: {
          mode: "independent",
          targetIds: ["verification-target"],
          status: "pending",
        },
      }),
      "verification-target",
      true,
    ),
    true,
  );
  assert.equal(
    shouldAutoResumeProviderVerification(
      contract("yuanta-trade.login.captcha-checkbox", {
        stageId: "yuanta-trade-captcha-checkbox",
        completion: {
          mode: "independent",
          targetIds: ["verification-target"],
          status: "pending",
        },
      }),
      "verification-target",
      false,
    ),
    false,
  );
  assert.equal(
    shouldAutoResumeProviderVerification(
      contract("yuanta-trade.login.captcha-checkbox", {
        stageId: "other-stage",
      }),
      "verification-target",
      true,
    ),
    false,
  );
  assert.equal(
    shouldAutoResumeProviderVerification(
      contract("cathay.login.email-otp-input"),
      "verification-target",
      true,
    ),
    false,
  );
});

test("Cathay refresh resolves the live OTP geometry and preserves the contract metadata", async () => {
  const refreshedRect = { x: 30, y: 40, width: 120, height: 32 };
  const otp = fakeLocator({ rect: refreshedRect });
  const host = createProviderVerificationHost({
    withPage: pageRunner(fakePage({ "#OtpMailPassword": otp })),
  });
  const input = await host.refreshTarget(
    "session-cathay",
    contract("cathay.login.email-otp-input", metadata()),
  );
  assert.equal(input?.targets[0]?.rect?.y, 40);
  assert.deepEqual(input?.challengeImageRegion, metadata().challengeImageRegion);
  assert.equal(input?.challengeKind, "text-captcha");
  assert.equal(input?.charset, "digits");
  assert.deepEqual(input?.imagePreprocessing, ["remove-interference-lines"]);
  assert.equal(input?.ocrPageSegmentationMode, "single-word");
  assert.equal(input?.solverConfidenceThreshold, 0.8);
  assert.equal(input?.expectedAnswerLength, 5);
  assert.equal(input?.prompt, "Enter the digits shown.");
});

test("SinoPac refresh resolves the live CAPTCHA geometry", async () => {
  const selectors: string[] = [];
  const inputLocator = fakeLocator({
    rect: { x: 50, y: 60, width: 122, height: 35 },
  });
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      locator(selector: string) {
        selectors.push(selector);
        return inputLocator;
      },
    } as never),
  });
  const input = await host.refreshTarget(
    "session-sinopac",
    contract(SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID, metadata()),
  );
  assert.equal(input?.targets[0]?.rect?.y, 60);
  assert.deepEqual(selectors, [SINOPAC_CAPTCHA_INPUT_SELECTOR]);
  assert.deepEqual(input?.challengeImageRegion, metadata().challengeImageRegion);
  assert.equal(input?.charset, "digits");
  assert.deepEqual(input?.imagePreprocessing, ["remove-interference-lines"]);
  assert.equal(input?.ocrPageSegmentationMode, "single-word");
  assert.equal(input?.solverConfidenceThreshold, 0.8);
  assert.equal(input?.expectedAnswerLength, 5);
  assert.equal(input?.prompt, "Enter the digits shown.");
});

test("SinoPac adapter owns selector-backed click and fill operations", async () => {
  const clicks: string[] = [];
  const fills: string[] = [];
  const inputLocator = fakeLocator({
    onClick: () => clicks.push("click"),
    onFill: (value) => fills.push(value),
  });
  const withPage = pageRunner(fakePage({ [SINOPAC_CAPTCHA_INPUT_SELECTOR]: inputLocator }));
  const host = createProviderVerificationHost({
    withPage,
    sendInput: async (session, rawInput, verificationContract, handler) => {
      const normalized = normalizeHumanVerificationInput(rawInput, verificationContract);
      const record = rawInput as Record<string, unknown>;
      const target = verificationContract.targets.find((candidate) => candidate.id === record.targetId);
      assert.ok(target && handler);
      return withPage(session, (page) => handler(page, normalized, target));
    },
  });
  const verificationContract = contract(SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID);
  await host.sendInput("session-sinopac", {
    type: "click",
    x: 20,
    y: 30,
    targetId: "verification-target",
    contractVersion: verificationContract.version,
  }, verificationContract);
  await host.sendInput("session-sinopac", {
    type: "type",
    text: "1234",
    targetId: "verification-target",
    contractVersion: verificationContract.version,
  }, verificationContract);
  assert.deepEqual(clicks, ["click"]);
  assert.deepEqual(fills, ["1234"]);
});

function yuantaPage(options: {
  checkboxChecked?: boolean;
  challengeVisible?: boolean;
  submitVisible?: boolean;
  submitRect?: HumanVerificationRect;
}) {
  const checkbox = fakeLocator({
    node: options.checkboxChecked ? new FakeInputElement() : {
      getAttribute: () => "false",
      classList: { contains: () => false },
      parentElement: null,
    },
  });
  const submit = fakeLocator({
    visible: options.submitVisible ?? true,
    rect: options.submitRect ?? { x: 250, y: 260, width: 80, height: 30 },
  });
  const challenge = fakeLocator({
    visible: options.challengeVisible ?? false,
    child: (selector) => {
      assert.equal(selector, YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR);
      return submit;
    },
  });
  return fakePage({
    ["#chbYCaptchaV2"]: checkbox,
    [YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR]: challenge,
  });
}

test("Yuanta completion inspection evaluates the checkbox and challenge probe", async () => {
  await withFakeInputElement(async () => {
    const host = createProviderVerificationHost({
      withPage: pageRunner(yuantaPage({ checkboxChecked: true, challengeVisible: false })),
    });
    const verificationContract = contract("yuanta-trade.login.captcha-checkbox", {
      stageId: "yuanta-trade-captcha-checkbox",
      completion: {
        mode: "independent",
        targetIds: ["verification-target"],
        status: "pending",
      },
    });
    assert.equal(await host.inspectCompletion("session-yuanta", verificationContract), true);
  });
});

test("Yuanta refresh adds the dynamic submit target and preserves all metadata", async () => {
  const refreshedRect = { x: 280, y: 290, width: 90, height: 34 };
  const host = createProviderVerificationHost({
    withPage: pageRunner(yuantaPage({
      challengeVisible: true,
      submitVisible: true,
      submitRect: refreshedRect,
    })),
  });
  const verificationContract = contract("yuanta-trade.login.challenge-control", {
    stageId: "yuanta-trade-challenge",
    completion: {
      mode: "independent",
      targetIds: ["verification-target"],
      status: "pending",
    },
    ...metadata(),
  });
  const input = await host.refreshTarget("session-yuanta", verificationContract);
  const submit = input?.targets.find((target) => target.id === "challenge-submit");
  assert.deepEqual(submit?.rect, refreshedRect);
  assert.deepEqual(input?.completion.targetIds, ["verification-target", "challenge-submit"]);
  assert.equal(input?.completion.status, "pending");
  assert.equal(input?.challengeKind, "text-captcha");
  assert.deepEqual(input?.challengeImageRegion, verificationContract.challengeImageRegion);
  assert.equal(input?.charset, "digits");
  assert.deepEqual(input?.imagePreprocessing, ["remove-interference-lines"]);
  assert.equal(input?.ocrPageSegmentationMode, "single-word");
  assert.equal(input?.solverConfidenceThreshold, 0.8);
  assert.equal(input?.expectedAnswerLength, 5);
  assert.equal(input?.prompt, "Enter the digits shown.");
});

test("Yuanta completion polling uses the injected wait seam", async () => {
  let inspections = 0;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => {
      inspections += 1;
      return action(yuantaPage({
        checkboxChecked: false,
        challengeVisible: inspections === 1,
      }));
    },
    sleep: async () => {},
  });
  const verificationContract = contract("yuanta-trade.login.challenge-control", {
    completion: {
      mode: "independent",
      targetIds: ["verification-target"],
      status: "pending",
    },
  });
  await withFakeInputElement(async () => {
    assert.equal(
      await host.waitForCompletion("session-yuanta", verificationContract, 3, 0),
      true,
    );
  });
  assert.equal(inspections, 2);
});
