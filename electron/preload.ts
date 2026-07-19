import { contextBridge, ipcRenderer, webFrame } from "electron";
import {
  displayScaleZoomFactor,
  type OctopusBeakApi,
} from "../src/lib/desktop/api.ts";

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
    updateItemCategory: (input) => ipcRenderer.invoke("spending:updateItemCategory", input),
    updateTransactionOverride: (input) => ipcRenderer.invoke("spending:updateTransactionOverride", input),
  },
  automation: {
    load: () => ipcRenderer.invoke("automation:load"),
    saveCredentials: (updates) => ipcRenderer.invoke("automation:saveCredentials", updates),
    run: (taskId) => ipcRenderer.invoke("automation:run", taskId),
    runMany: (taskIds) => ipcRenderer.invoke("automation:runMany", taskIds),
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
