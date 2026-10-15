import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import { PREVIEW_SOURCE_FIXTURE_ENV } from "./fixture-source.ts";

process.env[PREVIEW_SOURCE_FIXTURE_ENV] = "1";
const workDirectory = mkdtempSync(join(tmpdir(), "preview-sources-"));
process.chdir(workDirectory);
process.on("exit", () => rmSync(workDirectory, { recursive: true, force: true }));

const { AUTOMATION_CREDENTIAL_GROUPS, AUTOMATION_TASKS, enabledAutomationTasks } = await import("../automation/server/tasks.ts");
const { currentPreviewVisibility, offeredAutomationSources } = await import("../automation/server/settings.ts");
const { buildAutomationPageModel } = await import("../automation/server/page-model.ts");
const { scheduledCollectionTaskIds } = await import("../automation/server/scheduled-collection.ts");
const { workflowDefinitionForTask, workflowInputForTask } = await import("../automation/server/app-workflow-registry.ts");
const { createWorkflowExecutor } = await import("../automation/workflow-executor.ts");
const { assertPreviewRegistry } = await import("./registry.ts");
const { PREVIEW_FIXTURE_SOURCE } = await import("./fixture-source.ts");
const { previewVisibility } = await import("./visibility.ts");
const { takePreviewObservations, previewWorkflowDefinition } = await import("./workflow.ts");
const { deleteAllPreviewData } = await import("./delete-preview-data.ts");

const SINOPAC_ENABLED = "LIBRETTO_CLOUD_SINOPAC_ENABLED";

function offered(settings: Record<string, string>) {
  const sources = offeredAutomationSources(settings);
  const tasks = enabledAutomationTasks(sources.enabledGroups);
  const model = buildAutomationPageModel({
    tasks,
    latestRuns: {},
    activeTaskIds: [],
    credentials: Object.fromEntries(tasks.flatMap((task) => task.credentialKeys.map((key) => [key, true]))),
    active: false,
    businessDate: "2026-10-15",
  });
  return {
    signInSettings: sources.credentialGroups.map((group) => group.id),
    syncAll: model.parallelRunnableTaskIds,
    scheduled: scheduledCollectionTaskIds(model),
    visibility: currentPreviewVisibility(settings),
  };
}

test("a registry entry derives its sign-in group, task, and preview-only workflow", () => {
  const group = AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === "synthetic");
  assert.equal(group?.preview, true);
  assert.equal(group?.enabledKey, "PREVIEW_SYNTHETIC_ENABLED");
  assert.equal(AUTOMATION_TASKS.find((task) => task.id === "preview-synthetic")?.credentialGroupId, "synthetic");
  const definition = workflowDefinitionForTask("preview-synthetic");
  assert.equal(definition?.requiresFinancialCommit, false, "a preview workflow never receives the canonical commit");
  assert.equal(definition?.requiresPreviewWrite, true);
  assert.deepEqual(workflowInputForTask("preview-synthetic", { PREVIEW_SYNTHETIC_USER_ID: "u" }), {
    startUrl: "https://preview-fixture.invalid/",
    credentials: { PREVIEW_SYNTHETIC_USER_ID: "u" },
  });
});

test("the registry refuses colliding ids, foreign credential keys, and non-https start URLs", () => {
  assert.throws(() => assertPreviewRegistry([PREVIEW_FIXTURE_SOURCE], ["synthetic"]), /not unique/u);
  assert.throws(() => assertPreviewRegistry([{
    ...PREVIEW_FIXTURE_SOURCE,
    credentialFields: [{ ...PREVIEW_FIXTURE_SOURCE.credentialFields[0]!, key: "LIBRETTO_CLOUD_FUBON_PASSWORD" }],
  }], []), /must start with PREVIEW_SYNTHETIC_/u);
  assert.throws(() => assertPreviewRegistry([{ ...PREVIEW_FIXTURE_SOURCE, startUrl: "http://example.test/" }], []), /https/u);
});

test("an enabled verified source covering the same Institution and product hides a preview source", () => {
  const sources = [
    { id: "sinopac-preview", institution: "sinopac", product: "deposit" },
    { id: "esun-deposit-preview", institution: "esun", product: "deposit" },
    { id: "yuanta-deposit-preview", institution: "yuanta-bank", product: "deposit" },
  ] as const;
  const visible = (enabledGroups: Record<string, boolean>) =>
    previewVisibility({ previewFeaturesEnabled: true, enabledGroups, sources }).sourceIds;
  assert.deepEqual(visible({}), ["sinopac-preview", "esun-deposit-preview", "yuanta-deposit-preview"]);
  assert.deepEqual(visible({ sinopac: true }), ["esun-deposit-preview", "yuanta-deposit-preview"]);
  assert.deepEqual(visible({ sinopac: false }), ["sinopac-preview", "esun-deposit-preview", "yuanta-deposit-preview"],
    "a disabled verified source covers nothing");
  assert.deepEqual(visible({ esun: true, yuanta: true }), ["sinopac-preview", "esun-deposit-preview"],
    "E.SUN's verified source collects credit cards, not deposits");
  assert.deepEqual(
    previewVisibility({ previewFeaturesEnabled: false, enabledGroups: {}, sources }).sourceIds,
    [],
    "Preview features off reads no preview source",
  );
});

test("Preview features off removes preview sources from sign-in settings, Sync all, Scheduled Collection, and queries", () => {
  const ready = { PREVIEW_SYNTHETIC_ENABLED: "true", [SINOPAC_ENABLED]: "true" };
  const off = offered({ ...ready, PREVIEW_FEATURES_ENABLED: "false" });
  assert.equal(off.signInSettings.includes("synthetic"), false);
  assert.equal(off.syncAll.includes("preview-synthetic"), false);
  assert.equal(off.scheduled.includes("preview-synthetic"), false);
  assert.deepEqual(off.visibility, { sourceIds: [] });
  assert.ok(off.syncAll.includes("sinopac-statements"), "verified sources still sync");

  const on = offered({ ...ready, PREVIEW_FEATURES_ENABLED: "true" });
  assert.ok(on.signInSettings.includes("synthetic"));
  assert.ok(on.syncAll.includes("preview-synthetic"));
  assert.ok(on.scheduled.includes("preview-synthetic"));
  assert.deepEqual(on.visibility, { sourceIds: ["synthetic"] });
});

test("a preview workflow writes only through its bound preview port", async () => {
  const writes: PreviewWrite[] = [];
  let seenContextKeys: string[] = [];
  const definition = workflowDefinitionForTask("preview-synthetic")!;
  const observing = {
    ...definition,
    run: (context: Parameters<typeof definition.run>[0], input: unknown) => {
      seenContextKeys = Object.keys(context);
      return definition.run(context, input);
    },
  };
  const ports = {
    browser: { withPage: async () => { throw new Error("the fixture opens no page"); } },
    text: {} as never,
    humanAssistance: { request: async () => "failed" as const },
    financialCommit: { execute: async () => { throw new Error("canonical commit must not be called"); } },
    events: { append: async () => undefined },
    now: () => "2026-10-15T02:00:00.000Z",
  };
  const executor = createWorkflowExecutor([observing], {
    ...ports,
    previewWrite: { write: async (input) => { writes.push(input); return { accounts: 1, balances: 1, transactions: 0 }; } },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await executor.run("preview-synthetic", "run-1", { startUrl: "", credentials: {} }, signal),
    { accounts: 1, balances: 1, transactions: 0 });
  assert.equal(seenContextKeys.includes("financialCommit"), false);
  assert.deepEqual(writes.map(({ sourceId, institution, product }) => ({ sourceId, institution, product })),
    [{ sourceId: "synthetic", institution: "bank-009", product: "deposit" }]);

  await assert.rejects(
    createWorkflowExecutor([definition], ports).run("preview-synthetic", "run-2", {}, signal),
    /Preview write port is unavailable/u,
  );
});

test("the delete action empties preview data and invalidates every open view", async () => {
  const calls: string[] = [];
  await deleteAllPreviewData(
    { deleteAll: async () => { calls.push("deleteAll"); } },
    { markStale: (reason) => { calls.push(reason); return { version: 1, reason, changedAt: "" }; } },
  );
  assert.deepEqual(calls, ["deleteAll", "preview-data-changed"]);
});

test("a failed preview run keeps the responses it observed for a structure report", async () => {
  const failure = new Error("unexpected response shape");
  const failing = previewWorkflowDefinition({
    ...PREVIEW_FIXTURE_SOURCE,
    async run(context) {
      context.preview.observe({ endpoint: "/accounts", status: 200, body: { list: [] } });
      throw failure;
    },
  });
  const executor = createWorkflowExecutor([failing], {
    browser: { withPage: async () => { throw new Error("no page"); } },
    text: {} as never,
    humanAssistance: { request: async () => "failed" as const },
    previewWrite: { write: async () => ({ accounts: 0, balances: 0, transactions: 0 }) },
    events: { append: async () => undefined },
    now: () => "2026-10-15T02:00:00.000Z",
  });
  const thrown = await executor.run("preview-synthetic", "run-3", {}, new AbortController().signal).catch((error) => error);
  assert.equal(thrown, failure, "the original error reaches the runner unchanged");
  assert.deepEqual(takePreviewObservations(thrown), [{ endpoint: "/accounts", status: 200, body: { list: [] } }]);
  assert.deepEqual(takePreviewObservations(thrown), [], "raw bodies are released after the first take");
  assert.deepEqual(takePreviewObservations(new Error("other")), []);
});
