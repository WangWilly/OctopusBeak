# Selectable Bank Statement Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users persist a per-bank statement selection, run selected statement components in one bank login session, retain partial downloads, and import successful files while clearly reporting missing types.

**Architecture:** A shared capability catalog and pure selection parser feed the existing settings, desktop model, and workflows. Existing multi-statement workflows keep bank-specific login and navigation but call one small component orchestrator; the runner recognizes a structured final summary and persists `partial` without a database migration. Single-statement banks declare one capability now and keep their current single-session workflow until a second component exists.

**Tech Stack:** TypeScript 5.9, Svelte 5, Electron 43, Libretto 0.6, Playwright 1.61, Zod 4, Node built-in test/assert, SQLite.

## Global Constraints

- Persist non-secret selections in `settings.json`; keep secrets encrypted in `credentials.json` through existing Electron `safeStorage`.
- Apply the same saved selection to manual and scheduled task starts.
- An enabled bank must have at least one selected statement type.
- Multi-type banks with no saved selection are `needs_setup`; single-type banks initialize their sole type.
- A newly shipped statement type is unchecked for existing explicit selections.
- Run selected components in catalog order inside one Libretto workflow context and continue after component failure.
- `partial` means at least one selected component succeeded and one failed; it unlocks Import with a warning.
- Keep component CSV/JSON outputs and `downloads/<workflow-name>/` paths unchanged.
- Do not add dependencies, a migration, workflow DSL, cross-process session sharing, automatic import, or new date/account/currency/schedule controls.
- Use native checkboxes, `fieldset`/`legend`, visible focus, keyboard access, and an `aria-live` validation message.

---

## File Map

- `src/lib/automation/statement-selection.ts`: capability catalog, serialization, upgrade defaults, validation.
- `src/lib/automation/statement-run-summary.ts`: result aggregation and log sentinel parsing.
- `src/workflows/run-selected-statements.ts`: sequential execution in the caller's bank session.
- `src/lib/automation/types.ts`: capability, DTO, `needs_setup`, `partial`, warning, Configure types.
- `src/lib/automation/server/{tasks,config-files,desktop-api,page-model,runner,store}.ts`: persistence, guards, status, Import gate.
- `src/lib/desktop/api.ts`: selection state in `CredentialGroupDto`.
- `src/workflows/{fubon,yuanta,cathay}-all-statements.ts`: selected components with existing bank behavior.
- `src/lib/automation/AutomationDashboard.svelte` and `src/lib/i18n/i18n.ts`: Prototype A and bilingual states.
- Matching `*.check.ts` files: smallest regression checks.
- `README.md`, `README.zh-TW.md`: operating and upgrade behavior.

---

### Task 1: Capability Catalog And Selection Parser

**Files:**
- Create: `src/lib/automation/statement-selection.ts`
- Create: `src/lib/automation/statement-selection.check.ts`
- Modify: `src/lib/automation/types.ts:22-27`
- Modify: `src/lib/automation/server/tasks.ts:24-141,320-326`
- Test: `src/lib/automation/server/tasks.check.ts`

**Interfaces:**
- Produces `StatementTypeCapability` and optional capability fields on `AutomationCredentialGroup`.
- Produces `BANK_STATEMENT_CAPABILITIES` keyed by credential group ID.
- Produces `resolveStatementSelection(group, settings, enabled)`, `serializeStatementSelection(ids)`, and `assertValidStatementSelections(groups, settings)`.

- [ ] **Step 1: Write the failing pure check**

Create `src/lib/automation/statement-selection.check.ts`:

```ts
import assert from "node:assert/strict";
import {
  BANK_STATEMENT_CAPABILITIES,
  assertValidStatementSelections,
  resolveStatementSelection,
  serializeStatementSelection,
} from "./statement-selection.ts";

const fubon = BANK_STATEMENT_CAPABILITIES.fubon;
const esun = BANK_STATEMENT_CAPABILITIES.esun;
assert.deepEqual(resolveStatementSelection(fubon, {}, true), {
  selectedIds: [], needsSetup: true, persisted: false,
});
assert.deepEqual(resolveStatementSelection(esun, {}, true), {
  selectedIds: ["credit_card"], needsSetup: false, persisted: false,
});
assert.deepEqual(
  resolveStatementSelection(fubon, { [fubon.statementSelectionKey]: "loan,deposit,loan" }, true).selectedIds,
  ["deposit", "loan"],
);
assert.equal(serializeStatementSelection(["deposit", "credit_card"]), "deposit,credit_card");
assert.deepEqual(
  resolveStatementSelection(
    { ...fubon, statementTypes: [...fubon.statementTypes, { id: "new_type" }] },
    { [fubon.statementSelectionKey]: "deposit,loan" },
    true,
  ).selectedIds,
  ["deposit", "loan"],
);
assert.deepEqual(
  resolveStatementSelection(fubon, { [fubon.statementSelectionKey]: "deposit" }, false).selectedIds,
  ["deposit"],
);
assert.throws(
  () => resolveStatementSelection(fubon, { [fubon.statementSelectionKey]: "deposit,unknown" }, true),
  /Unknown Fubon statement type: unknown/,
);
assert.throws(
  () => assertValidStatementSelections(
    [{ id: "fubon", label: "Fubon", enabledKey: "LIBRETTO_CLOUD_FUBON_ENABLED", credentialKeys: [], ...fubon }],
    { LIBRETTO_CLOUD_FUBON_ENABLED: true, [fubon.statementSelectionKey]: "" },
  ),
  /Select at least one Fubon statement type/,
);
```

- [ ] **Step 2: Verify the check fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/statement-selection.check.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `statement-selection.ts`.

- [ ] **Step 3: Define types and the complete banking catalog**

Extend `src/lib/automation/types.ts`:

```ts
export type StatementTypeCapability = { id: string };

export type AutomationCredentialGroup = {
  id: string;
  label: string;
  enabledKey: string;
  credentialKeys: readonly string[];
  statementSelectionKey?: string;
  statementTypes?: readonly StatementTypeCapability[];
};
```

Create `statement-selection.ts` with this catalog:

```ts
import type { AutomationCredentialGroup, StatementTypeCapability } from "./types.ts";

export type StatementCapability = {
  label: string;
  statementSelectionKey: string;
  statementTypes: readonly StatementTypeCapability[];
};
const types = (...ids: string[]) => ids.map((id) => ({ id }));

export const BANK_STATEMENT_CAPABILITIES = {
  fubon: { label: "Fubon", statementSelectionKey: "LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES", statementTypes: types("deposit", "credit_card", "loan") },
  esun: { label: "ESun", statementSelectionKey: "LIBRETTO_CLOUD_ESUN_STATEMENT_TYPES", statementTypes: types("credit_card") },
  yuanta: { label: "Yuanta", statementSelectionKey: "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES", statementTypes: types("deposit", "foreign_currency", "loan", "credit_card", "fund") },
  "yuanta-trade": { label: "Yuanta Trade", statementSelectionKey: "LIBRETTO_CLOUD_YUANTA_TRADE_STATEMENT_TYPES", statementTypes: types("brokerage") },
  cathay: { label: "Cathay", statementSelectionKey: "LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES", statementTypes: types("domestic", "foreign_currency") },
  hncb: { label: "HNCB", statementSelectionKey: "LIBRETTO_CLOUD_HNCB_STATEMENT_TYPES", statementTypes: types("deposit") },
  ctbc: { label: "CTBC", statementSelectionKey: "LIBRETTO_CLOUD_CTBC_STATEMENT_TYPES", statementTypes: types("deposit") },
  post: { label: "Post Office", statementSelectionKey: "LIBRETTO_CLOUD_POST_STATEMENT_TYPES", statementTypes: types("deposit") },
  sinopac: { label: "SinoPac", statementSelectionKey: "LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES", statementTypes: types("accounts") },
  linebank: { label: "LINE Bank", statementSelectionKey: "LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES", statementTypes: types("accounts") },
} as const satisfies Record<string, StatementCapability>;
```

`accounts` remains one capability for SinoPac and LINE Bank because each current workflow owns TWD and foreign output internally.

- [ ] **Step 4: Implement deterministic parsing and validation**

Add:

```ts
type Settings = Record<string, string | boolean | undefined>;
export type StatementSelectionState = { selectedIds: string[]; needsSetup: boolean; persisted: boolean };

export function resolveStatementSelection(group: StatementCapability, settings: Settings, enabled: boolean) {
  const raw = settings[group.statementSelectionKey];
  if (raw === undefined) {
    const selectedIds = group.statementTypes.length === 1 ? [group.statementTypes[0].id] : [];
    return { selectedIds, needsSetup: enabled && selectedIds.length === 0, persisted: false };
  }
  if (typeof raw !== "string") throw new Error(`${group.statementSelectionKey} must be a string.`);
  const requested = new Set(raw.split(",").map((id) => id.trim()).filter(Boolean));
  const known = new Set(group.statementTypes.map((type) => type.id));
  for (const id of requested) {
    if (!known.has(id)) throw new Error(`Unknown ${group.label} statement type: ${id}`);
  }
  const selectedIds = group.statementTypes.map((type) => type.id).filter((id) => requested.has(id));
  return { selectedIds, needsSetup: enabled && selectedIds.length === 0, persisted: true };
}

export const serializeStatementSelection = (ids: readonly string[]) => ids.join(",");

export function assertValidStatementSelections(groups: readonly AutomationCredentialGroup[], settings: Settings) {
  for (const group of groups) {
    if (!group.statementSelectionKey || !group.statementTypes) continue;
    const state = resolveStatementSelection(
      { label: group.label, statementSelectionKey: group.statementSelectionKey, statementTypes: group.statementTypes },
      settings,
      settings[group.enabledKey] !== false,
    );
    if (state.needsSetup) throw new Error(`Select at least one ${group.label} statement type.`);
  }
}
```

- [ ] **Step 5: Attach capabilities and register non-secret keys**

Spread the matching catalog entry into Fubon, ESun, Yuanta, Yuanta Trade, Cathay, HNCB, CTBC, Post, SinoPac, and LINE Bank in `AUTOMATION_CREDENTIAL_GROUPS`. Leave E-Invoice and MaiCoin unchanged. Add keys without repeated literals:

```ts
const AUTOMATION_STATEMENT_SELECTION_KEYS = AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) =>
  group.statementSelectionKey ? [group.statementSelectionKey] : []
);
export const AUTOMATION_NON_SECRET_KEYS = [
  "SYSTEM_TIMEZONE", "EXCHANGE_RATE_UPDATE_TIME", "AUTOMATION_BUSINESS_TIMEZONE", "MAX_SUB_ACCOUNT",
  ...AUTOMATION_ENABLED_KEYS,
  ...AUTOMATION_STATEMENT_SELECTION_KEYS,
] as const;
```

- [ ] **Step 6: Run focused checks**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/statement-selection.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/tasks.check.ts
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/types.ts src/lib/automation/statement-selection.ts src/lib/automation/statement-selection.check.ts src/lib/automation/server/tasks.ts src/lib/automation/server/tasks.check.ts
git commit -m "feat: define bank statement selections"
```

---

### Task 2: Desktop State, Save Validation, And Start Guard

**Files:**
- Modify: `src/lib/desktop/api.ts:23-30`
- Modify: `src/lib/automation/server/desktop-api.ts:53-132`
- Modify: `src/lib/automation/server/page-model.ts:7-106`
- Modify: `src/lib/automation/server/runner.ts:345-359`
- Test: `src/lib/automation/server/config-files.check.ts`
- Test: `src/lib/automation/server/desktop-api.check.ts`
- Test: `src/lib/automation/server/page-model.check.ts`
- Test: `src/lib/automation/server/runner.check.ts`

**Interfaces:**
- Consumes Task 1 selection helpers.
- Produces `CredentialGroupDto.selectedStatementTypeIds`, `.statementSetupRequired`, page-only `needs_setup`, and `Configure`.
- Enforces identical selection validation for Save and every fresh manual/scheduled start; resume remains unaffected.

- [ ] **Step 1: Add failing DTO, save, and page-model checks**

Add assertions to `desktop-api.check.ts`:

```ts
const fubonGroup = model.credentialGroups.find((group) => group.id === "fubon");
assert.deepEqual(fubonGroup?.selectedStatementTypeIds, []);
assert.equal(fubonGroup?.statementSetupRequired, true);
assert.equal(model.automation.tasks.find((task) => task.id === "fubon-all-statements")?.primaryAction, "Configure");
assert.throws(() => api.assertAutomationTaskCanStart("fubon-all-statements", dir), /Select at least one Fubon/);
```

Snapshot both config files, call `automationSaveCredentials` with enabled Fubon and an empty selection, assert rejection, and assert both snapshots are unchanged. Then save `deposit,credit_card` and assert it appears only in `settings.json`.

- [ ] **Step 2: Verify focused checks fail**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
```

Expected: FAIL on missing DTO fields/status/action.

- [ ] **Step 3: Expose selection state in `CredentialGroupDto`**

```ts
export type CredentialGroupDto = AutomationCredentialGroup & {
  enabled: boolean;
  selectedStatementTypeIds: readonly string[];
  statementSetupRequired: boolean;
};
```

In `loadAutomationDesktopModel`, resolve each capable group's state from the already-read `settings`, return the DTO fields, and pass a set of setup-required group IDs into `buildAutomationPageModel`.

- [ ] **Step 4: Derive Needs setup and Configure**

Add `"needs_setup"` to `AutomationTaskStatus`, `"Configure"` to the primary-action union, and `statementSetupRequired: boolean` to `AutomationTaskRow`. In `rowStatus`, before persisted status handling:

```ts
if (task.credentialGroupId && setupRequiredGroupIds.has(task.credentialGroupId)) return "needs_setup";
```

Map it to Configure. Configure is clickable but must never enter `parallelRunnableTaskIds`.

- [ ] **Step 5: Validate merged settings before either file write**

At the top of `automationSaveCredentials`:

```ts
const split = splitAutomationUpdates(updates);
const nextSettings = { ...readAutomationSettings(), ...split.settings };
assertValidStatementSelections(AUTOMATION_CREDENTIAL_GROUPS, nextSettings);
writeAutomationSettings(nextSettings);
```

Only then run the existing credential merge/write.

- [ ] **Step 6: Guard every fresh task start**

Add this helper beside the task catalog:

```ts
export function assertTaskStatementSelection(
  task: AutomationTask,
  settings: Record<string, string | boolean | undefined>,
) {
  if (!task.credentialGroupId) return;
  const group = AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId);
  if (!group?.statementSelectionKey || !group.statementTypes) return;
  const selection = resolveStatementSelection(
    { label: group.label, statementSelectionKey: group.statementSelectionKey, statementTypes: group.statementTypes },
    settings,
    settings[group.enabledKey] !== false,
  );
  if (selection.needsSetup) throw new Error(`Select at least one ${group.label} statement type.`);
}
```

Call `assertTaskStatementSelection(task, readAutomationSettings())` in `startAutomationTask` after lookup and before claiming/spawning. Do not run it during resume because a paused session keeps its original selection.

- [ ] **Step 7: Run focused checks**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
```

Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/desktop/api.ts src/lib/automation/types.ts src/lib/automation/server/desktop-api.ts src/lib/automation/server/page-model.ts src/lib/automation/server/runner.ts src/lib/automation/server/config-files.check.ts src/lib/automation/server/desktop-api.check.ts src/lib/automation/server/page-model.check.ts src/lib/automation/server/runner.check.ts
git commit -m "feat: enforce bank statement setup"
```

---

### Task 3: Structured Summary, Partial Status, And Import Warnings

**Files:**
- Create: `src/lib/automation/statement-run-summary.ts`
- Create: `src/lib/automation/statement-run-summary.check.ts`
- Modify: `src/lib/automation/types.ts:3-10,43-46`
- Modify: `src/lib/automation/server/runner.ts:332-343,575-787`
- Modify: `src/lib/automation/server/store.ts:245-267`
- Modify: `src/lib/automation/server/page-model.ts:34-106`
- Test: `src/lib/automation/server/runner.check.ts`
- Test: `src/lib/automation/server/store.check.ts`
- Test: `src/lib/automation/server/page-model.check.ts`

**Interfaces:**
- Produces `StatementComponentResult`, `StatementRunSummary`, `aggregateStatementResults`, `statementRunSummaryLine`, `parseStatementRunSummary`.
- Produces persisted `partial` and Import warnings `{ taskId, failedTypeIds }`.
- Consumed by Task 4 orchestration and Task 5 renderer.

- [ ] **Step 1: Write failing summary and Import checks**

Create `statement-run-summary.check.ts`:

```ts
import assert from "node:assert/strict";
import {
  aggregateStatementResults,
  parseStatementRunSummary,
  statementRunSummaryLine,
} from "./statement-run-summary.ts";

const results = [
  { typeId: "deposit", status: "success" as const },
  { typeId: "loan", status: "failed" as const, error: "no account" },
  { typeId: "fund", status: "skipped" as const },
];
assert.equal(aggregateStatementResults(results), "partial");
assert.deepEqual(parseStatementRunSummary(`noise\n${statementRunSummaryLine(results)}\n`), {
  status: "partial", results,
});
assert.equal(aggregateStatementResults([{ typeId: "loan", status: "failed", error: "x" }]), "failed");
assert.equal(aggregateStatementResults([{ typeId: "deposit", status: "success" }]), "completed");
assert.equal(parseStatementRunSummary("automation-statement-summary: not-json"), null);
```

In `store.check.ts`, insert a current-day `partial` dependency with a final summary and assert the gate unlocks with its task/type warning. Keep a separate never-run dependency and assert it remains in `missingTaskIds`.

- [ ] **Step 2: Verify the new checks fail**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/statement-run-summary.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts
```

Expected: FAIL because the module/status and gate behavior do not exist.

- [ ] **Step 3: Implement the pure summary contract**

Create `statement-run-summary.ts`:

```ts
export type StatementComponentResult = {
  typeId: string;
  status: "success" | "failed" | "skipped";
  fileCount?: number;
  error?: string;
};
export type StatementRunSummary = {
  status: "completed" | "partial" | "failed";
  results: StatementComponentResult[];
};
export const STATEMENT_RUN_SUMMARY_PREFIX = "automation-statement-summary: ";

export function aggregateStatementResults(results: readonly StatementComponentResult[]) {
  const succeeded = results.some((result) => result.status === "success");
  const failed = results.some((result) => result.status === "failed");
  if (succeeded && failed) return "partial" as const;
  if (succeeded) return "completed" as const;
  return "failed" as const;
}

export function statementRunSummaryLine(results: StatementComponentResult[]) {
  return STATEMENT_RUN_SUMMARY_PREFIX + JSON.stringify({
    status: aggregateStatementResults(results), results,
  } satisfies StatementRunSummary);
}

export function parseStatementRunSummary(text: string): StatementRunSummary | null {
  const line = text.split(/\r?\n/).findLast((item) => item.startsWith(STATEMENT_RUN_SUMMARY_PREFIX));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(STATEMENT_RUN_SUMMARY_PREFIX.length)) as StatementRunSummary;
    if (!Array.isArray(value.results) || !["completed", "partial", "failed"].includes(value.status)) return null;
    return value;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Persist aggregate status after a clean exit**

Add `"partial"` to `AutomationTaskStatus`. In `runAutomationTask`, retain the latest parsed summary while output arrives:

```ts
let detectedStatementSummary: StatementRunSummary | null = null;
// in onOutput, before replacing logTail
detectedStatementSummary = parseStatementRunSummary(`${logTail}${output.logChunk}`)
  ?? detectedStatementSummary;
```

After `nextAttemptStatus`:

```ts
if (status === "completed" && detectedStatementSummary) status = detectedStatementSummary.status;
```

For aggregate failed, use joined `typeId: error` messages when no process error exists. Do not alter full logs or human-waiting semantics.

- [ ] **Step 5: Unlock Import for partial and return warnings**

Extend `ImportGate`:

```ts
type ImportWarning = { taskId: string; failedTypeIds: readonly string[] };
type ImportGate = {
  locked: boolean;
  missingTaskIds: readonly string[];
  warnings: readonly ImportWarning[];
};
```

For each dependency, use the current per-dependency loop and return both missing IDs and warnings:

```ts
const warnings: ImportWarning[] = [];
const missingTaskIds = input.dependencyIds.filter((taskId) => {
  const row = db.prepare(`
    SELECT status, log_tail
    FROM automation_task_runs
    WHERE task_id = ?
      AND status IN ('completed', 'partial')
      AND started_at >= ?
      AND started_at < ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(taskId, input.startUtc.toISOString(), input.endUtc.toISOString()) as
    | { status: "completed" | "partial"; log_tail: string }
    | undefined;
  if (!row) return true;
  if (row.status === "partial") {
    const summary = parseStatementRunSummary(row.log_tail);
    warnings.push({
      taskId,
      failedTypeIds: summary?.results
        .filter((result) => result.status === "failed")
        .map((result) => result.typeId) ?? [],
    });
  }
  return false;
});
return { locked: missingTaskIds.length > 0, missingTaskIds, warnings };
```

Ordinary failed rows never unlock Import.

- [ ] **Step 6: Surface failures in page rows**

Add this to `AutomationTaskRow`:

```ts
statementFailures: readonly { typeId: string; error?: string }[];
```

Populate it from the latest final summary. Map partial to ordinary Run, not Run again, and add a Partial progress label.

- [ ] **Step 7: Run focused checks**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/statement-run-summary.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
```

Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/automation/statement-run-summary.ts src/lib/automation/statement-run-summary.check.ts src/lib/automation/types.ts src/lib/automation/server/runner.ts src/lib/automation/server/store.ts src/lib/automation/server/page-model.ts src/lib/automation/server/runner.check.ts src/lib/automation/server/store.check.ts src/lib/automation/server/page-model.check.ts
git commit -m "feat: preserve partial statement runs"
```

---

### Task 4: Shared Orchestration And Multi-Type Workflows

**Files:**
- Create: `src/workflows/run-selected-statements.ts`
- Create: `src/workflows/run-selected-statements.check.ts`
- Modify: `src/workflows/fubon-all-statements.ts:26-45,123-171`
- Modify: `src/workflows/yuanta-all-statements.ts:26-64,427-551`
- Modify: `src/workflows/cathay-all-statements.ts:11-35,78-170`
- Test: `src/workflows/fubon-all-statements.check.ts`
- Test: `src/workflows/yuanta-all-statements.check.ts`
- Create: `src/workflows/cathay-all-statements.check.ts`

**Interfaces:**
- Consumes Task 1 selection and Task 3 summary helpers.
- Produces `runSelectedStatements(selectedIds, components)` with ordered results/outputs and one final summary.
- Preserves bank login, keep-alive/reset, CAPTCHA/session, paths, and logout.

- [ ] **Step 1: Write the failing orchestration check**

Create `run-selected-statements.check.ts`:

```ts
import assert from "node:assert/strict";
import { runSelectedStatements } from "./run-selected-statements.ts";

const calls: string[] = [];
const run = await runSelectedStatements(["deposit", "loan"], [
  { typeId: "deposit", run: async () => { calls.push("deposit"); return { count: 2 }; }, fileCount: (value) => (value as { count: number }).count },
  { typeId: "credit_card", run: async () => { calls.push("credit_card"); return {}; } },
  { typeId: "loan", prepare: async () => { calls.push("prepare-loan"); }, run: async () => { calls.push("loan"); throw new Error("no loan account"); } },
  { typeId: "fund", run: async () => { calls.push("fund"); return {}; } },
]);
assert.deepEqual(calls, ["deposit", "prepare-loan", "loan"]);
assert.deepEqual(run.results, [
  { typeId: "deposit", status: "success", fileCount: 2 },
  { typeId: "credit_card", status: "skipped" },
  { typeId: "loan", status: "failed", error: "no loan account" },
  { typeId: "fund", status: "skipped" },
]);
assert.deepEqual(run.outputs.deposit, { count: 2 });
```

- [ ] **Step 2: Verify the helper check fails**

```bash
node --no-warnings --experimental-strip-types src/workflows/run-selected-statements.check.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the sequential helper**

Create `run-selected-statements.ts`:

```ts
import { statementRunSummaryLine, type StatementComponentResult } from "../lib/automation/statement-run-summary.ts";

type Component = {
  typeId: string;
  prepare?: () => Promise<void>;
  run: () => Promise<unknown>;
  fileCount?: (output: unknown) => number;
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function runSelectedStatements(selectedIds: readonly string[], components: readonly Component[]) {
  const selected = new Set(selectedIds);
  const results: StatementComponentResult[] = [];
  const outputs: Record<string, unknown> = {};
  for (const component of components) {
    if (!selected.has(component.typeId)) {
      results.push({ typeId: component.typeId, status: "skipped" });
      continue;
    }
    const startedAt = Date.now();
    console.log("bank-statement-component-start", { typeId: component.typeId, startedAt });
    try {
      await component.prepare?.();
      const output = await component.run();
      outputs[component.typeId] = output;
      results.push({ typeId: component.typeId, status: "success", ...(component.fileCount ? { fileCount: component.fileCount(output) } : {}) });
      console.log("bank-statement-component-complete", { typeId: component.typeId, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = errorMessage(error);
      results.push({ typeId: component.typeId, status: "failed", error: message });
      console.error("bank-statement-component-failed", { typeId: component.typeId, durationMs: Date.now() - startedAt, message });
    }
  }
  console.log(statementRunSummaryLine(results));
  return { results, outputs };
}
```

- [ ] **Step 4: Adapt Fubon**

Resolve `BANK_STATEMENT_CAPABILITIES.fubon` from `process.env`. Keep the single existing login and keep-alive `try/finally`, but replace unconditional sections with:

```ts
const run = await runSelectedStatements(selectedIds, [
  { typeId: "deposit", run: () => runSectionOutOfForeground(page, "statements", () => runFubonStatements(page, input.statements)) },
  { typeId: "credit_card", run: () => runSectionOutOfForeground(page, "creditCards", () => runFubonCreditCardStatements(page, input.creditCards)) },
  { typeId: "loan", run: () => runSectionOutOfForeground(page, "loans", () => runFubonLoanStatements(page, input.loans)) },
]);
```

Make existing output fields optional and return successful outputs under their current names. Preserve logout and keep-alive cleanup exactly once.

- [ ] **Step 5: Adapt Yuanta**

Use the saved Yuanta selection as the outer allow-list. Replace local `runComponent` continuation with the helper, keep `prepareForComponent` in each selected component's `prepare`, preserve credentials injection, and keep fund last. Explicit `input.include` flags may further disable a selected component for direct development but never enable an unselected saved type. Return the existing component status/count shape.

- [ ] **Step 6: Adapt Cathay**

Make `statementTypes` optional and fall back to the saved selection. Map `domestic` and `foreign_currency` to existing retryable download closures. Preserve `createCathaySession`, retry reset, filters, `usedExistingSession`, and flattened downloads. Translate external `foreign_currency` back to existing output `foreign`.

- [ ] **Step 7: Lock bank behavior with checks**

For Fubon assert selection helper use and unchanged logout/keep-alive `finally`. For Yuanta assert catalog order, prepare calls, and fund-last. For Cathay assert both component IDs use `retryableStage` and reset still calls `createCathaySession`.

- [ ] **Step 8: Run workflow checks**

```bash
node --no-warnings --experimental-strip-types src/workflows/run-selected-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/fubon-all-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/yuanta-all-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/cathay-all-statements.check.ts
```

Expected: all exit 0; no live login is used.

- [ ] **Step 9: Commit**

```bash
git add src/workflows/run-selected-statements.ts src/workflows/run-selected-statements.check.ts src/workflows/fubon-all-statements.ts src/workflows/yuanta-all-statements.ts src/workflows/cathay-all-statements.ts src/workflows/fubon-all-statements.check.ts src/workflows/yuanta-all-statements.check.ts src/workflows/cathay-all-statements.check.ts
git commit -m "feat: run selected statements in bank sessions"
```

---

### Task 5: Prototype A Production UI And Partial States

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte:1-105,188-245,395-414,720-950,1876-2013`
- Modify: `src/lib/automation/AutomationDashboard.check.ts`
- Modify: `src/lib/i18n/i18n.ts:430-510,1010-1060`

**Interfaces:**
- Consumes Task 2 DTO/setup/Configure and Task 3 partial/warning/failure fields.
- Produces same-page selection, all-bank validation, Configure routing, counts, partial warnings, localized accessible copy.

- [ ] **Step 1: Add failing structural UI checks**

Extend `AutomationDashboard.check.ts`:

```ts
assert.match(source, /statementSelectionDrafts/);
assert.match(source, /<fieldset[^>]*class="statement-selection"/);
assert.match(source, /<legend>\{\$t\.automation\.statementsToCollect\}<\/legend>/);
assert.match(source, /type="checkbox"/);
assert.match(source, /selectedStatementTypeIds/);
assert.match(source, /task\.primaryAction === "Configure"/);
assert.match(source, /task\.status === "partial"/);
assert.match(source, /automation\.importGate\.warnings/);
```

- [ ] **Step 2: Verify the UI check fails**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/AutomationDashboard.check.ts
```

Expected: FAIL on the first new assertion.

- [ ] **Step 3: Use the shared DTO and initialize drafts**

Import `CredentialGroupDto` from `$lib/desktop/api.ts`, remove the local duplicate type, and add:

```ts
let statementSelectionDrafts: Record<string, string[]> = {};

function resetCredentialChanges() {
  credentialDrafts = {};
  groupEnabled = Object.fromEntries(credentialGroups.map((group) => [group.id, group.enabled]));
  statementSelectionDrafts = Object.fromEntries(
    credentialGroups.map((group) => [group.id, [...group.selectedStatementTypeIds]]),
  );
}
```

Include serialized draft-vs-DTO differences in `credentialsDirty`.

- [ ] **Step 4: Render selected Prototype A below credentials**

```svelte
{#if selectedCredentialGroup.statementTypes?.length}
  <fieldset
    class="statement-selection"
    id={`${selectedCredentialGroup.id}-statement-selection`}
    tabindex="-1"
    aria-describedby={`${selectedCredentialGroup.id}-statement-help`}
  >
    <legend>{$t.automation.statementsToCollect}</legend>
    <div class="statement-selection-head">
      <p id={`${selectedCredentialGroup.id}-statement-help`}>
        {$t.automation.statementSelectionHelp(selectedCredentialGroup.label)}
      </p>
      <button type="button" class="text-action" onclick={() => selectAllStatementTypes(selectedCredentialGroup)}>
        {$t.automation.selectAllStatements}
      </button>
    </div>
    <div class="statement-type-grid">
      {#each selectedCredentialGroup.statementTypes as type}
        <label class="statement-type-option">
          <input
            type="checkbox"
            checked={statementSelectionDrafts[selectedCredentialGroup.id]?.includes(type.id)}
            onchange={() => toggleStatementType(selectedCredentialGroup.id, type.id)}
          />
          <span>{$t.automation.statementTypeLabels[type.id] ?? type.id}</span>
        </label>
      {/each}
    </div>
  </fieldset>
{/if}
```

Add the approved top divider, two-column desktop grid, one-column narrow layout, selected surface, and visible checkbox/fieldset focus.

- [ ] **Step 5: Validate all enabled banks before Save**

At the beginning of `saveCredentials`:

```ts
const invalid = credentialGroups.find((group) =>
  group.statementTypes?.length
  && groupEnabled[group.id] !== false
  && !(statementSelectionDrafts[group.id]?.length)
);
if (invalid) {
  selectedCredentialGroupId = invalid.id;
  actionError = $t.automation.selectOneStatementType(invalid.label);
  await tick();
  document.getElementById(`${invalid.id}-statement-selection`)?.focus();
  return;
}
```

Serialize each capable draft into `updates`. Disabling a bank keeps its selection; never send an empty string to clear it.

- [ ] **Step 6: Add provider counts and Configure routing**

Provider subtitles show Disabled, Needs setup, or selected/total. Handle Configure before run/cancel:

```ts
if (task.primaryAction === "Configure") {
  openCredentials();
  selectedCredentialGroupId = task.credentialGroupId ?? "";
  await tick();
  document.getElementById(`${selectedCredentialGroupId}-statement-selection`)?.focus();
  return;
}
```

Treat setup-required tasks as not credential-ready even when secrets exist.

- [ ] **Step 7: Render partial and Import warnings**

Map partial to warning styling, list `task.statementFailures` inside details, and show `automation.importGate.warnings` next to the runnable Import action. Count partial history under Completed while retaining its own partial chip. Do not use failure red for partial.

- [ ] **Step 8: Add bilingual strings**

Add exact English/Traditional Chinese entries:

```ts
statementsToCollect: "Statements to collect" / "要抓取的帳戶資料",
selectAllStatements: "Select all" / "全選",
statementSelectionHelp: (bank) => `Choose at least one while ${bank} is enabled.` / `${bank} 啟用時，請至少選擇一種帳戶型態。`,
selectOneStatementType: (bank) => `Select at least one ${bank} statement type.` / `請至少選擇一種 ${bank} 帳戶型態。`,
needsSetup: "Needs setup" / "需要設定",
selectedStatementCount: (selected, total) => `${selected} of ${total} selected` / `已選 ${selected}/${total}`,
partialImportWarning: "Some statement types failed; available files can still be imported." / "部分帳戶資料抓取失敗；仍可匯入已成功下載的檔案。",
```

Add `needs_setup`/`partial` status labels, Configure action, progress labels, and labels for `deposit`, `foreign_currency`, `credit_card`, `loan`, `fund`, `brokerage`, `domestic`, and `accounts`.

- [ ] **Step 9: Run UI and type checks**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/AutomationDashboard.check.ts
npm run typecheck
```

Expected: UI check exits 0; typecheck reports no errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/automation/AutomationDashboard.svelte src/lib/automation/AutomationDashboard.check.ts src/lib/i18n/i18n.ts
git commit -m "feat: configure bank statement collection"
```

---

### Task 6: Documentation And End-To-End Verification

**Files:**
- Modify: `README.md:93-153`
- Modify: `README.zh-TW.md` Automation Panel and Supported Workflows sections
- Verify: every file changed by Tasks 1-5

**Interfaces:**
- Consumes all prior tasks.
- Produces user instructions and a verified implementation ready for review.

- [ ] **Step 1: Document operation and upgrade behavior**

Add these points to both READMEs:

```text
- Credentials → Statements to collect stores non-secret selections in settings.json.
- Multi-type banks require an explicit first selection after upgrade.
- Single-type banks initialize their current type.
- Newly supported types remain off until selected.
- Selected types for one bank reuse one login session.
- Partial runs preserve successful downloads and allow Import with a warning.
```

Add one sample setting:

```json
"LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES": "deposit,foreign_currency,credit_card"
```

- [ ] **Step 2: Run every focused check**

```bash
node --no-warnings --experimental-strip-types src/lib/automation/statement-selection.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/statement-run-summary.check.ts
node --no-warnings --experimental-strip-types src/workflows/run-selected-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/fubon-all-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/yuanta-all-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/cathay-all-statements.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/config-files.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/AutomationDashboard.check.ts
```

Expected: every command exits 0.

- [ ] **Step 3: Run repository-wide verification**

```bash
npm test
npm run typecheck
npm run build
```

Expected: tests pass, typecheck has no errors, renderer and Electron builds finish.

- [ ] **Step 4: Run privacy and diff checks**

```bash
npm run privacy-check
git diff --check
git status --short
```

Expected: no privacy violation, silent diff check, only intended changes.

- [ ] **Step 5: Verify the Electron interaction**

Run:

```bash
npm run desktop:dev:mock
```

Verify:

1. Missing multi-type selection shows Needs setup and Configure.
2. Configure opens/focuses the correct statement fieldset.
3. Checkboxes, Select all, keyboard, focus, and labels work.
4. Empty enabled selection is blocked before file writes.
5. Disable preserves selection; re-enable restores it.
6. Provider rows show Disabled, Needs setup, or selected count.
7. A fixture partial run shows warnings and leaves Import runnable.
8. History labels partial without failure treatment.
9. Narrow width collapses both grids to one column.

Stop the app normally; do not delete real user data or downloads.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md README.zh-TW.md
git commit -m "docs: explain statement collection settings"
```

- [ ] **Step 7: Review the final range**

```bash
git log --oneline --decorate -7
git diff HEAD~6..HEAD --stat
```

Expected: design plus six focused implementation commits and no unrelated files.
