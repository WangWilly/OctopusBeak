import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { ProductCollectionHandle } from "../lib/automation/product-collection.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { runSinopacDeposit, type SinopacWorkflowInput } from "./sinopac-statements.ts";

const CANCELLED = new Error("synthetic cancellation");
const MMA_HOME = "https://mma.sinopac.com/mma/home.aspx";

const input: SinopacWorkflowInput = {
  credentials: {
    sinopac_user_id: "synthetic-user",
    sinopac_account: "synthetic-account",
    sinopac_password: "synthetic-password",
  },
  accountFilters: [],
  currencyFilters: [],
  statementTypes: ["deposit"],
  attachedPreviewProducts: [],
};

// The 往來明細 link is visible but covered until 400 ms, so its click is still waiting when the run is cancelled.
const COVERED_DETAIL_LINK = `<!doctype html>
<a title="往來明細" href="javascript:void 0" onclick="window.detailClicked = true">往來明細</a>
<div id="cover" style="position:fixed;inset:0"></div>
<script>setTimeout(() => document.getElementById("cover").remove(), 400);</script>`;

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

test("cancelling the run stops a pending 往來明細 click instead of letting it land once the cover lifts", async () => {
  const page = await browser.newPage();
  try {
    await page.route("https://mma.sinopac.com/**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: COVERED_DETAIL_LINK }));
    await page.goto(MMA_HOME);
    const controller = new AbortController();
    const staged: unknown[] = [];
    const context = { signal: controller.signal, text: strictSourceText, now: () => "2026-10-01T12:00:00.000+08:00" } as unknown as WorkflowContext;
    const product = {
      event: async () => undefined,
      collectionPeriod: () => ({ start: "2026-09-01", end: "2026-09-30", windows: [{ start: "2026-09-01", end: "2026-09-30" }] }),
      stage: (...items: unknown[]) => { staged.push(...items); },
    } as unknown as ProductCollectionHandle;

    setTimeout(() => controller.abort(CANCELLED), 100);
    const started = Date.now();
    await assert.rejects(runSinopacDeposit(page, input, context, product), (error: unknown) => error === CANCELLED);
    assert.ok(Date.now() - started < 2_000);
    await page.waitForTimeout(1_500);
    assert.equal(await page.evaluate(() => (window as { detailClicked?: boolean }).detailClicked ?? false), false, "the cancelled click never landed");
    assert.deepEqual(staged, []);
  } finally {
    await page.close();
  }
});
