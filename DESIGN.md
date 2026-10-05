---
name: OctopusBeak
description: A private, local ledger for Taiwan bank, card, brokerage, crypto, and e-invoice data.
colors:
  paper-bg: "oklch(98.5% 0.003 250)"
  paper-white: "oklch(100% 0 0)"
  paper-soft: "oklch(96.5% 0.004 250)"
  slate-ink: "oklch(18% 0.012 250)"
  graphite-muted: "oklch(50% 0.012 250)"
  hairline: "oklch(90% 0.006 250)"
  ledger-blue: "oklch(48% 0.08 238)"
  ledger-blue-wash: "oklch(95% 0.018 238)"
  settled-green: "oklch(47% 0.08 155)"
  caution-ochre: "oklch(56% 0.08 82)"
  overdrawn-red: "oklch(48% 0.09 28)"
  series-blue: "oklch(52% 0.11 250)"
  series-green: "oklch(52% 0.09 170)"
  series-ochre: "oklch(56% 0.1 70)"
  series-plum: "oklch(53% 0.08 320)"
  series-clay: "oklch(50% 0.07 35)"
  series-teal: "oklch(49% 0.06 215)"
  series-violet: "oklch(50% 0.05 285)"
  series-slate: "oklch(46% 0.035 250)"
  viewer-night: "oklch(18% 0.025 250)"
  vault-blue: "#071f4a"
  engraving-teal: "#18a9a4"
  banknote-mint: "#edf4f1"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Display\", \"Inter\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "clamp(36px, 5vw, 72px)"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Display\", \"Inter\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "clamp(30px, 3.9vw, 56px)"
    fontWeight: 560
    lineHeight: 1.24
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Display\", \"Inter\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Inter\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Inter\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "0.075em"
  figure:
    fontFamily: "\"Courier Prime\", \"SFMono-Regular\", ui-monospace, Menlo, Consolas, monospace"
    fontSize: "clamp(22px, 2.5vw, 32px)"
    fontWeight: 750
    lineHeight: 1.1
    fontFeature: "\"tnum\""
rounded:
  sm: "6px"
  control: "8px"
  md: "10px"
  popover: "12px"
  lg: "16px"
  pill: "999px"
  panel: "clamp(24px, 2.8vw, 40px)"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  button-primary:
    backgroundColor: "{colors.slate-ink}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-default:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.ledger-blue-wash}"
    textColor: "{colors.ledger-blue}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-danger:
    textColor: "{colors.overdrawn-red}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  chip:
    backgroundColor: "{colors.paper-soft}"
    textColor: "{colors.graphite-muted}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  currency-chip:
    textColor: "{colors.graphite-muted}"
    rounded: "{rounded.pill}"
    padding: "5px 8px"
  card:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.lg}"
    padding: "20px"
  input-search:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  nav-link:
    textColor: "{colors.paper-white}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
  sidebar:
    backgroundColor: "{colors.slate-ink}"
    textColor: "{colors.paper-white}"
    width: "256px"
    padding: "24px"
  switch:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    width: "76px"
    height: "36px"
  popover:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.popover}"
    padding: "16px"
    width: "360px"
  modal:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.lg}"
    width: "920px"
  sync-sheet:
    backgroundColor: "{colors.paper-white}"
    padding: "28px"
    width: "455px"
  stage-number:
    backgroundColor: "{colors.ledger-blue}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.pill}"
    size: "36px"
  progress-bar:
    backgroundColor: "{colors.paper-soft}"
    rounded: "{rounded.pill}"
    height: "6px"
  option-tile:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.md}"
    padding: "12px"
    height: "44px"
  option-tile-checked:
    backgroundColor: "{colors.ledger-blue-wash}"
  floating-notice:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.graphite-muted}"
    rounded: "{rounded.popover}"
    padding: "10px 14px"
  verification-viewer:
    backgroundColor: "{colors.viewer-night}"
    rounded: "{rounded.lg}"
  onboarding-coach:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
    width: "360px"
  skeleton:
    backgroundColor: "{colors.paper-soft}"
    rounded: "{rounded.popover}"
  site-button-mint:
    backgroundColor: "{colors.banknote-mint}"
    textColor: "{colors.vault-blue}"
    rounded: "{rounded.md}"
    padding: "0 22px"
    height: "52px"
---

# Design System: OctopusBeak

## Overview

**Creative North Star: "The Private Ledger"**

OctopusBeak looks like a bookkeeping instrument kept in a locked drawer: slate ink on near-white paper, figures set in a monospace face with tabular digits, and color held back so that when it appears it means something. The app's working screens (Overview, Assets, Spending, Automation) are dense, scannable, and quiet. A dark slate sidebar is the ledger's spine, the content sits on a cool paper ground, and every number lines up in columns so the user can check it.

The ledger has a watermark. The marketing site and the first-run welcome add a brand layer of deep vault blue, engraving teal, banknote mint, and security-print guilloche engravings (rosettes, wave fields, rules). That layer marks the threshold, the moment you open the vault. It does not appear on everyday working screens.

Both layers share one token base. `site/assets/site.css` re-declares `src/app.css`'s neutrals, accent, radii, and spacing, and adds the brand layer on top. Light mode is the only theme. No dark scheme is defined.

**Key Characteristics:**
- Slate-tinted neutrals (hue 250, very low chroma). There are no pure greys and no pure black.
- One muted accent, Ledger Blue, used for selection, charts, and secondary emphasis. Primary actions are ink, not blue.
- Figures use the monospace face with tabular digits (the `.money` and `.num` classes) and can be blurred when the user hides values.
- Cards stay flat with hairline borders. Shadow and frosted glass are reserved for things that float.
- Compact, precise controls: 40px default height, 13px semibold labels, uppercase tracked micro-labels.
- The brand layer (vault blue, teal, mint, engravings) appears only on the site and in the first run.

## Colors

A slate-and-paper palette with one restrained blue. The status colors are desaturated so they never shout.

### Primary
- **Ledger Blue** (`ledger-blue`): the single accent. Used for chart lines and areas, allocation and exposure row bars, the selected row's inset bar, secondary buttons, and accent-tinted hover borders. Kept at low chroma (0.08) so it reads as ink, not as a brand splash.
- **Ledger Blue Wash** (`ledger-blue-wash`): the background behind secondary buttons and accent-tinted surfaces.

### Neutral
- **Slate Ink** (`slate-ink`): body text, primary button fill, the active filter, the sidebar and dark panels (`--surface-strong`), and tooltip backgrounds at 92%.
- **Graphite Muted** (`graphite-muted`): secondary text, micro-labels, table headers, chart axes, and inactive filters.
- **Paper Background** (`paper-bg`): the app canvas behind cards.
- **Paper White** (`paper-white`): card, input, popover, and default button surfaces.
- **Paper Soft** (`paper-soft`): chip fill, hover fill, row-bar track, and the site's soft panels.
- **Hairline** (`hairline`): 1px borders, table rules, and the chart grid.

### Status
- **Settled Green** (`settled-green`): positive or complete states (`.chip.good`), tinted at 10% into white for the background.
- **Caution Ochre** (`caution-ochre`): warnings.
- **Overdrawn Red** (`overdrawn-red`): destructive actions and errors, tinted at 9% into white for the button background.

### Data Series
An eight-hue categorical set for charts, matched in lightness (46–56%) and kept at moderate chroma (0.035–0.11) so that no single series overpowers the others. The stacked balance chart cycles through them in this order: **Series Blue**, **Series Green**, **Series Ochre**, **Series Plum**, **Series Clay**, **Series Teal**, **Series Violet**, **Series Slate**. The spending categories map onto the same hues (food, daily, transport, shopping, home, leisure, other) through overridable `--spending-*` properties. Semantic charts reuse them by meaning: net worth uses blue, assets use green, and liabilities and credit cards use clay. The Overview allocation treemaps give each asset category a fixed hue (bank blue, fund green, securities ochre, crypto plum, foreign currency clay, other teal) and draw loans in slate and credit cards in clay.
- **Viewer Night** (`viewer-night`): the slightly blue-shifted dark ground behind the human-verification screenshot viewer, so a bright bank page reads as an embedded window.

### Brand Layer (site and first-run only)
- **Vault Blue** (`vault-blue`): the hero and night-panel gradient base, and text on mint.
- **Engraving Teal** (`engraving-teal`): the end of the gradient, a radial glow, and engraving ink at 34%.
- **Banknote Mint** (`banknote-mint`): the welcome canvas, mint panels, and the mint call-to-action button.

### Named Rules
**The Ink-Not-Blue Rule.** The primary action is Slate Ink filled with white text. Ledger Blue is for selection, data, and secondary emphasis, never the main call to action.

**The Tint-Don't-Mix Rule.** Derived surfaces are produced with `color-mix(in oklch, <token> N%, white|transparent)` from an existing token. Never introduce a new hex for a hover or a wash.

**The Equal Weight Series Rule.** Chart series share a lightness band of 46–56%. A new series color takes the next free hue at that lightness. Don't add a brighter color to make a series stand out; emphasize it with selection or a label instead.

**The Threshold Rule.** Vault Blue, Engraving Teal, Banknote Mint, and the engravings belong to the site and the first-run welcome or onboarding. Working app screens stay slate and paper.

## Typography

**Display Font:** the system UI stack, SF Pro Display (with Inter, Segoe UI, system-ui)
**Body Font:** SF Pro Text (with the same fallbacks)
**Figure Font:** Courier Prime in the app stack, which is declared but not bundled, so it resolves to SF Mono / ui-monospace. The site uses `ui-monospace, "SF Mono"` directly.

**Character:** Native macOS sans for everything verbal and a monospace with tabular digits for everything numeric. The contrast between words and figures is itself the ledger metaphor.

### Hierarchy
- **Display** (500, `clamp(36px, 5vw, 72px)`, 1.2): site hero only. In English it tightens to `clamp(34px, 4.6vw, 68px)`, line-height 1.06, and -0.03em; zh-TW keeps its looser leading and keeps phrase spans together with `nowrap`.
- **Headline** (560, `clamp(30px, 3.9vw, 56px)`, 1.24, balanced wrap): site section heads, with an optional muted `.tone` second line.
- **Title** (700, 16px): app panel titles (`.panel-title h2`). Modal heads are 22px.
- **Body** (400, 15px, 1.5): app default. The site lead is `clamp(17px, ~0.9rem + 0.45vw, 22px)` at 1.6 in muted ink.
- **Label** (720, 10–11px, 0.075em, uppercase): eyebrows, metric labels, and table headers.
- **Figure** (750, `clamp(22px, 2.5vw, 32px)`, 1.1, tabular): headline metric values. Inline amounts inherit size and keep the monospace face.

Weights are fine-grained (560, 680, 720, 750) to match SF's variable axis. Don't round them to 500, 600, or 700.

### Named Rules
**The Tabular Figures Rule.** Every monetary amount or count carries `.money` or `.num`, which applies the monospace face and `font-variant-numeric: tabular-nums`. Proportional digits in a column are a defect.

**The Bilingual Leading Rule.** Display and headline styles have explicit `:lang(en)` overrides. zh-TW keeps looser line-height (1.2–1.24) and phrase-level `nowrap` spans, while English tightens. Any new display style needs both.

## Layout

**App shell.** A two-column grid: a 256px dark sidebar (88px collapsed) and a fluid page, under a sticky 60px top bar that spans both. The top bar is translucent paper with a 16px backdrop blur and reserves 88px on the left for the macOS traffic lights in the Electron shell. Content is capped at 1440px and padded `32px clamp(16px, 4vw, 40px) 40px`.

**Rhythm.** A 4px base scale (4, 8, 12, 16, 20, 24, 32, 40). Card padding is 20px, grid gaps are 16px, and section gaps are 24px.

**Grids.** Metric cards use `repeat(auto-fit, minmax(min(100%, 260px), 1fr))`. Detail layouts are `1.35fr / 0.65fr` with a 320px floor on the aside.

**Breakpoints (app).** At 1180px the sidebar narrows to 216px, metrics drop to two columns, and two-column layouts stack. At 760px the shell becomes a single column, the sidebar becomes a static three-column nav, and the top bar shrinks to 56px.

**Site.** The container is 1232px with a `clamp(16px, 4vw, 64px)` gutter and `clamp(64px, 9vw, 132px)` section padding. Sections are inset rounded panels (`clamp(8px, 1.1vw, 16px)` inset, `clamp(24px, 2.8vw, 40px)` radius) stacked with a gap of one inset. Site breakpoints are 1100, 900, and 760px.

## Elevation & Depth

The system is flat at rest and lifts only what floats. Content cards, tables, and inputs have no shadow. They separate from the paper ground with a 1px Hairline border and a white fill. Anything that floats above content (sticky toolbars, filter groups, the selection action bar, popovers, modals) gets a soft, slate-tinted ambient shadow, and toolbars also get frosted glass (`backdrop-filter: blur(18px) saturate(1.12–1.15)` over semi-transparent paper).

### Shadow Vocabulary
- **Hairline lift** (`0 1px 2px rgb(15 23 42 / 0.06–0.08)`): the pressed filter segment and toggle hover.
- **Toolbar ambient** (`0 12px 28px rgb(15 23 42 / 0.05)`, hover `0 16px 34px / 0.09`): floating filter groups and selection bars.
- **Panel** (`--shadow`: `0 14px 34px rgb(15 23 42 / 0.07)`): modal panels.
- **Popover** (`0 14px 36px rgb(15 23 42 / 0.14)`): anchored popovers such as search, and the floating notice (`0 12px 30px / 0.14`).
- **Sheet edge** (`-7px 0 22px rgb(30 48 66 / 0.05)`): the right-hand sync sheet.
- **Coach** (`0 22px 50px rgb(15 23 42 / 0.28)`): the onboarding coach card above the dimmed page, the deepest shadow in the app.

### Named Rules
**The Flat-By-Default Rule.** A surface that scrolls with content has no shadow. Shadow means "this floats above the ledger".

**The Slate Shadow Rule.** Shadows are always tinted `rgb(15 23 42 / α)` and never pure black. Alpha stays at 0.14 or below, except for the onboarding coach (0.28), which floats above a dimmed page.

## Shapes

Gently rounded, never pill-shaped except for status chips and tracks. Use 6px for tooltips, 8px for small icon controls and segmented filters, 10px (`--radius`) for buttons, inputs, chips, and nav links, 12px for popovers and filter groups, and 16px (`--radius-lg`) for cards, modals, and the selection bar. Full pills (999px) are reserved for currency chips, switch tracks, and progress bars. Collapsed sidebar nav items become 48px squares with a 14px radius. On the site, panels and the hero's bottom edge take the larger fluid `panel` radius.

## Components

The feel is precise and quiet: compact controls, ink-filled primary actions, the accent saved for secondary emphasis, and no bounce.

### Buttons
- **Shape:** gently rounded (10px), 40px tall, 16px horizontal padding, 13px at weight 680 with 0.01em tracking.
- **Primary:** Slate Ink fill, white text, ink border.
- **Default:** Paper White fill, Hairline border, ink text.
- **Secondary:** Ledger Blue Wash fill, Ledger Blue text, border at 24% accent.
- **Danger:** Overdrawn Red text on a 9% red tint, border at 28% red.
- **Hover / Focus:** 160ms color and background transitions. Focus-visible draws a 3px ring of accent at 18% and removes the outline. Disabled sets 0.48 opacity and the not-allowed cursor.
- **Site variants:** `btn-ink` (lightens 14% toward white on hover), `btn-mint` (mint on vault blue, turns white on hover, and the arrow icon nudges 3px), and `btn-glass` (white 8% plus a 12px blur, for dark heroes). `btn-lg` is 52px tall with 16px text.

### Chips
- **Status chip:** 28px, Paper Soft fill, Hairline border, muted 12px uppercase text at weight 720 with 0.06em tracking. `.good` swaps to Settled Green text on a 10% green tint.
- **Currency chip:** a pill with a muted 7% tint, a softened border, and 12px text at weight 700 that never wraps. It lists the per-currency amounts in metric cards.

### Segmented Filters
A frosted pill group (12px radius, 4px inset) of transparent 28px segments in muted text. The pressed segment (`aria-pressed="true"`) gets a 72% paper fill, a hairline, and a hairline lift. A standalone pressed filter uses an ink fill instead.

### Cards / Containers
- **Corner Style:** 16px.
- **Background:** Paper White on the Paper Background canvas.
- **Shadow Strategy:** none (Flat-By-Default).
- **Border:** 1px Hairline.
- **Internal Padding:** 20px. Panel titles are 60px bands with a bottom hairline.
- **Metric card:** at least 144px tall, an uppercase label at the top, and a large tabular figure plus currency chips at the bottom.

### Inputs / Fields
- **Style:** 44px tall, 10px radius, Hairline border, white fill.
- **Focus:** the border turns ink and gains a 3px Paper Soft halo.

### Tables
Uppercase muted headers at 11px. Cells have 16px by 20px padding and a top hairline. Numeric columns are right-aligned. A selected or hovered account row takes a 5% Ledger Blue tint and a 3px inset accent bar on the left edge. Sortable numeric headers put the sort mark on the inside so the label's right edge lines up with the figures. Below 1180px the institution column is hidden, since every account label already starts with it. A row repeats its "updated" date only when it differs from the table's latest date, which is shown once under the table.

### Navigation
The sidebar is a Slate Ink spine with white text at 62% opacity, 44px links at weight 560, and 14px text. Hover and active states are white text on a white 8% fill with a white 10% hairline. The bottom of the sidebar shows a net-worth status figure. The collapse animates at 220ms with `cubic-bezier(0.2, 0.8, 0.2, 1)`.

### Charts (Sparkline)
The balance history is drawn with a 4px round-capped Ledger Blue line over a 14% accent area, with a Hairline grid and muted 11px axis labels. Dots are accent with a 3px white stroke. The tooltip is an ink body at 92% opacity with white text and a tabular figure.

### Month Pace Chart (Spending)
Answers "how is this month going against usual". The cumulative month-to-date line uses the Sparkline spec (Ledger Blue, round caps) and stops at the last day with data. Usual is a Graphite Muted dashed line to month end over a 12% muted band spanning the low to high of the 3 baseline months. A daily strip below shares the x axis: normal days are Ledger Blue at 55% (`color-mix`), the month's heaviest days (at most 3, at least twice the usual median day) are full Ledger Blue, refunds are Overdrawn Red, and the selected day gets a 2px ink outline. The companion 12-month trend draws complete months in full accent, the in-progress month at 55%, the first imported month at 35%, with a usual tick on each bar. Direction is stated in words, never colored red or green.

### Switch
A 76×36px bordered control (8px radius) pairing an icon with a 30×18px pill track. The track is ink when on and Hairline when off. Its 12px white thumb slides 12px over 180ms. Used for the values-visible toggle and the per-source enable toggles.

### Popover
Anchored to its trigger with CSS anchor positioning and placed 8px below it, at most 360px wide. Paper White with a Hairline border, a 12px radius, 16px padding, and the Popover shadow. It opens from `translateY(-4px) scale(0.98)` to rest over 140ms via `@starting-style`, and its backdrop is transparent, so the page stays visible.

### Modal
- **Backdrop:** slate at 44% (`rgba(14, 18, 28, 0.44)`) with a `blur(10px) saturate(0.84)` that fades in over 160ms.
- **Panel:** Paper White, Hairline border, 16px radius, Panel shadow. It is at most 920px wide and at most 760px tall (or the viewport height minus 40px), and rises from `translateY(10px) scale(0.985)` over 180ms with the ease-out curve.
- **Head:** a 20px padded band with a bottom hairline, a 22px title, and a 40×40px bordered close button. The body scrolls; the head stays put.
- **Variants:** detail modals (transactions, invoices, statements, assets) use the standard panel. The human-verification viewer modal is wider (at most 1080px, 20px radius) and can expand to nearly the full viewport.
- Reduced motion disables both entrance animations.

### Side Sheet
The sync sheet slides in from the right edge below the top bar. It is 455px wide, Paper White, has a left Hairline, a faint leftward shadow (`-7px 0 22px rgb(30 48 66 / 0.05)`), a 28px padded head, and its own scroll. Use it for a task list that runs alongside the dashboard instead of blocking it.

### Staged Workflow (Automation)
Automation progress reads as numbered stages inside one card, separated by hairlines.
- **Stage head:** at least 82px tall with 10px by 20px padding and a Paper Soft fill on hover. It contains a 36px **stage number** (a Ledger Blue disc with white monospace numerals at weight 760 and a faint accent shadow, or a Graphite Muted disc with no shadow when the stage is inactive), the title, and a 10px chevron caret that rotates over 180ms. The number and caret appear only when there is more than one stage; a single stage shows its title and sync action, and its table is not indented.
- **Sync hero:** a card-radius banner at least 116px tall with 24px by 30px padding and a 22px heading at -0.01em. While a run is active it turns accent-tinted (an accent-wash fill at 24% over white, with a border at 28% accent) and shows a **running kicker** (Ledger Blue text at 14px and weight 780, next to a spinner).
- **Progress bar:** a 6px pill track in Paper Soft with a Ledger Blue fill. In tables it sits in a progress cell at least 96px wide alongside a short line of copy.
- **Event and product rows:** rows at least 42px tall, separated by hairlines, with metadata aligned right. Product status text is Ledger Blue at weight 650 and turns Overdrawn Red when `data-status="failed"`.

### Option Tiles
Checkbox or radio choices rendered as 44px bordered tiles (10px radius, 12px padding) in a grid, used for statement types. When checked (`:has(input:checked)`), the border becomes Ledger Blue and the fill becomes Ledger Blue Wash. The whole tile is the click target.

### Notices and Banners
- **Prerequisite notice:** a card-level warning with a border at 34% Caution Ochre, a 6% ochre wash, 24px by 30px padding, and a list of the tasks it affects. Warnings tint the container; they never switch to a loud fill.
- **Projection state banner:** a 10px-radius inline strip with a Hairline border and muted text, explaining gaps in the derived data.
- **Floating notice:** a toast-like pill fixed 24px from the bottom-right corner, at most 420px wide, with a 12px radius, a slate shadow, a 14px spinner, and muted text. It turns Overdrawn Red when the action failed.
- **Inline block error:** a 10px-radius row with a border at 35% red and red text, with a Retry button aligned right.

### Loading States
- **Skeleton:** Paper Soft blocks (12–14px radius) with a 100° shimmer gradient over 1.4s. Route skeletons mirror the target layout (a 32px heading bar, a three-column grid of 104px tiles, and a 240px table).
- **Spinner:** a 14px ring with a 2px Hairline track and a Ledger Blue top arc that turns every 700ms. On ink buttons the track is white at 35% and the arc uses `currentColor`.
- **Progressive block:** an already-rendered block keeps its content while it refreshes and shows a spinner in its top-right corner instead of being replaced by a skeleton.
- Reduced motion stops the shimmer and the spinners.

### Human Verification Viewer
When a site needs a CAPTCHA or OTP, the bank page's screenshot is shown inside a Viewer Night frame (16px radius, Hairline border, a faint inner white line). It can zoom toward the challenge region over 180ms. A floating input and submit control sit next to the challenge itself. The frame says, without decoration, "this part is the bank's page, and you're the one acting on it".

### Onboarding Coach
- **Spotlight:** the target is ringed by a 3px white border plus a 4px Ledger Blue ring (12px radius, 6px outset). Everything else is dimmed with a 9999px spread shadow (`rgb(10 14 18 / 0.56)`), and invisible blockers prevent clicks outside the target.
- **Coach card:** a Paper White card at most 360px wide with a 16px radius and 24px padding, placed next to the target and falling back to the bottom-right corner. It contains a 32px pixel-art guide sprite on a two-frame 1.2s idle loop, 8px milestone dots (Hairline, or Ledger Blue for the current step), a 23px title, muted body copy, and compact 38px buttons.
- **Short viewports:** at 700px and 560px of height the padding, title, and sprite step down so the card always fits.
- The coach is the one place in the working app that may use a deeper shadow (`0 22px 50px`), because it floats above a dimmed page.

### Privacy Blur (signature)
When values are hidden, every `.money` or `[data-sensitive]` element blurs 10px, drops to 64% opacity, and can't be selected, with a 160ms transition. The switch track fades from ink to hairline. This is the ledger's visible privacy affordance.

### Engravings (site and first-run signature)
Security-print SVG textures (rosette, wave field, and rule) are inked through `currentColor` at low alpha (`--engrave-on-dark`: mint 18%, `--engrave-teal`: teal 34%) and drift a few pixels with the pointer over 900ms. They sit only on vault-blue or mint brand surfaces.

## Do's and Don'ts

### Do:
- **Do** set every amount in `.money` or `.num` (monospace with tabular digits) and right-align numeric columns.
- **Do** derive hovers, washes, and tints with `color-mix(in oklch, …)` from existing tokens.
- **Do** keep primary actions Slate Ink. Use Ledger Blue for selection, data, and secondary emphasis.
- **Do** keep content cards flat with a 1px Hairline border. Add shadow and frosted glass only to floating layers.
- **Do** write a `:lang(en)` override alongside any new display or headline style, and test both zh-TW and en lengths.
- **Do** respect `prefers-reduced-motion`. The site zeroes all transitions, and the app disables modal animation.
- **Do** honor the values-hidden blur on any new surface that shows money.
- **Do** take chart colors from the Data Series set in order, and reuse its semantic mapping (net worth in blue, assets in green, liabilities in clay).
- **Do** keep content in place while it refreshes (progressive block spinner). Show skeletons only on first load, shaped like the content they stand in for.
- **Do** frame anything from a third-party site (bank screenshots, CAPTCHA regions) in the Viewer Night frame so it never looks like OctopusBeak's own UI.

### Don't:
- **Don't** bring Vault Blue, Engraving Teal, Banknote Mint, or the engravings into working app screens (Overview, Assets, Spending, Automation, Settings).
- **Don't** use proportional digits for figures or mix currencies in one unlabeled number.
- **Don't** introduce pure black, pure grey, or untinted `rgba(0,0,0,…)` shadows. Neutrals and shadows are slate-tinted.
- **Don't** round font weights to the 100s. The fine-grained weights (560, 680, 720, 750) are deliberate.
- **Don't** add bouncy, springy, or scale-heavy motion. Transitions run 140–220ms with `ease` or `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- **Don't** use pills for buttons. Pills are for status chips, currency chips, and tracks only. Stage-number discs and milestone dots are the only other round shapes.
- **Don't** signal a warning or failure with a solid fill. Tint the container (6–10%) and color the text or border instead.
