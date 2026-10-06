# English version — string table

The English cut reuses every frame's timing, geometry, motion and handoffs. Only visible
text changes. English UI terms come from the app's own English locale
(`src/lib/i18n/i18n.ts`, `en`), so the video says what the product says.

| Frame | 繁中 | English |
|---|---|---|
| 01, 02 | 同一筆消費， | One purchase, |
| 01, 02 | 記了兩次？ | counted twice? |
| 02 | strike 「兩次」 → swap in 「一次。」 | strike 「twice?」 → swap in 「once.」 (line reads "counted once.") |
| 02 | OctopusBeak 找出同一筆消費， / 只算一次。 | [icon] OctopusBeak finds the duplicate. / Counted once. |
| 01, 02 slips | 電子發票 | E-invoice |
| 01, 02 slips | 玉山信用卡 5512 | E.SUN card 5512 |
| 02–04 rows | 電子發票 AB-38201745 | E-invoice AB-38201745 |
| 02–04 rows | 10/3 18:21 · 全聯實業 | 10/3 18:21 · PX Mart Co. |
| 02–04 rows | 玉山信用卡 末碼 5512 | E.SUN card ending 5512 |
| 02–04 rows | 10/3 消費 · 10/4 入帳 | Spent 10/3 · Posted 10/4 |
| 03–05 | 帳目合併 (title) | Merge review |
| 03–05 | 同一筆消費的發票與刷卡，只算一次。 | An invoice and its payment, counted once. |
| 03–05 | 全聯福利中心 | PX Mart |
| 03–05 | 日常 · 10/3 | Daily · 10/3 |
| 03–05 | 高度相符 | Strong match |
| 03–04 | 金額相同 · 同一天 · 商家相符 | Same amount · Same day · Merchant matches |
| 03–04 | 合併 (button) | Merge |
| 04–05 | 已合併 (seal, badge) | Merged |
| 04–05 | 本月計為 1 筆 | Counted once this month |
| 04–05 merged row tags | 電子發票 · 玉山信用卡 5512 | E-invoice · E.SUN card 5512 |
| 05 | 每個數字， / 都點得回出處。 | Every number, / traced to its source. |
| 06 | 下載 macOS Beta · 適用 Apple silicon | Download macOS Beta · Requires Apple silicon |

Numbers (TWD 1,444, TWD 13,385, TWD 11,941, TWD 2,148,216, AB-38201745, 5512) and the
OctopusBeak wordmark do not change. The screenshot plates (spending page, overview,
blurred detail modal) stay as they are; they read as texture, not copy.

Type: keep PingFang TC / SF Mono so Latin glyphs match the Chinese cut. English runs
longer than the Chinese; when a string overflows its slot, first tighten tracking, then
step the size down, keeping the slot's position and baseline. A string that crosses a
cut must use the same size and position on both sides of the cut.

## Rendering the English cut

A project may hold only one root composition, so `npm run site-video` points `index.html`
at `compositions/frames-en/` for the English render and restores it afterwards (see
`scripts/site-video.mjs`).
