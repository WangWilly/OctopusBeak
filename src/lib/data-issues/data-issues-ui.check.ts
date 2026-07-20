import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("persistent data issue dashboard uses the desktop API and one progressive card", async () => {
  const dashboard = await readFile(new URL("./DataIssuesDashboard.svelte", import.meta.url), "utf8");
  const route = await readFile(new URL("../../routes/+page.svelte", import.meta.url), "utf8");

  assert.match(dashboard, /window\.octopusBeak\.dataIssues\.list\(\)/);
  assert.match(dashboard, /window\.octopusBeak\.dataIssues\.previewExclusion/);
  assert.match(dashboard, /window\.octopusBeak\.dataIssues\.confirmExclusion/);
  assert.match(dashboard, /transition:slide/);
  assert.match(dashboard, /class="stage-error"/);
  assert.match(dashboard, /<summary>\{\$t\.dataIssues\.operationHistory\}<\/summary>/);
  assert.match(dashboard, /const requestedIssueId = issueId;/);
  assert.match(dashboard, /if \(requestedIssueId !== issueId\) return;/);
  assert.match(dashboard, /stageError\?\.stage === "diagnosis" \|\| stageError\?\.stage === "preview"/);
  assert.match(dashboard, /restorePreview \|\| stageError\?\.stage === "restore"/);
  assert.match(dashboard, /state\.at/);
  assert.match(dashboard, /<details><summary>\{\$t\.dataIssues\.technicalDetails\}<\/summary>\{state\.message\}<\/details>/);
  assert.doesNotMatch(dashboard, /prototype|sessionStorage|scenario/);
  assert.doesNotMatch(dashboard, /class="error-history"|class="case-heading"/);
  assert.match(route, /DataIssuesDashboard/);
});

test("report submission persists the case before navigating", async () => {
  const liabilities = await readFile(new URL("../liabilities/LiabilitiesDashboard.svelte", import.meta.url), "utf8");
  const modal = await readFile(new URL("./ReportDataIssueModal.svelte", import.meta.url), "utf8");
  const accounts = await readFile(new URL("../shared-accounts/components/AccountTable.svelte", import.meta.url), "utf8");

  assert.match(liabilities, /await window\.octopusBeak\.dataIssues\.create\(input\)/);
  assert.match(liabilities, /location\.hash = `\/data-issues\/\$\{issue\.dataIssueId\}`/);
  assert.match(modal, /export let onSubmit: \(input: DataIssueCreateInput\) => Promise<void>/);
  assert.match(modal, /catch \(error\)/);
  assert.match(accounts, /account\.valueAvailability === "unavailable"[\s\S]*\$t\.accounts\.noAvailableData[\s\S]*#\/data-issues\/\$\{account\.dataIssueId\}/);
});
