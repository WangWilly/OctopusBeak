import { contextBridge, ipcRenderer } from "electron";
import type {
  DataViewErrorEvent,
  DataViewValueEvent,
  DataViewSubscribeResult,
  DataViewUnsubscribeResult,
  OctopusBeakApi,
  AutomationRuntimeSnapshot,
} from "../src/lib/desktop/api.ts";
import type { AppUpdateView } from "../src/lib/settings/app-updates.ts";
import type { DataInvalidationEvent } from "../src/lib/shared-shell/data-version.ts";

/** The payload each main-process broadcast carries to every window (electron/broadcast.ts). */
export type OctopusBeakPushEvents = {
  "data:invalidated": DataInvalidationEvent;
  "automation:runtime-changed": AutomationRuntimeSnapshot;
  "automation:notification-target-requested": undefined;
  "appUpdates:changed": AppUpdateView;
};

/** The one fire-and-forget channel the renderer sends on. */
export type OctopusBeakSendChannel = "display:setScale";

const DATA_VIEW_CHANNELS = {
  enabled: "data-views:enabled",
  subscribe: "data-views:subscribe",
  unsubscribe: "data-views:unsubscribe",
  value: "data-views:value",
  error: "data-views:error",
} as const;

export type OctopusBeakDataViewChannels = typeof DATA_VIEW_CHANNELS;

function onPush<Channel extends keyof OctopusBeakPushEvents>(
  channel: Channel,
  listener: (payload: OctopusBeakPushEvents[Channel]) => void,
) {
  const handler = (_event: Electron.IpcRendererEvent, payload: OctopusBeakPushEvents[Channel]) => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

let nextDataViewRequestId = 1;

function dataViewError(result: { code: string; message: string }): Error {
  const error = new Error(result.message);
  Object.assign(error, { code: result.code });
  return error;
}

const dataViews = {
  enabled: () => ipcRenderer.invoke(DATA_VIEW_CHANNELS.enabled),
  subscribe(view: string, params: object, onValue: (value: unknown) => void, onError?: (error: DataViewErrorEvent) => void) {
    const requestId = `renderer-view-${nextDataViewRequestId++}`;
    const removeListeners = () => {
      ipcRenderer.removeListener(DATA_VIEW_CHANNELS.value, valueHandler);
      ipcRenderer.removeListener(DATA_VIEW_CHANNELS.error, errorHandler);
    };
    const valueHandler = (_event: Electron.IpcRendererEvent, event: DataViewValueEvent) => {
      if (event.requestId === requestId) {
        onValue(event.value);
      }
    };
    const errorHandler = (_event: Electron.IpcRendererEvent, event: DataViewErrorEvent) => {
      if (event.requestId === requestId) {
        removeListeners();
        onError?.(event);
      }
    };
    ipcRenderer.on(DATA_VIEW_CHANNELS.value, valueHandler);
    ipcRenderer.on(DATA_VIEW_CHANNELS.error, errorHandler);
    return ipcRenderer.invoke(DATA_VIEW_CHANNELS.subscribe, { requestId, view, params })
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
            DATA_VIEW_CHANNELS.unsubscribe,
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
  appUpdates: {
    view: "appUpdates:view",
    check: "appUpdates:check",
    download: "appUpdates:download",
    restart: "appUpdates:restart",
  },
  errorReports: {
    available: "errorReports:available",
    preview: "errorReports:preview",
    send: "errorReports:send",
  },
  settings: {
    load: "settings:load",
    save: "settings:save",
    previewUsagePing: "settings:previewUsagePing",
    shouldAskUsageStatistics: "settings:shouldAskUsageStatistics",
    answerUsageStatistics: "settings:answerUsageStatistics",
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
    takeNotificationTarget: "automation:takeNotificationTarget",
    previewStructureReport: "automation:previewStructureReport",
    openPreviewStructureReportIssue: "automation:openPreviewStructureReportIssue",
  },
  manualAssets: {
    apply: "financial.manualAssets.apply",
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
      ipcRenderer.send("display:setScale" satisfies OctopusBeakSendChannel, percent);
    },
  },
  settings: invokers("settings"),
  appUpdates: {
    ...invokers("appUpdates"),
    onChanged: (listener) => onPush("appUpdates:changed", listener),
  },
  errorReports: invokers("errorReports"),
  spending: invokers("spending"),
  manualAssets: invokers("manualAssets"),
  automation: {
    ...invokers("automation"),
    onRuntimeChanged: (listener) => onPush("automation:runtime-changed", listener),
    onNotificationTargetRequested: (listener) => onPush("automation:notification-target-requested", () => listener()),
  },
  data: {
    ...invokers("data"),
    onInvalidated: (listener) => onPush("data:invalidated", listener),
  },
  dataViews,
};

contextBridge.exposeInMainWorld("octopusBeak", api);
