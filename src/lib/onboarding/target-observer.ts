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
