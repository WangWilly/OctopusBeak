# Plaid account、transaction 與同步語義研究

研究日期：2026-08-15

範圍：為後續 canonical model 與領域詞彙決策建立事實護欄；本文不決定 OctopusBeak schema。

來源政策：只引用 Plaid 官方文件。欄位語義以目前官方 API reference 為準；Plaid 文件或 API version 日後可能改變。

## 結論摘要

- Plaid 的 `Item` 是一次金融機構登入／連線，不是帳戶本身；同一組帳戶再次連線會產生不同 `item_id`。`account_id` 也不是永久跨連線識別碼：Plaid 無法 reconciliation、刪除 access token 後重連等情況都可能換 ID。[Items API](https://plaid.com/docs/api/items/)；[Accounts API](https://plaid.com/docs/api/accounts/)；[Preventing duplicate Items](https://plaid.com/docs/link/duplicate-items/)
- Plaid account、balance 與 transaction response 同時包含必定為非 `null` 的核心欄位，以及大量 nullable、機構限定、產品限定或 Plaid enrichment 欄位。`available`、精確時間、merchant、分類、counterparty、location、MCC、pending linkage 都不能視為普遍存在。[Accounts API](https://plaid.com/docs/api/accounts/)；[Transactions API](https://plaid.com/docs/api/products/transactions/)
- `/transactions/sync` 是「自某 cursor 後的有序 patch stream」，不是指定日期範圍的 snapshot。呼叫端必須拉完所有頁，累積 `added`、`modified`、`removed`，並保存最後 cursor；若 pagination 期間資料 mutation，整輪必須從該輪第一頁的原 cursor 重跑。[Transactions API — `/transactions/sync`](https://plaid.com/docs/api/products/transactions/#transactionssync)；[Sync migration guide](https://plaid.com/docs/transactions/sync-migration/)
- Pending 轉 posted 不是同一 record 的狀態翻轉：通常是 pending ID 出現在 `removed`，posted transaction 以新 ID 出現在 `added`，並可能用 `pending_transaction_id` 連回舊 ID；但機構不一定提供 pending，Plaid 也不保證成功 matching。[Transaction states](https://plaid.com/docs/transactions/transactions-data/)
- Plaid 提供的穩定 IDs、cursor/delta、webhook 與 enrichment 是 provider capabilities。沒有明示相同 contract 的台灣網銀爬取資料，不可假設具備這些能力。

## 1. Plaid 物件邊界與識別碼

### Item 與 Account

Plaid 定義一個 `Item` 為一次金融機構登入；一個 Item 通常包含該登入下的一個或多個 accounts。`access_token` 對應 Item，`item_id` 用於唯一識別該 Item 與 webhook routing。同一帳戶、同一機構再次經 Link 建立連線，仍會形成另一個 `item_id`，因此 Item identity 不等於外部世界中的銀行帳戶 identity。[Items API](https://plaid.com/docs/api/items/)；[Preventing duplicate Items](https://plaid.com/docs/link/duplicate-items/)

`account_id` 是 Plaid 在該連線脈絡中的 account identifier，且大小寫敏感。官方保證它通常不變，但列出兩種明確例外：Plaid 無法把金融機構新回傳資料 reconciliation 到既有帳戶（例如名稱改變），或 access token 被刪除後以相同 credentials 重新連線。帳戶若從 response 消失，Plaid 說「likely closed」；closed accounts 本身不再回傳。[Accounts API](https://plaid.com/docs/api/accounts/)

Plaid 另有 `persistent_account_id`，但它只支援採 Tokenized Account Numbers 的特定美國機構／帳戶，不能推廣成一般 account key。[Accounts API](https://plaid.com/docs/api/accounts/)；[Preventing duplicate Items](https://plaid.com/docs/link/duplicate-items/)

### Account 核心欄位與可空性

下表的「非 nullable」是 Plaid API reference 對 response object 的型別承諾，不代表其他資料來源也必須能供應。

| 欄位 | Plaid response 語義 | Presence／nullability 限制 |
| --- | --- | --- |
| `account_id` | Plaid account identifier | 非 nullable；case-sensitive；可能因 reconciliation 或重連而改變 |
| `balances` | balance fields 的容器 | 非 nullable object；其子欄位多為 nullable |
| `name` | 使用者或金融機構指定的帳戶名稱 | 非 nullable string |
| `type` | `investment`、`credit`、`depository`、`loan`、`other` 等粗分類 | 非 nullable enum string |
| `mask` | 顯示 mask 或 official account number 的末 2–4 碼 | nullable；同一 Item 內也可能不唯一，且不保證等於帳號末四碼 |
| `official_name` | 金融機構提供的官方帳戶名稱 | nullable |
| `subtype` | checking、savings、credit card 等細分類 | nullable；有效值受 `type` 與 API taxonomy 約束 |

來源：[Accounts API](https://plaid.com/docs/api/accounts/)；mask／duplicate 限制另見 [Preventing duplicate Items](https://plaid.com/docs/link/duplicate-items/)。

### Balance 欄位與 freshness

| 欄位 | Plaid response 語義 | Presence／nullability 限制 |
| --- | --- | --- |
| `available` | 金融機構判定目前可提領的金額 | nullable；並非所有機構計算。通常 `current` 為 null 時它非 null，但 limited-purpose checking 可兩者皆 null |
| `current` | 帳戶持有或所欠總額 | nullable；正負號意義依 account type 不同。credit／loan 正值通常表示欠款；investment 表示機構呈現的資產總值 |
| `limit` | credit limit；某些 depository 市場則是 overdraft limit | nullable；強烈依 account type／地區而定 |
| `iso_currency_code` | ISO-4217 幣別 | nullable；與 `unofficial_currency_code` 互斥 |
| `unofficial_currency_code` | 非 ISO 幣別 | nullable；與 `iso_currency_code` 互斥 |
| `last_updated_datetime` | balance 最後更新時間 | nullable 且目前只對官方指定的單一機構回傳，不可作通用 freshness timestamp |

除 `/accounts/balance/get` 或特定即時 balance endpoint 外，balance 可能是 cached，或由 Plaid 按最近取得的 transaction activity 調整；若 Item 啟用 Transactions，balance 至少與最近 transaction update 一樣新，但仍不是即時保證。[Accounts API](https://plaid.com/docs/api/accounts/)

## 2. Transaction 欄位、required／nullable／conditional 語義

以下聚焦 `/transactions/sync`／`/transactions/get` 的一般 Transaction object。Plaid API reference 將未標 `nullable` 的 response 欄位描述為非 nullable；部分非 nullable 容器仍可能是空陣列或其子欄位全為 null。

### 核心與金額／日期

| 欄位 | Plaid 語義 | Presence／nullability 限制 |
| --- | --- | --- |
| `transaction_id` | Plaid transaction identifier | 非 nullable、case-sensitive；pending 與 posted 通常是不同 ID |
| `account_id` | 此 transaction 所屬 Plaid account | 非 nullable；繼承 account ID 的 provider scope 與變更限制 |
| `amount` | transaction currency 下的 settled value | 非 nullable number；除 Income products 外，流出為正、流入為負 |
| `date` | pending 時為發生日；posted 時為入帳日 | 非 nullable `YYYY-MM-DD` |
| `pending` | 是否未入帳／未結算 | 非 nullable boolean；細節可能在結算前改變 |
| `payment_channel` | `online`、`in store`、`other` | 非 nullable；取代 deprecated `transaction_type` |
| `iso_currency_code` | ISO-4217 幣別 | nullable；與 `unofficial_currency_code` 互斥 |
| `unofficial_currency_code` | 非 ISO 幣別 | nullable；與 `iso_currency_code` 互斥 |
| `authorized_date` | 金融機構授權日 | nullable；posted UI 時官方通常偏好它而非 posted `date` |
| `authorized_datetime` | 授權時間 | nullable；只由部分機構提供，可能帶預設 `00:00:00` |
| `datetime` | 入帳時間 | nullable；只由部分機構提供，可能帶預設時間 |

來源：[Transactions API](https://plaid.com/docs/api/products/transactions/)。

### 描述、分類與 enrichment

| 欄位 | Plaid 語義 | Presence／nullability／conditional 限制 |
| --- | --- | --- |
| `name` | merchant name 或 transaction description 的 legacy 欄位 | Transactions endpoints 會出現，但已 deprecated／不主動維護 |
| `merchant_name` | Plaid 從 `name` enrichment 的較可讀 merchant | nullable；checks、account transfers 等可能沒有有意義的 merchant |
| `original_description` | 金融機構原始描述 | nullable；在 sync/get 只有 request 設 `include_original_description=true` 才包含 |
| `personal_finance_category` | Plaid 判定的 transaction intent taxonomy | nullable；若有則含非 null `primary`／`detailed` 及 nullable confidence；taxonomy 有版本 |
| `counterparties` | Plaid 從 raw description 擷取的 merchant／institution／payment app 等 parties | array 可為空；party 的 `entity_id`、網站、logo、confidence 等可空；`entity_id` 是 Plaid-generated stable ID |
| `merchant_entity_id` | 映射到跨門市 merchant 的 Plaid-generated stable ID | nullable |
| `merchant_category_code` | 機構回報的 MCC | nullable；通常僅機構有傳送的 card purchase 才有 |
| `location` | physical transaction 地點 | object 會出現但所有細節可空；online 不提供，且 availability 依 merchant |
| `payment_meta` | inter-bank transfer metadata | Transactions endpoints 會出現，但沒有任何子欄位有資料保證；非 transfer 時全為 null |
| `check_number` | 支票號碼 | nullable；只在 check transaction 填入 |
| `account_owner` | sub-account owner 描述 | nullable、不常填、格式不標準且依機構 |

來源：[Transactions API](https://plaid.com/docs/api/products/transactions/)。Plaid 明確描述 `merchant_name`、counterparties、PFC 與 entity IDs 為 Plaid enrichment／Plaid-generated data，而非原始銀行 statement 的普遍欄位。

## 3. `/transactions/sync` 的 patch 與 cursor contract

### Cursor 與 response

- Request `cursor` 表示「上一次已看過的 update」。省略／空 cursor 會從 Item 最初 added transactions 開始回傳完整 update history；`"now"` 是既有 `/transactions/get` migration 的 fast-forward 特例，不建議新 Item 使用。[Transactions API — `/transactions/sync`](https://plaid.com/docs/api/products/transactions/#transactionssync)；[Sync migration guide](https://plaid.com/docs/transactions/sync-migration/)
- `added`：cursor 後加入 Item 的完整 Transaction objects；`modified`：cursor 後被修改的完整 Transaction objects；`removed`：被移除 transaction 的 `transaction_id` 與 `account_id`。三組各自按 ascending last-modified time 排序。[Transactions API — `/transactions/sync`](https://plaid.com/docs/api/products/transactions/#transactionssync)
- `next_cursor` 用於取得後續頁或未來 updates。只有 `has_more=false` 時，該 cursor 才代表這輪已拉完；官方保證拉完所有頁後的 cursor 至少有效一年，應持久保存。資料尚未 ready 時可能是空字串。[Transactions API — `/transactions/sync`](https://plaid.com/docs/api/products/transactions/#transactionssync)
- `has_more=true` 時必須用該頁 `next_cursor` 繼續，直到 false。Plaid sample 先累積所有頁的三種 patches，最後才把 updates 與 final cursor 一起 persist，這反映 cursor checkpoint 與 patch application 需要同一完整批次處理。[Transactions API — `/transactions/sync`](https://plaid.com/docs/api/products/transactions/#transactionssync)
- `/transactions/sync` 不接受 date range；若 consumer 只要日期範圍，必須在取得 sync updates 後自行 filter。[Sync migration guide](https://plaid.com/docs/transactions/sync-migration/)

### Pagination mutation retry

Plaid 可能在多頁 update 尚未拉完時又收到 underlying mutation，並回傳 `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`。官方要求：**整個 pagination loop 從本輪第一頁使用的原 cursor 重新開始**，不可只重試失敗的單頁。因此實作者需要同時保留「目前頁的 `next_cursor`」和「本輪起始 cursor」，且在完成全輪前不能把中途 cursor 當作 durable checkpoint。[Transactions API — `/transactions/sync`](https://plaid.com/docs/api/products/transactions/#transactionssync)；[Sync migration guide](https://plaid.com/docs/transactions/sync-migration/)；[Transactions errors](https://plaid.com/docs/errors/transactions/)

## 4. Pending → posted

Plaid 將 pending 與 posted 視為兩筆不同 transaction records，而非同一 record 的 boolean transition：

1. pending transaction 先以自己的 `transaction_id` 存在，`pending=true`。
2. 入帳時，pending ID 出現在 `/transactions/sync.removed`；posted transaction 以另一個 `transaction_id` 出現在 `added`，`pending=false`。
3. 若 Plaid 能 matching，posted record 的 `pending_transaction_id` 指向舊 pending ID。removed 與 added 不保證在同一頁，但應在同一個 overall update。

這不是完整保證：某些機構完全不提供 pending；Plaid 也可能無法 matching，讓 `pending_transaction_id=null`。Pending 的名稱、金額等可在 posted 時改變，authorization hold 甚至可能只消失而不產生 posted counterpart；posted transaction 也不絕對 immutable，仍可能因退款或重新分類被 modified／removed。[Transaction states](https://plaid.com/docs/transactions/transactions-data/)；[Transactions API](https://plaid.com/docs/api/products/transactions/)

## 5. Webhook 與同步初始化

- `SYNC_UPDATES_AVAILABLE` 是「有變更可取」通知，不攜帶 transaction patches；收到後仍要用最後 cursor 呼叫 `/transactions/sync`。[Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)
- Webhook 要先配置 endpoint；而且每個 Item 至少呼叫過一次 `/transactions/sync` 後才會開始收到 `SYNC_UPDATES_AVAILABLE`。第一次 sync 若資料尚未 ready，會得到空 arrays 與空 `next_cursor`，但會啟動後續 webhook。[Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)；[Sync migration guide](https://plaid.com/docs/transactions/sync-migration/)
- `initial_update_complete` 表示最近 30 天可用；`historical_update_complete` 表示 requested history（上限 24 個月）可用。它們是 completeness milestones，不是每筆 transaction 的 state。[Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)
- 使用 `/transactions/sync` 時應處理 `SYNC_UPDATES_AVAILABLE`；舊的 `INITIAL_UPDATE`、`HISTORICAL_UPDATE`、`DEFAULT_UPDATE`、`TRANSACTIONS_REMOVED` 仍可能為相容性送達，但不應驅動 sync business logic。[Transactions API — webhooks](https://plaid.com/docs/api/products/transactions/#sync_updates_available)；[Sync migration guide](https://plaid.com/docs/transactions/sync-migration/)
- Plaid 通常每日向機構檢查一到四次，依機構而異；webhook 不等於即時銀行事件。`/transactions/refresh` 是另購的 on-demand extraction，成功後若有 changes 才觸發 webhook。[Transactions API](https://plaid.com/docs/api/products/transactions/)；[Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)

## 6. 不能移植成「台灣爬取資料必然具備」的 Plaid 能力

以下是 source capability 差異，不是 canonical schema 決策：

| Plaid 能力 | Plaid contract | 對台灣爬取資料的事實護欄 |
| --- | --- | --- |
| Stable provider IDs | `item_id`、`account_id`、`transaction_id`、部分 enrichment entity ID | 只有來源明確提供且描述 lifecycle 的 ID 才能依賴；畫面列號、排序位置、描述文字或自行 hash 沒有等同 Plaid ID 的官方穩定性保證 |
| Cross-link account identity | `persistent_account_id` 僅少數 TAN institutions 支援；一般 `account_id` 重連可變 | 不能假設能靠帳號 mask、名稱或單次 scrape ID 跨次／跨來源唯一識別同一帳戶 |
| Incremental patch stream | cursor + `added`／`modified`／`removed`，含完整 pagination retry contract | Snapshot scrape 若未提供 source cursor、tombstone 與 modification event，就沒有等價的 delta semantics；兩次 snapshot diff 是 consumer inference，不是來源事件 |
| Pending-posted linkage | Plaid matching 後提供 `pending_transaction_id` | 若銀行頁面不揭露 stable pending ID 或 matching link，就不能保證 pending 與 posted 一對一；金額＋日期＋描述比對只能是 heuristic |
| Push update notification | Item-scoped `SYNC_UPDATES_AVAILABLE` webhook | 爬取來源除非另有正式 event API，否則只有排程／手動擷取 freshness，不能宣稱 webhook 或 push semantics |
| Merchant／category enrichment | `merchant_name`、PFC、counterparties、entity IDs、logo、location 等由 Plaid enrichment | 原始 statement description 不等於 cleansed merchant；分類、counterparty identity、confidence、logo 與地點不能憑欄位名稱假設存在 |
| Balance freshness | 特定 paid endpoint 可 live fetch；一般 response 可 cached | 每個來源必須各自表達擷取時間與 freshness contract；不能由 balance 數值本身推斷「即時」 |
| Closed／removed detection | closed account 從 API 消失；sync 明示 removed transaction IDs | Snapshot 中缺席可能是頁面範圍、登入權限、抓取錯誤或關閉／刪除，若來源未提供 tombstone 就不能等同 removed event |

## 7. 給後續 canonical-model 討論的事實護欄

以下只界定問題必須容納的事實，不選定表、欄位或命名：

1. **Identity 必須有 scope 與 lifecycle。** 討論任何 account／transaction key 時，要能回答它由哪個 source 發出、在哪個 connection／account 範圍唯一、何時可能換值，以及沒有 provider ID 時怎麼表達不確定性。
2. **觀測值與金融實體不可先驗等同。** Plaid Item、Plaid Account、pending record、posted record 都有不同 lifecycle；爬取的一列也只是一個 source observation，是否代表同一金融實體需另行決策。
3. **缺席、null、unknown 與 not-applicable 不同。** Plaid 已示範欄位可能 nullable、條件性省略、整個 object 存在但子欄位無保證，及來源未提供能力等不同情況；後續詞彙應避免把它們壓成同一語義。
4. **交易變更不只 append。** Plaid contract 包含 added、modified、removed；pending 轉 posted 還可能 remove + add。任何 canonical model 若只描述不可變新增，會無法無損表達此已知 provider 行為。
5. **日期與時間至少有 authorization／occurrence／posting 差異。** `date` 在 pending 與 posted 的語義不同，精確 datetime 又可能缺失或是假預設值；後續不可只靠單一 timestamp 名稱暗示精度與事件種類。
6. **金額 sign 是 source convention。** Plaid Transactions（Income 除外）以流出正、流入負；這不是全球帳務的自然定律。後續必須明確決定是否保留 source sign、轉成方向＋絕對值，或採另一套 convention。
7. **Enrichment 要和 source facts 分層討論。** Merchant cleansing、分類、counterparty matching、confidence、logo、location 可能來自 Plaid，而非金融機構；原始描述與 enrichment 不應在概念上互相覆蓋。
8. **Freshness 與 completeness 是資料批次屬性。** Cursor、更新狀態、webhook milestone、擷取時間描述資料管線進度；它們不等於交易發生日或 balance 的經濟事件時間。
9. **同步 correctness 依賴 source contract。** Plaid 的 cursor、全頁 pagination、mutation restart 與 removed tombstone 組成一套完整保證；不能只借用 `cursor` 或 `sync` 詞彙，就推定 snapshot crawler 有同等一致性。

## 官方來源索引

- [Plaid Accounts API](https://plaid.com/docs/api/accounts/)
- [Plaid Transactions API](https://plaid.com/docs/api/products/transactions/)
- [Plaid Transaction states](https://plaid.com/docs/transactions/transactions-data/)
- [Plaid Transactions Sync migration guide](https://plaid.com/docs/transactions/sync-migration/)
- [Plaid Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)
- [Plaid Transactions errors](https://plaid.com/docs/errors/transactions/)
- [Plaid Items API](https://plaid.com/docs/api/items/)
- [Plaid Preventing duplicate Items](https://plaid.com/docs/link/duplicate-items/)
