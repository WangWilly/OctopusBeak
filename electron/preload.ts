import { contextBridge, ipcRenderer } from "electron";
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

/** The channel behind each bridge method that only forwards to an ipcMain handler. */
const INVOKE_CHANNELS = {
  settings: {
    load: "settings:load",
    save: "settings:save",
    previewUsagePing: "settings:previewUsagePing",
    deletePreviewData: "settings:deletePreviewData",
    deleteFinancialData: "settings:deleteFinancialData",
    clearSignInData: "settings:clearSignInData",
    collectAllSources: "settings:collectAllSources",
  },
  // A channel named after a financial operation forwards to it unchanged
  // (ipc-channels.ts); the others have their own main-process handler.
  spending: {
    loadRecordPage: "financial.spending.recordPage",
    loadCandidatePage: "spending:candidate-page",
    cancelCandidatePage: "spending:candidate-page-cancel",
    applyPageAction: "financial.spending.pageAction",
    setPurchaseCategory: "financial.spending.setPurchaseCategory",
    loadPendingOverview: "financial.spending.pendingOverview",
    loadMergeLog: "financial.spending.mergeLog",
    loadMonthInsight: "financial.spending.monthInsight",
    loadMerchantStats: "financial.spending.merchantStats",
    confirmStrongCandidates: "financial.spending.confirmStrongCandidates",
    rankPairingCandidates: "financial.spending.pairing",
    prewarmPairingCandidates: "spending:pairing-prewarm",
  },
  automation: {
    loadBlock: "automation:block",
    saveCredentials: "automation:saveCredentials",
    deviceRegistrationStatus: "automation:deviceRegistrationStatus",
    startDeviceRegistration: "automation:startDeviceRegistration",
    submitDeviceRegistrationCode: "automation:submitDeviceRegistrationCode",
    cancelDeviceRegistration: "automation:cancelDeviceRegistration",
    selectCertificateFile: "automation:selectCertificateFile",
    openSetupGuideLink: "automation:openSetupGuideLink",
    run: "automation:run",
    runMany: "automation:runMany",
    cancel: "automation:cancel",
    forceTerminate: "automation:forceTerminate",
    runHistory: "automation:runHistory",
    openExternalPrerequisite: "automation:openExternalPrerequisite",
    runtimeSnapshot: "automation:runtimeSnapshot",
    fatalRuntimeSnapshot: "automation:fatalRuntimeSnapshot",
    takeSignInSettingsRequest: "automation:takeSignInSettingsRequest",
    previewStructureReport: "automation:previewStructureReport",
    openPreviewStructureReportIssue: "automation:openPreviewStructureReportIssue",
  },
  data: {
    getVersion: "data:getVersion",
    acknowledgeVersion: "data:acknowledgeVersion",
  },
} as const satisfies { readonly [Namespace in keyof OctopusBeakApi]?: { readonly [Method in keyof OctopusBeakApi[Namespace]]?: string } };

export type OctopusBeakInvokeChannels = typeof INVOKE_CHANNELS;

function invokers<Namespace extends keyof OctopusBeakInvokeChannels>(namespace: Namespace) {
  return Object.fromEntries(Object.entries(INVOKE_CHANNELS[namespace]).map(([method, channel]) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  ])) as unknown as Pick<OctopusBeakApi[Namespace], keyof OctopusBeakInvokeChannels[Namespace] & keyof OctopusBeakApi[Namespace]>;
}

const api: OctopusBeakApi = {
  display: {
    setScale(percent) {
      ipcRenderer.send("display:setScale", percent);
    },
  },
  settings: invokers("settings"),
  spending: invokers("spending"),
  automation: {
    ...invokers("automation"),
    onRuntimeChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: AutomationRuntimeSnapshot) => {
        listener(snapshot);
      };
      ipcRenderer.on("automation:runtime-changed", handler);
      return () => ipcRenderer.removeListener("automation:runtime-changed", handler);
    },
    onSignInSettingsRequested(listener) {
      const handler = () => listener();
      ipcRenderer.on("automation:sign-in-settings-requested", handler);
      return () => ipcRenderer.removeListener("automation:sign-in-settings-requested", handler);
    },
  },
  data: {
    ...invokers("data"),
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
