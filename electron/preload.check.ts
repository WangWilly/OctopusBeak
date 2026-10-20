import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

type Recorded = { invoked: string[]; sent: string[]; listened: string[]; exposed?: Record<string, Record<string, unknown>> };
const recorded: Recorded = { invoked: [], sent: [], listened: [] };
(globalThis as { __preloadRecorded?: Recorded }).__preloadRecorded = recorded;

const fakeElectron = `
const recorded = globalThis.__preloadRecorded;
export const ipcRenderer = {
  invoke: (channel) => { recorded.invoked.push(channel); return Promise.resolve({ ok: true, subscriptionId: "s" }); },
  send: (channel) => { recorded.sent.push(channel); },
  on: (channel) => { recorded.listened.push(channel); },
  removeListener: () => {},
};
export const contextBridge = { exposeInMainWorld: (_name, api) => { recorded.exposed = api; } };
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      return { url: `data:text/javascript,${encodeURIComponent(fakeElectron)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const source = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
assert.deepEqual(
  [...source.matchAll(/^import (?!type\b)[\s\S]*? from "([^"]+)";/gm)].map((match) => match[1]),
  ["electron"],
  "sandboxed preload must stay self-contained after bundling",
);

await import("./preload.ts");
const api = recorded.exposed;
assert.ok(api, "the preload exposes the bridge");

const invokedBy = new Map<string, string>();
for (const [namespace, methods] of Object.entries(api)) {
  for (const [method, value] of Object.entries(methods)) {
    if (typeof value !== "function" || method.startsWith("on") || namespace === "dataViews") continue;
    const [invokedBefore, sentBefore] = [recorded.invoked.length, recorded.sent.length];
    void (value as (...args: unknown[]) => unknown)();
    const crossed = [...recorded.invoked.slice(invokedBefore), ...recorded.sent.slice(sentBefore)];
    assert.equal(crossed.length, 1, `${namespace}.${method} crosses exactly one channel`);
    invokedBy.set(`${namespace}.${method}`, crossed[0]!);
  }
}
assert.deepEqual([...invokedBy.values()].sort(), [
  "automation:block",
  "automation:cancel",
  "automation:cancelDeviceRegistration",
  "automation:deviceRegistrationStatus",
  "automation:fatalRuntimeSnapshot",
  "automation:forceTerminate",
  "automation:openExternalPrerequisite",
  "automation:openPreviewStructureReportIssue",
  "automation:openSetupGuideLink",
  "automation:previewStructureReport",
  "automation:run",
  "automation:runHistory",
  "automation:runMany",
  "automation:runtimeSnapshot",
  "automation:saveCredentials",
  "automation:selectCertificateFile",
  "automation:startDeviceRegistration",
  "automation:submitDeviceRegistrationCode",
  "automation:takeSignInSettingsRequest",
  "data:acknowledgeVersion",
  "data:getVersion",
  "display:setScale",
  "settings:deletePreviewData",
  "settings:load",
  "settings:save",
  "spending:candidate-page",
  "spending:candidate-page-cancel",
  "spending:confirm-strong-candidates",
  "spending:confirmCandidate",
  "spending:denyCandidate",
  "spending:merchant-stats",
  "spending:merge-log",
  "spending:month-insight",
  "spending:page-action",
  "spending:pairing-candidates",
  "spending:pairing-prewarm",
  "spending:pending-overview",
  "spending:record-page",
  "spending:revokeLink",
  "spending:set-purchase-category",
], "the bridge reaches exactly these request channels");
assert.equal(invokedBy.get("automation.forceTerminate"), "automation:forceTerminate");
assert.equal(invokedBy.get("data.getVersion"), "data:getVersion");

const automation = api.automation as Record<string, (listener: () => void) => () => void>;
const data = api.data as Record<string, (listener: () => void) => () => void>;
automation.onRuntimeChanged!(() => {});
automation.onSignInSettingsRequested!(() => {});
data.onInvalidated!(() => {});
assert.deepEqual(recorded.listened, [
  "automation:runtime-changed",
  "automation:sign-in-settings-requested",
  "data:invalidated",
]);

const dataViews = api.dataViews as { enabled(): Promise<unknown>; subscribe(...args: unknown[]): Promise<unknown> };
recorded.invoked.length = 0;
recorded.listened.length = 0;
await dataViews.enabled();
await dataViews.subscribe("financial.overview.current", {}, () => {});
assert.deepEqual(recorded.invoked, ["data-views:enabled", "data-views:subscribe"]);
assert.deepEqual(recorded.listened, ["data-views:rows", "data-views:error"]);
