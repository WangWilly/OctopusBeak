export function activateOnboardingTarget(target: HTMLElement) {
  target.focus();
  if (target.dataset.onboardingAction !== "choose-verification-control") target.click();
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
