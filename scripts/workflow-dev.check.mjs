import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createDevelopmentBrowserPort,
  createTerminalHumanAssistancePort,
} from "./workflow-dev.ts";

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
});

test("workflow development CLI lists only typed definitions enabled by the App", () => {
  const result = invoke("list");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").sort(), [
    "ctbc-statements",
    "einvoice-personal-invoices",
    "esun-credit-card-statements",
    "linebank-statements",
  ]);
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

test("terminal human assistance waits for the developer without printing the contract title", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let prompt = "";
  output.on("data", (chunk) => { prompt += chunk.toString("utf8"); });
  const port = createTerminalHumanAssistancePort(new AbortController().signal, input, output);
  const request = port.request({
    title: "private synthetic title",
    challengeKind: "text-captcha",
    targets: [{ id: "code", label: "private synthetic target", modes: ["type"] }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.write("\n");
  assert.equal(await request, "entered");
  assert.match(prompt, /text-captcha; 1 target/u);
  assert.doesNotMatch(prompt, /private synthetic/u);
});

test("terminal human assistance stops when the development run is cancelled", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const port = createTerminalHumanAssistancePort(controller.signal, input, output);
  const request = port.request({ challengeKind: "checkbox", targets: [{}] });
  controller.abort();
  assert.equal(await request, "failed");
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
  const port = createDevelopmentBrowserPort(new AbortController().signal, "http://127.0.0.1:4173", async () => browser);
  const received = await port.withPage(async (receivedPage) => receivedPage);
  assert.equal(received, page);
  assert.deepEqual(calls, [
    ["context", { acceptDownloads: false, locale: "zh-TW" }],
    ["goto", "http://127.0.0.1:4173"],
    ["close"],
  ]);
});
