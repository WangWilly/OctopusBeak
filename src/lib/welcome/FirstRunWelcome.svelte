<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    Archive,
    ArrowLeft,
    ArrowRight,
    CalendarRange,
    ChartLine,
    Coins,
    History,
    ListFilter,
    LockKeyhole,
    ReceiptText,
    RefreshCw,
    Scale,
    Tags,
    ToggleRight,
  } from "@lucide/svelte";

  import cathayLogo from "../../../site/assets/logos/cathay.webp";
  import ctbcLogo from "../../../site/assets/logos/ctbc.webp";
  import einvoiceLogo from "../../../site/assets/logos/einvoice.webp";
  import esunLogo from "../../../site/assets/logos/esun.webp";
  import fubonLogo from "../../../site/assets/logos/fubon.webp";
  import hncbLogo from "../../../site/assets/logos/hncb.webp";
  import linebankLogo from "../../../site/assets/logos/linebank.webp";
  import postLogo from "../../../site/assets/logos/post.webp";
  import sinopacLogo from "../../../site/assets/logos/sinopac.webp";
  import yuantaLogo from "../../../site/assets/logos/yuanta-bank.webp";
  import { locale, localeLabels, locales, setLocale, t, type Locale } from "$lib/i18n/i18n.ts";
  import appIcon from "./assets/app-icon.png";
  import curvedArrow from "./assets/curved-arrow-animation.svg";
  import inkBackground from "./assets/ink-background.png";
  import overviewScreen from "./assets/screenshots/01-overview.png";
  import assetsScreen from "./assets/screenshots/04-asset.png";
  import spendingScreen from "./assets/screenshots/08-spending.png";
  import ForceText from "./ForceText.svelte";
  import {
    reduceFirstRunWelcome,
    type FirstRunWelcomeAction,
    type FirstRunWelcomeState,
  } from "./state.ts";

  export let state: FirstRunWelcomeState;
  export let onStateChange: (next: FirstRunWelcomeState) => void;
  export let onComplete: (choice: "start" | "later") => void;

  type TourSlide = 3 | 4 | 5;

  const STAGE_WIDTH = 1440;
  const STAGE_HEIGHT = 900;
  const HERO_SCREENS = { 3: overviewScreen, 4: assetsScreen, 5: spendingScreen } as const;
  const TOUR_ICONS = {
    3: [Scale, Coins, ChartLine],
    4: [Archive, ListFilter, History],
    5: [ReceiptText, Tags, CalendarRange],
  } as const;
  const AUTOMATION_ICONS = [LockKeyhole, RefreshCw, ToggleRight];
  const INSTITUTIONS = [
    { name: "Taipei Fubon Bank", logo: fubonLogo },
    { name: "E.SUN Bank", logo: esunLogo },
    { name: "Cathay United Bank", logo: cathayLogo },
    { name: "CTBC Bank", logo: ctbcLogo },
    { name: "Bank SinoPac", logo: sinopacLogo },
    { name: "Hua Nan Bank", logo: hncbLogo },
    { name: "Yuanta Bank", logo: yuantaLogo },
    { name: "LINE Bank", logo: linebankLogo },
    { name: "Chunghwa Post", logo: postLogo },
    { name: "E-Invoice Platform", logo: einvoiceLogo },
  ];

  let root: HTMLElement;
  let introductionIcon: HTMLButtonElement;
  let languageContinueButton: HTMLButtonElement;
  let languageSelected = false;
  let transitionLocked = false;
  let direction: "forward" | "backward" = "forward";
  let circleCover = false;
  let reducedMotion = typeof window === "undefined"
    ? true
    : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let wheelDistance = 0;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  let unlockTimer: ReturnType<typeof setTimeout> | undefined;
  let coverTimer: ReturnType<typeof setTimeout> | undefined;
  let completeTimer: ReturnType<typeof setTimeout> | undefined;
  let motionQuery: MediaQueryList | undefined;

  let viewportWidth = STAGE_WIDTH;
  let viewportHeight = STAGE_HEIGHT;

  $: currentSlide = state.currentSlide;
  $: tourSlide = currentSlide >= 3 && currentSlide <= 5 ? currentSlide as TourSlide : null;
  $: tour = tourSlide ? $t.firstRunWelcome.tour[tourSlide - 3] : null;
  $: progressText = $t.firstRunWelcome.progress(currentSlide, 6);
  // The tour is composed on a fixed 1440x900 stage; below the floor the hero
  // window bleeds off the right edge instead of shrinking the copy further.
  $: stageScale = Math.min(1.25, Math.max(0.78, Math.min(
    viewportWidth / STAGE_WIDTH,
    viewportHeight / STAGE_HEIGHT,
  )));

  function requestTransition(action: FirstRunWelcomeAction, duration = 320) {
    if (transitionLocked) return;
    const next = reduceFirstRunWelcome(state, action);
    if (next === state) return;
    transitionLocked = true;
    direction = action.type === "previous" ? "backward" : "forward";
    onStateChange(next);
    void restoreFocus(next.currentSlide);
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => (transitionLocked = false), reducedMotion ? 120 : duration);
  }

  async function chooseLanguage(value: Locale) {
    if (transitionLocked) return;
    setLocale(value);
    languageSelected = true;
    await tick();
    languageContinueButton?.focus();
  }

  function confirmLanguage() {
    if (transitionLocked || !languageSelected) return;
    const next = reduceFirstRunWelcome(state, { type: "confirm-language" });
    if (next === state) return;
    transitionLocked = true;
    direction = "forward";
    clearTimeout(coverTimer);
    coverTimer = setTimeout(() => {
      onStateChange(next);
      void restoreFocus(next.currentSlide);
    }, reducedMotion ? 50 : 260);
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => (transitionLocked = false), reducedMotion ? 140 : 600);
  }

  function activateIntroduction() {
    if (transitionLocked || currentSlide !== 2) return;
    const next = reduceFirstRunWelcome(state, { type: "activate-introduction" });
    if (next === state) return;
    transitionLocked = true;
    direction = "forward";
    const rootRect = root.getBoundingClientRect();
    const iconRect = introductionIcon.getBoundingClientRect();
    root.style.setProperty("--circle-origin-x", `${iconRect.left - rootRect.left + iconRect.width / 2}px`);
    root.style.setProperty("--circle-origin-y", `${iconRect.top - rootRect.top + iconRect.height / 2}px`);
    circleCover = true;
    clearTimeout(coverTimer);
    coverTimer = setTimeout(() => {
      onStateChange(next);
      void restoreFocus(next.currentSlide);
    }, reducedMotion ? 80 : 390);
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => {
      circleCover = false;
      transitionLocked = false;
    }, reducedMotion ? 180 : 720);
  }

  function chooseAutomation(choice: "start" | "later") {
    if (transitionLocked || currentSlide !== 6) return;
    const next = reduceFirstRunWelcome(state, { type: "choose-bank-automation", choice });
    if (next.status !== "completed") return;
    transitionLocked = true;
    onStateChange(next);
    clearTimeout(completeTimer);
    completeTimer = setTimeout(() => onComplete(choice), reducedMotion ? 0 : 160);
  }

  async function restoreFocus(nextSlide: number) {
    await tick();
    if (state.status !== "active" || !root?.isConnected) return;
    root?.querySelector<HTMLElement>(`[data-slide="${nextSlide}"] [data-focus-default]`)?.focus();
  }

  function skipIntroduction() {
    requestTransition({ type: "skip-introduction" });
  }

  function navigate(nextDirection: "forward" | "backward") {
    if (nextDirection === "backward") requestTransition({ type: "previous" });
    else requestTransition({ type: "next" });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigate("backward");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      navigate("forward");
    }
  }

  function handlePointerMove(event: PointerEvent) {
    if (!reducedMotion && currentSlide >= 3) {
      const x = event.clientX / Math.max(1, innerWidth) - 0.5;
      const y = event.clientY / Math.max(1, innerHeight) - 0.5;
      root.style.setProperty("--parallax-x", `${x * 8}px`);
      root.style.setProperty("--parallax-y", `${y * 6}px`);
    }
  }

  function handleWheel(event: WheelEvent) {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || transitionLocked) return;
    event.preventDefault();
    wheelDistance += event.deltaX;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => (wheelDistance = 0), 140);
    if (Math.abs(wheelDistance) >= 80) {
      const distance = wheelDistance;
      wheelDistance = 0;
      navigate(distance > 0 ? "forward" : "backward");
    }
  }

  onMount(() => {
    motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => (reducedMotion = motionQuery?.matches ?? false);
    updateMotion();
    motionQuery.addEventListener("change", updateMotion);
    void restoreFocus(currentSlide);
    return () => motionQuery?.removeEventListener("change", updateMotion);
  });

  onDestroy(() => {
    clearTimeout(wheelTimer);
    clearTimeout(unlockTimer);
    clearTimeout(coverTimer);
    clearTimeout(completeTimer);
  });
</script>

<svelte:window onkeydown={handleKeydown} bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

{#snippet stepProgress(step: number)}
  <div class="step-progress" aria-hidden="true">
    <span class="step-count">{String(step).padStart(2, "0")} / 06</span>
    <span class="step-bars">
      {#each [1, 2, 3, 4, 5, 6] as item}<span class:filled={item <= step}></span>{/each}
    </span>
  </div>
{/snippet}

<main
  class="welcome"
  class:transitioning={transitionLocked}
  class:backward={direction === "backward"}
  class:reduced-motion={reducedMotion}
  class:latin={$locale === "en"}
  style={`--ink-background:url(${inkBackground});--stage-scale:${stageScale}`}
  bind:this={root}
  onpointermove={handlePointerMove}
  onwheel={handleWheel}
>
  <div class="window-drag-region" aria-hidden="true"></div>
  {#if currentSlide <= 2}
    <div class="progress" aria-hidden="true">
      {#each [1, 2, 3, 4, 5, 6] as item}<span class:active={item === currentSlide}></span>{/each}
    </div>
  {/if}
  <span class="visually-hidden" aria-live="polite">{progressText}</span>

  {#if currentSlide === 1}
    <section class="intro-slide language-slide" data-slide="1" aria-labelledby="welcome-language-heading">
      <div id="welcome-language-heading" class="force-heading">
        <ForceText text={$t.firstRunWelcome.languageHeading} {reducedMotion} />
      </div>
      <div class="app-icon-shell language-app-icon" aria-hidden="true">
        <img src={appIcon} alt="" draggable="false" />
      </div>
      <p class="language-prompt">{$t.firstRunWelcome.languagePrompt}</p>
      <div class="language-options" role="group" aria-label={$t.firstRunWelcome.languageOptions}>
        {#each locales as item}
          <button
            class:selected={$locale === item}
            data-focus-default={$locale === item ? "true" : undefined}
            type="button"
            aria-pressed={$locale === item}
            onclick={() => chooseLanguage(item)}
          >
            <span>{localeLabels[item]}</span>
            <span class="selection-mark" aria-hidden="true">✓</span>
          </button>
        {/each}
      </div>
      {#if languageSelected}
        <button
          class="language-continue"
          bind:this={languageContinueButton}
          type="button"
          onclick={confirmLanguage}
        >
          {$t.firstRunWelcome.continue}
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      {/if}
    </section>
  {:else if currentSlide === 2}
    <section class="intro-slide introduction-slide" data-slide="2" aria-labelledby="welcome-introduction-heading">
      <button class="intro-back" data-focus-default type="button" aria-label={$t.firstRunWelcome.previous} onclick={() => navigate("backward")}>
        <ArrowLeft size={18} aria-hidden="true" />
      </button>
      <button bind:this={introductionIcon} class="introduction-icon app-icon-shell" type="button" aria-label={$t.firstRunWelcome.activateIntroduction} onclick={activateIntroduction}>
        <img src={appIcon} alt="" aria-hidden="true" draggable="false" />
      </button>
      <div class="introduction-copy">
        <h1 id="welcome-introduction-heading">{$t.firstRunWelcome.introductionTitle}</h1>
        <p>{$t.firstRunWelcome.introductionBody}</p>
      </div>
      <img class="icon-arrow" src={curvedArrow} alt="" aria-hidden="true" draggable="false" />
    </section>
  {:else if tourSlide && tour}
    <section class="stage-slide tour-slide" data-slide={tourSlide} aria-labelledby={`welcome-slide-${tourSlide}-heading`}>
      <div class="stage">
        <div class="hero-window" aria-hidden="true">
          <div class="titlebar"><span></span><span></span><span></span></div>
          <img src={HERO_SCREENS[tourSlide]} alt="" draggable="false" />
        </div>
        <div class="panel">
          {@render stepProgress(tourSlide)}
          <h1 id={`welcome-slide-${tourSlide}-heading`} data-focus-default tabindex="-1">{tour.title}</h1>
          <p class="subtitle">{tour.subtitle}</p>
          <ul class="features">
            {#each tour.features as feature, index}
              {@const Icon = TOUR_ICONS[tourSlide][index]}
              <li>
                <span class="feature-icon" aria-hidden="true"><Icon size={20} /></span>
                <span class="feature-copy">
                  <strong>{feature.title}</strong>
                  <span>{feature.body}</span>
                </span>
              </li>
            {/each}
          </ul>
          <div class="tour-navigation">
            <button class="round-button" type="button" aria-label={$t.firstRunWelcome.previous} onclick={() => navigate("backward")}>
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
            <button class="pill-button primary" type="button" onclick={() => navigate("forward")}>
              {$t.firstRunWelcome.next}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
            <button class="skip-button" type="button" onclick={skipIntroduction}>{$t.firstRunWelcome.skipIntroduction}</button>
          </div>
        </div>
        <div class="callout" aria-hidden="true">
          <img src={appIcon} alt="" draggable="false" />
          <span>
            <span class="callout-label">{tour.callout.label}</span>
            <strong>{tour.callout.value}</strong>
            <span class="callout-detail">{tour.callout.detail}</span>
          </span>
        </div>
      </div>
    </section>
  {:else if currentSlide === 6}
    <section class="stage-slide automation-slide" data-slide="6" aria-labelledby="welcome-slide-6-heading">
      <div class="stage">
        <div class="automation-progress">{@render stepProgress(6)}</div>
        <div class="automation-mascot app-icon-shell" aria-hidden="true">
          <img src={appIcon} alt="" draggable="false" />
        </div>
        <h1 id="welcome-slide-6-heading" data-focus-default tabindex="-1">{$t.firstRunWelcome.automationTitle}</h1>
        <p class="subtitle">{$t.firstRunWelcome.automationBody}</p>
        <div class="trust-card">
          <ul class="highlights">
            {#each $t.firstRunWelcome.automationHighlights as highlight, index}
              {@const Icon = AUTOMATION_ICONS[index]}
              <li>
                <span class="feature-icon" aria-hidden="true"><Icon size={20} /></span>
                <strong>{highlight.title}</strong>
                <span>{highlight.body}</span>
              </li>
            {/each}
          </ul>
          <div class="institutions">
            <span class="institutions-label">{$t.firstRunWelcome.supportedInstitutions}</span>
            <ul>
              {#each INSTITUTIONS as institution}
                <li><img src={institution.logo} alt={institution.name} title={institution.name} draggable="false" /></li>
              {/each}
            </ul>
            <span class="institutions-more">{$t.firstRunWelcome.moreInstitutions}</span>
          </div>
        </div>
        <div class="final-actions">
          <button class="round-button" type="button" aria-label={$t.firstRunWelcome.previous} onclick={() => navigate("backward")}>
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <button class="pill-button primary" type="button" onclick={() => chooseAutomation("start")}>
            {$t.firstRunWelcome.startSetup}
            <ArrowRight size={18} aria-hidden="true" />
          </button>
          <button class="pill-button secondary" type="button" onclick={() => chooseAutomation("later")}>{$t.firstRunWelcome.maybeLater}</button>
        </div>
      </div>
    </section>
  {/if}

  {#if circleCover}<div class="circle-cover" aria-hidden="true"></div>{/if}
</main>

<style>
  :global(html:has(.welcome)),
  :global(body:has(.welcome)) {
    overflow: hidden;
    scrollbar-gutter: auto;
  }

  .welcome {
    --deep-blue: #071f4a;
    --teal: #18a9a4;
    --parallax-x: 0px;
    --parallax-y: 0px;
    --circle-origin-x: 50%;
    --circle-origin-y: 31%;
    position: fixed;
    z-index: 100;
    inset: 0;
    overflow: hidden;
    color: var(--deep-blue);
    background: #edf4f1 var(--ink-background) center / cover no-repeat;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    touch-action: auto;
  }

  .window-drag-region {
    position: fixed;
    z-index: 7;
    top: 0;
    right: 0;
    left: 0;
    height: 44px;
    -webkit-app-region: drag;
  }

  .welcome button {
    -webkit-app-region: no-drag;
  }

  .progress {
    position: fixed;
    z-index: 8;
    top: max(18px, env(safe-area-inset-top));
    left: 50%;
    display: flex;
    gap: 8px;
    transform: translateX(-50%);
    pointer-events: none;
    -webkit-app-region: drag;
  }

  .progress span {
    width: 7px;
    height: 7px;
    border: 1px solid rgb(7 31 74 / 28%);
    border-radius: 999px;
    background: rgb(255 255 255 / 54%);
    transition: width 240ms ease, background 240ms ease;
  }

  .progress span.active {
    width: 22px;
    border-color: var(--deep-blue);
    background: var(--deep-blue);
  }

  .intro-slide {
    position: absolute;
    inset: 0;
    --welcome-hero-size: clamp(150px, 17vw, 210px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 54px 28px 36px;
  }

  .force-heading {
    width: min(720px, 76vw);
    height: var(--welcome-hero-size);
    margin-bottom: -18px;
  }

  .app-icon-shell {
    overflow: hidden;
    border-radius: 25%;
    filter: drop-shadow(0 16px 24px rgb(7 31 74 / 20%));
  }

  .app-icon-shell > img {
    display: block;
    width: 114%;
    height: 114%;
    max-width: none;
    object-fit: cover;
    transform: translate(-6.15%, -6.15%);
    user-select: none;
    -webkit-user-drag: none;
  }

  .language-app-icon {
    width: var(--welcome-hero-size);
    height: var(--welcome-hero-size);
  }

  .language-prompt {
    margin: 22px 0 12px;
    color: rgb(7 31 74 / 74%);
    font-size: .83rem;
    font-weight: 700;
    letter-spacing: .14em;
    text-transform: uppercase;
  }

  .language-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(150px, 210px));
    gap: 12px;
  }

  .language-options button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 58px;
    padding: 0 20px;
    border: 1px solid rgb(255 255 255 / 68%);
    border-radius: 18px;
    color: var(--deep-blue);
    background: rgb(255 255 255 / 70%);
    box-shadow: 0 12px 36px rgb(7 31 74 / 11%);
    font: inherit;
    font-weight: 750;
    backdrop-filter: blur(14px);
    cursor: pointer;
  }

  .language-options button.selected {
    border-color: rgb(7 31 74 / 52%);
    background: rgb(255 255 255 / 88%);
  }

  .selection-mark {
    opacity: 0;
  }

  .selected .selection-mark {
    opacity: 1;
  }

  .language-continue {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-width: 180px;
    min-height: 50px;
    margin-top: 18px;
    padding: 0 24px;
    border: 1px solid var(--deep-blue);
    border-radius: 16px;
    color: white;
    background: var(--deep-blue);
    box-shadow: 0 14px 32px rgb(7 31 74 / 22%);
    font: inherit;
    font-weight: 750;
    cursor: pointer;
  }

  .transitioning .language-slide .force-heading {
    transform: scale(1.08);
    transition: transform 360ms ease;
  }

  .transitioning .language-slide .language-options,
  .transitioning .language-slide .language-prompt,
  .transitioning .language-slide .language-continue {
    transform: translateY(12px);
    transition: transform 300ms ease;
  }

  .transitioning .language-slide .language-app-icon {
    transform: translateY(-30px) scale(1.35);
    transition: transform 560ms cubic-bezier(.16, 1, .3, 1);
  }

  .introduction-slide {
    justify-content: flex-start;
    padding-top: clamp(68px, 10vh, 112px);
  }

  .introduction-icon {
    z-index: 2;
    width: clamp(132px, 18vw, 220px);
    aspect-ratio: 1;
    padding: 0;
    border: 0;
    border-radius: 28%;
    background: transparent;
    filter: drop-shadow(0 20px 32px rgb(7 31 74 / 24%));
    cursor: pointer;
  }

  .introduction-icon img {
    max-width: none;
  }

  .introduction-copy {
    width: min(720px, 80vw);
    margin-top: clamp(28px, 5vh, 52px);
    text-align: center;
  }

  .introduction-copy h1 {
    margin: 0;
    font-size: clamp(1.7rem, 3.2vw, 3rem);
    letter-spacing: -.04em;
  }

  .introduction-copy p {
    max-width: 650px;
    margin: 16px auto 0;
    color: rgb(7 31 74 / 76%);
    font-size: clamp(1rem, 1.45vw, 1.25rem);
    line-height: 1.65;
  }

  .icon-arrow {
    position: absolute;
    top: clamp(250px, 36vh, 350px);
    left: calc(50% + clamp(85px, 13vw, 160px));
    width: clamp(150px, 16vw, 220px);
    height: auto;
    transform: translateY(-110px) rotate(-15deg);
    transform-origin: center;
    pointer-events: none;
    user-select: none;
  }

  .intro-back {
    position: absolute;
    bottom: 28px;
    left: 50%;
    width: 44px;
    height: 44px;
    border: 1px solid rgb(7 31 74 / 14%);
    border-radius: 50%;
    color: var(--deep-blue);
    background: rgb(255 255 255 / 58%);
    font-size: 1.25rem;
    transform: translateX(-50%);
    cursor: pointer;
  }

  .stage-slide {
    position: absolute;
    inset: 0;
    overflow: hidden;
    animation: slide-in 320ms cubic-bezier(.2, .8, .2, 1) both;
  }

  .backward .stage-slide {
    animation-name: slide-in-back;
  }

  .stage {
    position: absolute;
    top: 50%;
    left: max(0px, calc((100% - 1440px * var(--stage-scale)) / 2));
    width: 1440px;
    height: 900px;
    transform: translateY(-50%) scale(var(--stage-scale));
    transform-origin: 0 50%;
  }

  .tour-slide {
    background: linear-gradient(90deg, rgb(7 31 74 / 35%) 0%, rgb(7 31 74 / 0%) 55%);
  }

  .automation-slide {
    background: radial-gradient(ellipse 55% 60% at 50% 50%, rgb(255 255 255 / 85%) 0%, rgb(255 255 255 / 45%) 50%, rgb(255 255 255 / 0%) 100%);
  }

  .step-progress {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .step-count {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1px;
    white-space: nowrap;
  }

  .step-bars {
    display: flex;
    flex: 1;
    gap: 6px;
  }

  .step-bars span {
    flex: 1;
    height: 4px;
    border-radius: 999px;
    background: rgb(7 31 74 / 12%);
  }

  .step-bars span.filled {
    background: var(--deep-blue);
  }

  .hero-window {
    position: absolute;
    top: 143px;
    left: 600px;
    display: flex;
    flex-direction: column;
    width: 920px;
    height: 614.5px;
    overflow: hidden;
    border-radius: 14px;
    background: white;
    outline: 1px solid rgb(255 255 255 / 60%);
    box-shadow: 0 32px 80px rgb(7 31 74 / 35%);
    transform: translate(var(--parallax-x), var(--parallax-y));
    transition: transform 180ms ease-out;
  }

  .titlebar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 33.5px;
    padding: 0 14px;
    border-bottom: 1px solid #dbdee2;
    background: #eef1f4;
  }

  .titlebar span {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ff5f57;
  }

  .titlebar span:nth-child(2) {
    background: #febc2e;
  }

  .titlebar span:nth-child(3) {
    background: #28c840;
  }

  .hero-window img {
    display: block;
    flex: 1;
    width: 100%;
    min-height: 0;
    object-fit: cover;
    object-position: left top;
    user-select: none;
    -webkit-user-drag: none;
  }

  .panel {
    position: absolute;
    top: 130px;
    left: 72px;
    box-sizing: border-box;
    width: 500px;
    padding: 48px;
    border-radius: 28px;
    background: rgb(255 255 255 / 90%);
    outline: 1px solid white;
    box-shadow: 0 24px 64px rgb(7 31 74 / 20%);
    backdrop-filter: blur(12px);
  }

  .panel h1,
  .automation-slide h1 {
    margin: 56px 0 0;
    font-size: 56px;
    line-height: 64px;
    letter-spacing: 2px;
  }

  .latin .panel h1 {
    font-size: 48px;
    line-height: 53px;
    letter-spacing: -0.5px;
  }

  .latin.welcome .automation-slide h1 {
    letter-spacing: -1px;
  }

  .subtitle {
    margin: 12px 0 0;
    color: rgb(7 31 74 / 72%);
    font-size: 20px;
  }

  .features,
  .highlights,
  .institutions ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .features {
    display: grid;
    gap: 24px;
    margin-top: 40px;
    padding-top: 28px;
    border-top: 1px solid rgb(7 31 74 / 12%);
  }

  .features li {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }

  .feature-icon {
    display: grid;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: rgb(7 31 74 / 6%);
    place-items: center;
  }

  .feature-copy {
    display: grid;
    gap: 4px;
  }

  .features strong,
  .highlights strong {
    font-size: 16px;
  }

  .feature-copy span {
    color: rgb(7 31 74 / 60%);
    font-size: 14px;
    line-height: 21px;
  }

  .tour-navigation {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 56px;
  }

  .round-button,
  .pill-button,
  .skip-button {
    color: var(--deep-blue);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .round-button {
    display: grid;
    width: 52px;
    height: 52px;
    padding: 0;
    border: 1px solid rgb(7 31 74 / 20%);
    border-radius: 50%;
    background: transparent;
    place-items: center;
  }

  .pill-button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 0 24px 0 28px;
    border: 1px solid transparent;
    border-radius: 999px;
    font-size: 15px;
  }

  .pill-button.primary {
    color: white;
    background: var(--deep-blue);
  }

  .skip-button {
    margin-left: auto;
    padding: 8px 0;
    border: 0;
    color: rgb(7 31 74 / 60%);
    background: none;
    font-size: 14px;
    font-weight: 600;
  }

  .callout {
    position: absolute;
    top: 676px;
    left: 1000px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 22px 14px 14px;
    border-radius: 20px;
    background: rgb(255 255 255 / 92%);
    outline: 1px solid white;
    box-shadow: 0 20px 48px rgb(7 31 74 / 24%);
    backdrop-filter: blur(10px);
    transform: translate(calc(var(--parallax-x) * -1.25), calc(var(--parallax-y) * -1.25));
    transition: transform 180ms ease-out;
    white-space: nowrap;
  }

  .callout img {
    width: 56px;
    height: 56px;
    border-radius: 14px;
  }

  .callout > span {
    display: grid;
    gap: 2px;
  }

  .callout strong {
    font-family: var(--font-mono);
    font-size: 22px;
  }

  .callout-label,
  .callout-detail {
    color: rgb(7 31 74 / 60%);
    font-size: 12px;
  }

  .callout-label {
    font-weight: 600;
  }

  .automation-slide .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .automation-progress {
    position: absolute;
    top: 48px;
    left: 560px;
    width: 320px;
  }

  .automation-mascot {
    width: 132px;
    height: 132px;
    border-radius: 32px;
    filter: drop-shadow(0 24px 56px rgb(7 31 74 / 25%));
  }

  .automation-slide h1 {
    margin-top: 36px;
    font-size: 64px;
    line-height: normal;
  }

  .trust-card {
    width: 860px;
    margin-top: 40px;
    overflow: hidden;
    border-radius: 24px;
    background: rgb(255 255 255 / 90%);
    outline: 1px solid white;
    box-shadow: 0 24px 64px rgb(7 31 74 / 18%);
    backdrop-filter: blur(12px);
    text-align: left;
  }

  .highlights {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    padding: 28px 8px;
  }

  .highlights li {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 0 24px;
  }

  .highlights li + li {
    border-left: 1px solid rgb(7 31 74 / 10%);
  }

  .highlights span:not(.feature-icon) {
    color: rgb(7 31 74 / 60%);
    font-size: 13px;
    line-height: 20px;
  }

  .institutions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 18px 32px;
    border-top: 1px solid rgb(7 31 74 / 8%);
    background: rgb(7 31 74 / 3%);
    color: rgb(7 31 74 / 60%);
    font-size: 12px;
  }

  .institutions-label {
    font-weight: 700;
    letter-spacing: 1px;
  }

  .institutions ul {
    display: flex;
    gap: 8px;
  }

  .institutions li {
    display: grid;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: white;
    outline: 1px solid rgb(7 31 74 / 8%);
    box-shadow: 0 2px 6px rgb(7 31 74 / 8%);
    place-items: center;
  }

  .institutions img {
    width: 26px;
    height: 26px;
    border-radius: 6px;
  }

  .final-actions {
    display: flex;
    gap: 12px;
    margin-top: 40px;
  }

  .final-actions .round-button {
    width: 56px;
    height: 56px;
    background: rgb(255 255 255 / 70%);
  }

  .final-actions .pill-button {
    height: 56px;
    padding: 0 28px 0 32px;
    font-size: 16px;
  }

  .final-actions .pill-button.primary {
    box-shadow: 0 12px 28px rgb(7 31 74 / 30%);
  }

  .final-actions .pill-button.secondary {
    padding: 0 28px;
    border-color: rgb(7 31 74 / 15%);
    background: rgb(255 255 255 / 80%);
  }

  button:focus-visible {
    outline: 3px solid #20a9ae;
    outline-offset: 4px;
  }

  [tabindex="-1"]:focus {
    outline: none;
  }

  .circle-cover {
    position: fixed;
    z-index: 20;
    top: var(--circle-origin-y);
    left: var(--circle-origin-x);
    width: 22px;
    aspect-ratio: 1;
    border-radius: 50%;
    background: var(--deep-blue);
    animation: circle-cover 700ms cubic-bezier(.76, 0, .24, 1) both;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes slide-in {
    from { opacity: 0; transform: translateX(28px); }
    to { opacity: 1; transform: translateX(0); }
  }

  @keyframes slide-in-back {
    from { opacity: 0; transform: translateX(-28px); }
    to { opacity: 1; transform: translateX(0); }
  }

  @keyframes circle-cover {
    from { transform: translate(-50%, -50%) scale(1); }
    68%, 86% { transform: translate(-50%, -50%) scale(160); opacity: 1; }
    to { transform: translate(-50%, -50%) scale(160); opacity: 0; }
  }

  @media (max-width: 520px) {
    .language-options {
      width: min(100%, 340px);
      grid-template-columns: 1fr;
    }

    .intro-slide {
      padding-inline: 20px;
    }

    .introduction-copy {
      width: 92vw;
    }

    .icon-arrow {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .welcome *,
    .welcome *::before,
    .welcome *::after {
      scroll-behavior: auto !important;
      animation-duration: 120ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 120ms !important;
    }

    .stage-slide {
      animation-name: reduced-fade;
    }

    .hero-window,
    .callout {
      transform: none;
    }

    .circle-cover {
      inset: 0;
      width: auto;
      border-radius: 0;
      animation-name: reduced-fade;
    }
  }

  @keyframes reduced-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
