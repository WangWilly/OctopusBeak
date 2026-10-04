import { contextBridge, ipcRenderer, webFrame } from "electron";
import type {
  DataViewErrorEvent,
  DataViewRowsEvent,
  DataViewSubscribeResult,
  DataViewUnsubscribeResult,
  OctopusBeakApi,
  AutomationRuntimeSnapshot,
} from "../src/lib/desktop/api.ts";
import type { DataInvalidationEvent } from "../src/lib/shared-shell/data-version.ts";

let nextDataViewRequestId = 1;

function dataViewError(result: { code: string; message: string }): Error {
  const error = new Error(result.message);
  Object.assign(error, { code: result.code });
  return error;
}

const dataViews = {
  enabled: () => ipcRenderer.invoke("data-views:enabled"),
  subscribe(view: string, params: object, onRows: (rows: unknown[]) => void, onError?: (error: DataViewErrorEvent) => void) {
    const requestId = `renderer-view-${nextDataViewRequestId++}`;
    const removeListeners = () => {
      ipcRenderer.removeListener("data-views:rows", rowsHandler);
      ipcRenderer.removeListener("data-views:error", errorHandler);
    };
    const rowsHandler = (_event: Electron.IpcRendererEvent, event: DataViewRowsEvent) => {
      if (event.requestId === requestId) {
        onRows(event.rows);
      }
    };
    const errorHandler = (_event: Electron.IpcRendererEvent, event: DataViewErrorEvent) => {
      if (event.requestId === requestId) {
        removeListeners();
        onError?.(event);
      }
    };
    ipcRenderer.on("data-views:rows", rowsHandler);
    ipcRenderer.on("data-views:error", errorHandler);
    return ipcRenderer.invoke("data-views:subscribe", { requestId, view, params })
      .then((result: DataViewSubscribeResult) => {
        if (!result.ok) {
          removeListeners();
          throw dataViewError(result);
        }
        let stopped = false;
        return async () => {
          if (stopped) return;
          stopped = true;
          removeListeners();
          const response = await ipcRenderer.invoke(
            "data-views:unsubscribe",
            { requestId, subscriptionId: result.subscriptionId },
          ) as DataViewUnsubscribeResult;
          if (!response.ok) throw dataViewError(response);
        };
      }, (error: unknown) => {
        removeListeners();
        throw error;
      });
  },
};

function displayScaleZoomFactor(percent: number) {
  if (!Number.isFinite(percent)) throw new TypeError("Display scale must be finite.");
  return Math.min(1.5, Math.max(0.75, percent / 100));
}

const api: OctopusBeakApi = {
  display: {
    setScale(percent) {
      webFrame.setZoomFactor(displayScaleZoomFactor(percent));
      ipcRenderer.send("display:setScale", percent);
    },
  },
  settings: {
    load: () => ipcRenderer.invoke("settings:load"),
    save: (input) => ipcRenderer.invoke("settings:save", input),
  },
  overview: {
    load: (options) => ipcRenderer.invoke("overview:load", options),
    loadBlock: (block, options) => ipcRenderer.invoke("overview:block", block, options),
  },
  assets: {
    load: (options) => ipcRenderer.invoke("assets:load", options),
    loadBlock: (block, options) => ipcRenderer.invoke("assets:block", block, options),
  },
  liabilities: {
    load: (options) => ipcRenderer.invoke("liabilities:load", options),
    loadBlock: (block, options) => ipcRenderer.invoke("liabilities:block", block, options),
  },
  spending: {
    load: (input, options) => ipcRenderer.invoke("spending:load", input, options),
    loadRecordPage: (input) => ipcRenderer.invoke("spending:record-page", input),
    loadCandidatePage: (input, requestId) => ipcRenderer.invoke("spending:candidate-page", input, requestId),
    cancelCandidatePage: (requestId) => ipcRenderer.invoke("spending:candidate-page-cancel", requestId),
    applyPageAction: (input) => ipcRenderer.invoke("spending:page-action", input),
    loadBlock: (block, options) => ipcRenderer.invoke("spending:block", block, options),
    rankPairingCandidates: (input) => ipcRenderer.invoke("spending:pairing-candidates", input),
    prewarmPairingCandidates: (input) => ipcRenderer.invoke("spending:pairing-prewarm", input),
    confirmCandidate: (input) => ipcRenderer.invoke("spending:confirmCandidate", input),
    denyCandidate: (input) => ipcRenderer.invoke("spending:denyCandidate", input),
    revokeLink: (input) => ipcRenderer.invoke("spending:revokeLink", input),
  },
  automation: {
    loadBlock: (block, options) => ipcRenderer.invoke("automation:block", block, options),
    saveCredentials: (updates) => ipcRenderer.invoke("automation:saveCredentials", updates),
    cathayGmailOtpStatus: () => ipcRenderer.invoke("automation:cathayGmailOtpStatus"),
    enableCathayGmailOtp: () => ipcRenderer.invoke("automation:enableCathayGmailOtp"),
    setCathayGmailOtpEnabled: (enabled) => ipcRenderer.invoke("automation:setCathayGmailOtpEnabled", enabled),
    disconnectCathayGmailOtp: () => ipcRenderer.invoke("automation:disconnectCathayGmailOtp"),
    selectCertificateFile: (locale) => ipcRenderer.invoke("automation:selectCertificateFile", locale),
    openSetupGuideLink: (groupId, linkId, locale) => ipcRenderer.invoke("automation:openSetupGuideLink", groupId, linkId, locale),
    run: (taskId) => ipcRenderer.invoke("automation:run", taskId),
    runMany: (taskIds) => ipcRenderer.invoke("automation:runMany", taskIds),
    resumeHumanAssistance: (taskId) => ipcRenderer.invoke("automation:resumeHumanAssistance", taskId),
    cancel: (taskId, expectedRunId) => ipcRenderer.invoke("automation:cancel", taskId, expectedRunId),
    forceTerminate: (taskId, expectedRunId) => ipcRenderer.invoke("automation:forceTerminate", taskId, expectedRunId),
    runHistory: () => ipcRenderer.invoke("automation:runHistory"),
    openExternalPrerequisite: (prerequisiteId) => ipcRenderer.invoke("automation:openExternalPrerequisite", prerequisiteId),
    viewerScreenshot: (taskId) => ipcRenderer.invoke("automation:viewerScreenshot", taskId),
    viewerInspect: (taskId, point) => ipcRenderer.invoke("automation:viewerInspect", taskId, point),
    viewerInput: (taskId, input) => ipcRenderer.invoke("automation:viewerInput", taskId, input),
    viewerCompletionCheck: (taskId) => ipcRenderer.invoke("automation:viewerCompletionCheck", taskId),
    runtimeSnapshot: () => ipcRenderer.invoke("automation:runtimeSnapshot"),
    fatalRuntimeSnapshot: () => ipcRenderer.invoke("automation:fatalRuntimeSnapshot"),
    onRuntimeChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: AutomationRuntimeSnapshot) => {
        listener(snapshot);
      };
      ipcRenderer.on("automation:runtime-changed", handler);
      return () => ipcRenderer.removeListener("automation:runtime-changed", handler);
    },
  },
  data: {
    getVersion: () => ipcRenderer.invoke("data:getVersion"),
    acknowledgeVersion: (version) => ipcRenderer.invoke("data:acknowledgeVersion", version),
    onInvalidated(listener) {
      const handler = (_event: Electron.IpcRendererEvent, event: DataInvalidationEvent) => {
        listener(event);
      };
      ipcRenderer.on("data:invalidated", handler);
      return () => ipcRenderer.removeListener("data:invalidated", handler);
    },
  },
  dataViews,
};

contextBridge.exposeInMainWorld("octopusBeak", api);
