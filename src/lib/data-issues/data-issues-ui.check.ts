import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("persistent data issue dashboard uses the desktop API and one progressive card", async () => {
  const dashboard = await readFile(new URL("./DataIssuesDashboard.svelte", import.meta.url), "utf8");
  const route = await readFile(new URL("../../routes/+page.svelte", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../i18n/i18n.ts", import.meta.url), "utf8");

  assert.match(dashboard, /window\.octopusBeak\.dataIssues\.list\(\)/);
  assert.match(dashboard, /window\.octopusBeak\.dataIssues\.previewExclusion/);
  assert.match(dashboard, /window\.octopusBeak\.dataIssues\.confirmExclusion/);
  assert.match(dashboard, /transition:slide/);
  assert.match(dashboard, /stageTransition = \{ duration: reduceMotion \? 0 : 220 \}/);
  assert.match(dashboard, /class="stage-error"/);
  const stageErrors = dashboard.match(/<div class="stage-error"[^>]*>/g) ?? [];
  assert.ok(stageErrors.length >= 5);
  for (const stageError of stageErrors) assert.match(stageError, /role="alert"/);
  assert.match(dashboard, /aria-live="polite" aria-atomic="true">\{liveStatus\}<\/span>/);
  assert.match(dashboard, /liveStatus = \$t\.common\.loading/);
  assert.match(dashboard, /liveStatus = \$t\.dataIssues\.eventExclusion/);
  assert.match(dashboard, /liveStatus = \$t\.dataIssues\.eventRestore/);
  assert.match(dashboard, /formatUtcDateTime\(source\.importedAt, \$systemTimezone, \$locale\)/);
  assert.match(dashboard, /formatUtcDateTime\(event\.createdAt, \$systemTimezone, \$locale\)/);
  assert.match(dashboard, /class="account-return-link"[\s\S]*href=\{accountReturnHref\(issue\.account\)\}/);
  assert.match(dashboard, /aria-describedby="account-return-tooltip"/);
  assert.match(dashboard, /id="account-return-tooltip"[\s\S]*\{\$t\.dataIssues\.backToAccountHint\}/);
  assert.doesNotMatch(dashboard, /class="button secondary" href=\{accountReturnHref\(issue\.account\)\}/);
  assert.match(dashboard, /bind:this=\{historyTrigger\}[\s\S]*aria-label=\{\$t\.dataIssues\.operationHistory\}/);
  assert.match(dashboard, /<dialog[\s\S]*bind:this=\{historyDialog\}[\s\S]*aria-labelledby="operation-history-title"/);
  assert.match(dashboard, /oncancel=\{cancelHistory\}/);
  assert.match(dashboard, /historyTrigger\?\.focus\(\)/);
  assert.doesNotMatch(dashboard, /<details class="operation-history">/);
  assert.match(i18n, /backToAccountHint: "Open this account page"/);
  assert.match(i18n, /backToAccountHint: "回到此帳戶頁面"/);
  assert.match(dashboard, /const requestedIssueId = issueId;/);
  assert.match(dashboard, /if \(requestedIssueId !== issueId\) return;/);
  assert.equal(dashboard.match(/const operationCaseId = state\.issue\.dataIssueId;/g)?.length, 5);
  assert.ok((dashboard.match(/operationCaseId !== issueId/g) ?? []).length >= 10);
  assert.match(dashboard, /stageError\?\.stage === "diagnosis" \|\| stageError\?\.stage === "preview"/);
  assert.match(dashboard, /restorePreview \|\| stageError\?\.stage === "restore"/);
  assert.match(dashboard, /restorePreview\.blockedBy\.map\(\(item\) => item\.updatedAt\)\.join\(" · "\)\}<\/small><\/span><details><summary>\{\$t\.dataIssues\.technicalDetails\}<\/summary>/);
  assert.match(dashboard, /state\.at/);
  assert.match(dashboard, /<details><summary>\{\$t\.dataIssues\.technicalDetails\}<\/summary>\{state\.message\}<\/details>/);
  assert.doesNotMatch(dashboard, /prototype|sessionStorage|scenario/);
  assert.doesNotMatch(dashboard, /breadcrumb|status-chip|page-error|error-banner/);
  assert.doesNotMatch(dashboard, /class="error-history"|class="case-heading"/);
  assert.match(i18n, /confirmExclusion: "排除錯誤匯入"/);
  assert.match(dashboard, /<strong>\{eventSummary\(event\)\}<\/strong>/);
  assert.match(dashboard, /details: errorMessage\(error\)/);
  assert.match(dashboard, /\{stageError\.details\}<\/details>/);
  assert.match(dashboard, /\.source-option \{[^}]*border: 0;[^}]*border-radius: 0;/);
  assert.match(i18n, /eventCreated: "問題案件已建立"/);
  assert.match(i18n, /operationFailed: "無法完成這項操作，帳本資料未變更。請重試。"/);
  assert.match(route, /DataIssuesDashboard/);
});

test("prototype documents contain only de-identified synthetic incident values", async () => {
  const plan = await readFile(new URL("../../../docs/superpowers/plans/2026-07-20-data-issues-clickable-prototype.md", import.meta.url), "utf8");
  const design = await readFile(new URL("../../../docs/superpowers/specs/2026-07-20-data-issue-quarantine-design.md", import.meta.url), "utf8");
  const documents = `${plan}\n${design}`;
  for (const privateValue of [
    "Yuanta", "yuanta", "元大", "萬華", "**********1100",
    "520_524", "520,524", "354_107", "354,107",
    "2026-07-13", "2026/07/13", "11,874", "1,072",
  ]) {
    assert.doesNotMatch(documents, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(documents, /Example Bank loan \*\*\*\*0420/);
  assert.match(documents, /81[_ ,]250/);
  assert.match(documents, /63[_ ,]900/);
});

test("report submission persists the case before navigating", async () => {
  const assets = await readFile(new URL("../assets/AssetsDashboard.svelte", import.meta.url), "utf8");
  const liabilities = await readFile(new URL("../liabilities/LiabilitiesDashboard.svelte", import.meta.url), "utf8");
  const modal = await readFile(new URL("./ReportDataIssueModal.svelte", import.meta.url), "utf8");
  const accounts = await readFile(new URL("../shared-accounts/components/AccountTable.svelte", import.meta.url), "utf8");

  assert.match(assets, /onReportDataIssue=\{openReport\}/);
  assert.match(assets, /<ReportDataIssueModal bind:open=\{reportOpen\}/);
  assert.match(liabilities, /await window\.octopusBeak\.dataIssues\.create\(input\)/);
  assert.match(liabilities, /location\.hash = `\/data-issues\/\$\{issue\.dataIssueId\}`/);
  assert.match(modal, /export let onSubmit: \(input: DataIssueCreateInput\) => Promise<void>/);
  assert.match(modal, /catch \(error\)/);
  assert.match(modal, /aria-describedby="report-hint"/);
  assert.match(modal, /<p id="report-hint" class="lead">\{\$t\.dataIssues\.reportProblemHint\}<\/p>/);
  assert.match(modal, /await onSubmit\([\s\S]*submitting = false;[\s\S]*close\(\);[\s\S]*catch \(error\)/);
  assert.match(modal, /if \(submitting\) return;/);
  assert.match(modal, /account\.valueAvailability === "unavailable"[\s\S]*\$t\.accounts\.noAvailableData/);
  assert.doesNotMatch(modal, /currency: "TWD", value: 0/);
  assert.match(accounts, /account\.valueAvailability === "unavailable"[\s\S]*\$t\.accounts\.noAvailableData[\s\S]*#\/data-issues\/\$\{account\.dataIssueId\}/);
});

test("report creation announces progress and completion from the loaded destination", async () => {
  const assets = await readFile(new URL("../assets/AssetsDashboard.svelte", import.meta.url), "utf8");
  const liabilities = await readFile(new URL("../liabilities/LiabilitiesDashboard.svelte", import.meta.url), "utf8");
  const modal = await readFile(new URL("./ReportDataIssueModal.svelte", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("./DataIssuesDashboard.svelte", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../i18n/i18n.ts", import.meta.url), "utf8");

  assert.match(modal, /role="status" aria-live="polite"[^>]*>\{submitting \? \$t\.dataIssues\.creatingIssue : ""\}<\/span>/);
  for (const source of [assets, liabilities]) {
    assert.match(source, /history\.replaceState\(\{ \.\.\.history\.state, createdDataIssueId: issue\.dataIssueId \}, ""\)/);
  }
  assert.match(dashboard, /history\.state\?\.createdDataIssueId !== dataIssueId/);
  assert.match(dashboard, /delete nextState\.createdDataIssueId/);
  assert.match(dashboard, /history\.replaceState\(nextState, ""\)/);
  assert.match(dashboard, /state = next;[\s\S]*announceCreatedIssue\(requestedIssueId\)/);
  assert.match(dashboard, /liveStatus = \$t\.dataIssues\.issueCreatedReady/);
  assert.match(i18n, /creatingIssue: "Creating data issue…"/);
  assert.match(i18n, /issueCreatedReady: "Data issue created and loaded\."/);
  assert.match(i18n, /creatingIssue: "正在建立資料問題…"/);
  assert.match(i18n, /issueCreatedReady: "資料問題已建立並載入。"/);
});

test("account issue navigation preserves account deep links and unmounts closed reports", async () => {
  const route = await readFile(new URL("../../routes/+page.svelte", import.meta.url), "utf8");
  const assets = await readFile(new URL("../assets/AssetsDashboard.svelte", import.meta.url), "utf8");
  const liabilities = await readFile(new URL("../liabilities/LiabilitiesDashboard.svelte", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("./DataIssuesDashboard.svelte", import.meta.url), "utf8");
  const modal = await readFile(new URL("./ReportDataIssueModal.svelte", import.meta.url), "utf8");

  assert.match(route, /focusAccountId/);
  assert.match(route, /decodeURIComponent/);
  assert.match(assets, /focusAccountId=\{focusAccountId\}/);
  assert.match(liabilities, /focusAccountId=\{focusAccountId\}/);
  assert.match(dashboard, /accountReturnHref\(issue\.account\)/);
  assert.match(modal, /\{#if account && open\}/);
});

test("exclusion preview explains impact and returns to the selected source", async () => {
  const dashboard = await readFile(new URL("./DataIssuesDashboard.svelte", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../i18n/i18n.ts", import.meta.url), "utf8");

  assert.match(dashboard, /<strong>\{account\.accountLabel\}<\/strong>/);
  assert.match(dashboard, /<small>\{account\.accountId\}<\/small>/);
  assert.equal((dashboard.match(/role="tooltip"/g) ?? []).length, 5);
  assert.equal((dashboard.match(/aria-describedby="impact-[^"]+-tooltip"/g) ?? []).length, 3);
  const impactCounts = dashboard.slice(dashboard.indexOf('<dl class="impact-counts">'), dashboard.indexOf("</dl>", dashboard.indexOf('<dl class="impact-counts">')));
  assert.equal((impactCounts.match(/<dd>\{state\.preview\.(?:excludedRows|duplicateRows|affectedAccounts\.length)\}<span id="impact-(?:excluded|retained|accounts)-tooltip" class="impact-tooltip" role="tooltip">/g) ?? []).length, 3);
  assert.equal((dashboard.match(/class="impact-metric" tabindex="0"/g) ?? []).length, 3);
  assert.match(dashboard, /\.impact-metric:hover \.impact-tooltip,/);
  assert.match(dashboard, /\.impact-metric:focus-within \.impact-tooltip/);
  assert.match(dashboard, /onclick=\{backToSourceSelection\}/);
  assert.match(dashboard, /onclick=\{backToSourceSelection\}[\s\S]*onclick=\{confirmExclusion\}/);
  assert.match(dashboard, /function backToSourceSelection\(\)[\s\S]*preview: null[\s\S]*stageError = null;/);
  const backAction = dashboard.slice(
    dashboard.indexOf("function backToSourceSelection"),
    dashboard.indexOf("async function previewRestore"),
  );
  assert.doesNotMatch(backAction, /selectedSource\s*=/);
  assert.match(i18n, /excludedRowsExplanation: \(count: number\) => `\$\{count\} physical imported rows owned by this exact source version will become inactive\.`/);
  assert.match(i18n, /retainedRowsExplanation: \(count: number\) => `\$\{count\} logical duplicate rows remain visible because another active source version supports their complete projections\.`/);
  assert.match(i18n, /affectedAccountsExplanation: \(count: number\) => `\$\{count\} accounts depend on this source for a visible value or shared capture validity, including unchanged fallback values\.`/);
  assert.match(i18n, /excludedRowsExplanation: \(count\) => `此來源版本擁有的 \$\{count\} 筆實際匯入資料列將停用。`/);
  assert.match(i18n, /retainedRowsExplanation: \(count\) => `\$\{count\} 筆邏輯重複資料列仍由另一個有效來源版本提供完整投影，因此維持顯示。`/);
  assert.match(i18n, /affectedAccountsExplanation: \(count\) => `\$\{count\} 個帳戶的顯示值或共用擷取有效性依賴此來源，包括數值未變的備援結果。`/);
});

test("restore preview shows current and proposed state for every persisted affected account", async () => {
  const dashboard = await readFile(new URL("./DataIssuesDashboard.svelte", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../i18n/i18n.ts", import.meta.url), "utf8");
  const restore = dashboard.slice(
    dashboard.indexOf('{#if issue.status === "resolved"}'),
    dashboard.indexOf('<details class="operation-history">'),
  );

  assert.match(restore, /\{#each restorePreview\.affectedAccounts as account\}/);
  assert.match(restore, /<strong>\{account\.accountLabel\}<\/strong><small>\{account\.accountId\}<\/small>/);
  assert.match(restore, /\{\$t\.dataIssues\.before\}: \{formatAccountState\(account\.before\)\}/);
  assert.match(restore, /\{\$t\.dataIssues\.afterRestore\}: \{formatAccountState\(account\.after\)\}/);
  assert.ok(restore.indexOf("restorePreview.affectedAccounts") < restore.indexOf("onclick={confirmRestore}"));
  assert.match(i18n, /afterRestore: "After restore"/);
  assert.match(i18n, /afterRestore: "還原後"/);
});
