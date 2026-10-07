---
format: 1080x1920
duration: 30s
message: "各家帳戶的錢，OctopusBeak 幫你一次加總，不用一個個 App 打開"
arc: Hook → Question → The sum → The answer → Proof → Brand
audience: Taiwanese Mac users whose money sits across a salary bank, a card bank, and a brokerage
mode: autonomous
music: playful confident minimal electronic, plucky marimba and light claps, clear pulse around 112 bpm, builds to a satisfying resolve, clean ending
---

"How much money do I have?" is a sum whose terms live in different apps. App tiles pile
up while a counter of opened apps climbs; then the tiles drop into a vertical addition
on paper where every amount is 「?」. OctopusBeak arrives, the question marks roll into
real numbers like an odometer, a rule line draws, and the total lands on the same net
worth the real 總覽 screen shows.

## Video direction

- **Canvas and safe zones.** 1080×1920. Readable content inside y 220–1540. Readable type ≥ 56px; headlines 96–112px; amounts mono. Screenshots are evidence: crop tight, never shrink a whole screen into a thumbnail.
- **Two grounds.** *Night* (frames 1, 2, 6): deep blue `#071f4a` → `#0d4672` → teal `#12808f` diagonal gradient (top-left → bottom-right) as a full-duration `class="clip"` background layer; `#waves-teal` wave lines from `assets/banknote-defs.svg` full-bleed, pattern color `#18a9a4`, layer opacity 0.5; one `#rosette` 1100px centered (540, 960), stroke mint `#edf4f1` at 0.2. *Paper* (frames 3–5): `#f9fafc` with a mint `#edf4f1` radial wash bottom-right, `#waves-ink` (pattern color `#0e1217`) at 0.05, and the same rosette in ink `#2c6485` at 0.06. In both grounds the rosette rotates linearly at 0.6°/s of film time: angle = 0.6 × (frameStart + t). Frame starts: F1 0, F2 6, F3 11, F4 17, F5 22, F6 26.5.
- **App tiles.** White rounded squares, radius 46 (iOS-like), shadow `0 18px 36px rgba(0,0,0,.30)` on night, `0 10px 24px rgba(15,23,42,.14)` on paper; the logo image is 120px centered (small source files go soft above that). A tile's label sits under it: 40px white 600 on night.
- **Tile grid (frame 2 → 3 handoff).** Six tiles 200×200, centers: row 1 y=980 — 富邦 `fubon` (260), 元大證券 `yuanta-securities` (540), MaiCoin `maicoin` (820); row 2 y=1240 — 元大銀行 `yuanta-bank` (260), 國泰世華 `cathay` (540), 玉山 `esun` (820). Rotation 0, scale 1.
- **The ledger column (frames 3–5) — fixed geometry.** Title 「你有多少錢？」 104px 700 ink `#0e1217`, left x=110, baseline y=400. Six rows, row centers y = 560, 670, 780, 890, 1000, 1110; each row: logo 72px (inside a 96px white rounded tile, radius 24) centered x=158; label 50px 600 ink at x=230 (銀行、證券、加密資產、基金、外幣、負債); amount right-aligned at x=970 in `"SF Mono", ui-monospace, Menlo` 700 60px tabular, ink — before it is known it reads 「?」 in accent teal `#18a9a4`. The liabilities row's amount is red-brown `#8a3b2e` with a leading 「−」. A 「+」 operator 60px muted `#5e646a` at x=110 on the 外幣 row. Rule line y=1185, x 110 → 970, 6px ink. Total row: label 「淨資產」 52px 700 at x=110 baseline y=1290; amount 「TWD 2,148,216」 mono 700 84px right-aligned at x=970, baseline y=1300.
- **Real amounts (from the app's own screens; never change them).** 銀行 699,160 · 證券 1,284,600 · 加密資產 809,297 · 基金 356,200 · 外幣 330,281 · 負債 −1,331,322 · 淨資產 TWD 2,148,216.
- **Type.** CJK `"PingFang TC"`; numbers `"SF Mono"` with tabular-nums. Declare both with `@font-face { src: local(...) }` (PingFangTC-Regular / -Medium / -Semibold, SFMono-Regular / -Bold); the render runs locally on macOS. Night headlines are white with a vertical gradient `linear-gradient(180deg, #ffffff 15%, #c4f5ee 78%, #5fd4c9 118%)` clipped to the text. Sun Yat-sen engravings are tinted teal: `filter: grayscale(1) sepia(1) hue-rotate(130deg) saturate(1.6) brightness(.95)`.
- **Motion grammar.** `power3.out` settles; `expo.out` for slams and fast arrivals; `power2.inOut` for camera moves. One `.world` camera wrapper per frame. Odometer rolls are stepped vertical tickers. No bounce/elastic, no Math.random, no infinite tweens, no CSS transitions. Reveal on cue across the frame; holds keep only the rosette turning.
- **Negative list.** No phone mockups or fake device chrome, no stock icons for banks, no purple AI gradients, no bokeh.

## Frame 1 — 一間、一間、又一間

- scene: On the night field the hook builds phrase by phrase — 「薪轉一間、」 slams in with the 富邦 tile, 「繳卡費一間、」 with 玉山, 「買股票又一間。」 with 元大證券 — each tile labelled 薪轉 / 卡費 / 股票
- voiceover: ""
- onscreen: "薪轉一間、" / "繳卡費一間、" / "買股票又一間。"
- duration: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- type: hook
- persuasion: Recognition
- beat: tension
- blueprint: kinetic-type-beats (Adapt)
- focal: the three app tiles under the three phrases
- roles: logos = content · banknote-defs = ground
- asset_candidates: assets/logos/fubon.webp, assets/logos/esun.webp, assets/logos/yuanta-securities.webp, assets/banknote-defs.svg
- sfx: pop, pop, pop
- handoff_in: loop-friendly opening — night ground only (rosette angle 0).
- handoff_out: three headline lines left x=100, 104px 700, baselines y=420, 560, 700, white gradient, opacity 1: 「薪轉一間、」, 「繳卡費一間、」, 「買股票又一間。」; three tiles 220×220 at centers (260, 1060) 富邦, (540, 1060) 玉山, (820, 1060) 元大證券, rotation 0, scale 1, each with its label under it (薪轉 / 卡費 / 股票, 40px, centered, baseline y=1230).

Adapt kinetic-type-beats: three beats, one phrase + one tile per beat, payoff on the third.
Scene 1 (0.0–0.4s): night ground only.
Scene 2 (0.4–1.9s): 「薪轉一間、」 slams in (`kinetic-beat-slam` scale-slam) at baseline 420; on the same beat the 富邦 tile drops into (260, 1060) with `expo.out` and its label 薪轉 prints under it.
Scene 3 (1.9–3.4s): 「繳卡費一間、」 side-snaps in at baseline 560; the 玉山 tile drops to (540, 1060), label 卡費.
Scene 4 (3.4–4.9s): 「買股票又一間。」 lands at baseline 700 with the heaviest hit (rise-rotate, the 「又」 flashes teal `#5fd4c9` once); the 元大證券 tile drops to (820, 1060), label 股票.
Scene 5 (4.9–6.0s): hold; the three tiles keep still.

## Frame 2 — 得打開幾個 App？

- scene: The three lines clear and the question 「你要確認自己有多少錢，得打開幾個 App？」 takes over; more tiles pop in to a 3×2 grid, each gets tapped open to a login card with password dots, and an 「已打開」 counter climbs 1 → 6
- voiceover: ""
- onscreen: "你要確認自己有多少錢，" / "得打開幾個 App？"
- duration: 5s
- transition_in: none
- status: animated
- src: compositions/frames/02-question.html
- type: problem
- persuasion: Pain amplification
- beat: tension peak
- blueprint: overwhelm-surround (Adapt)
- focal: the tile grid and the opened-apps counter
- roles: logos = content · banknote-defs = ground
- asset_candidates: assets/logos/fubon.webp, assets/logos/esun.webp, assets/logos/yuanta-securities.webp, assets/logos/maicoin.webp, assets/logos/yuanta-bank.webp, assets/logos/cathay.webp, assets/banknote-defs.svg
- sfx: whoosh, tap, tap, tap, tap, tap, tap
- handoff_in: identical to Frame 1 handoff_out (three headline lines at x=100 baselines 420/560/700; tiles 220px at (260,1060) 富邦, (540,1060) 玉山, (820,1060) 元大證券 with labels).
- handoff_out: night ground; no headline, no counter, no login cards; six tiles 200×200 at the Video-direction tile grid (row 1 y=980: 富邦 260, 元大證券 540, MaiCoin 820; row 2 y=1240: 元大銀行 260, 國泰世華 540, 玉山 820), rotation 0, scale 1, no labels.

Adapt overwhelm-surround: the surround is apps you must open, one by one.
Scene 1 (0.0–0.6s): the three lines and the labels lift 60px and fade; the three tiles glide to their grid slots and shrink to 200px (富邦 → (260,980), 元大證券 → (540,980), 玉山 → (820,1240)), `power3.out`.
Scene 2 (0.4–1.6s): the question sets in two lines, left x=100, 96px 700, white gradient, baselines y=420 and y=540: 「你要確認自己有多少錢，」 then 「得打開幾個 App？」 (word-staggered `waterfall-entry`); meanwhile MaiCoin, 元大銀行 and 國泰世華 tiles pop into their grid slots (`spring-pop-entrance`, small overshoot).
Scene 3 (1.6–4.2s): the tiles get "opened" one after another in grid order every 0.42s: a teal tap ripple on the tile, then a small white login card (300×150, radius 24) flips up from the tile showing 「••••••」 and a teal bar, holds 0.3s and folds back. A counter at bottom-left x=100, y=1470 reads 「已打開」 44px + a mono number 96px that steps 1 → 6 in lockstep with each tap (`discrete-text-sequence`); the number turns `#ffb4a2` (warm alarm) from 5 on.
Scene 4 (4.2–5.0s): the question and counter fade out; tiles hold at the grid for the handoff.

## Frame 3 — 這道加法

- scene: Paper washes over the night; the six tiles shrink into the left column of a vertical addition 「你有多少錢？」 where every amount is a teal 「?」; then the OctopusBeak icon stamps onto the page and the 「?」 roll like odometers into the real amounts, row by row
- voiceover: ""
- onscreen: "你有多少錢？" / "銀行 證券 加密資產 基金 外幣 負債"
- duration: 6s
- transition_in: none
- status: animated
- src: compositions/frames/03-sum.html
- type: product_intro
- persuasion: Show-don't-tell
- beat: turn
- blueprint: compose
- focal: the ledger column
- roles: logos = row marks · app-icon = the product arriving · banknote-defs = paper texture
- asset_candidates: assets/logos/fubon.webp, assets/logos/yuanta-securities.webp, assets/logos/maicoin.webp, assets/logos/yuanta-bank.webp, assets/logos/cathay.webp, assets/logos/esun.webp, assets/app-icon-180.png, assets/banknote-defs.svg
- sfx: swoosh, stamp, ticker, ticker, ticker, ticker, ticker, ticker
- handoff_in: identical to Frame 2 handoff_out (night ground; six 200px tiles at the tile grid).
- handoff_out: paper ground; the full ledger column per Video direction with all six amounts filled (699,160 / 1,284,600 / 809,297 / 356,200 / 330,281 / −1,331,322), the 「+」 on the 外幣 row, title 「你有多少錢？」 at baseline 400; the OctopusBeak icon 120px (radius 28, shadow) at center (900, 360), rotation −6°; rule line NOT drawn yet; total row NOT shown.

Scene 1 (0.0–1.0s): the paper ground wipes in from the bottom edge upward behind the tiles (a straight edge riding a band of `#waves-teal` lines, `power2.inOut`); each tile flies to its row's logo slot — 富邦 → 銀行 row, 元大證券 → 證券, MaiCoin → 加密資產, 元大銀行 → 基金, 國泰世華 → 外幣, 玉山 → 負債 — shrinking to the 96px row tile (stagger 0.05s, `power3.out`).
Scene 2 (0.8–1.8s): title 「你有多少錢？」 rises in; labels print left→right on each row (stepped clip, 0.08s stagger); every amount shows a teal 「?」 that pops in (`spring-pop-entrance`).
Scene 3 (1.9–2.4s): the OctopusBeak icon drops from above and stamps at (900, 360) with `expo.out` and a 3px page shake.
Scene 4 (2.5–5.4s): row by row (stagger 0.45s), each 「?」 rolls up into its real amount as an odometer (`vertical-spring-ticker`, digits roll 0.4s, ease out); the ink color replaces teal as each lands; the liabilities row lands last in red-brown with its 「−」. A thin teal check flicks at each row's right edge as it lands.
Scene 5 (5.4–6.0s): hold.

## Frame 4 — 加總

- scene: The rule line draws under the column, the 「+」 pulses, and 淨資產 counts up to TWD 2,148,216; a teal highlight sweeps the total; the line 「打開 1 個 App 就好」 sets above it
- voiceover: ""
- onscreen: "淨資產 TWD 2,148,216" / "打開 1 個 App 就好"
- duration: 5s
- transition_in: none
- status: animated
- src: compositions/frames/04-total.html
- type: feature_showcase
- persuasion: Payoff
- beat: climax
- blueprint: dataviz-countup (Adapt)
- focal: the total amount
- roles: ledger column = content · app-icon = product mark
- asset_candidates: assets/app-icon-180.png, assets/logos/fubon.webp, assets/logos/yuanta-securities.webp, assets/logos/maicoin.webp, assets/logos/yuanta-bank.webp, assets/logos/cathay.webp, assets/logos/esun.webp, assets/banknote-defs.svg
- sfx: pen draw, rising whoosh, cash register ding
- handoff_in: identical to Frame 3 handoff_out (full column with all amounts, icon at (900,360) rotated −6°, no rule line, no total).
- handoff_out: paper ground; the same column, rule line drawn, total row shown (「淨資產」 + 「TWD 2,148,216」 at its geometry); the title line now reads 「打開 1 個 App 就好」 (104px, same baseline 400) with the 「1」 in teal; icon unchanged.

Adapt dataviz-countup: the number is the payoff.
Scene 1 (0.0–0.6s): the rule line draws left→right (`svg-path-draw`), the 「+」 pulses once.
Scene 2 (0.5–2.4s): 「淨資產」 prints; the total counts up from TWD 0 to TWD 2,148,216 (`counting-dynamic-scale`, `power3.out`), landing with one teal flash and a soft highlight bar (teal at 0.14) sweeping behind the amount.
Scene 3 (2.5–3.6s): the title 「你有多少錢？」 swaps in place to 「打開 1 個 App 就好」 (hard swap, the 「1」 in teal, `discrete-text-sequence`).
Scene 4 (3.6–5.0s): hold.

## Frame 5 — 真的算給你看

- scene: The column slides up and away while the real 總覽 net-worth card (screenshot) rises into the same spot showing TWD 2,148,216, with the assets split and the liabilities total clipped beside it as evidence; caption 「OctopusBeak 自動收齊各家帳戶」
- voiceover: ""
- onscreen: "OctopusBeak 自動收齊各家帳戶" / "在你的 Mac 上算好"
- duration: 4.5s
- transition_in: none
- status: animated
- src: compositions/frames/05-proof.html
- type: proof
- persuasion: Evidence
- beat: confidence
- blueprint: zoom-out-workspace-reveal (Adapt)
- focal: the real overview net-worth card
- roles: overview = proof plate · assets/liabilities = supporting clippings
- asset_candidates: assets/overview.webp, assets/assets.webp, assets/liabilities.webp, assets/app-icon-180.png, assets/banknote-defs.svg
- sfx: swoosh, paper flick
- handoff_in: identical to Frame 4 handoff_out (paper ground; column with rule and total TWD 2,148,216; title 「打開 1 個 App 就好」; icon at (900,360)).
- handoff_out: night ground only (gradient, waves, rosette), nothing else — the paper has washed back to night.

Scene 1 (0.0–0.8s): camera (`.world`) pulls the whole column up and fades it while a clipping of `assets/overview.webp` — crop to the net-worth card (source x 590–2780, y 320–1300) — rises into the middle (x 70–1010, top y≈560), tilt −1°, white 10px border, soft shadow.
Scene 2 (0.8–2.2s): two supporting clippings slide in under it, slightly overlapping: `assets/assets.webp` top total card (source x 80–2260, y 60–320) and `assets/liabilities.webp` top total card (source x 80–2260, y 60–320), each scaled to 900 wide, tilted +1.5° / −1.5°, at y≈1060 and y≈1250; a teal marker circle draws around the TWD 2,148,216 on the overview clip (`svg-path-draw`).
Scene 3 (1.0–2.6s): caption at the top, left x=90, two lines: 「OctopusBeak 自動收齊各家帳戶」 (64px 700 ink) and 「在你的 Mac 上算好」 (52px, accent `#2c6485`), baselines y=330 and y=420.
Scene 4 (2.6–3.9s): hold.
Scene 5 (3.9–4.5s): the night ground wipes back over everything from the top (band of `#waves-teal` lines on the edge), leaving night ground only.

## Frame 6 — 一個 App，就夠

- scene: On the night field the OctopusBeak lockup sets with the teal-engraved Sun Yat-sen facing the viewer; 「資料只留在你的 Mac」, the download pill and the URL close the film, then everything fades back to the opening field
- voiceover: ""
- onscreen: "OctopusBeak" / "資料只留在你的 Mac" / "下載 macOS Beta" / "wangwilly.github.io/OctopusBeak"
- duration: 3.5s
- transition_in: none
- status: animated
- src: compositions/frames/06-close.html
- type: cta
- persuasion: Trust + action
- beat: resolve
- blueprint: logo-assemble-lockup (Adapt)
- focal: the brand lockup
- roles: sun-phone-facing = character · app-icon = lockup mark · banknote-defs = ground
- asset_candidates: assets/sun-phone-facing.webp, assets/app-icon-180.png, assets/banknote-defs.svg
- sfx: chime
- handoff_in: identical to Frame 5 handoff_out (night ground only).
- handoff_out: loop seam — content fades out in the last 0.4s, leaving night ground only.

Scene 1 (0.0–0.8s): app icon 160px (radius 36) pops in at (190, 420) and 「OctopusBeak」 112px 700 white sets to its right (left x=300, baseline y=460) — `spring-pop-entrance` on the icon, stepped clip on the word.
Scene 2 (0.3–1.3s): Sun Yat-sen (facing, teal-tinted, 600px tall) rises from below to sit bottom-right, image box x 520–1120, bottom at y=1540 under a soft bottom fade mask; a mint glow (opacity 0.3) blooms behind him.
Scene 3 (0.8–1.8s): 「資料只留在」 / 「你的 Mac」 (96px 700, white gradient, left x=100, baselines y=720 and y=836) enter word-staggered; a 56px mint lock icon precedes line one.
Scene 4 (1.6–2.3s): pill 「下載 macOS Beta」 (44px 600, ink on `#c9efe9`, radius 999, left x=100, center y=960) rises in; URL 「wangwilly.github.io/OctopusBeak」 SF Mono 30px mint at left x=100, center y=1050 wipes in. Keep the text column left of x=560 so it never covers his face.
Scene 5 (2.3–3.1s): hold.
Scene 6 (3.1–3.5s): everything but the ground fades to 0.
