---
format: 1920x1080
duration: 30s
message: "每一筆帳都能自動合併，也點得回出處"
arc: Hook → Value → Match → Merge → Roll-up → Brand
audience: Taiwanese Mac users with accounts across several banks and cards
mode: autonomous
music: calm confident minimal tech underscore, soft piano and warm pads with a light pulse, building gently, clean ending
---

One continuous take. The thread is a single charge — 全聯福利中心, TWD 1,444 — that
the camera never lets go of: two copies of it (e-invoice + card statement) are found,
matched, sealed into one, and rolled up into the month and then the whole picture.
Silent, looping in a ~400px website tile: every on-screen line is display-size, and
the last frame returns to the first frame's deep-blue field so the loop seam is soft.

## Video direction

- **Viewing size drives everything.** The video plays muted and looped in a tile about 400px wide (≈ 0.21× of 1920). Anything that must be read is ≥ 64px on the 1920 canvas (headlines 112–150px, amounts 72–96px, chips/labels 44–52px). Small app UI detail is texture, never the message. No captions.
- **Two worlds, one film.** (1) *Banknote field* — deep-blue `bg-night #071f4a` ground with the site's engraving language from `assets/banknote-defs.svg`: guilloche `#rosette` (stroke = mint at 18–35% opacity), `#waves-teal` wave lines, `#microline` rules. Headline type on it is white `#ffffff` with the teal→mint display gradient feel of the site hero (`#5fd4c9` → `#c4f5ee` → `#ffffff`). (2) *Paper* — `bg-primary #f9fafc` with `bg-secondary #edf4f1` mint wash and `#waves-ink` wave lines at very low opacity; text `text-primary #0e1217`, muted `#5e646a`, accent `#2c6485`.
- **App UI reconstructions follow the app's own tokens, not cartesian's zero-shadow rule**: white cards `#ffffff`, 1px border `#dbdee2`, radius 20–24px (scaled up for the canvas), soft shadow `0 18px 40px rgba(15,23,42,.12)`; amounts in `"SF Mono", ui-monospace, Menlo, monospace` with tabular numerals, weight 700; CJK in `"PingFang TC", "Noto Sans TC", sans-serif`; primary button black `#0e1217` with white text; match chips light gray `#f1f4f6` with a ✓; `高度相符` pill green text `#2f7a55` on `#e5f2ea`; `已合併` / merge accent teal `#18a9a4`. Cartesian atoms (hairline, compass ring) frame the type, they don't restyle the app.
- **Fixed geometry shared by frames 2–5 (the "card world").** Merge card: 1560×640, centered at (960, 560), radius 28. Inside it: merchant column left (x 260–640): 全聯福利中心 (56px, 600), 日常 · 10/3 (36px muted), `高度相符` pill. A vertical hairline at x=680. Two source rows on the right, each 1000×120 at x 720–1720: **invoice row** centered y=470 — receipt icon, 「電子發票 AB-38201745」 (44px) over 「10/3 18:21 · 全聯實業」 (30px muted), amount 「TWD 1,444」 (60px mono) right-aligned at x=1640; **card row** centered y=610 — card icon, 「玉山信用卡 末碼 5512」 over 「10/3 消費 · 10/4 入帳」, 「TWD 1,444」 right-aligned. Chips row centered y=745, spanning x 720–1420: 「✓ 金額相同」「✓ 同一天」「✓ 商家相符」 (44px). Black 「合併」 button 240×92 centered at (1600, 800), bottom-right of the card. The camera stays fixed in frames 2–4 except the bounded zoom in Frame 3, so these canvas coordinates are the handoff truth.
- **Motion grammar.** Long-tail `power3.out` settles; `expo.out` only on fast arrivals; no bounce/elastic/back. One virtual camera: each frame animates a `.world` wrapper (scale/translate) for camera moves — never independent drifting elements. Reveal each piece on its on-screen cue, spread across the shot; hold reads still (subtle jitter at most). Seams between frames 1→2→3→4→5 are continuous (matching handoffs below); 5→6 is the one soft break (blur-crossfade); 6's last 0.6s returns to frame 1's opening field for the loop.
- **Rhythm.** Frame 1 tense and quick; frame 2 the turn; frame 3 methodical (three checks, evenly spaced); frame 4 the climax — the seal stamp is the single heaviest hit, held ~1.2s; frame 5 an expansive decelerating pull-back; frame 6 a calm held breather.
- **Negative list.** No bokeh, no purple/blue "AI" gradients, no generic stock icons standing in for the app, no fake browser chrome, no lazy breathing, no slow back-half pans, no `Math.random`, no infinite/yoyo tweens, no CSS transitions/keyframes. Never front-load a frame then freeze; never let many elements float independently.

## Frame 1 — 記了兩次

- scene: On a deep-blue engraved field, two ledger slips for the same TWD 1,444 drop in side by side under the line 「同一筆消費，記了兩次？」
- voiceover: ""
- onscreen: "同一筆消費，" / "記了兩次？"
- duration: 4.5s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- type: hook
- persuasion: Pain validation
- beat: tension
- blueprint: compose
- focal: assets/banknote-defs.svg
- roles: banknote-defs = background (rosette + waves on deep blue) · spending-b-merge-modal = content reference only (slip text), not placed as an image
- asset_candidates: assets/spending-b-merge-modal.png — reference for the two slips' content (電子發票 AB-38201745 · 玉山信用卡 末碼 5512, both TWD 1,444); assets/banknote-defs.svg — rosette, wave and microline engraving defs
- handoff_in: loop seam — at t=0 the field is deep blue #071f4a with the #rosette centered at (960, 540), 900px, stroke mint #edf4f1 at opacity 0.3, rotation 0°, nothing else visible.
- handoff_out: invoice slip center (600, 720), 640×200, scale 1, opacity 1, rotation −2°, at rest; card slip center (1320, 720), 640×200, scale 1, opacity 1, rotation 2°, at rest; headline lines 「同一筆消費，」 and 「記了兩次？」 left-aligned at x=200, baselines y=300 and y=440, 130px, white; ground deep blue with rosette now at (1500, 420), 900px, opacity 0.22.

Compose (shape borrowed from the blueprint menu, built from the motion vocabulary): keep kinetic-type-beats' statement build landing on a payoff word; the "payoff" is the second slip mirroring the first.
Scene 1 (0.0–0.8s): only the loop-seam field — rosette centered, wave lines faint. The rosette glides up-right to (1500, 420) and dims while the #waves-teal field fades in at low opacity. Full-bleed background layer.
Scene 2 (0.8–1.8s): 「同一筆消費，」 enters via per-word staggered reveal (`dynamic-content-sequencing`), left-aligned upper third, 130px white with the hero teal→mint gradient.
Scene 3 (1.8–2.8s): slip one — an ivory paper slip (white card, mono amount) with receipt icon, 「電子發票」 (48px), 「TWD 1,444」 (84px mono) — drops in from above to (600, 720) with a fast `expo.out` arrival and a short directional motion-blur streak; a #microline rule draws under its amount (`svg-path-draw`).
Scene 4 (2.8–3.7s): slip two — card icon, 「玉山信用卡 5512」, 「TWD 1,444」 — drops to (1320, 720) mirroring slip one; as it lands, both amounts flash teal once.
Scene 5 (3.7–4.5s): 「記了兩次？」 lands as the payoff line beneath the first (hard word arrival, a single percussive hit); hold still with subtle jitter on the two slips only.

## Frame 2 — 只算一次

- scene: 「兩次」 is struck through by an engraved microline and replaced by 「一次」; the deep-blue field washes to paper as wave lines sweep across, and the two slips glide into a stacked pair at the card-world row positions
- voiceover: ""
- onscreen: "OctopusBeak 找出同一筆消費，" / "只算一次。"
- duration: 4s
- transition_in: none
- status: animated
- src: compositions/frames/02-value.html
- type: product_intro
- persuasion: Negative contrast
- beat: curiosity → relief
- blueprint: compose
- focal: the headline swap 「兩次」→「一次」
- roles: site-icon = supporting (beside the OctopusBeak name) · banknote-defs = background (microline strike, waves)
- asset_candidates: assets/site-icon.webp — OctopusBeak icon beside the name; assets/banknote-defs.svg — microline strike and wave-line wash
- handoff_in: identical to Frame 1 handoff_out (slips at (600,720) rot −2° and (1320,720) rot 2°, 640×200; headline at x=200, baselines 300/440, 130px white; deep-blue ground, rosette (1500,420) 900px opacity 0.22).
- handoff_out: paper ground #f9fafc with #waves-ink at opacity 0.08 and a mint #edf4f1 radial wash bottom-right; the two slips have become the two card-world source rows — invoice row centered (1220, 470) 1000×120, card row centered (1220, 610) 1000×120, rotation 0, white, border #dbdee2, shadow soft, amounts 「TWD 1,444」 60px mono right-aligned at x=1640; headline gone; no card frame yet.

Compose (shape borrowed from the blueprint menu, built from the motion vocabulary): keep the in-place token swap as the signature (「兩次」 → 「一次」), then let the statement give way to the product surface.
Scene 1 (0.0–1.0s): a #microline rule draws through 「兩次」 left→right (`svg-path-draw`); 「兩次」 drops out and 「一次。」 flips in at the same slot in teal (`discrete-text-sequence` hard swap) — the line now reads 「記了一次。」 for a beat.
Scene 2 (1.0–2.2s): the ground washes from deep blue to paper: a band of #waves-teal lines sweeps left→right as the wipe edge (velocity-matched, `cut-catalog.md` cut-the-curve), revealing paper behind; type recolors to ink #0e1217. The headline re-sets as 「OctopusBeak 找出同一筆消費，」 / 「只算一次。」 with the app icon (72px) before "OctopusBeak" — per-word staggered reveal on the new line one, upper-left.
Scene 3 (2.2–3.4s): the two slips straighten and glide into a stacked pair — invoice to (1220, 470), card to (1220, 610) — while morphing from slip shape (640×200) to row shape (1000×120) (`card-morph-anchor`, uniform scale + crossfade of inner layout), `power3.out`.
Scene 4 (3.4–4.0s): the headline lifts and fades up out of frame (cleared for frame 3); rows hold still at their handoff positions.

## Frame 3 — 自動配對

- scene: The rows dock into a rebuilt 帳目合併 card for 全聯福利中心; a microline connector draws between the two TWD 1,444 amounts while 金額相同 ✓ · 同一天 ✓ · 商家相符 ✓ check off one by one and 高度相符 springs in
- voiceover: ""
- onscreen: "金額相同 · 同一天 · 商家相符"
- duration: 6.5s
- transition_in: none
- status: animated
- src: compositions/frames/03-match.html
- type: feature_showcase
- persuasion: Show-don't-tell proof
- beat: clarity
- blueprint: agent-progress-theater (Adapt)
- focal: the rebuilt merge card (card-world geometry)
- roles: spending-b-merge-modal = content/style reference for the rebuilt card · spending-c-detail-pending = background plate, heavily blurred and dimmed behind the card (≈ 35% opacity, blur 24px) for app context
- asset_candidates: assets/spending-b-merge-modal.png — 帳目合併 modal, first pair is the hero; assets/spending-c-detail-pending.png — 消費明細 with matched invoice line items
- handoff_in: identical to Frame 2 handoff_out (paper ground; invoice row (1220,470), card row (1220,610), 1000×120, no card frame).
- handoff_out: complete card-world merge card at (960, 560), 1560×640, scale 1: merchant column (全聯福利中心 / 日常 · 10/3 / 高度相符 pill), hairline at x=680, invoice row y=470, card row y=610, three checked chips at y=745, black 「合併」 button 240×92 centered at (1600, 800); a teal connector line joins the two amounts (x=1600, y 495→585); camera (world) scale 1 at rest; title strip 「帳目合併」 above the card at y=185 (60px) with sub 「同一筆消費的發票與刷卡，只算一次。」 (34px muted).

Adapt: keep the agent-progress-theater receipt that CHECKS OFF row by row; the "work" is the match evidence, no loader.
Scene 1 (0.0–1.2s): the card frame draws around the rows — the 1px border traces on (`svg-path-draw`), white fill fades up behind, the merchant column slides in from the left (全聯福利中心 56px, 日常 · 10/3), hairline divider draws down. Title strip 「帳目合併」 + sub fades up above. Blurred app plate fades in behind (background layer). Centered, ~70% of frame, 3 depth layers.
Scene 2 (1.2–2.2s): camera (world) eases in to 1.25× toward the amounts column (`coordinate-target-zoom`) so the two 「TWD 1,444」 read big; a teal connector draws from the invoice amount down to the card amount (`svg-path-draw`), a small teal 「=」 node pops at its middle (`spring-pop-entrance`, smooth settle).
Scene 3 (2.2–4.6s): the three chips check off one by one, evenly spaced (~0.75s apart): each chip slides up, its ✓ draws (`svg-path-draw`) and the chip tints from gray to light teal. Camera slides along the chip row as they land (same world wrapper, one smooth lateral move, no back-half re-push).
Scene 4 (4.6–5.6s): camera eases back to 1× (whole card); 「高度相符」 pill springs in under the merchant name (`spring-pop-entrance`, smooth); the 「合併」 button fades up bottom-right.
Scene 5 (5.6–6.5s): hold still on the complete card — subtle jitter only.

## Frame 4 — 合併印記

- scene: A cursor presses 合併; the two rows fold into one; a guilloche rosette seal stamps 「已合併」 over the card; the row reads 本月計為 1 筆 · TWD 1,444
- voiceover: ""
- onscreen: "已合併" / "本月計為 1 筆"
- duration: 5s
- transition_in: none
- status: animated
- src: compositions/frames/04-merge.html
- type: feature_showcase
- persuasion: Friction reduction
- beat: relief + control
- blueprint: cta-morph-press (Adapt)
- focal: the rosette seal stamping 「已合併」
- roles: spending-d-detail-merged = content/style reference for the merged state · banknote-defs = the seal (#rosette) and microline ring text
- asset_candidates: assets/spending-d-detail-merged.png — merged-state anatomy (已合併 badge, 本月計為 1 筆); assets/banknote-defs.svg — rosette seal
- handoff_in: identical to Frame 3 handoff_out (complete merge card at (960,560) 1560×640, title strip at y=185, chips checked, 合併 button at (1600,800), connector drawn, camera 1×).
- handoff_out: merge card at (960, 560) 1560×640, scale 1, now merged: a single merged row centered y=520 reading 「全聯福利中心」 with two small source tags 「電子發票」「玉山信用卡 5512」 and amount 「TWD 1,444」 (72px mono); beneath it, at y=650, 「本月計為 1 筆」 (48px, teal #18a9a4) with an 「已合併」 badge; chips and button gone; the rosette seal (300px, teal stroke, opacity 0.9) sits at (520, 560) over the merchant column with 「已合併」 in its center (48px); title strip still at y=185.

Adapt: keep cta-morph-press's human-aimed click with tactile feedback, then the morph — here the morph is two rows condensing into one.
Scene 1 (0.0–1.0s): a dark arrow cursor glides in from bottom-right to the 「合併」 button and presses it (`cursor-click-ripple` + `press-release-spring` — compress, smooth recovery, teal ripple).
Scene 2 (1.0–2.2s): the two rows fold together — the card row slides up under the invoice row, both compress into one merged row at y=520 (`scale-swap-transition`), the connector line retracts into the amount, the two 「TWD 1,444」 overlap into one; chips and button fade down and out.
Scene 3 (2.2–3.4s): THE HIT — the guilloche rosette seal stamps down onto the merchant column: it starts 2× size, rotated −25°, opacity 0, and lands at 300px, 0°, opacity 0.9 with a fast `expo.out` arrival; on contact the card shakes a few px (subtle, damped) and a teal ink ring expands from the seal (`cursor-click-ripple` ripple recipe). 「已合併」 sets in the seal's center.
Scene 4 (3.4–5.0s): 「本月計為 1 筆」 types in under the merged row (`discrete-text-sequence`), the 「已合併」 badge pops beside it (smooth settle); hold still — the seal's inner rings turn a few degrees only (finite tween, no loop).

## Frame 5 — 點得回出處

- scene: The merged row shrinks into the October spending list; a decelerating zoom-out reveals 本月消費 counting up to TWD 13,385, then keeps pulling back to the overview's 淨資產 TWD 2,148,216 while a teal thread traces back to the row it came from
- voiceover: ""
- onscreen: "每個數字，" / "都點得回出處。"
- duration: 6s
- transition_in: none
- status: animated
- src: compositions/frames/05-rollup.html
- type: benefit_highlight
- persuasion: Feature-to-benefit translation
- beat: confidence
- blueprint: zoom-out-workspace-reveal (Adapt)
- focal: assets/spending-a-default.png
- roles: spending-a-default = the containing whole for the first pull-back (real spending page plate; the 全聯福利中心 row is the target) · overview = the final, widest plate · the merged card = foreground that shrinks into the list
- asset_candidates: assets/spending-a-default.png — October spending page (TWD 13,385, list with 全聯福利中心); assets/overview.webp — overview with 淨資產 TWD 2,148,216
- handoff_in: identical to Frame 4 handoff_out (merged card at (960,560) 1560×640 with seal at (520,560), 本月計為 1 筆, title strip at y=185).
- handoff_out: none (clean blur-crossfade into Frame 6). Final state: paper ground; the overview plate framed as a floating window (radius 24, soft shadow) at ~78% width, centered slightly low; headline 「每個數字，」 / 「都點得回出處。」 upper-left on the paper margin at 112px ink, the second line accent #2c6485.

Adapt: keep the ONE continuous decelerating zoom-out as the engine; extend it to two nesting levels (spending page → overview).
Scene 1 (0.0–1.4s): the title strip and seal fade; the merged card shrinks and flattens into a list row (`card-morph-anchor`) while the world pulls back to reveal it sitting inside the spending page plate (spending-a-default.png) — exactly over the plate's 全聯福利中心 row, which is highlighted teal. Decelerating pull-back, `power3.out`.
Scene 2 (1.4–3.0s): the camera continues the same pull-back up the page to the 本月消費 header; a mono counter overlay 「TWD 11,941 → 13,385」 counts up over the plate's total (`counting-dynamic-scale`, value-scaled), and a thin teal thread draws from the highlighted row up to the total (`svg-path-draw`).
Scene 3 (3.0–4.6s): still the same continuous pull-back: the spending plate shrinks into a window that slides into the overview plate's spending slot, and the overview (overview.webp) resolves as a floating window; the teal thread extends from the spending total to the overview's 淨資產 figure (TWD 2,148,216) which glows once.
Scene 4 (4.6–6.0s): camera locks; 「每個數字，」 / 「都點得回出處。」 per-word staggered reveal upper-left; hold still.

## Frame 6 — OctopusBeak

- scene: Back on deep blue, the rosette turns slowly behind the octopus icon and the OctopusBeak wordmark; the engraved Sun Yat-sen gives a thumbs-up; 「下載 macOS Beta」 settles beneath
- voiceover: ""
- onscreen: "OctopusBeak" / "下載 macOS Beta · 適用 Apple silicon"
- duration: 4s
- transition_in: blur-crossfade
- status: animated
- src: compositions/frames/06-brand.html
- type: branding
- persuasion: Authority by association
- beat: trust
- blueprint: compose
- focal: assets/site-icon.webp
- roles: site-icon = cutout (the mark) · sun-phone-thumbs-up = supporting (engraving tinted via #ink-hero, right third, bleeding off the bottom) · banknote-defs = background (rosette + waves)
- asset_candidates: assets/site-icon.webp — OctopusBeak app icon; assets/sun-phone-thumbs-up.webp — engraved Sun Yat-sen giving a thumbs-up; assets/banknote-defs.svg — rosette and wave lines
- handoff_in: none (blur-crossfade from Frame 5).
- handoff_out: loop seam — over the last 0.6s everything except the field fades out, leaving deep blue #071f4a with the #rosette centered at (960, 540), 900px, stroke mint at opacity 0.3, rotation 0° — identical to Frame 1's t=0.

Compose (shape borrowed from the blueprint menu, built from the motion vocabulary): keep the lockup resolving from an outline that draws on; the "parts" are the rosette rings.
Scene 1 (0.0–1.0s): deep-blue field with #waves-teal; the #rosette draws on from the center outward (`svg-path-draw`, rings in sequence) behind center-left.
Scene 2 (1.0–2.0s): the app icon (160px) blooms in at the rosette's center (`spring-pop-entrance`, smooth) and the wordmark 「OctopusBeak」 (140px, white, 700) builds letter-chunk by chunk to its right (`dynamic-content-sequencing`); the engraved Sun Yat-sen (thumbs-up, tinted by #ink-hero) rises into the right third.
Scene 3 (2.0–3.4s): 「下載 macOS Beta · 適用 Apple silicon」 (52px, mint) sets under the wordmark on a #microline rule that draws beneath it; hold still — the rosette turns a few degrees only (finite).
Scene 4 (3.4–4.0s): loop exit — icon, wordmark, line, and Sun fade out; the rosette slides to center (960, 540) at 900px and opacity 0.3, rotation back to 0°, matching Frame 1's opening field.
