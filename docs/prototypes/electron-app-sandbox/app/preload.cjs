/*
 * THROWAWAY PROTOTYPE — intentionally exposes one versioned request only.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("probe", {
  run: (rendererFacts) => ipcRenderer.invoke("probe:v1:run", rendererFacts),
});
