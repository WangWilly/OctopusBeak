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

test("data issue workflow is compact and keeps error history visible", async () => {
  const source = await readFile(
    new URL("./DataIssuesPrototype.svelte", import.meta.url),
    "utf8",
  );

  assert.match(source, /class="workflow-card card"/);
  assert.match(source, /class="error-history"/);
  assert.match(source, /state\.errors/);
  assert.match(source, /\$t\.dataIssues\.reportDetails/);
  assert.match(source, /\$t\.dataIssues\.confirmSource/);
  assert.match(source, /\$t\.dataIssues\.impactPreview/);
  assert.doesNotMatch(source, /prototypeScenario/);
  assert.doesNotMatch(source, /bind:value=\{scenario\}/);
});
