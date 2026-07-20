export type DataIssueStatus = "open" | "investigating" | "resolved" | "restored";
export type PrototypeScenario = "safe" | "blocked" | "failure";
export type PrototypeScreen =
  | "list"
  | "diagnosis"
  | "preview"
  | "blocked"
  | "failure"
  | "working"
  | "success"
  | "audit"
  | "restore-preview"
  | "restored";

export type DataIssueReportContext = {
  accountId: string;
  accountLabel: string;
  institution: string;
  fieldKey: "balance";
  displayedValue: number;
  currency: string;
  dataDate: string;
  note: string;
};

export type PrototypeImport = {
  id: string;
  fileName: string;
  importedAt: string;
  csvRows: number;
  insertedRows: number;
  duplicateRows: number;
  affectedAccounts: number;
};

export type PrototypePreview = {
  beforeValue: number;
  afterValue: number;
  activeRowsBefore: number;
  activeRowsAfter: number;
  excludedRows: number;
  retainedRows: number;
  unresolvedRows: number;
};

export type DataIssuePrototypeState = {
  screen: PrototypeScreen;
  issue: DataIssueReportContext & {
    id: string;
    status: DataIssueStatus;
    createdAt: string;
  };
  imports: PrototypeImport[];
  selectedSourceId: string | null;
  scenario: PrototypeScenario;
  preview: PrototypePreview | null;
  reason: string;
  acknowledged: boolean;
  currentValue: number;
  audit: Array<{
    action: "invalidated" | "restored";
    reason: string;
    at: string;
  }>;
};

export type PrototypeEvent =
  | { type: "open-diagnosis" }
  | { type: "select-source"; sourceId: string }
  | { type: "preview"; scenario: PrototypeScenario }
  | { type: "set-reason"; reason: string }
  | { type: "acknowledge"; acknowledged: boolean }
  | { type: "start-quarantine" }
  | { type: "complete-quarantine" }
  | { type: "show-audit" }
  | { type: "preview-restore" }
  | { type: "confirm-restore" }
  | { type: "back-to-diagnosis" }
  | { type: "back-to-list" };

const safePreview: PrototypePreview = {
  beforeValue: 520_524,
  afterValue: 354_107,
  activeRowsBefore: 78,
  activeRowsAfter: 72,
  excludedRows: 6,
  retainedRows: 66,
  unresolvedRows: 0,
};

export function seedDataIssuePrototype(): DataIssuePrototypeState {
  return {
    screen: "list",
    issue: {
      id: "issue-demo-1",
      status: "open",
      accountId: "loan-demo-1100",
      accountLabel: "萬華 - 信貸中放 - **********1100",
      institution: "元大銀行",
      fieldKey: "balance",
      displayedValue: 520_524,
      currency: "TWD",
      dataDate: "2026-07-13",
      note: "實際剩餘本金應為 354,107",
      createdAt: "2026-07-20 11:30",
    },
    imports: [
      {
        id: "reported-import",
        fileName: "loan-statements-<reported-import>.csv",
        importedAt: "2026-07-20 02:46",
        csvRows: 72,
        insertedRows: 6,
        duplicateRows: 66,
        affectedAccounts: 2,
      },
    ],
    selectedSourceId: null,
    scenario: "safe",
    preview: null,
    reason: "",
    acknowledged: false,
    currentValue: 520_524,
    audit: [],
  };
}

export function reportDataIssue(
  state: DataIssuePrototypeState,
  report: DataIssueReportContext,
): DataIssuePrototypeState {
  return {
    ...state,
    screen: "diagnosis",
    issue: {
      ...report,
      id: "issue-reported",
      status: "open",
      createdAt: "剛剛",
    },
    currentValue: report.displayedValue,
  };
}

export function canConfirmQuarantine(state: DataIssuePrototypeState) {
  return (
    state.screen === "preview" &&
    state.preview?.unresolvedRows === 0 &&
    state.reason.trim().length > 0 &&
    state.acknowledged
  );
}

export function transitionDataIssuePrototype(
  state: DataIssuePrototypeState,
  event: PrototypeEvent,
): DataIssuePrototypeState {
  if (event.type === "open-diagnosis") {
    return {
      ...state,
      screen: "diagnosis",
      issue: { ...state.issue, status: "investigating" },
    };
  }
  if (event.type === "select-source") {
    return { ...state, selectedSourceId: event.sourceId };
  }
  if (event.type === "preview") {
    if (!state.selectedSourceId) return state;
    if (event.scenario === "blocked") {
      return {
        ...state,
        scenario: event.scenario,
        screen: "blocked",
        preview: { ...safePreview, unresolvedRows: 1 },
      };
    }
    if (event.scenario === "failure") {
      return {
        ...state,
        scenario: event.scenario,
        screen: "failure",
        preview: null,
      };
    }
    return {
      ...state,
      scenario: event.scenario,
      screen: "preview",
      preview: safePreview,
    };
  }
  if (event.type === "set-reason") return { ...state, reason: event.reason };
  if (event.type === "acknowledge") {
    return { ...state, acknowledged: event.acknowledged };
  }
  if (event.type === "start-quarantine" && canConfirmQuarantine(state)) {
    return { ...state, screen: "working" };
  }
  if (event.type === "complete-quarantine" && state.screen === "working") {
    return {
      ...state,
      screen: "success",
      issue: { ...state.issue, status: "resolved" },
      currentValue: state.preview?.afterValue ?? state.currentValue,
      audit: [
        ...state.audit,
        {
          action: "invalidated",
          reason: state.reason.trim(),
          at: "剛剛",
        },
      ],
    };
  }
  if (event.type === "show-audit") return { ...state, screen: "audit" };
  if (event.type === "preview-restore") {
    return { ...state, screen: "restore-preview" };
  }
  if (event.type === "confirm-restore") {
    return {
      ...state,
      screen: "restored",
      issue: { ...state.issue, status: "restored" },
      currentValue: 520_524,
      audit: [
        ...state.audit,
        {
          action: "restored",
          reason: "使用者還原 prototype 匯入",
          at: "剛剛",
        },
      ],
    };
  }
  if (event.type === "back-to-diagnosis") {
    return {
      ...state,
      screen: "diagnosis",
      preview: null,
      reason: "",
      acknowledged: false,
    };
  }
  if (event.type === "back-to-list") return { ...state, screen: "list" };
  return state;
}
