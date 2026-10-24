import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { signalRunEvent, type WorkflowRunEvent } from "../lib/automation/run-event.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { classifyTypedWorkflowFailure } from "../lib/automation/server/typed-workflow-outcome.ts";
import { runCtbcProviderWorkflow } from "./ctbc-statements.ts";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route("https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<html><body>回應說明：系統忙碌中，請稍後再試(APP-0000)</body></html>",
    });
  });
  const controller = new AbortController();
  // Three unavailable-page attempts include two one-second retry waits.
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const events: WorkflowRunEvent[] = [];
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "ctbc-busy-fixture",
    signal: controller.signal,
    now: () => "2026-09-26T00:00:00.000Z",
    browser: { withPage: (run) => run(page) },
    text: strictSourceText,
    verification: { complete: async () => { throw new Error("unexpected assistance"); } },
    financialCommit: { execute: async () => { throw new Error("unexpected commit"); } },
    event: async (stage, outcome, code) => {
      events.push({ runId: "ctbc-busy-fixture", stage, outcome, code, occurredAt: "2026-09-26T00:00:00.000Z" });
    },
    signalEvent: async (signal) => {
      events.push(signalRunEvent(signal, { runId: "ctbc-busy-fixture", occurredAt: "2026-09-26T00:00:00.000Z" }));
    },
  };
  let failure: unknown;
  try {
    await runCtbcProviderWorkflow(context, {
      credentials: { ctbc_user_id: "fixture", ctbc_account: "fixture", ctbc_password: "fixture" },
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timeout);
  }
  assert.ok(failure);
  assert.ok(events.some((event) => event.code === "source-unavailable"));
  assert.equal(classifyTypedWorkflowFailure(failure, events), "source-unavailable");

  const acceptedPage = await browser.newPage();
  await acceptedPage.route("https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010", async (route) => {
    await route.fulfill({ status: 202, contentType: "text/html", body: "<html><body></body></html>" });
  });
  const acceptedController = new AbortController();
  const acceptedTimeout = setTimeout(() => acceptedController.abort(), 12_000);
  const acceptedEvents: WorkflowRunEvent[] = [];
  const acceptedContext: WorkflowContextWith<"financialCommit"> = {
    ...context,
    runId: "ctbc-blank-202-fixture",
    signal: acceptedController.signal,
    browser: { withPage: (run) => run(acceptedPage) },
    event: async (stage, outcome, code) => {
      acceptedEvents.push({ runId: "ctbc-blank-202-fixture", stage, outcome, code, occurredAt: "2026-09-26T00:00:00.000Z" });
    },
    signalEvent: async (signal) => {
      acceptedEvents.push(signalRunEvent(signal, { runId: "ctbc-blank-202-fixture", occurredAt: "2026-09-26T00:00:00.000Z" }));
    },
  };
  let acceptedFailure: unknown;
  try {
    await runCtbcProviderWorkflow(acceptedContext, {
      credentials: { ctbc_user_id: "fixture", ctbc_account: "fixture", ctbc_password: "fixture" },
    });
  } catch (error) {
    acceptedFailure = error;
  } finally {
    clearTimeout(acceptedTimeout);
  }
  assert.ok(acceptedFailure);
  assert.ok(acceptedEvents.some((event) => event.code === "source-unavailable"));
  assert.equal(classifyTypedWorkflowFailure(acceptedFailure, acceptedEvents), "source-unavailable");
} finally {
  await browser.close();
}
