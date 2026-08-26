import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { emitHumanAssistanceStage } from "./human-assistance.ts";
import {
  closeInvoiceDetailModal,
  einvoiceCaptchaAssistanceStage,
  waitForListResponse,
} from "./einvoice-personal-invoices.ts";

const browser = await chromium.launch();
try {
  const captchaPage = await browser.newPage();
  await captchaPage.setContent(`
    <input id="captcha" style="width: 120px; height: 32px" />
    <span class="input-group-text code_num">
      <img
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        style="width: 150px; height: 40px"
        alt="圖形驗證碼"
      />
    </span>
  `);
  const captchaContract = await emitHumanAssistanceStage(
    einvoiceCaptchaAssistanceStage(captchaPage),
    (contract) => contract,
  );
  assert.equal(captchaContract.stageId, "einvoice-login-captcha");
  assert.equal(captchaContract.challengeKind, "text-captcha");
  assert.equal(captchaContract.charset, "digits");
  assert.equal(captchaContract.imagePreprocessing, undefined);
  assert.equal(captchaContract.ocrPageSegmentationMode, "single-word");
  assert.deepEqual(captchaContract.ocrAttemptPlan, [
    { imagePreprocessing: ["mask-bottom-interference-band"] },
    { imagePreprocessing: ["suppress-horizontal-interference"] },
  ]);
  assert.deepEqual(captchaContract.solveAcceptancePolicy, {
    mode: "agreement-only",
  });
  assert.equal(captchaContract.expectedAnswerLength, 5);
  assert.equal(
    captchaContract.targets[0]?.semanticId,
    "einvoice.login.captcha-input",
  );
  assert.equal(
    captchaContract.challengeImageRegion?.semanticId,
    "einvoice.login.captcha-image",
  );
  assert.equal(captchaContract.challengeImageRegion?.rect?.width, 150);
  assert.equal(captchaContract.challengeImageRegion?.rect?.height, 40);
  await captchaPage.close();
} finally {
  await browser.close();
}

const actions: string[] = [];
let modalVisible = true;
let closeClicks = 0;
const closeButton = {
  async click() {
    actions.push("click-close");
    closeClicks += 1;
    if (closeClicks === 2) modalVisible = false;
  },
};
const modal = {
  first() {
    return this;
  },
  async isVisible() {
    actions.push("modal-visible");
    return modalVisible;
  },
  getByRole(role: string, options: { name: string }) {
    assert.equal(role, "button");
    assert.equal(options.name, "關閉視窗");
    return closeButton;
  },
  async waitFor(options: { state: string }) {
    actions.push(`wait-modal-${options.state}`);
    if (modalVisible) throw new Error("Modal is still visible");
  },
};
const backdrop = {
  first() {
    return this;
  },
  async waitFor(options: { state: string }) {
    actions.push(`wait-backdrop-${options.state}`);
  },
};
const page = {
  locator(selector: string) {
    if (selector === ".modal_barcode_detail.show") return modal;
    if (selector === ".simple-modal-backdrop") return backdrop;
    throw new Error(`Unexpected selector: ${selector}`);
  },
};

await closeInvoiceDetailModal(page as unknown as Page);

assert.deepEqual(actions, [
  "modal-visible",
  "click-close",
  "wait-modal-hidden",
  "modal-visible",
  "click-close",
  "wait-modal-hidden",
  "wait-backdrop-hidden",
]);

actions.length = 0;
modalVisible = false;
await closeInvoiceDetailModal(page as unknown as Page);
assert.deepEqual(actions, [
  "modal-visible",
  "wait-backdrop-hidden",
]);

const noContentListResponse = await waitForListResponse({
  async waitForResponse(
    predicate: (response: {
      url(): string;
      request(): { method(): string };
    }) => boolean,
  ) {
    const response = {
      url: () =>
        "https://www.einvoice.nat.gov.tw/btc/cloud/api/btc502w/searchCarrierInvoice",
      request: () => ({ method: () => "POST" }),
    };
    assert.equal(predicate(response), true);
    return {
      status: () => 204,
      json: async () => await new Response(null, { status: 204 }).json(),
    };
  },
} as unknown as Page);

assert.deepEqual(noContentListResponse, {
  totalElements: 0,
  totalPages: 0,
  size: 0,
  content: [],
});

const populatedListResponse = {
  totalElements: 1,
  totalPages: 1,
  size: 1,
  content: [],
};
assert.equal(
  await waitForListResponse({
    async waitForResponse() {
      return {
        status: () => 200,
        json: async () => populatedListResponse,
      };
    },
  } as unknown as Page),
  populatedListResponse,
);
