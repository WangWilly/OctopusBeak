import assert from "node:assert/strict";
import test from "node:test";
import { buildAutomationPageModel } from "../src/lib/automation/server/page-model.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, AUTOMATION_TASKS } from "../src/lib/automation/server/tasks.ts";
import { acquireBrowserTestRuntime } from "./browser-test-runtime.mjs";
import { spendingDesktopApiInitScript } from "./spending-browser-harness.mjs";
import { createOnboardingState, ONBOARDING_STORAGE_KEY } from "../src/lib/onboarding/state.ts";

const sources = ["fubon", "cathay", "maicoin"];
const tasks = AUTOMATION_TASKS.filter((task) => sources.includes(task.credentialGroupId));
const taskId = (source) => tasks.find((task) => task.credentialGroupId === source).id;
const credentialGroups = AUTOMATION_CREDENTIAL_GROUPS.filter((group) => sources.includes(group.id)).map((group) => ({
  ...group, enabled: true, selectedStatementTypeIds: group.id === "cathay" ? [group.statementTypes[0].id] : [], storedCredentialFileNames: {}, invalidCredentialFileKeys: [],
}));
const automation = buildAutomationPageModel({
  tasks, latestRuns: {}, credentials: Object.fromEntries(tasks.flatMap((task) => task.credentialKeys.map((key) => [key, true]))),
  setupRequiredGroupIds: new Set(["fubon", "maicoin"]),
  active: false, businessDate: "2026-11-20",
});
const cathay = automation.tasks.find((task) => task.credentialGroupId === "cathay");
Object.assign(cathay, {
  status: "failed", latestRunStatus: "failed",
  appWorkflowOutcome: { errorCode: "device-registration-required", summary: null },
});

function installAutomation(model) {
  const api = window.octopusBeak.automation;
  api.loadBlock = async (block) => ({ route: "automation", block, data: { ...model, runtimeRevision: 0, runtimeSessionId: "fixture" } });
  api.deviceRegistrationStatus = async () => ({ registered: false });
  api.saveCredentials = async (updates) => {
    window.submittedDraft = updates.LIBRETTO_CLOUD_FUBON_ACCOUNT;
    return { saved: true };
  };
  let target = null;
  api.takeNotificationTarget = async () => {
    const next = target;
    target = null;
    return next;
  };
  api.onNotificationTargetRequested = (notify) => {
    window.showSourceSettings = (credentialGroupId) => {
      target = { route: "automation", credentialGroupId };
      notify();
    };
    return () => {};
  };
}

async function openAutomation(t, onboarding = null) {
  const runtime = await acquireBrowserTestRuntime();
  t.after(() => runtime.close());
  const page = await runtime.newPage(t);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(spendingDesktopApiInitScript({}) + `;(${installAutomation.toString()})(${JSON.stringify({ automation, credentialGroups })})`);
  if (onboarding) {
    await page.addInitScript(([key, state]) => localStorage.setItem(key, JSON.stringify(state)), [ONBOARDING_STORAGE_KEY, onboarding]);
  }
  await page.goto(runtime.url + "#/automation");
  return { page, errors };
}

test("source destinations focus the rendered section and retain staged sign-in details", async (t) => {
  const { page, errors } = await openAutomation(t);
  const focused = (id) => page.waitForFunction((id) => document.activeElement?.id === id, id);
  const configure = (source) => page.locator(`#${taskId(source)}-task-row .task-control`).first().click();
  const close = () => page.locator(".credential-modal .modal-close").click();

  await configure("maicoin");
  await focused("maicoin-credentials-title");
  await close();
  await page.locator(`#${taskId("cathay")}-task-row .device-registration-action`).first().click();
  await focused("cathay-device-title");
  await close();
  await configure("fubon");
  await focused("fubon-statement-selection");
  const field = page.locator("#credential-input-LIBRETTO_CLOUD_FUBON_ACCOUNT");
  await field.click();
  await field.fill("fixture-draft");
  await field.press("Enter");
  await page.evaluate(() => window.showSourceSettings("maicoin"));
  await focused("maicoin-credentials-title");
  await page.locator(".credential-modal button[type=submit]").click();
  await focused("fubon-statement-selection");
  assert.ok(await page.locator("#fubon-statement-error").textContent());
  await page.locator("#fubon-statement-selection input").first().check();
  await page.locator(".credential-modal button[type=submit]").click();
  await page.locator(".credential-modal").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.submittedDraft), "fixture-draft");
  assert.deepEqual(errors, []);
});

test("a notification waits for onboarding to release the source picker", async (t) => {
  const { page, errors } = await openAutomation(t, { ...createOnboardingState(null), storyNodeId: "source-selection" });
  await page.locator(".credential-modal .rail-row").first().waitFor();
  await page.evaluate(() => window.showSourceSettings("maicoin"));
  assert.equal(await page.locator(".credential-modal .credential-body").count(), 0);
  assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).storyNodeId, ONBOARDING_STORAGE_KEY), "source-selection");
  await page.locator(".coach-exit").click();
  await page.waitForFunction(() => document.activeElement?.id === "maicoin-credentials-title");
  assert.deepEqual(errors, []);
});

test("a notification waits for the save reply and page reload before opening the next source", async (t) => {
  const { page, errors } = await openAutomation(t);
  await page.locator(`#${taskId("fubon")}-task-row .task-control`).first().click();
  await page.locator("#fubon-statement-selection input").first().check();
  await page.evaluate(() => {
    const api = window.octopusBeak.automation;
    const loadBlock = api.loadBlock;
    api.saveCredentials = async () => {
      await new Promise((resolve) => { window.finishSave = resolve; });
      const reloaded = new Promise((resolve) => { window.finishReload = resolve; });
      api.loadBlock = async (...args) => {
        window.reloading = true;
        await reloaded;
        return loadBlock(...args);
      };
      return { saved: true };
    };
  });
  await page.locator(".credential-modal button[type=submit]").click();
  await page.waitForFunction(() => typeof window.finishSave === "function");
  await page.evaluate(() => window.showSourceSettings("maicoin"));
  assert.equal(await page.locator("#fubon-credentials-title").count(), 1);
  await page.evaluate(() => window.finishSave());
  await page.waitForFunction(() => window.reloading);
  assert.equal(await page.locator("#fubon-credentials-title").count(), 1);
  await page.evaluate(() => window.finishReload());
  await page.waitForFunction(() => document.activeElement?.id === "maicoin-credentials-title");
  assert.deepEqual(errors, []);
});
