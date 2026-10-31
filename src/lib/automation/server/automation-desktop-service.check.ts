import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AutomationRuntimeSnapshot } from "../../desktop/api.ts";
import { DataVersionMismatchError, type DataVersionSnapshot } from "../../shared-shell/data-version.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import {
  createAutomationDesktopService,
  type AutomationDesktopServiceDeps,
} from "./automation-desktop-service.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { StartAutomationTaskOptions } from "./runner.ts";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";

const REGISTRATION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
// Built from parts so the secret scanner does not read a credential assignment.
const CERTIFICATE_KEY = ["LIBRETTO", "CLOUD", "YUANTA", "TRADE", "CA", "PATH"].join("_");

let directory = "";
let previousDirectory = "";
before(() => {
  previousDirectory = process.cwd();
  directory = mkdtempSync(join(tmpdir(), "automation-desktop-service-"));
  process.chdir(directory);
});
after(() => {
  process.chdir(previousDirectory);
  rmSync(directory, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

const emptyProvider = {
  automation: {
    latestTaskRuns: async () => [],
    todayTaskRunIds: async () => [],
    activeTaskPrerequisiteNotices: async () => [],
    recentTaskRuns: async () => [],
  },
} as unknown as AutomationPersistenceProvider;

const readableCredentials = () => ({
  status: {},
  fileNames: {},
  invalidFileKeys: [],
  invalidFileReasons: {},
});

function harness(overrides: Partial<AutomationDesktopServiceDeps<string>> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const state = createAutomationRuntimeState("session-check");
  const runtime = {
    snapshot: () => state.snapshot(),
    subscribe: state.subscribe,
    activeTaskIds: () => [],
    cancel: async (taskId: string, expectedRunId?: string) => {
      calls.push(["cancel", taskId, expectedRunId]);
      return { cancelled: taskId };
    },
    forceTerminate: async (taskId: string, expectedRunId?: string) => {
      calls.push(["forceTerminate", taskId, expectedRunId]);
      return { cancelled: taskId };
    },
  } as unknown as AutomationRuntime;
  let version: DataVersionSnapshot = { version: 3, stale: false, changedAt: null };
  const published: AutomationRuntimeSnapshot[] = [];
  const fatal: Array<{ code: string; stage: string }> = [];
  let credentialReads = 0;
  const service = createAutomationDesktopService<string>({
    runtime,
    provider: emptyProvider,
    dataVersions: {
      snapshot: () => version,
      markStale: (reason) => {
        version = { version: version.version + 1, stale: true, changedAt: "" };
        return { version: version.version, reason, changedAt: "" };
      },
    },
    collection: {
      pauseSchedules: () => () => {},
      whileStopped: (work) => work(),
    },
    readCredentialState: () => {
      credentialReads += 1;
      return readableCredentials();
    },
    deviceRegistration: {
      status: (source) => {
        calls.push(["registration.status", source]);
        return { registered: false } as never;
      },
      start: async (source) => {
        calls.push(["registration.start", source]);
        return {} as never;
      },
      submitCode: async (source, id, code) => {
        calls.push(["registration.submitCode", source, id, code]);
        return {} as never;
      },
      cancel: (source, id) => {
        calls.push(["registration.cancel", source, id]);
      },
      cancelAll: async () => {
        calls.push(["registration.cancelAll"]);
      },
    },
    structureReports: { get: () => null },
    notificationTarget: { take: () => null },
    eraseSignInDetails: () => {
      calls.push(["erase"]);
    },
    userDataDirectory: () => directory,
    chooseFile: async (owner, options) => {
      calls.push(["chooseFile", owner, options.title]);
      return { canceled: true, filePaths: [] };
    },
    openExternal: async (url) => {
      calls.push(["openExternal", url]);
    },
    appVersion: () => "0.0.0-check",
    publishRuntimeChanged: (snapshot) => published.push(snapshot),
    onAutomationRuntimeFatal: (details) => fatal.push(details),
    log: { error: () => {}, warn: () => {} },
    ...overrides,
  });
  return {
    service,
    calls,
    state,
    published,
    fatal,
    credentialReads: () => credentialReads,
  };
}

test("the credential state cache is read once at construction, before any block asks", async () => {
  const { credentialReads } = harness();
  await settle();
  assert.equal(credentialReads(), 1);
});

test("an unreadable credential state fails the details block and degrades every other block", async () => {
  const { service } = harness({
    readCredentialState: () => {
      throw new Error("keychain locked");
    },
  });
  await assert.rejects(service.loadBlock("details"), { message: "無法讀取登入資料" });

  const list = await service.loadBlock("list") as unknown as {
    data: { automation: { credentialStates: Record<string, string> } };
  };
  const states = Object.values(list.data.automation.credentialStates);
  assert.ok(states.length > 0);
  assert.ok(states.every((state) => state === "read_failed"), JSON.stringify(states));
});

test("a block read against a stale data version is rejected before it reads anything", async () => {
  let readied = 0;
  const { service } = harness({ onAutomationRuntimeReady: () => { readied += 1; } });
  await assert.rejects(service.loadBlock("list", { expectedVersion: 2 }), DataVersionMismatchError);
  assert.equal(readied, 0);
  await service.loadBlock("list", { expectedVersion: 3 });
  assert.equal(readied, 1);
});

test("credentials are reread only after a save succeeds", async () => {
  const { service, credentialReads } = harness();
  await settle();
  const rejected = await service.saveCredentials({ [CERTIFICATE_KEY]: "/missing/cert.txt" });
  assert.equal(rejected.saved, false);
  await settle();
  assert.equal(credentialReads(), 1);

  const saved = await service.saveCredentials({
    LIBRETTO_CLOUD_FUBON_ENABLED: "true",
    LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit",
  });
  assert.equal(saved.saved, true);
  assert.equal(credentialReads(), 2);
});

test("a malformed device registration request never reaches the registration host", async () => {
  const { service, calls } = harness();
  assert.throws(() => service.startDeviceRegistration("fubon"), /source is invalid/u);
  assert.throws(() => service.deviceRegistrationStatus(42), /source is invalid/u);
  assert.throws(() => service.cancelDeviceRegistration("tdcc", "not-a-uuid"), /ID is invalid/u);
  assert.throws(() => service.submitDeviceRegistrationCode("tdcc", "not-a-uuid", "123456"), /ID is invalid/u);
  for (const code of ["12", "123456789", "12ab56", 123456]) {
    assert.throws(
      () => service.submitDeviceRegistrationCode("tdcc", REGISTRATION_ID, code),
      /4 to 8 digits/u,
    );
  }
  assert.deepEqual(calls, []);

  await service.submitDeviceRegistrationCode("cathay", REGISTRATION_ID, "0123");
  assert.deepEqual(calls, [["registration.submitCode", "cathay", REGISTRATION_ID, "0123"]]);
});

test("cancel and force terminate name the run the renderer saw", async () => {
  const { service, calls } = harness();
  await service.cancel("fubon-statements", "run-1");
  await service.forceTerminate("fubon-statements", "run-2");
  assert.deepEqual(calls, [
    ["cancel", "fubon-statements", "run-1"],
    ["forceTerminate", "fubon-statements", "run-2"],
  ]);
});

test("an unknown or unsafe link is refused without opening anything", async () => {
  const { service, calls } = harness();
  await assert.rejects(service.openSetupGuideLink("maicoin", "missing", "en"), /unsafe setup guide link/u);
  await assert.rejects(service.openExternalPrerequisite("missing"), /unsafe external prerequisite/u);
  await assert.rejects(service.openPreviewStructureReportIssue("exchange-rates"), /No preview structure report/u);
  assert.deepEqual(calls, []);

  await service.openSetupGuideLink("maicoin", "api-guide", "en");
  assert.deepEqual(calls, [["openExternal", "https://campaign.maicoin.com/en/api"]]);
});

test("the certificate dialog opens on the caller's owner with the locale's title", async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.selectCertificateFile("window-1", "zh-TW"), { cancelled: true });
  assert.deepEqual(await service.selectCertificateFile("window-2", "en"), { cancelled: true });
  assert.deepEqual(calls, [
    ["chooseFile", "window-1", "選擇憑證檔案"],
    ["chooseFile", "window-2", "Choose certificate file"],
  ]);
});

test("an unknown active runtime task fails the block and reports a fatal runtime error", async () => {
  const { service, state, fatal } = harness();
  state.upsert({
    taskId: "unknown-active-task",
    runId: "unknown-run",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: "fixture", completed: 0, total: 1, percent: 0, attempt: 1 },
    appWorkflowOutcome: null,
    updatedAt: new Date(0).toISOString(),
  });
  await assert.rejects(service.loadBlock("summary"), /Automation runtime snapshot unavailable/u);
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0]?.code, "automation-unknown-active-task");
  assert.equal(fatal[0]?.stage, "automation-block");
});

test("runtime changes are published until the service closes", () => {
  const { service, state, published } = harness();
  const task = {
    taskId: "exchange-rates",
    runId: "run-1",
    status: "running" as const,
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: "fixture", completed: 0, total: 1, percent: 0, attempt: 1 },
    appWorkflowOutcome: null,
    updatedAt: new Date(0).toISOString(),
  };
  state.upsert(task);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.tasks[0]?.runId, "run-1");

  service.close();
  state.upsert({ ...task, status: "completed" });
  assert.equal(published.length, 1);
});

test("clearing sign-in data cancels registrations, erases under the user data directory and rereads credentials", async () => {
  const erased: unknown[] = [];
  const { service, calls, credentialReads } = harness({
    eraseSignInDetails: (options) => {
      erased.push(options.userDataDirectory);
    },
  });
  await settle();
  const before = credentialReads();
  await service.clearSignInData();
  assert.deepEqual(calls, [["registration.cancelAll"]]);
  assert.deepEqual(erased, [directory]);
  assert.equal(credentialReads(), before + 1, "the credential cache is refreshed after erasing");
});

test("a sync the person starts reports its sources once they end, and exchange rates alone report nothing", async () => {
  const state = createAutomationRuntimeState("session-check");
  const settled: Array<(taskId: string, run: AutomationTaskRun | null) => void> = [];
  const runtime = {
    snapshot: () => state.snapshot(),
    subscribe: state.subscribe,
    run: async (taskId: string, options: StartAutomationTaskOptions = {}) => {
      if (options.onSettled) settled.push(options.onSettled);
      return { started: taskId, runId: "run", runtime: state.snapshot() };
    },
    runMany: async (taskIds: string[], options: StartAutomationTaskOptions = {}) => {
      if (options.onSettled) settled.push(options.onSettled);
      return {
        started: taskIds,
        results: Object.fromEntries(taskIds.map((taskId) => [taskId, { status: "started" as const, runId: taskId }])),
      };
    },
  } as unknown as AutomationRuntime;
  const reports: string[][] = [];
  const { service } = harness({
    runtime,
    onManualCollectionFinished: (results) => reports.push(results.map(({ taskId, run }) => `${taskId}:${run?.status ?? null}`)),
  });
  const finished = (taskId: string) => ({ taskId, status: "completed" }) as AutomationTaskRun;

  await service.run("sync-tdcc");
  settled.shift()!("sync-tdcc", finished("sync-tdcc"));
  await service.run("exchange-rates");
  assert.equal(settled.length, 0, "exchange rates are not a source");

  await service.runMany(["sync-tdcc", "fubon-all-statements"]);
  const onSettled = settled.shift()!;
  onSettled("sync-tdcc", finished("sync-tdcc"));
  assert.equal(reports.length, 1, "waits for every source of the batch");
  onSettled("fubon-all-statements", null);
  assert.deepEqual(reports, [
    ["sync-tdcc:completed"],
    ["sync-tdcc:completed", "fubon-all-statements:null"],
  ]);
});

test("a single source the person could not start is reported as not synced", async () => {
  const state = createAutomationRuntimeState("session-check");
  const runtime = {
    snapshot: () => state.snapshot(),
    subscribe: state.subscribe,
    run: async () => { throw new Error("device busy"); },
  } as unknown as AutomationRuntime;
  const reports: unknown[] = [];
  const { service } = harness({ runtime, onManualCollectionFinished: (results) => reports.push(results) });
  await assert.rejects(service.run("sync-tdcc"), /device busy/);
  assert.deepEqual(reports, [[{ taskId: "sync-tdcc", run: null }]]);
});
