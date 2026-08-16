# 現有本機 ledger 對 canonical reset 的可行性

## 範圍與方法

本紀錄彙整 2026-08-16 對 OctopusBeak application-support `data` 與 `downloads` 目錄所做的唯讀盤點，用來判斷 legacy migration 是否值得實作。SQLite 以 immutable read-only 模式查詢；下載檔只統計數量、格式與 integration 分布。本文不保存帳號、交易內容、登入資料、原始 payload 或檔名。

這是單一實際執行環境的可行性證據，不是 integration contract fixture，也不能證明某個 legacy row 符合 canonical admission。

## 資料規模

- `ledger.sqlite` 約 1.28 GB。
- `downloads` 約 4,239 個檔案，以各 integration 的 CSV／JSON 輸出為主。
- ledger 記錄 595 個 imported source versions。
- 產品 overview、spending 與 liabilities 查詢直接依賴多組 product-specific tables；64 筆 spending overrides 仍引用 legacy statement row identity，盤點時沒有 orphan。

## Canonical model gaps

| Legacy product data | 盤點數量 | 可見資訊 | 對 strict canonical admission 的限制 |
| --- | ---: | --- | --- |
| Domestic account transactions | 427 | legacy account欄位與交易時間皆存在；3 筆 movement 為零 | 欄位存在不等於 integration contract 已證明 stable account identity、direction 與 status |
| Foreign-currency transactions | 71 | legacy identity 與時間皆存在 | 仍需 contract 證明 account scope、money direction 與 typed date semantics |
| Credit-card statement lines | 514 | 多數有 legacy card identity；1 筆 billed row 缺少 card identity | card key 不能自行提升為 Credit-card Financial Account identity |
| Active loan transactions | 132 | 另有 6 筆透過 disabled lineage 不再 active | legacy visibility lifecycle 不能直接等同 canonical source assertion lifecycle |
| Fund holding rows | 106 | overview projection 缺少 provider effective time，亦缺 fund ID／query period | 無法滿足 Holding Observation 的 effective-time 與 stable Security evidence |
| Brokerage holding rows | 297 | 具有 legacy identity 與 `as_of` | 仍需由 integration contract 驗證語義，不能僅靠欄位名稱遷移 |
| Brokerage trades | 91 | 具有 legacy identity 與日期 | 仍缺 strict admission 所需的完整 contract guarantee |
| MaiCoin account snapshots | 347 | 只有 collection／capture time | 不可把 collection time 代替 Balance Observation `effective_at` |
| MaiCoin statement rows | 890 | 多數具有 provider-created time；conversion row 另有 from／to values | event data可能可重新建模，但不能修補 snapshot effective time |
| Credit-card snapshots | 294 | `as_of_date` 由 `capturedAt` 截取日期產生 | parser-derived collection date 不是 provider-established financial effective time |

## 可行性結論

Legacy data不是完全無用，但不同產品缺少的 canonical semantics 不一致。要保留其中一部分，仍需建立 product-specific migration contracts、信用卡 account／card 重建規則、legacy effective-time 例外、override identity 轉換及 mixed projection compatibility；即使完成，也無法讓 fund、crypto balance 與 credit-card snapshot history符合目前要求的 Measurement Effective Time。

因此，最小且完整符合現有 model 的方案是 Canonical Reset Cutover：不讀取或轉換任何 legacy financial state，只保存 Operational Configuration，從新的 contract-compliant Captures 重建資料。舊 ledger 與 downloads 只進入 read-disabled Legacy Data Quarantine，並依 [ADR 0009](../adr/0009-reset-legacy-financial-data-before-canonical-collection.md) 的 marker 條件在後續 release 銷毀。

此結論不保證 provider 仍能重新提供全部歷史。無法重新取得的歷史會永久缺少；產品必須顯示 awaiting collection 或 unavailable，而不能回退到 legacy projection。
