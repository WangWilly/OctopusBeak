import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Browser, type Page } from "playwright";
import { launchCheckBrowser } from "../lib/automation/check-browser.fixtures.ts";
import { productCollectionHandle, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import {
  CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  CTBC_CURRENT_DEPOSIT_BALANCE_HOST,
  readCtbcCurrentDepositBalanceResponse,
} from "./ctbc-current-deposit-balances.ts";
import { readCtbcDepositSource } from "./ctbc-statements.ts";
import { providerResponseReader, WITHOUT_PRODUCT_VALIDATION } from "./provider-response-reader.ts";

const CANCELLED = new Error("synthetic cancellation");
const ABORT_AFTER_MS = 300;
const UNCOVERED_AFTER_MS = 700;

let browser: Browser;
before(async () => {
  browser = await launchCheckBrowser();
});
after(async () => {
  await browser.close();
});

/**
 * A CTBC page whose control stays covered until after the run is cancelled.
 * A click still pending then would land; a stopped one never does.
 */
const coveredControlPage = (control: string) => `<!doctype html>
<meta charset="utf-8">
${control}
<div id="cover" style="position:fixed;inset:0;background:white"></div>
<script>
  window.clicks = 0;
  document.querySelector("[data-control]").addEventListener("click", () => { window.clicks += 1; });
  setTimeout(() => document.getElementById("cover").remove(), ${UNCOVERED_AFTER_MS});
  for (const resource of ["/twrbc-deposit/qu002/010", "/twrbc-deposit/qu002/011"]) {
    fetch("${CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}", { method: "POST", body: JSON.stringify({ resource }) });
  }
</script>`;

const resources: Record<string, unknown> = {
  "/twrbc-deposit/qu002/010": { code: "0000", rsData: { accountInfoList: [{ accountId: "synthetic" }], dateRanges: [] } },
  "/twrbc-deposit/qu002/011": { code: "9201", rsData: null },
};

async function withCtbc(control: string, body: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`https://${CTBC_CURRENT_DEPOSIT_BALANCE_HOST}/**`, (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: coveredControlPage(control) });
      }
      const { resource } = JSON.parse(request.postData() ?? "{}") as { resource: string };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(resources[resource]) });
    });
    await body(page);
  } finally {
    await page.close();
  }
}

const cancelledAfter = (ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(CANCELLED), ms);
  return controller.signal;
};

/** The read rejects with the run's reason well inside its wait, and the pending click never lands. */
async function assertStopped(page: Page, read: Promise<unknown>) {
  const started = Date.now();
  await assert.rejects(read, (error: unknown) => error === CANCELLED);
  assert.ok(Date.now() - started < 2_000);
  await new Promise((resolve) => setTimeout(resolve, UNCOVERED_AFTER_MS + 500));
  assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 0);
}

test("cancelling the run stops a deposit read clicking the account selector", () =>
  withCtbc(`<div class="btn dropdown-toggle" data-control>帳戶</div>`, async (page) => {
    const staged: ProductStageRequest[] = [];
    const signal = cancelledAfter(ABORT_AFTER_MS);
    const now = () => new Date().toISOString();
    const event = async () => undefined;
    const context = { signal, text: strictSourceText, now, event } as unknown as WorkflowContext;
    const product = productCollectionHandle({
      now,
      text: strictSourceText,
      signal,
      event,
      stage: (...requests) => { staged.push(...requests); },
      reportActivity: async () => undefined,
      collectionPeriod: () => { throw new Error("This check supplies no collection period."); },
    });
    await assertStopped(page, readCtbcDepositSource(page, {
      credentials: { ctbc_user_id: "synthetic-user", ctbc_account: "synthetic-account", ctbc_password: "synthetic-password" },
      statementTypes: ["deposit"],
      attachedPreviewProducts: [],
    }, context, product));
    assert.deepEqual(staged, []);
  }));

test("cancelling the run stops a current-balance read clicking its menu", () =>
  withCtbc(`<a data-control>臺幣/轉帳</a>`, async (page) => {
    await page.goto(`https://${CTBC_CURRENT_DEPOSIT_BALANCE_HOST}/twrbc/`);
    const reader = providerResponseReader({
      now: () => new Date().toISOString(),
      text: strictSourceText,
      validate: WITHOUT_PRODUCT_VALIDATION,
    });
    await assertStopped(page, readCtbcCurrentDepositBalanceResponse(page, cancelledAfter(ABORT_AFTER_MS), reader));
  }));
