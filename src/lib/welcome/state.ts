export const WELCOME_STORAGE_KEY = "octopusbeak-welcome-v1";

export type FirstRunWelcomeState = {
  version: 1;
  status: "active" | "completed" | "bypassed";
  currentSlide: 1 | 2 | 3 | 4 | 5 | 6;
  bankAutomationChoice: "start" | "later" | null;
};

export type FirstRunWelcomeAction =
  | { type: "confirm-language" }
  | { type: "activate-introduction" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "choose-bank-automation"; choice: "start" | "later" };

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export type FirstRunWelcomeAutomationTask = {
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
};

export type FirstRunWelcomeEligibilityFacts = {
  welcomeState: FirstRunWelcomeState | null;
  onboardingState: unknown | null;
  overview: {
    accounts: readonly unknown[];
    importedAt: string | null;
  } | null;
  automation: {
    tasks: readonly FirstRunWelcomeAutomationTask[];
  } | null;
};

export function createFirstRunWelcomeState(): FirstRunWelcomeState {
  return {
    version: 1,
    status: "active",
    currentSlide: 1,
    bankAutomationChoice: null,
  };
}

export function readFirstRunWelcomeState(
  storage: StorageReader = localStorage,
): FirstRunWelcomeState | null {
  try {
    const value = JSON.parse(storage.getItem(WELCOME_STORAGE_KEY) ?? "null");
    if (!isFirstRunWelcomeState(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeFirstRunWelcomeState(
  storage: StorageWriter = localStorage,
  state: FirstRunWelcomeState,
) {
  storage.setItem(WELCOME_STORAGE_KEY, JSON.stringify(state));
}

export function shouldShowFirstRunWelcome(facts: FirstRunWelcomeEligibilityFacts) {
  if (facts.welcomeState || facts.onboardingState) return false;
  if (facts.overview?.accounts.length || facts.overview?.importedAt) return false;
  return !facts.automation?.tasks.some(
    (task) => Boolean(task.latestStartedAt || task.latestFinishedAt),
  );
}

export function reduceFirstRunWelcome(
  state: FirstRunWelcomeState,
  action: FirstRunWelcomeAction,
): FirstRunWelcomeState {
  if (state.status !== "active") return state;

  if (action.type === "confirm-language") {
    return state.currentSlide === 1 ? { ...state, currentSlide: 2 } : state;
  }

  if (action.type === "activate-introduction") {
    return state.currentSlide === 2 ? { ...state, currentSlide: 3 } : state;
  }

  if (action.type === "previous") {
    return state.currentSlide === 1
      ? state
      : { ...state, currentSlide: (state.currentSlide - 1) as FirstRunWelcomeState["currentSlide"] };
  }

  if (action.type === "next") {
    return state.currentSlide < 3 || state.currentSlide >= 6
      ? state
      : { ...state, currentSlide: (state.currentSlide + 1) as FirstRunWelcomeState["currentSlide"] };
  }

  if (action.type === "choose-bank-automation") {
    return state.currentSlide === 6
      ? { ...state, status: "completed", bankAutomationChoice: action.choice }
      : state;
  }

  return state;
}

function isFirstRunWelcomeState(value: unknown): value is FirstRunWelcomeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "bankAutomationChoice,currentSlide,status,version") return false;
  const validShape = record.version === 1
    && (record.status === "active" || record.status === "completed" || record.status === "bypassed")
    && (record.currentSlide === 1
      || record.currentSlide === 2
      || record.currentSlide === 3
      || record.currentSlide === 4
      || record.currentSlide === 5
      || record.currentSlide === 6)
    && (record.bankAutomationChoice === null
      || record.bankAutomationChoice === "start"
      || record.bankAutomationChoice === "later");
  if (!validShape) return false;
  return record.status === "completed"
    ? record.bankAutomationChoice === "start" || record.bankAutomationChoice === "later"
    : record.bankAutomationChoice === null;
}
