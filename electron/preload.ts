import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { OctopusBeakApi } from "../src/lib/desktop/api.ts";

const api: OctopusBeakApi = {
  display: {
    setScale(percent) {
      if (!Number.isFinite(percent)) throw new TypeError("Display scale must be finite.");
      webFrame.setZoomFactor(Math.min(1.5, Math.max(0.75, percent / 100)));
    },
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
    load: () => ipcRenderer.invoke("spending:load"),
    updateItemCategory: (input) => ipcRenderer.invoke("spending:updateItemCategory", input),
  },
  automation: {
    load: () => ipcRenderer.invoke("automation:load"),
    saveCredentials: (updates) => ipcRenderer.invoke("automation:saveCredentials", updates),
    run: (taskId) => ipcRenderer.invoke("automation:run", taskId),
    resume: (taskId) => ipcRenderer.invoke("automation:resume", taskId),
    cancel: (taskId) => ipcRenderer.invoke("automation:cancel", taskId),
    runHistory: () => ipcRenderer.invoke("automation:runHistory"),
    viewerScreenshot: (taskId) => ipcRenderer.invoke("automation:viewerScreenshot", taskId),
    viewerInspect: (taskId, point) => ipcRenderer.invoke("automation:viewerInspect", taskId, point),
    viewerInput: (taskId, input) => ipcRenderer.invoke("automation:viewerInput", taskId, input),
    forceQuit: (taskId) => ipcRenderer.invoke("automation:forceQuit", taskId),
  },
};

contextBridge.exposeInMainWorld("octopusBeak", api);
