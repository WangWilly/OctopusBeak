<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { t, type Translation } from "$lib/i18n/i18n.ts";
  import {
    onboardingCopyKey,
    onboardingStepNumber,
    targetForOnboardingStep,
    type OnboardingCopyKey,
    type OnboardingContext,
    type OnboardingState,
    type OnboardingStep,
  } from "./state.ts";
  import { activateOnboardingTarget, observeOnboardingTarget } from "./target-observer.ts";
  import { placeOnboardingCoach } from "./placement.ts";

  export let step: OnboardingStep;
  export let state: OnboardingState;
  export let route: OnboardingContext["route"];
  export let onPause: () => void;
  export let onFinish: () => void;
  export let onAddSource: () => void;
  export let onBack: () => void;
  export let onRetryTarget: () => void;
  export let compact = false;

  let target: HTMLElement | null = null;
  let targetRect: DOMRect | null = null;
  let obstacleRects: DOMRect[] = [];
  let coachWidth = 0;
  let coachHeight = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let listening = false;
  let rootOverflow = "";
  let bodyOverflow = "";
  let stopObserving = () => {};
  let watchedSelector: string | null | undefined;
  let announcement = "";

  $: visible = step !== "hidden";
  $: key = visible ? onboardingCopyKey(step) : null;
  $: copy = key ? coachCopy($t, key, target?.dataset.onboardingAction) : null;
  $: title = copy?.title ?? "";
  $: body = copy?.body ?? "";
  $: current = onboardingStepNumber(step);
  $: coachPosition = targetRect && coachWidth && coachHeight
    ? placeOnboardingCoach(
      targetRect,
      { width: coachWidth, height: coachHeight },
      { width: viewportWidth, height: viewportHeight },
      obstacleRects,
    )
    : null;
  $: watchTarget(visible ? targetForOnboardingStep(step, state, route) : null);
  $: if (visible) announce(title);

  async function announce(value: string) {
    announcement = "";
    await tick();
    announcement = value;
  }

  function coachCopy(
    dictionary: Translation,
    copyKey: OnboardingCopyKey,
    targetAction?: string,
  ) {
    const copies = {
      automation: { title: dictionary.onboarding.automationTitle, body: dictionary.onboarding.automationBody },
      credentials: { title: dictionary.onboarding.credentialsTitle, body: dictionary.onboarding.credentialsBody },
      collection: { title: dictionary.onboarding.collectionTitle, body: dictionary.onboarding.collectionBody },
      assist: { title: dictionary.onboarding.assistTitle, body: dictionary.onboarding.assistBody },
      collectionFailed: { title: dictionary.onboarding.collectionFailedTitle, body: dictionary.onboarding.collectionFailedBody },
      import: { title: dictionary.onboarding.importTitle, body: dictionary.onboarding.importBody },
      importFailed: { title: dictionary.onboarding.importFailedTitle, body: dictionary.onboarding.importFailedBody },
      overview: { title: dictionary.onboarding.overviewTitle, body: dictionary.onboarding.overviewBody },
      overviewEmpty: { title: dictionary.onboarding.overviewEmptyTitle, body: dictionary.onboarding.overviewEmptyBody },
      complete: { title: dictionary.onboarding.completeTitle, body: dictionary.onboarding.completeBody },
    } satisfies Record<OnboardingCopyKey, { title: string; body: string }>;
    if (copyKey === "credentials") {
      if (targetAction === "select-source") return dictionary.onboarding.chooseSourceCopy;
      if (targetAction === "enable-source") return dictionary.onboarding.enableSourceCopy;
      if (targetAction === "enter-credentials") return dictionary.onboarding.enterCredentialsCopy;
      if (targetAction === "select-statements") return dictionary.onboarding.selectStatementsCopy;
      if (targetAction === "save-credentials") return dictionary.onboarding.saveCredentialsCopy;
    }
    if (copyKey === "assist") {
      if (targetAction === "open-assist") return dictionary.onboarding.openAssistCopy;
      if (targetAction === "choose-verification-control") return dictionary.onboarding.chooseVerificationCopy;
      if (targetAction === "enter-verification") return dictionary.onboarding.enterVerificationCopy;
      if (targetAction === "resume-collection") return dictionary.onboarding.resumeCollectionCopy;
    }
    return copies[copyKey];
  }

  function watchTarget(selector: string | null) {
    if (selector === watchedSelector) return;
    watchedSelector = selector;
    stopObserving();
    stopObserving = () => {};
    target = null;
    targetRect = null;
    obstacleRects = [];
    if (!selector) {
      stopListening();
      return;
    }
    stopObserving = observeOnboardingTarget(selector, (nextTarget) => {
      if (nextTarget && nextTarget !== target) {
        nextTarget.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "center",
          inline: "center",
        });
      }
      target = nextTarget;
      updateRect();
    });
    if (!listening) {
      addEventListener("resize", updateRect);
      addEventListener("scroll", updateRect, true);
      addEventListener("animationend", updateRect, true);
      rootOverflow = document.documentElement.style.overflow;
      bodyOverflow = document.body.style.overflow;
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      listening = true;
    }
  }

  function stopListening() {
    if (!listening) return;
    removeEventListener("resize", updateRect);
    removeEventListener("scroll", updateRect, true);
    removeEventListener("animationend", updateRect, true);
    document.documentElement.style.overflow = rootOverflow;
    document.body.style.overflow = bodyOverflow;
    listening = false;
  }

  function measureCoachWidth(value: number) {
    if (!coachPosition?.compact) coachWidth = value;
  }

  function measureCoachHeight(value: number) {
    if (!coachPosition?.compact) coachHeight = value;
  }

  function updateRect() {
    viewportWidth = innerWidth;
    viewportHeight = innerHeight;
    targetRect = target?.getBoundingClientRect() ?? null;
    obstacleRects = [...document.querySelectorAll<HTMLElement>(
      ".credential-provider-list, .credential-field input, .statement-selection, [data-onboarding-action='save-credentials'], .human-viewer-modal .viewer-actions, .human-viewer-modal .viewer-floating-input",
    )].map((element) => element.getBoundingClientRect());
  }

  function activateTarget() {
    if (!target) {
      onRetryTarget();
      return;
    }
    activateOnboardingTarget(target);
  }

  function back() {
    if (target && !target.dispatchEvent(
      new CustomEvent("onboardingback", { bubbles: true, cancelable: true }),
    )) return;
    onBack();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (visible && event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onPause();
    }
  }

  function primaryLabel(
    nextStep: OnboardingStep,
    dictionary: Translation,
    nextRoute: OnboardingContext["route"],
    targetAction?: string,
  ) {
    if (nextStep === "automation-nav") return dictionary.onboarding.openAutomation;
    if (nextStep === "credentials") {
      if (targetAction === "select-source") return dictionary.onboarding.chooseSource;
      if (targetAction === "enable-source") return dictionary.onboarding.enableSource;
      if (targetAction === "enter-credentials") return dictionary.onboarding.enterCredentials;
      if (targetAction === "select-statements") return dictionary.onboarding.selectStatements;
      if (targetAction === "save-credentials") return dictionary.onboarding.saveCredentials;
      return dictionary.onboarding.openCredentials;
    }
    if (nextStep === "assist" && targetAction === "resume-collection") {
      return dictionary.onboarding.resumeCollection;
    }
    if (nextStep === "assist" && targetAction === "choose-verification-control") {
      return dictionary.onboarding.focusVerificationViewer;
    }
    if (nextStep === "overview") return dictionary.onboarding.openOverview;
    if (nextStep === "overview-empty") {
      return nextRoute === "automation" ? dictionary.onboarding.logs : dictionary.onboarding.openAutomation;
    }
    if (nextStep.endsWith("failed")) return dictionary.onboarding.logs;
    if (nextStep === "complete") return dictionary.onboarding.finish;
    return dictionary.onboarding.continue;
  }

  onDestroy(() => {
    stopObserving();
    stopListening();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  <div class="onboarding-layer" aria-hidden="true">
    {#if targetRect && coachPosition}
      <div class="interaction-blocker top" style={`height:${Math.max(0, targetRect.top - 6)}px`}></div>
      <div
        class="interaction-blocker bottom"
        style={`top:${Math.min(viewportHeight, targetRect.bottom + 6)}px`}
      ></div>
      <div
        class="interaction-blocker left"
        style={`top:${Math.max(0, targetRect.top - 6)}px;width:${Math.max(0, targetRect.left - 6)}px;height:${Math.min(viewportHeight, targetRect.bottom + 6) - Math.max(0, targetRect.top - 6)}px`}
      ></div>
      <div
        class="interaction-blocker right"
        style={`top:${Math.max(0, targetRect.top - 6)}px;left:${Math.min(viewportWidth, targetRect.right + 6)}px;height:${Math.min(viewportHeight, targetRect.bottom + 6) - Math.max(0, targetRect.top - 6)}px`}
      ></div>
      <div
        class="spotlight"
        style={`--target-top:${targetRect.top}px;--target-left:${targetRect.left}px;--target-width:${targetRect.width}px;--target-height:${targetRect.height}px`}
      ></div>
    {/if}
  </div>

  {#if targetRect}
    <div
      bind:clientWidth={null, measureCoachWidth}
      bind:clientHeight={null, measureCoachHeight}
      class:compact
      class:corner={coachPosition?.compact}
      class:measuring={!coachPosition}
      class="coach"
      role="dialog"
      aria-modal="false"
      aria-labelledby="onboarding-title"
      style={coachPosition
        ? `--coach-left:${coachPosition.left}px;--coach-top:${coachPosition.top}px;--coach-width:${coachPosition.width}px;--coach-height:${coachPosition.height}px`
        : undefined}
    >
      <div class="coach-meta">
        <span>{$t.onboarding.stepLabel(current, 5)}</span>
        <span class="guide" aria-hidden="true"></span>
      </div>
      <div class="milestones" aria-hidden="true">
        {#each [1, 2, 3, 4, 5] as item}<span class:active={item === current}></span>{/each}
      </div>
      <h2 id="onboarding-title">{title}</h2>
      <p>{body}</p>
      <div class="coach-actions">
        <button class="button secondary" type="button" onclick={back}>{$t.onboarding.back}</button>
        {#if step === "complete"}
          <button class="button secondary" type="button" onclick={onAddSource}>{$t.onboarding.addSource}</button>
          <button class="button primary" type="button" onclick={onFinish}>{$t.onboarding.finish}</button>
        {:else}
          <button class="button secondary" type="button" onclick={onPause}>{$t.onboarding.pause}</button>
          <button class="button primary" type="button" onclick={activateTarget}>
            {primaryLabel(step, $t, route, target?.dataset.onboardingAction)}
          </button>
        {/if}
      </div>
    </div>
  {/if}
{/if}

<span class="visually-hidden" aria-live="polite">{announcement}</span>

<style>
  .onboarding-layer {
    position: fixed;
    inset: 0;
    z-index: 80;
    pointer-events: none;
  }
  .spotlight {
    position: fixed;
    top: calc(var(--target-top) - 6px);
    left: calc(var(--target-left) - 6px);
    width: calc(var(--target-width) + 12px);
    height: calc(var(--target-height) + 12px);
    border: 3px solid white;
    border-radius: 12px;
    box-shadow:
      0 0 0 4px var(--accent),
      0 0 0 9999px rgb(10 14 18 / 0.56);
  }
  .interaction-blocker {
    position: fixed;
    pointer-events: auto;
  }
  .interaction-blocker.top {
    inset: 0 0 auto;
  }
  .interaction-blocker.bottom {
    inset-inline: 0;
    bottom: 0;
  }
  .interaction-blocker.left {
    left: 0;
  }
  .interaction-blocker.right {
    right: 0;
  }
  .coach {
    position: fixed;
    z-index: 81;
    top: var(--coach-top);
    left: var(--coach-left);
    width: min(360px, calc(100vw - 48px));
    box-sizing: border-box;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: 0 22px 50px rgb(0 0 0 / 0.28);
    transition: width 180ms ease;
  }
  .coach.measuring {
    visibility: hidden;
    top: 24px;
    left: 24px;
  }
  .coach.compact {
    width: min(320px, calc(100vw - 48px));
    padding: 14px 18px;
  }
  .coach.compact .milestones,
  .coach.compact p,
  .coach.compact .coach-actions .primary {
    display: none;
  }
  .coach.compact h2 {
    margin: 8px 0 12px;
    font-size: 15px;
  }
  .coach.corner {
    width: var(--coach-width);
    height: var(--coach-height);
    max-height: var(--coach-height);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    padding: 8px 10px;
  }
  .coach.corner .coach-meta,
  .coach.corner .milestones,
  .coach.corner p {
    display: none;
  }
  .coach.corner h2 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 13px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .coach.corner .coach-actions {
    gap: 6px;
  }
  .coach.corner .coach-actions .button {
    min-height: 40px;
    padding: 0 8px;
  }
  .coach.corner .coach-actions .primary {
    display: inline-flex;
  }
  .coach.corner .coach-actions .secondary:not(:first-child) {
    display: none;
  }
  .coach-meta, .coach-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .coach-meta {
    color: var(--muted);
    font-size: 12px;
    font-weight: 750;
  }
  .guide {
    width: 32px;
    height: 32px;
    background: url("./assets/onboarding-guide-sprite.webp") left center / 200% 100% no-repeat;
    animation: guide-idle 1.2s step-end infinite;
    image-rendering: pixelated;
  }
  .milestones { display: flex; gap: 7px; margin: 8px 0 18px; }
  .milestones span { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .milestones span.active { background: var(--accent); }
  h2 { margin: 0 0 10px; font-size: 24px; line-height: 1.2; }
  p { margin: 0 0 22px; color: var(--muted); line-height: 1.55; }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @keyframes guide-idle { 50% { background-position: right center; } }
  @media (prefers-reduced-motion: reduce) {
    .guide { animation: none; }
    .coach { transition: none; }
  }
</style>
