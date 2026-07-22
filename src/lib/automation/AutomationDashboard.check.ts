import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./AutomationDashboard.svelte", import.meta.url), "utf8");
const runTaskSource = source.slice(source.indexOf("async function runTask"), source.indexOf("async function runParallelTasks"));
const runParallelTasksSource = source.slice(source.indexOf("async function runParallelTasks"), source.indexOf("async function stopAllTasks"));

assert.doesNotMatch(runTaskSource, /expandedLogTaskId\s*=/);
assert.doesNotMatch(runParallelTasksSource, /expandedLogTaskId\s*=/);
assert.match(runParallelTasksSource, /automation\.runMany\(tasks\.map\(\(task\) => task\.id\)\)/);
assert.doesNotMatch(runParallelTasksSource, /Promise\.allSettled/);
assert.match(source, /import \{ slide \} from "svelte\/transition"/);
assert.match(source, /function disclosureSlide\(node: Element\)/);
assert.match(source, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \? 0 : 220/);
assert.match(source, /class="stage-body"[^>]*transition:disclosureSlide/);
assert.match(source, /class="inline-log-panel"[^>]*transition:disclosureSlide/);
assert.match(source, /async function toggleCollectTasks\(event: MouseEvent\)/);
assert.match(source, /class="table-reveal"/);
assert.match(source, /container\.animate\(/);
assert.doesNotMatch(source, /class="task-row"[^>]*transition:disclosureSlide/);
assert.match(source, /transition: transform 180ms ease/);
assert.match(source, /class="inline-task-log"/);
assert.doesNotMatch(source, /activeLogsOpen/);
assert.doesNotMatch(source, /openActiveLogs/);
assert.doesNotMatch(source, /aria-labelledby="active-logs-title"/);
assert.doesNotMatch(source, /\$t\.automation\.viewLogs/);
assert.match(source, /from "@lucide\/svelte"/);
assert.match(source, /ArrowLeftRight/);
assert.match(source, /CircleEllipsis/);
assert.match(source, /CloudDownload/);
assert.match(source, /Import as ImportIcon/);
assert.match(source, /Landmark/);
assert.match(source, /class="active-task-jump-list"/);
assert.match(source, /class="active-task-filter"/);
assert.match(source, /\$: iconTasks = automation\.tasks\.filter\([\s\S]*?task\.status === "failed"/);
assert.match(source, /\{#if iconTasks\.length\}/);
assert.match(source, /\{#each iconTasks as task \(task\.id\)\}/);
assert.match(source, /class="active-task-jump"/);
assert.match(source, /class:failed=\{task\.status === "failed"\}/);
assert.match(source, /aria-label=\{`\$\{\$t\.automation\.logs\} · \$\{taskLabel\(task, \$t\)\}`\}/);
assert.match(source, /title=\{taskLabel\(task, \$t\)\}/);
assert.match(source, /onclick=\{\(\) => handleActiveTaskClick\(task\)\}/);
assert.match(source, /function handleActiveTaskClick\(task: AutomationTaskRow\)/);
assert.match(source, /task\.status === "waiting_for_human" && task\.humanSession/);
assert.match(source, /openHumanViewer\(task\)/);
assert.match(source, /async function revealTaskLog\(task: AutomationTaskRow\)/);
assert.match(source, /expandedLogTaskId = task\.id/);
assert.match(source, /showAllCollectTasks = true/);
assert.match(source, /<tr class="task-row"[^>]*id=\{`\$\{task\.id\}-task-row`\}/);
assert.match(source, /getElementById\(`\$\{task\.id\}-task-row`\)/);
assert.match(source, /scrollIntoView\(\{ behavior: reducedMotion \? "auto" : "smooth", block: "start" \}\)/);
assert.match(source, /\.task-row\s*\{\s*scroll-margin-top: 88px;/);
assert.match(source, /focus\(\{ preventScroll: true \}\)/);
assert.match(source, /overflow-x:\s*auto/);
assert.match(source, /\.active-task-filter\s*\{[\s\S]*?border: 1px solid var\(--border\)/);
assert.match(source, /\.active-task-jump-list\s*\{[\s\S]*?flex-wrap: nowrap/);
assert.match(source, /scrollbar-width: none/);
assert.match(source, /onwheel=\{scrollActiveTasks\}/);
assert.match(source, /function scrollActiveTasks\(event: WheelEvent\)/);
assert.match(source, /class="active-task-tooltip"/);
assert.match(source, /role="tooltip"/);
assert.match(source, /onpointerenter=\{\(event\) => showTaskTooltip\(task, event\)\}/);
assert.match(source, /onpointerleave=\{hideTaskTooltip\}/);
assert.match(source, /\$t\.automation\.statusLabels\[hoveredTask\.status\]/);
assert.match(source, /border-radius: 50%/);
assert.match(source, /\.active-task-jump\.failed\s*\{[\s\S]*?var\(--danger\)/);
const resumeHumanViewerSource = source.slice(source.indexOf("async function resumeHumanViewer"), source.indexOf("function pointerPoint"));
assert.match(resumeHumanViewerSource, /automation\.resume\(task\.id\)/);
assert.doesNotMatch(resumeHumanViewerSource, /runTask\(task\)/);
assert.doesNotMatch(source, /aggregateProgress/);
assert.doesNotMatch(source, /combinedTaskProgress/);
assert.doesNotMatch(source, /class="aggregate-progress"/);
assert.match(source, /class="progress-cell"/);
assert.match(source, /\$: activeTasks = automation\.tasks\.filter\(\(task\) => task\.isActive\);/);
assert.match(source, /task\.status === "waiting_for_human"[\s\S]*?automation\.forceQuit\(task\.id\)/);
assert.match(source, /historyTaskCount\(historyRows\.length\)/);
assert.match(source, /class="stage-toggle-action"/);
assert.match(source, /aria-expanded=\{stageOpen\[stage\.id\]\}/);
assert.doesNotMatch(source, /<details class="stage-section"/);
assert.doesNotMatch(source, /\$t\.automation\.independentTasks/);
assert.doesNotMatch(source, /\$: parallelTasks =/);
assert.match(source, /class="button primary stage-sync-action"/);
assert.match(source, /onclick=\{\(\) => openSyncSheet\(stage\.tasks\)\}/);
assert.match(source, /class:muted=\{!stageRunnableTasks\(stage\.tasks\)\.length\}/);
assert.doesNotMatch(source, /stage\.description/);
assert.match(source, /\$t\.automation\.startImportHeading/);
assert.match(source, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(source, /:global\(html\) \{\s*overflow-y: scroll;/);
assert.match(source, /class="card workflow-card"/);
assert.match(source, /class="sync-sheet"/);
assert.doesNotMatch(source, /\$t\.automation\.commandId/);
assert.doesNotMatch(source, /class="task-command"/);
assert.match(source, /<colgroup>[\s\S]*width: 32%[\s\S]*width: 14%[\s\S]*width: 22%[\s\S]*width: 12%[\s\S]*width: 20%[\s\S]*<\/colgroup>/);
assert.match(source, /\.automation-table\s*\{\s*table-layout: fixed;/);
assert.match(source, /colspan="5"/);
assert.match(source, /class="modal-body credential-layout"/);
assert.match(source, /class="credential-provider-list"/);
assert.match(source, /class:selected=\{group\.id === selectedCredentialGroupId\}/);
assert.match(source, /async function updateCredentialSearch\(event: Event\)/);
assert.match(source, /selectedCredentialGroupId = visibleCredentialGroups\[0\]\?\.id \?\? ""/);
assert.match(source, /value=\{credentialSearch\} oninput=\{updateCredentialSearch\}/);
assert.match(source, /\$: selectedCredentialGroup = visibleCredentialGroups\.find/);
assert.match(source, /class="modal-body history-layout"/);
assert.match(source, /class="history-filters"/);
assert.match(source, /class="history-error-detail"/);
assert.match(source, /\.history-table \.task-name span\s*\{[\s\S]*display: block/);
assert.match(source, /historySearch/);
assert.match(source, /historyFilter/);
assert.match(source, /\$: historyCounts = historyRows\.reduce/);
assert.match(source, /historyCounts\.completed/);
assert.doesNotMatch(source, /historyFinishedTime/);
assert.doesNotMatch(source, /class="modal-footer"/);

assert.match(source, /statementSelectionDrafts/);
assert.match(source, /<fieldset[^>]*class="statement-selection"/);
assert.match(source, /<legend>\{\$t\.automation\.statementsToCollect\}<\/legend>/);
assert.match(source, /type="checkbox"/);
assert.match(source, /selectedStatementTypeIds/);
assert.match(source, /task\.primaryAction === "Configure"/);
assert.match(source, /task\.status === "partial"/);
assert.match(source, /automation\.importGate\.warnings/);
assert.match(source, /import type \{ CredentialGroupDto \} from "\$lib\/desktop\/api\.ts"/);
assert.match(source, /function toggleStatementType\(groupId: string, typeId: string\)/);
assert.match(source, /function selectAllStatementTypes\(group: CredentialGroupDto\)/);
assert.match(source, /document\.getElementById\(`\$\{invalid\.id\}-statement-selection`\)\?\.focus\(\)/);
assert.match(source, /updates\[group\.statementSelectionKey\] = statementSelectionDrafts\[group\.id\]\.join\(","\)/);
assert.match(source, /aria-live="polite"/);
assert.match(source, /\.statement-selection:focus\s*\{/);
assert.match(source, /\.statement-type-option:focus-within\s*\{/);
assert.match(source, /\.statement-type-grid\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(source, /@media \(max-width: 820px\)[\s\S]*?\.statement-type-grid\s*\{[\s\S]*?grid-template-columns: 1fr/);

const saveCredentialsSource = source.slice(source.indexOf("async function saveCredentials"), source.indexOf("async function refreshViewerImage"));
assert.match(
  saveCredentialsSource,
  /if \(invalid\) \{[\s\S]*?credentialSearch = "";[\s\S]*?selectedCredentialGroupId = invalid\.id;[\s\S]*?await tick\(\);[\s\S]*?getElementById\(`\$\{invalid\.id\}-statement-selection`\)\?\.focus\(\)/,
);

const credentialGroupStatusSource = source.slice(source.indexOf("function credentialGroupStatus"), source.indexOf("function updateCredentialDraft"));
assert.doesNotMatch(credentialGroupStatusSource, /statementSetupRequired/);
assert.match(
  credentialGroupStatusSource,
  /function credentialGroupStatus\(group: CredentialGroupDto, enabled: boolean, selectedCount: number, dictionary: Translation\)/,
);
assert.doesNotMatch(credentialGroupStatusSource, /groupEnabled|statementSelectionDrafts/);
assert.match(
  credentialGroupStatusSource,
  /if \(group\.statementTypes\?\.length && !selectedCount\) return dictionary\.automation\.needsSetup;[\s\S]*?selectedStatementCount\(selectedCount, group\.statementTypes\.length\)/,
);

assert.match(
  source,
  /\$: credentialGroupStatuses = Object\.fromEntries\([\s\S]*?groupEnabled\[group\.id\] !== false,[\s\S]*?statementSelectionDrafts\[group\.id\]\?\.length \?\? 0,[\s\S]*?\$t/,
);
assert.match(source, /<span>\{credentialGroupStatuses\[group\.id\]\}<\/span>/);
assert.doesNotMatch(source, /<span>\{credentialGroupStatus\(group, \$t\)\}<\/span>/);

const importWarningSource = source.slice(
  source.indexOf('{#if task.id === "import-downloads-csv" && task.canRun && automation.importGate.warnings.length}'),
  source.indexOf('<button\n                      class={`button task-control', source.indexOf('{#if task.id === "import-downloads-csv"')),
);
assert.match(importWarningSource, /\{#each automation\.importGate\.warnings as warning\}/);
assert.match(importWarningSource, /taskIdLabel\(warning\.taskId, \$t\)/);
assert.match(
  importWarningSource,
  /warning\.failedTypeIds\.map\(\(typeId\) => \$t\.automation\.statementTypeLabels\[typeId\] \?\? typeId\)\.join\(", "\)/,
);

const statementFieldsetSource = source.slice(
  source.indexOf('<fieldset\n                class="statement-selection"'),
  source.indexOf("</fieldset>", source.indexOf('<fieldset\n                class="statement-selection"')),
);
assert.match(source, /let statementSelectionError = ""/);
assert.match(statementFieldsetSource, /aria-describedby=\{statementSelectionError/);
assert.match(statementFieldsetSource, /aria-invalid=\{statementSelectionError/);
assert.match(statementFieldsetSource, /id=\{`\$\{selectedCredentialGroup\.id\}-statement-error`\}/);
assert.match(statementFieldsetSource, /aria-live="polite"/);
assert.doesNotMatch(statementFieldsetSource, /\{#if statementSelectionError\}/);
assert.match(saveCredentialsSource, /statementSelectionError = \$t\.automation\.selectOneStatementType\(invalid\.label\)/);
assert.doesNotMatch(
  saveCredentialsSource.slice(saveCredentialsSource.indexOf("if (invalid)"), saveCredentialsSource.indexOf("const updates")),
  /actionError = \$t\.automation\.selectOneStatementType/,
);
