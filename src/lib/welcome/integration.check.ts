import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("completion updates the destination URL and normalizes the route exactly once", async () => {
  const page = await readFile(new URL("../../routes/+page.svelte", import.meta.url), "utf8");
  const navigation = page.match(/function navigateToRoute\(nextRoute: RouteId\) \{([\s\S]*?)\n  \}/)?.[1];
  const completion = page.match(/function completeFirstRunWelcome\(\) \{([\s\S]*?)\n  \}/)?.[1];

  assert.ok(navigation);
  assert.ok(completion);
  assert.match(navigation, /const destinationHash = `#\/\$\{nextRoute\}`;/);
  assert.match(navigation, /if \(location\.hash !== destinationHash\) history\.pushState\(history\.state, "", destinationHash\);/);
  assert.equal(navigation.match(/normalizeRoute\(\)/g)?.length, 1);
  assert.match(completion, /navigateToRoute\(destination\.route\);/);
  assert.doesNotMatch(completion, /location\.hash|normalizeRoute\(\)/);
});
