<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";

  import { locale, localeLabels, locales, setLocale, t, type Locale } from "$lib/i18n/i18n.ts";
  import appIcon from "./assets/app-icon.png";
  import curvedArrow from "./assets/curved-arrow-animation.svg";
  import inkBackground from "./assets/ink-background.png";
  import iconOverview from "./assets/icons/01-overview.png";
  import iconAssets from "./assets/icons/04-asset.png";
  import iconSpending from "./assets/icons/08-spending.png";
  import iconCredentials from "./assets/icons/11-credential-settings.png";
  import overviewEn from "./assets/screenshots/01-overview.en.png";
  import overviewZh from "./assets/screenshots/01-overview.zh-TW.png";
  import netChangeEn from "./assets/screenshots/02-overview-net-change.en.png";
  import netChangeZh from "./assets/screenshots/02-overview-net-change.zh-TW.png";
  import portfolioEn from "./assets/screenshots/03-overview-portfolio-flow.en.png";
  import portfolioZh from "./assets/screenshots/03-overview-portfolio-flow.zh-TW.png";
  import assetsEn from "./assets/screenshots/04-asset.en.png";
  import assetsZh from "./assets/screenshots/04-asset.zh-TW.png";
  import tradesEn from "./assets/screenshots/05-asset-brokerage-trades.en.png";
  import tradesZh from "./assets/screenshots/05-asset-brokerage-trades.zh-TW.png";
  import positionsEn from "./assets/screenshots/06-asset-brokerage-positions.en.png";
  import positionsZh from "./assets/screenshots/06-asset-brokerage-positions.zh-TW.png";
  import liabilitiesEn from "./assets/screenshots/07-liability-changes.en.png";
  import liabilitiesZh from "./assets/screenshots/07-liability-changes.zh-TW.png";
  import spendingEn from "./assets/screenshots/08-spending.en.png";
  import spendingZh from "./assets/screenshots/08-spending.zh-TW.png";
  import receiptListEn from "./assets/screenshots/09-receipt-list.en.png";
  import receiptListZh from "./assets/screenshots/09-receipt-list.zh-TW.png";
  import receiptDetailEn from "./assets/screenshots/10-receipt-detail.en.png";
  import receiptDetailZh from "./assets/screenshots/10-receipt-detail.zh-TW.png";
  import credentialsEn from "./assets/screenshots/11-credential-settings.en.png";
  import credentialsZh from "./assets/screenshots/11-credential-settings.zh-TW.png";
  import ForceText from "./ForceText.svelte";
  import {
    reduceFirstRunWelcome,
    type FirstRunWelcomeAction,
    type FirstRunWelcomeState,
  } from "./state.ts";

  export let state: FirstRunWelcomeState;
  export let onStateChange: (next: FirstRunWelcomeState) => void;
  export let onComplete: (choice: "start" | "later") => void;

  type ProductSlide = {
    number: 3 | 4 | 5 | 6;
    title: string;
    body: string;
    note?: string;
    icon: string;
    main: string;
    foreground: string[];
  };

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

  $: currentSlide = state.currentSlide;
  $: slide = currentSlide >= 3 ? productSlide(currentSlide as 3 | 4 | 5 | 6, $locale) : null;
  $: progressText = $t.firstRunWelcome.progress(currentSlide, 6);

  function productSlide(number: 3 | 4 | 5 | 6, language: Locale): ProductSlide {
    const localized = language === "zh-TW";
    if (number === 3) return {
      number,
      title: $t.firstRunWelcome.overviewTitle,
      body: $t.firstRunWelcome.overviewBody,
      icon: iconOverview,
      main: localized ? overviewZh : overviewEn,
      foreground: [localized ? netChangeZh : netChangeEn, localized ? portfolioZh : portfolioEn],
    };
    if (number === 4) return {
      number,
      title: $t.firstRunWelcome.assetsTitle,
      body: $t.firstRunWelcome.assetsBody,
      icon: iconAssets,
      main: localized ? assetsZh : assetsEn,
      foreground: [
        localized ? tradesZh : tradesEn,
        localized ? positionsZh : positionsEn,
        localized ? liabilitiesZh : liabilitiesEn,
      ],
    };
    if (number === 5) return {
      number,
      title: $t.firstRunWelcome.spendingTitle,
      body: $t.firstRunWelcome.spendingBody,
      icon: iconSpending,
      main: localized ? spendingZh : spendingEn,
      foreground: [localized ? receiptListZh : receiptListEn, localized ? receiptDetailZh : receiptDetailEn],
    };
    return {
      number,
      title: $t.firstRunWelcome.automationTitle,
      body: $t.firstRunWelcome.automationBody,
      note: $t.firstRunWelcome.credentialsNote,
      icon: iconCredentials,
      main: localized ? credentialsZh : credentialsEn,
      foreground: [],
    };
  }

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

<svelte:window onkeydown={handleKeydown} />

<main
  class="welcome"
  class:transitioning={transitionLocked}
  class:backward={direction === "backward"}
  class:reduced-motion={reducedMotion}
  bind:this={root}
  onpointermove={handlePointerMove}
  onwheel={handleWheel}
>
  <div class="window-drag-region" aria-hidden="true"></div>
  <div class="progress" aria-hidden="true">
    {#each [1, 2, 3, 4, 5, 6] as item}<span class:active={item === currentSlide}></span>{/each}
  </div>
  <span class="visually-hidden" aria-live="polite">{progressText}</span>

  {#if currentSlide === 1}
    <section
      class="intro-slide language-slide"
      data-slide="1"
      style={`--ink-background:url(${inkBackground})`}
      aria-labelledby="welcome-language-heading"
    >
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
          <span aria-hidden="true">→</span>
        </button>
      {/if}
    </section>
  {:else if currentSlide === 2}
    <section
      class="intro-slide introduction-slide"
      data-slide="2"
      style={`--ink-background:url(${inkBackground})`}
      aria-labelledby="welcome-introduction-heading"
    >
      <button class="intro-back" data-focus-default type="button" aria-label={$t.firstRunWelcome.previous} onclick={() => navigate("backward")}>
        <span aria-hidden="true">←</span>
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
  {:else if slide}
    <section class="product-slide" data-slide={slide.number} aria-labelledby={`welcome-slide-${slide.number}-heading`}>
      <div class="screenshots" aria-hidden="true">
        <img class="main-screenshot" src={slide.main} alt="" draggable="false" />
        {#each slide.foreground as foreground, index}
          <img class={`foreground foreground-${index + 1}`} src={foreground} alt="" draggable="false" />
        {/each}
      </div>
      <div class="copy-region" style={`--feature-mask:url(${slide.icon})`}>
        <div class="feature-mask" aria-hidden="true"></div>
        <div class="copy">
          <h1 id={`welcome-slide-${slide.number}-heading`} data-focus-default tabindex="-1">{slide.title}</h1>
          <p>{slide.body}</p>
          {#if slide.note}<p class="credential-note">{slide.note}</p>{/if}
          {#if slide.number === 6}
            <div class="final-actions">
              <button class="primary-action" type="button" onclick={() => chooseAutomation("start")}>{$t.firstRunWelcome.startSetup}</button>
              <button class="secondary-action" type="button" onclick={() => chooseAutomation("later")}>{$t.firstRunWelcome.maybeLater}</button>
            </div>
          {/if}
        </div>
        <div class="navigation">
          <button type="button" aria-label={$t.firstRunWelcome.previous} onclick={() => navigate("backward")}><span aria-hidden="true">←</span></button>
          {#if slide.number < 6}
            <button type="button" aria-label={$t.firstRunWelcome.next} onclick={() => navigate("forward")}><span aria-hidden="true">→</span></button>
          {/if}
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
    background: #edf4f1;
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

  .product-slide {
    position: absolute;
    inset: 0;
    animation: slide-in 320ms cubic-bezier(.2, .8, .2, 1) both;
  }

  .backward .product-slide {
    animation-name: slide-in-back;
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
    background-image: var(--ink-background);
    background-position: center;
    background-size: cover;
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

  .product-slide {
    display: grid;
    grid-template-columns: minmax(0, 62fr) minmax(340px, 38fr);
    background: linear-gradient(135deg, #e7f0ec 0%, #f5f7f4 58%, #dcebe6 100%);
  }

  .screenshots {
    position: relative;
    display: grid;
    min-width: 0;
    padding: clamp(72px, 9vh, 108px) clamp(32px, 4vw, 72px) clamp(50px, 7vh, 82px);
    place-items: center;
    perspective: 1400px;
  }

  .main-screenshot {
    display: block;
    width: min(100%, 980px);
    max-height: 76vh;
    border: 1px solid rgb(7 31 74 / 10%);
    border-radius: 22px;
    object-fit: contain;
    box-shadow: 0 32px 80px rgb(7 31 74 / 18%);
    transform: translate(var(--parallax-x), var(--parallax-y));
    transition: transform 180ms ease-out;
    user-select: none;
    -webkit-user-drag: none;
  }

  .foreground {
    position: absolute;
    width: clamp(190px, 24vw, 380px);
    max-height: 32vh;
    border: 1px solid rgb(255 255 255 / 72%);
    border-radius: 17px;
    object-fit: contain;
    box-shadow: 0 20px 50px rgb(7 31 74 / 24%);
    transition: transform 180ms ease-out;
  }

  .foreground-1 {
    right: 3.5%;
    bottom: 7%;
    transform: translate(calc(var(--parallax-x) * -1.25), calc(var(--parallax-y) * -1.25)) rotate(1.5deg);
  }

  .foreground-2 {
    left: 3.5%;
    top: 16%;
    transform: translate(calc(var(--parallax-x) * -1), calc(var(--parallax-y) * -1)) rotate(-1.2deg);
  }

  .foreground-3 {
    left: 8%;
    bottom: 4%;
    width: clamp(170px, 20vw, 310px);
    transform: translate(calc(var(--parallax-x) * -.8), calc(var(--parallax-y) * -.8)) rotate(-.5deg);
  }

  .copy-region {
    position: relative;
    display: grid;
    min-width: 0;
    padding: clamp(82px, 13vh, 142px) clamp(34px, 5vw, 78px) 104px;
    align-items: center;
    overflow: hidden;
    isolation: isolate;
  }

  .feature-mask {
    position: absolute;
    z-index: -1;
    top: 7%;
    right: -28%;
    width: min(48vw, 620px);
    aspect-ratio: 1;
    opacity: .16;
    background: linear-gradient(145deg, #0a4b9f 12%, #13b9a5 85%);
    mask: var(--feature-mask) center / contain no-repeat;
    -webkit-mask: var(--feature-mask) center / contain no-repeat;
  }

  .copy {
    position: relative;
    z-index: 1;
  }

  .copy h1 {
    max-width: 560px;
    margin: 0;
    font-size: clamp(2.25rem, 4.1vw, 5.3rem);
    line-height: .98;
    letter-spacing: -.065em;
  }

  .copy > p {
    max-width: 500px;
    margin: 24px 0 0;
    color: rgb(7 31 74 / 72%);
    font-size: clamp(1.05rem, 1.5vw, 1.5rem);
    line-height: 1.55;
  }

  .copy p.credential-note {
    margin-top: 16px;
    color: rgb(7 31 74 / 58%);
    font-size: .92rem;
    font-weight: 700;
  }

  .final-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 34px;
  }

  .final-actions button {
    min-height: 50px;
    padding: 0 22px;
    border-radius: 15px;
    font: inherit;
    font-weight: 750;
    cursor: pointer;
  }

  .primary-action {
    border: 1px solid var(--deep-blue);
    color: white;
    background: var(--deep-blue);
    box-shadow: 0 12px 28px rgb(7 31 74 / 22%);
  }

  .secondary-action {
    border: 1px solid rgb(7 31 74 / 20%);
    color: var(--deep-blue);
    background: rgb(255 255 255 / 60%);
  }

  .navigation {
    position: absolute;
    z-index: 2;
    right: clamp(34px, 5vw, 78px);
    bottom: 32px;
    left: clamp(34px, 5vw, 78px);
    display: flex;
    justify-content: space-between;
  }

  .navigation button {
    display: grid;
    width: 48px;
    height: 48px;
    border: 1px solid rgb(7 31 74 / 18%);
    border-radius: 50%;
    color: var(--deep-blue);
    background: rgb(255 255 255 / 62%);
    font-size: 1.35rem;
    place-items: center;
    cursor: pointer;
    backdrop-filter: blur(10px);
  }

  button:focus-visible,
  [tabindex="-1"]:focus-visible {
    outline: 3px solid #20a9ae;
    outline-offset: 4px;
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

  @media (max-width: 850px) {
    .product-slide {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(250px, 43fr) minmax(0, 57fr);
    }

    .copy-region {
      grid-row: 1;
      padding: 64px 28px 70px;
    }

    .screenshots {
      grid-row: 2;
      padding: 22px 28px 36px;
    }

    .copy h1 {
      font-size: clamp(2rem, 8vw, 3.7rem);
    }

    .copy > p {
      margin-top: 12px;
      font-size: 1rem;
    }

    .final-actions {
      margin-top: 18px;
    }

    .feature-mask {
      top: -55%;
      right: -8%;
      width: 70vw;
    }

    .navigation {
      right: 28px;
      bottom: 14px;
      left: 28px;
    }

    .navigation button {
      width: 42px;
      height: 42px;
    }

    .main-screenshot {
      width: min(100%, 720px);
      max-height: 46vh;
      border-radius: 14px;
    }

    .foreground {
      width: min(42vw, 260px);
      max-height: 20vh;
      border-radius: 10px;
    }
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

    .product-slide {
      animation-name: reduced-fade;
    }

    .main-screenshot,
    .foreground {
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
