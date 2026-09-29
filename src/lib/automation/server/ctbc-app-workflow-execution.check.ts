import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Page, Response } from "playwright";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type { WorkflowBrowserPort, WorkflowFinancialCommitPort } from "../workflow-executor.ts";
import { taskById } from "./tasks.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { workflowBrowserProfileForTask, workflowInputForTask, workflowStartUrlForTask } from "./app-workflow-registry.ts";

const LOGIN_URL = "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010";
const RESOURCE_URL = "https://www.ctbcbank.com/IB/api/adapters/IB_Adapter/resource/ebmwResource";
const accountId = ["0000", "3145", "4055", "4100"].join("");
const bootstrapResource = "/twrbc-deposit/qu002/010";
const detailsResource = "/twrbc-deposit/qu002/011";
const syntheticEnvironment = () => ({
  [["LIBRETTO", "CLOUD", "CTBC", "USER", "ID"].join("_")]: "synthetic-user-id",
  [["LIBRETTO", "CLOUD", "CTBC", "ACCOUNT"].join("_")]: "synthetic-account",
  [["LIBRETTO", "CLOUD", "CTBC", "PASSWORD"].join("_")]: "synthetic-password",
});

function sourceResponse(resource: string, value: unknown): Response {
  const postData = JSON.stringify({ resource });
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    url: () => RESOURCE_URL,
    status: () => 200,
    request: () => ({
      method: () => "POST",
      url: () => RESOURCE_URL,
      postData: () => postData,
    }),
    body: async () => bytes,
  } as unknown as Response;
}

function createPage(options: {
  expectedRanges?: number;
  signedIn?: boolean;
  onPoll?: () => Promise<void>;
  malformedSource?: boolean;
} = {}) {
  const ranges = options.expectedRanges === 2
    ? [
        { firstDateYYYYMMDD: "20260801", lastDateYYYYMMDD: "20260815" },
        { firstDateYYYYMMDD: "20260816", lastDateYYYYMMDD: "20260831" },
      ]
    : [{ firstDateYYYYMMDD: "20260801", lastDateYYYYMMDD: "20260831" }];
  const responses = [
    sourceResponse(bootstrapResource, {
      code: "0000",
      rsData: { accountInfoList: [{ accountId }], dateRanges: ranges },
    }),
    options.malformedSource
      ? {
          ...sourceResponse(detailsResource, {}),
          body: async () => Buffer.from([0xc3, 0x28]),
        } as Response
      : sourceResponse(detailsResource, {
          code: "0000",
          rsData: { detailList: [], nextKey: "" },
        }),
  ];
  const credentialValues = new Map<string, string>();
  let signedIn = options.signedIn ?? false;
  let loginPolls = 0;
  const locator = (selector: string, index = 0) => ({
    first() { return locator(selector, 0); },
    last() { return locator(selector, 0); },
    nth(value: number) { return locator(selector, value); },
    filter() { return this; },
    isVisible: async () => selector === "form input[type=text]"
      || (selector === "#btnHeaderLogout" && signedIn),
    waitFor: async () => undefined,
    count: async () => selector === "a.nav-link" ? 1 : 0,
    textContent: async () => selector === "a.nav-link" ? "2026/08" : "帳戶餘額 0000314540554100",
    click: async () => undefined,
    fill: async (value: string) => { credentialValues.set(`${selector}#${index}`, value); },
    boundingBox: async () => ({ x: 1, y: 1, width: 640, height: 480 }),
  });
  return {
    page: Object.assign({
      on: () => undefined,
      off: () => undefined,
      locator: (selector: string) => locator(selector),
      keyboard: { press: async () => undefined },
      goto: async () => undefined,
      waitForURL: async () => undefined,
      waitForTimeout: async () => {
        await options.onPoll?.();
        loginPolls += 1;
        if (loginPolls >= 20) signedIn = true;
      },
      waitForResponse: async (predicate: (candidate: Response) => boolean) => {
        const index = responses.findIndex(predicate);
        if (index < 0) throw new Error("No synthetic CTBC App response matched.");
        return responses.splice(index, 1)[0]!;
      },
      getByText: () => {
        const textLocator = {
          first() { return textLocator; },
          click: async () => undefined,
          isVisible: async () => false,
        };
        return textLocator;
      },
      getByRole: () => ({ click: async () => undefined, waitFor: async () => undefined }),
      url: () => LOGIN_URL,
    }, { setSignedIn(value: boolean) { signedIn = value; } }) as unknown as Page & {
      setSignedIn(value: boolean): void;
    },
    credential(selector: string, index = 0) {
      return credentialValues.get(`${selector}#${index}`) ?? "";
    },
    finishSignIn() { signedIn = true; },
  };
}

async function createRun(
  provider: ReturnType<typeof createPgliteOperationalProvider>,
) {
  const created = await provider.automation.createTaskRun({
    taskId: "ctbc-statements",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  return created.taskRunId;
}

function createCommitPort(committed: unknown[][]): WorkflowFinancialCommitPort {
  return {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      committed.push(received);
      return {
        status: "completed",
        items: received.map((item) => ({
          itemKey: item.itemKey,
          provider: item.provider,
          product: item.product,
          status: "committed",
          admissionSummaries: [],
          value: {},
          relationWarnings: [],
        })),
        diagnostics: [],
        committedCount: received.length,
        failedCount: 0,
      } as never;
    },
  };
}

test("CTBC App task maps credentials and reaches Canonical Financial Commit with typed events", async () => {
  const task = taskById("ctbc-statements");
  assert.ok(task);
  assert.equal(task.workflowId, "ctbc-statements");
  assert.equal(Object.hasOwn(task, "script"), false);
  assert.equal(Object.hasOwn(task, "command"), false);
  assert.equal(workflowStartUrlForTask(task.workflowId), LOGIN_URL);
  assert.equal(workflowBrowserProfileForTask(task.workflowId), "ctbc-login");
  assert.deepEqual(workflowInputForTask(task.workflowId, syntheticEnvironment()), {
    credentials: {
      ctbc_user_id: "synthetic-user-id",
      ctbc_account: "synthetic-account",
      ctbc_password: "synthetic-password",
    },
  });

  const root = await mkdtemp(join(tmpdir(), "ctbc-app-workflow-"));
  const previousDirectory = process.cwd();
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const app = createPage();
  const committed: unknown[][] = [];
  const financialCommit = createCommitPort(committed);
  let observedStartUrl: string | undefined;
  let observedBrowserProfile: string | undefined;
  try {
    process.chdir(root);
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider);
    const browser: WorkflowBrowserPort = {
      async withPage(run) {
        return run(app.page);
      },
    };
    const result = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: {
        financialCommit,
        now: () => "2026-09-25T12:00:00.000Z",
        humanAssistance: {
          async request(contract) {
            assert.fail("A delayed CTBC login must not become human assistance.");
          },
        },
      },
      workflowBrowserPortFactory: ({ startUrl, browserProfile }) => {
        observedStartUrl = startUrl;
        observedBrowserProfile = browserProfile;
        return browser;
      },
    }, async () => {});

    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(result.status, "completed");
    assert.ok(result.result);
    assert.equal(result.result.appWorkflowOutcome?.errorCode, null);
    assert.deepEqual(
      Object.keys(result.result.appWorkflowOutcome?.summary?.counts ?? {}).sort(),
      ["count", "rowCount", "sourceCaptureCount"],
    );
    assert.equal(observedStartUrl, LOGIN_URL);
    assert.equal(observedBrowserProfile, "ctbc-login");
    assert.equal(app.credential("form input[type=text]"), "synthetic-user-id");
    assert.equal(app.credential("form input[type=password]", 0), "synthetic-account");
    assert.equal(app.credential("form input[type=password]", 1), "synthetic-password");
    assert.equal(committed.length, 1);
    assert.equal((committed[0]?.[0] as { provider?: string }).provider, "ctbc");
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.appWorkflowOutcome, result.result.appWorkflowOutcome);
    assert.equal(Object.hasOwn(run ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(run ?? {}, "logTail"), false);
    assert.ok(!run?.events.some((event) => event.code === "human-assistance-requested"));
    assert.ok(run?.events.some((event) => event.code === "canonical-admission-completed"));
    assert.ok(run?.events.some((event) => event.code === "canonical-commit-completed"));
    assert.deepEqual(await readdir(root), [], "typed App dispatch writes no statement files or logs");

    const incompletePage = createPage({ expectedRanges: 2, signedIn: true });
    const incompleteBrowser: WorkflowBrowserPort = {
      async withPage(runPage) {
        return runPage(incompletePage.page);
      },
    };
    const incompleteRunId = await createRun(provider);
    const incomplete = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: incompleteRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: () => incompleteBrowser,
    }, async () => {});
    assert.equal(incomplete.status, "failed");
    assert.ok(incomplete.result);
    assert.equal(incomplete.result.appWorkflowOutcome?.errorCode, "source-validation-failed");
    assert.equal(committed.length, 1, "incomplete CTBC source is rejected before commit");
    const rejectedRun = await provider.automation.taskRunById(incompleteRunId);
    assert.equal(rejectedRun?.appWorkflowOutcome?.errorCode, "source-validation-failed");
    assert.ok(rejectedRun?.events.some((event) => event.code === "source-validation-rejected"));

    const malformedPage = createPage({ malformedSource: true, signedIn: true });
    const malformedBrowser: WorkflowBrowserPort = {
      async withPage(runPage) {
        return runPage(malformedPage.page);
      },
    };
    const malformedRunId = await createRun(provider);
    const malformed = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: malformedRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: { financialCommit },
      workflowBrowserPortFactory: () => malformedBrowser,
    }, async () => {});
    assert.equal(malformed.status, "failed");
    assert.ok(malformed.result);
    assert.equal(malformed.result.appWorkflowOutcome?.errorCode, "source-integrity-failed");
    assert.equal(committed.length, 1, "undecodable CTBC source is rejected before commit");
    const malformedRun = await provider.automation.taskRunById(malformedRunId);
    assert.equal(malformedRun?.appWorkflowOutcome?.errorCode, "source-integrity-failed");
    assert.ok(malformedRun?.events.some((event) => event.code === "source-decoding-failed"));

    let cancellationRequested = false;
    const cancellationPage = createPage({ onPoll: async () => {
      cancellationRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 75));
    } });
    const cancellationBrowser: WorkflowBrowserPort = {
      async withPage(runPage) {
        return runPage(cancellationPage.page);
      },
    };
    const cancellationRunId = await createRun(provider);
    const cancelled = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: cancellationRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      isCancellationRequested: () => cancellationRequested,
      workflowPorts: {
        financialCommit,
        now: () => "2026-09-25T12:00:00.000Z",
        humanAssistance: {
          async request(contract) {
            assert.fail("Cancellation during normal login must not request human assistance.");
          },
        },
      },
      workflowBrowserPortFactory: () => cancellationBrowser,
    }, async () => {});
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.result);
    assert.equal(cancelled.result.appWorkflowOutcome?.errorCode, "cancelled");
    assert.equal((await provider.automation.taskRunById(cancellationRunId))?.appWorkflowOutcome?.errorCode, "cancelled");
    assert.equal(committed.length, 1, "cancelled CTBC run does not commit");
    assert.deepEqual(await readdir(root), []);

    const ambiguousPage = createPage({ signedIn: true });
    const ambiguousBrowser: WorkflowBrowserPort = {
      async withPage(runPage) {
        return runPage(ambiguousPage.page);
      },
    };
    let commitAttempts = 0;
    const ambiguousRunId = await createRun(provider);
    const ambiguous = await runAutomationTaskExecution(task, provider.automation, {
      taskRunId: ambiguousRunId,
      launchEnv: { ...syntheticEnvironment(), OCTOPUSBEAK_USER_DATA: root },
      workflowPorts: {
        financialCommit: {
          async execute() {
            commitAttempts += 1;
            throw new Error("synthetic transport loss after commit dispatch");
          },
        },
      },
      workflowBrowserPortFactory: () => ambiguousBrowser,
    }, async () => {});
    assert.equal(ambiguous.status, "failed");
    assert.ok(ambiguous.result);
    assert.equal(ambiguous.result.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
    assert.equal(commitAttempts, 1, "an ambiguous commit is not replayed by task execution");
    assert.equal((await provider.automation.taskRunById(ambiguousRunId))?.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
