# 國際新聞與市場證據來源研究

研究日期：2026-08-01

對應決策票：[研究國際新聞與市場證據來源](https://github.com/WangWilly/OctopusBeak/issues/53)

## 結論

第一版應採「公開事件發現層 + 官方事實層 + 可選授權行情層」，而不是找一個供應商包辦所有證據：

1. 以 **GDELT 2.0** 做跨語言全球事件發現與候選來源清單，但絕不把 GDELT 的事件分類、情緒或新聞篇數直接當成已證實事實。
2. 以 **發布該事實的主管機關、央行、統計機關、交易所、監管申報系統、制裁機關及公司投資人關係公告**作為確認層；國際事件至少要回到一個官方來源，重大或有爭議事件再加一個獨立來源。
3. 台灣資產第一版使用 **TWSE OpenAPI／公開資訊觀測站資料、央行 API、主計總處發布與發布日曆**。海外公司事實先支援 **SEC EDGAR**；全球總經與匯率以 **ECB Data Portal**、各國央行／統計機關為主，FRED 僅作方便索引且逐序列檢查授權。
4. 即時報價是獨立的授權產品問題。第一版可用官方盤後／延遲資料完成配置與風險分析；若產品要求即時海外或台股報價，必須另購具有產品顯示及衍生分析權利的商業授權，不能抓取官網或假設免費 API 可商用。
5. 外部請求不得由使用者持倉觸發。固定頻率下載廣泛的國家、資產類別、產業與事件 feed，在本機把事件對應到持倉；不得送出帳戶、金額、完整持倉清單或可辨識的稀有 ticker 組合。

這個組合可在台灣提供低成本、可追溯的第一版，但不能保證盤中即時行情、付費新聞全文或單一來源的完整全球覆蓋。

## 來源評估

### 1. 國際新聞與事件發現

| 來源 | 可取得內容與時間 | 授權／成本 | 判斷 |
| --- | --- | --- | --- |
| GDELT 2.0 Event、Mentions、GKG | Event 與 GKG 每 15 分鐘更新；涵蓋跨語新聞。Event 的 `DATEADDED` 是 UTC 加入時間，`SOURCEURL` 可回到最早一批被偵測的報導；GKG 另有文件來源與發布日期欄位。 | GDELT 表示其資料集可供學術、商業、政府用途無限制免費使用，但使用或重散布時須標示 GDELT 與連結。 | **第一版採用，僅作 discovery。** 可用事件、地點、組織、來源 URL 建候選集；其自動抽取可能誤判，且來源文章本身仍有各自著作權。 |
| 官方發布 feed／API | 央行決策、統計發布、交易所公告、公司申報、政府政策與制裁的第一手文本。發布頻率依機關而異。 | 多數公開且免費，但授權逐站不同；只保存必要摘要、結構化欄位、URL 與雜湊，不假設可重製全文。 | **確認層的核心。** 事件分類先對應到官方來源目錄，再取得原始公告。 |
| ReliefWeb API（UN OCHA） | 人道事件的編輯整理資料庫，API 唯讀且持續更新。 | 免費；每次最多 1,000 筆、每天最多 1,000 次。2025-11-01 起需預先核准 `appname`；API 會記錄呼叫，合作夥伴報告可能有原作者著作權。 | **限人道／衝突影響的第二發現源。** 不宜當一般財經新聞源，也不應保存或重發合作夥伴全文。 |
| GDACS（UN／EC） | 地震、海嘯、熱帶氣旋、洪水等災害警報與模型估計；熱門 feeds 約每 6 分鐘更新，提供 RSS/API/GeoJSON。 | 資料免費，需標示 GDACS；官方明示其模型估計不能取代國家／地方官方警報。 | **災害傳導風險採用。** 先發現，再回到氣象、地震或災防主管機關確認。 |
| OFAC Sanctions List Service | 最新 SDN 與 non-SDN 制裁清單、可下載結構化資料、變更封存及雜湊。 | 公開下載；舊 RSS 已於 2025-01-31 退役，不能再依賴 RSS。 | **制裁風險採用。** 定時抓取 SLS 結構化檔與官方 recent actions，保存檔案雜湊及更新日。 |

依據：

- [GDELT 2.0 官方介紹](https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/)記載 15 分鐘更新與 65 種語言即時翻譯；[Event 2.0 codebook](https://data.gdeltproject.org/documentation/GDELT-Event_Codebook-V2.0.pdf)定義 `DATEADDED`、`SOURCEURL` 和 Mentions；[GKG 2.1 codebook](https://data.gdeltproject.org/documentation/GDELT-Global_Knowledge_Graph_Codebook-V2.1.pdf)定義來源集合、文件識別碼與 URL；[GDELT Terms of Use](https://www.gdeltproject.org/about.html#termsofuse)說明免費用途與 attribution 要求。
- [ReliefWeb API 官方文件](https://apidoc.reliefweb.int/)列出 API、appname、記錄呼叫、著作權與 quota。
- [GDACS feed reference](https://www.gdacs.org/feed_reference.aspx)列出更新頻率與 feeds；[API quick start](https://www.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf)及[使用條款](https://www.gdacs.org/About/termofuse.aspx)說明免費、標示來源和不可取代官方警報。
- [OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service)提供最新資料、客製資料與 archives；[OFAC technical actions](https://ofac.treasury.gov/sdn-list-data-formats-data-schemas/ofac-technical-actions-in-reverse-chronological-order)記載 RSS 退役。

### 2. 台灣市場、公司與總體資料

| 來源 | 可取得內容與時間 | 授權／成本 | 判斷 |
| --- | --- | --- | --- |
| TWSE OpenAPI | 上市公司公開資料、盤後日資料、統計與公開資訊觀測站衍生的開放資料 endpoints；OAS/Swagger 可機讀。 | OpenAPI 可直接介接。TWSE 網站一般條款禁止未經同意的 crawler；只有明確授權到政府資料開放平台的資料例外，使用時須標示來源。 | **第一版採用列入 OpenAPI／政府開放資料的 endpoints。** 不抓一般網站頁面，不把 OpenAPI 當即時行情。 |
| TWSE 即時交易資訊 | 直接或透過簽約資訊商取得交易資訊。 | 需申請、簽約及月費；官方費率列有每月 NT$60,000 重散布授權費，另依連線及帳戶計費。 | **不納入零成本第一版。** 需要即時功能時另開商務授權決策。 |
| 公開資訊觀測站／TWSE OpenAPI 公司資料 | 台灣上市公司財務、重大訊息、股利、治理等結構化公開資料。 | 僅使用明確開放的 API／資料集並遵守 attribution；網頁內容不自動視為開放資料。 | **公司事實主來源。** 原公告 URL、公司代碼、發布時間和報告期間一併保存。 |
| 中華民國中央銀行統計 API | NTD/USD 日、月、年資料及貨幣、金融市場、國際收支等統計。官方另提供方法與發布時效。 | 央行網站公開資料採 OGDL-Taiwan-1.0，免費、可再授權與製作產品，但必須顯名。 | **第一版採用。** NTD 換算與台灣總經優先於第三方匯率聚合器。 |
| 主計總處 SDDS／統計發布 | GDP、CPI、就業、工資等，含發布日曆、初估／修訂時程與方法。 | 政府公開資料依資料集標示授權；OGDL 允許商業加值使用並要求顯名。 | **第一版採用。** 必須保留「初估／修訂」狀態，不以新值覆蓋舊值而失去版本。 |

依據：

- [TWSE OpenAPI Swagger](https://openapi.twse.com.tw/)列出 base URL 與 endpoints；[TWSE 使用條款](https://wwwc.twse.com.tw/en/terms/use.html)禁止未授權自動抓取，並限定政府開放資料例外。
- [TWSE 即時交易資訊與費率](https://wwwc.twse.com.tw/en/products/information/real-time.html)列出申請方式、重散布、連線及帳戶費；[TWSE 資訊服務 Q&A](https://www.twse.com.tw/en/products/information/qa.html)說明加值傳送需同意與書面契約。
- [央行 API 說明](https://cpx.cbc.gov.tw/Data/ExportToEnAPIInfo)列出 NTD/USD 與各統計 item code；[央行匯率方法](https://www.cbc.gov.tw/en/cp-515-30005-D62ED-2.html)說明資料是銀行間即期市場收盤匯率；[央行開放資料聲明](https://www.cbc.gov.tw/en/cp-958-40419-F8209-2.html)採 OGDL-Taiwan-1.0。
- [台灣政府資料開放授權條款 1.0](https://data.gov.tw/license)允許不限目的、時間、地域及免授權金利用與再授權，但要求顯名。
- [主計總處 SDDS](https://eng.stat.gov.tw/sdds/)提供資料類別、發布日曆與方法入口。

### 3. 海外公司、市場、總體與匯率

| 來源 | 可取得內容與時間 | 授權／成本 | 判斷 |
| --- | --- | --- | --- |
| SEC EDGAR `data.sec.gov` | 美國發行人的 submissions 與 XBRL company facts；JSON API 不需 key。Submissions 通常低於一秒、XBRL 通常低於一分鐘更新；bulk ZIP 每晚更新。 | 公開免費；自動請求總量不得超過 10 requests/sec，應提供可識別的 User-Agent。申報附件可能含個別權利，保留連結而非重發完整附件。 | **第一版採用。** 美國公司財報與重大申報事實的主來源，不提供股價。 |
| ECB Data Portal SDMX API | 歐元區總經、利率與對 EUR 匯率；支援 `updatedAfter`、`includeHistory`、觀測期間與 metadata。ECB 參考匯率工作日約 16:00 CET 發布，僅供資訊用途。 | 公開統計可免費重用，需標示來源、準確呈現；若改算須註明，第三方資料例外。 | **第一版採用。** 適合作為非 NTD 匯率交叉檢查與歐洲總經來源，不當成交價。 |
| FRED API | 統一檢索大量官方與第三方總經序列，需 API key。 | API 本身可用，但每個序列可能有第三方著作權；有 `Copyright` note 的序列，非個人用途須向資料所有人取得同意。應顯示「使用 FRED API、非聯準銀行背書」聲明。 | **有條件採用。** 只白名單化授權清楚、能追到原發布者的序列；FRED 是索引／鏡像，不取代原始機關。 |
| 商業行情 API（以 Twelve Data 為代表） | 股票、ETF、FX、crypto 即時／歷史 endpoints，需 API key；免費 Basic 有 8 credits/min、800/day。 | 2026 條款限制免費層商業使用；預設授權以 internal use 為主，外部顯示、重散布、非顯示用途及交易所資料可能需 add-on／額外協議。 | **不作第一版預設。** 若海外行情精度是必要需求，先向供應商取得書面的商業、顯示、衍生資料、快取與台灣使用權，再選型。 |

依據：

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)說明資料範圍、免驗證、更新時效、bulk files 與 CORS；[SEC rate control](https://www.sec.gov/filergroup/announcements-old/new-rate-control-limits)規定自動存取上限 10 requests/sec。
- [ECB Data Portal API](https://data.ecb.europa.eu/help/api/data)定義時間區間、`updatedAfter`、歷史版本與輸出格式；[ECB 匯率頁](https://data.ecb.europa.eu/key-figures/ecb-interest-rates-and-exchange-rates/exchange-rates)說明發布時間及資訊用途；[ESCB 統計重用政策](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html)及[ECB copyright](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)定義免費重用與標示條件。
- [FRED API Terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html)說明 API key、顯示聲明及第三方序列權利。
- [Twelve Data 文件](https://twelvedata.com/docs/introduction/quickstart)、[價目](https://twelvedata.com/pricing)與[2026 Terms](https://twelvedata.com/terms)說明 key、credits、方案與使用／重散布限制。它只是商業方案代表，最終採購仍需比較涵蓋率、SLA、錯誤更正、資料沿革與契約。

## 證據與時間資料契約

每一筆外部證據都應保存下列欄位，LLM 只讀取正規化後的證據，不直接把網頁文字當事實：

```text
evidence_id
source_organization
source_kind              # authority / filing / exchange / issuer / media-index
canonical_url
source_record_id
title
published_at             # 原發布時間，含 timezone
effective_at_or_period   # 事實適用時間／財報期間
source_updated_at        # 原站最後更新或修訂時間
retrieved_at             # 本機實際取得時間
revision_status          # preliminary / revised / final / corrected
content_hash
license_id
license_url
license_checked_at
language
entities
event_type
extractor_version
confidence
corroborates[] / contradicts[]
```

實作規則：

- UI 同時顯示「發布時間」與「本機取得時間」；行情另顯示 `as_of` 及 delayed/realtime 狀態。
- 不把 observation period、發布時間和擷取時間混成一個 timestamp。
- 保存修訂鏈，不靜默覆寫；若來源更正或撤回，舊結論必須失效並重算。
- 保存 canonical URL、source record ID、內容雜湊與 extractor version，讓相同輸入可重現。
- 授權條款以 `license_checked_at` 快照管理；條款變更後停止新擷取，直到重新核可。
- 新聞全文預設不入庫；保存允許的 metadata、短摘錄或本機臨時內容，回答連回原文。

## 交叉驗證與信心規則

1. **GDELT、ReliefWeb 和商業新聞都是發現或彙整來源，不是最終確認。**
2. 公司財務／重大訊息以監管申報或公司官方公告為主；市場狀態以交易所或已授權行情為主；政策、制裁、利率、統計以發布機關為主。
3. 對「可能顯著影響資產」的國際事件，至少需要：
   - 一個發布該事實的官方／公司／交易所來源；以及
   - 另一個獨立來源確認事件存在或其市場傳導。
4. 只有新聞而沒有官方資料時，可顯示「未確認報導」，不得產生高信心的資產行動建議。
5. 多篇轉載同一通訊社不算多個獨立來源；依 canonical URL、內容雜湊、引用鏈和事件時間去重。
6. 來源互相衝突、已過有效期、只有模型推論或資料落後時，降低信心並把衝突並列。

## 去識別查詢設計

「不送姓名」並不等於隱私安全；ticker 組合、查詢時序與 IP 仍可能推測持倉。第一版應採以下順序：

1. **Bulk/feed first：**固定排程下載 GDELT 公開更新檔、官方發布日曆、制裁清單、GDACS feeds、TWSE 開放資料和 SEC bulk/index；供應商看不到是哪些持倉觸發請求。
2. **固定公共目錄：**以國家、產業、資產類別、總經主題建立與所有使用者相同的粗粒度查詢集合；在本機做 ticker、公司、地區、幣別與持倉的 join。
3. **直接官方 URL：**特定公司資料從公開的 issuer/filing identifier 目錄取得，不把帳戶、部位、成本、損益或整組 watchlist 放入 query。
4. **批次、快取、抖動：**用固定批次及共享公共快取降低查詢時序與單一事件的關聯；本機 cache 也避免重複暴露。
5. **例外需揭露：**若使用者主動查特定標的且必須呼叫商業 API，UI 應逐供應商揭露將送出的 symbol、時間與目的；仍不送部位與個資。
6. **不要宣稱匿名：**服務仍可看到 IP、API key 與 usage。需要更強保護時，採只承載公共固定查詢的 relay；relay 不接收持倉，也不寫 query log。

ReliefWeb 明載會記錄 API calls；FRED 與商業行情需帳戶／key。因此最安全的第一版不是把 ticker 做雜湊（供應商無法查詢且仍可能被字典反解），而是讓外部擷取與個人持倉完全解耦。

## 成本與台灣可用性

- **可零資料授權費啟動：**GDELT raw data、TWSE 明確開放 endpoints、央行、主計總處、SEC EDGAR、ECB、OFAC、GDACS；仍有下載流量、儲存、解析、監控與合規維運成本。
- **需帳號但可低成本驗證：**FRED API key、ReliefWeb 預先核准 appname。正式產品須把 key 及條款同意流程納入設計。
- **不可假設免費商用：**Twelve Data 等免費行情層可能明禁商業用途；交易所即時資訊、新聞全文和重散布通常另行計費。
- 本次官方文件未見上述公開資料服務排除台灣的一般條款；這只表示**沒有發現文件上的地域禁止**，不是 SLA。產品化前仍須在台灣網路環境做 endpoint、DNS、延遲、流量限制、帳號申請及付款方式驗證。

## 第一版建議來源清單

**必選**

- GDELT 2.0 Event/Mentions/GKG：全球事件 discovery。
- TWSE OpenAPI/MOPS 開放資料、央行 API、主計總處：台灣市場／公司／總經。
- SEC EDGAR：美國持股公司的申報事實。
- ECB Data Portal + 央行：FX 與總經；FRED 僅作授權白名單序列的輔助。
- OFAC SLS：制裁；GDACS：災害；ReliefWeb：重大人道事件的補充發現。
- 公司 IR／交易所／監管機關原公告：每個風險事件的 confirmation。

**延後**

- 即時市場資料與付費新聞全文：等產品確認即時性、顯示、快取、衍生分析及重散布需求後採購。
- 任意新聞網站 crawler、Google News 未授權抓取、社群貼文：授權、穩定性、假訊息及隱私風險不符合第一版證據標準。

## 驗收門檻

進入實作規格前，應用小型 prototype 驗證：

- 從台灣連續 14 天抓取所有必選來源，記錄成功率、延遲、429、schema 變更與每日資料量。
- 用至少 20 個已知國際事件做 GDELT → 官方來源 → 持倉曝險的回放，量測漏報、誤報與來源去重。
- 用修訂過的 GDP/CPI、公司更正申報及 OFAC 變更測試 revision invalidation。
- 法務逐 endpoint 確認 attribution、快取、顯示、衍生分析與商業使用權；任何未確認來源不得進 production allowlist。
- 以攔截外連請求的測試證明 payload 不含帳戶、金額、成本、完整持倉、使用者識別碼或由持倉生成的 ticker 集合。
