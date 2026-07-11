# Octopus Beak Vertical Ad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a mobile-first 30-second Octopus Beak ad and five matching visual-reference images that accurately present the existing Electron desktop app.

**Architecture:** Keep the composition self-contained under `video/octopus-beak-vertical-ad/`. A small timeline module is the single source of truth for the eight scene boundaries and copy; `index.html` renders every state from the HyperFrames timeline rather than wall-clock time. Generated reference art establishes the atmosphere, while existing Octopus Beak dashboard screenshots provide truthful product visuals.

**Tech Stack:** HyperFrames HTML composition, CSS transforms, existing PNG dashboard assets, ImageGen reference imagery, FFmpeg-generated original instrumental pulse, Node.js standard-library assertions.

## Global Constraints

- Render exactly 30 seconds at 1080×1920 and 30 fps.
- Target mobile viewing; retain a central mobile-safe area for essential copy.
- Depict Octopus Beak as desktop Electron software, never as a mobile app.
- Use fictional, representative financial figures only.
- Use the exact approved Traditional Chinese copy in the storyboard below.
- Reference images may contain no required readable text, final figures, or brand logo; render all final copy in HTML.
- Add no runtime dependency or package script.

---

### Task 1: Create and approve five visual references

**Files:**
- Create: `outputs/ads/octopus-beak-vertical-ad/reference-manifest.md`
- Create: `outputs/ads/octopus-beak-vertical-ad/references/01-fragmented-finance.png`
- Create: `outputs/ads/octopus-beak-vertical-ad/references/02-account-integration.png`
- Create: `outputs/ads/octopus-beak-vertical-ad/references/03-cash-flow.png`
- Create: `outputs/ads/octopus-beak-vertical-ad/references/04-einvoice-spending.png`
- Create: `outputs/ads/octopus-beak-vertical-ad/references/05-investment-cta.png`
- Copy from: `site/assets/ob-dashboard-drilldown.png` to `video/octopus-beak-vertical-ad/assets/product/dashboard.png`
- Copy from: `site/assets/ob-automation-flow.png` to `video/octopus-beak-vertical-ad/assets/product/automation.png`

**Interfaces:**
- Produces: five 1080×1920 PNG reference images, named in chronological story order.
- Produces: two real Octopus Beak desktop screenshots for the composition; no generated dashboard UI substitutes for the product.
- Consumes: the approved colour treatment: dark violet base, magenta and coral-orange light, sharp editorial lighting, no readable text.

- [ ] **Step 1: Write the reference manifest before generation**

Record this table verbatim in `reference-manifest.md` so each asset has a reproducible purpose and prompt:

| File | Approved prompt |
| --- | --- |
| `01-fragmented-finance.png` | `Vertical 9:16 advertising reference, Taiwanese office worker leaving work at dusk, desk lit by a laptop and phone, abstract overlapping banking, credit-card, investment, and receipt windows with intentionally unreadable interface marks, deep violet background with magenta and coral-orange light trails, fast premium fintech editorial photography, no logos, no readable text, no numbers` |
| `02-account-integration.png` | `Vertical 9:16 advertising reference, elegant floating desktop monitor in a dark violet space, abstract account and card data streams converging into one calm luminous hub, magenta and coral-orange energy lines, premium Taiwanese fintech campaign, no people required, no logos, no readable text, no numbers` |
| `03-cash-flow.png` | `Vertical 9:16 advertising reference, close-up of a desktop financial dashboard behind translucent glowing cash-flow lines, one upward curve and one downward curve converging, deep purple black, vibrant magenta and coral-orange accents, crisp high-end product advertising, no readable text, no brand logo, no numbers` |
| `04-einvoice-spending.png` | `Vertical 9:16 advertising reference, abstract Taiwan electronic receipt tiles flowing into soft rounded spending categories around a desktop monitor, energetic violet magenta coral palette, polished modern fintech visual, no real receipt data, no readable text, no logos, no numbers` |
| `05-investment-cta.png` | `Vertical 9:16 advertising reference, confident end card atmosphere, desktop monitor centered against a dark violet to coral gradient, subtle investment line rising behind it, generous empty safe space above and below for later text, premium fintech campaign, no readable text, no logo, no numbers` |

- [ ] **Step 2: Generate the five references**

Use ImageGen once for each prompt and save the returned PNG under its manifest filename. Keep the model’s composition inside the middle 80% of the frame; retain clean space for HTML overlay copy.

- [ ] **Step 3: Verify the reference set visually**

Inspect all five images at their original resolution. Reject and regenerate any image that has legible synthetic words, visible personal account information, phone-native product UI, or a visual style outside dark violet / magenta / coral-orange.

- [ ] **Step 4: Copy the genuine product screenshots**

Copy the two named 1672×941 `site/assets` images into `video/octopus-beak-vertical-ad/assets/product/`. Use those copies inside desktop-window frames in the composition; do not crop them into a fake mobile application screen.

- [ ] **Step 5: Commit the approved visual package**

```bash
git add outputs/ads/octopus-beak-vertical-ad video/octopus-beak-vertical-ad/assets/product
git commit -m "feat: add vertical ad visual references"
```

### Task 2: Build the deterministic HyperFrames composition

**Files:**
- Create: `video/octopus-beak-vertical-ad/hyperframes.json`
- Create: `video/octopus-beak-vertical-ad/timeline.mjs`
- Create: `video/octopus-beak-vertical-ad/timeline.check.mjs`
- Create: `video/octopus-beak-vertical-ad/index.html`
- Use: `video/octopus-beak-vertical-ad/assets/product/dashboard.png`
- Use: `video/octopus-beak-vertical-ad/assets/product/automation.png`
- Use: `outputs/ads/octopus-beak-vertical-ad/references/*.png`

**Interfaces:**
- `timeline.mjs` exports `durationSeconds = 30` and `scenes`, an ordered array of `{ start, end, copy, visual }` values.
- `timeline.check.mjs` imports those values and exits successfully only when the scenes are contiguous, start at `0`, end at `30`, and contain the eight approved copy strings in order.
- `index.html` consumes `scenes` and the HyperFrames time signal to derive all opacity, translation, clipping, and scale. It must not use `Date`, random values, or elapsed browser time.

- [ ] **Step 1: Initialize the composition without adding a package dependency**

Run the HyperFrames CLI initializer in `video/octopus-beak-vertical-ad/`. Set the composition configuration to 1080×1920, 30 fps, and 30 seconds. Keep the generated configuration and only the minimum HTML entrypoint; do not modify the project’s `package.json`.

- [ ] **Step 2: Write the failing timeline check**

Create `timeline.check.mjs` using Node’s `assert/strict`. It must assert exactly these intervals and labels:

```js
[
  [0, 3, "一天的錢，去哪了？"],
  [3, 7, "帳戶。投資。消費。發票。"],
  [7, 11, "自動整合線上帳戶資料"],
  [11, 15, "今天，多了多少？\n花到哪裡？"],
  [15, 19, "發票消費，自動看懂"],
  [19, 23, "投資變化，也不漏看"],
  [23, 27, "30 秒，看清你的錢"],
  [27, 30, "前往網站，了解 Octopus Beak"]
]
```

- [ ] **Step 3: Run the check and verify it fails**

```bash
node video/octopus-beak-vertical-ad/timeline.check.mjs
```

Expected: failure because `timeline.mjs` does not yet export the required duration and scene array.

- [ ] **Step 4: Add the minimal scene data and make the check pass**

Export the eight entries above from `timeline.mjs` with visual identifiers `fragmented`, `fragmented-detail`, `integration`, `cash-flow`, `einvoice`, `investments`, `overview`, and `cta`. The check must also assert each `end` equals the following scene’s `start` and `scenes.at(-1).end === durationSeconds`.

Run:

```bash
node video/octopus-beak-vertical-ad/timeline.check.mjs
```

Expected: exit 0.

- [ ] **Step 5: Author the eight-scene HTML composition**

Use one full-frame scene layer per `visual` identifier. Preserve this visual mapping:

| Scenes | Treatment |
| --- | --- |
| `fragmented`, `fragmented-detail` | Reference `01` behind overlapping translucent desktop-source cards; large question then compact source list. |
| `integration` | Reference `02` plus real `automation.png` inside a labelled desktop-window chrome; source dots connect to one centre. |
| `cash-flow` | Reference `03` plus real `dashboard.png`; animate a balance card and opposed cash-flow curves. |
| `einvoice` | Reference `04`; receipt tiles turn into three rounded expenditure bars. |
| `investments` | Reference `05` cropped without its safe-space copy; a representative portfolio line and daily-change card appear. |
| `overview` | Assemble the account, cash-flow, spending, and investment cards into a single desktop overview. |
| `cta` | Return to reference `05`, centre the real desktop dashboard, and retain final copy at full opacity through 30 seconds. |

Every scene uses the same centre-safe copy column. Add a visible desktop title bar and window shadows to all product shots. Use only fictional labels and amounts, such as `今日資產變化 +NT$12,480`, `消費 NT$2,460`, and `投資 +1.8%`.

- [ ] **Step 6: Make motion seek-safe**

Drive all scene timing from the HyperFrames seek/time callback: calculate a clamped local progress from `scene.start`, `scene.end`, and the current composition time, then set CSS custom properties for each scene. Use CSS `opacity`, `transform`, and `clip-path` only. Do not use live timers, autonomous animation loops, or random stagger offsets.

- [ ] **Step 7: Lint and inspect the composition**

Run the HyperFrames lint and inspect commands for `video/octopus-beak-vertical-ad/`, then run the timeline check. Resolve every reported configuration, missing-asset, or non-deterministic-animation issue.

```bash
node video/octopus-beak-vertical-ad/timeline.check.mjs
```

Expected: exit 0 and HyperFrames reports a valid 30-second composition.

- [ ] **Step 8: Commit the composition**

```bash
git add video/octopus-beak-vertical-ad/hyperframes.json video/octopus-beak-vertical-ad/timeline.mjs video/octopus-beak-vertical-ad/timeline.check.mjs video/octopus-beak-vertical-ad/index.html
git commit -m "feat: compose vertical Octopus Beak ad"
```

### Task 3: Add original music and verify the rendered ad

**Files:**
- Create: `video/octopus-beak-vertical-ad/assets/audio/octopus-pulse.wav`
- Create: `video/octopus-beak-vertical-ad/RENDERING.md`
- Create: `video/octopus-beak-vertical-ad/output/octopus-beak-vertical-ad.mp4`

**Interfaces:**
- Produces: a 30-second, original, instrumental WAV with no voiceover and no external licence requirement.
- Produces: an H.264/AAC MP4 at 1080×1920, 30 fps, and exactly 30 seconds.
- `RENDERING.md` contains the exact final preview and render commands reported by the installed HyperFrames CLI.

- [ ] **Step 1: Generate a native instrumental pulse**

Use FFmpeg’s built-in audio source to create a simple original 120 BPM synth pulse. This avoids downloading a third-party track:

```bash
ffmpeg -f lavfi -i "aevalsrc=0.16*sin(2*PI*55*t)*exp(-18*mod(t\,0.5))+0.07*sin(2*PI*440*t)*exp(-28*mod(t\,0.25)):s=48000:d=30" -c:a pcm_s16le video/octopus-beak-vertical-ad/assets/audio/octopus-pulse.wav
```

- [ ] **Step 2: Check the soundtrack duration**

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video/octopus-beak-vertical-ad/assets/audio/octopus-pulse.wav
```

Expected: `30.000000`.

- [ ] **Step 3: Attach audio and render through HyperFrames**

Add `octopus-pulse.wav` to the composition according to the installed HyperFrames audio API, with gain that leaves the final CTA clean. Run the CLI preview, then render to `output/octopus-beak-vertical-ad.mp4`. Record the successful commands in `RENDERING.md`; do not add npm scripts.

- [ ] **Step 4: Perform boundary and mobile QA**

Seek the preview or rendered frames at 0, 3, 7, 11, 15, 19, 23, 27, and 30 seconds. Confirm the corresponding approved copy is legible, each transition has completed, the final CTA has uninterrupted visibility from 27–30 seconds, and no scene treats the product as a phone-native app.

Run:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -of default=noprint_wrappers=1 video/octopus-beak-vertical-ad/output/octopus-beak-vertical-ad.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,duration -of default=noprint_wrappers=1 video/octopus-beak-vertical-ad/output/octopus-beak-vertical-ad.mp4
git diff --check
```

Expected: video width `1080`, height `1920`, frame rate `30/1`, video and audio durations of `30.000000`, and no whitespace errors.

- [ ] **Step 5: Commit the finished ad**

```bash
git add video/octopus-beak-vertical-ad
git commit -m "feat: render Octopus Beak vertical ad"
```

## Plan Self-Review

- **Spec coverage:** Task 1 delivers the five defined references and genuine desktop imagery. Task 2 implements every approved storyboard interval, exact copy, desktop-product constraint, mobile-safe layout, deterministic motion, and fictional financial values. Task 3 supplies original music, final rendering, timing checks, and mobile QA.
- **Placeholder scan:** No task uses TBD/TODO language or defers a decision. The exact prompts, copy, asset locations, visual mappings, and validation criteria are defined.
- **Interface consistency:** `timeline.mjs` is the only timing authority; its `durationSeconds` and `scenes` exports are consumed by both the check and the HTML composition. Asset paths produced in Task 1 are the paths consumed by Task 2 and Task 3.
