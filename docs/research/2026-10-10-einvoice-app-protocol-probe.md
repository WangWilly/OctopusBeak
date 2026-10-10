# 電子發票 App 協定探查：Cloudflare 封鎖與真瀏覽器繞行

研究日期：2026-10-10。性質：Phase 0 欄位探查與傳輸驗證紀錄，非部署或正式資料結果。配合 [ADR 0043](../adr/0043-einvoice-app-protocol-over-browser-transport.md)。

## 背景

網站 workflow（`src/workflows/einvoice-personal-invoices.ts`）的 E-Invoice 同步失敗於 `source-collection-failed`／`authentication-timeout`：登入後被導到 手機條碼專區 › 資料設定 改密碼頁，`#dp-input-searchInvoiceDate` 從未出現。原本評估改用 all-set-tw（MIT，commit `a5c56e9`）的 App 協定，但直接 HTTP 探測被 Cloudflare 封鎖。本紀錄是驗證「真瀏覽器 + App 協定」這條可用路徑的過程與結果。

## 三個 host 的現況

| 路徑 | host | 結果 |
| --- | --- | --- |
| v2 登入 | `uia.einvoice.nat.gov.tw/mid/v1/login` | curl 403「Just a moment…」；**真瀏覽器 200** |
| v2 查發票 | `upi.einvoice.nat.gov.tw` | curl 403「Just a moment…」；**真瀏覽器 200** |
| 舊協定 | `invoiceapp.nat.gov.tw/UIAPAPP/api/` | 可連線（真後端 IP 203.66.154.x），但登入回 `6603`「目前系統繁忙，請稍後再試。」（協定已廢棄） |
| 網站 | `www.einvoice.nat.gov.tw` | 登入成功但被導到 資料設定 改密碼 |

`6603` 是 all-set-tw `EInvoiceProtocolUnavailableError` 明確攔截的碼，註解指出「不是帳號密碼錯誤，也不是暫時忙碌；重複同步不會恢復」。用假門號與真實門號都回 6603，證明與憑證無關，是協定層級拒絕。因此舊協定 `invoiceapp.nat.gov.tw` 雖可連線，但登入不可用。

## Cloudflare 封鎖的性質與繞行

- Cloudflare 對 `uia`/`upi` 回 `403 Just a moment…`，但**不設 `cf_clearance` cookie**（真瀏覽器通過後 cookie 仍為空）。這表示封鎖靠的是 TLS 指紋／header 特徵，不是 cookie challenge。
- 因此「用真瀏覽器通過 challenge 後把 cookie 拿給 Node 用」無效——所有請求必須**在瀏覽器頁面內**發送，才能繼承真瀏覽器的 TLS 指紋。
- 登入（`uia`）以 in-page `fetch` 即可成功；查發票（`upi`）則額外回 `403 Invalid CORS request`，因為瀏覽器 POST 會自動帶 `Origin`，而原生 App 不帶、`upi` 的 Cloudflare 拒絕帶 `Origin` 的請求。
- 解法：CDP `Fetch.enable` + `Fetch.continueRequest` 在網路層剝掉 `Origin`/`Referer` 後續送。剝除後 `upi` 查詢回 200 + App 後端 JSON。這是沿用國泰／LINE 既有的「登入後在 page context 發 fetch」模式，非 TLS 偽造、非換 IP、非 Workers 中繼。

## 欄位清單（Phase 0 探查結果）

登入回 `result: 0`，session 含 `sid`、`token`、`skey`、`iv`、`ltoken`、`appid`、`ssme`、`liat`、`carrier_code`、`nick_name`、`need_change_pw`（本帳號為 `false`）等。

header 查詢（`/einvoice/carriers/query-invoices-header`，前一個月 24 筆）每筆含：

- `invNum`（發票號碼）、`invPeriod`（期別，如 `11510`）
- `sellerBan`（賣方統編）、`sellerName`、`sellerAddress`
- `amount`（總額，字串）、`currency`、`donateMark`、`invDonatable`、`npoBan`
- `invStatus`（狀態，觀察值 `開立已確認`）、`buyerBan`、`cardType`、`cardNo`
- `invoiceTime`（`HH:MM:SS`）與 `invDate`（`year/month/date/day/hours/minutes/seconds/time/timezoneOffset`，`time` 為 epoch 毫秒）
- `awardInfo`（null）、`rowNum`

明細查詢（`/einvoice/carriers/query-invoices-details`）每品項含 `description`、`quantity`、`unitPrice`、`amount`。

分頁：`page=1` 回 24 筆、`page=2` 回 0 筆，回應無 total 欄位，需翻到空頁證明完整範圍。

## 對照 canonical contract

| contract 欄位 | App 協定來源 | 備註 |
| --- | --- | --- |
| `invoiceNumber` | `invNum` | |
| `seller.taxId` | `sellerBan` | |
| `seller.name` | `sellerName` | |
| `total` | `amount` | 字串 → `exactDecimal` |
| `occurrence` | `invDate` + `invoiceTime` | |
| `items[].name/quantity/unitPrice/amount` | 明細 `description`/`quantity`/`unitPrice`/`amount` | |
| `revisionKind` | `invStatus` | `開立已確認` → issued；作廢字串待確認 |
| `randomNumber` | 無 → null | |
| `pages`（完整範圍證明） | page 翻到空頁 | |

## 尚未確認

- **作廢狀態字串**：本月 24 筆皆 `開立已確認`（issued），未觀察到作廢值。`statusKind` 需加入 App 協定字串對照；在觀察到作廢樣本前，該字串不應臆測。
- `need_change_pw` 在強制改密碼情境下是否為 `true`，以及 App 協定是否因此拒絕查詢，未驗證。
