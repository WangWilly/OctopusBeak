import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./AutomationDashboard.svelte", import.meta.url),
  "utf8",
);
/** The source from one anchor up to the next; both anchors must exist, or the slice would check nothing. */
function sourceBetween(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing anchor ${start}`);
  assert.notEqual(to, -1, `missing anchor ${end}`);
  return source.slice(from, to);
}
// run-actions.check.ts covers the run flows; the dashboard asks for confirmation and hands each action over.
assert.match(source, /const runActions = createRunActions<AutomationTaskRow>\(\{\s*state,/);
for (const call of ["runActions.runTask(task)", "runActions.runAll(tasks)", "runActions.stopAll(activeTasks)"]) {
  assert.ok(source.includes(call), `the dashboard hands ${call} to the run actions`);
}
assert.match(source, /import \{ slide \} from "svelte\/transition"/);
assert.match(source, /function disclosureSlide\(node: Element\)/);
assert.match(
  source,
  /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \? 0 : 220/,
);
assert.match(source, /class="stage-body"[^>]*transition:disclosureSlide/);
assert.match(source, /class="inline-run-details"[^>]*transition:disclosureSlide/);
assert.match(source, /class="table-reveal"/);
assert.doesNotMatch(source, /container\.animate\(/);
assert.doesNotMatch(source, /class="task-row"[^>]*transition:disclosureSlide/);
assert.match(source, /transition: transform 180ms ease/);
assert.doesNotMatch(source, /viewer-coordinate|assist-interaction/);
assert.doesNotMatch(
  source,
  /automation\.(?:resumeHumanAssistance|viewerScreenshot|viewerInspect|viewerInput|viewerCompletionCheck)\(/,
);
assert.doesNotMatch(source, /\$t\.automation\.assist\b|human-viewer-modal|humanTask/);
assert.doesNotMatch(source, /shouldOfferManualVerification|verificationActorsByCredentialGroup/);
assert.match(source, /class="inline-run-details-row"/);
assert.doesNotMatch(source, /activeLogsOpen/);
assert.doesNotMatch(source, /openActiveLogs/);
assert.doesNotMatch(source, /aria-labelledby="active-logs-title"/);
assert.doesNotMatch(source, /\$t\.automation\.viewLogs/);
assert.match(source, /function blockState\(\s*source: Readonly<Record<string, BlockState<DashboardBlockPayload>>>,\s*key: string,/u);
assert.match(source, /state=\{blockState\(blocks, "summary"\)\}/u);
assert.match(source, /state=\{blockState\(blocks, "details"\)\}/u);
assert.match(source, /state=\{blockState\(blocks, "list"\)\}/u);
assert.match(source, /from "@lucide\/svelte"/);
assert.match(source, /ArrowLeftRight/);
assert.match(source, /CircleEllipsis/);
assert.match(source, /CloudDownload/);
assert.match(source, /Landmark/);
assert.match(source, /class="active-task-jump-list"/);
assert.match(source, /class="active-task-filter"/);
assert.match(
  source,
  /\$: iconTasks = live\.tasks\.filter\([\s\S]*?task\.status === "failed"/,
);
assert.match(source, /\{#if iconTasks\.length\}/);
assert.match(source, /\{#each iconTasks as task \(task\.id\)\}/);
assert.match(source, /class="active-task-jump"/);
assert.match(source, /class:failed=\{task\.status === "failed"\}/);
assert.match(
  source,
  /aria-label=\{`\$\{\$t\.automation\.runDetails\} · \$\{taskLabel\(task, \$locale\)\}`\}/,
);
assert.match(source, /\{#each task\.events as event, index/);
assert.match(source, /\$t\.automation\.workflowStages\[event\.stage\]/);
assert.match(source, /workflowEventFailureLabel\(event, \$t\)/);
assert.match(source, /<code>\{event\.code\}<\/code>/);
assert.match(source, /formatTime\(event\.occurredAt\)/);
assert.match(source, /workflowEventCounts\(event\.completed, event\.total\)/);
assert.match(source, /\{#if present\(task\)\.failure\}/);
assert.match(source, /Object\.entries\(task\.appWorkflowOutcome\.summary\.counts\)/);
assert.doesNotMatch(source, /eventDisplayMode/);
assert.doesNotMatch(source, /task\.(?:logPath|logTail|errorMessage|statementFailures)/);
assert.doesNotMatch(source, /inline-log-path|task\.logPath|task\.logTail/);
assert.match(source, /title=\{taskLabel\(task, \$locale\)\}/);
assert.match(source, /onclick=\{\(\) => void revealTaskDetails\(task\)\}/);
assert.match(source, /async function revealTaskDetails\(task: AutomationTaskRow\)/);
assert.match(source, /expandedRunDetailsTaskId = task\.id/);
assert.match(
  source,
  /<tr class="task-row"[^>]*id=\{`\$\{task\.id\}-task-row`\}/,
);
assert.match(source, /getElementById\(`\$\{task\.id\}-task-row`\)/);
assert.match(
  source,
  /scrollIntoView\(\{ behavior: reducedMotion \? "auto" : "smooth", block: "start" \}\)/,
);
assert.match(source, /\.task-row\s*\{\s*scroll-margin-top: 88px;/);
assert.match(source, /focus\(\{ preventScroll: true \}\)/);
assert.match(source, /overflow-x:\s*auto/);
assert.match(
  source,
  /\.active-task-filter\s*\{[\s\S]*?border: 1px solid var\(--border\)/,
);
assert.match(source, /\.active-task-jump-list\s*\{[\s\S]*?flex-wrap: nowrap/);
assert.match(source, /scrollbar-width: none/);
assert.match(source, /onwheel=\{scrollActiveTasks\}/);
assert.match(source, /function scrollActiveTasks\(event: WheelEvent\)/);
assert.match(source, /class="active-task-tooltip"/);
assert.match(source, /role="tooltip"/);
assert.match(
  source,
  /onpointerenter=\{\(event\) => showTaskTooltip\(task, event\)\}/,
);
assert.match(source, /onpointerleave=\{hideTaskTooltip\}/);
assert.match(source, /present\(hoveredTask\)\.statusLabel/);
assert.match(source, /border-radius: 50%/);
assert.match(source, /\.active-task-jump\.failed\s*\{[\s\S]*?var\(--danger\)/);
assert.doesNotMatch(source, /primaryAction === "Resume"|automation\.resume/);
assert.doesNotMatch(source, /aggregateProgress/);
assert.doesNotMatch(source, /combinedTaskProgress/);
assert.doesNotMatch(source, /class="aggregate-progress"/);
assert.match(source, /class="progress-cell"/);
assert.match(source, /<ProgressiveBlock label="details"[^>]*showSpinner=\{false\}/);
assert.match(source, /<ProgressiveBlock label="list"[^>]*showSpinner=\{false\}/);
assert.doesNotMatch(source, /<ProgressiveBlock label="summary"[^>]*showSpinner=\{false\}/);
assert.match(source, /role="progressbar"/);
assert.match(source, /aria-valuenow=\{task\.progressPercent/);
assert.match(source, /aria-valuetext=\{present\(task\)\.progressLabel\}/);
const onboardingProgressTaskSource = source.slice(
  source.indexOf("const ONBOARDING_PROGRESS_NODES"),
  source.indexOf("$: present ="),
);
assert.match(onboardingProgressTaskSource, /\? onboardingTrackedTaskId : null/);
for (const step of [
  "collection-progress",
  "collection-failed",
  "overview-preparing",
  "overview-preparation-failed",
]) {
  assert.match(onboardingProgressTaskSource, new RegExp(`"${step}"`));
}
assert.match(source, /task\.status === "waiting_for_human"/);
assert.match(source, /class:working=\{present\(task\)\.progressWorking\}/);
assert.match(source, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.progress-bar\.working::after/);
assert.match(
  source,
  /\$: activeTasks = live\.tasks\.filter\(\(task\) => task\.isActive\);/,
);
const primaryTaskActionSource = sourceBetween(
  "async function primaryTaskAction",
  "async function saveCredentials",
);
// automation-actions.check.ts covers force-terminating a run waiting for a person.
assert.match(primaryTaskActionSource, /runActions\.cancel\(task\)/);
const forceTerminateTaskSource = source.slice(
  source.indexOf("async function forceTerminateTask"),
  source.indexOf("async function revealTaskDetails"),
);
assert.match(forceTerminateTaskSource, /confirm\(\$t\.automation\.confirmForceQuit\)/);
assert.match(forceTerminateTaskSource, /runActions\.forceTerminate\(task\)/);
assert.match(
  source,
  /\{#if task\.status === "cancelling" && task\.forceTerminateAvailable\}[\s\S]*?forceTerminateTask\(task\)[\s\S]*?\$t\.automation\.forceQuit/,
);
assert.doesNotMatch(source, /automation\.forceQuit\(/);
assert.match(source, /class="stage-toggle-action"/);
assert.match(source, /aria-expanded=\{stageOpen\[stage\.id\]\}/);
assert.doesNotMatch(source, /<details class="stage-section"/);
assert.doesNotMatch(source, /\$t\.automation\.independentTasks/);
assert.doesNotMatch(source, /\$: parallelTasks =/);
assert.match(source, /class="button primary stage-sync-action"/);
assert.match(source, /\{#each stage\.tasks as task \(task\.id\)\}/);
assert.match(source, /stageRunnableTasks\(stage\.tasks, listParallelTaskIds\)/);
assert.match(source, /listTaskStages = \[\{ id: "sync", title: \$t\.automation\.syncStage, tasks: listAutomation\.tasks \}\]/);
assert.match(source, /onclick=\{\(\) => openSyncSheet\(listAutomation\.tasks, listParallelTaskIds\)\}/);
assert.doesNotMatch(source, /stage\.description/);
assert.match(source, /\$t\.automation\.startSyncHeading/);
assert.match(
  source,
  /summaryAutomation\s*=\s*selectAutomationBlockModel\(pageModel,\s*automationBlockData\("summary", data\)\?\.automation,\s*\$state\.runtime,\s*\$state\.pendingActions\)/,
);
assert.match(source, /:global\(html\) \{\s*overflow-y: scroll;/);
assert.match(source, /class="card workflow-card"/);
assert.match(source, /class="sync-sheet"/);
assert.doesNotMatch(source, /\$t\.automation\.commandId/);
assert.doesNotMatch(source, /class="task-command"/);
assert.doesNotMatch(source, /(?:task|run)\.script/);
assert.match(
  source,
  /<colgroup>[\s\S]*width: 22%[\s\S]*width: 16%[\s\S]*width: 17%[\s\S]*width: 16%[\s\S]*width: 29%[\s\S]*<\/colgroup>/,
);
assert.match(source, /\.automation-table\s*\{\s*table-layout: fixed;/);
assert.match(source, /colspan="5"/);
assert.match(source, /class="modal-body credential-layout"/);
assert.match(source, /class="credential-provider-list"/);
assert.match(
  source,
  /\.credential-modal\s*\{[\s\S]*?height: min\(800px, calc\(100vh - 40px\)\);[\s\S]*?max-height: min\(800px, calc\(100vh - 40px\)\);/,
);
assert.match(
  source,
  /\.credential-provider-list nav\s*\{[\s\S]*?overflow-y: scroll;[\s\S]*?scrollbar-gutter: stable;/,
);
assert.match(
  source,
  /\.credential-provider-list nav::-webkit-scrollbar\s*\{\s*width: 12px;/,
);
assert.doesNotMatch(source, /data-onboarding/);
assert.doesNotMatch(source, /ononboarding(?:advance|back)/);
assert.match(source, /registerOnboardingTarget/);
assert.match(source, /onboardingTargets/);
assert.match(source, /"automation\.credentials"/);
assert.match(source, /"automation\.run"/);
assert.match(source, /"automation\.progress"/);
assert.match(source, /onOnboardingWorkflowStarting/);
assert.match(source, /onOnboardingWorkflowStarted/);
assert.match(source, /onOnboardingWorkflowStartFailed/);
assert.match(source, /export async function retryOnboardingWorkflow\(\)/);
assert.match(source, /export async function openCredentialsForOnboarding\(\)/);
assert.equal(source.match(/<span>\{failure\.explanation\}<\/span>/g)?.length, 2, "the run list and the run details both show the explanation");
assert.match(source, /\$t\.automation\.viewOverview/);
assert.match(
  source,
  /class:selected=\{group\.id === sheet\.selectedGroupId\}/,
);
const sourceGroupIdsSource = source.slice(
  source.indexOf("$: collectionGroupIds"),
  source.indexOf("$: onboardingDisclosure"),
);
assert.match(sourceGroupIdsSource, /\.filter\(\(task\) => task\.credentialGroupId\)/);
assert.match(
  source,
  /value=\{sheet\.search\} oninput=\{updateCredentialSearch\}/,
);
assert.match(
  source,
  /<RunHistoryDialog tasks=\{live\.tasks\} port=\{window\.octopusBeak\.automation\}/,
  "Run history reads the current task catalog and its own IPC port",
);
assert.match(
  source,
  /const selected = selectStructureReportRun\(structureReport, key\);[\s\S]*?\{#if structureReport\.open && structureReport\.report\}\s*<StructureReportDialog/,
  "the Structure report dialog shows only while the report it opened on is current",
);
assert.match(source, /\{#if errorReportsAvailable\}[\s\S]*?errorReport = errorReportTarget\(task, errorCode\)/);
assert.match(source, /\{#if errorReport\}\s*<ErrorReportDialog target=\{errorReport\} port=\{window\.octopusBeak\.errorReports\}/);
assert.doesNotMatch(source, /class="modal-footer"/);

assert.match(source, /<fieldset[^>]*class="statement-selection"/);
assert.match(
  source,
  /<legend class="visually-hidden">\{\$t\.automation\.statementsToCollect\}<\/legend>/,
);
assert.match(source, /type="checkbox"/);
assert.doesNotMatch(source, /statementSelectionAllSupported/);
assert.doesNotMatch(source, /selectedCredentialGroup\.id !== "fubon"/);
assert.match(source, /task\.primaryAction === "Configure"/);
assert.match(
  source,
  /import type \{ CertificateFileValidationReason, CredentialGroupDto \} from "\$lib\/desktop\/api\.ts"/,
);
assert.match(
  source,
  /function toggleStatementType\(groupId: string, typeId: string\)/,
);
assert.match(
  source,
  /function selectAllStatementTypes\(group: CredentialGroupDto\)/,
);
assert.match(source, /aria-live="polite"/);
assert.match(source, /summary\?\.products\?\.length/);
assert.match(source, /productOutcomeStatuses\[product\.status\]/);
assert.match(source, /productSkipReasons\[product\.skipReason\]/);
assert.match(source, /product\.status === "failed" && product\.committedCount > 0/);
assert.match(source, /productRetainedCount\(product\.committedCount\)/);
assert.match(source, /\.statement-type-option:focus-within\s*\{/);
assert.match(
  source,
  /@media \(max-width: 820px\)[\s\S]*?\.credential-layout\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
);

const saveCredentialsSource = sourceBetween(
  "async function saveCredentials",
  "const ONBOARDING_PROGRESS_NODES",
);
// The save rules (generation, failure, the story's saved source) are tested in credential-editor.check.ts.
assert.match(
  saveCredentialsSource,
  /if \(submission\.kind === "blocked"\) return;\s*runActions\.setError\(""\);/,
  "a blocked submit leaves the page's error alone",
);
assert.match(
  saveCredentialsSource,
  /if \(\(await submission\.settled\) === "failed"\) runActions\.setError\(\$t\.automation\.saveCredentialsFailed\)/,
  "a failed save shows the page's own copy, not the raw error",
);
assert.match(
  saveCredentialsSource,
  /if \(submission\.kind === "focus-statement-selection"\) \{\s*await tick\(\);\s*document\.getElementById\(`\$\{submission\.groupId\}-statement-selection`\)\?\.focus\(\)/,
);

assert.match(source, /\{#each sheetView\.railEnabledGroups as group \(group\.id\)\}/);
assert.match(source, /\{#each sheetView\.railAvailableGroups as group \(group\.id\)\}/);
assert.match(source, /onclick=\{\(\) => enableAndSelectGroup\(group\.id\)\}/);
assert.match(source, /class="credential-footer"/);
assert.match(source, /type="submit"\s*disabled=\{!sheetView\.canSubmit\}/);
assert.match(source, /if \(sheet\.changes\.editor\) \{\s*event\.preventDefault\(\);\s*dispatchSheet\(\{ type: "editor-cancel" \}\);/);

const statementFieldsetSource = source.slice(
  source.indexOf('<fieldset\n                class="statement-selection"'),
  source.indexOf(
    "</fieldset>",
    source.indexOf('<fieldset\n                class="statement-selection"'),
  ),
);
assert.match(
  statementFieldsetSource,
  /aria-describedby=\{sheet\.statementSelectionError/,
);
assert.match(statementFieldsetSource, /aria-invalid=\{sheet\.statementSelectionError/);
assert.match(
  statementFieldsetSource,
  /id=\{`\$\{group\.id\}-statement-error`\}/,
);
assert.match(statementFieldsetSource, /aria-live="polite"/);
assert.doesNotMatch(statementFieldsetSource, /\{#if sheet\.statementSelectionError\}/);
assert.match(
  source,
  /group\.credentialFields as credentialField \(credentialField\.key\)/,
);
assert.match(source, /selectCertificateFile\(key\)/);
assert.match(source, /invalidCredentialFileReasons\?\.\[key\]/);
assert.match(
  source,
  /certificateFileValidationMessage\(storedFileError, true\)/,
);
assert.match(source, /class="setup-guide" class:open=\{sheet\.setupGuideOpen\}/);
assert.match(
  source,
  /openSetupGuideLink\(group\.id, guideLink\.id\)/,
);

assert.match(
  source,
  /import \{ credentialInputValue \} from "\$lib\/automation\/credential-redaction\.ts"/,
);
const credentialFocusSource = source.slice(
  source.indexOf("function focusCredentialInput"),
  source.indexOf("async function selectCertificateFile"),
);
assert.match(
  credentialFocusSource,
  /credentialInputValue\(credentialFieldText\(key\), redaction, true\)/,
);
assert.match(
  credentialFocusSource,
  /credentialInputValue\(credentialFieldText\(key\), redaction, false\)/,
);
assert.match(
  source,
  /value=\{credentialInputValue\([\s]*credentialFieldText\(key\),[\s]*credentialField\.redaction,[\s]*sheet\.focusedKey === key,[\s]*\)\}/,
);
assert.match(
  source,
  /value=\{credentialInputValue\([\s]*sheet\.changes\.editor\.draft,[\s]*credentialField\.redaction,[\s]*sheet\.focusedKey === key,[\s]*\)\}/,
);
assert.doesNotMatch(source, /storedCredentialValue|credentialValues\[/);
assert.match(
  source,
  /onfocus=\{\(event\) => focusCredentialInput\(key, credentialField\.redaction, event\)\}/,
);
assert.match(
  source,
  /onblur=\{\(event\) => blurCredentialInput\(key, credentialField\.redaction, event\)\}/,
);
assert.doesNotMatch(saveCredentialsSource, /credentialInputValue/);

assert.doesNotMatch(source, /viewerImageUrl|screenshotUnavailable|floatingInput/);

assert.match(
  source,
  /watchRunDetailsOverview\(expandedRunDetailsTaskId === null \? null : overviewLive\)/,
  "run details read the current overview only while a panel is open",
);
assert.match(
  source,
  /unvaluedAccountLabels\(task\.integrationNamespaces, runDetailsOverview, \$t\)[\s\S]*?class="unvalued-accounts"/,
  "run details list the task's accounts without a current value",
);

assert.match(
  source,
  /\{#each group\.statementTypes as type \(type\.id\)\}[\s\S]*?\{#if type\.preview\}\s*<span class="statement-type-preview"[^>]*>\{\$t\.automation\.previewStatementType\}<\/span>/,
  "an attached preview statement type carries the Preview badge inside its own checkbox label",
);
