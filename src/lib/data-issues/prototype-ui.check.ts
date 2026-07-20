import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("account report action is an accessible warning icon", async () => {
  const source = await readFile(
    new URL("../shared-accounts/components/AccountTable.svelte", import.meta.url),
    "utf8",
  );

  assert.match(source, /TriangleAlert/);
  assert.match(source, /aria-label=\{\$t\.dataIssues\.reportProblem\}/);
  assert.match(source, /title=\{\$t\.dataIssues\.reportProblem\}/);
  assert.doesNotMatch(source, />\s*\{\$t\.dataIssues\.reportProblem\}\s*<\/button>/);
});

test("data issue workflow progressively reveals the next stage", async () => {
  const source = await readFile(
    new URL("./DataIssuesPrototype.svelte", import.meta.url),
    "utf8",
  );
  const i18n = await readFile(new URL("../i18n/i18n.ts", import.meta.url), "utf8");

  assert.match(source, /class="workflow-card card"/);
  assert.match(
    source,
    /class="workflow-card card"[\s\S]*class="panel-title"[\s\S]*\{#if state\.screen === "list"\}/,
  );
  assert.match(source, /import \{ slide \} from "svelte\/transition"/);
  assert.match(source, /class="stage-reveal" transition:slide/);
  assert.match(i18n, /excludeInvalidImport: "排除錯誤匯入"/);
  assert.match(source, /\$t\.dataIssues\.reportDetails/);
  assert.match(source, /\$t\.dataIssues\.confirmSource/);
  assert.match(source, /\$t\.dataIssues\.impactPreview/);
  assert.doesNotMatch(source, /class="chip"/);
  assert.doesNotMatch(source, /class="case-heading"/);
  assert.doesNotMatch(source, /class="error-history"/);
  assert.doesNotMatch(source, /prototypeScenario/);
  assert.doesNotMatch(source, /bind:value=\{scenario\}/);
});
