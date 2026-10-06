import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createDevelopmentBrowserPort,
  createLocalSolverHumanAssistancePort,
} from "./workflow-dev.ts";
import { createBrowserRuntime } from "../src/lib/automation/server/browser-runtime.ts";
import { appWorkflowPageForSession } from "../src/lib/automation/server/app-browser-host.ts";
import { APP_WORKFLOW_DEFINITIONS } from "../src/lib/automation/server/app-workflow-registry.ts";

const cli = fileURLToPath(new URL("./workflow-dev.ts", import.meta.url));

function invoke(...args) {
  return spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    cli,
    ...args,
  ], { encoding: "utf8" });
}

function invokeWithEnv(env, ...args) {
  return spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    cli,
    ...args,
  ], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("workflow development CLI explains the project-owned typed interface", () => {
  const result = invoke("help");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workflow:dev -- (?:list|validate|fixture|inspect|run)/u);
  assert.match(result.stdout, /WorkflowDefinition/u);
  assert.match(result.stdout, /dry-run/u);
  assert.match(result.stdout, /production/iu);
  assert.match(result.stdout, /--headless/u);
  assert.match(result.stdout, /--browser-profile PROFILE/u);
});

test("workflow development CLI lists only typed definitions enabled by the App", () => {
  const result = invoke("list");
  assert.equal(result.status, 0, result.stderr);
  const listedIds = result.stdout.trim().split("\n").filter(Boolean).sort();
  const appCatalogIds = APP_WORKFLOW_DEFINITIONS.map(({ id }) => id).sort();
  assert.deepEqual(listedIds, appCatalogIds);
});

test("workflow development CLI validates a provider definition export", () => {
  const result = invoke(
    "validate",
    "src/lib/automation/linebank-workflow.ts",
    "linebankStatementsWorkflow",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid WorkflowDefinition: linebank-statements; financialCommit=required/u);
});

test("workflow development CLI refuses definition imports outside its automation module root", () => {
  const result = invoke("validate", "package.json", "default");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workflow development failed: module-invalid/u);
  assert.doesNotMatch(result.stderr, /octopus-beak|0\.6\.12/u);
});

test("workflow development CLI requires an explicit opt-in before opening a remote source", () => {
  const inspect = invoke("inspect", "https://example.com");
  assert.notEqual(inspect.status, 0);
  assert.match(inspect.stderr, /live-source-confirmation-required/u);

  const run = invoke("run", "src/lib/automation/linebank-workflow.ts", "linebankStatementsWorkflow", "--input-env", "WORKFLOW_DEV_INPUT_JSON");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /live-source-confirmation-required/u);
});

test("workflow development CLI parses input from an environment variable without echoing it", () => {
  const secretFixture = "synthetic-sensitive-input";
  const result = invokeWithEnv({ WORKFLOW_DEV_INPUT_JSON: `{${secretFixture}}` },
    "validate",
    "src/lib/automation/linebank-workflow.ts",
    "linebankStatementsWorkflow",
    "--input-env",
    "WORKFLOW_DEV_INPUT_JSON",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /input-invalid/u);
  assert.doesNotMatch(result.stderr, new RegExp(secretFixture, "u"));
});

test("fixture command exercises injected browser, strict text, stage events and a file-free financial dry-run", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "workflow-dev-check-"));
  try {
    const result = invokeWithEnv({ TMPDIR: temporaryRoot }, "fixture");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /event collection\/fixture-source-read 2\/2/u);
    assert.match(result.stdout, /source rows=2; dry-run financial items=2; database writes=0; files=0/u);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

const rect = { x: 10, y: 20, width: 80, height: 24 };
const textCaptchaStage = Object.freeze({
  stageId: "synthetic-login-captcha",
  title: "Synthetic CAPTCHA",
  targets: [{ id: "code", label: "Code", semanticId: "synthetic.login.captcha-input", modes: ["type"], rect }],
  contextRegions: [],
  completion: { mode: "inline", targetIds: ["code"] },
  focus: { targetId: "code", contextRegionIds: [] },
  challengeKind: "text-captcha",
  challengeImageRegion: { id: "image", label: "Image", semanticId: "synthetic.login.captcha-image", rect },
});

function recordingRoute(outcome, { resume = true } = {}) {
  const calls = [];
  return {
    calls,
    async route(input) {
      calls.push(input);
      if (resume) await input.dependencies.resumeAppWorkflow();
      return outcome;
    },
  };
}

test("development verification runs the App solver route on the registered session", async () => {
  const { calls, route } = recordingRoute({ kind: "resumed" });
  const port = createLocalSolverHumanAssistancePort(new AbortController().signal, {
    workflowId: "sinopac-statements",
    sessionKey: "dev-session",
    route,
  });
  assert.equal(await port.request(textCaptchaStage, new AbortController().signal), "entered");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskRunId, "dev-session");
  assert.equal(calls[0].contract.version, 1);
  assert.equal(calls[0].contract.stageId, "synthetic-login-captcha");
  let probeResumed = false;
  assert.equal(
    await calls[0].dependencies.probePostSubmit("dev-session", calls[0].contract, async () => { probeResumed = true; }),
    "none",
  );
  assert.equal(probeResumed, true, "workflow-owned CAPTCHA outcomes resume without a provider dialog probe");
});

test("development verification fails closed where the App has no solver route", async () => {
  const { calls, route } = recordingRoute({ kind: "resumed" });
  const unrouted = createLocalSolverHumanAssistancePort(new AbortController().signal, {
    workflowId: "esun-credit-card-statements",
    sessionKey: "dev-session",
    route,
  });
  await assert.rejects(
    unrouted.request(textCaptchaStage, new AbortController().signal),
    /solver route is unavailable/u,
  );
  const routed = createLocalSolverHumanAssistancePort(new AbortController().signal, {
    workflowId: "yuanta-trade-statements",
    sessionKey: "dev-session",
    route,
  });
  const { challengeKind: _kind, challengeImageRegion: _region, ...nonSolverStage } = textCaptchaStage;
  await assert.rejects(
    routed.request({ ...nonSolverStage, stageId: "synthetic-certificate" }, new AbortController().signal),
    /solver route is unavailable/u,
  );
  assert.equal(calls.length, 0);
});

test("development verification rejects a route that ends before resuming the workflow", async () => {
  const { route } = recordingRoute({ kind: "retryable", reason: "solver-exhausted" }, { resume: false });
  const port = createLocalSolverHumanAssistancePort(new AbortController().signal, {
    workflowId: "fubon-all-statements",
    sessionKey: "dev-session",
    route,
  });
  await assert.rejects(
    port.request(textCaptchaStage, new AbortController().signal),
    /ended with retryable/u,
  );
});

test("development browser uses an ephemeral context and closes it after the workflow", async () => {
  const calls = [];
  const page = { goto: async (url) => { calls.push(["goto", url]); } };
  const browser = {
    newContext: async (options) => {
      calls.push(["context", options]);
      return { newPage: async () => page };
    },
    close: async () => { calls.push(["close"]); },
  };
  const runtime = createBrowserRuntime({
    getChromiumVersion: async () => "151.0.7922.34",
    platform: "darwin",
  });
  const port = createDevelopmentBrowserPort(
    new AbortController().signal,
    "http://127.0.0.1:4173",
    async (options) => { calls.push(["launch", options]); return browser; },
    { runtime },
  );
  const received = await port.withPage(async (receivedPage) => receivedPage);
  assert.equal(received, page);
  assert.deepEqual(calls, [
    ["launch", { headless: false, args: [] }],
    ["context", {
      acceptDownloads: false,
      locale: "zh-TW",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36",
    }],
    ["goto", "http://127.0.0.1:4173"],
    ["close"],
  ]);
});

test("development browser exposes its page to the solver seams only while the workflow runs", async () => {
  const page = { goto: async () => {} };
  const browser = {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {},
  };
  const runtime = createBrowserRuntime({
    getChromiumVersion: async () => "151.0.7922.34",
    platform: "darwin",
  });
  const port = createDevelopmentBrowserPort(
    new AbortController().signal,
    undefined,
    async () => browser,
    { runtime, sessionKey: "dev-session" },
  );
  const registered = await port.withPage(async () => appWorkflowPageForSession("dev-session"));
  assert.equal(registered, page);
  assert.equal(appWorkflowPageForSession("dev-session"), null);
});

test("development headless mode applies the same named runtime profile to launch and context", async () => {
  const runtime = createBrowserRuntime({
    getChromiumVersion: async () => "151.0.7922.34",
    platform: "darwin",
  });
  const launches = [];
  const contexts = [];
  const browser = {
    newContext: async (options) => {
      contexts.push(options);
      return { newPage: async () => ({}) };
    },
    close: async () => {},
  };
  const port = createDevelopmentBrowserPort(
    new AbortController().signal,
    undefined,
    async (options) => { launches.push(options); return browser; },
    { headless: true, profile: "ctbc-login", runtime },
  );

  await port.withPage(async () => undefined);
  assert.deepEqual(launches, [{
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  }]);
  assert.equal(contexts[0].userAgent, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36");
});
