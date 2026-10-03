import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { captureSessionScreenshot, sendHumanVerificationInput } from "./automation-viewer.ts";
import { createAppWorkflowBrowserPort } from "./app-browser-host.ts";
import { humanSessionForTask, updateHumanAssistanceCompletionForTask } from "./human-session.ts";
import { resumeAppWorkflowHumanAssistance } from "./app-workflow-human-assistance.ts";
import { automationResumeHumanAssistance } from "./desktop-api.ts";
import { shutdownAppAutomationWorkflows } from "./runner.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import type { WorkflowFinancialCommitPort } from "../workflow-executor.ts";
import { taskById } from "./tasks.ts";
import { configureHostVerificationActorPolicy } from "../verification-config.ts";

const loginUrl = "https://www.einvoice.nat.gov.tw/accounts/login";
const homeUrl = "https://www.einvoice.nat.gov.tw/portal/btc/mobile/home";
const searchUrl = "https://www.einvoice.nat.gov.tw/portal/btc/mobile/btc502w/search";
const listEndpoint = "https://www.einvoice.nat.gov.tw/btc/cloud/api/btc502w/searchCarrierInvoice";
const humanVerificationSettings = { LIBRETTO_CLOUD_EINVOICE_VERIFICATION_ACTOR: "human" } as const;
const testCredentialEnvironment = () => ({
  [["LIBRETTO", "CLOUD", "EINVOICE", "PHONE_NUMBER"].join("_")]: "0900000000",
  [["LIBRETTO", "CLOUD", "EINVOICE", "PASSWORD"].join("_")]: "test-only-secret",
});

const loginPage = `<!doctype html><html><body>
  <input id="mobile_phone" /><input id="password" /><input id="captcha" />
  <span class="input-group-text code_num"><img alt="圖形驗證碼" width="150" height="40"
    src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" /></span>
  <button id="submitBtn" type="button" onclick="location.href='/portal/btc/mobile/home'">登入</button>
</body></html>`;

const searchPage = () => `<!doctype html><html><body>
  <input id="dp-input-searchInvoiceDate" />
  <div class="dp__month_year_wrap"></div>
  <button aria-label="上個月" type="button">prev</button>
  <button aria-label="下個月" type="button">next</button>
  <div id="days"></div>
  <select id="carrier"><option value="all">All</option></select>
  <select id="status"><option value="all">All</option></select>
  <input id="buyerBan" /><input id="productName" />
  <button aria-label="查詢" type="button">查詢</button>
  <script>
    let month = new Date().getMonth();
    let year = new Date().getFullYear();
    const label = document.querySelector('.dp__month_year_wrap');
    const render = () => {
      label.textContent = (month + 1) + '月 ' + year + '年';
      document.querySelector('#days').innerHTML = Array.from({ length: 31 }, (_, i) =>
        '<div class="dp__calendar_item"><span class="dp__cell_inner">' + (i + 1) + '</span></div>'
      ).join('');
    };
    document.querySelector('[aria-label="上個月"]').addEventListener('click', () => {
      month -= 1; if (month < 0) { month = 11; year -= 1; } render();
    });
    document.querySelector('[aria-label="下個月"]').addEventListener('click', () => {
      month += 1; if (month > 11) { month = 0; year += 1; } render();
    });
    document.querySelector('[aria-label="查詢"]').addEventListener('click', () => {
      fetch('/btc/cloud/api/btc502w/searchCarrierInvoice', { method: 'POST' });
    });
    render();
  </script>
</body></html>`;

function waitForStatus(
  provider: ReturnType<typeof createPgliteOperationalProvider>,
  taskRunId: string,
  status: "waiting_for_human" | "completed" | "cancelled",
) {
  return (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const run = await provider.automation.taskRunById(taskRunId);
      if (run?.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const latest = await provider.automation.taskRunById(taskRunId);
    throw new Error(`Timed out waiting for ${status}; latest=${latest?.status ?? "missing"}`);
  })();
}

async function createRun(
  provider: ReturnType<typeof createPgliteOperationalProvider>,
) {
  const created = await provider.automation.createTaskRun({
    taskId: "einvoice-personal-invoices",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  const run = await provider.automation.taskRunById(created.taskRunId);
  assert.ok(run);
  return run;
}

test("App dispatch runs E-Invoice in its browser host and resumes human assistance in place", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  assert.equal(task.workflowId, "einvoice-personal-invoices");

  const root = await mkdtemp(join(tmpdir(), "einvoice-app-workflow-"));
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const browser = await chromium.launch({ headless: true });
  const contexts = new Map<string, BrowserContext>();
  configureHostVerificationActorPolicy({
    isPackaged: false,
    env: { LIBRETTO_CLOUD_EINVOICE_VERIFICATION_ACTOR: "human" },
  });
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const firstRun = await createRun(provider);
    const launchContext = async (runId: string) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      contexts.set(runId, context);
      const page = await context.newPage();
      await page.route("https://www.einvoice.nat.gov.tw/**", async (route) => {
          const url = route.request().url();
          if (url === loginUrl) {
            await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: loginPage });
          } else if (url === homeUrl) {
            await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html><body>會員專區</body></html>" });
          } else if (url.startsWith(searchUrl)) {
            await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: searchPage() });
          } else if (url.includes("/btc/cloud/api/btc502w/searchCarrierInvoice")) {
            await route.fulfill({
              status: 200,
              contentType: "application/json; charset=utf-8",
              body: JSON.stringify({ totalElements: 0, totalPages: 0, size: 0, content: [] }),
            });
          } else {
            await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html></html>" });
          }
      });
      return context;
    };
    const financialCommit: WorkflowFinancialCommitPort = {
      async execute(items) {
        const received = [];
        for await (const item of items) received.push(item);
        const request = (received[0]?.command as unknown as { request: { captureId: string; invoices: unknown[] } }).request;
        return {
          status: "completed",
          items: [{
            itemKey: request.captureId,
            provider: "einvoice",
            product: "personal-invoice",
            status: "committed",
            admissionSummaries: [],
            value: {
              status: "committed",
              captureId: request.captureId,
              knowledgeAt: 1,
              sourceRecordIds: [],
              invoiceCount: request.invoices.length,
              insertedInvoiceCount: request.invoices.length,
              insertedRevisionCount: request.invoices.length,
              observedDuplicateCount: 0,
              itemCount: 0,
            },
            relationWarnings: [],
          }],
          diagnostics: [],
          committedCount: 1,
          failedCount: 0,
        };
      },
    };
    const runPromise = runAutomationTaskExecution(task, provider.automation, {
      taskRunId: firstRun.taskRunId,
      launchEnv: testCredentialEnvironment(),
      launchVerificationSettings: humanVerificationSettings,
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: ({ taskId, taskRunId, signal }) =>
        createAppWorkflowBrowserPort({
          taskId,
          taskRunId,
          signal,
          userDataDirectory: root,
          launchPersistentContext: async () => await launchContext(taskRunId),
        }),
    }, async () => {});

    const waitingRun = await waitForStatus(provider, firstRun.taskRunId, "waiting_for_human");
    assert.equal(await humanSessionForTask(task.id, provider), firstRun.taskRunId);
    assert.equal(Object.hasOwn(waitingRun, "logPath"), false);
    assert.equal(Object.hasOwn(waitingRun, "logTail"), false);
    const contract = waitingRun.humanAssistanceContract;
    assert.ok(contract);
    assert.equal(contract.stageId, "einvoice-login-captcha");
    const screenshot = await captureSessionScreenshot(firstRun.taskRunId);
    assert.ok(screenshot.byteLength > 0, "the existing App viewer can read the hosted page");
    await sendHumanVerificationInput(firstRun.taskRunId, {
      type: "type",
      text: "12345",
      targetId: "captcha-input",
      contractVersion: contract.version,
    }, contract);
    assert.equal(await contexts.get(firstRun.taskRunId)?.pages()[0]?.locator("#captcha").inputValue(), "12345");
    await updateHumanAssistanceCompletionForTask(task.id, "entered", provider);
    const enabledKey = "LIBRETTO_CLOUD_EINVOICE_ENABLED";
    const originalEnabled = process.env[enabledKey];
    process.env[enabledKey] = "true";
    let resumed: Awaited<ReturnType<typeof automationResumeHumanAssistance>>;
    try {
      resumed = await automationResumeHumanAssistance(task.id, provider);
    } finally {
      if (originalEnabled === undefined) delete process.env[enabledKey];
      else process.env[enabledKey] = originalEnabled;
    }
    assert.equal(resumed.runId, firstRun.taskRunId);
    assert.equal(resumed.resumed, task.id);

    const result = await runPromise;
    assert.equal(result.status, "completed");
    const completedRun = await provider.automation.taskRunById(firstRun.taskRunId);
    assert.equal(completedRun?.status, "completed");
    assert.equal(Object.hasOwn(completedRun ?? {}, "logTail"), false);
    assert.ok(completedRun?.events.some((event) => event.code === "authentication-completed"));
    assert.ok(completedRun?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(join(root, "data", "automation")), ["browser-state"]);
    assert.equal((await readdir(join(root, "data", "automation", "browser-state"))).includes(task.id), true);

    const rejectedRun = await createRun(provider);
    const rejectedCommit: WorkflowFinancialCommitPort = {
      async execute(items) {
        let itemKey: string | undefined;
        for await (const candidate of items) {
          itemKey = candidate.itemKey;
          break;
        }
        assert.ok(itemKey);
        const problem = {
          itemKey,
          provider: "einvoice",
          product: "personal-invoice",
          stage: "commit" as const,
          errorCode: "conflict",
          message: "conflict",
        };
        return {
          status: "failed",
          items: [{
            itemKey,
            provider: "einvoice",
            product: "personal-invoice",
            status: "failed",
            failureKind: "item",
            diagnostics: [problem],
          }],
          diagnostics: [problem],
          committedCount: 0,
          failedCount: 1,
        };
      },
    };
    const rejectedPromise = runAutomationTaskExecution(task, provider.automation, {
      taskRunId: rejectedRun.taskRunId,
      launchEnv: testCredentialEnvironment(),
      launchVerificationSettings: humanVerificationSettings,
      workflowPorts: { financialCommit: rejectedCommit },
      workflowBrowserPortFactory: ({ taskId, taskRunId, signal }) =>
        createAppWorkflowBrowserPort({
          taskId,
          taskRunId,
          signal,
          userDataDirectory: root,
          launchPersistentContext: async () => await launchContext(taskRunId),
        }),
    }, async () => {});
    const rejectedWaiting = await waitForStatus(provider, rejectedRun.taskRunId, "waiting_for_human");
    assert.ok(rejectedWaiting.humanAssistanceContract);
    await sendHumanVerificationInput(rejectedRun.taskRunId, {
      type: "type",
      text: "12345",
      targetId: "captcha-input",
      contractVersion: rejectedWaiting.humanAssistanceContract.version,
    }, rejectedWaiting.humanAssistanceContract);
    await updateHumanAssistanceCompletionForTask(task.id, "entered", provider);
    await resumeAppWorkflowHumanAssistance(rejectedRun.taskRunId, "entered");
    const rejectedResult = await rejectedPromise;
    assert.equal(rejectedResult.status, "failed");
    const rejectedRecord = await provider.automation.taskRunById(rejectedRun.taskRunId);
    assert.equal(rejectedRecord?.appWorkflowOutcome?.errorCode, "canonical-commit-failed");
    assert.ok(rejectedRecord?.events.some((event) => event.code === "canonical-commit-failed"));

    const cancelRun = await createRun(provider);
    let cancellationRequested = false;
    const cancelled = runAutomationTaskExecution(task, provider.automation, {
      taskRunId: cancelRun.taskRunId,
      launchEnv: testCredentialEnvironment(),
      launchVerificationSettings: humanVerificationSettings,
      isCancellationRequested: () => cancellationRequested,
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: ({ taskId, taskRunId, signal }) =>
        createAppWorkflowBrowserPort({
          taskId,
          taskRunId,
          signal,
          userDataDirectory: root,
          launchPersistentContext: async () => await launchContext(taskRunId),
        }),
    }, async () => {});
    await waitForStatus(provider, cancelRun.taskRunId, "waiting_for_human");
    cancellationRequested = true;
    const cancelledResult = await cancelled;
    assert.equal(cancelledResult.status, "cancelled");
    assert.equal((await provider.automation.taskRunById(cancelRun.taskRunId))?.status, "cancelled");
    assert.equal(await resumeAppWorkflowHumanAssistance(cancelRun.taskRunId, "entered"), false);
    assert.deepEqual(await readdir(join(root, "data", "automation")), ["browser-state"]);

    const shutdownRun = await createRun(provider);
    const interrupted = runAutomationTaskExecution(task, provider.automation, {
      taskRunId: shutdownRun.taskRunId,
      launchEnv: testCredentialEnvironment(),
      launchVerificationSettings: humanVerificationSettings,
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: ({ taskId, taskRunId, signal }) =>
        createAppWorkflowBrowserPort({
          taskId,
          taskRunId,
          signal,
          userDataDirectory: root,
          launchPersistentContext: async () => await launchContext(taskRunId),
        }),
    }, async () => {});
    await waitForStatus(provider, shutdownRun.taskRunId, "waiting_for_human");
    await shutdownAppAutomationWorkflows(provider);
    assert.equal((await provider.automation.taskRunById(shutdownRun.taskRunId))?.status, "interrupted");
    await interrupted;
    assert.deepEqual(await readdir(join(root, "data", "automation")), ["browser-state"]);
  } finally {
    configureHostVerificationActorPolicy({ isPackaged: true, env: {} });
    for (const context of contexts.values()) await context.close().catch(() => {});
    await browser.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
