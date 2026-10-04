<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import { workflowFailureExplanation } from "$lib/automation/workflow-failures.ts";
  import type { OnboardingState } from "./state.ts";
  import type { OnboardingCommandId, OnboardingDisabledReason, OnboardingStoryView } from "./story.ts";
  import { focusOnboardingTarget, type OnboardingTargetRegistry } from "./target-observer.ts";
  import { placeOnboardingCoach } from "./placement.ts";

  export let story: OnboardingStoryView | null;
  export let state: OnboardingState;
  export let targets: OnboardingTargetRegistry;
  export let onExit: () => void;
  export let onPrevious: () => void | Promise<void>;
  export let onReturnToOverview: () => void | Promise<unknown>;
  export let onFinish: () => void;
  export let onAddSource: () => void;
  export let onRetryWorkflow: () => Promise<void>;
  export let onRetryOverview: () => Promise<void>;
  export let onCancelWorkflow: () => Promise<void>;

  const COACH_BASE_WIDTH = 360;
  const COACH_VIEWPORT_MARGIN = 24;
  let target: HTMLElement | null = null;
  let coachElement: HTMLElement | null = null;
  let targetRect: DOMRect | null = null;
  let obstacleRects: DOMRect[] = [];
  let coachWidth = COACH_BASE_WIDTH;
  let coachHeight = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let listening = false;
  let rootOverflow = "";
  let bodyOverflow = "";
  let stopObserving = () => {};
  let targetResizeObserver: ResizeObserver | null = null;
  let watchedTargetId: string | null | undefined;
  let coachMeasureFrame: number | null = null;
  let announcement = "";
  let cancelPending = false;
  let operationPending = false;

  $: visible = Boolean(story);
  $: copy = story ? coachCopy($t, story.copyKey) : null;
  $: title = copy?.title ?? "";
  $: body = copy?.body ?? "";
  $: current = story?.ordinal ?? 0;
  $: coachPosition = targetRect && coachWidth && coachHeight
    ? placeOnboardingCoach(
      targetRect,
      { width: coachWidth, height: coachHeight },
      { width: viewportWidth, height: viewportHeight },
      obstacleRects,
      )
    : null;
  $: watchTarget(visible ? story?.targetId ?? null : null);
  $: if (visible) announce(title);

  onMount(() => {
    const synchronizeCurrentTarget = () => {
      // Read the latest component prop as well as the registry snapshot. The
      // first target can register during the welcome-to-dashboard transition,
      // before this coach has subscribed.
      const currentTargetId = visible ? story?.targetId ?? null : null;
      if (currentTargetId !== watchedTargetId) watchedTargetId = currentTargetId;
      updateRegisteredTarget();
    };
    const unsubscribeTargets = targets.subscribe(synchronizeCurrentTarget);
    synchronizeCurrentTarget();
    document.addEventListener("focusin", guardFocus, true);
    return () => {
      unsubscribeTargets();
      document.removeEventListener("focusin", guardFocus, true);
    };
  });

  async function announce(value: string) {
    announcement = "";
    await tick();
    announcement = value;
  }

  function coachCopy(dictionary: Translation, copyKey: OnboardingStoryView["copyKey"]) {
    const copies = {
      sourceEntry: { title: dictionary.onboarding.sourceEntryTitle, body: dictionary.onboarding.sourceEntryBody },
      sourceSelection: dictionary.onboarding.chooseSourceCopy,
      credentials: dictionary.onboarding.credentialsSetupCopy,
      collection: { title: dictionary.onboarding.collectionTitle, body: dictionary.onboarding.collectionBody },
      collectionProgress: { title: dictionary.onboarding.collectionProgressTitle, body: dictionary.onboarding.collectionProgressBody },
      collectionFailed: { title: dictionary.onboarding.collectionFailedTitle, body: dictionary.onboarding.collectionFailedBody },
      workflowReview: { title: dictionary.onboarding.workflowReviewTitle, body: dictionary.onboarding.workflowReviewBody },
      overviewPreparing: { title: dictionary.onboarding.overviewPreparingTitle, body: dictionary.onboarding.overviewPreparingBody },
      overviewPreparationFailed: { title: dictionary.onboarding.overviewPreparationFailedTitle, body: dictionary.onboarding.overviewPreparationFailedBody },
      overviewEmpty: { title: dictionary.onboarding.overviewEmptyTitle, body: dictionary.onboarding.overviewEmptyBody },
      complete: { title: dictionary.onboarding.completeTitle, body: dictionary.onboarding.completeBody },
    } satisfies Record<OnboardingStoryView["copyKey"], { title: string; body: string }>;
    return copies[copyKey];
  }

  function watchTarget(id: string | null) {
    if (id === watchedTargetId) return;
    watchedTargetId = id;
    updateRegisteredTarget();
  }

  function updateRegisteredTarget() {
    const registration = targets.get(watchedTargetId);
    const nextTarget = registration?.element ?? null;
    if (nextTarget === target) {
      updateRect();
      return;
    }
    targetResizeObserver?.disconnect();
    targetResizeObserver = null;
    target = nextTarget;
    targetRect = null;
    obstacleRects = [];
    if (!target) {
      stopListening();
      updateRect();
      return;
    }
    targetResizeObserver = new ResizeObserver(updateRect);
    targetResizeObserver.observe(target);
    target.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
      inline: "center",
    });
    focusOnboardingTarget(target);
    updateRect();
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

  function scheduleCoachMeasurement(node: HTMLElement | null = coachElement) {
    if (!node) return;
    if (coachMeasureFrame !== null) cancelAnimationFrame(coachMeasureFrame);
    coachMeasureFrame = requestAnimationFrame(() => {
      coachMeasureFrame = null;
      if (!node.isConnected) return;
      const width = Math.max(1, Math.min(
        COACH_BASE_WIDTH,
        innerWidth - COACH_VIEWPORT_MARGIN * 2,
      ));
      // Measure the natural, unscrolled content height so viewport placement
      // never feeds a clipped box size back as the next desired size.
      const height = Math.max(1, node.scrollHeight + 2);
      if (coachWidth !== width) coachWidth = width;
      if (coachHeight !== height) coachHeight = height;
    });
  }

  function observeCoachSize(node: HTMLElement) {
    const resizeObserver = new ResizeObserver(() => scheduleCoachMeasurement(node));
    const mutationObserver = new MutationObserver(() => scheduleCoachMeasurement(node));
    resizeObserver.observe(node);
    mutationObserver.observe(node, { childList: true, characterData: true, subtree: true });
    scheduleCoachMeasurement(node);
    return {
      destroy() {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        if (coachMeasureFrame !== null) cancelAnimationFrame(coachMeasureFrame);
        coachMeasureFrame = null;
      },
    };
  }

  function updateRect() {
    viewportWidth = innerWidth;
    viewportHeight = innerHeight;
    targetRect = target?.getBoundingClientRect() ?? null;
    obstacleRects = [];
    scheduleCoachMeasurement();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!visible || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      onExit();
      return;
    }
    if (event.key === "Tab") {
      const focusable = focusableElements();
      if (!focusable.length) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const offset = event.shiftKey ? -1 : 1;
      const nextIndex = currentIndex < 0
        ? (event.shiftKey ? focusable.length - 1 : 0)
        : (currentIndex + offset + focusable.length) % focusable.length;
      // Move only through the active target region and coach. Native tab order
      // includes dimmed app controls between them, so every Tab must be routed.
      event.preventDefault();
      focusable[nextIndex]?.focus();
    }
  }

  function focusableElements() {
    const selector = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const candidates = [
      ...(target?.matches(selector) ? [target] : []),
      ...(target?.querySelectorAll<HTMLElement>(selector) ?? []),
      ...(coachElement?.querySelectorAll<HTMLElement>(selector) ?? []),
    ];
    return [...new Set(candidates)].filter((element) => {
      const style = getComputedStyle(element);
      return !element.matches(":disabled")
        && element.getAttribute("aria-disabled") !== "true"
        && !element.closest('[aria-hidden="true"], [inert]')
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && element.getClientRects().length > 0;
    });
  }

  function guardFocus(event: FocusEvent) {
    if (!visible || !(event.target instanceof HTMLElement)) return;
    if (coachElement?.contains(event.target) || target?.contains(event.target)) return;
    focusableElements()[0]?.focus();
  }

  async function cancelWorkflow() {
    if (cancelPending) return;
    cancelPending = true;
    await onCancelWorkflow();
    cancelPending = false;
  }

  async function retryWorkflow() {
    if (operationPending) return;
    operationPending = true;
    await onRetryWorkflow();
    operationPending = false;
  }

  async function retryOverview() {
    if (operationPending) return;
    operationPending = true;
    await onRetryOverview();
    operationPending = false;
  }

  function commandLabel(command: OnboardingCommandId) {
    const labels: Record<OnboardingCommandId, string> = {
      previous: $t.onboarding.previous,
      exit: $t.onboarding.exit,
      cancelWorkflow: $t.onboarding.cancelWorkflow,
      retryWorkflow: $t.onboarding.retryWorkflow,
      retryOverview: $t.onboarding.retryOverview,
      addSource: $t.onboarding.addSource,
      finish: $t.onboarding.finish,
      returnToOverview: $t.onboarding.returnToOverview,
    };
    return labels[command];
  }

  function disabledReasonLabel(reason: OnboardingDisabledReason | null) {
    if (reason === "workflowRunning") return $t.onboarding.previousBlockedWorkflow;
    if (reason === "overviewPreparing") return $t.onboarding.previousBlockedOverview;
    if (reason === "workflowAlreadyCompleted") return $t.onboarding.previousBlockedCompleted;
    if (reason === "restartCancelling") return $t.onboarding.previousBlockedRestart;
    return "";
  }

  function commandDisabled(command: OnboardingCommandId, enabled: boolean) {
    return !enabled || (command !== "exit" && (operationPending || cancelPending));
  }

  async function invokeCommand(command: OnboardingCommandId) {
    if (command === "exit") {
      onExit();
      return;
    }
    if (operationPending || cancelPending) return;
    if (command === "previous") await onPrevious();
    else if (command === "cancelWorkflow") await cancelWorkflow();
    else if (command === "retryWorkflow") await retryWorkflow();
    else if (command === "retryOverview") await retryOverview();
    else if (command === "addSource") onAddSource();
    else if (command === "finish") onFinish();
    else if (command === "returnToOverview") {
      operationPending = true;
      await onReturnToOverview();
      operationPending = false;
    }
  }

  onDestroy(() => {
    targetResizeObserver?.disconnect();
    stopListening();
    if (coachMeasureFrame !== null) cancelAnimationFrame(coachMeasureFrame);
  });
</script>

<svelte:window onkeydowncapture={handleKeydown} />

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
    {:else}
      <div class="interaction-blocker missing-target"></div>
    {/if}
  </div>

  <div
    bind:this={coachElement}
    use:observeCoachSize
    class:fallback={!targetRect}
    class:measuring={Boolean(targetRect) && !coachPosition}
    class="coach"
    role="dialog"
    aria-modal="true"
    aria-labelledby="onboarding-title"
    style={coachPosition
      ? `--coach-left:${coachPosition.left}px;--coach-top:${coachPosition.top}px;--coach-width:${coachPosition.width}px`
      : undefined}
  >
    <div class="coach-meta">
      <span>{$t.onboarding.stepLabel(current, story?.total ?? 0)}</span>
      <span class="guide" aria-hidden="true"></span>
    </div>
    <div class="milestones" aria-hidden="true">
      {#each Array.from({ length: story?.total ?? 0 }, (_, index) => index + 1) as item}<span class:active={item === current}></span>{/each}
    </div>
    <h2 id="onboarding-title">{title}</h2>
    <p>{body}</p>
    {#if state.error}
      {#if workflowFailureExplanation(state.error, $locale)}
        <p class="coach-error" role="alert">{workflowFailureExplanation(state.error, $locale)} <code>{state.error}</code></p>
      {:else}
        <p class="coach-error" role="alert">{state.error}</p>
      {/if}
    {/if}
    {#if story?.commands.find((command) => command.id === "previous" && !command.enabled)}
      {@const blockedPrevious = story.commands.find((command) => command.id === "previous")}
      <p class="coach-disabled-reason" id="onboarding-previous-reason">
        {disabledReasonLabel(blockedPrevious?.disabledReason ?? null)}
      </p>
    {/if}
    <div class="coach-actions">
      {#each story?.commands ?? [] as commandView (commandView.id)}
        <button
          class={`button ${commandView.id === "retryWorkflow" || commandView.id === "retryOverview" || commandView.id === "finish" ? "primary" : commandView.id === "cancelWorkflow" ? "danger" : "secondary"}`}
          type="button"
          disabled={commandDisabled(commandView.id, commandView.enabled)}
          aria-describedby={commandView.id === "previous" && !commandView.enabled ? "onboarding-previous-reason" : undefined}
          onclick={() => void invokeCommand(commandView.id)}
        >
          {commandView.id === "cancelWorkflow" && cancelPending
            ? $t.onboarding.cancellingWorkflow
            : commandLabel(commandView.id)}
        </button>
      {/each}
    </div>
  </div>
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
  .interaction-blocker.missing-target {
    inset: 0;
  }
  .coach {
    position: fixed;
    z-index: 81;
    pointer-events: auto;
    top: var(--coach-top);
    left: var(--coach-left);
    width: var(--coach-width, min(360px, calc(100vw - 48px)));
    box-sizing: border-box;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: 0 22px 50px rgb(15 23 42 / 0.28);
  }
  .coach.measuring {
    visibility: hidden;
    top: 24px;
    left: 24px;
  }
  .coach.fallback {
    top: auto;
    right: 24px;
    bottom: 24px;
    left: auto;
  }
  .coach-meta, .coach-actions {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: 12px;
  }
  .coach-meta { justify-content: space-between; }
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
  .milestones { display: flex; gap: 7px; margin: 8px 0 14px; }
  .milestones span { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .milestones span.active { background: var(--accent); }
  h2 { margin: 0 0 8px; font-size: 23px; line-height: 1.2; }
  .coach > p { margin: 0 0 14px; color: var(--muted); line-height: 1.45; }
  .coach-error { margin: 0 0 10px; color: var(--danger); font-size: 13px; }
  .coach-disabled-reason { margin: 0 0 10px !important; color: var(--muted); font-size: 12px; line-height: 1.3 !important; }
  .coach-actions :global(.button) { min-height: 38px; padding: 8px 11px; }
  @keyframes guide-idle { 50% { background-position: right center; } }
  @media (max-height: 700px) {
    .coach { padding: 18px; }
    .guide { width: 26px; height: 26px; }
    .milestones { margin: 6px 0 10px; }
    h2 { margin-bottom: 6px; font-size: 21px; }
    .coach > p { margin-bottom: 10px; line-height: 1.38; }
    .coach-disabled-reason { margin-bottom: 7px !important; }
    .coach-actions { gap: 7px; }
  }
  @media (max-height: 560px) {
    .coach { padding: 14px; }
    .coach-meta { font-size: 11px; }
    .guide { width: 22px; height: 22px; }
    .milestones { margin: 4px 0 7px; }
    h2 { margin-bottom: 4px; font-size: 19px; }
    .coach > p { margin-bottom: 7px; line-height: 1.3; }
    .coach-actions :global(.button) { min-height: 34px; padding: 6px 9px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .guide { animation: none; }
  }
</style>
