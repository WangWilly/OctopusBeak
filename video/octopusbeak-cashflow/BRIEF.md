---
workflow: product-launch-video
flow: automation
storyboard: no
message: "收支流水：所有帳戶的收支在同一頁，帳戶之間搬錢不算收支，看清楚錢流去哪、留下多少"
destination: website, release notes, YouTube (16:9); social cut in video/octopusbeak-cashflow-social (9:16)
aspect: 1920x1080
language: zh-TW and en (compositions/frames, compositions/frames-en)
audience: Taiwanese Mac users whose money moves through several bank and card accounts
length: 31s
angle: 錢的河流 — the month's money as one river through every account
narration: no
---

## Intent

User request (verbatim): 「重點是在「收支流水」提供的介面，在統一的頁面幫助使用者觀察所有帳戶的收支變化。已經登入 hyperframes。另外需要英文版與直式社群版。發揮你的創意力，可以討論方向。」

Chosen direction (user picked A from three pitches): **「錢的河流」**. Accounts are nodes on one
river of realistic flowing water (a WebGL flowmap shader); salary flows in, transfers between the person's own
accounts loop out and lift away as not counted, outflow splits into category tributaries, and
what remains pools as 留下來. The river then flattens into the page's real two-row flow bar and
the real app screen takes over. Sound: music bed + SFX, no narration (user choice).

## Data (real, from the demo ledger)

Captured from the running app on `scripts/seed-app-demo.ts` data, 收支流水, range 10/01–10/31
(`capture/cashflow-{zh,en}.txt`, `capture/*.png`):

- 流入 86,912 = 薪資 86,500 + 利息 412 (2 筆 · 薪資佔 99.5%)
- 流出 43,744 (22 筆 · 居家佔 67%) = 居家 29,381 · 交通 4,736 · 餐飲 3,458 · 日常 2,889 · 購物 1,780 · 休閒 1,500
- 留下來 43,168 · 流入的 50% · 比上期多 30 個百分點 → 「每收進 100 元，留下了 50 元」
- 帳戶間搬錢 · 不計入收支: 內部轉帳 1 組 TWD 30,000 (台北富邦 7028 → 7036, 元大證券交割, 已確認) · 換匯 1 組 TWD 32,064 (元大銀行 7819 → USD 1,000.00) · 未配對 2 筆 TWD 24,040
- 帳戶淨變動: 台北富邦銀行 7036 +30,000 · 台北富邦銀行 7028 +2,473 · 玉山銀行 −18,345 · 元大銀行 7819 −32,064
- Counting every transfer side as outflow would read 129,848 (43,744 + 30,000 + 32,064 + 24,040).

## Assets

- assets/app/hero-{zh,en}.png — the page's top card (headline, 流入−流出=留下來, transfer panel, flow bar), 2172×756.
- assets/app/accounts-{zh,en}.png — the 帳戶淨變動 card, 692×548.
- assets/logos/{fubon,esun,yuanta-bank,yuanta-securities}.webp, assets/app-icon-180.png, assets/banknote-defs.svg.
