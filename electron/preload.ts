import { contextBridge, ipcRenderer, webFrame } from "electron";
import type {
  FinancialFreshnessEvent,
  FinancialPageLoadInput,
  OctopusBeakApi,
} from "../src/lib/desktop/api.ts";
import type { SpendingLoadInput } from "../src/lib/spending/server/store.ts";
import type { FinancialSection } from "../src/lib/shared-ledger/financial-section.ts";

function displayScaleZoomFactor(percent: number) {
  if (!Number.isFinite(percent)) throw new TypeError("Display scale must be finite.");
  return Math.min(1.5, Math.max(0.75, percent / 100));
}

function knowledgePointFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function financialFreshnessEventFrom(
  value: unknown,
): FinancialFreshnessEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const knowledgePoint = knowledgePointFrom(record.knowledgePoint);
  return knowledgePoint === null || Object.keys(record).length !== 1
    ? null
    : Object.freeze({ knowledgePoint });
}

function cutoffFrom(value: unknown): { knowledgePoint: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Financial query cutoff must be an object.");
  }
  const record = value as Record<string, unknown>;
  const knowledgePoint = knowledgePointFrom(record.knowledgePoint);
  if (knowledgePoint === null || Object.keys(record).length !== 1) {
    throw new TypeError(
      "Financial query cutoff must contain a non-negative safe integer knowledge point.",
    );
  }
  return Object.freeze({ knowledgePoint });
}

function financialSectionFrom(value: unknown): FinancialSection {
  if (value !== "primary" && value !== "secondary") {
    throw new TypeError("Financial section must be primary or secondary.");
  }
  return value;
}

function financialPageLoadInputFrom(
  value: unknown,
): FinancialPageLoadInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Financial page load input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "cutoff")) {
    throw new TypeError("Financial page load input contains an unknown field.");
  }
  const cutoff = cutoffFrom(record.cutoff);
  return cutoff === undefined ? {} : Object.freeze({ cutoff });
}

function spendingLoadInputFrom(value: unknown): SpendingLoadInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Spending load input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) =>
    key !== "selectedMonth" && key !== "selectedCategory" && key !== "cutoff"
  )) {
    throw new TypeError("Spending load input contains an unknown field.");
  }
  if (record.selectedMonth !== undefined && typeof record.selectedMonth !== "string") {
    throw new TypeError("Spending selected month must be a string.");
  }
  if (record.selectedCategory !== undefined && typeof record.selectedCategory !== "string") {
    throw new TypeError("Spending selected category must be a string.");
  }
  const cutoff = cutoffFrom(record.cutoff);
  return {
    ...(record.selectedMonth === undefined ? {} : { selectedMonth: record.selectedMonth }),
    ...(record.selectedCategory === undefined ? {} : { selectedCategory: record.selectedCategory }),
    ...(cutoff === undefined ? {} : { cutoff }),
  } as SpendingLoadInput;
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
    load: (input) => ipcRenderer.invoke("overview:load", financialPageLoadInputFrom(input)),
    loadSection: (section, input) => ipcRenderer.invoke(
      "overview:section:load",
      financialSectionFrom(section),
      financialPageLoadInputFrom(input),
    ),
  },
  assets: {
    load: (input) => ipcRenderer.invoke("assets:load", financialPageLoadInputFrom(input)),
    loadSection: (section, input) => ipcRenderer.invoke(
      "assets:section:load",
      financialSectionFrom(section),
      financialPageLoadInputFrom(input),
    ),
  },
  liabilities: {
    load: (input) => ipcRenderer.invoke("liabilities:load", financialPageLoadInputFrom(input)),
    loadSection: (section, input) => ipcRenderer.invoke(
      "liabilities:section:load",
      financialSectionFrom(section),
      financialPageLoadInputFrom(input),
    ),
  },
  financialFreshness: {
    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("Financial freshness listener must be a function.");
      }
      const onEvent = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const event = financialFreshnessEventFrom(payload);
        if (event) listener(event);
      };
      ipcRenderer.on("financialFreshness:changed", onEvent);
      return () => {
        ipcRenderer.removeListener("financialFreshness:changed", onEvent);
      };
    },
    async latestKnowledgePoint() {
      const value = await ipcRenderer.invoke(
        "financialFreshness:latestKnowledgePoint",
      );
      const knowledgePoint = knowledgePointFrom(value);
      if (knowledgePoint === null) {
        throw new Error("Financial freshness response is invalid.");
      }
      return knowledgePoint;
    },
  },
  spending: {
    load: (input) => ipcRenderer.invoke("spending:load", spendingLoadInputFrom(input)),
    loadSection: (section, input) => ipcRenderer.invoke(
      "spending:section:load",
      financialSectionFrom(section),
      spendingLoadInputFrom(input),
    ),
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
};

contextBridge.exposeInMainWorld("octopusBeak", api);
