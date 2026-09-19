import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { OctopusBeakApi } from "../src/lib/desktop/api.ts";
import type { DataInvalidationEvent } from "../src/lib/shared-shell/data-version.ts";

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
    load: () => ipcRenderer.invoke("overview:load"),
  },
  assets: {
    load: () => ipcRenderer.invoke("assets:load"),
  },
  liabilities: {
    load: () => ipcRenderer.invoke("liabilities:load"),
  },
  spending: {
    load: (input) => ipcRenderer.invoke("spending:load", input),
    rankPairingCandidates: (input) => ipcRenderer.invoke("spending:pairing-candidates", input),
    confirmCandidate: (input) => ipcRenderer.invoke("spending:confirmCandidate", input),
    denyCandidate: (input) => ipcRenderer.invoke("spending:denyCandidate", input),
    revokeLink: (input) => ipcRenderer.invoke("spending:revokeLink", input),
    updateItemCategory: (input) => ipcRenderer.invoke("spending:updateItemCategory", input),
    updateTransactionOverride: (input) => ipcRenderer.invoke("spending:updateTransactionOverride", input),
  },
  automation: {
    load: () => ipcRenderer.invoke("automation:load"),
    saveCredentials: (updates) => ipcRenderer.invoke("automation:saveCredentials", updates),
    cathayGmailOtpStatus: () => ipcRenderer.invoke("automation:cathayGmailOtpStatus"),
    enableCathayGmailOtp: () => ipcRenderer.invoke("automation:enableCathayGmailOtp"),
    setCathayGmailOtpEnabled: (enabled) => ipcRenderer.invoke("automation:setCathayGmailOtpEnabled", enabled),
    disconnectCathayGmailOtp: () => ipcRenderer.invoke("automation:disconnectCathayGmailOtp"),
    selectCertificateFile: (locale) => ipcRenderer.invoke("automation:selectCertificateFile", locale),
    openSetupGuideLink: (groupId, linkId, locale) => ipcRenderer.invoke("automation:openSetupGuideLink", groupId, linkId, locale),
    run: (taskId) => ipcRenderer.invoke("automation:run", taskId),
    runMany: (taskIds) => ipcRenderer.invoke("automation:runMany", taskIds),
    resume: (taskId) => ipcRenderer.invoke("automation:resume", taskId),
    cancel: (taskId) => ipcRenderer.invoke("automation:cancel", taskId),
    runHistory: () => ipcRenderer.invoke("automation:runHistory"),
    openExternalPrerequisite: (prerequisiteId) => ipcRenderer.invoke("automation:openExternalPrerequisite", prerequisiteId),
    viewerScreenshot: (taskId) => ipcRenderer.invoke("automation:viewerScreenshot", taskId),
    viewerInspect: (taskId, point) => ipcRenderer.invoke("automation:viewerInspect", taskId, point),
    viewerInput: (taskId, input) => ipcRenderer.invoke("automation:viewerInput", taskId, input),
    viewerCompletionCheck: (taskId) => ipcRenderer.invoke("automation:viewerCompletionCheck", taskId),
    forceQuit: (taskId) => ipcRenderer.invoke("automation:forceQuit", taskId),
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
};

contextBridge.exposeInMainWorld("octopusBeak", api);
