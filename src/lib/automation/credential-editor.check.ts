import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import type { AutomationCredentialSaveResult, CertificateFileSelectionResult, CredentialGroupDto } from "../desktop/api.ts";
import type { OnboardingStoryEvent } from "../onboarding/story.ts";
import { createCredentialEditor } from "./credential-editor.ts";
import { planCredentialSave, type CredentialSheetContext } from "./credential-sheet.ts";

function group(id: string, overrides: Partial<CredentialGroupDto> = {}): CredentialGroupDto {
  return {
    id,
    label: id,
    displayName: { en: id.toUpperCase(), "zh-TW": id },
    searchAliases: [],
    enabledKey: `${id.toUpperCase()}_ENABLED`,
    credentialKeys: [`${id.toUpperCase()}_ID`],
    credentialFields: [],
    setupGuide: { summary: { en: "", "zh-TW": "" }, requirements: [], steps: [], links: [] },
    enabled: false,
    selectedStatementTypeIds: [],
    statementSetupRequired: false,
    storedCredentialFileNames: {},
    invalidCredentialFileKeys: [],
    ...overrides,
  } as CredentialGroupDto;
}

const groups = [
  group("fubon", { enabled: true, selectedStatementTypeIds: ["deposit"], statementSelectionKey: "FUBON_STATEMENTS", statementTypes: [{ id: "deposit" }] }),
  group("cathay", { statementSelectionKey: "CATHAY_STATEMENTS", statementTypes: [{ id: "deposit" }] }),
  group("maicoin"),
];

function context(overrides: Partial<CredentialSheetContext> = {}): CredentialSheetContext {
  return {
    dictionary: translations.en,
    locale: "en",
    credentialGroups: groups,
    collectionGroupIds: new Set(["fubon", "cathay", "maicoin"]),
    onboardingSourceSelection: false,
    onboardingSingleSource: false,
    onboardingNodeId: null,
    onboardingSelectedCredentialGroupId: null,
    credentialState: () => "ready",
    ...overrides,
  };
}

type Task = { credentialGroupId: string; canRun: boolean };

function harness(options: {
  save?: (updates: Record<string, string>) => Promise<AutomationCredentialSaveResult>;
  select?: () => Promise<CertificateFileSelectionResult>;
  reload?: () => Promise<void>;
  tasks?: readonly Task[];
} = {}) {
  const calls: string[] = [];
  const stories: OnboardingStoryEvent[] = [];
  const ran: Task[] = [];
  let bridgeReads = 0;
  const editor = createCredentialEditor<Task>({
    bridge: () => {
      bridgeReads += 1;
      return {
        saveCredentials: async (updates) => {
          calls.push(`save ${Object.keys(updates).sort().join(",")}`);
          return options.save ? options.save(updates) : { saved: true };
        },
        selectCertificateFile: async (locale) => {
          calls.push(`select ${locale}`);
          if (!options.select) throw new Error("no dialog");
          return options.select();
        },
      };
    },
    page: {
      reload: async () => {
        calls.push("reload");
        await options.reload?.();
      },
      tasks: () => options.tasks ?? [],
    },
    onboarding: { story: (event) => { stories.push(event); } },
    runTask: async (task) => { ran.push(task); },
    now: () => "2026-11-04T01:02:03.000Z",
  });
  return { editor, calls, stories, ran, bridgeReads: () => bridgeReads };
}

async function save(editor: ReturnType<typeof harness>["editor"], ctx: CredentialSheetContext) {
  const submission = editor.submit(ctx);
  return submission.kind === "saving" ? await submission.settled : submission.kind;
}

function stageMaicoin(editor: ReturnType<typeof harness>["editor"], ctx: CredentialSheetContext) {
  editor.dispatch({ type: "open" }, ctx);
  editor.dispatch({ type: "toggle-group", groupId: "maicoin" }, ctx);
  editor.dispatch({ type: "stage-value", key: "MAICOIN_ID", value: "user-1" }, ctx);
}

test("a save submits the staged updates, reloads the page and closes the sheet", async () => {
  const { editor, calls, stories, ran } = harness({ tasks: [{ credentialGroupId: "fubon", canRun: true }] });
  const ctx = context();
  stageMaicoin(editor, ctx);
  assert.equal(await save(editor, ctx), "done");
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /^save .*MAICOIN_ENABLED,MAICOIN_ID$/u);
  assert.equal(calls[1], "reload");
  assert.equal(editor.sheet().saving, false);
  assert.equal(editor.sheet().open, false);
  assert.deepEqual(stories, [], "outside the story nothing is told");
  assert.deepEqual(ran, [], "outside the story no task starts");
});

test("an invalid Statement Selection asks the view to focus that source and submits nothing", async () => {
  const { editor, calls } = harness();
  const ctx = context();
  editor.dispatch({ type: "open" }, ctx);
  editor.dispatch({ type: "toggle-group", groupId: "cathay" }, ctx);
  assert.deepEqual(editor.submit(ctx), { kind: "focus-statement-selection", groupId: "cathay" });
  assert.deepEqual(calls, []);
});

test("a save that cannot reach the host settles as failed and leaves the sheet editable", async () => {
  const { editor } = harness({ save: async () => { throw new Error("ipc down"); } });
  const ctx = context();
  stageMaicoin(editor, ctx);
  assert.equal(await save(editor, ctx), "failed");
  assert.equal(editor.sheet().saving, false);
  assert.equal(editor.sheet().open, true);
});

test("a submit while a save is in flight is blocked and submits nothing", async () => {
  let release = () => {};
  const { editor, calls } = harness({ save: () => new Promise((done) => { release = () => done({ saved: true }); }) });
  const ctx = context();
  stageMaicoin(editor, ctx);
  const first = editor.submit(ctx);
  assert.equal(first.kind, "saving");
  assert.deepEqual(editor.submit(ctx), { kind: "blocked" });
  release();
  if (first.kind === "saving") assert.equal(await first.settled, "done");
  assert.equal(calls.filter((call) => call.startsWith("save")).length, 1);
});

test("a host refusal keeps the sheet open without a reload", async () => {
  const { editor, calls } = harness({
    save: async () => ({ saved: false, error: "invalid-certificate-file", credentialKey: "MAICOIN_ID", reason: "missing-or-unreadable" }),
  });
  const ctx = context();
  stageMaicoin(editor, ctx);
  assert.equal(await save(editor, ctx), "done");
  assert.equal(calls.length, 1, "no reload after a refusal");
  assert.equal(editor.sheet().open, true);
});

test("a save whose sheet was closed and reopened during the reload neither closes the new sheet nor starts a task", async () => {
  let reopen = () => {};
  const ctx = context({
    onboardingSourceSelection: true,
    onboardingSingleSource: true,
    onboardingNodeId: "source-selection",
    onboardingSelectedCredentialGroupId: "maicoin",
  });
  const { editor, stories, ran } = harness({
    reload: async () => reopen(),
    tasks: [{ credentialGroupId: "maicoin", canRun: true }],
  });
  reopen = () => {
    editor.dispatch({ type: "close" }, ctx);
    editor.dispatch({ type: "open" }, ctx);
  };
  editor.dispatch({ type: "open" }, ctx);
  editor.enableAndSelect("maicoin", ctx);
  editor.dispatch({ type: "stage-value", key: "MAICOIN_ID", value: "user-1" }, ctx);
  stories.length = 0;
  await save(editor, ctx);
  assert.equal(editor.sheet().open, true, "the reopened sheet stays open");
  assert.deepEqual(stories, []);
  assert.deepEqual(ran, []);
});

test("during the story's source selection a saved source is told and its runnable task starts", async () => {
  const ctx = context({
    onboardingSourceSelection: true,
    onboardingSingleSource: true,
    onboardingNodeId: "source-selection",
    onboardingSelectedCredentialGroupId: "maicoin",
  });
  const tasks = [{ credentialGroupId: "fubon", canRun: true }, { credentialGroupId: "maicoin", canRun: true }];
  const { editor, stories, ran } = harness({ tasks });
  editor.dispatch({ type: "open" }, ctx);
  editor.enableAndSelect("maicoin", ctx);
  editor.dispatch({ type: "stage-value", key: "MAICOIN_ID", value: "user-1" }, ctx);
  const plan = planCredentialSave(editor.sheet(), ctx);
  assert.equal(plan.kind, "submit");
  const savedGroupId = plan.kind === "submit" ? plan.savedGroupId : "";
  await save(editor, ctx);
  assert.deepEqual(stories, [
    { type: "choose-source", credentialGroupId: "maicoin" },
    { type: "source-saved", credentialGroupId: savedGroupId, configuredAt: "2026-11-04T01:02:03.000Z" },
  ]);
  assert.deepEqual(ran, tasks.filter((task) => task.credentialGroupId === savedGroupId));
});

test("a saved source whose task cannot run starts nothing", async () => {
  const ctx = context({
    onboardingSourceSelection: true,
    onboardingSingleSource: true,
    onboardingNodeId: "source-selection",
    onboardingSelectedCredentialGroupId: "maicoin",
  });
  const { editor, ran } = harness({ tasks: [{ credentialGroupId: "maicoin", canRun: false }] });
  editor.dispatch({ type: "open" }, ctx);
  editor.enableAndSelect("maicoin", ctx);
  editor.dispatch({ type: "stage-value", key: "MAICOIN_ID", value: "user-1" }, ctx);
  assert.equal(planCredentialSave(editor.sheet(), ctx).kind, "submit");
  await save(editor, ctx);
  assert.deepEqual(ran, []);
});

test("choosing a source tells the story only at source selection, and the story's entry opens the picker", () => {
  const { editor, stories } = harness();
  editor.choose("cathay", context());
  editor.enableAndSelect("cathay", context({ onboardingSourceSelection: true, onboardingNodeId: "source-entry" }));
  assert.deepEqual(stories, []);
  editor.enableAndSelect("cathay", context({ onboardingSourceSelection: true, onboardingNodeId: "source-selection" }));
  editor.openFromStoryEntry(context({ onboardingSourceSelection: true, onboardingNodeId: "source-entry" }));
  assert.deepEqual(stories, [{ type: "choose-source", credentialGroupId: "cathay" }, { type: "open-picker" }]);
  assert.equal(editor.sheet().presentation, "picker");
});

test("a certificate file chosen after the sheet closed is dropped, and a dialog failure is shown on the field", async () => {
  let resolve: (result: CertificateFileSelectionResult) => void = () => {};
  const { editor, calls, bridgeReads } = harness({ select: () => new Promise((done) => { resolve = done; }) });
  const ctx = context();
  editor.dispatch({ type: "open" }, ctx);
  const choosing = editor.selectCertificateFile("MAICOIN_ID", "zh-TW", ctx);
  editor.dispatch({ type: "close" }, ctx);
  resolve({ cancelled: false, path: "/tmp/cert.pfx", filename: "cert.pfx" });
  await choosing;
  assert.deepEqual(calls, ["select zh-TW"]);
  assert.deepEqual(editor.sheet().changes.credentials, {}, "the stale choice stages nothing");

  const failing = harness();
  failing.editor.dispatch({ type: "open" }, ctx);
  await failing.editor.selectCertificateFile("MAICOIN_ID", "en", ctx);
  assert.equal(failing.editor.sheet().fileErrors.MAICOIN_ID, "no dialog");
  assert.equal(bridgeReads(), 1, "the bridge is read per call");
});
