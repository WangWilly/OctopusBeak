import { createCipheriv } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createAppWorkflowBrowserPort } from "./app-browser-host.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import { executeTaskRunForCheck } from "./task-run-check-support.ts";
import type { WorkflowFinancialCommitPort } from "../workflow-executor.ts";
import { taskById } from "./tasks.ts";
import { ldataContext } from "../../../workflows/einvoice-app-protocol.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

const middleHost = "https://uia.einvoice.nat.gov.tw";
const bigHost = "https://upi.einvoice.nat.gov.tw";
const testCredentialEnvironment = () => ({
  [["LIBRETTO", "CLOUD", "EINVOICE", "PHONE_NUMBER"].join("_")]: "0900000000",
  [["LIBRETTO", "CLOUD", "EINVOICE", "PASSWORD"].join("_")]: "test-only-secret",
});

// The live login endpoint answers with a bare base64 ciphertext sealed under
// the key and iv of the request's own a|ciphertext|b ldata.
function sealedLoginPayload(requestBody: string | null): string {
  const [a, , b] = (JSON.parse(requestBody ?? "{}") as { ldata: string }).ldata.split("|");
  const { key, iv } = ldataContext(a!, b!);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([cipher.update(JSON.stringify(loginSession), "utf8"), cipher.final(), cipher.getAuthTag()])
    .toString("base64");
}

const loginSession = {
  sid: "S" + "x".repeat(17),
  token: "t",
  appid: "a",
  ssme: "s",
  liat: 1,
  carrier_code: "/AB+123",
  now: Math.floor(Date.now() / 1000),
};

async function installEinvoiceAppMock(context: BrowserContext, loginDelayMs = 0) {
  await context.route("https://**einvoice.nat.gov.tw/**", async (route) => {
    const url = route.request().url();
    if (url.startsWith(middleHost) && url.includes("/mid/v1/login")) {
      if (loginDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, loginDelayMs));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: 0, payload: sealedLoginPayload(route.request().postData()), id: "fixture" }),
      });
      return;
    }
    if (url.startsWith(bigHost) && url.includes("/einvoice/carriers/query-invoices-header")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ carrierQueryList: { code: "200", msg: "執行成功", version: "1.0", details: [] }, cloudPrizeInvList: [] }),
      });
      return;
    }
    if (url.startsWith(bigHost) && url.includes("/einvoice/carriers/query-invoices-details")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ code: "200", msg: "執行成功", version: "1.0", details: [] }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
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

function committedFinancialCommit(): WorkflowFinancialCommitPort {
  return {
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
}

test("App dispatch runs E-Invoice over its App protocol and commits, rejects, and shuts down", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  assert.equal(task.workflowId, "einvoice-personal-invoices");

  const root = await mkdtemp(join(tmpdir(), "einvoice-app-workflow-"));
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  const browser = await chromium.launch({ headless: true });
  const contexts = new Map<string, BrowserContext>();
  try {
    const provider = createPgliteOperationalProvider(store);

    const launchContext = async (runId: string, loginDelayMs = 0) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      contexts.set(runId, context);
      await installEinvoiceAppMock(context, loginDelayMs);
      return context;
    };
    const makeBrowserPort = (taskId: string, taskRunId: string, signal: AbortSignal, loginDelayMs = 0) =>
      createAppWorkflowBrowserPort({
        taskId,
        taskRunId,
        signal,
        userDataDirectory: root,
        launchPersistentContext: async () => await launchContext(taskRunId, loginDelayMs),
      });

    // Successful empty collection commits.
    const firstRun = await createRun(provider);
    const firstResult = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId: firstRun.taskRunId,
      launchEnv: testCredentialEnvironment(),
      launchVerificationSettings: {},
      workerPorts: { financialCommit: committedFinancialCommit() },
      workflowBrowserPortFactory: ({ taskId, taskRunId, signal }) => makeBrowserPort(taskId, taskRunId, signal),
    });
    assert.equal(firstResult.status, "completed");
    const completedRun = await provider.automation.taskRunById(firstRun.taskRunId);
    assert.equal(completedRun?.status, "completed");
    assert.ok(completedRun?.events.some((event) => event.code === "authentication-completed"));
    assert.ok(completedRun?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(join(root, "data", "automation")), ["browser-state"]);

    // A commit rejection surfaces as canonical-commit-failed.
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
    const rejectedResult = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId: rejectedRun.taskRunId,
      launchEnv: testCredentialEnvironment(),
      launchVerificationSettings: {},
      workerPorts: { financialCommit: rejectedCommit },
      workflowBrowserPortFactory: ({ taskId, taskRunId, signal }) => makeBrowserPort(taskId, taskRunId, signal),
    });
    assert.equal(rejectedResult.status, "failed");
    const rejectedRecord = await provider.automation.taskRunById(rejectedRun.taskRunId);
    assert.equal(rejectedRecord?.appWorkflowOutcome?.errorCode, "canonical-commit-failed");
    assert.ok(rejectedRecord?.events.some((event) => event.code === "canonical-commit-failed"));

    // Shutdown interrupts a run still parked in its (slow) login.
    const shutdownRun = await createRun(provider);
    let shutdownActive: ActiveAutomationTaskRun | undefined;
    const shutdownPromise = executeTaskRunForCheck(task, provider.automation, {
      taskRunId: shutdownRun.taskRunId,
      onRunOpened: (active) => {
        shutdownActive = active;
      },
      launchEnv: testCredentialEnvironment(),
      launchVerificationSettings: {},
      workerPorts: { financialCommit: committedFinancialCommit() },
      workflowBrowserPortFactory: ({ taskId, taskRunId, signal }) => makeBrowserPort(taskId, taskRunId, signal, 30_000),
    });
    // Wait until the run is actively executing, then shut down.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(shutdownActive);
    await shutdownActive.requestStop("shutdown");
    const shutdownResult = await shutdownPromise;
    assert.equal(shutdownResult.status, "interrupted");
    assert.equal((await provider.automation.taskRunById(shutdownRun.taskRunId))?.status, "interrupted");
  } finally {
    for (const context of contexts.values()) await context.close().catch(() => {});
    await browser.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
