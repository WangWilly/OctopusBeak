import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserRuntime,
  type BrowserRuntime,
  type BrowserRuntimeProfileId,
} from "../src/lib/automation/server/browser-runtime.ts";
import {
  createWorkflowExecutor,
  type WorkflowDefinition,
  type WorkflowExecutorPorts,
  type WorkflowFinancialCommitPort,
  type WorkflowRunEvent,
} from "../src/lib/automation/workflow-executor.ts";
import { strictSourceText } from "../src/lib/automation/source-text.ts";
import {
  APP_WORKFLOW_DEFINITIONS,
  workflowBrowserProfileForTask,
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowStartUrlForTask,
} from "../src/lib/automation/server/app-workflow-registry.ts";
import type { PGliteWorkflowRunItem } from "../src/ledger/pglite/workflow-run.ts";
import { registerAppWorkflowPage } from "../src/lib/automation/server/app-browser-host.ts";
import {
  WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS,
  appProviderPostSubmitProbe,
  appWorkflowRoutesVerification,
  routeVerificationActor,
  verificationConfidenceThreshold,
  verificationRoutingDependencies,
} from "../src/lib/automation/server/verification-routing.ts";
import { verificationPlanForContract } from "../src/lib/automation/server/verification-solver.ts";
import { readAutomationSettingsFile } from "../src/lib/automation/server/config-files.ts";
import {
  createHumanAssistanceContract,
  type HumanAssistanceCompletionStatus,
} from "../src/lib/automation/human-assistance.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const AUTOMATION_ROOT = resolve(ROOT, "src", "lib", "automation");
const SAFE_WORKFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/u;

export class WorkflowDevCliError extends Error {
  readonly code: "usage" | "module-invalid" | "input-invalid" | "live-source-confirmation-required" | "unsupported-persistence";

  constructor(code: WorkflowDevCliError["code"]) {
    super(code);
    this.name = "WorkflowDevCliError";
    this.code = code;
  }
}

function fail(code: ConstructorParameters<typeof WorkflowDevCliError>[0]): never {
  throw new WorkflowDevCliError(code);
}

function helpText() {
  return [
    "Project workflow development CLI (WorkflowDefinition; development only)",
    "",
    "  npm run workflow:dev -- list",
    "  npm run workflow:dev -- validate <module.ts> <exportName> [--input-env JSON_ENV_NAME]",
    "  npm run workflow:dev -- fixture",
    "  npm run workflow:dev -- inspect <url> [--headless] [--browser-profile PROFILE] [--allow-live-source]",
    "  npm run workflow:dev -- run <module.ts> <exportName> --input-env JSON_ENV_NAME [--start-url URL] [--headless] [--browser-profile PROFILE] --allow-live-source",
    "  npm run workflow:dev -- run-app <workflow-id> [--headless] [--browser-profile PROFILE] --allow-live-source",
    "",
    "Production collection starts in the desktop App. CLI runs use an ephemeral browser and a dry-run financial commit port; they never write to the financial database or save workflow files.",
  ].join("\n");
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function loadDefinition(modulePath: string, exportName: string): Promise<WorkflowDefinition> {
  if (!modulePath || !exportName || !/^[A-Za-z_$][\w$]*$/u.test(exportName)) fail("module-invalid");
  const target = await realpath(resolve(ROOT, modulePath)).catch(() => null);
  if (!target || !within(AUTOMATION_ROOT, target) || !target.endsWith(".ts")) fail("module-invalid");
  try {
    const module = await import(pathToFileURL(target).href) as Record<string, unknown>;
    const candidate = module[exportName];
    if (!candidate || typeof candidate !== "object") fail("module-invalid");
    const definition = candidate as Partial<WorkflowDefinition>;
    if (!definition.id || !SAFE_WORKFLOW_ID.test(definition.id)
      || typeof definition.requiresFinancialCommit !== "boolean"
      || typeof definition.run !== "function") fail("module-invalid");
    return definition as WorkflowDefinition;
  } catch (error) {
    if (error instanceof WorkflowDevCliError) throw error;
    fail("module-invalid");
  }
}

function jsonInputFromEnvironment(name: string | undefined): unknown {
  if (!name) fail("input-invalid");
  const serialized = process.env[name];
  if (!serialized) fail("input-invalid");
  try {
    return JSON.parse(serialized);
  } catch {
    fail("input-invalid");
  }
}

function safeUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") fail("usage");
    if (url.username || url.password) fail("usage");
    return url.href;
  } catch (error) {
    if (error instanceof WorkflowDevCliError) throw error;
    fail("usage");
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail("usage");
  return value;
}

function hasFlag(args: readonly string[], flag: string) {
  return args.includes(flag);
}

function validateFlags(args: readonly string[], allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowedSet.has(flag) || seen.has(flag)) fail("usage");
    seen.add(flag);
    if (flag === "--input-env" || flag === "--start-url" || flag === "--browser-profile") {
      if (!args[index + 1] || args[index + 1]?.startsWith("--")) fail("usage");
      index += 1;
    }
  }
}

function printEvent(event: WorkflowRunEvent) {
  const count = event.completed === undefined
    ? ""
    : ` ${event.completed}${event.total === undefined ? "" : `/${event.total}`}`;
  stdout.write(`event ${event.stage}/${event.code}${count}\n`);
}

export function createDryRunFinancialCommitPort(
  onItems: (count: number) => void = () => {},
): WorkflowFinancialCommitPort {
  return {
    async execute(items, options) {
      options?.signal?.throwIfAborted();
      const observed: PGliteWorkflowRunItem[] = [];
      for await (const item of items) {
        options?.signal?.throwIfAborted();
        observed.push(item);
      }
      onItems(observed.length);
      return {
        status: "completed",
        items: observed.map((item, index) => ({
          itemKey: item.itemKey,
          provider: item.provider,
          product: item.product,
          status: "committed" as const,
          admissionSummaries: [{ captureId: `dry-run-${index + 1}`, commitSequence: index + 1 }],
          value: { dryRun: true },
          relationWarnings: [],
        })),
        diagnostics: [],
        committedCount: observed.length,
        failedCount: 0,
      };
    },
  };
}

export function createDevelopmentBrowserPort(
  signal: AbortSignal,
  startUrl?: string,
  launch: (options: Readonly<{ headless: boolean; args: string[] }>) => Promise<Browser> = (options) =>
    chromium.launch(options),
  options: Readonly<{
    headless?: boolean;
    profile?: BrowserRuntimeProfileId;
    runtime?: BrowserRuntime;
    /** Registers the page where the App's solver seams resolve it. */
    sessionKey?: string;
  }> = {},
): WorkflowExecutorPorts["browser"] {
  const runtime = options.runtime ?? browserRuntime;
  return {
    async withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const profile = await runtime.resolve(options.profile);
      const browser = await launch({
        headless: options.headless ?? false,
        args: [...profile.args],
      });
      const closeOnAbort = () => { void browser.close().catch(() => {}); };
      let unregister = () => {};
      signal.addEventListener("abort", closeOnAbort, { once: true });
      try {
        signal.throwIfAborted();
        const context = await browser.newContext({
          acceptDownloads: false,
          locale: "zh-TW",
          userAgent: profile.userAgent,
        });
        const page = await context.newPage();
        if (options.sessionKey) unregister = registerAppWorkflowPage(options.sessionKey, page);
        if (startUrl) {
          await page.goto(startUrl, { waitUntil: "domcontentloaded" });
          signal.throwIfAborted();
        }
        return await run(page);
      } finally {
        unregister();
        signal.removeEventListener("abort", closeOnAbort);
        await browser.close().catch(() => {});
      }
    },
  };
}

type LocalSolverRoute = Readonly<{
  route?: typeof routeVerificationActor;
  dependencies?: typeof verificationRoutingDependencies;
}>;

/**
 * Verify through the App's local solver route against the development browser
 * page registered under `sessionKey`. Like the App, the request settles when
 * the solver resumes the workflow and fails closed for any stage the App would
 * not route.
 */
export function createLocalSolverHumanAssistancePort(
  signal: AbortSignal,
  options: Readonly<{ workflowId: string; sessionKey: string }> & LocalSolverRoute,
): WorkflowExecutorPorts["humanAssistance"] {
  const route = options.route ?? routeVerificationActor;
  const dependencies = options.dependencies ?? verificationRoutingDependencies;
  let version = 0;
  return {
    async request(input, requestSignal) {
      signal.throwIfAborted();
      requestSignal.throwIfAborted();
      version += 1;
      const contract = createHumanAssistanceContract(input, version);
      const plan = verificationPlanForContract(contract).kind;
      if (
        !appWorkflowRoutesVerification(options.workflowId)
        || (plan !== "solve" && plan !== "click")
      ) {
        throw new Error("App workflow solver route is unavailable for this verification stage.");
      }
      const completed: Exclude<HumanAssistanceCompletionStatus, "pending"> =
        contract.completion.mode === "independent" ? "verified" : "entered";
      return await new Promise((resolve, reject) => {
        let resumed = false;
        const onAbort = () => reject(requestSignal.reason);
        requestSignal.addEventListener("abort", onAbort, { once: true });
        void route({
          contract,
          taskRunId: options.sessionKey,
          confidenceThreshold: verificationConfidenceThreshold(contract, readAutomationSettingsFile()),
          dependencies: dependencies(contract, {
            resumeAppWorkflow: () => {
              resumed = true;
              resolve(completed);
            },
            finalizeFailed: (message) => { throw new Error(message); },
            providerProbePostSubmit: WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS.has(options.workflowId)
              ? async (_session, _contract, resume) => { await resume(); return "none"; }
              : appProviderPostSubmitProbe(),
          }),
        }).then(
          (outcome) => outcome.kind === "resumed" ? undefined : outcome.kind,
          () => "failed",
        ).then((failure) => {
          requestSignal.removeEventListener("abort", onAbort);
          if (!failure) return;
          // The App would start a new CAPTCHA round here; the CLI reports and stops.
          if (resumed) stdout.write(`verification route ended with ${failure} after resume\n`);
          else reject(new Error(`Verification route ended with ${failure}.`));
        });
      });
    },
  };
}

function makePorts(
  signal: AbortSignal,
  workflowId: string,
  startUrl?: string,
  commitPort?: WorkflowFinancialCommitPort,
  browserOptions: Readonly<{ headless?: boolean; profile?: BrowserRuntimeProfileId }> = {},
): WorkflowExecutorPorts {
  const sessionKey = randomUUID();
  return {
    browser: createDevelopmentBrowserPort(signal, startUrl, undefined, { ...browserOptions, sessionKey }),
    text: strictSourceText,
    humanAssistance: createLocalSolverHumanAssistancePort(signal, { workflowId, sessionKey }),
    ...(commitPort ? { financialCommit: commitPort } : {}),
    events: { append: async (event) => printEvent(event) },
    now: () => new Date().toISOString(),
  };
}

const fixtureDefinition: WorkflowDefinition = {
  id: "workflow-dev-fixture",
  requiresFinancialCommit: true,
  async run(context) {
    const source = await context.browser.withPage(async (page) => {
      const fakePage = page as unknown as { locator(selector: string): { innerText(): Promise<string> } };
      return await fakePage.locator("main").innerText();
    });
    const decoded = context.text.decode(new TextEncoder().encode(source), "utf-8");
    context.text.assertIntact(decoded);
    const rows = decoded.trim().split("\n");
    if (rows.length !== 2 || rows.some((row) => row.length === 0)) throw new Error("Fixture source incomplete.");
    await context.event("collection", "fixture-source-read", { completed: rows.length, total: rows.length });
    const financialCommit = context.financialCommit;
    if (!financialCommit) throw new Error("Dry-run financial commit is unavailable.");
    const items = rows.map((row, index) => ({
      provider: "fixture",
      product: "sample",
      itemKey: `fixture-${index + 1}`,
      command: { kind: "development-fixture", request: { row } },
    })) as unknown as PGliteWorkflowRunItem[];
    const result = await financialCommit.execute(items, { signal: context.signal });
    if (result.status !== "completed" || result.items.length !== rows.length) throw new Error("Fixture dry-run failed.");
    return { rows: rows.length };
  },
};

async function runFixture() {
  const events: WorkflowRunEvent[] = [];
  let dryRunCount = 0;
  const page = {
    locator(selector: string) {
      if (selector !== "main") throw new Error("Fixture selector missing.");
      return { innerText: async () => "fixture-row-1\nfixture-row-2" };
    },
  } as unknown as Page;
  const executor = createWorkflowExecutor([fixtureDefinition], {
    browser: { withPage: async (run) => await run(page) },
    text: strictSourceText,
    humanAssistance: { request: async () => "entered" },
    financialCommit: createDryRunFinancialCommitPort((count) => { dryRunCount = count; }),
    events: { append: async (event) => { events.push(event); } },
    now: () => "2026-09-25T00:00:00.000Z",
  });
  const result = await executor.run(
    fixtureDefinition.id,
    randomUUID(),
    undefined,
    new AbortController().signal,
  ) as { rows: number };
  return { result, events, dryRunCount };
}

async function inspect(
  url: string,
  allowLiveSource: boolean,
  signal: AbortSignal,
  browserOptions: Readonly<{ headless?: boolean; profile?: BrowserRuntimeProfileId }> = {},
) {
  const normalized = safeUrl(url);
  if (!normalized) fail("usage");
  const host = new URL(normalized).hostname;
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!isLoopback && !allowLiveSource) fail("live-source-confirmation-required");
  const port = createDevelopmentBrowserPort(signal, normalized, undefined, browserOptions);
  await port.withPage(async () => {
    stdout.write("Page is open in the ephemeral development browser. Press Enter to close it.\n");
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      await readline.question("> ", { signal });
    } finally {
      readline.close();
    }
  });
}

function abortOnInterrupt() {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  return {
    controller,
    dispose() { process.removeListener("SIGINT", onInterrupt); },
  };
}

async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${helpText()}\n`);
    return;
  }
  if (command === "list") {
    if (rest.length) fail("usage");
    for (const definition of APP_WORKFLOW_DEFINITIONS) stdout.write(`${definition.id}\n`);
    return;
  }
  if (command === "validate") {
    const [modulePath, exportName, ...flags] = rest;
    validateFlags(flags, ["--input-env"]);
    const definition = await loadDefinition(modulePath ?? "", exportName ?? "");
    const inputEnvironment = flagValue(flags, "--input-env");
    if (inputEnvironment) jsonInputFromEnvironment(inputEnvironment);
    stdout.write(`valid WorkflowDefinition: ${definition.id}; financialCommit=${definition.requiresFinancialCommit ? "required" : "not-required"}\n`);
    return;
  }
  if (command === "fixture") {
    if (rest.length) fail("usage");
    const { result, events, dryRunCount } = await runFixture();
    for (const event of events) printEvent(event);
    stdout.write(`fixture completed; source rows=${result.rows}; dry-run financial items=${dryRunCount}; database writes=0; files=0\n`);
    return;
  }
  if (command === "inspect") {
    const [url, ...flags] = rest;
    validateFlags(flags, ["--allow-live-source", "--headless", "--browser-profile"]);
    const interrupt = abortOnInterrupt();
    try {
      await inspect(url ?? "", hasFlag(flags, "--allow-live-source"), interrupt.controller.signal, {
        headless: hasFlag(flags, "--headless"),
        profile: flagValue(flags, "--browser-profile") as BrowserRuntimeProfileId | undefined,
      });
    } finally {
      interrupt.dispose();
    }
    return;
  }
  if (command === "run" || command === "run-app") {
    const modulePath = command === "run" ? rest[0] : undefined;
    const exportName = command === "run" ? rest[1] : undefined;
    const workflowId = command === "run-app" ? rest[0] : undefined;
    const flags = rest.slice(command === "run" ? 2 : 1);
    validateFlags(flags, ["--input-env", "--start-url", "--allow-live-source", "--headless", "--browser-profile"]);
    if (!hasFlag(flags, "--allow-live-source")) fail("live-source-confirmation-required");
    let definition: WorkflowDefinition | null;
    let input: unknown;
    let startUrl = safeUrl(flagValue(flags, "--start-url"));
    let browserProfile = flagValue(flags, "--browser-profile") as BrowserRuntimeProfileId | undefined;
    if (command === "run-app") {
      if (!workflowId || !SAFE_WORKFLOW_ID.test(workflowId)) fail("usage");
      definition = workflowDefinitionForTask(workflowId);
      input = workflowInputForTask(workflowId, process.env);
      startUrl = safeUrl(startUrl ?? workflowStartUrlForTask(workflowId));
      browserProfile ??= workflowBrowserProfileForTask(workflowId);
    } else {
      definition = await loadDefinition(modulePath ?? "", exportName ?? "");
      input = jsonInputFromEnvironment(flagValue(flags, "--input-env"));
    }
    if (!definition || input === undefined) fail("module-invalid");
    if (definition.requiresMaicoinPersistence) fail("unsupported-persistence");

    const interrupt = abortOnInterrupt();
    let dryRunCount = 0;
    const commitPort = definition.requiresFinancialCommit
      ? createDryRunFinancialCommitPort((count) => { dryRunCount = count; })
      : undefined;
    const executor = createWorkflowExecutor([definition], makePorts(
      interrupt.controller.signal,
      definition.id,
      startUrl,
      commitPort,
      { headless: hasFlag(flags, "--headless"), profile: browserProfile },
    ));
    try {
      await executor.run(definition.id, randomUUID(), input, interrupt.controller.signal);
      stdout.write(`workflow completed; canonical financial dry-run items=${dryRunCount}; database writes=0; files=0\n`);
    } finally {
      interrupt.dispose();
    }
    return;
  }
  fail("usage");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const code = error instanceof WorkflowDevCliError
      ? error.code
      : "workflow-run-failed";
    process.stderr.write(`workflow development failed: ${code}; source details were suppressed\n`);
    process.exitCode = 1;
  });
}
