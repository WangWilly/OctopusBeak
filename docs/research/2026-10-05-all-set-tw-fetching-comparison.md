# ALL SET TW 與本專案的資料抓取比較

研究日期：2026-10-05。性質：程式碼研究紀錄，並非部署或銀行實測結果。

## 外部專案版本與範圍

研究 [TedLin1993/all-set-tw](https://github.com/TedLin1993/all-set-tw) 的 `main`，固定於 commit `e53b4603657e1e4ebb68deaea65127b4fb74df73`。以淺層 clone、codebase-memory 索引及第一方原始碼／文件查核；未安裝相依套件、未執行同步、未登入銀行。以下連結均固定於此 commit，不能據此保證各銀行目前仍能成功同步。

## ALL SET TW 怎麼抓資料

核心是「每個來源各自實作登入與協定，再統一正規化和入庫」。不是單一通用爬蟲，也不能概括成全部使用 API 或全部操作網頁。共用 catalog 明確區分 API 帳密、API CAPTCHA、裝置 OTP、每次瀏覽器登入、可復用 browser session 等模式，涵蓋電子發票、集保 e 存摺及 13 個銀行連接器。[來源 catalog](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/shared/connector-catalog.ts#L33-L393)

| 代表來源 | 實際機制 | 原始碼證據 |
| --- | --- | --- |
| 電子發票 | 直接 POST App 協定；送出前加密 request，收到後解密／解析 response | [EInvoiceClient.send](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/einvoice/api.ts#L92-L100) |
| 集保 e 存摺 | 直接呼叫 App API；組 appInfo、裝置 ID、token、sequence、SHA256 signature，部分欄位 AES 加密；裝置驗證使用 OTP | [EPassbookClient.post](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/tdcc/epassbook-client.ts#L156-L228)、[OTP 模式](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/shared/connector-catalog.ts#L71-L97) |
| 中國信託 | bootstrap → 帳密登入 Mobile API → 查存款、交易、信用卡與即時授權 → parseCtbcData → finally 登出 | [createCtbcConnector.sync](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/ctbc/mobile-api.ts#L140-L199) |
| 永豐 | Puppeteer 操作登入頁並處理 CAPTCHA；取得 cookies 後改用 SinopacAppClient 直接查行動銀行 JSON API，而不是全程點頁面抓表格 | [登入](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/sinopac/connector.ts#L429-L484)、[cookies → API 查詢](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/sinopac/connector.ts#L99-L193) |
| 玉山／國泰 | 保留來源專用瀏覽器操作和頁面解析。玉山也可在登入頁面 context 內 fetch portal API；國泰 catalog 明定 browser_per_sync | [玉山 page fetch](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/esun/portal.ts#L499-L575)、[模式 catalog](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/shared/connector-catalog.ts#L98-L143) |

這些是來源網站／App 的內部協定整合；從 inspected code 可確認其自行組登入、簽名與加密 request，並非統一第三方 Open Banking aggregator。此為程式碼層次的判斷，不代表對各銀行 API 授權政策的判斷。[協定／adapter 邊界](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/docs/004-connector-development.md#L70-L92)

## 執行、排程與驗證

後端部署在 Cloudflare Workers；資料存 D1，需要瀏覽器時用 Browser binding + Puppeteer，驗證碼圖片交 Workers AI。`wrangler.toml` 每 10 分鐘 Cron 啟動，Queue 的 batch size 和 concurrency 都是 1。Cron 是喚醒 scheduler，不表示每家银行每 10 分鐘同步；D1 sync job 決定哪些工作到期，執行後延遲 20 秒串下一個工作。[部署 bindings](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/wrangler.toml#L1-L37)、[Queue controller](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/features/sync/scheduling/queue.ts#L15-L100)

Queue payload 是工作種類以及 durable run ID，沒有直接攜帶銀行帳密；Worker 仍必須從雲端 D1 讀取加密設定／認證來登入外部服務。敏感設定以 AES-GCM 加密（12-byte random IV），cookies、tokens、device state 跟一般同步 cursor 分開保存。[enqueue payload](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/features/sync/scheduling/queue.ts#L37-L61)、[TDCC run state](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/tdcc/run-repository.ts#L44-L70)、[設定加密](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/platform/crypto.ts#L25-L40)、[狀態分級規範](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/docs/004-connector-development.md#L39-L67)

CAPTCHA 辨識不是銀行回傳資料的 AI 解析：OCR service 把驗證碼圖送到 `@cf/google/gemma-4-26b-a4b-it`，要求固定字數及格式。AI 暫時錯誤最多 2 次、間隔 500 ms。永豐另有登入嘗試迴圈，帳密被拒立即停止；失敗要求人工處理。其他銀行各自限制 OTP、異地登入與接管行為，因此不應宣稱完全無人值守。[OCR service](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/features/ocr/service.ts#L6-L139)、[永豐登入分類](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/sinopac/connector.ts#L429-L484)、[各銀行特殊規則](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/docs/004-connector-development.md)

重試分層處理：Browser 建立僅針對 acquisition endpoint 的 HTTP 503，等待 2 秒、5 秒後重試，最多 3 次，既有 session/CDP 操作不在此重試；電子發票與集保 chunk Queue 最多 3 次，暫時失敗延遲公式為 `min(15 * 2^(attempts-1), 300)` 秒，需要人工處理則結案。一般銀行 job 失敗記錄狀態並推進到下次排程，與 durable chunk retry 不同。[Browser retry](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/browser.ts#L3-L98)、[chunk retry](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/features/sync/scheduling/queue.ts#L134-L236)、[bank job fail](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/db/sync-jobs.ts#L266-L296)

## 抓取後如何保存

來源 parse 為銀行帳戶、餘額快照、交易、帳單、投資持倉／交易、發票／品項等金融 entity。銀行明細回溯固定最近 3 個月或 3 期帳單、電子發票最近 2 期；並非所有銀行的全部歷史資料。[回溯 policy](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/sources/sync-window.ts)、[規範](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/docs/004-connector-development.md#L52-L63)

先寫 staging，再以 D1 batch promotion 更新正式表、cursor 和 cleanup；`settingsGuard` 比對 encrypted_config，防止同步期間改帳密後舊結果覆蓋新設定。帳戶用 `(connector_id, source_id)` upsert；餘額快照與銀行交易都用 `(connector_id, account_id, source_id)`；帳單依帳戶 + billing_period，投資持倉加 as_of_date。這是明確的來源 ID 去重／歷史模型，不是每次把整張表覆蓋掉。[entity conflict keys](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/features/sync/persistence.ts#L54-L332)、[promotion 原子邊界](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/features/sync/persistence.ts#L384-L504)

共用 mapper 依 connector/account/sourceId 產生 stable ID，保存 amount、currency、posted/authorized date、status 和 raw_payload；snapshot 另存 as_of_at。mapper 的缺省 currency 為 TWD、缺省 status 為 posted，不能假設和本專案嚴格資料 admission 規則相同。[交易 mapper](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/apps/worker/src/features/sync/record-mapper.ts#L103-L172)

電子發票與集保另用 durable run/item 表保存分段工作，不要求單次 Worker invocation 抓完全部資料；電子發票每段最多 35 張品項明細，集保每段最多一個分頁 item，全部取得後才 promotion。[現行同步設計](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/docs/002-backend-architecture.md#L632-L662)

## 本資料夾的正式抓取流程

本地研究基準為 commit `303676325a1717d02dcfbec34c4e15f4d22594a9`。比較的是目前 Octopus Beak 桌面 App 的 production runtime，而非早期下載 CSV 的開發腳本；以下本地連結以此版本的檔案為證據。

App 以 typed WorkflowDefinition 執行供應商流程，注入 browser、text、event、signal 與 financialCommit ports；供應商流程不自行打開金融資料庫。正式 catalog 共 13 個任務，其中 11 個使用 App 管理的 headless Chromium／Playwright worker，MaiCoin 與匯率為非瀏覽器流程。[executor](../../src/lib/automation/workflow-executor.ts#L114)、[runtime contract](../specs/app-owned-workflow-runtime.md)、[ADR 0032](../adr/0032-app-owned-workflow-runtime.md)

本地同樣是混合抓取：

- 國泰在登入後取得 JWT，再於 page context 發 POST；同時以 waitForResponse 核對 hostname、path、method、request body 和 response status，取得原始 bytes 嚴格解碼。[fetchCathayApiSourceText](../../src/workflows/cathay-statements.ts#L1896)
- LINE Bank 在 page context 發 fetch，帶登入 cookies，取得 response bytes，再交 text port 解碼與完整性檢查。[apiResponse](../../src/workflows/linebank-statements.ts#L1121)
- 華南攔截 POST 匯出，使用 route.fetch 取得 attachment response，核對 HTTP status、content type、charset、大小與內容；Big5／CP950 匯出在記憶體解析，上限 64 MiB，不先把 XLS 寫入 downloads。[handleRoute](../../src/workflows/hncb-statements.ts#L997)
- MaiCoin 直接用 MAX API，帶 nonce、access key、payload 與 signature，有取消與 bounded fetch retry，無須瀏覽器。[privateGetResponse](../../src/ledger/sync-maicoin.ts#L126)、[workflow](../../src/lib/automation/maicoin-workflow.ts#L55)

資料經 provider adapter 建立 Source Capture，再由 Canonical Financial Commit 提交至單一 worker 擁有的 PGlite。已提交項目保留 receipt；receipt 異常或不確定結果不自動重播。不是「整次同步全部成功才有資料」：獨立完整項目／產品可先提交，之後失敗仍回報既有提交。[commit execution](../../src/ledger/pglite/workflow-run.ts#L153)、[產品結果與原子範圍](../specs/app-owned-workflow-runtime.md#statement-selection-and-per-product-outcomes)、[PGlite ownership](../adr/0030-pglite-owned-live-financial-views.md)

## 兩個專案的差異

| 面向 | ALL SET TW | 本資料夾的 Octopus Beak |
| --- | --- | --- |
| 取得資料 | 各來源獨立協定；多個來源直接呼叫 App／網銀 API，必要時使用 Puppeteer | 銀行／發票以 Playwright Chromium 工作流程為入口；其中也用登入後 API、response interception 和 DOM；MaiCoin／匯率直接 HTTP |
| 執行位置 | 自架 Cloudflare Worker，必要時用遠端 Browser Run | 本機 Electron App 管理 headless Chromium 與 supervised worker |
| 認證與 session | 雲端保存加密設定與分級 cookies/token/device state | 登入資料在裝置；browser cookies 以 Electron safeStorage 加密，每次使用暫時 profile；不保留 localStorage |
| CAPTCHA | Workers AI 雲端模型，來源各自處理登入與 OTP | App 注入本機 OCR／語音 solver；有固定十輪、只對明確 CAPTCHA retry trigger 重試的 campaign；國泰另有本機 Gmail OAuth OTP |
| 排程／併發 | Cron 每 10 分鐘找到期 job，Queue concurrency 1 | App 開啟時排程；目前 scheduled task 為匯率；manual／Sync all／scheduled 共用 FIFO，最多 3 個 execution |
| 中斷恢復 | 發票／集保有 durable run/item 分段工作和 chunk retry | 中斷 run 記為 interrupted，新 run 從 collection 開始；不重連舊 browser |
| 正規化與去重 | source ID upsert，餘額快照、staging promotion、cursor 與設定 CAS | Source Capture + 經註冊的 source contract／rule tuple；共同 admission 處理 identity、occurrence、revision、幣別與有效時間 |
| 原始資料 | 共用 transaction mapper 保留 raw_payload | 正式流程不保留原始匯出檔、CSV/JSON、raw response body 或 Libretto telemetry 檔；持久化已驗證財務資料與必要 evidence／sanitized outcome |

本地 runtime／認證／solver／排程比較的依據：[正式合約](../specs/app-owned-workflow-runtime.md#source-files-and-failure-rules)、[queue](../../src/lib/automation/server/workflow-run-queue.ts#L1)、[scheduler](../../electron/exchange-rate-scheduler.ts#L80)、[browser host](../../src/lib/automation/server/app-browser-host.ts#L372)。Source Contract／幣別與時間規則依據：[ADR 0035](../adr/0035-source-contract-catalog-and-rule-admission.md)、[money/currency/time](../adr/0006-canonical-transaction-money-currency-and-time.md)、[strict admission](../adr/0008-source-scoped-lineage-and-strict-canonical-admission.md)。外部比較依據見前述 pinned source links。

最具體的 admission 差異是 ALL SET 共用 mapper 可把缺少 currency/status 的交易設為 TWD/posted；本地要求來源契約成立並有足夠證據，缺乏必要識別、幣別、日期或完整性資訊時拒絕該 capture。這是邊界政策差異，不表示外部每個 adapter 都缺乏驗證，也不表示本地沒有依已審查 source contract 使用常數。

## 可借鏡的方向與成本

1. 可借鏡永豐的「登入 adapter → session → 獨立 API client」分工，降低登入頁面變動與資料查詢之間的耦合。本地國泰／LINE 已採登入後 API，因此應先找仍需多次導頁的 provider，而非全面重寫 browser runtime。
2. 集保是值得調查的新增來源，可由一個來源覆蓋持倉與部分交割帳戶；不能據此假設它覆蓋各銀行全部產品或歷史。實作時仍須本地 Source Connection、Financial Account 與來源完整性契約。
3. 若未來資料量超過單次 worker 能承受的範圍，可借鏡 durable chunk／cursor。它會改變本地的中斷恢復與 admission 邊界，需明確設計；不是直接接上 Queue 就完成。
4. 直接 App API 可能減少瀏覽器操作，但也要維護 signature、encryption、device registration、OTP 和回應格式。這是從程式碼推導的取捨，未量測速度、資源消耗或成功率，沒有證據支持「一定更快／更穩」。

## 研究限制

證據可支持架構、protocol 和程式碼行為；未驗證真實帳號、各銀行阻擋 Cloudflare 出口 IP 的程度、免費額度能否涵蓋實際使用量，或所有 connector 的回應完整性。專案本身也指出網頁／App API 改版、OTP、裝置驗證與資料更新時間都會影響同步。[README 限制](https://github.com/TedLin1993/all-set-tw/blob/e53b4603657e1e4ebb68deaea65127b4fb74df73/README.md)
