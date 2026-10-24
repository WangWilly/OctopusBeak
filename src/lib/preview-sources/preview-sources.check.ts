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
const { decimalSum } = await import("./source-kit.ts");

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

test("decimalSum adds signed lexemes exactly at the widest operand scale", () => {
  assert.equal(decimalSum([]), "0");
  assert.equal(decimalSum([[1, "3000"], [-1, "1000"], [1, "1530"]]), "3530");
  assert.equal(decimalSum([[1, "0.1"], [1, "0.2"]]), "0.3");
  assert.equal(decimalSum([[1, "100000"], [-1, "87654.50"]]), "12345.50");
  assert.equal(decimalSum([[1, "100"], [-1, "100.25"]]), "-0.25");
  assert.equal(decimalSum([[1, "-12.50"], [1, "-0"], [-1, "0"]]), "-12.50");
  assert.equal(decimalSum([[-1, "-5"], [1, "-5"]]), "0");
  assert.equal(decimalSum([[1, "-0.05"], [1, "0.01"]]), "-0.04");
  assert.equal(decimalSum([[1, "007.10"], [-1, "0.001"]]), "7.099");
});

test("a registry entry derives its sign-in group, task, and preview-only workflow", () => {
  const group = AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === "synthetic");
  assert.equal(group?.preview, true);
  assert.equal(group?.enabledKey, "PREVIEW_SYNTHETIC_ENABLED");
  assert.equal(AUTOMATION_TASKS.find((task) => task.id === "preview-synthetic")?.credentialGroupId, "synthetic");
  const definition = workflowDefinitionForTask("preview-synthetic");
  assert.equal(definition?.requiresFinancialCommit, false, "a preview workflow never receives the canonical commit");
  assert.equal(definition?.requiresPreviewWrite, true);
  assert.deepEqual(workflowInputForTask("preview-synthetic", { PREVIEW_SYNTHETIC_USER_ID: "u", PREVIEW_FEATURES_ENABLED: "true" }), {
    startUrl: "https://preview-fixture.invalid/",
    credentials: { PREVIEW_SYNTHETIC_USER_ID: "u" },
    products: ["deposit"],
  }, "a single product is the selection");
  assert.deepEqual(
    (workflowInputForTask("preview-synthetic", { PREVIEW_SYNTHETIC_USER_ID: "u" }) as { products: unknown }).products,
    [],
    "Preview features off offers no product",
  );
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
    { id: "sinopac-preview", institution: "sinopac", products: ["deposit"] },
    { id: "esun-preview", institution: "esun", products: ["deposit", "credit_card"] },
    { id: "yuanta-deposit-preview", institution: "yuanta-bank", products: ["deposit"] },
  ] as const;
  const visible = (enabledGroups: Record<string, boolean>) =>
    previewVisibility({ previewFeaturesEnabled: true, enabledGroups, sources, attached: [] }).visible
      .map((entry) => `${entry.sourceId}:${entry.product}`);
  assert.deepEqual(visible({}), ["sinopac-preview:deposit", "esun-preview:deposit", "esun-preview:credit_card", "yuanta-deposit-preview:deposit"]);
  assert.deepEqual(visible({ sinopac: true }), ["esun-preview:deposit", "esun-preview:credit_card", "yuanta-deposit-preview:deposit"]);
  assert.deepEqual(visible({ sinopac: false }), ["sinopac-preview:deposit", "esun-preview:deposit", "esun-preview:credit_card", "yuanta-deposit-preview:deposit"],
    "a disabled verified source covers nothing");
  assert.deepEqual(visible({ esun: true, yuanta: true }), ["sinopac-preview:deposit", "esun-preview:deposit"],
    "E.SUN's verified source covers only its credit cards, so the deposit product stays");
  assert.deepEqual(
    previewVisibility({ previewFeaturesEnabled: false, enabledGroups: {}, sources }).visible,
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
  assert.deepEqual(off.visibility, { visible: [] });
  assert.ok(off.syncAll.includes("sinopac-statements"), "verified sources still sync");

  const on = offered({ ...ready, PREVIEW_FEATURES_ENABLED: "true" });
  assert.ok(on.signInSettings.includes("synthetic"));
  assert.ok(on.syncAll.includes("preview-synthetic"));
  assert.ok(on.scheduled.includes("preview-synthetic"));
  assert.ok(on.visibility.visible.some((entry) => entry.sourceId === "synthetic" && entry.product === "deposit"));
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
    previewWrite: { write: async (input) => { writes.push(input); return { accounts: 1, balances: 1, transactions: 0, statements: 0, closedAccounts: 0 }; } },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await executor.run("preview-synthetic", "run-1", { startUrl: "", credentials: {}, products: ["deposit"] }, signal), {
    status: "completed",
    accountCount: 1,
    itemCount: 1,
    committedCount: 1,
    products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
  });
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
    previewWrite: { write: async () => ({ accounts: 0, balances: 0, transactions: 0, statements: 0, closedAccounts: 0 }) },
    events: { append: async () => undefined },
    now: () => "2026-10-15T02:00:00.000Z",
  });
  const thrown = await executor.run("preview-synthetic", "run-3", { products: ["deposit"] }, new AbortController().signal).catch((error) => error);
  assert.equal(thrown, failure, "the original error reaches the runner unchanged");
  assert.deepEqual(takePreviewObservations(thrown), [{ endpoint: "/accounts", status: 200, body: { list: [] } }]);
  assert.deepEqual(takePreviewObservations(thrown), [], "raw bodies are released after the first take");
  assert.deepEqual(takePreviewObservations(new Error("other")), []);
});

test("production browser-backed bank sources reach their supported CAPTCHA flow", async () => {
  const { runPreviewSource } = await import("./preview-source-harness.ts");
  const { MEGA_PREVIEW_SOURCE } = await import("./mega-source.ts");
  const { TAISHIN_PREVIEW_SOURCE } = await import("./taishin-source.ts");
  const { NEXTBANK_PREVIEW_SOURCE } = await import("./nextbank-source.ts");
  const { RAKUTEN_PREVIEW_SOURCE } = await import("./rakuten-source.ts");
  const { FIRSTBANK_PREVIEW_SOURCE } = await import("./firstbank-source.ts");
  const { KGIBANK_PREVIEW_SOURCE } = await import("./kgibank-source.ts");
  const refused = (result: Awaited<ReturnType<typeof runPreviewSource>>) =>
    result.errorCode === "verification-configuration-failed" && result.events.some((event) => event.code === "solver-challenge-unsupported");
  for (const source of [MEGA_PREVIEW_SOURCE, TAISHIN_PREVIEW_SOURCE, NEXTBANK_PREVIEW_SOURCE,
    RAKUTEN_PREVIEW_SOURCE, FIRSTBANK_PREVIEW_SOURCE, KGIBANK_PREVIEW_SOURCE]) {
    const result = await runPreviewSource(source, {});
    assert.ok(!refused(result), `${source.id} goes on to open its page`);
    assert.match(String(result.error), /preview source checks open no page/u);
  }
});


test("an attached preview product is offered only while Preview features are on, marked preview, and never selected by default", async () => {
  const { selectStatementTypes } = await import("../automation/statement-selection.ts");
  const groups = (settings: Record<string, string>) =>
    Object.fromEntries(offeredAutomationSources(settings).credentialGroups.map((group) => [group.id, group.statementTypes ?? []]));
  const off = groups({ PREVIEW_FEATURES_ENABLED: "false" });
  assert.deepEqual(off.cathay!.map((type) => type.id), ["domestic", "foreign_currency"]);
  assert.deepEqual(off.hncb!.map((type) => type.id), ["deposit"]);
  const on = groups({ PREVIEW_FEATURES_ENABLED: "true" });
  assert.deepEqual(on.cathay, [
    { id: "domestic" }, { id: "foreign_currency" }, { id: "credit_card", preview: true }, { id: "time_deposit", preview: true },
  ]);
  assert.deepEqual(on.hncb, [{ id: "deposit" }, { id: "credit_card", preview: true }]);
  assert.deepEqual(on.sinopac, [{ id: "deposit" }, { id: "credit_card", preview: true }]);
  assert.deepEqual(on.esun, [{ id: "credit_card" }, { id: "deposit", preview: true }]);
  assert.deepEqual(on.fubon!.map((type) => type.preview), [undefined, undefined, undefined], "a group without attached products is unchanged");

  const hncb = { id: "hncb", label: "HNCB", enabledKey: "E", statementSelectionKey: "S", statementTypes: on.hncb! };
  assert.deepEqual(selectStatementTypes(hncb, { E: true }, "display"), { selectedIds: ["deposit"], needsSetup: false, persisted: false },
    "the single verified product is still selected by default; the attached product is not");
  assert.deepEqual(selectStatementTypes(hncb, { E: true, S: "deposit,credit_card" }, "strict").selectedIds, ["deposit", "credit_card"]);
});

test("a covered product is left out of a source's selection, and a verified run receives only its visible attached products", async () => {
  const { selectedPreviewProducts, selectedAttachedPreviewProducts } = await import("./workflow.ts");
  const twoProducts = { id: "sinopac-cards", institution: "sinopac", products: ["deposit", "credit_card"] } as const;
  const chosen = { PREVIEW_FEATURES_ENABLED: "true", PREVIEW_SINOPAC_CARDS_STATEMENT_TYPES: "deposit,credit_card" };
  assert.deepEqual(selectedPreviewProducts(twoProducts, chosen), ["deposit", "credit_card"]);
  assert.deepEqual(selectedPreviewProducts(twoProducts, { ...chosen, [SINOPAC_ENABLED]: "true" }), ["credit_card"],
    "the enabled verified SinoPac source covers deposits only");
  assert.deepEqual(selectedPreviewProducts(twoProducts, { PREVIEW_FEATURES_ENABLED: "true" }), [], "two products need an explicit selection");
  assert.deepEqual(selectedPreviewProducts(twoProducts, { ...chosen, PREVIEW_FEATURES_ENABLED: "false" }), []);

  const cathay = { LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES: "domestic,credit_card", LIBRETTO_CLOUD_CATHAY_ENABLED: "true" };
  assert.deepEqual(selectedAttachedPreviewProducts("cathay", { ...cathay, PREVIEW_FEATURES_ENABLED: "true" }), ["credit_card"]);
  assert.deepEqual(selectedAttachedPreviewProducts("cathay", cathay), [], "Preview features off collects no attached product");
  const input = workflowInputForTask("cathay-all-statements", { ...cathay, PREVIEW_FEATURES_ENABLED: "true" }) as Record<string, unknown>;
  assert.deepEqual(input.statementTypes, ["domestic"], "the verified selection tolerates the attached id without collecting it");
  assert.deepEqual(input.attachedPreviewProducts, ["credit_card"]);
  assert.deepEqual((workflowInputForTask("cathay-all-statements", cathay) as Record<string, unknown>).attachedPreviewProducts, []);
  assert.equal(workflowDefinitionForTask("cathay-all-statements")?.attachedPreviewProducts?.sourceId, "cathay");
  assert.equal(workflowDefinitionForTask("hncb-statements")?.attachedPreviewProducts?.sourceId, "hncb");
  assert.equal(workflowDefinitionForTask("sinopac-statements")?.attachedPreviewProducts?.sourceId, "sinopac");
  assert.equal(workflowDefinitionForTask("esun-credit-card-statements")?.attachedPreviewProducts?.sourceId, "esun");
  assert.equal(workflowDefinitionForTask("ctbc-statements")?.attachedPreviewProducts, undefined, "CTBC credit cards are a separate Preview Source");
});
