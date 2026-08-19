# LINE Bank 公開交易明細契約證據

## 研究問題與範圍

本文件回答：在無法找到先前建議的頁面元件時，LINE Bank 的官方公開資料是否足以擴大帳戶交易明細的查找範圍，以及 Issue #132 應如何處理目前的來源契約不確定性。

研究只使用 LINE Bank 官方頁面／公開路由、本 repository source，以及一筆使用者已授權、已遮罩的第一方回應結構觀察。帳號、交易內容、cookies、credentials、network raw body 與 CAPTCHA 均不寫入本文件。證據分為：

- **已證實**：官方公開文字或 repo source 直接呈現的事實。
- **合理推論**：由已證實資料推導，但不是 LINE Bank 公開承諾。
- **未解決**：目前不能安全寫入 workflow contract 的項目。

## 已證實

### 1. 官方公開資料：有交易期間控制，但沒有公開最大範圍

LINE Bank 官方教學說明，登入 App 的「主帳戶」後，交易查詢區預設顯示「30天」，可選「交易類型」、「交易期間」及「顯示餘額」，再套用篩選。這證明交易期間是使用者可調整的控制項；「30天」是官方示例／預設選項，並不是官方公布的最長可查期間。官方頁面沒有在這段說明中給出可選日期的上限、最早可追溯日期或 API range limit。([LINE Bank App 可以查詢各項歷史交易紀錄](https://corp.linebank.com.tw/blog/0417a9c9-ce2c-4319-8290-cc6d1340a5c7))

LINE Bank 友善網路銀行的公開網站導覽把「帳戶交易明細查詢」列為功能，但頁面也說明該站需要 JavaScript；未登入的公開 HTML 只呈現導覽與登入入口，沒有交易查詢 API schema、日期驗證規則或方向碼對照。([LINE Bank 友善網路銀行網站導覽](https://accessibility.linebank.com.tw/sitemap), [LINE Bank 登入頁](https://accessibility.linebank.com.tw/login))

官方友善金融公告確認網路銀行提供「查詢帳戶交易明細」，但未補充歷史期間、欄位語義、交易方向 enum 或分頁保證。([2025 LINE Bank 金融服務友善措施](https://accessibility.linebank.com.tw/notice/1187450))

官方產品資料足以建立一個**有界的幣別／產品 scope**，但不是任意帳戶的預設值：LINE Bank 官方頁面把「LINE Bank 臺幣活期儲蓄存款『主帳戶』」並列為產品條件；個人存款牌告頁則將「臺幣活期性存款」下的「活期儲蓄存款」獨立列示；產品總覽另將「主帳戶」與「外幣存款帳戶」分開列為不同產品群。([LINE Bank 聯名信用卡官方說明](https://event.linebank.com.tw/marketing/cobrandcards/), [個人臺幣存款利率](https://www.linebank.com.tw/board-rate/deposit-rate), [LINE Bank 產品總覽](https://www.linebank.com.tw/products))

這些第一方文字支持 `domestic-main-account-demand-savings` → `TWD` 的**公開產品描述**，不支持把任何回應中的 `pdCd`、`pdNm`、`currCd` 或未知帳戶自動歸入該 scope。因公開頁面沒有提供可安全依賴的 provider product code 與 transaction endpoint 的一一映射，`preflight-v4` 只接受由 source adapter 明確提供的 versioned scope descriptor：route `/transaction`、account role `main-account`、product descriptor `domestic-main-account-demand-savings`、currency `TWD` 及 evidence version `domestic-main-twd-v1`，且每頁都必須有與 request account composite 相符的 staged source envelope。外幣、缺漏或不一致的 product／route／role evidence 只能回傳不支援，不得靜默產生 TWD。

### 2. Repo 已有的 LINE Bank source contract

`src/workflows/linebank-statements.ts:7-10` 定義友善網路銀行登入／交易路由，以及帳戶清單 endpoint `/v1/account/common/payables?featureTypeCode=01` 與交易 endpoint `/v1/account/history/transactions`。

`LineBankAccount`（`src/workflows/linebank-statements.ts:70-87`）保存 `acctNbr`、`arrId`、帳戶名稱候選與幣別候選；`LineBankTransactionRow`（`src/workflows/linebank-statements.ts:98-121`）另保存來源交易函式／案件碼、目前存款序號、counterparty line UID、可能的 transaction/linkage ID（nullable）、取消旗標，以及 numeric epoch-millisecond `txDtm`。`LineBankTransactionSourceEnvelope`（同檔案）保存 account identity、product／role、status、balance 與 account epoch 候選欄位。這些是 repo 對回應形狀的接受型別，不是 LINE Bank 公開 API 文件。

`LineBankApiClient.fetchTransactions`（`src/workflows/linebank-statements.ts:420-453`）送出的請求包含：

- account candidates：`acctNbr`、`arrId`；
- date fields：`inqrStrtDt`、`inqrEndDt`；
- filter/detail fields：空字串 `dpstWdrwDsCd`、`sortTpCd: 2`、`txDtlDsCd: "01"`；
- paging fields：`pageNbr`、`pageCnt: 1000`、`totCnt: 1000`。

目前 staged response contract 宣告 `content` 的 account／product／role／status envelope、`pageNbr`、`pageCnt`、`totTxCnt`、`txCnt` 與 `txLst`；每個 row 也保留先前未保存的來源欄位及 nullable linkage candidates。`linebankTransactionPageFromResponse` 只做型別／頁面形狀保存，沒有把欄位名稱升格為 canonical semantics；本文件不保存任何實際值。

### 3. 目前 workflow 的日期、方向與分頁處理

`resolveDateRange`（`src/workflows/linebank-statements.ts:193-202`）在未給 `startDate` 時預設從 `endDate` 往前 12 個月加一天；`linebankQueryWindows`（`src/workflows/linebank-statements.ts:204-221`）將較長查詢切成每段最多約 12 個月。這是 workflow 的防護／實作假設，不是官方公開的 LINE Bank 上限證據。

`amountColumns`（`src/workflows/linebank-statements.ts`）現在依 `historical-v7` 的 observed-versioned mapping 將 code `1` 投影為 inflow、code `2` 投影為 outflow，兩者都要求 absolute non-negative amount；未知／缺漏方向與 signed-negative conflict 一律拒絕。這是 evidence-gated projection，不是 provider-guaranteed canonical direction semantics。

`linebankApiRowsToStatementRows`（`src/workflows/linebank-statements.ts:315-337`）仍把同一個 `txDt` 同時寫成「帳務日期」與「交易日期」，把 `txTm` 格式化成 `HH:mm:ss`，以 `txDt + txTm + txSeqNbr` 排序；numeric `txDtm` 只保留在 typed staged page，未寫入 legacy CSV，也沒有被宣稱為 posting/effective-time。

分頁迴圈（`src/workflows/linebank-statements.ts`）依 `totTxCnt` 持續增加 `pageNbr`，並核對 `pageCnt`／`txCnt`、跨頁 count drift、每頁 source account identity 是否精確等於 request account、numeric `txDtm`／amount／balance 形狀及「已收 rows == totTxCnt」；每頁保留 source envelope 與 response code。這些是 transport/preflight checks，不是 provider 對 completeness 或 authority 的承諾。

### 4. 最新已遮罩第一方觀察（只保留 aggregate／shape）

本次 bundle 只記錄第一方 route 與結構，不保留 raw response、body hash、帳號值或交易值。可重現的 route metadata 為：

- UI：`https://accessibility.linebank.com.tw/transaction`
- account list：`/v1/account/common/payables?featureTypeCode=01`
- transaction history：`/v1/account/history/transactions`

已授權的最新交易 response 是一筆 HTTP 200、JSON、第一頁；`pageNbr`、`pageCnt`、`totTxCnt`、`txCnt` 與列數均保留在 typed page，來源 row 為 numeric `txDtm`，且 `acctNbr`／`arrId`、product／role／status envelope 與 nullable linkage candidates 皆保留。所有真實值只存在於受控的本地觀察，不進入 fixture、研究文件、CSV 或 diagnostics。

UI 同頁觀察到 `dpstWdrwDsCd="1"` 與「存入」的單筆 correlation；historical-v7 另有 code `2` 的單筆 response row 與 exact negative balance transition，但沒有 code `2` 對 UI「提出」的直接 correlation。`fxsTxId`／`rltvTxArrId` 在該樣本為 nullable，不能作為已證實 transaction ID 或 reversal link。交易 response 本身沒有已證實的 currency、posting、effective、revision、authority 欄位語義；上段官方產品資料只證明明確的 domestic main-account scope，不能把 live response 的未知 product 欄位轉成 TWD。`txDtm` 與 Asia/Taipei epoch-millisecond 轉換相容，但這些 observations 仍不能建立 provider-guaranteed canonical contract。

本次 evidence fixture／preflight contract 已版本化為 `linebank/domestic-deposit/preflight-v4`，並加入 `cross-window-v3` 的完全 synthetic cross-window fixture。該 fixture 表示：長窗口兩列共享 `txSeqNbr`、短窗口恰有一列與長窗口 full-row／non-content candidate tuple 各重疊一列；`txSeqNbr + crrnDpstNthCnt`、`txSeqNbr + txDtm` 與 provider-looking tuple 在此樣本內暫時唯一，但仍標示為 observed-not-provider-guaranteed。候選明確排除 amount、description、balance、content hash 與 row order；nullable linkage 不被當作身份證據。未保留 static bundle hash；因公開 assets 未提供可安全引用的固定 hash，不能以本地 raw sidecar 的 digest 代替第一方公開證據。route、typed fixture version、domestic-main-twd-v1 scope descriptor 與 source field inventory 是目前可審計的證據界面。

既有 sidecar 另保留一組 `repeat-v5` aggregate-only 比對：前一筆 semantics capture 與後一筆 repeat capture 都是 transaction-history endpoint 的單一 HTTP 200 POST；request shape、account composite 與 query window 相同，兩次均為第一頁、相同 page/count aggregate 與單列結果。full-row equality overlap 為 1，provider-looking candidate tuple overlap 為 1；`txSeqNbr`、`crrnDpstNthCnt`、nullable linkage candidates、`txCaseCd`、`bizTxFuncTpCd`、`txDtm` 均在此 repeat 中穩定，方向觀察仍只有 code `1`、取消旗標仍為 `N`，`txDtm` 兩次均為 numeric presence。未觀察到 request、account、window、response-envelope、aggregate 或 candidate drift。這是重複樣本的經驗穩定性，不是 provider-backed identity、revision、posting/effective 或 authority 證明；因此 identity and all other semantic blockers remain.

另加入完全 aggregate-only 的 `clean-headed-v6` evidence record：從無 open session 的 fresh headed start，由人完成 login／CAPTCHA，通過 authenticated root → transaction route；只匹配一個主帳戶，alert gate 為 no-visible-dialog，transaction-history POST 恰一筆且 HTTP 200，回應是一頁一列（page/count invariants preserved），direction set 只有 `1`、取消旗標只有 `N`，`txSeqNbr` 在該 sample 出現且唯一，`txDt`／`txTm` 是 string、`txDtm`／amount 是 number，automation progress 為 25 → 100，最後 session 已關閉。此 record 不含任何帳號、交易、日期或 timestamp 值；它只把 manual-auth-navigation live validation 標成 `complete`。它不能獨立授權 canonical admission：provider-backed identity、完整 direction、posting／effective-time、cancellation lifecycle、completeness、authority、writer 與 query completeness blockers 全部保留；source manifest 仍是 `partial`／`preflight-only`。

歷史範圍另形成 `historical-v7` aggregate-only evidence：共 5 列，direction code `1` 有 4 列、code `2` 有 1 列；所有 amount 都是 non-negative numeric，按 `txDtm` 排序的相鄰餘額轉移有 3 次 code `1` 的 exact `+amount` 與 1 次 code `2` 的 exact `-amount`，沒有 inconsistent 或 indeterminate transition。兩組 classification set 互斥，但沒有 code `2` 對 UI「提出」的直接 correlation；取消旗標仍只觀察到 `N`。因此 source projection contract 現在把 code `1` 觀察式映射為 inflow、code `2` 觀察式映射為 outflow，兩者都要求 absolute non-negative amount，unknown／missing code 與 signed-negative conflict 在 export／admission 前拒絕。這是 `observed-versioned`、非 provider-guaranteed 的方向證據；只移除 `direction-mapping-incomplete`，`direction-semantics-unproven`、identity、posting、effective-time、cancellation、completeness、authority 與 writer/readiness blockers 仍保留。

同一 historical capture 的來源時間另版本化為 `observed-time-v1`：5/5 列的 `txDtm` 都是 safe-integer epoch milliseconds，且精確等於 `txDt + txTm` 以 Asia/Taipei 固定 UTC+8 重建的結果；seconds、UTC offset、mismatch、ambiguity 與 same-time collision 都是 0，排序 chronology 為 descending。workflow 與 preflight 對缺漏／非法 calendar date／clock time、非 safe integer、seconds-like unit、offset mismatch 或重建不一致的 row/page 整體拒絕。這只證明 source timestamp reconstruction，不把 `txDtm` 稱為 posting、accounting 或 effective event time；`effective-time-semantics-unproven` 與其他 canonical blockers 保留。

完成一次新的 historical revalidation 後，另加入完全 aggregate-only 的 `historical-revalidation-v9` record：fresh headed start 時沒有 open session，由人完成 login／CAPTCHA，authenticated root → transaction route，只匹配一個主帳戶；transaction-history POST 恰一筆且 HTTP 200，第一頁 `pageNbr=1`、`pageCnt=1000`，`totTxCnt=5` 與 `txCnt=5`，共 5 列。direction code `1` 有 4 列、code `2` 有 1 列，全部通過目前 observed-versioned projection；取消旗標仍只有 `N`。`txSeqNbr` 有 3 個 distinct 值，但 `txSeqNbr + crrnDpstNthCnt` 與 `txSeqNbr + txDtm` 各 5 個 distinct；amount 全為 non-negative numeric。5/5 `txDtm` 精確符合 Asia/Taipei UTC+8 reconstruction，UTC／seconds／mismatch／ambiguity／same-time collision 都是 0，chronology 為 descending；automation progress 為 25 → 100、command exit 0、session 已關閉。這只把 transport 與 observed direction validation 標成 live-complete；canonical admission 仍為 blocked、readiness 仍為 preflight-only，identity provider guarantee、posting/effective-time、cancellation lifecycle、completeness、authority、writer 與 query completeness blockers 全部保留。

在 v9 之上加入 `occurrence-v1` empirical source-occurrence matching seam：opaque tuple digest 僅組合 source namespace／connection／domestic-deposit stream、contract version、source account identity epoch、`acctNbr + arrId` composite、`txDtm`、`txSeqNbr` 與 `crrnDpstNthCnt`；不把 amount、balance、description、row order、business classification 或 nullable linkage 當成 identity。缺漏／非法欄位、同 capture 完整 tuple 重複、同 base tuple 卻有不同 `txDtm` 都以 atomic rejection/quarantine 處理。相同 tuple 與相同非 identity source values 的 repeat 只記為 stable observation；同 tuple 若 financial/source change 則是 conflict，禁止 overwrite/revision。account、identity epoch 與 contract version 會隔離 digest；window absence 沒有 comparable completeness 時不產生 withdrawal decision。這個規則明確 `providerGuaranteed: false`，只提供 preflight/comparison seam，不增加 writer 或 readiness。

Workflow 的登入邊界也已明確化：`startUrl` 是官方登入頁；`librettoAuthenticate` 在 `/login` 一律視為未登入，非 login root page 以任一可見「帳戶交易明細查詢」連結判定，`/transaction` 則以任一可見 `#account-dropdown` 判定。未登入時只等待人完成登入／CAPTCHA（明確最長兩分鐘），不讀取或填寫 credential；完成後才透過可見連結（或同源 `/transaction` fallback）進入交易 stage，並等待 `#account-dropdown`。已登入或已在交易頁的 path 不重登入、不重導覽。這是互動式 authentication handoff contract，不代表 live query 已在本工作包重送。

使用者已明確批准一個窄化的 alert handoff：登入後若沒有可見 `[role="alertdialog"]` 即繼續；若恰有一個，且其中恰有一個 accessible name 為 `確定`、`關閉` 或 `知道了` 的 button，workflow 才會正常 click 該非表單 dismissal button，等待 dialog 隱藏／detached 並重新驗證沒有可見 dialog。它不讀取 body、勾選條款、點擊 link、force click 或處理未知／多重 dialog／button；任何歧義或持續存在都在交易連結／帳戶／history request 前失敗。隱藏 dialog 不阻擋流程。

這裡的 manual-auth 是經使用者批准的例外：`librettoAuthenticate` 仍是正式 auth boundary，credentials declaration 僅為 workflow metadata／runtime compatibility 保留；實作刻意不讀取、填寫、提交或記錄 credential，因 LINE Bank login 與 CAPTCHA 必須由人完成，automation 只在可見 authenticated state 之後開始。repo dependency 固定升至 Libretto `0.6.45`，原因是 workflow 需要 `startUrl` 與 `run --cdp` 的 runtime contract；setup-synced skill 變更不屬於本 feature scope。

## 合理推論

1. 官方「30天」控制項與可選「交易期間」表示 UI 至少支援期間選擇；因此 12 個月切窗並非由官方文字直接證實的最大範圍。可是，沒有公開上限時，不能把它推進為任意多年查詢或移除切窗。
2. workflow 送 `dpstWdrwDsCd: ""` 很可能意圖代表不限制方向，與官方 UI 的「交易類型」控制相容；historical-v7 讓 code `1`／`2` 可以作 observed-versioned inflow/outflow projection，但沒有官方 enum 文件或 code `2` 的直接 UI correlation，不能把它們宣稱為 provider-guaranteed canonical income/expense。
3. `acctNbr + arrId` 是目前 account request identity candidate；`occurrence-v1` 將 account epoch、`txDtm`、`txSeqNbr` 與 `crrnDpstNthCnt` 組成 opaque empirical source-occurrence key，但它是否為 provider-backed stable identity、revision link 或 authority contract，仍未由公開資料證實。
4. source 同時提供 `txDt`／`txTm` 與 numeric `txDtm`；把 `txDt` 複製到兩個日期欄位仍只是目前輸出格式的 projection，不能宣稱帳務日與交易日相同，也不能宣稱 `txTm` 或 `txDtm` 是 posting/effective time。

## 未解決契約矩陣

| 契約項目 | 公開資料能證明什麼 | 仍不能安全宣稱什麼 |
|---|---|---|
| 可查歷史範圍 | 官方教學有「30天」預設／查詢期間控制 | 最長期間、最早日期、是否可跨多年 |
| 查詢／篩選控制 | 交易類型、交易期間、顯示餘額；repo request 另有 detail/sort 欄位 | 每個 request 欄位的 enum、空值語義、UI 與 API 的一一對應 |
| 方向碼 | `historical-v7`：code `1` 4 列、code `2` 1 列；餘額轉移分別符合 `+amount`／`-amount`，code `1` 另有 UI「存入」correlation | provider-guaranteed 的 code `1`／`2` 完整存入／支出含義、其他 code、取消交易的方向 |
| 帳戶／交易 identifier | `acctNbr`、`arrId`、`txSeqNbr`、`crrnDpstNthCnt`、`txDtm` 出現在 source contract；`occurrence-v1` 只產生 opaque empirical tuple | provider-backed stable uniqueness、masking、帳戶重建或交易修正時是否不變、revision／authority link |
| `txDt`／`txTm`／`txDtm` | `observed-time-v1`：5/5 exact Asia/Taipei UTC+8 epoch-ms reconstruction，0 mismatch／ambiguity | `txDt` 是帳務日或交易日、provider 的 `txDtm` 是否代表 posting／accounting／effective event |
| 取消旗標 | 已遮罩 response 與 typed row 保存 `cncdTxYn`／`cnclTxYn` | 值域的完整保證、取消是否會產生反向 row、如何與原交易關聯 |
| 幣別／產品 scope | 官方產品文字把臺幣活期儲蓄存款「主帳戶」與外幣存款帳戶分開；preflight-v4 有明確 domestic-main-twd-v1 descriptor | live response 的 product code／currency 欄位與官方產品描述的映射、外幣產品的完整 enum；未知或不一致 scope 不得產生 TWD |
| 分頁／完整性 | response observation 有 page/total count；repo 會保存並核對 `pageCnt`／`txCnt`／`totTxCnt` | `pageCnt` 的精確語義、總數在跨頁期間是否固定、是否可能 truncation 或代表完整 snapshot |
| 公開 assets／validation | 公開 route 要求 JavaScript，未登入 HTML 沒有 API schema | 從公開資產直接取得可依賴的 range limit、enum 或 validation contract |

## 對 Issue #132 的 actionable implications

- 不應因官方「30天」預設就把來源限制為 30 天；同樣也不應因官方提到可選期間，就把 workflow 改成無切窗多年查詢。
- 在 live evidence 尚未證明更大合法範圍前，保留 `linebankQueryWindows` 的 12 個月切窗。它是目前可解釋、可回退的安全假設；報告與 workflow 都不應把 12 個月寫成銀行保證。
- 方向 mapping 現為 `observed-versioned`：legacy projection 接受 code `1`／`2` 的 absolute non-negative amount，未知／缺漏方向與 sign-conflict 直接拒絕；`direction-semantics-unproven` 仍保留，因 code `2` 沒有直接 UI correlation，且 provider guarantee 尚未建立。
- workflow 在每頁 staged response 上要求 source envelope 的 `acctNbr + arrId` 精確等於 request account；缺漏或 mismatch 在 rows/export 前拒絕。這是 transport identity guard，不是 transaction occurrence identity 或 canonical readiness 證明。
- TWD JSON numeric amount/balance 只接受可安全、精確表示的整數；證據未支持的 numeric float、非有限值與 unsafe integer 在 staged/page 或 CSV projection 前拒絕。字串 decimal 仍以 exact lexeme 保存，但不因此建立銀行語義。
- typed staged page 保存取消旗標、nullable linkage candidates、來源 envelope 與 numeric `txDtm`，並在 transport/preflight 以 observed-time-v1 嚴格核對 `txDt`／`txTm`；legacy CSV projection 仍不輸出 `txDtm`，也不把它當成 posting/effective time。在沒有欄位和值域證據前，不應以欄位名稱猜測或把 `txDt` 複製結果當成 source fact。
- 對已證實的 domestic main-account scope，preflight 可保留 `currency: TWD` 的**證據描述**；這不是 writer readiness，也不替代 identity、direction-total、posting、effective-time、cancellation、completeness 或 authority blockers。沒有完整 scope descriptor 或 source envelope 不一致時，currency evidence 維持 unsupported。
- 分頁 acceptance 應要求一次 live 查詢取得 `totTxCnt`、每頁 row count、最後 page，以及至少一個多頁或空頁邊界；只有一頁結果不足以證明 completeness。

## UI 元件不存在時的安全下一步

官方公開網站導覽已確認功能名稱是「帳戶交易明細查詢」，而不是特定 frontend component 名稱。可在使用者完成登入／CAPTCHA 後，直接開啟官方交易路由 `https://accessibility.linebank.com.tw/transaction`，以頁面可見文字或 accessibility tree 尋找「帳戶交易明細查詢」、帳戶、日期／交易期間與交易類型控制；不要依賴 component 名稱或猜測 selector。官方網站也提供鍵盤導覽規則，可先用網站導覽與 Tab／方向鍵操作。([LINE Bank 友善網路銀行網站導覽](https://accessibility.linebank.com.tw/sitemap))

若仍找不到控制項，最安全的 discovery 是請使用者在官方頁面完成一次正常查詢，然後只記錄不含輸入值的 action metadata／可見欄位名稱，針對日期上下限、全部方向、多頁結果與取消 row 做最小化驗證。不要直接呼叫未公開 endpoint、重播 request、讀取 network body 或繞過 CAPTCHA；在證據不足時應保留 12 個月切窗並標記 unresolved，而不是擴大宣稱的支援範圍。

若要重跑互動式 validation，使用者必須在 headed browser 中手動完成 login／CAPTCHA；以下是目前的去識別命令模板，將 placeholder 換成明確且不超過 12 個月的查詢範圍後再執行，且每次只允許一次 read-only history query：

```sh
npx libretto run src/workflows/linebank-statements.ts --session issue132-linebank-clean-validation-4 --stay-open-on-success --params '{"startDate":"<YYYYMMDD>","endDate":"<YYYYMMDD>","accountFilters":["<main-account-filter>"],"currencyFilters":["TWD"]}'
```

## 結論

公開資訊能把「可查期間」從固定 30 天的誤解，擴大為「UI 支援可調整交易期間」，並在官方產品 scope 上支持「臺幣活期儲蓄存款主帳戶」這個明確 descriptor。最新遮罩 response、cross-window-v3 synthetic fixture、observed-time-v1、historical-revalidation-v9 與 occurrence-v1 seam 已補足 typed source envelope、來源時間重建、方向／分頁／聚合驗證、跨範圍 aggregate evidence 與 privacy-safe empirical occurrence comparison；這些 observations 仍不能把 opaque tuple 宣稱為 provider-backed identity，也不能證明 revision、取消 lifecycle、posting/effective semantics、authority 或分頁完整性。Issue #132 目前應**保留 12 個月切窗**；只有明確的 domestic-main-twd-v1 scope 可以去除 currency scope blocker，canonical readiness 仍維持 preflight-only/blocked。
