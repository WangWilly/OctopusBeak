import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { signalRunEvent, type WorkflowRunEvent } from "../lib/automation/run-event.ts";
import { classifyFailure } from "../lib/automation/failure-classification.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { reportedVerificationPort } from "../lib/automation/verification-stage.ts";
import type { WorkflowContext, WorkflowHumanAssistancePort } from "../lib/automation/workflow-executor.ts";

/** What the fake human does with a Verification stage. */
export type Assist = (page: Page, signal: AbortSignal) => Promise<"entered" | "verified" | "failed">;

export const typesAnswer = (selector: string, answer: string): Assist => async (page) => {
  await page.locator(selector).first().fill(answer);
  return "entered";
};
export const leavesEmpty: Assist = async () => "entered";
export const givesUp: Assist = async () => "failed";

export const untilAborted = <T>(signal: AbortSignal): Promise<T> => new Promise<T>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

/**
 * A run whose Verification port is the real `reportedVerificationPort`, so a
 * check can assert that the port's events appear exactly once. `codes` reads
 * `<outcome> <code>` for an event and `signal:<name>` for a signal.
 */
export function recordedRun(page: Page, assist: Assist) {
  const controller = new AbortController();
  const events: WorkflowRunEvent[] = [];
  const codes: string[] = [];
  const record = (event: WorkflowRunEvent) => {
    events.push(event);
    codes.push(event.signal ? `signal:${event.signal}` : `${event.outcome} ${event.code}`);
  };
  const event: WorkflowContext["event"] = async (stage, outcome, code) => {
    record({ runId: "sign-in-check", occurredAt: "now", stage, outcome, code });
  };
  const signalEvent: WorkflowContext["signalEvent"] = async (signal) => {
    record(signalRunEvent(signal, { runId: "sign-in-check", occurredAt: "now" }));
  };
  const humanAssistance: WorkflowHumanAssistancePort = { request: (_contract, signal) => assist(page, signal) };
  const context: WorkflowContext = {
    runId: "sign-in-check",
    signal: controller.signal,
    now: () => "now",
    browser: { withPage: (run) => run(page) },
    text: strictSourceText,
    verification: reportedVerificationPort({ humanAssistance, signal: controller.signal, event, signalEvent }),
    event,
    signalEvent,
  };
  return {
    context,
    controller,
    codes,
    classify: (error: unknown) => classifyFailure({ error, events, stopped: controller.signal.aborted }),
  };
}

export async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the sign-in to reject");
}

export const dialogListeners = (page: Page) => (page as unknown as EventEmitter).listenerCount("dialog");

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A page with an open dialog never answers evaluate(). */
export async function assertUsable(page: Page): Promise<void> {
  const answer = await Promise.race([page.evaluate(() => "usable"), delay(1_500).then(() => "blocked by an open dialog")]);
  assert.equal(answer, "usable");
}

export const STARTED = "started authentication-started";
export const REQUESTED = "advanced human-assistance-requested";
export const ASSISTED = "advanced human-assistance-completed";
export const TAKEN = "advanced session-takeover-confirmed";
export const DONE = "completed authentication-completed";
export const FAILED = "failed authentication-failed";
export const REJECTION = "failed captcha-rejected";
export const INTERRUPTED = "signal:login-dialog-interrupted";
