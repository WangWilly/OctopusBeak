import assert from "node:assert/strict";
import test from "node:test";
import {
  WELCOME_STORAGE_KEY,
  createFirstRunWelcomeState,
  reduceFirstRunWelcome,
  readFirstRunWelcomeState,
  resolveFirstRunWelcomeBoot,
  shouldShowFirstRunWelcome,
  writeFirstRunWelcomeState,
  type FirstRunWelcomeEligibilityFacts,
  type FirstRunWelcomeState,
} from "./state.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("creates and persists the resumable Welcome state", () => {
  const storage = new MemoryStorage();
  const state = createFirstRunWelcomeState();

  assert.deepEqual(state, {
    version: 1,
    status: "active",
    currentSlide: 1,
    bankAutomationChoice: null,
  });
  writeFirstRunWelcomeState(storage, state);
  assert.deepEqual(readFirstRunWelcomeState(storage), state);
  assert.equal(storage.getItem(WELCOME_STORAGE_KEY), JSON.stringify(state));
});

test("rejects malformed or future Welcome state records", () => {
  const storage = new MemoryStorage();
  const invalidRecords = [
    "not-json",
    JSON.stringify({ version: 2, status: "active", currentSlide: 1, bankAutomationChoice: null }),
    JSON.stringify({ version: 1, status: "active", currentSlide: 0, bankAutomationChoice: null }),
    JSON.stringify({ version: 1, status: "active", currentSlide: 7, bankAutomationChoice: null }),
    JSON.stringify({ version: 1, status: "active", currentSlide: 1, bankAutomationChoice: "never" }),
    JSON.stringify({ version: 1, status: "active", currentSlide: 1, bankAutomationChoice: null, extra: true }),
    JSON.stringify({ version: 1, status: "active", currentSlide: 1, bankAutomationChoice: "later" }),
    JSON.stringify({ version: 1, status: "completed", currentSlide: 6, bankAutomationChoice: null }),
    JSON.stringify({ version: 1, status: "bypassed", currentSlide: 1, bankAutomationChoice: "start" }),
  ];

  for (const record of invalidRecords) {
    storage.setItem(WELCOME_STORAGE_KEY, record);
    assert.equal(readFirstRunWelcomeState(storage), null);
  }
});

const emptyEligibilityFacts = (): FirstRunWelcomeEligibilityFacts => ({
  welcomeState: null,
  onboardingState: null,
  overview: null,
  automation: null,
});

test("shows Welcome only for a genuinely empty installation", () => {
  assert.equal(shouldShowFirstRunWelcome(emptyEligibilityFacts()), true);

  const existingWelcome = emptyEligibilityFacts();
  existingWelcome.welcomeState = createFirstRunWelcomeState();
  assert.equal(shouldShowFirstRunWelcome(existingWelcome), false);

  for (const status of ["active", "paused", "completed"]) {
    const existingOnboarding = emptyEligibilityFacts();
    existingOnboarding.onboardingState = { version: 2, status };
    assert.equal(shouldShowFirstRunWelcome(existingOnboarding), false);
  }

  const existingAccount = emptyEligibilityFacts();
  existingAccount.overview = { accounts: [{ id: "cash" }], importedAt: null };
  assert.equal(shouldShowFirstRunWelcome(existingAccount), false);

  const importedOverview = emptyEligibilityFacts();
  importedOverview.overview = { accounts: [], importedAt: "2026-08-07T00:00:00.000Z" };
  assert.equal(shouldShowFirstRunWelcome(importedOverview), false);

  for (const history of [
    { id: "fubon-all-statements", kind: "crawler" as const, latestStartedAt: "2026-08-07T00:00:00.000Z", latestFinishedAt: null },
    { id: "import-downloads-csv", kind: "import" as const, latestStartedAt: null, latestFinishedAt: "2026-08-07T00:01:00.000Z" },
  ]) {
    const existingAutomation = emptyEligibilityFacts();
    existingAutomation.automation = { tasks: [history] };
    assert.equal(shouldShowFirstRunWelcome(existingAutomation), false);
  }

  const queuedAutomation = emptyEligibilityFacts();
  queuedAutomation.automation = { tasks: [{ id: "fubon-all-statements", kind: "crawler", latestStartedAt: null, latestFinishedAt: null }] };
  assert.equal(shouldShowFirstRunWelcome(queuedAutomation), true);
});

test("ignores system-maintenance history when identifying an existing user", () => {
  const maintenanceOnly = emptyEligibilityFacts();
  maintenanceOnly.automation = { tasks: [{
    id: "exchange-rates",
    kind: "sync",
    latestStartedAt: "2026-08-07T07:26:16.023Z",
    latestFinishedAt: "2026-08-07T07:26:16.459Z",
  }] };

  assert.equal(shouldShowFirstRunWelcome(maintenanceOnly), true);
  assert.deepEqual(resolveFirstRunWelcomeBoot(maintenanceOnly), createFirstRunWelcomeState());
});

test("resolves first-use boot to a resumable Welcome or a durable bypass", () => {
  const active = activeAt(4);
  assert.deepEqual(resolveFirstRunWelcomeBoot({
    ...emptyEligibilityFacts(),
    welcomeState: active,
  }), active);

  const completed: FirstRunWelcomeState = {
    ...activeAt(6),
    status: "completed",
    bankAutomationChoice: "later",
  };
  assert.deepEqual(resolveFirstRunWelcomeBoot({
    ...emptyEligibilityFacts(),
    welcomeState: completed,
  }), completed);

  assert.deepEqual(
    resolveFirstRunWelcomeBoot(emptyEligibilityFacts()),
    createFirstRunWelcomeState(),
  );

  const existingUser = emptyEligibilityFacts();
  existingUser.automation = {
    tasks: [{ id: "sync-maicoin", kind: "sync", latestStartedAt: "2026-08-07T00:00:00.000Z", latestFinishedAt: null }],
  };
  assert.deepEqual(resolveFirstRunWelcomeBoot(existingUser), {
    version: 1,
    status: "bypassed",
    currentSlide: 1,
    bankAutomationChoice: null,
  });
});

const activeAt = (currentSlide: FirstRunWelcomeState["currentSlide"]): FirstRunWelcomeState => ({
  version: 1,
  status: "active",
  currentSlide,
  bankAutomationChoice: null,
});

test("gates the narrative slides and supports bounded navigation", () => {
  const first = activeAt(1);
  assert.deepEqual(reduceFirstRunWelcome(first, { type: "next" }), first);
  assert.equal(reduceFirstRunWelcome(first, { type: "confirm-language" }).currentSlide, 2);

  const second = activeAt(2);
  assert.deepEqual(reduceFirstRunWelcome(second, { type: "confirm-language" }), second);
  assert.equal(reduceFirstRunWelcome(second, { type: "activate-introduction" }).currentSlide, 3);

  const third = activeAt(3);
  assert.equal(reduceFirstRunWelcome(third, { type: "next" }).currentSlide, 4);
  assert.equal(reduceFirstRunWelcome(third, { type: "previous" }).currentSlide, 2);

  const sixth = activeAt(6);
  assert.deepEqual(reduceFirstRunWelcome(sixth, { type: "next" }), sixth);
  assert.equal(reduceFirstRunWelcome(sixth, { type: "previous" }).currentSlide, 5);
});

test("completes Welcome only after an explicit bank automation choice", () => {
  const slideSix = activeAt(6);
  const start = reduceFirstRunWelcome(slideSix, {
    type: "choose-bank-automation",
    choice: "start",
  });
  assert.deepEqual(start, {
    ...slideSix,
    status: "completed",
    bankAutomationChoice: "start",
  });

  const later = reduceFirstRunWelcome(slideSix, {
    type: "choose-bank-automation",
    choice: "later",
  });
  assert.deepEqual(later, {
    ...slideSix,
    status: "completed",
    bankAutomationChoice: "later",
  });
  assert.deepEqual(reduceFirstRunWelcome(later, { type: "previous" }), later);
});
