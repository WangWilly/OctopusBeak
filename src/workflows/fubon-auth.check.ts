import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Frame, Locator, Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import {
  FubonDuplicateLoginTerminalError,
  FubonLoginRefusedError,
  FubonLoginRejectedError,
  fillFubonLoginCredentials,
  fubonLogin,
  fubonCaptchaAssistanceStage,
  hasFubonDuplicateLoginTerminal,
  inspectFubonOtpFromCurrentFrame,
  prepareFubonLoginDocument,
  readFubonLoginGeneration,
  runFubonCaptchaAcquisition,
  submitFubonCaptchaFromCurrentFrame,
  waitForFubonLoginDocument,
  waitForFubonPostLoginOutcome,
  type FubonLoginDialogChannel,
  type FubonLoginSnapshot,
} from "./fubon-auth.ts";

test("recognizes only the exact Fubon duplicate-login terminal URL", () => {
  const pageWith = (url: string) =>
    ({ frames: () => [{ url: () => url }] }) as unknown as Page;
  assert.equal(
    hasFubonDuplicateLoginTerminal(
      pageWith(
        "https://ebank.taipeifubon.com.tw/B2C/common/error/NotAuth.jsp?type=dupLogin",
      ),
    ),
    true,
  );
  for (const url of [
    "https://ebank.taipeifubon.com.tw/B2C/common/error/NotAuth.jsp?type=timeout",
    "https://ebank.taipeifubon.com.tw/B2C/common/error/NotAuth.jsp?type=dupLoginExtra",
    "https://example.test/NotAuth.jsp?type=dupLogin#not-fubon-evidence",
  ]) {
    assert.equal(hasFubonDuplicateLoginTerminal(pageWith(url)), false);
  }
});

test("login-document wait fails immediately on duplicate-login terminal", async () => {
  let waits = 0;
  const page = {
    frames: () => [
      {
        url: () =>
          "https://ebank.taipeifubon.com.tw/B2C/common/error/NotAuth.jsp?type=dupLogin",
      },
    ],
    waitForTimeout: async () => {
      waits += 1;
    },
  } as unknown as Page;
  await assert.rejects(
    waitForFubonLoginDocument(page, { timeoutMs: 10 }),
    FubonDuplicateLoginTerminalError,
  );
  assert.equal(waits, 0);
});

test("duplicate-login terminal remains fail-closed without automatic recovery", async () => {
  const source = await readFile(
    new URL("./fubon-auth.ts", import.meta.url),
    "utf8",
  );
  const completeLogin = source.slice(
    source.indexOf("export function fubonLogin("),
  );
  assert.doesNotMatch(
    completeLogin,
    /runFubonDuplicateLoginRecovery|reopenLoginForm/,
  );
  assert.match(completeLogin, /runFubonCaptchaAcquisition/);
  assert.match(completeLogin, /await complete\(/);
});

type FakeInput = {
  value: string;
  isConnected: boolean;
  offsetParent: object | null;
  identity: string;
  dispatchCount: number;
  dispatchEvent: () => boolean;
  offsetWidth: number;
  offsetHeight: number;
  getClientRects: () => readonly object[];
};

type FakeDom = {
  generation: string;
  documentUrl: string;
  captcha: FakeInput | undefined;
  captchaImageTimestamp: number | undefined;
  fields: FakeInput[];
  otp: FakeInput | undefined;
  clickInvocations: number;
  successfulClicks: number;
  throwOnClick: boolean;
  evaluationDetaches: boolean;
  throwAfterClickEvaluation?: boolean;
  onFirstFill?: () => void;
  didFill?: boolean;
};

type FakeFrame = Frame & { id: string; dom: FakeDom };
type FakePage = Page & {
  currentFrame: FakeFrame | undefined;
  dom: FakeDom;
  mutationCount: () => number;
};

function input(value = "", identity = "input"): FakeInput {
  const field = {
    value,
    isConnected: true,
    offsetParent: {},
    identity,
    dispatchCount: 0,
    offsetWidth: 20,
    offsetHeight: 20,
    getClientRects: () => [{}],
    dispatchEvent() {
      field.dispatchCount += 1;
      return true;
    },
  };
  return field;
}

function fakeDom(overrides: Partial<FakeDom> = {}): FakeDom {
  return {
    generation: "generation-1",
    documentUrl: "https://ebank.taipeifubon.com.tw/B2C/common/PreLogin.faces",
    captcha: input("captcha-answer", "captcha-1"),
    captchaImageTimestamp: 1787220778495,
    fields: [
      input("id", "id-1"),
      input("account", "account-1"),
      input("password", "password-1"),
    ],
    otp: undefined,
    clickInvocations: 0,
    successfulClicks: 0,
    throwOnClick: false,
    evaluationDetaches: false,
    ...overrides,
  };
}

function fakeFrame(id: string, dom: FakeDom): FakeFrame {
  const documentObject = {
    querySelector(selector: string) {
      if (selector === "#m1_userCaptcha") return dom.captcha ?? null;
      if (selector === "#m1_inputOTP") return dom.otp ?? null;
      if (selector === "#btnLogin2") {
        return {
          isConnected: true,
          click() {
            dom.clickInvocations += 1;
            if (dom.throwOnClick) throw new Error("submit transport failure");
            dom.successfulClicks += 1;
          },
        };
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === 'input[type="password"]') return dom.fields;
      if (selector === "img[src]") {
        return dom.captchaImageTimestamp === undefined
          ? []
          : [
              {
                getAttribute(name: string) {
                  return name === "src"
                    ? `/B2C/captchaImage?timestamp=${dom.captchaImageTimestamp}`
                    : null;
                },
              },
            ];
      }
      return [];
    },
  };

  const evaluate = async (
    callback: (root: unknown, values: unknown) => unknown,
    values: unknown,
  ) => {
    if (dom.evaluationDetaches) throw new Error("Frame was detached");
    const prior = {
      document: globalThis.document,
      htmlInput: globalThis.HTMLInputElement,
      event: globalThis.Event,
      style: globalThis.getComputedStyle,
      location: globalThis.location,
    };
    Object.assign(globalThis, {
      document: Object.assign(documentObject, {
        __librettoFubonLoginGeneration: dom.generation,
      }),
      HTMLInputElement: class {
        get value() {
          return (this as unknown as FakeInput).value;
        }
        set value(value: string) {
          (this as unknown as FakeInput).value = value;
        }
      },
      Event: class {},
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
      }),
      location: new URL(dom.documentUrl),
    });
    try {
      const result = callback({}, values);
      if (dom.throwAfterClickEvaluation && dom.clickInvocations > 0) {
        throw new Error("Frame was detached after submit click");
      }
      return result;
    } finally {
      Object.assign(globalThis, prior);
    }
  };

  const frame = {
    id,
    dom,
    locator(selector: string) {
      if (selector === "html") return { evaluate };
      if (selector === "#m1_userCaptcha" || selector === "#m1_inputOTP") {
        return {
          async focus() {},
          async isVisible() {
            return true;
          },
        };
      }
      assert.equal(selector, 'input[type="password"]:visible');
      return {
        async count() {
          return dom.fields.length;
        },
        nth(index: number): Locator {
          return {
            async waitFor() {},
            async fill(value: string) {
              const field = dom.fields[index];
              if (!field) throw new Error("field missing");
              if (!dom.didFill && dom.onFirstFill) {
                dom.didFill = true;
                dom.onFirstFill();
                throw new Error("Frame was detached");
              }
              field.value = value;
            },
            async inputValue() {
              const field = dom.fields[index];
              if (!field) throw new Error("field missing");
              return field.value;
            },
          } as unknown as Locator;
        },
      } as unknown as Locator;
    },
  } as unknown as FakeFrame;
  return frame;
}

function fakePage(dom = fakeDom()): FakePage {
  let frame = fakeFrame("frame-1", dom);
  const page = {
    dom,
    get currentFrame() {
      return frame;
    },
    frame: () => frame,
    waitForTimeout: async (timeoutMs: number) => {
      if (timeoutMs > 0)
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    },
    mutationCount: () =>
      dom.fields.reduce((count, field) => count + field.dispatchCount, 0),
    replace(nextDom: FakeDom) {
      frame = fakeFrame("frame-" + nextDom.generation, nextDom);
    },
  } as unknown as FakePage & { replace: (nextDom: FakeDom) => void };
  return page;
}

function setCredentialFields(dom: FakeDom, values: readonly string[]): void {
  dom.fields.forEach((field, index) => {
    field.value = values[index] ?? "";
  });
}

function snapshot(
  overrides: Partial<FubonLoginSnapshot> = {},
): FubonLoginSnapshot {
  return {
    loggedIn: undefined,
    result: undefined,
    errorCode: undefined,
    logoutAttached: false,
    logoutVisible: false,
    authenticatedMarker: false,
    loginAnchorVisible: false,
    loginFormVisible: false,
    ...overrides,
  };
}

function channelWithMessages(messages: string[]): FubonLoginDialogChannel {
  return { messages, beginOutcomeWindow() {} };
}

async function withTelemetry<T>(run: () => Promise<T>): Promise<{
  result?: T;
  error?: unknown;
  events: Array<{ status?: string; reason?: string }>;
}> {
  const originalLog = console.log;
  const events: Array<{ status?: string; reason?: string }> = [];
  console.log = ((_label: unknown, payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const record = payload as { status?: unknown; reason?: unknown };
    events.push({
      status: typeof record.status === "string" ? record.status : undefined,
      reason: typeof record.reason === "string" ? record.reason : undefined,
    });
  }) as typeof console.log;
  try {
    return { result: await run(), events };
  } catch (error) {
    return { error, events };
  } finally {
    console.log = originalLog;
  }
}

test("waits through 0/6 transient fields and returns a stable three-field snapshot", async () => {
  const observations = [
    { frame: "old", marker: false, count: 0, ids: [] },
    { frame: "old", marker: true, count: 0, ids: [] },
    {
      frame: "old",
      marker: true,
      count: 6,
      ids: ["m1", "m2", "m3", "x1", "x2", "x3"],
    },
    { frame: "stable", marker: true, count: 3, ids: ["m1", "m2", "m3"] },
    { frame: "stable", marker: true, count: 3, ids: ["m1", "m2", "m3"] },
  ];
  let index = 0;
  const frames = new Map<string, Frame>();
  const page = {
    frame: () => {
      const current = observations[Math.min(index, observations.length - 1)];
      const existing = frames.get(current.frame);
      if (existing) return existing;
      const created = {
        locator: () => ({
          evaluate: async () => ({
            markerReady: current.marker,
            generation: current.frame,
            visibleCredentialCount: current.count,
            visibleCredentialIdentities: current.ids,
          }),
        }),
      } as unknown as Frame;
      frames.set(current.frame, created);
      return created;
    },
    waitForTimeout: async () => {
      index += 1;
    },
  } as unknown as Page;
  const result = await waitForFubonLoginDocument(page, {
    timeoutMs: 50,
    pollIntervalMs: 1,
    confirmationMs: 1,
  });
  assert.equal(result.visibleCredentialCount, 3);
  assert.equal(result.documentIdentity, "stable");
  assert.ok(result.frameIdentity);
});

test("fails closed for a stable ambiguous field set", async () => {
  const dom = fakeDom({ fields: [input(), input(), input(), input()] });
  await assert.rejects(
    waitForFubonLoginDocument(fakePage(dom), {
      timeoutMs: 20,
      pollIntervalMs: 1,
      confirmationMs: 1,
    }),
    /ambiguous.*exactly three/i,
  );
});

test("initial fill remains bounded after one observed detached frame", async () => {
  const dom = fakeDom();
  const page = fakePage(dom);
  let detached = false;
  dom.onFirstFill = () => {
    detached = true;
    (page as unknown as { replace: (nextDom: FakeDom) => void }).replace(
      fakeDom({ generation: "generation-2" }),
    );
  };
  await fillFubonLoginCredentials(
    page,
    {
      userId: "id",
      account: "account",
      password: "password",
    },
    { timeoutMs: 1_000, retryIntervalMs: 1 },
  );
  assert.equal(detached, true);
});

test("unchanged generation with credentials present submits without mutations", async () => {
  const page = fakePage();
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  const result = await submitFubonCaptchaFromCurrentFrame(
    page,
    {
      userId: "id",
      account: "account",
      password: "password",
    },
    { before, timeoutMs: 40 },
  );
  assert.equal(result.status, "submitted");
  assert.equal(page.mutationCount(), 0);
  assert.equal(page.dom.clickInvocations, 1);
});

test("unchanged generation with empty credentials refills exactly three fields", async () => {
  const dom = fakeDom();
  setCredentialFields(dom, ["", "", ""]);
  const page = fakePage(dom);
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  const result = await submitFubonCaptchaFromCurrentFrame(
    page,
    {
      userId: "id",
      account: "account",
      password: "password",
    },
    { before, timeoutMs: 40 },
  );
  assert.equal(result.status, "submitted");
  assert.equal(page.dom.clickInvocations, 1);
  assert.deepEqual(
    dom.fields.map((field) => field.value),
    ["id", "account", "password"],
  );
});

test("changed document requires new assistance and does not click", async () => {
  const page = fakePage();
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  const next = fakeDom({
    generation: "generation-2",
    captchaImageTimestamp: 1787220779495,
  });
  (page as unknown as { replace: (nextDom: FakeDom) => void }).replace(next);
  const result = await submitFubonCaptchaFromCurrentFrame(
    page,
    {
      userId: "id",
      account: "account",
      password: "password",
    },
    { before, timeoutMs: 40 },
  );
  assert.equal(result.status, "reacquire-human-assistance");
  assert.equal(result.reason, "current-frame-changed");
  assert.equal(next.clickInvocations, 0);
});

test("changed input identity, CAPTCHA identity, or document URL requires assistance", async () => {
  for (const mutate of [
    (dom: FakeDom) => {
      dom.fields = [input("id"), input("account"), input("password")];
    },
    (dom: FakeDom) => {
      dom.captcha = input("captcha-answer", "captcha-new");
    },
    (dom: FakeDom) => {
      dom.documentUrl =
        "https://ebank.taipeifubon.com.tw/B2C/common/Other.faces";
    },
  ]) {
    const dom = fakeDom();
    const page = fakePage(dom);
    const before = await readFubonLoginGeneration(page);
    assert.ok(before);
    mutate(dom);
    const result = await submitFubonCaptchaFromCurrentFrame(
      page,
      { userId: "id", account: "account", password: "password" },
      { before, timeoutMs: 40 },
    );
    assert.equal(result.status, "reacquire-human-assistance");
    assert.notEqual(result.reason, undefined);
    assert.equal(dom.clickInvocations, 0);
  }
});

test("explicit 0240 before submit never reuses the CAPTCHA", async () => {
  const dom = fakeDom();
  const page = fakePage(dom);
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  const result = await submitFubonCaptchaFromCurrentFrame(
    page,
    { userId: "id", account: "account", password: "password" },
    { before, preSubmitErrorCode: "0240", timeoutMs: 40 },
  );
  assert.deepEqual(result, {
    status: "reacquire-human-assistance",
    reason: "idle-expired",
  });
  assert.equal(dom.clickInvocations, 0);
});

test("missing or empty CAPTCHA never mutates credentials", async () => {
  for (const captcha of [undefined, input("")]) {
    const dom = fakeDom({ captcha });
    const page = fakePage(dom);
    const before = await readFubonLoginGeneration(page);
    assert.ok(before);
    const result = await submitFubonCaptchaFromCurrentFrame(
      page,
      {
        userId: "id",
        account: "account",
        password: "password",
      },
      { before, timeoutMs: 40 },
    );
    assert.equal(result.status, "reacquire-human-assistance");
    assert.equal(page.mutationCount(), 0);
    assert.equal(dom.clickInvocations, 0);
  }
});

test("submit invocation is an uncertainty fence", async () => {
  const dom = fakeDom({ throwOnClick: true });
  const page = fakePage(dom);
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  const result = await submitFubonCaptchaFromCurrentFrame(
    page,
    {
      userId: "id",
      account: "account",
      password: "password",
    },
    { before, timeoutMs: 40 },
  );
  assert.equal(result.status, "submit-outcome-uncertain");
  assert.equal(dom.clickInvocations, 1);
});

test("evaluate rejection after click remains uncertain and is never retried", async () => {
  const dom = fakeDom({ throwAfterClickEvaluation: true });
  const page = fakePage(dom);
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  let assists = 0;
  const bounded = await runFubonCaptchaAcquisition({
    prepare: async () => before,
    assistAndPause: async () => {
      assists += 1;
    },
    submit: async () =>
      submitFubonCaptchaFromCurrentFrame(
        page,
        { userId: "id", account: "account", password: "password" },
        { before, timeoutMs: 40 },
      ),
  });
  assert.equal(bounded.status, "submit-outcome-uncertain");
  assert.equal(assists, 1);
  assert.equal(dom.clickInvocations, 1);
});

test("synchronous pre-click detach reacquires without clicking", async () => {
  const dom = fakeDom({ evaluationDetaches: true });
  const page = fakePage(dom);
  const before = {
    frameName: "txnFrame",
    frameIdentity: "known",
    documentIdentity: "known",
    documentUrl: dom.documentUrl,
    visibleCredentialCount: 3,
    visibleCredentialIdentities: ["a", "b", "c"],
    captchaIdentity: "captcha-known",
    captchaImageTimestamp: dom.captchaImageTimestamp,
    markerReady: true,
  };
  const result = await submitFubonCaptchaFromCurrentFrame(
    page,
    { userId: "id", account: "account", password: "password" },
    { before, timeoutMs: 40 },
  );
  assert.equal(result.status, "reacquire-human-assistance");
  assert.equal(result.reason, "frame-detached");
  assert.equal(dom.clickInvocations, 0);
});

test("acquisition stops after one uncertain submit", async () => {
  let assists = 0;
  let submits = 0;
  const result = await runFubonCaptchaAcquisition({
    prepare: async () => undefined,
    assistAndPause: async () => {
      assists += 1;
    },
    submit: async () => {
      submits += 1;
      return { status: "submit-outcome-uncertain", reason: "submit-threw" };
    },
  });
  assert.equal(result.status, "submit-outcome-uncertain");
  assert.equal(assists, 1);
  assert.equal(submits, 1);
});

test("OTP inspection reacquires when the observed generation changes", async () => {
  const page = fakePage();
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  const next = fakeDom({
    generation: "otp-generation-2",
    otp: input("123456", "otp-2"),
  });
  (page as unknown as { replace: (nextDom: FakeDom) => void }).replace(next);
  const result = await inspectFubonOtpFromCurrentFrame(page, {
    before,
    timeoutMs: 40,
  });
  assert.equal(result.status, "reacquire-human-assistance");
  assert.equal(result.reason, "current-frame-changed");
});

for (const fileName of [
  "fubon-statements.ts",
  "fubon-credit-card-statements.ts",
  "fubon-loan-statements.ts",
]) {
  test(`${fileName} contains no independent login behavior`, async () => {
    const source = await readFile(
      new URL(`./${fileName}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /fubonLogin|openFubonLoginForm/);
    assert.doesNotMatch(source, /stageId: "fubon-login-captcha"/);
    assert.doesNotMatch(source, /#btnLogin2/);
    assert.doesNotMatch(source, /visiblePasswordFields/);
  });
}

test("the App provider owns shared Fubon login and assistance", async () => {
  const source = await readFile(
    new URL("./fubon-all-statements.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /fubonLogin\(/);
  assert.match(source, /context\.verification\.complete/);
});

test("Fubon declares three distinct agreement-only OCR strategies", () => {
  const locator = {
    boundingBox: async () => ({ x: 0, y: 0, width: 1, height: 1 }),
    first() {
      return this;
    },
  };
  const frame = {
    locator: () => locator,
  } as unknown as Frame;

  const stage = fubonCaptchaAssistanceStage(frame);

  assert.equal(stage.challengeKind, "text-captcha");
  assert.equal(stage.charset, "digits");
  assert.equal(stage.expectedAnswerLength, 6);
  assert.equal(stage.ocrPageSegmentationMode, "single-word");
  assert.deepEqual(stage.ocrAttemptPlan, [
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-word" },
    {
      imagePreprocessing: ["fubon-luminance-foreground"],
      ocrPageSegmentationMode: "single-word",
    },
    {
      imagePreprocessing: ["fubon-min-channel-foreground"],
      ocrPageSegmentationMode: "single-word",
    },
  ]);
  assert.deepEqual(stage.solveAcceptancePolicy, { mode: "agreement-only" });
  assert.equal(
    stage.challengeImageRegion?.semanticId,
    "fubon.login.captcha-image",
  );
});

test("login source contains no credential or CAPTCHA values", async () => {
  const source = await readFile(
    new URL("./fubon-auth.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /never-log-this-secret|account-secret|password-secret/,
  );
  assert.doesNotMatch(source, /console\.(log|error)\([^)]*captchaValue/);
});

test("the dialog observer accepts an alert and rejects every other dialog without its text", async () => {
  const login = fubonLogin({ userId: "id", account: "account", password: "password" }, async () => undefined);
  const observed = await withTelemetry(async () => {
    assert.equal(login.observe({ type: "alert", message: "頁面閒置過久 private-secret" }), "accept");
    for (const type of ["confirm", "prompt", "beforeunload", "unknown"]) {
      const decision = login.observe({ type, message: "請確認是否刪除這筆資料 private-secret" });
      assert.ok(decision instanceof FubonLoginRejectedError, type);
      assert.equal(decision.reason, "unknown-confirm");
      assert.doesNotMatch(String(decision), /private-secret/u);
    }
  });
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.events, Array(4).fill({ status: "rejected", reason: "unknown-confirm" }));
});

test("accepts an authenticated marker", async () => {
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(
      { frame: () => undefined } as unknown as Page,
      {
        timeoutMs: 20,
        pollIntervalMs: 1,
        probe: async () =>
          snapshot({ loggedIn: true, authenticatedMarker: true }),
      },
    ),
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events, [{ status: "success", reason: "marker" }]);
});

test("rejects a sanitized 0240 alert", async () => {
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(
      { frame: () => undefined } as unknown as Page,
      {
        timeoutMs: 20,
        pollIntervalMs: 1,
        dialogChannel: channelWithMessages([
          "登入失敗 errorCode0240 private-secret",
        ]),
        probe: async () => snapshot({ result: false, errorCode: "0240" }),
      },
    ),
  );
  assert.match(String(result.error), /Fubon login rejected \(error 0240\)/);
  assert.doesNotMatch(String(result.error), /private-secret/);
});

test("waits for a post-submit bank dialog before treating the still-visible login form as rejection", async () => {
  const messages: string[] = [];
  let probes = 0;
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(
      { frame: () => undefined } as unknown as Page,
      {
        timeoutMs: 50,
        pollIntervalMs: 1,
        dialogChannel: channelWithMessages(messages),
        probe: async () => {
          probes += 1;
          if (probes === 2) messages.push("dialog-alert");
          return snapshot({ loggedIn: false, loginFormVisible: true });
        },
      },
    ),
  );
  assert.equal(probes, 2);
  assert.deepEqual(result.events, [{ status: "rejected", reason: "dialog-alert" }]);
});

test("still rejects an unchanged login form when no bank outcome appears", async () => {
  let probes = 0;
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(
      { frame: () => undefined } as unknown as Page,
      {
        timeoutMs: 8,
        pollIntervalMs: 1,
        probe: async () => {
          probes += 1;
          return snapshot({ loggedIn: false, loginFormVisible: true });
        },
      },
    ),
  );
  assert.ok(probes > 1);
  assert.deepEqual(result.events, [{ status: "rejected", reason: "login-form-visible" }]);
});

test("an in-page 0290 CAPTCHA response is a provider CAPTCHA rejection", async () => {
  let bannerVisible = false;
  let probes = 0;
  const page = {
    frame: ({ name }: { name: string }) => name === "txnFrame"
      ? {
        getByText: (pattern: RegExp) => {
          const rejection = {
            first: () => rejection,
            isVisible: async () => bannerVisible && pattern.test("0290 驗證碼輸入錯誤"),
          };
          return rejection;
        },
      }
      : undefined,
  } as unknown as Page;
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(page, {
      timeoutMs: 50,
      pollIntervalMs: 1,
      probe: async () => {
        probes += 1;
        if (probes === 2) bannerVisible = true;
        return snapshot({ loggedIn: false, loginFormVisible: true });
      },
    }),
  );
  assert.ok(result.error instanceof CaptchaProviderRejectedError);
  assert.deepEqual(result.events, [{ status: "rejected", reason: "captcha-rejected" }]);
});

test("a server refusal of filled credentials is a retryable login refusal", async () => {
  const page = {
    frame: () => ({
      getByText: (pattern: RegExp) => {
        const message = {
          first: () => message,
          isVisible: async () => pattern.test("請輸入身分證字號\n請輸入使用者代碼\n請輸入使用者密碼"),
        };
        return message;
      },
    }),
  } as unknown as Page;
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(page, {
      timeoutMs: 50,
      pollIntervalMs: 1,
      probe: async () => snapshot({ loggedIn: false, loginFormVisible: true }),
    }),
  );
  assert.ok(result.error instanceof FubonLoginRefusedError);
  assert.ok(result.error instanceof CaptchaProviderRejectedError);
  assert.deepEqual(result.events, [{ status: "rejected", reason: "login-refused" }]);
});

test("a single missing-field message is not a server login refusal", async () => {
  const page = {
    frame: () => ({
      getByText: (pattern: RegExp) => {
        const message = {
          first: () => message,
          isVisible: async () => pattern.test("請輸入使用者密碼"),
        };
        return message;
      },
    }),
  } as unknown as Page;
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(page, {
      timeoutMs: 8,
      pollIntervalMs: 1,
      probe: async () => snapshot({ loggedIn: false, loginFormVisible: true }),
    }),
  );
  assert.equal(result.error instanceof CaptchaProviderRejectedError, false);
  assert.deepEqual(result.events, [{ status: "rejected", reason: "login-form-visible" }]);
});

test("a 0290 credential response is not a CAPTCHA rejection", async () => {
  const page = {
    frame: () => ({
      getByText: (pattern: RegExp) => {
        const rejection = {
          first: () => rejection,
          isVisible: async () => pattern.test("0290 帳號或密碼錯誤"),
        };
        return rejection;
      },
    }),
  } as unknown as Page;
  const result = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(page, {
      timeoutMs: 8,
      pollIntervalMs: 1,
      probe: async () => snapshot({ loggedIn: false, loginFormVisible: true }),
    }),
  );
  assert.equal(result.error instanceof CaptchaProviderRejectedError, false);
  assert.deepEqual(result.events, [{ status: "rejected", reason: "login-form-visible" }]);
});

test("post-click 0240 is terminal after the single submit", async () => {
  const dom = fakeDom();
  const page = fakePage(dom);
  const before = await readFubonLoginGeneration(page);
  assert.ok(before);
  const submit = await submitFubonCaptchaFromCurrentFrame(
    page,
    { userId: "id", account: "account", password: "password" },
    { before, timeoutMs: 40 },
  );
  assert.equal(submit.status, "submitted");
  assert.equal(dom.clickInvocations, 1);

  const outcome = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(page, {
      timeoutMs: 20,
      pollIntervalMs: 1,
      probe: async () => snapshot({ result: false, errorCode: "0240" }),
    }),
  );
  assert.match(String(outcome.error), /Fubon login rejected \(error 0240\)/);
  assert.equal(dom.clickInvocations, 1);
});

test("prepared login exposes only an opaque, non-sensitive snapshot", async () => {
  const frame = {
    locator: () => ({
      evaluate: async () => ({
        markerReady: true,
        generation: "prepared-generation",
        visibleCredentialCount: 3,
        visibleCredentialIdentities: ["a", "b", "c"],
      }),
    }),
  } as unknown as Frame;
  const page = {
    frame: () => frame,
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  const prepared = await prepareFubonLoginDocument(page, {
    timeoutMs: 20,
    confirmationMs: 0,
  });
  assert.ok(prepared.snapshot.documentIdentity);
  assert.ok(prepared.snapshot.frameIdentity);
  assert.equal("captcha-answer" in prepared.snapshot, false);
  assert.equal("password" in prepared.snapshot, false);
});
