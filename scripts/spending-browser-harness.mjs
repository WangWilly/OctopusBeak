import net from "node:net";
import { createServer } from "vite";

const HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 8;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Unable to allocate a local browser harness port."));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function isAddressInUse(error) {
  return error?.code === "EADDRINUSE" || /address already in use|port .* in use/iu.test(String(error?.message ?? error));
}

/** Start a strict Vite server on an OS-selected port, with collision retry. */
export async function createSpendingViteServer() {
  let lastError;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = await freePort();
    let server;
    try {
      server = await createServer({
        server: { host: HOST, port, strictPort: true },
      });
      await server.listen();
      await server.watcher.close();
      return server;
    } catch (error) {
      lastError = error;
      await server?.close().catch(() => {});
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw lastError ?? new Error("Unable to start an isolated browser harness server.");
}

const settings = {
  systemTimezone: "Asia/Taipei",
  exchangeRateUpdateTime: "06:00",
};

const emptyOverview = {
  availability: "empty",
  coverage: "complete",
  historyAvailability: "unavailable",
  sourceGaps: [],
  importedAt: null,
  summary: [],
  dailyHistory: [],
  accounts: [],
  sankey: null,
  sankeyExchangeRates: [],
  sankeyLatestExchangeRateDate: null,
  exchangeRates: [],
  latestExchangeRateDate: null,
};

const emptyAssets = {
  availability: "empty",
  coverage: "complete",
  sourceGaps: [],
  importedAt: null,
  accounts: [],
  positionsByAccount: {},
  transactionsByAccount: {},
  dailyHistoryByAccount: {},
  dailyHistory: [],
};

const emptyLiabilities = {
  ...emptyAssets,
  marginAccounts: [],
};

const emptyAutomation = {
  automation: {
    businessDate: "2026-01-01",
    active: false,
    activeTaskCount: 0,
    parallelRunnableTaskIds: [],
    credentials: {},
    externalPrerequisiteNotices: [],
    tasks: [],
  },
  credentialGroups: [],
};

const currentDataVersion = {
  version: 0,
  stale: false,
  changedAt: null,
};

/**
 * Build the renderer-facing API used by spending browser checks.  Keeping the
 * full bridge shape here prevents unrelated shell startup reads from becoming
 * console errors while the test focuses on the Spending view.
 */
export function createSpendingDesktopApi(
  model,
  { spendingLoad } = {},
) {
  let version = { ...currentDataVersion };
  const spendingPage = model;
  const loadSpending = spendingLoad ?? (async () => spendingPage);
  const blockValue = async () => spendingPage;
  const noOp = async () => ({ ok: true });
  return {
    dataViews: {
      enabled: async () => true,
      subscribe: async (view, _params, onRows) => {
        const pages = {
          "financial.overview.current": emptyOverview,
          "financial.assets.current": emptyAssets,
          "financial.liabilities.current": emptyLiabilities,
          "financial.spending.current": spendingPage,
        };
        queueMicrotask(() => onRows([pages[view]]));
        return () => {};
      },
    },
    display: { setScale: () => {} },
    settings: {
      load: async () => settings,
      save: async (value) => value,
    },
    overview: {
      load: async () => emptyOverview,
      loadBlock: blockValue,
    },
    assets: {
      load: async () => emptyAssets,
      loadBlock: blockValue,
    },
    liabilities: {
      load: async () => emptyLiabilities,
      loadBlock: blockValue,
    },
    spending: {
      load: loadSpending,
      loadBlock: blockValue,
      loadRecordPage: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month ?? null, day: input.day ?? null, categoryCodes: null, query: null, basis: input.basis ?? null, records: [], nextCursor: null }),
      loadCandidatePage: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month ?? null, items: [], totalCandidateCount: 0, strongCandidateCount: 0, nextOffset: null }),
      cancelCandidatePage: async () => true,
      rankPairingCandidates: async (input) => ({
        dataVersion: input.dataVersion,
        candidates: [],
        totalCandidateCount: 0,
        nextOffset: null,
      }),
      prewarmPairingCandidates: async (input) => ({ dataVersion: input.dataVersion, reused: false }),
      loadPendingOverview: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, pendingCount: 0, strongCount: 0, affectedByCurrency: [], strongPairs: [] }),
      loadMonthInsight: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month, largestByCurrency: [] }),
      loadMerchantStats: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, purchaseId: input.purchaseId, month: "", merchant: null, merchantLabel: null, count: 0, totalsByCurrency: [] }),
      loadMergeLog: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, entries: [], nextCursor: null }),
      confirmStrongCandidates: async (input) => ({ status: "committed", baseKnowledgeAt: input.shownKnowledgeAt, knowledgeAt: input.shownKnowledgeAt, confirmed: [] }),
      setPurchaseCategory: async (input) => ({ purchaseId: input.purchaseId, subject: "transaction", categoryCode: input.categoryCode, baseKnowledgeAt: input.knowledgeAt, knowledgeAt: input.knowledgeAt }),
      confirmCandidate: noOp,
      denyCandidate: noOp,
      revokeLink: noOp,
      updateItemCategory: noOp,
      updateTransactionOverride: noOp,
    },
    automation: {
      load: async () => emptyAutomation,
      loadBlock: blockValue,
      saveCredentials: async () => ({ saved: true }),
      cathayGmailOtpStatus: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      enableCathayGmailOtp: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      setCathayGmailOtpEnabled: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      disconnectCathayGmailOtp: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      selectCertificateFile: async () => ({ cancelled: true }),
      openSetupGuideLink: async () => ({ ok: true }),
      run: async () => ({ started: "fixture" }),
      runMany: async () => ({ started: ["fixture"] }),
      resume: async () => ({ resumed: "fixture" }),
      cancel: async () => ({ cancelled: "fixture" }),
      runHistory: async () => [],
      openExternalPrerequisite: async () => ({ ok: true }),
      viewerScreenshot: async () => null,
      viewerInspect: async () => ({ editable: false, rect: null }),
      viewerInput: async () => ({ ok: true, contract: null, resumed: false }),
      viewerCompletionCheck: async () => ({ verified: false, contract: null }),
      forceQuit: async () => ({ ok: true, closed: true }),
    },
    data: {
      getVersion: async () => version,
      acknowledgeVersion: async (requestedVersion) => {
        if (requestedVersion === version.version) version = { ...version, stale: false };
        return version;
      },
      onInvalidated: () => () => {},
    },
  };
}

/** Serialize the same complete bridge for Playwright's isolated page world. */
export function spendingDesktopApiInitScript(model) {
  return `(${installSpendingDesktopApi.toString()})(${JSON.stringify(model)})`;
}

function installSpendingDesktopApi(model) {
  const fixtureSettings = {
    systemTimezone: "Asia/Taipei",
    exchangeRateUpdateTime: "06:00",
  };
  const fixtureOverview = {
    availability: "empty",
    coverage: "complete",
    historyAvailability: "unavailable",
    sourceGaps: [],
    importedAt: null,
    summary: [],
    dailyHistory: [],
    accounts: [],
    sankey: null,
    sankeyExchangeRates: [],
    sankeyLatestExchangeRateDate: null,
    exchangeRates: [],
    latestExchangeRateDate: null,
  };
  const fixtureAssets = {
    availability: "empty",
    coverage: "complete",
    sourceGaps: [],
    importedAt: null,
    accounts: [],
    positionsByAccount: {},
    transactionsByAccount: {},
    dailyHistoryByAccount: {},
    dailyHistory: [],
  };
  const fixtureLiabilities = { ...fixtureAssets, marginAccounts: [] };
  const fixtureAutomation = {
    automation: {
      businessDate: "2026-01-01",
      active: false,
      activeTaskCount: 0,
      parallelRunnableTaskIds: [],
      credentials: {},
      externalPrerequisiteNotices: [],
      tasks: [],
    },
    credentialGroups: [],
  };
  let version = { version: 0, stale: false, changedAt: null };
  const spendingPage = model;
  const blockValue = async () => spendingPage;
  const noOp = async () => ({ ok: true });
  window.__spendingLoadCount = 0;
  window.__spendingLiveSubscribeCount = 0;
  localStorage.setItem("octopusbeak-welcome-v1", JSON.stringify({
    version: 1,
    status: "bypassed",
    currentSlide: 1,
    bankAutomationChoice: null,
  }));
  window.octopusBeak = {
    dataViews: {
      enabled: async () => true,
      subscribe: async (view, _params, onRows) => {
        const pages = {
          "financial.overview.current": fixtureOverview,
          "financial.assets.current": fixtureAssets,
          "financial.liabilities.current": fixtureLiabilities,
          "financial.spending.current": spendingPage,
        };
        window.__spendingLiveSubscribeCount += 1;
        queueMicrotask(() => onRows([pages[view]]));
        return () => {};
      },
    },
    display: { setScale: () => {} },
    settings: {
      load: async () => fixtureSettings,
      save: async (value) => value,
    },
    overview: { load: async () => fixtureOverview, loadBlock: blockValue },
    assets: { load: async () => fixtureAssets, loadBlock: blockValue },
    liabilities: { load: async () => fixtureLiabilities, loadBlock: blockValue },
    spending: {
      load: async () => {
        window.__spendingLoadCount += 1;
        return spendingPage;
      },
      loadBlock: blockValue,
      loadRecordPage: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month ?? null, day: input.day ?? null, categoryCodes: null, query: null, basis: input.basis ?? null, records: [], nextCursor: null }),
      loadCandidatePage: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month ?? null, items: [], totalCandidateCount: 0, strongCandidateCount: 0, nextOffset: null }),
      cancelCandidatePage: async () => true,
      rankPairingCandidates: async (input) => ({ dataVersion: input.dataVersion, candidates: [], totalCandidateCount: 0, nextOffset: null }),
      prewarmPairingCandidates: async (input) => ({ dataVersion: input.dataVersion, reused: false }),
      loadPendingOverview: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, pendingCount: 0, strongCount: 0, affectedByCurrency: [], strongPairs: [] }),
      loadMonthInsight: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month, largestByCurrency: [] }),
      loadMerchantStats: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, purchaseId: input.purchaseId, month: "", merchant: null, merchantLabel: null, count: 0, totalsByCurrency: [] }),
      loadMergeLog: async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, entries: [], nextCursor: null }),
      confirmStrongCandidates: async (input) => ({ status: "committed", baseKnowledgeAt: input.shownKnowledgeAt, knowledgeAt: input.shownKnowledgeAt, confirmed: [] }),
      setPurchaseCategory: async (input) => ({ purchaseId: input.purchaseId, subject: "transaction", categoryCode: input.categoryCode, baseKnowledgeAt: input.knowledgeAt, knowledgeAt: input.knowledgeAt }),
      confirmCandidate: noOp,
      denyCandidate: noOp,
      revokeLink: noOp,
      updateItemCategory: noOp,
      updateTransactionOverride: noOp,
    },
    automation: {
      load: async () => fixtureAutomation,
      loadBlock: blockValue,
      saveCredentials: async () => ({ saved: true }),
      cathayGmailOtpStatus: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      enableCathayGmailOtp: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      setCathayGmailOtpEnabled: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      disconnectCathayGmailOtp: async () => ({ enabled: false, connectedEmail: null, needsAuthorization: false }),
      selectCertificateFile: async () => ({ cancelled: true }),
      openSetupGuideLink: async () => ({ ok: true }),
      run: async () => ({ started: "fixture" }),
      runMany: async () => ({ started: ["fixture"] }),
      resume: async () => ({ resumed: "fixture" }),
      cancel: async () => ({ cancelled: "fixture" }),
      runHistory: async () => [],
      openExternalPrerequisite: async () => ({ ok: true }),
      viewerScreenshot: async () => null,
      viewerInspect: async () => ({ editable: false, rect: null }),
      viewerInput: async () => ({ ok: true, contract: null, resumed: false }),
      viewerCompletionCheck: async () => ({ verified: false, contract: null }),
      forceQuit: async () => ({ ok: true, closed: true }),
    },
    data: {
      getVersion: async () => version,
      acknowledgeVersion: async (requestedVersion) => {
        if (requestedVersion === version.version) version = { ...version, stale: false };
        return version;
      },
      onInvalidated: () => () => {},
    },
  };
}
