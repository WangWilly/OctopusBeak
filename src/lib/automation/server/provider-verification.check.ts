import assert from "node:assert/strict";
import test from "node:test";
import type {
  HumanAssistanceContract,
  HumanVerificationRect,
} from "../human-assistance.ts";
import { normalizeHumanVerificationInput } from "./automation-viewer.ts";
import {
  createProviderVerificationHost,
  FUBON_CAPTCHA_IMAGE_SELECTOR,
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

test("Post solver fills its semantic CAPTCHA field despite stale coordinates over the user-code field", async () => {
  const fills: string[] = [];
  const captcha = fakeLocator({ onFill: value => fills.push(value) });
  const withPage = pageRunner(fakePage({ 'input[name="captcha"]:visible': captcha }));
  const host = createProviderVerificationHost({
    withPage,
    sendInput: async (session, rawInput, verificationContract, handler) => {
      const input = normalizeHumanVerificationInput(rawInput, verificationContract);
      assert.ok(handler, "Post requires semantic input ownership, never coordinate fallback");
      return withPage(session, page => handler(page, input, verificationContract.targets[0]!));
    },
  });
  const verification = contract("post.login.captcha-input", { stageId: "ipost-login-captcha" });
  await host.injectAnswer("post-session", verification, "1234");
  assert.deepEqual(fills, ["1234"]);
});

test("Post input ownership rejects missing, ambiguous and non-retaining CAPTCHA fields", async () => {
  for (const options of [{ count: 0 }, { count: 2 }, { inputValue: () => "" }]) {
    const withPage = pageRunner(fakePage({ 'input[name="captcha"]:visible': fakeLocator(options) }));
    const host = createProviderVerificationHost({
      withPage,
      sendInput: async (session, rawInput, verificationContract, handler) => {
        assert.ok(handler);
        return withPage(session, page => handler(page, normalizeHumanVerificationInput(rawInput, verificationContract), verificationContract.targets[0]!));
      },
    });
    await assert.rejects(host.injectAnswer("post-session", contract("post.login.captcha-input", { stageId: "ipost-login-captcha" }), "1234"), /Post CAPTCHA/u);
  }
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

test("no provider declares an in-page CAPTCHA refresh control yet", async () => {
  const providerContracts = {
    fubon: fubonCaptchaContract(),
    sinopac: sinopacCaptchaContract(),
    "yuanta-bank": yuantaBankCaptchaContract(),
    post: contract("post.login.captcha-input", { stageId: "ipost-login-captcha" }),
  };
  const host = createProviderVerificationHost({ pageForRun: () => null });
  for (const [provider, verification] of Object.entries(providerContracts)) {
    assert.equal(
      host.refreshesChallengeImage(verification),
      false,
      `${provider} declares a CAPTCHA refresh control. ADR 0046 requires fixture or live evidence `
        + "that the control yields a new challenge without resetting the sign-in details, and the "
        + "workflow's post-assistance CAPTCHA identity guard must accept the refreshed image first: "
        + "snapshotChangeReason in src/workflows/fubon-auth.ts and postCaptchaGenerationUnchanged "
        + "in src/workflows/post-statements.ts reject a changed CAPTCHA.",
    );
    assert.equal(await host.refreshChallengeImage(`${provider}-session`, verification), false);
  }
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
