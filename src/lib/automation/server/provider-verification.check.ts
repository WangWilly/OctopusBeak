import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  HumanAssistanceContract,
  HumanVerificationRect,
} from "../human-assistance.ts";
import {
  normalizeHumanVerificationInput,
  type ViewerDialogAccess,
} from "./automation-viewer.ts";
import {
  createProviderVerificationHost,
  FUBON_CAPTCHA_IMAGE_SELECTOR,
  shouldAutoResumeProviderVerification,
  shouldCheckProviderVerificationCompletion,
  type ProviderVerificationPageRunner,
} from "./provider-verification.ts";
import {
  SINOPAC_CAPTCHA_IMAGE_SELECTOR,
  SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
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
  inputValue?: () => string;
  evaluateResult?: unknown;
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
  inputValue(): Promise<string>;
};

function fakeLocator(options: FakeLocatorOptions = {}): FakeLocator {
  let filledValue = "";
  const locator: FakeLocator = {
    first: () => locator,
    count: async () => options.count ?? 1,
    isVisible: async () => options.visible ?? true,
    boundingBox: async () => options.rect ?? targetRect,
    locator: (selector) => options.child?.(selector) ?? locator,
    evaluate: async (callback) => options.evaluateResult ?? callback(options.node),
    click: async () => options.onClick?.(),
    fill: async (value) => {
      filledValue = value;
      options.onFill?.(value);
    },
    inputValue: async () => options.inputValue?.() ?? filledValue,
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

function yuantaBankCaptchaContract(overrides: Partial<HumanAssistanceContract> = {}) {
  return contract("yuanta-bank.login.captcha-input", {
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "yuanta-bank.login.captcha-image",
      rect: { x: 10, y: 20, width: 96, height: 28 },
    },
    ...overrides,
  });
}

function sinopacCaptchaContract(overrides: Partial<HumanAssistanceContract> = {}) {
  return contract(SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID, {
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
      rect: { x: 150, y: 60, width: 100, height: 35 },
    },
    ...overrides,
  });
}

function fubonCaptchaContract(overrides: Partial<HumanAssistanceContract> = {}) {
  return contract("fubon.login.captcha-input", {
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "fubon.login.captcha-image",
      rect: { x: 10, y: 20, width: 158, height: 30 },
    },
    ...overrides,
  });
}

function fubonCaptchaPage(options: {
  source: unknown;
  rect?: HumanVerificationRect;
  screenshot?: (clip: HumanVerificationRect) => Buffer;
}) {
  const image = fakeLocator({
    visible: true,
    rect: options.rect ?? { x: 10, y: 20, width: 158, height: 30 },
    evaluateResult: options.source,
  });
  const frame = {
    locator(selector: string) {
      assert.equal(selector, FUBON_CAPTCHA_IMAGE_SELECTOR);
      return image;
    },
    url: () => "https://ebank.taipeifubon.com.tw/B2C/txn/txnFrame.faces",
    name: () => "txnFrame",
  };
  const screenshotCalls: HumanVerificationRect[] = [];
  const page = {
    locator: () => fakeLocator(),
    frame: (name: string) => name === "txnFrame" ? frame : null,
    url: () => "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces",
    screenshot: async ({ clip }: { clip: HumanVerificationRect }) => {
      screenshotCalls.push(clip);
      return options.screenshot?.(clip) ?? Buffer.from("forbidden-fallback");
    },
  };
  return { page, screenshotCalls };
}

function sinopacCaptchaPage(options: {
  source: unknown;
  rect?: HumanVerificationRect;
  screenshot?: (clip: HumanVerificationRect) => Buffer;
}) {
  const image = fakeLocator({
    visible: true,
    rect: options.rect ?? { x: 150, y: 60, width: 100, height: 35 },
    evaluateResult: options.source,
  });
  const screenshotCalls: HumanVerificationRect[] = [];
  const page = {
    locator(selector: string) {
      if (selector === SINOPAC_CAPTCHA_IMAGE_SELECTOR) return image;
      if (selector === SINOPAC_CAPTCHA_INPUT_SELECTOR) return fakeLocator();
      throw new Error(`unexpected selector: ${selector}`);
    },
    url: () => "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx",
    screenshot: async ({ clip }: { clip: HumanVerificationRect }) => {
      screenshotCalls.push(clip);
      return options.screenshot?.(clip) ?? Buffer.from("forbidden-fallback");
    },
  };
  return { page, screenshotCalls };
}

function yuantaCaptchaPage(options: {
  source: unknown;
  rect?: HumanVerificationRect;
  screenshot?: (clip: HumanVerificationRect) => Buffer;
  pageUrl?: string;
  frameUrl?: string;
}) {
  const image = fakeLocator({
    visible: true,
    rect: options.rect ?? { x: 10, y: 20, width: 96, height: 28 },
    evaluateResult: options.source,
  });
  const frame = {
    locator(selector: string) {
      assert.equal(selector, 'img[src*="GOTP"]:visible');
      return image;
    },
    url: () => options.frameUrl ?? "https://ebank.yuantabank.com.tw/nib/main.jsp",
    name: () => "main",
  };
  const screenshotCalls: HumanVerificationRect[] = [];
  const page = {
    locator: () => fakeLocator(),
    mainFrame: () => frame,
    frame: (name: string) => name === "main" ? frame : null,
    url: () => options.pageUrl ?? "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
    screenshot: async ({ clip }: { clip: HumanVerificationRect }) => {
      screenshotCalls.push(clip);
      return options.screenshot?.(clip) ?? Buffer.from("fallback-screenshot");
    },
  };
  return { page, screenshotCalls };
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
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-word" },
      { imagePreprocessing: [], ocrOutputStage: "grayscale", ocrPageSegmentationMode: "single-line" },
    ] as const,
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
  assert.deepEqual(input?.ocrAttemptPlan, metadata().ocrAttemptPlan);
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
  assert.deepEqual(input?.ocrAttemptPlan, metadata().ocrAttemptPlan);
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

test("SinoPac selector-backed fill fails when the field does not retain the answer", async () => {
  const inputLocator = fakeLocator({ inputValue: () => "" });
  const withPage = pageRunner(fakePage({ [SINOPAC_CAPTCHA_INPUT_SELECTOR]: inputLocator }));
  const host = createProviderVerificationHost({
    withPage,
    sendInput: async (session, rawInput, verificationContract, handler) => {
      const normalized = normalizeHumanVerificationInput(rawInput, verificationContract);
      const target = verificationContract.targets[0];
      assert.ok(target && handler);
      return withPage(session, (page) => handler(page, normalized, target));
    },
  });
  const verificationContract = contract(SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID);
  await assert.rejects(
    host.injectAnswer("session-sinopac", verificationContract, "120987"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "SinoPac CAPTCHA input did not retain the solver answer.",
  );
});

test("SinoPac host probe proves a CAPTCHA rejection from the provider dialog", async () => {
  const dialogs = new EventEmitter();
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-sinopac",
    sinopacCaptchaContract(),
    async () => {
      dialogs.emit("dialog", {
        type: () => "alert",
        message: () => "驗證碼失效或輸入錯誤，請重新輸入。",
        dismiss: async () => {},
      });
    },
    async () => {},
  );
  assert.equal(outcome, "provider-rejected");
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("SinoPac host probe keeps a proven rejection when resume fails after the dialog", async () => {
  const dialogs = new EventEmitter();
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-sinopac",
    sinopacCaptchaContract(),
    async () => {
      dialogs.emit("dialog", {
        type: () => "alert",
        message: () => "驗證碼失效或輸入錯誤，請重新輸入。",
        dismiss: async () => {},
      });
      throw new Error("workflow stopped at the provider dialog");
    },
    async () => {},
  );
  assert.equal(outcome, "provider-rejected");
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("SinoPac host probe recognizes only the exact provider CAPTCHA wording", async () => {
  const dialogs = new EventEmitter();
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-sinopac",
    sinopacCaptchaContract(),
    async () => {
      dialogs.emit("dialog", {
        type: () => "alert",
        message: () => "驗證碼失效或輸入錯誤，請重新輸入。",
        dismiss: async () => {},
      });
    },
    async () => {},
  );
  assert.equal(outcome, "provider-rejected");
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("SinoPac host probe fails closed for near-match and account-lock wording", async () => {
  for (const message of [
    "驗證碼不正確，請重新輸入",
    "驗證碼失效或輸入錯誤，請重新輸入",
    "帳號已被鎖定，請聯絡客服",
  ]) {
    const dialogs = new EventEmitter();
    let cleanupCount = 0;
    let releaseResume!: () => void;
    const host = createProviderVerificationHost({
      withPage: async (_session, action) => action({
        onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
        offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
      } as never),
      sleep: async () => {},
    });
    const outcome = await host.probePostSubmit(
      "session-sinopac-unknown-dialog",
      sinopacCaptchaContract(),
      async () => {
        dialogs.emit("dialog", {
          type: () => "alert",
          message: () => message,
          dismiss: async () => {},
        });
        await new Promise<void>((resolve) => {
          releaseResume = resolve;
        });
      },
      async () => {
        cleanupCount += 1;
        releaseResume();
      },
    );
    assert.equal(outcome, "unrecognized-dialog");
    assert.equal(cleanupCount, 1);
    assert.equal(dialogs.listenerCount("dialog"), 0);
  }
});

test("SinoPac host fails closed before resume when dialog hooks are unavailable", async () => {
  let resumeCalls = 0;
  let cleanupCalls = 0;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({} as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-sinopac-missing-hooks",
    sinopacCaptchaContract(),
    async () => { resumeCalls += 1; },
    async () => { cleanupCalls += 1; },
  );
  assert.equal(outcome, "unrecognized-dialog");
  assert.equal(resumeCalls, 0);
  assert.equal(cleanupCalls, 0);
});

test("SinoPac host fails closed before resume when cleanup capability is unavailable", async () => {
  const dialogs = new EventEmitter();
  let resumeCalls = 0;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-sinopac-missing-cleanup",
    sinopacCaptchaContract(),
    async () => { resumeCalls += 1; },
  );
  assert.equal(outcome, "unrecognized-dialog");
  assert.equal(resumeCalls, 0);
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("SinoPac host joins cleanup before returning a CAPTCHA rejection", async () => {
  const dialogs = new EventEmitter();
  let dismissCount = 0;
  let cleanupCount = 0;
  let resumeSettled = false;
  let releaseResume!: () => void;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcomePromise = host.probePostSubmit(
    "session-sinopac-stalled-resume",
    sinopacCaptchaContract(),
    async () => new Promise<void>((resolve) => {
      releaseResume = resolve;
    }).then(() => {
      resumeSettled = true;
    }),
    async () => {
      cleanupCount += 1;
      releaseResume();
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  dialogs.emit("dialog", {
    type: () => "alert",
    message: () => "驗證碼失效或輸入錯誤，請重新輸入。",
    dismiss: async () => {
      dismissCount += 1;
    },
  });
  const outcome = await outcomePromise;
  assert.equal(outcome, "provider-rejected");
  assert.equal(dismissCount, 1);
  assert.equal(cleanupCount, 1);
  assert.equal(resumeSettled, true);
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("SinoPac host fails closed when dialog dismissal exceeds its bound", async () => {
  const dialogs = new EventEmitter();
  let releaseResume!: () => void;
  let dismissStarted = false;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcomePromise = host.probePostSubmit(
    "session-sinopac-delayed-dismiss",
    sinopacCaptchaContract(),
    async () => new Promise<void>((resolve) => {
      releaseResume = resolve;
    }),
    async () => releaseResume(),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  dialogs.emit("dialog", {
    type: () => "alert",
    message: () => "驗證碼失效或輸入錯誤，請重新輸入。",
    dismiss: async () => {
      dismissStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
    },
  });
  assert.equal(await outcomePromise, "unrecognized-dialog");
  assert.equal(dismissStarted, true);
});

test("SinoPac host fails closed when dialog dismissal rejects", async () => {
  const dialogs = new EventEmitter();
  let releaseResume!: () => void;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcomePromise = host.probePostSubmit(
    "session-sinopac-failed-dismiss",
    sinopacCaptchaContract(),
    async () => new Promise<void>((resolve) => {
      releaseResume = resolve;
    }),
    async () => releaseResume(),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  dialogs.emit("dialog", {
    type: () => "alert",
    message: () => "驗證碼失效或輸入錯誤，請重新輸入。",
    dismiss: async () => {
      throw new Error("dialog already closed");
    },
  });
  assert.equal(await outcomePromise, "unrecognized-dialog");
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("SinoPac host probe fails closed for a non-CAPTCHA dialog", async () => {
  const dialogs = new EventEmitter();
  let dismissCount = 0;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-sinopac",
    sinopacCaptchaContract(),
    async () => {
      dialogs.emit("dialog", {
        type: () => "alert",
        message: () => "帳號或密碼錯誤",
        dismiss: async () => {
          dismissCount += 1;
        },
      });
    },
    async () => {},
  );
  assert.equal(outcome, "unrecognized-dialog");
  assert.equal(dismissCount, 1);
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("SinoPac host probe returns normal completion when the resumed workflow succeeds without a dialog", async () => {
  const dialogs = new EventEmitter();
  let dismissCount = 0;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-sinopac-success",
    sinopacCaptchaContract(),
    async () => {},
    async () => {},
  );
  assert.equal(outcome, "none");
  assert.equal(dismissCount, 0);
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("Yuanta host probe routes the observed CAPTCHA rejection to the retry campaign", async () => {
  const dialogs = new EventEmitter();
  let dismissCount = 0;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcome = await host.probePostSubmit(
    "session-yuanta",
    yuantaBankCaptchaContract(),
    async () => {
      dialogs.emit("dialog", {
        type: () => "alert",
        message: () => "驗證碼不正確，請重新輸入",
        dismiss: async () => { dismissCount += 1; },
      });
    },
    async () => {},
  );
  assert.equal(outcome, "provider-rejected");
  assert.equal(dismissCount, 1);
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("Yuanta host probe fails closed for an unrecognized or non-CAPTCHA dialog", async () => {
  for (const message of [
    "驗證碼錯誤，請重新輸入",
    "帳號或密碼錯誤",
  ]) {
    const dialogs = new EventEmitter();
    let dismissCount = 0;
    let releaseResume!: () => void;
    const host = createProviderVerificationHost({
      withPage: async (_session, action) => action({
        onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
        offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
      } as never),
      sleep: async () => {},
    });
    const outcomePromise = host.probePostSubmit(
      "session-yuanta-unknown",
      yuantaBankCaptchaContract(),
      async () => {
        dialogs.emit("dialog", {
          type: () => "alert",
          message: () => message,
          dismiss: async () => { dismissCount += 1; },
        });
        await new Promise<void>((resolve) => { releaseResume = resolve; });
      },
      async () => releaseResume(),
    );
    const outcome = await outcomePromise;
    assert.equal(outcome, "unrecognized-dialog");
    assert.equal(dismissCount, 1);
    assert.equal(dialogs.listenerCount("dialog"), 0);
  }
});

test("Yuanta host probe joins cleanup before returning the observed rejection", async () => {
  const dialogs = new EventEmitter();
  const events: string[] = [];
  let releaseResume!: () => void;
  const host = createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.on("dialog", handler),
      offDialog: (handler: (dialog: ViewerDialogAccess) => void) => dialogs.off("dialog", handler),
    } as never),
    sleep: async () => {},
  });
  const outcomePromise = host.probePostSubmit(
    "session-yuanta-stalled-resume",
    yuantaBankCaptchaContract(),
    async () => {
      events.push("resume-started");
      await new Promise<void>((resolve) => { releaseResume = resolve; });
      events.push("resume-settled");
    },
    async () => {
      events.push("cleanup-started");
      releaseResume();
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  dialogs.emit("dialog", {
    type: () => "alert",
    message: () => "驗證碼不正確，請重新輸入",
    dismiss: async () => { events.push("dismissed"); },
  });
  assert.equal(await outcomePromise, "provider-rejected");
  assert.deepEqual(events, [
    "resume-started",
    "dismissed",
    "cleanup-started",
    "resume-settled",
  ]);
  assert.equal(dialogs.listenerCount("dialog"), 0);
});

test("Fubon source capture uses loaded 158 by 30 DOM pixels", async () => {
  const naturalPixels = Buffer.from("fubon-natural-158x30");
  const source = {
    dataUrl: `data:image/png;base64,${naturalPixels.toString("base64")}`,
    sourceMarker: "fubon-image-v1",
    frameMarker: "fubon-frame-v1",
    naturalWidth: 158,
    naturalHeight: 30,
  };
  const { page, screenshotCalls } = fubonCaptchaPage({ source });
  const host = createProviderVerificationHost({ withPage: pageRunner(page as never) });

  assert.equal(host.handlesChallengeImage(fubonCaptchaContract()), true);
  assert.deepEqual(
    await host.captureChallengeImage("session-fubon-source", fubonCaptchaContract()),
    naturalPixels,
  );
  assert.deepEqual(screenshotCalls, []);
});

test("Fubon DOM capture fails closed without screenshot or URL refetch", async () => {
  let refetches = 0;
  for (const source of [
    {
      dataUrl: null,
      sourceMarker: "fubon-image-v1",
      frameMarker: "fubon-frame-v1",
      naturalWidth: 158,
      naturalHeight: 30,
    },
    {
      dataUrl: `data:image/png;base64,${Buffer.from("wrong-size").toString("base64")}`,
      sourceMarker: "fubon-image-v1",
      frameMarker: "fubon-frame-v1",
      naturalWidth: 157,
      naturalHeight: 30,
    },
  ]) {
    const { page, screenshotCalls } = fubonCaptchaPage({
      source,
      screenshot: () => {
        refetches += 1;
        return Buffer.from("forbidden-fallback");
      },
    });
    (page as unknown as { request?: () => never }).request = () => {
      refetches += 1;
      throw new Error("CAPTCHA URL must not be refetched.");
    };
    const host = createProviderVerificationHost({ withPage: pageRunner(page as never) });
    assert.equal(
      await host.captureChallengeImage("session-fubon-unsupported", fubonCaptchaContract()),
      null,
    );
    assert.deepEqual(screenshotCalls, []);
  }
  assert.equal(refetches, 0);
});

test("Fubon source fingerprint rejects changed DOM pixels", async () => {
  let version = 1;
  const withPage: ProviderVerificationPageRunner = async (_session, action) => {
    const pixels = Buffer.from(`fubon-natural-v${version}`);
    const source = {
      dataUrl: `data:image/png;base64,${pixels.toString("base64")}`,
      sourceMarker: `fubon-image-v${version}`,
      frameMarker: "fubon-frame-v1",
      naturalWidth: 158,
      naturalHeight: 30,
    };
    const { page } = fubonCaptchaPage({ source });
    const result = await action(page as never);
    version += 1;
    return result;
  };
  const host = createProviderVerificationHost({ withPage });

  assert.deepEqual(
    await host.captureChallengeImage("session-fubon-stale", fubonCaptchaContract()),
    Buffer.from("fubon-natural-v1"),
  );
  assert.equal(
    await host.isChallengeImageCurrent("session-fubon-stale", fubonCaptchaContract()),
    false,
  );
});

test("SinoPac source capture uses calibrated natural pixels and never the CSS-sized screenshot", async () => {
  const naturalPixels = Buffer.from("sinopac-natural-120x40");
  const source = {
    dataUrl: `data:image/png;base64,${naturalPixels.toString("base64")}`,
    sourceMarker: "sinopac-image-v1",
    frameMarker: "sinopac-page-v1",
    naturalWidth: 120,
    naturalHeight: 40,
  };
  const { page, screenshotCalls } = sinopacCaptchaPage({ source });
  const host = createProviderVerificationHost({ withPage: pageRunner(page as never) });
  assert.equal(host.handlesChallengeImage(sinopacCaptchaContract()), true);
  assert.deepEqual(
    await host.captureChallengeImage("session-sinopac-source", sinopacCaptchaContract()),
    naturalPixels,
  );
  assert.deepEqual(screenshotCalls, []);
});

test("SinoPac source capture fails closed for missing pixels or unsupported natural geometry", async () => {
  for (const source of [
    {
      dataUrl: null,
      sourceMarker: "sinopac-image-v1",
      frameMarker: "sinopac-page-v1",
      naturalWidth: 120,
      naturalHeight: 40,
    },
    {
      dataUrl: `data:image/png;base64,${Buffer.from("css-sized").toString("base64")}`,
      sourceMarker: "sinopac-image-v1",
      frameMarker: "sinopac-page-v1",
      naturalWidth: 100,
      naturalHeight: 35,
    },
  ]) {
    const { page, screenshotCalls } = sinopacCaptchaPage({ source });
    const host = createProviderVerificationHost({ withPage: pageRunner(page as never) });
    assert.equal(
      await host.captureChallengeImage("session-sinopac-unsupported", sinopacCaptchaContract()),
      null,
    );
    assert.deepEqual(screenshotCalls, []);
  }
});

test("SinoPac source fingerprint rejects a changed CAPTCHA before answer injection", async () => {
  let version = 1;
  const withPage: ProviderVerificationPageRunner = async (_session, action) => {
    const pixels = Buffer.from(`sinopac-natural-v${version}`);
    const source = {
      dataUrl: `data:image/png;base64,${pixels.toString("base64")}`,
      sourceMarker: `sinopac-image-v${version}`,
      frameMarker: "sinopac-page-v1",
      naturalWidth: 120,
      naturalHeight: 40,
    };
    const { page } = sinopacCaptchaPage({ source });
    const result = await action(page as never);
    version += 1;
    return result;
  };
  const host = createProviderVerificationHost({ withPage });
  const contractValue = sinopacCaptchaContract();
  assert.deepEqual(
    await host.captureChallengeImage("session-sinopac-stale", contractValue),
    Buffer.from("sinopac-natural-v1"),
  );
  assert.equal(
    await host.isChallengeImageCurrent("session-sinopac-stale", contractValue),
    false,
  );
});

test("Yuanta source capture uses loaded natural pixels instead of the CSS-sized rectangle", async () => {
  const naturalPixels = Buffer.from("yuanta-natural-180x50");
  const source = {
    dataUrl: `data:image/png;base64,${naturalPixels.toString("base64")}`,
    sourceMarker: "yuanta-image-v1",
    frameMarker: "frame-v1",
    naturalWidth: 180,
    naturalHeight: 50,
  };
  const { page, screenshotCalls } = yuantaCaptchaPage({
    source,
    rect: { x: 10, y: 20, width: 96, height: 28 },
  });
  const host = createProviderVerificationHost({ withPage: pageRunner(page as never) });
  const image = await host.captureChallengeImage("session-yuanta-source", yuantaBankCaptchaContract());
  assert.deepEqual(image, naturalPixels);
  assert.deepEqual(screenshotCalls, []);
});

test("Yuanta loaded-image capture fails closed without a screenshot fallback", async () => {
  let refetches = 0;
  const source = {
    dataUrl: null,
    sourceMarker: "yuanta-image-v1",
    frameMarker: "frame-v1",
    naturalWidth: 180,
    naturalHeight: 50,
  };
  const { page, screenshotCalls } = yuantaCaptchaPage({
    source,
    screenshot: () => {
      refetches += 1;
      return Buffer.from("forbidden-fallback");
    },
  });
  (page as unknown as { request?: () => never }).request = () => {
    refetches += 1;
    throw new Error("CAPTCHA URL must not be refetched.");
  };
  const host = createProviderVerificationHost({ withPage: pageRunner(page as never) });
  const image = await host.captureChallengeImage("session-yuanta-fallback", yuantaBankCaptchaContract());
  assert.equal(image, null);
  assert.equal(refetches, 0);
  assert.deepEqual(screenshotCalls, []);
});

test("missing source captures fail freshness closed", async () => {
  const host = createProviderVerificationHost({
    withPage: pageRunner({ locator: () => fakeLocator() } as never),
  });
  assert.equal(
    await host.isChallengeImageCurrent("session-without-capture", yuantaBankCaptchaContract()),
    false,
  );
});

test("Yuanta source fingerprint rejects a replaced frame or changed image before injection", async () => {
  const naturalPixels = Buffer.from("yuanta-natural-180x50");
  let frameVersion = 1;
  const withPage: ProviderVerificationPageRunner = async (_session, action) => {
    const source = {
      dataUrl: `data:image/png;base64,${naturalPixels.toString("base64")}`,
      sourceMarker: `yuanta-image-v${frameVersion}`,
      frameMarker: `frame-v${frameVersion}`,
      naturalWidth: 180,
      naturalHeight: 50,
    };
    const { page } = yuantaCaptchaPage({ source });
    const result = await action(page as never);
    frameVersion += 1;
    return result;
  };
  const host = createProviderVerificationHost({ withPage });
  const contractValue = yuantaBankCaptchaContract();
  assert.deepEqual(
    await host.captureChallengeImage("session-yuanta-stale", contractValue),
    naturalPixels,
  );
  assert.equal(await host.isChallengeImageCurrent("session-yuanta-stale", contractValue), false);
});

test("Yuanta source fingerprint rejects a stale live rectangle even when image bytes are unchanged", async () => {
  const naturalPixels = Buffer.from("yuanta-natural-180x50");
  let moved = false;
  const withPage: ProviderVerificationPageRunner = async (_session, action) => {
    const source = {
      dataUrl: `data:image/png;base64,${naturalPixels.toString("base64")}`,
      sourceMarker: "yuanta-image-v1",
      frameMarker: "frame-v1",
      naturalWidth: 180,
      naturalHeight: 50,
    };
    const { page } = yuantaCaptchaPage({
      source,
      rect: moved ? { x: 40, y: 20, width: 96, height: 28 } : undefined,
    });
    const result = await action(page as never);
    moved = true;
    return result;
  };
  const host = createProviderVerificationHost({ withPage });
  const contractValue = yuantaBankCaptchaContract();
  await host.captureChallengeImage("session-yuanta-stale-rect", contractValue);
  assert.equal(
    await host.isChallengeImageCurrent("session-yuanta-stale-rect", contractValue),
    false,
  );
});

test("only adapters with calibrated source capture own challenge images", () => {
  const host = createProviderVerificationHost({
    withPage: pageRunner({ locator: () => fakeLocator() } as never),
  });
  assert.equal(host.handlesChallengeImage(sinopacCaptchaContract()), true);
  assert.equal(host.handlesChallengeImage(yuantaBankCaptchaContract()), true);
  assert.equal(
    host.handlesChallengeImage(contract("yuanta-bank.login.captcha-input")),
    false,
  );
  assert.equal(host.handlesChallengeImage(contract("cathay.login.email-otp-input")), false);
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
