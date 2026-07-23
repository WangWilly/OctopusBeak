import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createDataIssueIpcHandlers,
  octopusBeakApiChannels,
  type DataIssueDesktopService,
} from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("settings:load"), true);
assert.equal(octopusBeakApiChannels.includes("settings:save"), true);

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /ipcMain\.handle\("settings:load"/);
assert.match(source, /ipcMain\.handle\("settings:save"/);
assert.match(source, /await onSystemSettingsChanged\?\.\(value\)/);

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
assert.match(mainSource, /createExchangeRateScheduler/);
assert.match(mainSource, /onSystemSettingsChanged: scheduler\.reschedule/);
assert.match(mainSource, /scheduler\.start\(\)/);
assert.match(mainSource, /scheduler\?\.stop\(\)/);
assert.match(mainSource, /exchange-rate-scheduler-error/);

const pageSource = readFileSync(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
assert.match(pageSource, /\.catch\(\(error\) => console\.warn\("system-settings-load-failed", error\)\)/);
assert.match(pageSource, /\.finally\(\(\) => \{\s*onboardingState = readOnboardingState\(localStorage\);\s*initialized = true;\s*normalizeRoute\(\);\s*\}\)/);

for (const [channel, handler, service] of [
  ["dataIssues:list", "list", "listDataIssues"],
  ["dataIssues:create", "create", "createDataIssue"],
  ["dataIssues:load", "load", "loadDataIssue"],
  ["dataIssues:startDiagnosis", "startDiagnosis", "startDataIssueDiagnosis"],
  ["dataIssues:previewExclusion", "previewExclusion", "previewDataIssueExclusion"],
  ["dataIssues:confirmExclusion", "confirmExclusion", "confirmDataIssueExclusion"],
  ["dataIssues:previewRestore", "previewRestore", "previewDataIssueRestore"],
  ["dataIssues:confirmRestore", "confirmRestore", "confirmDataIssueRestore"],
]) {
  assert.match(source, new RegExp(`${handler}: ${service}`));
  assert.match(source, new RegExp(`ipcMain\\.handle\\("${channel}", dataIssueHandlers\\.${handler}\\)`));
}

const calls: Array<{ operation: string; payload: unknown }> = [];
const services: DataIssueDesktopService = {
  list: () => { calls.push({ operation: "list", payload: undefined }); return []; },
  create: (input) => { calls.push({ operation: "create", payload: input }); return undefined as never; },
  load: (dataIssueId) => { calls.push({ operation: "load", payload: dataIssueId }); return undefined as never; },
  startDiagnosis: (dataIssueId) => { calls.push({ operation: "startDiagnosis", payload: dataIssueId }); return undefined as never; },
  previewExclusion: (input) => { calls.push({ operation: "previewExclusion", payload: input }); return undefined as never; },
  confirmExclusion: (input) => { calls.push({ operation: "confirmExclusion", payload: input }); return undefined as never; },
  previewRestore: (dataIssueId) => { calls.push({ operation: "previewRestore", payload: dataIssueId }); return undefined as never; },
  confirmRestore: (input) => { calls.push({ operation: "confirmRestore", payload: input }); return undefined as never; },
};
const handlers = createDataIssueIpcHandlers(services);
const fictionalCreate = {
  account: {
    id: "fictional-bank-loan-1100", label: "海風銀行 - 信貸 - **********1100",
    institution: "海風銀行", product: "信貸", group: "liability" as const, kind: "loan" as const,
    typeLabel: "信貸", amountLines: [{ currency: "TWD", value: 123_456 }], lastUpdated: "2026-07-20",
  },
  fieldKey: "balance" as const,
  note: "合成資料異常",
};
const fictionalExclusion = {
  dataIssueId: "issue-fictional",
  sourceVersion: { sourceFileId: "source-fictional", importRunId: "run-fictional" },
};
const fictionalConfirmation = {
  ...fictionalExclusion, reason: "合成測試排除", acknowledged: true as const,
  previewToken: "synthetic-preview-token",
};
const fictionalRestore = { dataIssueId: "issue-fictional", previewToken: "synthetic-restore-token" };

await handlers.list({});
await handlers.create({}, fictionalCreate);
await handlers.load({}, "issue-fictional");
await handlers.startDiagnosis({}, "issue-fictional");
await handlers.previewExclusion({}, fictionalExclusion);
await handlers.confirmExclusion({}, fictionalConfirmation);
await handlers.previewRestore({}, "issue-fictional");
await handlers.confirmRestore({}, fictionalRestore);
assert.deepEqual(calls.map(({ operation }) => operation), [
  "list", "create", "load", "startDiagnosis", "previewExclusion", "confirmExclusion", "previewRestore", "confirmRestore",
]);
assert.deepEqual(calls.map(({ payload }) => payload), [
  undefined, fictionalCreate, "issue-fictional", "issue-fictional", fictionalExclusion,
  fictionalConfirmation, "issue-fictional", fictionalRestore,
]);
