# First-run Welcome design

Date: 2026-08-07

## Goal

Introduce OctopusBeak before a genuinely new user enters the existing bank-automation onboarding progression. The experience selects the interface language, establishes the product's emotional promise, previews the product with real screenshots, and ends with an explicit choice to start bank setup or enter the product without it.

First-run Welcome is not part of Settings onboarding. Restarting onboarding from Settings begins the existing milestone-driven bank-automation progression directly.

## Product boundaries

- Show First-run Welcome only when there is no Welcome state, no existing onboarding state, and no product data or automation history that identifies an existing user.
- Mark an existing user as having bypassed Welcome so an upgrade does not interrupt them later.
- Keep Welcome state independent from the existing `OnboardingState`.
- Persist the current slide after every completed transition.
- Persist language through the existing i18n locale store as soon as the person confirms a language.
- Complete Welcome only when the person makes the explicit choice on slide 6.
- Do not offer a global Skip action.
- `Start setup` completes Welcome, creates the existing onboarding state, and navigates to Automation.
- `Maybe later` completes Welcome without creating an onboarding state and enters Overview.

## State

Use a dedicated versioned renderer state under a new localStorage key:

```ts
type FirstRunWelcomeState = {
  version: 1;
  status: "active" | "completed" | "bypassed";
  currentSlide: 1 | 2 | 3 | 4 | 5 | 6;
  bankAutomationChoice: "start" | "later" | null;
};
```

The selected locale remains owned by the existing `octopusbeak-locale` setting rather than being duplicated in this object. An active state resumes at `currentSlide`; completed and bypassed states never render Welcome.

Eligibility must load enough of the existing Overview and Automation models to distinguish an empty installation from an existing user. Existing product data, automation history, or any existing onboarding state suppresses Welcome. Settings actions never clear or recreate Welcome state.

## Six-slide narrative

### 1. Language

- Render the supplied ink image as a full-window `cover` background.
- Place the ForceSimulation word `歡迎` or `Welcome` above the centered OctopusBeak app icon.
- Place native-name language cards below the icon: `繁體中文` and `English`.
- Preselect the system language visually, but require an explicit click, Enter, or Space confirmation.
- Confirming either card calls the existing locale setter, persists the choice, and advances to slide 2.

The force text begins as scattered particles and settles into the word. Pointer proximity creates a mild repulsion. The simulation cools after approximately 1.2 seconds and reheats only during pointer interaction. Particle count is capped according to rendered size and device pixel ratio. Under reduced motion, render a static DOM heading without starting the simulation; the canvas/SVG effect is always accompanied by a real accessible heading.

### 2. Introduction

Retain the same ink background and app icon so the first transition feels continuous. The icon expands outward and moves upward; the introduction appears below in two beats:

Traditional Chinese:

> 準備放手，讓資料自己就位。\
> 清晰看見全貌，智慧整理每一筆，安心掌握你的財務。

English:

> Ready to let go? Let your data fall into place.\
> See the whole picture clearly, organize every detail intelligently, and feel at ease with your finances.

An arrow points to the app icon. Clicking the icon is the required forward action. A deep-blue single-color circle expands from the icon center until it covers the window; slide 3 is swapped underneath, then the cover fades out.

### 3. Overview

Traditional Chinese:

> **終於清晰**\
> 一個視野，所有資產

English:

> **Beautiful clear view**\
> Net asset in one place

Use Overview as the main screenshot. Present Net change and Portfolio flow as two cropped foreground cards. Use the processed eye-magnifier icon as the enlarged background graphic behind the copy.

### 4. Assets and liabilities

Traditional Chinese:

> **交易歸檔**\
> 歷史追蹤，路徑直達

English:

> **Organized transactions**\
> One route to historical changes

Use Assets as the main screenshot. Present brokerage transaction/position and liability-change details as foreground cards. Use the processed asset-magnifier icon behind the copy.

### 5. Spending and receipts

Traditional Chinese:

> **財務日記**\
> 精彩生活，安心消費

English:

> **Financial diary**\
> Live fully, spend with confidence

Use Spending as the main screenshot. Present Receipt list and Receipt detail as foreground cards. Use the processed spending-magnifier icon behind the copy.

### 6. Bank automation choice

Traditional Chinese:

> **準備放手了嗎？**\
> 無風險自動收集帳務資料，再也不用親自填進試算表。\
> 憑證只保存在這台裝置上

Actions: `開始設定`, `稍後再說`

English:

> **Ready to let go?**\
> Collect your financial records risk-free—no more entering them into spreadsheets by hand.\
> Credentials stay on this device

Actions: `Start setup`, `Maybe later`

Use Credential settings as the single main screenshot. Use the processed key-vault icon behind the copy. The slide cannot advance through a forward swipe or arrow; one of the two explicit actions is required.

## Layout

Welcome occupies the full renderer window before the Dashboard shell is rendered. It is not a modal over the product.

Slides 1 and 2 use a centered vertical composition. Slides 3 through 6 use a stable split:

- left 62%: product screenshot composition;
- right 38%: progress-aware copy and actions;
- enlarged processed icon behind the right-side copy;
- previous and next icon buttons fixed to the bottom of the right copy region, independent of copy length.

At narrower widths, the split stacks with copy above and imagery below while preserving a fixed action area. Six non-interactive progress dots remain fixed at the top center on every slide. The active dot uses deep blue; inactive dots use low-contrast white or gray. Accessible text announces the current slide and total.

The main screenshot remains front-facing. Foreground cards use restrained offset, scale, and shadow. Pointer movement may produce subtle parallax, but there is no nested carousel.

## Visual assets

### Sources

The production asset set contains 35 PNG files:

- one OctopusBeak app icon from `~/Projects/ob-social-posts/assets/brand/`;
- one ink background supplied as `ChatGPT Image Aug 7 2026 from rasterizeText.png`;
- 22 localized screenshots from the 11 groups under `~/Documents/ob-welcome/`;
- 11 feature icons from those groups.

Copy all shipping outputs into a dedicated directory such as `src/lib/welcome/assets/`. Do not load production assets from the original external paths.

Use the ink image directly as the first two slides' background. Do not recreate it as a CSS gradient.

Do not recolor or place gradients over product screenshots. For feature icons only:

1. remove the background without changing the visible line silhouette;
2. retain a transparent alpha mask;
3. apply a blue-to-teal gradient to the line through CSS masking;
4. enlarge it behind the copy at low opacity.

The app icon retains its supplied appearance.

### Lossless compression

Every shipping asset must receive strict lossless optimization:

- retain dimensions, alpha, color, and text sharpness;
- do not use lossy palette quantization;
- compare decoded pixels before and after optimization;
- require exact equality for untouched screenshots and backgrounds;
- for transformed icons, compare the unoptimized processed output with its optimized output.

Record an asset manifest containing source, destination, dimensions, byte size before and after optimization, and decoded-pixel hash. Tests fail if a destination is missing, a hash differs, or a file is not represented by a Git LFS pointer.

### Git LFS

Track only the Welcome asset directory through Git LFS, for example:

```gitattributes
src/lib/welcome/assets/** filter=lfs diff=lfs merge=lfs -text
```

Do not migrate unrelated repository PNG files. Add `lfs: true` to checkout in `.github/workflows/pr-tests.yml` and `.github/workflows/release-macos.yml`; `.github/workflows/pages.yml` already enables it. Release packaging must verify that raster files contain PNG bytes rather than LFS pointer text before Electron Forge runs.

## Motion

- Slide 1 to 2: approximately 600 ms. Force text disperses, language cards fade, and the app icon expands and moves upward before the introduction appears in two staggered beats.
- Slide 2 to 3: approximately 700 ms. A deep-blue circle expands from the app icon, covers the viewport, swaps the underlying content, and fades.
- Slides 3 to 6: approximately 320 ms. The screenshot composition moves horizontally according to direction while fading; copy and background icon cross-fade.
- Reduced motion replaces spatial movement, parallax, force simulation, and circular expansion with short opacity transitions.

Do not autoplay between slides.

## Input and navigation

- Support horizontal trackpad swipe and pointer drag after a deliberate distance/velocity threshold.
- Support Left and Right Arrow keys.
- Support visible previous/next icon buttons where progression is not gated.
- Let every slide after the first return to the previous slide.
- Slide 1 advances only through language confirmation.
- Slide 2 advances only through app-icon activation.
- Slide 6 completes only through `Start setup` or `Maybe later`.
- Ignore a second navigation request while a transition is active.
- Preserve logical focus after every transition and expose visible focus states.

## Implementation shape

Create a focused `src/lib/welcome/` module:

- pure versioned state parsing, eligibility, and transition guards;
- one top-level Welcome component;
- a ForceText component and local text-rasterization utility;
- slide data/copy derived from the existing translation dictionary;
- asset manifest and processed LFS assets.

Integrate the gate in `src/routes/+page.svelte` before route content and the existing `OnboardingCoach` render. Reuse `setLocale` and the existing onboarding state factory. Do not modify Settings restart behavior beyond ensuring it never clears or reopens Welcome.

LayerChart 2.0.0 already exports `layerchart/force`. Add `d3-force` as a direct dependency rather than relying on LayerChart's transitive installation. The supplied `rasterizeText` helper is not part of this repository or LayerChart and must be implemented locally with deterministic sampling and bounded output.

## Accessibility

- Use real buttons for language cards, app-icon activation, arrows, and the final choices.
- Give the app-icon activation an explicit accessible name.
- Keep visible focus styles and deterministic focus movement.
- Announce slide changes politely without reading decorative imagery.
- Mark decorative icons, screenshot cards, particles, and ink background as hidden from accessibility APIs.
- Provide a semantic heading and copy independent from rasterized force text.
- Honor `prefers-reduced-motion`.
- Maintain readable contrast over the supplied background and gradient icons.

## Verification

### Pure behavior

- invalid, future, active, completed, and bypassed Welcome state;
- truly empty installation eligibility;
- suppression for every existing onboarding status and existing product-data signal;
- persisted resume on slides 1 through 6;
- language persistence without duplicating locale state;
- gated slide 1, slide 2, and slide 6 transitions;
- `Start setup` creates onboarding state and navigates to Automation;
- `Maybe later` does not create onboarding state and navigates to Overview;
- Settings restart leaves Welcome state unchanged.

### Interaction and accessibility

- pointer drag, trackpad-style wheel input, icon buttons, and keyboard arrows;
- transition lockout against double advancement;
- focus restoration and accessible page announcements;
- reduced-motion behavior;
- ForceSimulation cooling and bounded particle count.

### Assets and delivery

- exactly 35 manifest entries and shipping outputs;
- strict decoded-pixel equality after compression;
- transparent processed icon masks;
- Git LFS attributes and pointer checks;
- LFS checkout in PR and macOS release workflows;
- Vite production build and Electron Forge package contain real image bytes.

### Visual acceptance

Use Electron CDP to capture slides 1 through 6 in both locales at standard and narrow window sizes. Compare:

- centered composition on slides 1 and 2;
- stable 62/38 split and fixed copy-region controls on slides 3 through 6;
- uncropped important screenshot content;
- foreground-card hierarchy and restrained parallax;
- top-centered progress dots;
- icon gradient, opacity, and copy legibility;
- deep-blue circular transition origin and coverage;
- no movement under reduced motion beyond opacity changes.
