import { contextBridge, ipcRenderer } from "electron";
import type { OctopusBeakApi } from "../src/lib/desktop/api.ts";

const api: OctopusBeakApi = {
  overview: {
    load: () => ipcRenderer.invoke("overview:load"),
  },
  assets: {
    load: () => ipcRenderer.invoke("assets:load"),
  },
  liabilities: {
    load: () => ipcRenderer.invoke("liabilities:load"),
  },
  automation: {
    load: () => ipcRenderer.invoke("automation:load"),
    saveCredentials: (updates) => ipcRenderer.invoke("automation:saveCredentials", updates),
    run: (taskId) => ipcRenderer.invoke("automation:run", taskId),
    resume: (taskId) => ipcRenderer.invoke("automation:resume", taskId),
    cancel: (taskId) => ipcRenderer.invoke("automation:cancel", taskId),
    viewerScreenshot: (taskId) => ipcRenderer.invoke("automation:viewerScreenshot", taskId),
    viewerInspect: (taskId, point) => ipcRenderer.invoke("automation:viewerInspect", taskId, point),
    viewerInput: (taskId, input) => ipcRenderer.invoke("automation:viewerInput", taskId, input),
    forceQuit: (taskId) => ipcRenderer.invoke("automation:forceQuit", taskId),
  },
};

contextBridge.exposeInMainWorld("octopusBeak", api);
