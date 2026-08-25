import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Frame, Locator, Page } from "playwright";
import {
  captureFubonLoginDialogs,
  FubonDuplicateLoginTerminalError,
  fillFubonLoginCredentials,
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
    source.indexOf("export async function completeFubonHumanLogin"),
  );
  assert.doesNotMatch(
    completeLogin,
    /runFubonDuplicateLoginRecovery|reopenLoginForm/,
  );
  assert.match(completeLogin, /completeFubonHumanLoginAttempt/);
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
  return {
    messages,
    duplicateTakeoverAccepted: false,
    terminalReason: undefined,
    beginOutcomeWindow() {},
    dispose() {},
  };
}

async function classifyConfirmMessage(message: string): Promise<{
  accepted: number;
  dismissed: number;
  duplicateTakeoverAccepted: boolean;
  terminalReason: FubonLoginDialogChannel["terminalReason"];
}> {
  let handler: ((dialog: unknown) => Promise<void>) | undefined;
  let accepted = 0;
  let dismissed = 0;
  const page = {
    on: (_event: string, callback: (dialog: unknown) => Promise<void>) => {
      handler = callback;
    },
    off: () => undefined,
  } as unknown as Page;
  const channel = captureFubonLoginDialogs(page);
  assert.ok(handler);
  await handler({
    type: () => "confirm",
    message: () => message,
    accept: async () => {
      accepted += 1;
    },
    dismiss: async () => {
      dismissed += 1;
    },
  });
  const result = {
    accepted,
    dismissed,
    duplicateTakeoverAccepted: channel.duplicateTakeoverAccepted,
    terminalReason: channel.terminalReason,
  };
  channel.dispose();
  return result;
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
  test(`${fileName} delegates all login behavior to the shared seam`, async () => {
    const source = await readFile(
      new URL(`./${fileName}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /await completeFubonHumanLogin\(/);
    assert.doesNotMatch(source, /stageId: "fubon-login-captcha"/);
    assert.doesNotMatch(source, /#btnLogin2/);
    assert.doesNotMatch(source, /visiblePasswordFields/);
  });
}

test("Fubon declares a solver-capable text CAPTCHA challenge", async () => {
  const source = await readFile(
    new URL("./fubon-auth.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /challengeKind: "text-captcha"/);
  assert.match(source, /challengeImageRegion/);
  assert.match(source, /fubon\.login\.captcha-image/);
  assert.match(source, /img\[src\*="captchaImage"\]:visible/);
  assert.doesNotMatch(source, /challengeKind: "image-selection"/);
});

// The strip-types repository runner cannot resolve Libretto's nested TSX
// loader. Run this gate with the actual TSX loader command instead.
if (!process.execArgv.includes("--experimental-strip-types")) {
  test("the real Libretto loader resolves every Fubon workflow", async () => {
    const runtime = await import(
      pathToFileURL(
        process.cwd() +
          "/node_modules/libretto/dist/cli/core/workflow-runtime.js",
      ).href
    );
    for (const fileName of [
      "fubon-all-statements.ts",
      "fubon-statements.ts",
      "fubon-credit-card-statements.ts",
      "fubon-loan-statements.ts",
    ]) {
      const workflow = await runtime.loadDefaultWorkflow(
        process.cwd() + "/src/workflows/" + fileName,
      );
      assert.match(workflow.name, /^fubon/);
    }
  });
}

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

test("captures and disposes racing dialogs", async () => {
  let handler: ((dialog: unknown) => Promise<void>) | undefined;
  let accepted = false;
  const page = {
    on: (_event: string, callback: (dialog: unknown) => Promise<void>) => {
      handler = callback;
    },
    off: () => {
      handler = undefined;
    },
  } as unknown as Page;
  const channel = captureFubonLoginDialogs(page);
  assert.ok(handler);
  await handler({
    type: () => "alert",
    message: () => "頁面閒置過久 private-secret",
    accept: async () => {
      accepted = true;
    },
  });
  assert.equal(accepted, true);
  assert.deepEqual(channel.messages, ["errorCode0240"]);
  assert.equal(channel.duplicateTakeoverAccepted, false);
  assert.equal(channel.terminalReason, undefined);
  assert.doesNotMatch(JSON.stringify(channel), /private-secret/);
  channel.dispose();
});

test("accepts the evidence-backed duplicate-login confirm once", async () => {
  let handler: ((dialog: unknown) => Promise<void>) | undefined;
  let accepted = 0;
  let dismissed = 0;
  const page = {
    on: (_event: string, callback: (dialog: unknown) => Promise<void>) => {
      handler = callback;
    },
    off: () => undefined,
  } as unknown as Page;
  const channel = captureFubonLoginDialogs(page);
  assert.ok(handler);
  await handler({
    type: () => "confirm",
    message: () => "錯誤代碼0212：已有其他裝置登入，是否繼續？",
    accept: async () => {
      accepted += 1;
    },
    dismiss: async () => {
      dismissed += 1;
    },
  });
  assert.equal(accepted, 1);
  assert.equal(dismissed, 0);
  assert.equal(channel.duplicateTakeoverAccepted, true);
  assert.equal(channel.terminalReason, undefined);
  assert.deepEqual(channel.messages, []);
  channel.dispose();
});

test("accepts only exact 0212 codes or current duplicate-login actions", async () => {
  for (const message of [
    "0212",
    "00212",
    "錯誤代碼:0212",
    "errorCode=00212",
    "偵測到重複登入，是否繼續登入？",
    "偵測到重覆登入，確定仍要登入？",
    "您已在其他裝置登入，是否要繼續？",
    "You are already logged in on another device. Continue?",
  ]) {
    const result = await classifyConfirmMessage(message);
    assert.deepEqual(
      result,
      {
        accepted: 1,
        dismissed: 0,
        duplicateTakeoverAccepted: true,
        terminalReason: undefined,
      },
      message,
    );
  }

  for (const message of [
    "02120",
    "1212",
    "0213",
    "錯誤代碼:02120",
    "錯誤代碼:1212",
    "errorCode0212something",
    "重複登入",
    "曾經重複登入，是否繼續登入？",
    "其他裝置曾登入，是否繼續？",
    "帳號已登出，其他裝置登入，是否繼續？",
    "previously logged in on another device, continue?",
    "為安全起見，是否繼續？",
    "other device login",
  ]) {
    const result = await classifyConfirmMessage(message);
    assert.deepEqual(
      result,
      {
        accepted: 0,
        dismissed: 1,
        duplicateTakeoverAccepted: false,
        terminalReason: "unknown-confirm",
      },
      message,
    );
  }
});

test("dismisses an unknown confirm without accepting takeover", async () => {
  let handler: ((dialog: unknown) => Promise<void>) | undefined;
  let accepted = 0;
  let dismissed = 0;
  const page = {
    on: (_event: string, callback: (dialog: unknown) => Promise<void>) => {
      handler = callback;
    },
    off: () => undefined,
  } as unknown as Page;
  const channel = captureFubonLoginDialogs(page);
  assert.ok(handler);
  await handler({
    type: () => "confirm",
    message: () => "請確認是否刪除這筆資料 private-secret",
    accept: async () => {
      accepted += 1;
    },
    dismiss: async () => {
      dismissed += 1;
    },
  });
  assert.equal(accepted, 0);
  assert.equal(dismissed, 1);
  assert.equal(channel.duplicateTakeoverAccepted, false);
  assert.equal(channel.terminalReason, "unknown-confirm");
  assert.deepEqual(channel.messages, []);
  assert.doesNotMatch(JSON.stringify(channel), /private-secret/);
  channel.dispose();
});

test("repeated duplicate-login confirm is dismissed after one acceptance", async () => {
  let handler: ((dialog: unknown) => Promise<void>) | undefined;
  let accepted = 0;
  let dismissed = 0;
  const page = {
    on: (_event: string, callback: (dialog: unknown) => Promise<void>) => {
      handler = callback;
    },
    off: () => undefined,
  } as unknown as Page;
  const channel = captureFubonLoginDialogs(page);
  assert.ok(handler);
  const duplicate = {
    type: () => "confirm",
    message: () => "0212 其他裝置登入",
    accept: async () => {
      accepted += 1;
    },
    dismiss: async () => {
      dismissed += 1;
    },
  };
  await handler(duplicate);
  await handler(duplicate);
  assert.equal(accepted, 1);
  assert.equal(dismissed, 1);
  assert.equal(channel.duplicateTakeoverAccepted, true);
  assert.equal(channel.terminalReason, "duplicate-takeover-repeated");
  channel.dispose();
});

test("accepted duplicate takeover continues to authenticated outcome", async () => {
  let handler: ((dialog: unknown) => Promise<void>) | undefined;
  const page = {
    on: (_event: string, callback: (dialog: unknown) => Promise<void>) => {
      handler = callback;
    },
    off: () => undefined,
  } as unknown as Page;
  const channel = captureFubonLoginDialogs(page);
  assert.ok(handler);
  await handler({
    type: () => "confirm",
    message: () => "0212：其他裝置登入",
    accept: async () => undefined,
    dismiss: async () => undefined,
  });
  const outcome = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(page, {
      timeoutMs: 20,
      pollIntervalMs: 1,
      dialogChannel: channel,
      probe: async () =>
        snapshot({ loggedIn: true, authenticatedMarker: true }),
    }),
  );
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.events, [{ status: "success", reason: "marker" }]);
  channel.dispose();
});

test("accepted duplicate takeover followed by NotAuth remains a failure", async () => {
  let handler: ((dialog: unknown) => Promise<void>) | undefined;
  const page = {
    on: (_event: string, callback: (dialog: unknown) => Promise<void>) => {
      handler = callback;
    },
    off: () => undefined,
  } as unknown as Page;
  const channel = captureFubonLoginDialogs(page);
  assert.ok(handler);
  await handler({
    type: () => "confirm",
    message: () => "0212：其他裝置登入",
    accept: async () => undefined,
    dismiss: async () => undefined,
  });
  const outcome = await withTelemetry(() =>
    waitForFubonPostLoginOutcome(page, {
      timeoutMs: 20,
      pollIntervalMs: 1,
      dialogChannel: channel,
      probe: async () => snapshot({ result: false, errorCode: "0212" }),
    }),
  );
  assert.match(String(outcome.error), /Fubon login rejected \(error 0212\)/);
  channel.dispose();
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
