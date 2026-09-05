import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Frame, Page } from "playwright";
import { emitHumanAssistanceStage } from "./human-assistance.ts";

const {
  isYuantaSignedIn,
  yuantaBankCaptchaAssistanceStage,
  classifyYuantaBankDialogMessage,
  yuantaBankDialogFailureMessage,
  yuantaBankDialogState,
  yuantaPostSubmitDialogOwner,
  yuantaSourceConnectionScope,
  deriveYuantaSourceConnectionKey,
} = await import(
  "./yuanta-auth.ts",
);
const { deriveSourceConnectionIdentityKey } = await import(
  "../ledger/canonical/source-connection-identity.ts"
);
const { canonicalLoanSourceIdentity } = await import(
  "../ledger/canonical/loan-financial.ts"
);
import {
  YUANTA_DIALOG_OWNER_ENV,
  yuantaHostDialogOwner,
} from "../lib/automation/yuanta-captcha.ts";

type FakeFrame = {
  frameName: string;
  frameUrl: string;
  marker: "navigation" | "logout" | "none" | "login";
  url: () => string;
  loginVisibility: boolean[];
  locator: (selector: string) => {
    count: () => Promise<number>;
    isVisible: () => Promise<boolean>;
    nth: (index: number) => {
      isVisible: () => Promise<boolean>;
    };
    first: () => {
      count: () => Promise<number>;
      isVisible: () => Promise<boolean>;
    };
  };
};

function fakeFrame(
  frameName: string,
  marker: FakeFrame["marker"],
  frameUrl = "https://ebank.yuantabank.com.tw/nib/tx/home",
  loginVisibility = [true],
): FakeFrame {
  return {
    frameName,
    frameUrl,
    marker,
    url: () => frameUrl,
    loginVisibility,
    locator: (selector: string) => {
      const isLoginSelector =
        marker === "login" &&
        /custidMask|custnoInput|custcode|gcode/.test(selector);
      const matches =
        marker === "navigation"
          ? /doAction|menuaction|menu_|\/nib\/tx\//.test(selector)
          : marker === "logout"
            ? /logout|btnLogout/.test(selector)
            : isLoginSelector;
      const visibleValues = isLoginSelector ? loginVisibility : [matches];
      const locator = {
        count: async () => (matches ? visibleValues.length : 0),
        isVisible: async () => visibleValues[0] ?? false,
        nth: (index: number) => ({
          isVisible: async () => visibleValues[index] ?? false,
        }),
        first: () => locator,
      };
      return locator;
    },
  };
}

function fakePage(
  frames: FakeFrame[],
  pageUrl = "https://ebank.yuantabank.com.tw/nib/tx/home",
): Page {
  return {
    url: () => pageUrl,
    frames: () => frames,
    frame: ({ name }: { name: string }) =>
      frames.find((frame) => frame.frameName === name) ?? null,
  } as unknown as Page;
}

test("shared Yuanta signed-in probe accepts bank navigation without cid", async () => {
  const page = fakePage([
    fakeFrame("fmenu", "navigation"),
    fakeFrame("fmain", "none"),
  ]);
  assert.equal(await isYuantaSignedIn(page), true);
});

test("shared Yuanta signed-in probe accepts a bank logout marker", async () => {
  const page = fakePage([
    fakeFrame("fmenu", "none"),
    fakeFrame("fmain", "logout"),
  ]);
  assert.equal(await isYuantaSignedIn(page), true);
});

test("shared Yuanta signed-in probe rejects stale frames without bank evidence", async () => {
  const page = fakePage([
    fakeFrame("fmenu", "none"),
    fakeFrame("fmain", "none"),
  ]);
  assert.equal(await isYuantaSignedIn(page), false);
});

test("shared Yuanta signed-in probe rejects NotAuth and timeout documents", async () => {
  for (const frameUrl of [
    "https://ebank.yuantabank.com.tw/nib/common/NotAuth.jsp?type=timeout",
    "https://ebank.yuantabank.com.tw/nib/common/error/NotAuth.jsp?type=dupLogin",
  ]) {
    const page = fakePage([
      fakeFrame("fmenu", "navigation", frameUrl),
      fakeFrame("fmain", "logout"),
    ]);
    assert.equal(await isYuantaSignedIn(page), false, frameUrl);
  }
});

test("shared Yuanta signed-in probe rejects a visible login frame", async () => {
  const page = fakePage([
    fakeFrame("main", "login"),
    fakeFrame("fmenu", "navigation"),
    fakeFrame("fmain", "logout"),
  ]);
  assert.equal(await isYuantaSignedIn(page), false);
});

test("shared Yuanta signed-in probe rejects external or mixed-origin shells", async () => {
  const cases = [
    fakePage(
      [
        fakeFrame(
          "fmenu",
          "navigation",
          "https://evil.example.test/nib/tx/home",
        ),
        fakeFrame("fmain", "logout"),
      ],
      "https://ebank.yuantabank.com.tw/nib/tx/home",
    ),
    fakePage(
      [
        fakeFrame("fmenu", "navigation"),
        fakeFrame("fmain", "logout", "https://evil.example.test/nib/tx/home"),
      ],
      "https://ebank.yuantabank.com.tw/nib/tx/home",
    ),
    fakePage(
      [fakeFrame("fmenu", "navigation"), fakeFrame("fmain", "logout")],
      "https://evil.example.test/nib/tx/home",
    ),
  ];
  for (const page of cases) {
    assert.equal(await isYuantaSignedIn(page), false);
  }
});

test("shared Yuanta signed-in probe checks every visible login field", async () => {
  const page = fakePage([
    fakeFrame("main", "login", undefined, [false, true]),
    fakeFrame("fmenu", "navigation"),
    fakeFrame("fmain", "logout"),
  ]);
  assert.equal(await isYuantaSignedIn(page), false);
});

test("Yuanta products delegate authentication to the shared CAPTCHA seam", async () => {
  const authSource = await readFile(
    new URL("./yuanta-auth.ts", import.meta.url),
    "utf8",
  );
  assert.match(authSource, /export async function authenticateYuantaBank/);
  assert.match(authSource, /emitHumanAssistanceStage/);
  assert.match(authSource, /#gcode/);
  assert.doesNotMatch(
    authSource,
    /console\.(log|warn|error)\([^\n]*(?:password|captcha)/i,
  );

  for (const fileName of [
    "yuanta-all-statements.ts",
    "yuanta-statements.ts",
    "yuanta-foreign-currency-statements.ts",
    "yuanta-loan-statements.ts",
    "yuanta-credit-card-statements.ts",
    "yuanta-fund-statements.ts",
  ]) {
    const source = await readFile(
      new URL(`./${fileName}`, import.meta.url),
      "utf8",
    );
    if (fileName !== "yuanta-auth.ts") {
      assert.match(source, /yuanta-auth\.ts/);
    }
  }
});

test("Yuanta post-submit dialog ownership is bound to the current hosted retry session", () => {
  assert.equal(
    yuantaPostSubmitDialogOwner("ses-yuanta-current", {
      [YUANTA_DIALOG_OWNER_ENV]: yuantaHostDialogOwner("ses-yuanta-current"),
    }),
    "host",
  );
  assert.equal(
    yuantaPostSubmitDialogOwner("ses-yuanta-current", {
      [YUANTA_DIALOG_OWNER_ENV]: yuantaHostDialogOwner("ses-yuanta-stale"),
    }),
    "workflow",
  );
  assert.equal(yuantaPostSubmitDialogOwner("ses-yuanta-current", {}), "workflow");
});

test("Yuanta local dialog handling keeps provider text out of state and errors", async () => {
  const rawMessage = "驗證碼不正確，請重新輸入";
  const state = yuantaBankDialogState({
    type: () => "alert",
    message: () => rawMessage,
  });
  assert.deepEqual(state, { type: "alert", category: "captcha-rejected" });
  assert.equal(classifyYuantaBankDialogMessage(rawMessage), "captcha-rejected");
  const safeError = yuantaBankDialogFailureMessage(state.category);
  assert.equal(safeError.includes(rawMessage), false);
  assert.equal(safeError.includes("請重新輸入"), false);

  const authSource = await readFile(
    new URL("./yuanta-auth.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    authSource,
    /console\.warn\([\s\S]*?bank-dialog[\s\S]*?message\s*:/,
  );
});

test("shared Yuanta CAPTCHA seam publishes a digit text challenge for the observed GOTP image", async () => {
  const selectors: string[] = [];
  const loginFrame = {
    locator: (selector: string) => {
      selectors.push(selector);
      const locator = {
        boundingBox: async () =>
          selector === "#gcode"
            ? { x: 120, y: 537, width: 150, height: 50 }
            : { x: 13, y: 537, width: 107, height: 50 },
        first: () => locator,
      };
      return locator;
    },
  } as unknown as Frame;
  const contract = await emitHumanAssistanceStage(
    yuantaBankCaptchaAssistanceStage(loginFrame),
    () => undefined,
  );

  assert.deepEqual(selectors, ["#gcode", 'img[src*="GOTP"]:visible']);
  assert.equal(contract.challengeKind, "text-captcha");
  assert.equal(contract.charset, "digits");
  assert.deepEqual(contract.imagePreprocessing, ["remove-interference-lines"]);
  assert.deepEqual(contract.ocrAttemptPlan, [
    { ocrPageSegmentationMode: "single-line" },
    { ocrPageSegmentationMode: "single-word" },
    { imagePreprocessing: [], ocrOutputStage: "grayscale", ocrPageSegmentationMode: "single-line" },
  ]);
  assert.equal(contract.expectedAnswerLength, 6);
  assert.deepEqual(contract.challengeImageRegion, {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "yuanta-bank.login.captcha-image",
    rect: { x: 13, y: 537, width: 107, height: 50 },
  });
  assert.equal(contract.targets[0]?.semanticId, "yuanta-bank.login.captcha-input");
  assert.deepEqual(contract.targets[0]?.rect, {
    x: 120,
    y: 537,
    width: 150,
    height: 50,
  });
});

test("Yuanta product workflows derive one stable source connection from one login identity", () => {
  const credentials = {
    yuanta_user_id: " user-001 ",
    yuanta_account: " main-account ",
    yuanta_password: "password-one",
  };
  const scope = yuantaSourceConnectionScope(credentials);
  assert.equal(scope, "USER-001\u0000MAIN-ACCOUNT");

  const sameLoginAfterPasswordRotation = yuantaSourceConnectionScope({
    ...credentials,
    yuanta_password: "password-two",
  });
  assert.equal(sameLoginAfterPasswordRotation, scope);
  assert.equal(
    deriveSourceConnectionIdentityKey("yuanta", scope),
    deriveSourceConnectionIdentityKey("yuanta", sameLoginAfterPasswordRotation),
  );
  assert.equal(
    deriveYuantaSourceConnectionKey(credentials),
    deriveSourceConnectionIdentityKey("yuanta", scope),
    "Yuanta product workflows must use the shared canonical source key",
  );
  assert.equal(
    canonicalLoanSourceIdentity("yuanta", scope, "loan-001")
      .sourceConnectionKey,
    deriveSourceConnectionIdentityKey("yuanta", scope),
  );

  const otherLoginScope = yuantaSourceConnectionScope({
    ...credentials,
    yuanta_user_id: "other-user",
  });
  assert.notEqual(
    deriveSourceConnectionIdentityKey("yuanta", scope),
    deriveSourceConnectionIdentityKey("yuanta", otherLoginScope),
  );

  // Session, solver, OTP and query-range values are intentionally not
  // accepted by this helper, so changing those runtime details cannot create
  // another source connection key.
  assert.equal(
    yuantaSourceConnectionScope({
      ...credentials,
      yuanta_password: "password-one",
    }),
    scope,
  );
  assert.equal(
    deriveYuantaSourceConnectionKey({
      ...credentials,
      yuanta_password: "rotated-password",
    }),
    deriveYuantaSourceConnectionKey(credentials),
    "password changes must not change Source Connection identity",
  );
  assert.equal(
    deriveYuantaSourceConnectionKey({
      yuanta_user_id: credentials.yuanta_user_id,
      yuanta_account: credentials.yuanta_account,
    }),
    deriveYuantaSourceConnectionKey(credentials),
    "session/query details are not part of the Source Connection input",
  );
});

test("Yuanta stable login scope owns one shared field definition", async () => {
  const authSource = await readFile(
    new URL("./yuanta-auth.ts", import.meta.url),
    "utf8",
  );
  assert.equal(authSource.match(/name: "yuanta_user_id"/gu)?.length, 1);
  assert.equal(authSource.match(/name: "yuanta_account"/gu)?.length, 1);
  assert.match(authSource, /yuantaStableLoginFields\(credentials\)/u);
});

// This regression must run through Libretto's actual TSX loader. The regular
// repository test runner may use Node's strip-types mode, which cannot resolve
// Libretto's nested TSX loader seam.
if (!process.execArgv.includes("--experimental-strip-types")) {
  test("the real Libretto loader resolves every Yuanta workflow", async () => {
    const runtime = await import(
      pathToFileURL(
        process.cwd() +
          "/node_modules/libretto/dist/cli/core/workflow-runtime.js",
      ).href
    );
    for (const fileName of [
      "yuanta-all-statements.ts",
      "yuanta-statements.ts",
      "yuanta-foreign-currency-statements.ts",
      "yuanta-loan-statements.ts",
      "yuanta-credit-card-statements.ts",
      "yuanta-fund-statements.ts",
    ]) {
      const workflow = await runtime.loadDefaultWorkflow(
        process.cwd() + "/src/workflows/" + fileName,
      );
      assert.match(workflow.name, /^yuanta/);
    }
  });

  test("the Vite production auth loader uses current bank shell evidence", async () => {
    const { createServer } = await import("vite");
    const server = await createServer({
      configFile: false,
      cacheDir: "/tmp/octopus-beak-yuanta-auth-check",
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    try {
      const module = await server.ssrLoadModule(
        "/src/workflows/yuanta-auth.ts",
      );
      assert.equal(
        await module.isYuantaSignedIn(
          fakePage([
            fakeFrame("fmenu", "navigation"),
            fakeFrame("fmain", "none"),
          ]),
        ),
        true,
      );
      assert.equal(
        await module.isYuantaSignedIn(
          fakePage([
            fakeFrame(
              "fmenu",
              "navigation",
              "https://ebank.yuantabank.com.tw/nib/common/error/NotAuth.jsp?type=timeout",
            ),
            fakeFrame("fmain", "logout"),
          ]),
        ),
        false,
      );
    } finally {
      await server.close();
    }
  });
}
