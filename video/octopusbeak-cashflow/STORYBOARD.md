---
format: 1920x1080
duration: 31s
message: "收支流水：所有帳戶的收支在同一頁，帳戶之間搬錢不算收支，看清楚錢流去哪、留下多少"
arc: Hook (four accounts, no answer) → One river (inflow) → Loops that don't count (transfers) → Tributaries (outflow) → The pool (kept) → Flatten into the real flow bar → Real screen → Brand
mode: autonomous
music: calm confident minimal electronic with a warm flowing pulse, soft plucks, around 100 bpm, builds gently, clean resolved ending
---

October's money is drawn as one river in banknote line-engraving. Four account nodes sit on it.
Salary flows in; transfers between the person's own accounts loop out of the river and lift away
into a "not counted" panel; the rest splits into category tributaries; what remains pools as
留下來. The river then flattens into the page's real two-row flow bar, and the real app screen
lands exactly on top of it. Every number is the real demo ledger (see BRIEF.md → Data).

Three compositions (each built in zh-TW `compositions/frames/` and English `compositions/frames-en/`,
same code and timing, only the strings table differs):

| id | file | film start | duration |
| --- | --- | --- | --- |
| 01-hook | 01-hook.html | 0 | 4.5 |
| 02-river | 02-river.html | 4.5 | 21.5 |
| 03-close | 03-close.html | 26 | 5 |

## Video direction

- **Canvas** 1920×1080. Readable content inside x 96–1824, y 60–1020. Type ≥ 22px; headlines 56–76px.
- **Grounds** (each a full-duration `class="clip"` layer, never on `#root`):
  - *Night*: diagonal gradient `#071f4a` → `#0d4672` → `#12808f` (135deg, middle stop 52%); `#waves-teal` wave lines from `assets/banknote-defs.svg` full-bleed, pattern colour `#18a9a4`, opacity 0.4; rosette 1000px centred (960, 540), stroke `#edf4f1`, opacity 0.14.
  - *Paper*: `#f9fafc` + mint `#edf4f1` radial wash (ellipse 70% 60% at 0% 100%); `#waves-ink` (pattern colour `#0e1217`) opacity 0.04; rosette 1000px centred (1500, 760), ink `#2c6485`, opacity 0.05.
  - Rosette angle = 0.6° × film time (film starts above). Inline the needed defs from `assets/banknote-defs.svg` with a composition-unique id prefix (`f01-`, `f02-`, `f03-`).
- **App palette (sampled from the real page):** 薪資 / positive / 留下來 text `#285d3f` · 利息 `#76527c` · 居家 `#7d4a40` · 交通 `#915d2a` · 餐飲 `#266299` · 日常 `#186e57` · 購物 `#76527c` · 休閒 `#2a5e6a` · 留下來 fill `#ebf0ed` · negative amounts `#7d4a40` · transfer panel fill `#dfeef8`, ink `#2c6485`, pill `#1f4f73` with white text · ink `#0e1217` · muted `#5e646a` · hairline `#d5dae1`.
- **Engraved river.** Every band is a filled path in its colour plus a clip of 1.2px lines every 7px running along the flow (white at 22% on dark bands, `#285d3f` at 18% on the 留下來 band) — banknote line-engraving. Flow = the line texture translating along the flow direction at a constant 40 px/s (finite tween over the composition, seek-safe). Band width scale: **1px = 200 TWD** (86,912 → 435px). Transfer ribbons are drawn at half scale (1px = 400 TWD). A thin band never goes below 4px.
- **Account nodes** (shared by 01-hook end and 02-river): white discs 88px, 1px `#d5dae1` border, shadow `0 10px 24px rgba(15,23,42,.18)`, logo 56px centred. Centres: 台北富邦 7028 `fubon` (360, 640) · 台北富邦 7036 `fubon` (1000, 340) · 元大銀行 7819 `yuanta-bank` (1340, 340) · 玉山銀行 `esun` (1180, 747). A small name label under each disc, 20px 600 (ink on paper, white on night): 「富邦 7028」「富邦 7036」「元大 7819」「玉山」 / "Fubon 7028" "Fubon 7036" "Yuanta 7819" "E.SUN".
- **Headline block (02-river)**: eyebrow 24px 700 `#18a9a4` at x=120 baseline 132; headline 56px 700 ink at x=120 baseline 206 (max width 820; English may wrap to two lines at 48px, second baseline 262). Headlines change per scene with a short wipe-up (old up 20px + fade 0.25s; new from +20px 0.35s `power3.out`).
- **Counter strip (02-river)**, app hero-row style, top-right: three cells, label 22px 500 muted at baseline 112, number `"SF Mono"` 700 54px tabular at baseline 172. 流入/Inflow left x=1000 (green); 流出/Outflow left x=1290 (ink); 留下來/Kept left x=1560 (green). Operators 「−」 at x=1250 and 「=」 at x=1525, 40px muted, baseline 168. A cell shows its label at 35% opacity and number 「—」 until its scene reveals it; numbers roll as stepped odometers (discrete integer steps, ~24 steps), never tweened decimals.
- **Real flow-bar geometry (02-river end = 03-close start).** The hero screenshot `assets/app/hero-{zh,en}.png` (2172×756) is shown at x=120, y=230, width 1680 (height 584.8) on a white card x 120–1800, y 230–815, radius 16. Its bars, in frame px (radius 5): inflow bar y 601–651: 薪資 x 258–1729, 利息 x 1731–1761. Outflow bar y 669–712: 居家 258–752, 交通 754–833, 餐飲 836–895, 日常 897–947, 購物 949–979, 休閒 983–1012, 留下來 1015–1761 (fill `#ebf0ed`, 1px `#285d3f` at 40% border).
- **Type.** CJK and Latin `"PingFang TC"`; numbers `"SF Mono"` tabular-nums; `@font-face { src: local(...) }` as in `../octopusbeak-accounts/compositions/frames/04-total.html`. Night headlines white with `linear-gradient(180deg, #ffffff 15%, #c4f5ee 78%, #5fd4c9 118%)` clipped to text.
- **Motion grammar.** `power3.out` settles; `expo.out` seals and pops; `power2.inOut` camera moves and morphs; draw-on of a band = its clip rect or mask growing along the flow. No bounce/elastic, no Math.random, no infinite repeats, no CSS transitions/animations. One paused GSAP timeline per composition on `window.__timelines["<id>"]`.
- **Negative list.** No device mockups, no fake window chrome, no stock icons, no purple gradients, no emoji.
- **SFX cue points** (film time, for the mix later): 0.4/0.9/1.4/1.9 card pops · 4.6 wipe whoosh · 5.4 water swell (inflow) · 10.2, 11.4, 12.6 ribbon ticks · 11.0 seal click · 13.6 panel lift whoosh · 16.0 tributary split shimmer · 21.2 pool chime · 24.0 morph whoosh · 26.3 screen settle · 28.4 wipe · 28.8 brand chime.

## 01-hook — 四個帳戶，沒有答案 (0–4.5s)

- ground: night
- onscreen zh: 「錢流過四個帳戶，」 / 「這個月，到底流去哪了？」 · en: "Your money runs through four accounts." / "So where did October's go?"
- handoff_out: night ground; no text, no cards; only the four account discs at their node centres (scale 1, opacity 1), each with its name label in white.

Scene 1 (0.0–0.3): night ground.
Scene 2 (0.3–2.4): four account cards pop in one by one (0.5s apart, `expo.out` scale 0.85→1 + fade): white at 95%, 440×116, radius 18, logo disc 64px at left inset 24, name 26px 600 ink (「台北富邦銀行 7028」「台北富邦銀行 7036」「玉山銀行」「元大銀行 7819」 / "Taipei Fubon Bank 7028" "Taipei Fubon Bank 7036" "E.SUN Bank" "Yuanta Bank 7819"), a 22px muted second line 「10 月淨變動」 / "October net change", and the account's net change right-aligned mono 700 34px: +2,473 `#285d3f` · +30,000 `#285d3f` · −18,345 `#7d4a40` · −32,064 `#7d4a40`. Card centres: 7028 (500, 330) · 7036 (1420, 300) · 玉山 (560, 600) · 7819 (1380, 620); each card is tilted −2°/1.5°/1.5°/−2.5° and drifts 6px over its life (deterministic). Each card has a short faint teal wave stroke running off its right edge that ends in nothing — four separate streams.
Scene 3 (1.9–3.5): the headline sets centred at x=960, 64px 700 white-gradient, baselines y=880 and y=960 (English 56px), line 2 after line 1 by 0.35s; the 「?」/"?" flashes teal `#5fd4c9` once.
Scene 4 (3.5–4.5): headline lifts and fades; every card's text and frame fade out while its logo disc (64px) flies to the account's node centre and grows to 88px (`power2.inOut` 0.7s) and its name label prints under it.

## 02-river — 一條河 (4.5–26.0s; times below are composition time)

- ground: night until the paper circle wipe, then paper
- handoff_in: identical to 01-hook handoff_out.
- handoff_out: paper ground; white card x 120–1800, y 230–815, radius 16, shadow `0 20px 50px rgba(15,23,42,.10)`; on it only the two flow bars at the real-flow-bar geometry, flat colours (no engraving texture), with the in-bar labels the real screen shows (「薪資 86,500」 white 20px 700 inside 薪資 at x 274; 「居家 29,381」 white inside 居家; 「留下來 43,168 · 50%」 green `#285d3f` 20px 700 centred in 留下來 / "Salary 86,500" "Home 29,381" "Kept 43,168 · 50%"). No nodes, no counters, no headline, no panel.

Scene 1 — paper (0.0–0.9): paper ground circle-wipes out from node 富邦 7028 (clip-path circle 0 → 2300px, `power2.inOut`); node labels turn white → ink; the counter strip fades in with all three cells dimmed.
Scene 2 — inflow (0.7–5.0): eyebrow 「新功能 · 收支流水」 / "New · Cash flow"; headline 「所有帳戶的錢，匯成一條河。」 / "Every account's money, one river.". The 薪資 band (432px, `#285d3f`, engraved) draws on from the left edge into node 7028 and on to the right edge as the trunk (centre y 640, 1.8s); 「薪資 86,500」 / "Salary 86,500" white 24px 700 inside the band near x 140; a 4px 利息 `#76527c` strand curls in from the bottom-left and joins at x 330 with a tiny label 「利息 412」 / "Interest 412" 20px. The 流入 cell un-dims and rolls 0 → 86,912; under it 「2 筆 · 薪資佔 99.5%」 / "2 items · Salary 99.5%" 18px muted. Nodes 7036, 7819 and 玉山 pulse once as the water reaches their x.
Scene 3 — transfers (5.0–10.5): headline 「帳戶之間搬錢，不算收支。」 / "Moving money between your own accounts isn't inflow or outflow.". Three ribbons (half scale, `#2c6485` at 85%, engraved) rise out of the trunk one by one (1.2s apart): (a) 30,000 → 75px from node 7028 arcing over to node 7036; when its head reaches 7036 a seal pops on the arc (pill `#1f4f73`, white 18px 700 「內部轉帳 · 已配對」 / "Internal transfer · paired", `expo.out`); (b) 32,064 → 80px from node 7819 looping out to a small coin disc 「USD 1,000.00」 at (1620, 420) with pill 「換匯」 / "Currency exchange"; (c) 24,040 → 60px, two dashed-edge strands from node 7028 that rise and fade out at the top edge, pill 「未配對 2 筆」 / "Unpaired · 2". As each ribbon appears its amount floats into the 流出 cell as grey text stacked under the dimmed label (「+30,000」 「+32,064」 「+24,040」); then (8.2–8.7) all three are struck through with a single rule and drop out. (8.6–10.3) the three ribbons desaturate to `#dfeef8`, detach and fly up-right, condensing into the app's transfer panel at x 1440–1800, y 228–388 (fill `#dfeef8`, radius 12): head 「⇆ 帳戶間搬錢 · 不計入收支」 / "Between your accounts · not counted" 18px 700 ink `#2c6485`; rows 18px: 「內部轉帳 1 組 · TWD 30,000」 / "Internal transfer · 1 · TWD 30,000", 「換匯 1 組 · TWD 32,064」 / "Currency exchange · 1 · TWD 32,064", 「未配對 2 筆 · TWD 24,040」 / "Unpaired · 2 · TWD 24,040" (amounts mono 700). The coin disc leaves with them. The trunk is untouched.
Scene 4 — outflow (10.5–15.5): headline 「錢的去向，一眼看清。」 / "Where the money went, at a glance.". From x 1060 the bottom 219px of the trunk (y 637–856, 流出 43,744) peels off and fans into six tributaries that curve down-right and end at x 1800: 居家 147px `#7d4a40`, 交通 24px `#915d2a`, 餐飲 17px `#266299`, 日常 14px `#186e57`, 購物 9px `#76527c`, 休閒 8px `#2a5e6a`, ends stacked from y 690 down with 18px gaps (居家 ends y 690–837, then each next band below). Labels: 「居家 29,381」 white 22px 700 inside the 居家 band near its end; the others to the right-aligned at x 1790 just above their band end, 20px 700 in the band colour (zh 交通 4,736 · 餐飲 3,458 · 日常 2,889 · 購物 1,780 · 休閒 1,500; en Transport · Dining · Daily · Shopping · Leisure), no overlaps (use small leader ticks if needed). The 玉山 node rides the outflow half. Tributaries draw on staggered 0.15s, 居家 first. The 流出 cell un-dims and rolls to 43,744 (ink) with 「22 筆 · 居家佔 67%」 / "22 items · Home 67%".
Scene 5 — kept (15.5–19.5): headline 「10 月，每收進 100 元，留下了 50 元。」 / "In October, of every 100 that came in, 50 stayed." with the 50 in `#285d3f`. The top 216px of the trunk past x 1060 turns into the 留下來 band (fill `#ebf0ed`, 2px `#285d3f` edge, green engraving) and widens into a rounded pool at its end (x 1500–1800, y 400–660, radius 40) whose waterline rises; 「留下來 43,168 · 50%」 / "Kept 43,168 · 50%" 24px 700 `#285d3f` centred in the pool. The 留下來 cell un-dims and rolls to 43,168 with 「流入的 50%，比上期多 30 個百分點」 / "50% of inflow, up 30 points on the previous period"; the 「−」 and 「=」 operators pop in.
Scene 6 — flatten (19.5–21.5): everything except the bands fades out (nodes, labels, headline, counters, panel: 0.4s). The white card scales up from the river's bounds. The river morphs into the two real flow bars (`power2.inOut`, 1.2s): the inflow trunk compresses into the inflow bar (薪資 + 利息 segments); the six tributaries and the 留下來 band straighten into the outflow bar's segments in order; the engraving texture fades to flat colour; in-bar labels appear as in handoff_out. Hold 0.3s.

## 03-close — 真實畫面與品牌 (26.0–31.0s)

- handoff_in: identical to 02-river handoff_out.
- handoff_out: end of film — night ground with the brand lockup held.

Scene 1 (0.0–0.5): the real screenshot `assets/app/hero-zh.png` (en: `hero-en.png`) fades in over the card at x=120, y=230, width 1680, so its bars land exactly on the drawn ones; the drawn bars fade out underneath.
Scene 2 (0.5–2.3): slow push-in on the card (scale 1 → 1.035 around (960, 520), `power2.inOut`); a caption under the card 「收支流水 · 實際畫面」 / "Cash flow · the real screen" 24px 600 muted at x=120 baseline 880; a soft teal underline sweeps under the screenshot's headline (「這段期間，每收進 100 元，留下了 50 元」), drawn as a 4px `#18a9a4` bar from x 156 to x 1043 at y 318 (after the push-in transform, attach it to the card so it moves with it).
Scene 3 (2.3–2.9): the night ground returns as a circle wipe from (960, 540), 0 → 2300px.
Scene 4 (2.7–5.0): brand lockup centred: app icon 150px (radius 34) at (960, 370); 「OctopusBeak」 96px 700 white-gradient baseline y=555; 「收支流水 · v0.11」 / "Cash flow · v0.11" 36px 600 mint `#c4f5ee` baseline y=625; 「資料只留在你的 Mac。」 / "Your data stays on your Mac." 30px 500 white at 75% baseline y=690. Rise 24px + fade, stagger 0.12s, `power3.out`. Hold to the end.
