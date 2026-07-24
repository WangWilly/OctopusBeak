import type { OnboardingTarget } from "./progression.ts";

export function selectorForOnboardingTarget(target: OnboardingTarget | null) {
  if (!target) return null;
  if (target.kind === "automation-nav") return '[data-onboarding="nav-automation"]';
  if (target.kind === "credentials") return '[data-onboarding="automation-credentials"]';
  if (target.kind === "assist") return '[data-onboarding="automation-assist"]';
  if (target.kind === "overview-nav") return '[data-onboarding="nav-overview"]';
  if (target.kind === "complete") return '[data-onboarding="overview-summary"]';
  if (target.kind === "overview-empty") {
    return target.route === "automation"
      ? '[data-onboarding-task="import-downloads-csv"][data-onboarding-action="logs"]'
      : '[data-onboarding="nav-automation"]';
  }
  return `[data-onboarding-group="${target.taskId}"][data-onboarding-action="${target.action}"],`
    + `[data-onboarding-task="${target.taskId}"][data-onboarding-action="${target.action}"]`;
}

export function activateOnboardingTarget(target: HTMLElement) {
  target.focus();
  const action = target.dataset.onboardingAction;
  if (action === "enter-credentials") {
    if (target instanceof HTMLInputElement && target.value.trim()) {
      target.dispatchEvent(new CustomEvent("onboardingadvance", { bubbles: true }));
    }
    return;
  }
  if (action !== "choose-verification-control" && action !== "select-source") target.click();
}

export function observeOnboardingTarget(
  selector: string | null,
  onTarget: (target: HTMLElement | null) => void,
) {
  const locate = () => {
    onTarget(selector ? document.querySelector<HTMLElement>(selector) : null);
  };
  locate();
  if (!selector) return () => {};

  const observer = new MutationObserver(locate);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-onboarding"],
  });
  return () => observer.disconnect();
}
