import assert from "node:assert/strict";
import test from "node:test";

import { resolveCompletedFirstRunWelcome } from "./integration.ts";
import type { FirstRunWelcomeState } from "./state.ts";

const completed = (bankAutomationChoice: "start" | "later"): FirstRunWelcomeState => ({
  version: 1,
  status: "completed",
  currentSlide: 6,
  bankAutomationChoice,
});

test("routes Start setup into a newly-created bank onboarding progression", () => {
  assert.deepEqual(resolveCompletedFirstRunWelcome(completed("start")), {
    route: "automation",
    onboardingState: {
      version: 2,
      status: "active",
      selectedCredentialGroupId: null,
      sourceConfiguredAt: null,
    },
  });
});

test("routes Maybe later to Overview without creating bank onboarding", () => {
  assert.deepEqual(resolveCompletedFirstRunWelcome(completed("later")), {
    route: "overview",
    onboardingState: null,
  });
});

test("does not resolve an active or bypassed Welcome as completed", () => {
  assert.equal(resolveCompletedFirstRunWelcome({
    version: 1,
    status: "active",
    currentSlide: 6,
    bankAutomationChoice: null,
  }), null);
  assert.equal(resolveCompletedFirstRunWelcome({
    version: 1,
    status: "bypassed",
    currentSlide: 1,
    bankAutomationChoice: null,
  }), null);
});
