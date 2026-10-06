---
format: 1080x1920
duration: 30s
message: "設定一次，OctopusBeak 自動把各家帳戶收進你的 Mac，整理成一份財務全貌"
arc: Hook → Product → Step 1 → Step 2 → Step 3 → Promise + Brand
audience: Taiwanese Mac users juggling several bank, card, and investment accounts
mode: autonomous
music: upbeat confident minimal tech pop, light percussion and plucked synth, clear pulse around 110 bpm, social promo energy, clean ending
---

The film is a passbook (存摺). Twelve bank logos pile up as a chore, get swallowed by
a deep-blue engraved passbook cover, and the cover opens. Each step of how the app
works is one passbook page: lines print themselves like a passbook printer, and a
teal rosette stamp ①②③ closes the page. The book shuts into the brand lockup.
Vertical, muted-autoplay first: on-screen type carries every idea.

## Video direction

- **Canvas and safe zones.** 1080×1920. Keep anything readable inside y 220–1540 (feed UI covers the top ~220px and bottom ~380px). Readable type ≥ 56px; headlines 96–120px; amounts 64–96px mono. Real app screenshots are *evidence texture*: crop them tight to the part that matters and scale them up; never shrink a whole screen into an unreadable thumbnail.
- **Ground (every frame).** Deep blue `#071f4a` → `#0d4672` → teal `#12808f` diagonal gradient (top-left to bottom-right) as a full-duration background clip, with the banknote engraving from `assets/banknote-defs.svg`: `#waves-teal` wave lines at 0.5 opacity full-bleed, and one `#rosette` guilloche (stroke mint `#edf4f1` at 0.2) 1100px centered at (540, 960). The rosette rotates slowly and continuously across the whole film (0.6°/s, deterministic from frame start time: frame-local angle = 0.6 × (frameStart + t)). Frame start times: F1 0, F2 4.0, F3 8.5, F4 13.5, F5 19.5, F6 25.5.
- **The passbook object — fixed geometry shared by frames 2–6.** Book block 920×1240, top-left (80, 300), centered (540, 920), corner radius 28 on the right side and 10 on the spine (left). **Page**: paper `#fbfaf6` with a faint mint `#edf4f1` radial wash bottom-right, `#waves-ink` at 0.06, horizontal ruled lines every 72px starting y=520 (1px `#d9e2df`), a vertical double microline at x=150 (spine margin), soft shadow `0 40px 80px rgba(0,0,0,.35)`. **Cover**: same footprint, deep blue `#0a2a5c` with `#rosette` (mint 0.35) 760px centered on the cover, a 2px mint inset border 28px in, the app icon `assets/app-icon-180.png` 180px at (540, 760), 「OctopusBeak」 white 88px 700 centered at y=930, 「存摺」 mint 40px letter-spaced at y=1010. Cover and page turns hinge on the spine x=80 (`transform-origin: left center`, `perspective: 2400px` on the book wrapper, rotateY 0 → −180 for opening, page backs plain paper).
- **Page anatomy (frames 3–5).** Step badge: a 112px teal `#18a9a4` ring with the number inside (white on teal, 64px) at center (210, 420). Step title 92px 700 ink `#0e1217` left-aligned at x=290, baseline y=450. Printed rows start at y=560, 72px pitch, text 46px, mono amounts `"SF Mono", ui-monospace, Menlo` tabular. **Page stamp**: a 260px teal rosette seal (rosette stroke teal `#18a9a4`, ring text) centered (800, 1380), rotation −12°, multiply blend, opacity 0.92.
- **Printer grammar.** Passbook rows print one at a time: each row reveals left→right with a hard stepped clip (8 steps over 0.28s, `steps(8)`), never a soft fade, with one SFX tick per row. The stamp lands with `expo.out` from scale 1.6 → 1 in 0.18s plus a 3px book shake that decays in 0.25s — the heaviest hit of each page.
- **Type.** CJK `"PingFang TC", "Noto Sans TC", sans-serif`; headlines on the deep field are white with the site hero's teal→mint gradient (`#5fd4c9` → `#c4f5ee` → `#ffffff`, background-clip text). Sun Yat-sen engravings (`assets/sun-phone-*.webp`, red ink) are tinted teal as on the site: `filter: grayscale(1) sepia(1) hue-rotate(130deg) saturate(1.6) brightness(.95)`.
- **Motion grammar.** `power3.out` settles, `expo.out` only for fast arrivals and stamps, `power2.inOut` for page turns (0.55s). One camera per frame: a `.world` wrapper; no independent floating. No bounce/elastic, no Math.random, no infinite tweens, no CSS transitions. Reveal on cue across the whole frame; hold reads with only the rosette's slow rotation.
- **Negative list.** No device mockups, no fake browser chrome, no stock icons for banks (use `assets/logos/*.webp`), no purple AI gradients, no bokeh.

## Frame 1 — 一家家登入

- scene: On the engraved deep-blue field, twelve bank logo tiles pop in one after another and pile up while 「12 家網銀、每月一家家登入？」 builds above them
- voiceover: ""
- onscreen: "12 家網銀、" / "每月一家家登入？"
- duration: 4s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- type: hook
- persuasion: Pain validation
- beat: tension
- blueprint: overwhelm-surround (Adapt)
- focal: the pile of 12 logo tiles
- roles: logos = content (12 tiles) · banknote-defs = background
- asset_candidates: assets/logos/fubon.webp, assets/logos/esun.webp, assets/logos/yuanta-bank.webp, assets/logos/yuanta-securities.webp, assets/logos/cathay.webp, assets/logos/hncb.webp, assets/logos/ctbc.webp, assets/logos/post.webp, assets/logos/sinopac.webp, assets/logos/linebank.webp, assets/logos/einvoice.webp, assets/logos/maicoin.webp, assets/banknote-defs.svg
- sfx: soft pop, soft pop, keyboard typing short
- handoff_in: loop-friendly opening — ground only (gradient, waves, rosette at angle 0), nothing else.
- handoff_out: headline lines 「12 家網銀、」 baseline y=420 and 「每月一家家登入？」 baseline y=560, left x=90, 104px, white→mint gradient, opacity 1; twelve logo tiles (white rounded squares 200×200, radius 44, logo image 150px centered, shadow `0 18px 36px rgba(0,0,0,.3)`) at rest in a 3-col × 4-row pile: column centers x = 260, 540, 820; row centers y = 820, 1040, 1260, 1480 (order: fubon, esun, yuanta-bank / yuanta-securities, cathay, hncb / ctbc, post, sinopac / linebank, einvoice, maicoin), each with rotation from this list in the same order: −6, 4, −3, 7, −5, 2, 5, −7, 3, −4, 6, −2 degrees; scale 1, opacity 1.

Adapt overwhelm-surround: the "surround" is a pile that keeps growing faster — a chore, not a threat.
Scene 1 (0.0–0.4s): ground only; the rosette is already turning.
Scene 2 (0.4–1.4s): 「12 家網銀、」 enters word-by-word (`waterfall-entry`) upper-left; a small mono counter 「01」 in teal sits at the right end of the line (x≈930, y=420, 56px) and starts counting.
Scene 3 (1.0–3.0s): the 12 tiles drop in one by one at their pile positions with accelerating rhythm (first gaps 0.26s, last gaps 0.10s): each tile arrives from 120px above with `expo.out` 0.3s and a tiny `spring-pop-entrance` settle to its rotation; the counter steps 01 → 12 in lockstep with the tiles (`discrete-text-sequence`).
Scene 4 (2.6–3.4s): 「每月一家家登入？」 lands as the payoff line beneath (hard arrival, `kinetic-beat-slam` scale-slam, single hit).
Scene 5 (3.4–4.0s): hold; tiles keep their rest pose (no wobble). The counter fades out at 3.8s.

## Frame 2 — 交給 OctopusBeak

- scene: The passbook cover rises from below and the twelve tiles are sucked into it; the headline becomes 「交給 OctopusBeak」, then the cover swings open on a blank ruled page
- voiceover: ""
- onscreen: "交給 OctopusBeak" / "在你的 Mac 上自動收帳"
- duration: 4.5s
- transition_in: none
- status: animated
- src: compositions/frames/02-cover.html
- type: product_intro
- persuasion: Relief
- beat: turn
- blueprint: logo-assemble-lockup (Adapt)
- focal: the passbook cover
- roles: app-icon = cover mark · logos = content being absorbed · banknote-defs = cover rosette + ground
- asset_candidates: assets/app-icon-180.png, assets/banknote-defs.svg, assets/logos/fubon.webp, assets/logos/esun.webp, assets/logos/yuanta-bank.webp, assets/logos/yuanta-securities.webp, assets/logos/cathay.webp, assets/logos/hncb.webp, assets/logos/ctbc.webp, assets/logos/post.webp, assets/logos/sinopac.webp, assets/logos/linebank.webp, assets/logos/einvoice.webp, assets/logos/maicoin.webp
- sfx: whoosh, book open
- handoff_in: identical to Frame 1 handoff_out (headline two lines at x=90 baselines 420/560 104px; 12 tiles at the listed pile positions and rotations).
- handoff_out: the open passbook — book block at (80, 300) 920×1240 showing a blank page (paper, ruled lines, spine microline, no content); cover has fully swung open and is gone (rotateY −180 and faded out at the end of the turn); no headline; ground unchanged.

Adapt logo-assemble-lockup: the twelve marks assemble *into* the product.
Scene 1 (0.0–0.6s): the headline lines lift 60px and fade out (`power3.out`); simultaneously the cover enters from below (from y offset +900 to its geometry, `expo.out` 0.6s), passing behind the tile pile.
Scene 2 (0.5–1.6s): the tiles are pulled into the cover's center (540, 760) in a fast spiral: each tile travels to the icon spot while scaling to 0.2 and rotating to 0, staggered 0.05s in pile order, `power3.in` then vanishing at arrival (a short 3-ghost echo trail on the travel). The app icon on the cover does a single scale pulse (1 → 1.08 → 1) as the last tile lands (1.6s).
Scene 3 (1.4–2.6s): the cover's own type carries the line: 「交給」 white 56px appears just above the cover title at y=850 (centered), then 「OctopusBeak」 (cover title, y=930) and 「存摺」 (y=1010) reveal, then 「在你的 Mac 上自動收帳」 mint 48px at y=1110 — each with a stepped clip reveal (`waterfall-entry`). 「交給」 fades out at 2.6s so the cover matches the shared cover spec. Nothing is placed above the book (top band is unsafe).
Scene 4 (2.6–3.3s): hold on the closed cover; the rosette on the cover catches a single diagonal light sheen sweep (one pass, white at 0.25).
Scene 5 (3.3–4.5s): the cover swings open on the spine (rotateY 0 → −180, 0.7s `power2.inOut`), revealing the blank ruled page; the cover's front fades to 0 as it passes −90° so it never shows its back flat. Hold the blank page 0.4s.

## Frame 3 — ① 設定一次

- scene: Page one prints itself: 「① 設定一次」, the real 登入資料 screen pasted in as a clipping, three printed lines, then the ① stamp
- voiceover: ""
- onscreen: "① 設定一次" / "選銀行、勾要抓的資料" / "密碼加密，只存在這台 Mac"
- duration: 5s
- transition_in: none
- status: animated
- src: compositions/frames/03-setup.html
- type: feature_showcase
- persuasion: Ease
- beat: clarity
- blueprint: compose
- focal: the credentials clipping
- roles: credentials = evidence clipping · banknote-defs = stamp + ground
- asset_candidates: assets/credentials.webp, assets/banknote-defs.svg
- sfx: printer tick, printer tick, printer tick, stamp
- handoff_in: identical to Frame 2 handoff_out (blank ruled page at (80,300) 920×1240).
- handoff_out: the blank ruled page under a page that has just turned away — at the end of this frame the filled page turns over on the spine (rotateY 0 → −180, fading as it passes −90°), revealing a fresh blank ruled page at the same geometry; ground unchanged.

Scene 1 (0.0–0.6s): the step badge ① pops in (`spring-pop-entrance`, small overshoot) and the title 「設定一次」 prints with the printer grammar.
Scene 2 (0.5–1.8s): a clipping of `assets/credentials.webp` — crop to the left service list plus the 台北富邦銀行 header and 登入資料 rows (source region x 0–1300, y 170–1180) — slides in from the right and lands tilted −2° at x 130–950 (820 wide), top y=520, with a white 12px photo border and a small strip of translucent tape at its top edge; it settles with `power3.out`. Inside the clipping, one quick `coordinate-target-zoom` push (1 → 1.12) toward the masked password rows during 1.2–1.8s, then hold.
Scene 3 (1.9–3.6s): below the clipping, three passbook rows print one after another at y = 1180, 1252, 1324 (46px): 「✓ 選銀行」, 「✓ 勾要抓的資料」, 「🔒 密碼加密，只存在這台 Mac」 — use an inline SVG lock icon, not an emoji; mono dates on the left edge of each row 「10/06」 in muted `#5e646a`.
Scene 4 (3.7–4.0s): the ① stamp slams at (800, 1380) per the stamp grammar.
Scene 5 (4.0–4.4s): hold.
Scene 6 (4.4–5.0s): page turn (handoff_out).

## Frame 4 — ② 一鍵同步

- scene: Page two: 「② 一鍵同步」; the real 同步資料 table's bars fill as passbook rows print 富邦、玉山、元大、MaiCoin 已完成 with logos; a chip reads 驗證碼在本機自動辨識; the ② stamp lands
- voiceover: ""
- onscreen: "② 一鍵同步" / "自動登入、下載對帳單" / "驗證碼在本機自動辨識"
- duration: 6s
- transition_in: none
- status: animated
- src: compositions/frames/04-sync.html
- type: feature_showcase
- persuasion: Show-don't-tell proof
- beat: momentum
- blueprint: agent-progress-theater (Adapt)
- focal: the printed sync rows
- roles: sync-data = evidence clipping (header + button only) · logos = row marks · banknote-defs = stamp
- asset_candidates: assets/sync-data.webp, assets/logos/fubon.webp, assets/logos/esun.webp, assets/logos/yuanta-bank.webp, assets/logos/maicoin.webp, assets/banknote-defs.svg
- sfx: button click, printer tick, printer tick, printer tick, printer tick, stamp
- handoff_in: identical to Frame 3 handoff_out (fresh blank ruled page at (80,300) 920×1240).
- handoff_out: same as Frame 3's — the filled page turns over on the spine revealing a fresh blank ruled page at the same geometry.

Adapt agent-progress-theater: the "work" is the passbook printing each institution as it finishes.
Scene 1 (0.0–0.6s): badge ② pops, title 「一鍵同步」 prints.
Scene 2 (0.6–1.4s): a clipping of `assets/sync-data.webp` cropped to its header strip 「同步資料 … 同步全部」 (source y 0–150, full width) lands at x 130–950, y 520, tilted 1.5°; a cursor (simple black arrow SVG) glides to the black 「同步全部」 button and clicks (`cursor-click-ripple`) at 1.2s.
Scene 3 (1.5–4.3s): four passbook rows print at y = 720, 828, 936, 1044 (row height 96 for logos): logo 64px (fubon, esun, yuanta-bank, maicoin) + name 46px (台北富邦、玉山銀行、元大銀行、MaiCoin) + a thin progress bar (x 600–860, 10px, mint track) that fills teal (`stat-bars-and-fills`, 0.45s each, staggered 0.65s), and when full the bar's end is replaced by 「已完成」 green `#2f7a55` 40px with a ✓ that draws (`svg-path-draw`).
Scene 4 (2.6–3.4s): sub-line 「自動登入、下載對帳單」 prints at y=1180 (46px ink).
Scene 5 (3.4–4.3s): a pill chip 「驗證碼在本機自動辨識」 (teal text on `#e3f4f2`, 42px, inline shield-check SVG) springs in at y=1270, x from 130 (`spring-pop-entrance`).
Scene 6 (4.5–4.8s): ② stamp slams at (800, 1380).
Scene 7 (4.8–5.4s): hold.
Scene 8 (5.4–6.0s): page turn (handoff_out).

## Frame 5 — ③ 一頁看清

- scene: Page three: 「③ 一頁看清」; the real 總覽 net-worth card counts up to TWD 2,148,216 as its line draws, then 資產、負債、消費 tabs fan out below it; the ③ stamp lands and the cover swings shut
- voiceover: ""
- onscreen: "③ 一頁看清" / "淨資產 TWD 2,148,216" / "資產 · 負債 · 消費"
- duration: 6s
- transition_in: none
- status: animated
- src: compositions/frames/05-overview.html
- type: feature_showcase
- persuasion: Payoff
- beat: climax
- blueprint: dataviz-countup (Adapt)
- focal: the net-worth count-up
- roles: overview = evidence clipping (net-worth card) · assets/spending/liabilities = fan of tab clippings · banknote-defs = stamp
- asset_candidates: assets/overview.webp, assets/assets.webp, assets/spending.webp, assets/liabilities.webp, assets/banknote-defs.svg
- sfx: rising whoosh, cash register ding, paper flick, stamp, book close
- handoff_in: identical to Frame 4 handoff_out (fresh blank ruled page at (80,300) 920×1240).
- handoff_out: the closed passbook cover exactly as specified in Video direction (cover at (80,300) 920×1240, app icon 180px at (540,760), 「OctopusBeak」 88px at y=930, 「存摺」 40px at y=1010, 「在你的 Mac 上自動收帳」 48px mint at y=1110), rotateY 0, opacity 1; ground unchanged.

Adapt dataviz-countup: the number is the payoff of every page before it.
Scene 1 (0.0–0.6s): badge ③ pops, title 「一頁看清」 prints.
Scene 2 (0.6–1.0s): a clipping of `assets/overview.webp` cropped to the net-worth card (source x 415–1945, y 225–910) lands at x 110–970, y 520 (scaled to 860 wide), tilt −1°.
Scene 3 (1.0–2.6s): over the clipping's big number area, a rebuilt overlay (white patch exactly covering the original 「TWD 2,148,216」 text) counts up from TWD 0 to TWD 2,148,216 in mono 78px (`counting-dynamic-scale`, `power3.out`), while a teal line draws across the chart area left→right (`svg-path-draw`) mirroring the screenshot's curve on an overlay that fades in at 0.5 opacity. At 2.6s the number lands with a single teal flash.
Scene 4 (2.7–3.9s): three tab clippings fan out below the card, each 280×200 with a 10px white border and a label strip: 資產 (`assets/assets.webp` crop of its top total card), 負債 (`assets/liabilities.webp` crop of its top card), 消費 (`assets/spending.webp` crop of 本月消費 TWD 13,385) — they slide up from y=1600 to centers (250, 1160), (540, 1180), (830, 1160) with rotations −5°, 0°, 5°, staggered 0.12s, `power3.out`; labels 44px 700 ink.
Scene 5 (4.0–4.3s): ③ stamp slams at (800, 1400), slightly overlapping the 消費 clipping.
Scene 6 (4.3–4.9s): hold.
Scene 7 (4.9–6.0s): the cover swings shut over the page from the left (rotateY −180 → 0, 0.7s `power2.inOut`, the cover's front fading in as it passes −90°), landing exactly on the handoff_out cover; a soft 4px settle shake.

## Frame 6 — 資料只留在你的 Mac

- scene: The closed passbook slides up and shrinks into a lockup; the teal-tinted engraved Sun Yat-sen rises giving a thumbs-up beside 「資料只留在你的 Mac」; download line and URL close the film on the deep field
- voiceover: ""
- onscreen: "資料只留在你的 Mac" / "OctopusBeak" / "下載 macOS Beta" / "wangwilly.github.io/OctopusBeak"
- duration: 4.5s
- transition_in: none
- status: animated
- src: compositions/frames/06-close.html
- type: cta
- persuasion: Trust + action
- beat: resolve
- blueprint: logo-assemble-lockup (Adapt)
- focal: the brand lockup
- roles: sun-phone-thumbs-up = character · app-icon = lockup mark · banknote-defs = ground
- asset_candidates: assets/sun-phone-thumbs-up.webp, assets/app-icon-180.png, assets/banknote-defs.svg
- sfx: soft whoosh, chime
- handoff_in: identical to Frame 5 handoff_out (closed cover at (80,300) 920×1240 with icon, title, 存摺, tagline).
- handoff_out: loop seam — at 4.5s the screen fades (last 0.4s) to the ground only (gradient, waves, rosette), matching Frame 1's opening state.

Scene 1 (0.0–0.8s): the cover scales down to 0.42 and moves up so its center lands at (540, 560) (`nudge-curve` slow-fast-slow); its tagline fades out during the move.
Scene 2 (0.5–1.6s): Sun Yat-sen thumbs-up (teal-tinted, 620px tall) rises from below the frame to sit bottom-right, center (720, 1260), clipped at y=1540 by a soft fade mask; a bloom of mint glow blooms behind him (`ambient-glow-bloom`).
Scene 3 (1.0–2.0s): 「資料只留在」 / 「你的 Mac」 (two lines, 100px, white→mint gradient, left x=90, baselines y=1000 and y=1120) enter with `waterfall-entry`; an inline lock SVG (64px, mint) precedes line one.
Scene 4 (2.0–2.8s): under it, 「下載 macOS Beta」 as a mint pill button (48px, ink text on `#c9efe9`, radius 999) at x=90, y=1230; 「wangwilly.github.io/OctopusBeak」 mono 34px mint at y=1340.
Scene 5 (2.8–4.1s): hold (rosette keeps turning; nothing else moves).
Scene 6 (4.1–4.5s): everything except the ground fades to 0 for the loop seam.
