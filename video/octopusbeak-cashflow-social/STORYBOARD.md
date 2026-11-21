---
format: 1080x1920
duration: 31s
message: "收支流水：所有帳戶的收支在同一頁，帳戶之間搬錢不算收支，看清楚錢流去哪、留下多少"
arc: same as the 16:9 film — Hook → One river → Loops that don't count → Tributaries → The pool → Flatten into the real flow bar → Real screen → Brand
mode: autonomous
music: shared with the 16:9 film (identical timing; the audio cues in index.html are the same)
---

The vertical social cut of `../octopusbeak-cashflow` (read its `STORYBOARD.md` and `BRIEF.md` first:
the concept, the real numbers, the palette, the engraving, the motion grammar, every string in zh and
en, and every scene's content carry over unchanged). **Scene timings are identical to the 16:9 film**
(so the shared music and SFX land on the same beats). Only the layout changes: the river flows from top
to bottom and everything is re-composed for 1080×1920. Treat the finished 16:9 compositions
(`../octopusbeak-cashflow/compositions/frames{,-en}/*.html` and their generators under
`../octopusbeak-cashflow/.hyperframes/work-*/`) as the reference implementation to adapt — reuse their code
and look; do not reinvent them.

| id | file | film start | duration |
| --- | --- | --- | --- |
| 01-hook | 01-hook.html | 0 | 4.5 |
| 02-river | 02-river.html | 4.5 | 21.5 |
| 03-close | 03-close.html | 26 | 5 |

## Vertical direction

- **Canvas** 1080×1920. Social UI covers the top ~180px and bottom ~360px: keep all readable content inside **y 200–1560**, x 64–1016. Type ≥ 24px; headlines 60–72px.
- **Grounds** as in 16:9; rosette centred (540, 960) on night, (700, 1300) on paper; same 0.6°/s film-time angle.
- **River scale** unchanged: 1px = 200 TWD (trunk 435px wide); transfer ribbons at half scale.
- **Headline block (02-river)**: eyebrow 26px 700 `#18a9a4` at x=80 baseline 252; headline 60px 700 ink at x=80 baseline 330, max width 920, a second line at baseline 404 when needed (English 52px).
- **Counter strip (02-river)**: label 24px muted baseline 486; number `"SF Mono"` 700 50px baseline 546; sub-line 20px muted baseline 580. Cells left x: 流入 80 · 流出 410 · 留下來 740; operators 「−」 x 372, 「=」 x 702.
- **Transfer panel** (condenses in scene 3, stays until the flatten): x 80–1000, y 606–736, radius 14, `#dfeef8`; head line + three rows laid out in two columns as fits.
- **River layout.** 薪資 enters from the left edge at y 790–1225 and bends down into a vertical trunk centred x 540 (x 322.5–757.5) that runs to y 1560. 利息 strand joins from the left. **Nodes**: 富邦 7028 (540, 830) on the trunk head; 富邦 7036 (950, 900) and 元大 7819 (950, 1090) in the right margin; 玉山 (648, 1250) on the outflow half. Node labels as in 16:9.
- **Transfers**: ribbon (a) arcs from 7028 out to 7036; (b) loops from 7819 to the USD coin at (950, 1250); (c) the unpaired strands rise to the left edge and fade. Ghost amounts stack under the 流出 cell, strike, drop. Ribbons condense into the panel (y 606–736).
- **Outflow** (scene 4): from y 1150 the trunk's right 219px (x 538.5–757.5) peels off and fans down-right into six tributaries ending at y 1560, spread across x 560–1040 (居家 widest at left); labels as chips at their ends, no overlaps.
- **Kept** (scene 5): the left 216px (x 322.5–538.5) continues down into a rounded pool x 80–540, y 1340–1560, label 「留下來 43,168 · 50%」 inside.
- **Flatten target (02-river end = 03-close start).** The real hero screenshot `assets/app/hero-{zh,en}.png` (2172×756) is placed at x=40, y=620, width 1000 (scale s = 1000/2172), on a white card x 40–1040, y 620–968 (zh card bottom = 620 + 732·s; en card bottom = 620 + 756·s — measure as the 16:9 03-close worker did), radius 12. Bars: x = 40 + X·s, y = 620 + Y·s with the screenshot runs: 薪資 [178,2080), 利息 [2083,2122), 居家 [178,815), 交通 [819,922), 餐飲 [926,1002), 日常 [1005,1069), 購物 [1072,1111), 休閒 [1115,1153), 留下來 [1156,2122); rows zh [480,544) / [563,627), en [509,573) / [592,656). In-bar labels scaled to fit (≈ 12–13px at this size) or omitted if unreadable — both sides of the cut must agree.

## 01-hook (0–4.5s)
Same beats and strings as 16:9. Cards (440×116; English 500 wide) in a zig-zag column: centres 7028 (360, 470) · 7036 (720, 690) · 玉山 (360, 910) · 7819 (720, 1130); headline centred x=540, 64px (English 54px, may wrap to 3 lines), baselines y 1330 and 1410 (+1490). Handoff_out: the four discs at the vertical node centres with labels.

## 02-river (4.5–26.0s)
Same scenes, timings and strings as 16:9 (use the 16:9 river's final internal timings), laid out per the vertical direction. The headline wrap points may differ; keep two lines max in zh, three in en.

## 03-close (26.0–31.0s)
- Scene 1 (0–0.5): real hero screenshot fades in on the drawn bars (no shift).
- Scene 2 (0.5–2.3): the real 帳戶淨變動 card `assets/app/accounts-{zh,en}.png` (692×548) rises 40px and fades in, centred x 540, top y 1000 (ends y 1548); the hero card stays; caption 「收支流水 · 實際畫面」 / "Cash flow · the real screen" 26px 600 muted centred, baseline 580; gentle push-in 1 → 1.03 around (540, 1090).
- Scene 3 (2.3–2.9): night circle wipe from (540, 960).
- Scene 4 (2.7–5.0): brand lockup centred: icon 160px at (540, 720); 「OctopusBeak」 92px baseline 910; 「收支流水 · v0.11」 / "Cash flow · v0.11" 38px mint baseline 985; 「資料只留在你的 Mac。」 / "Your data stays on your Mac." 32px white 75% baseline 1050. Hold.
