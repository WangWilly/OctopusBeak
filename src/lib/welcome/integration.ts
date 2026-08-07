import { createOnboardingState, type OnboardingState } from "../onboarding/state.ts";
import type { FirstRunWelcomeState } from "./state.ts";

export type CompletedFirstRunWelcomeDestination = {
  route: "automation" | "overview";
  onboardingState: OnboardingState | null;
};

export function resolveCompletedFirstRunWelcome(
  state: FirstRunWelcomeState,
): CompletedFirstRunWelcomeDestination | null {
  if (state.status !== "completed" || !state.bankAutomationChoice) return null;
  return state.bankAutomationChoice === "start"
    ? { route: "automation", onboardingState: createOnboardingState() }
    : { route: "overview", onboardingState: null };
}
