# OctopusBeak 現有銀行資料儲存與來源能力盤點

## 研究問題與範圍

本文件回答：現有 collector、CSV importer、SQLite ledger 與產品 query，對台灣銀行存款、外幣存款、信用卡、餘額、交易、帳單／抓取批次及來源 lineage **實際能表達什麼**。證據基線為 commit [`93bfbd24`](https://github.com/WangWilly/OctopusBeak/tree/93bfbd24b3353b19b5cdf85b592e6731bc23ba90)。證券、基金、加密資產排除；貸款只標示既有邊界。

證據強度分三層：

- **Source fact**：collector 從銀行頁面/API 讀到並寫入 CSV/sidecar 的欄位。
- **Parser inference**：importer 由目錄、檔名、sidecar 或欄位推導的值；不等同銀行明示。
- **Normalized projection**：ledger 或產品層再計算的 account、balance、transaction、snapshot；不等同 source fact。

`BANK_STATEMENT_CAPABILITIES` 與 automation task registry 只證明產品可選／可執行哪些 workflow，不單獨證明銀行端現在仍可成功抓取。registry 宣告 Fubon、ESun、Yuanta、Cathay、HNCB、CTBC、Post、SinoPac、LINE Bank 的 statement types，且 importer gate 依賴相應 crawler tasks；本文只有在 collector output 與 parser mapping 也吻合時，才列為「collector→import 已接通」。([statement-selection.ts L68-L79](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/automation/statement-selection.ts#L68-L79), [tasks.ts L29-L41](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/automation/server/tasks.ts#L29-L41))

## 1. 現有儲存模型

### 共通 provenance

三種本票核心 row tables 共用：`statement_row_id`、`source_file_id`、`import_run_id`、`source_relative_path`、`source_row_index`、`source_hash`、`content_hash`、`bank`、`product`、`raw_payload_json`、`imported_at`、`created_at`。因此 normalized row 可回到某次 import、某個檔案路徑及 CSV row，但這不是外部銀行物件 ID。([schema.ts L4-L17](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/db/schema.ts#L4-L17))

### `account_transactions`

來源專屬 normalized fields：`account_name`、`account_number`、固定必填的 `currency`、`accounting_date`、`transaction_date`、`transaction_time`、`transaction_at_utc`、`description`、`withdrawal_amount`、`deposit_amount`、`balance_after`、`note`、`fx_rate`。沒有 account master、account type（活存／支存／定存）、available/current balance 區分、transaction status 或 source transaction ID。([schema.ts L148-L163](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/db/schema.ts#L148-L163))

### `foreign_currency_transactions`

欄位與 domestic 相同，另有 `query_currency`；每 row 的 `currency` 必填。沒有外幣 account master、存款種類或 balance type。([schema.ts L165-L181](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/db/schema.ts#L165-L181))

### 信用卡 tables

`credit_card_statement_lines` 保存 `statement_type`、`statement_period`、card number/label、consume/posting dates、description、country/foreign currency、FX date/amount、TWD amount、installment action、payment status，以及 canonicalization 用的 `content_key`、`occurrence_index`、first/last seen。([schema.ts L183-L208](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/db/schema.ts#L183-L208))

`credit_card_captures` 與 `credit_card_capture_entries` 表示一次完整 billed+unbilled capture 及其 row membership；`credit_card_snapshots` 則按 card key、statement type、日期保存 transaction count 與 total amount。這些是 importer 建立的 normalized capture/snapshot，不是銀行提供的 balance object。([schema.ts L210-L267](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/db/schema.ts#L210-L267))

### 貸款邊界

現有 `loan_transactions` 有 account number、trade/posting dates、item、計息期間、amount/rate、`balance_after`、overpayment、note；本票不延伸其 canonical model。([schema.ts L269-L282](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/db/schema.ts#L269-L282))

## 2. Collector → importer → projection

### Collector 輸出

銀行存款 workflows 的共同 contract 是每 account/currency 寫一對 `.csv` + `.json` sidecar。CSV 是 transaction rows；sidecar 通常保存 `帳號`、查詢期間、分行，外幣來源另存幣別。例：Fubon 寫帳務日、交易時間、摘要、支出、存入、即時餘額、附註及 account/query metadata；Cathay foreign 另寫 currency；SinoPac 與 LINE Bank 依 currency 分流到 domestic/foreign 目錄。([fubon-statements.ts L654-L705](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/fubon-statements.ts#L654-L705), [cathay-foreign-statements.ts L438-L490](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/cathay-foreign-statements.ts#L438-L490), [sinopac-statements.ts L600-L634](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/sinopac-statements.ts#L600-L634), [linebank-statements.ts L457-L491](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/linebank-statements.ts#L457-L491))

信用卡 workflows 也寫 billed/unbilled CSV + sidecars。Fubon source columns 包含 last-card identifiers、consume/posting dates、foreign/TWD amounts、installment/payment status；ESun 有 statement period、payment currency/status；Yuanta 有 consume/posting dates、country/currency、FX date/amount、TWD amount，billed 才多 payment status。([fubon-credit-card-statements.ts L112-L135](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/fubon-credit-card-statements.ts#L112-L135), [esun-credit-card-statements.ts L82-L93](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/esun-credit-card-statements.ts#L82-L93), [yuanta-credit-card-statements.ts L627-L639](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/yuanta-credit-card-statements.ts#L627-L639))

### Parser 與 persistence

Importer recursively 掃描 `downloads/**/*.csv`，以第一層目錄 `<bank>-<product>` 推導 bank/product，讀同 basename JSON sidecar；這兩者都是 **parser inference**。([import-downloads-csv.ts L169-L177](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L169-L177), [import-downloads-csv.ts L207-L220](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L207-L220))

第一 CSV row 被視為 header；空 row 被略過；duplicate headers 會加 `__2` 等 suffix。每 row 保留 raw payload，再交由 `(bank, product, filename)` mapping 寫入 typed table；未知組合進 `unsupported_statement_rows`。([import-downloads-csv.ts L1090-L1140](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L1090-L1140), [source-csv-parsers.ts L60-L149](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/source-csv-parsers.ts#L60-L149))

Domestic parser 將「交易日期」缺值 fallback 為「帳務日期」，currency 強制 TWD；account identity 依序取 row、sidecar、filename；foreign parser 再由 row、sidecar 或 filename 推 currency。信用卡 `statement_type` 是由 filename 是否含 `unbilled` 推得。這些值均須視為 **parser inference**。([source-csv-parsers.ts L385-L425](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/source-csv-parsers.ts#L385-L425), [source-csv-parsers.ts L428-L459](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/source-csv-parsers.ts#L428-L459), [source-csv-parsers.ts L462-L498](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/source-csv-parsers.ts#L462-L498))

Importer 在單一 SQLite transaction 內接受 source versions、寫 source files/rows/captures、寫 completed run；失敗 rollback，另記 failed event。([import-downloads-csv.ts L1306-L1413](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L1306-L1413))

## 3. Identity、dedup 與 idempotency

- `source_version_key = SHA256([bank, product, source_file_hash])`；相同 bytes 在同 bank/product 下再次觀察時不重投影，只增加 observation count/last seen。路徑不是 version identity。([source-version.ts L1-L7](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/source-version.ts#L1-L7), [import-downloads-csv.ts L1206-L1227](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L1206-L1227))
- `source_file_id = hash(source relative path)`；`statement_row_id = hash(path, row index, raw-row hash)`。它們是本地 ingestion IDs，不是 provider IDs。([import-downloads-csv.ts L382-L394](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L382-L394))
- 一般 typed rows 的 `content_hash = hash(bank, product, raw payload)`，但忽略 query period/currency keys；unique `content_hash` 或 `statement_row_id` 衝突視為 duplicate。因此 corrected source row 可能成為新 logical row，而非更新舊 row；也沒有 source transaction ID 可用來表達 mutation。([content-hash.ts L3-L8](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/content-hash.ts#L3-L8), [content-hash.ts L30-L41](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/content-hash.ts#L30-L41), [import-downloads-csv.ts L280-L301](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L280-L301))
- Credit-card content identity 是 bank + card last4 + billed/unbilled + consume date + description + currency/amount + installment/payment status；相同 content 的真正重複 row 用 capture 內 occurrence index 保留。程式註解亦承認 source 沒有 transaction sequence 時可能 collision。([credit-card-identity.ts L21-L35](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/credit-card-identity.ts#L21-L35), [credit-card-capture.ts L26-L37](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/credit-card-capture.ts#L26-L37))
- 只有 billed 與 unbilled 兩檔、capture metadata/card row counts 彼此一致時，capture 才被 verified；這是 importer completeness 驗證，不是銀行 statement finality。([import-downloads-csv.ts L829-L889](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L829-L889))

## 4. Lineage：已有與缺少

已有：

- `import_runs`/events 記 importer 起訖、filters、file/row counts；`source_file_imports` 記 immutable version、first/last seen、observation count；`source_row_lineage` 記 source version row → projection table/row 與 inserted/duplicate/upserted outcome。([schema.ts L25-L94](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/db/schema.ts#L25-L94))
- `source_files` 是「同一路徑最新觀察」的 mutable record；`source_file_imports` 才是多版本 history。([import-downloads-csv.ts L396-L461](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L396-L461))
- 每 normalized row 仍存完整 raw CSV payload。([import-downloads-csv.ts L464-L509](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L464-L509))

缺少：

- Automation crawler run 有獨立 `task_run_id`、task/script/status/log/attempt/timestamps，但 schema 與 importer input 都沒有 `task_run_id` ↔ generated file/source version/import run 的 FK 或 correlation ID。只能用 path/timestamp/log 人工關聯。([store.ts L15-L32](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/automation/server/store.ts#L15-L32), [store.ts L246-L273](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/automation/server/store.ts#L246-L273), [import-downloads-csv.ts L33-L38](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/import-downloads-csv.ts#L33-L38))
- 沒有 institution connection/login identity、provider account ID、provider transaction ID、statement ID、bank-side generated/export timestamp、coverage start/end 的結構化欄位；sidecar 的 query periods 是 free-form metadata。
- 沒有「同一銀行 transaction 被後續 source 修正／刪除／pending→posted」的 explicit lineage。一般 dedup 是內容相等；credit card 是 local content key + occurrence。

## 5. 產品使用的 normalized projections

- Overview 讀取 source lineage、domestic/foreign transactions、credit-card captures/entries/snapshots/lines，建立 account overview、net assets、daily history 與 Sankey。([load-overview.ts L21-L76](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/overview/server/load-overview.ts#L21-L76))
- Bank/foreign account identity 是 hash(kind, bank, product, account number, currency)；balance 是每 account/currency 最新一筆 transaction 的 `balance_after`，不是獨立 balance snapshot。([accounts.ts L319-L360](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/shared-ledger/server/accounts.ts#L319-L360), [accounts.ts L1153-L1159](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/shared-ledger/server/accounts.ts#L1153-L1159))
- Transaction DTO 的 signed amount 是 deposit − withdrawal；date 依 transaction → accounting → import date fallback。信用卡 account 以 bank/product/card last4 聚合，amount 優先 TWD。這些是 **normalized projections**。([accounts.ts L847-L891](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/shared-ledger/server/accounts.ts#L847-L891))
- Spending 直接 query domestic `account_transactions` 的提款/存款，並用負額 credit-card lines 識別 card payment；foreign transactions 不在此 spending query。([spending store.ts L107-L128](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/spending/server/store.ts#L107-L128))
- Daily history 的日期主要取 source file modified/imported day；它不是 source-reported balance as-of timeline。([daily-history.ts L52-L79](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/overview/server/daily-history.ts#L52-L79), [daily-history.ts L106-L108](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/lib/overview/server/daily-history.ts#L106-L108))

## 6. Supported-source capability matrix

`✓` = collector output 與 parser mapping 都有 source-code 證據；`P` = parser/projected/inferred；`—` = 未見證據。所有列均缺 source transaction ID、statement ID 與 bank-side mutation semantics。

| 實際接通來源 | Account identifier | Balance | Transaction/date | Statement/status | Currency/FX | Source identifiers |
|---|---|---|---|---|---|---|
| Fubon domestic | sidecar account；P account number extraction | ✓ running `即時餘額` | ✓ accounting date/time, debit/credit | query periods；無 row status | TWD(P) | — |
| Cathay domestic | sidecar/API account no+label | ✓ running balance | ✓ accounting + transaction datetime | query period；無 row status | TWD(P) | — |
| HNCB domestic | sidecar account/id | ✓ running balance | ✓ transaction/accounting date+time；另有存款人代號、票據欄 | query period；無 row status | row currency | — |
| CTBC / Post domestic | sidecar account/id | ✓ running balance | ✓ accounting/transaction date+time | query periods；無 row status | TWD(P) | — |
| Yuanta domestic | row account name/no | ✓ 帳面餘額 | ✓ accounting/transaction date+time | chosen range；無 row status | TWD(P) | — |
| SinoPac / LINE Bank domestic | endpoint account id/label；sidecar | ✓ running balance | ✓ accounting/transaction date+time | query periods；無 row status | TWD(P), row FX optional | — |
| Cathay / SinoPac / LINE Bank foreign | account id+currency；sidecar | ✓ running balance | ✓ dates/time, debit/credit | query periods；無 row status | ✓ currency；FX only when source row has it | — |
| Yuanta foreign demand deposit | row account name/no/query currency | ✓ 帳面餘額 | ✓ accounting/transaction date+time | chosen range；無 row status | ✓ row/query currency + FX | — |
| Fubon / ESun / Yuanta credit card | card number/label（projection 常退化 last4） | —；P capture total only | ✓ consume date；posting date 視來源；foreign/TWD amount | billed/unbilled 是 filename P；payment status 視來源 | foreign amount/currency；TWD amount；部分 FX date | — |

Domestic/foreign table mappings 的完整名單由 parser 明確列出。([source-csv-parsers.ts L72-L109](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/ledger/source-csv-parsers.ts#L72-L109)) HNCB headers 證明額外欄位；Yuanta foreign headers 證明 query currency/FX；SinoPac/LINE Bank headers 都含 running balance 與 FX。([hncb-statements.ts L85-L97](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/hncb-statements.ts#L85-L97), [yuanta-foreign-currency-statements.ts L119-L133](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/yuanta-foreign-currency-statements.ts#L119-L133), [sinopac-statements.ts L19-L29](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/sinopac-statements.ts#L19-L29), [linebank-statements.ts L12-L22](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/linebank-statements.ts#L12-L22))

### 無法證明或僅為邊界

- **活存／支存／定存**：現行 domestic table 沒有 account type。Yuanta foreign workflow 明確導向「活期明細」，但這不足以推出其他 workflow 或定存能力；定存 balance/term/maturity/rate 沒有本票範圍內的 normalized fields。([yuanta-foreign-currency-statements.ts L630-L636](https://github.com/WangWilly/OctopusBeak/blob/93bfbd24b3353b19b5cdf85b592e6731bc23ba90/src/workflows/yuanta-foreign-currency-statements.ts#L630-L636))
- Workflow 檔與 tests 證明 parser/DOM/API contract 的意圖，不證明 2026-08 銀行 production endpoint 可用、所有 account types 可列舉或歷史區間完整。
- `payment_status` 是自由文字且各 card source 不一致；不能當成跨來源 posted/pending enum。
- Running `balance_after` 只在有 transaction row 且 source 有該欄時存在；零交易 account 可能完全不出現在 normalized account overview。

## 7. 給後續 canonical model 的事實護欄（非 schema 決策）

1. 必須能保留 source fact、parser inference、normalized projection 的界線；目前若只看 typed row，三者容易混在一起。
2. 不可預設 provider account/transaction/statement IDs 存在；現有 bank sources 幾乎只有 account label/number、card last4 與本地 hashes。
3. 不可預設 transaction 有 stable mutation identity、pending→posted linkage、delete/update stream 或 webhook；repo 無此 source capability。
4. `balance_after` 是 transaction-row running balance；credit-card liability 是 verified capture 的 locally computed total。兩者皆不可自動等同獨立 provider balance snapshot。
5. `transaction_date`、`currency=TWD`、credit-card billed/unbilled 與 account identity 可能是 fallback/inference；canonical discussion 應明示 provenance/confidence。
6. Source-file/import-run/row lineage 已足以做 ingestion audit，但 automation run 到 source file 的鏈缺失。
7. Account type、term-deposit terms、statement coverage/finality、source timestamps、balance type 與 cross-source institution/account identity，都是現有模型無法可靠回答的 gaps；後續決策不可從 workflow 名稱臆測。

## Unresolved gaps

- Repo 中沒有 production fixture/recording 可證明各 bank 實際回傳的 account-type universe、空帳戶或零交易帳戶行為。
- 查詢期間 sidecar 多為 workflow request，不一定等於 source 保證的完整 coverage；未見 truncation/page completeness 的統一持久化欄位。
- 未見 institution-level canonical registry；`bank`/`product` 來自目錄命名，可能隨 workflow rename 改變。
- 未見跨檔案辨識同一 account 的 provider ID；account number masking/label fallback 可能造成 collision 或分裂。
- Tests 可驗證 importer idempotency 與部分 workflow parser，但不能提升為 bank production capability；本文件因此沒有把 test-only case 列成 supported source。
