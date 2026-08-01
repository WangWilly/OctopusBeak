# Apple 裝置端 Foundation Models 的產品與整合邊界

研究日期：2026-08-01
研究問題：在第一版支援的 Apple Silicon macOS 範圍內，釐清 Apple 裝置端 Foundation Models 的硬體與系統需求、繁體中文品質、上下文與工具呼叫能力、資料處理保證、授權與發佈限制，並決定它在經驗證模型目錄中的角色。

## 結論

Apple 裝置端 Foundation Models 應列為**條件式「系統內建」選項**，不應列為可下載的開源模型，也不應成為第一版預設模型。

只有在下列條件同時成立時才顯示為可用：

1. Apple Silicon Mac；
2. macOS 26.1 或更新版本（繁體中文自 26.1 起納入 Apple Intelligence 支援語言）；
3. 使用者已啟用 Apple Intelligence、系統模型已就緒；
4. 當前 App locale 通過 `supportsLocale(_:)`；
5. 該 OS／模型版本通過產品自己的繁中與財務安全評測。

它適合負責短篇摘要、分類、實體擷取、文字改寫、將**已由確定性程式算出的財務事實**轉成結構化說明，以及以唯讀工具取得本機事實。它不適合單獨負責長期資產對話、世界知識、國際新聞判讀、複雜財務推理、配置適合度判斷或買賣建議。Apple 明示裝置端模型的世界知識與進階推理能力有限，而 Foundation Models 可接受使用規範禁止在金融等高風險領域提供不準確或危險輸出，或在無人監督下作出對個人權益有重大影響的決定。[Apple：Meet the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2025/286/)；[Apple：Acceptable use requirements](https://developer.apple.com/apple-intelligence/acceptable-use-requirements-for-the-foundation-models-framework/)

因此第一版的產品標示建議為：

> Apple 裝置端（系統內建）— 無需另行下載、可離線、資料留在裝置；適合摘要與解釋。複雜財務推理與即時新聞風險分析會改用其他已驗證模型或受控流程。

## 1. 硬體、系統與可用性

Apple Intelligence 在 Mac 上要求 Apple Silicon；Apple 目前列出的通用系統需求還包括至少 macOS Sequoia 15.1、約 7 GB 裝置儲存空間，以及裝置語言和 Siri 語言設為相同的支援語言。關閉 Apple Intelligence 會移除裝置端模型。[Apple 支援：如何取得 Apple Intelligence](https://support.apple.com/zh-tw/121115)

但 **Foundation Models framework 本身從 macOS 26.0 才開始提供**；繁體中文則自 macOS 26.1 起列入 Apple Intelligence 支援語言。因此，本產品若要提供繁中 Apple 模型體驗，實際最低門檻應訂為 **macOS 26.1**，而不是 Apple Intelligence 的較早通用門檻 15.1。[Apple：Updating prompts for new model versions](https://developer.apple.com/documentation/foundationmodels/updating-prompts-for-new-model-versions)；[Apple 支援：如何取得 Apple Intelligence](https://support.apple.com/zh-tw/121115)

應在每次建立 session 前檢查 `SystemLanguageModel.default.availability`／`isAvailable`，並分別處理：

- `deviceNotEligible`：裝置不支援 Apple Intelligence；
- `appleIntelligenceNotEnabled`：使用者未啟用 Apple Intelligence；
- `modelNotReady`：模型尚未下載或未就緒；下載由系統依網路、電量與負載自動管理。

來源：[Apple：SystemLanguageModel unavailable reasons](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason/modelnotready)

### 對模型目錄的影響

- Apple 模型不是由 OctopusBeak 下載、更新或刪除；它由作業系統提供與管理。
- 模型卡應顯示「系統內建」而不是下載大小或權重格式。
- 不可把「Apple Silicon」等同於「一定可用」；設定、locale、地區、模型下載狀態都可能使其不可用。
- Apple 模型不可用時，產品必須保留已驗證開放權重模型作為完整替代路徑。

## 2. 繁體中文：支援已確認，品質尚未被證明

Apple 將繁體中文列為 macOS 26.1 起的 Apple Intelligence 支援語言。Foundation Models 的系統模型是多語模型，可透過 `supportsLocale(_:)` 或 `supportedLanguages` 在執行期查詢；若 prompt 或指定輸出語言不支援，session 會拋出 `unsupportedLanguageOrLocale`。[Apple：Supporting languages and locales with Foundation Models](https://developer.apple.com/documentation/foundationmodels/supporting-languages-and-locales-with-foundation-models)；[Apple 支援：如何取得 Apple Intelligence](https://support.apple.com/zh-tw/121115)

官方資料沒有提供繁體中文、台灣金融語境或中英跨語新聞推理的品質分數。因此只能得出「API／語言支援」，不能得出「品質足以作為預設」。Apple 也提醒語言支援會隨 OS／模型版本改善，而且非美式英文 locale 應在 instructions 中明確指定 locale 與語言，以降低多語情境的幻覺。[Apple：Supporting languages and locales with Foundation Models](https://developer.apple.com/documentation/foundationmodels/supporting-languages-and-locales-with-foundation-models)

上架前至少應按每個支援的 macOS 模型版本評測：

- 台灣繁體中文術語與數字表達；
- 台幣、外幣、ETF、債券、負債、現金流等財務概念；
- 中英來源交叉閱讀後的忠實摘要；
- 引用來源與「事實／推論／建議」分離；
- 不把資料缺口補成事實；
- 不產生未經證據支持的買賣、報酬或風險結論。

Apple 指出，同一 prompt 的輸出具有變異性，底層模型也會隨 OS 更新而在開發者無法控制的情況下改變；應以可量測標準做持續評測，並為不同模型版本維護 prompt。[Apple：Evaluating prompts](https://developer.apple.com/documentation/foundationmodels/evaluating-prompts-to-measure-performance-and-improve-model-responses)；[Apple：Updating prompts for new model versions](https://developer.apple.com/documentation/foundationmodels/updating-prompts-for-new-model-versions)

## 3. Context、推理與對話邊界

macOS 26 系列的裝置端 `SystemLanguageModel` context 上限是 **4,096 tokens**；instructions、所有 prompts、工具內容與所有 outputs 都共同計入。Apple 說明中文、日文、韓文通常約一字一 token，因此繁中可容納的實際文字量尤其有限。超限會拋出 `contextSizeExceeded`，需要裁切 transcript、分段處理或建立新 session。[Apple：Generating content and performing tasks with Foundation Models](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models)

Apple 對裝置端模型的定位是摘要、實體擷取、文字理解與改寫等任務；官方明示小型裝置端模型不適合世界知識或進階推理，複雜問題需要拆成較小、明確的步驟。[Apple：Meet the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2025/286/)；[Apple：Prompting an on-device foundation model](https://developer.apple.com/documentation/foundationmodels/prompting-an-on-device-foundation-model)

### 對產品的影響

- 不把完整帳本、長期對話或大量新聞全文塞入 session。
- 資產金額、報酬率、配置比例、曝險與傳導關係先由確定性程式計算，再只提供回答所需的最小結構化事實。
- 長對話由產品層保存，採「結構化狀態＋短摘要＋當次必要證據」重建 session；不要把 Apple session transcript 當唯一記憶。
- 世界知識與即時新聞必須由外部資料工具取得，模型訓練記憶不能作為證據。
- 新聞到個人資產風險的複雜推理不應只依賴 Apple 裝置端模型；至少要由規則／計算管線先建立可驗證的曝險與事件關係。

## 4. 結構化輸出與工具呼叫

Foundation Models 支援：

- `@Generable`／`@Guide` guided generation，將輸出限制為 Swift 型別；
- stateful `LanguageModelSession`；
- streaming；
- `Tool` protocol，由模型決定何時與呼叫幾次，framework 執行開發者提供的程式碼，再把結果放回 transcript。

工具參數透過 guided generation 產生，Apple 表示這可保證工具名稱與參數符合 schema；但這不保證模型選對工具、工具結果正確，或最終財務結論正確。[Apple：Meet the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2025/286/)；[Apple：Deep dive into the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2025/301/)

第一版應限制 Apple 模型只能使用：

- 唯讀資產查詢；
- 已驗證的財務計算結果查詢；
- 來源受控的新聞／市場證據查詢；
- 無副作用的格式化與分類工具。

交易、修改帳本、改風險規則、送通知或任何會改變外部狀態的動作，不應由模型自主呼叫。若未來開放有副作用工具，必須在真正執行前經由確定性政策檢查與明確的人類確認。

外部資料工具可以連網；因此「Apple 模型在裝置端」只保證送入／產出模型的資料留在裝置，**不會自動替開發者寫的工具提供隱私保證**。工具若呼叫網路服務，仍須遵守本產品既定的最小化與去識別化查詢邊界。Apple 官方範例也明確區分模型本身的裝置端隱私，以及可由開發者工具查詢本機或線上資料庫的能力。[Apple：Foundation Models framework](https://developer.apple.com/documentation/foundationmodels/)；[Apple：Meet the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2025/286/)

## 5. 資料處理與安全保證

Apple 表示裝置端模型的輸入與輸出留在裝置、可以離線運作，且模型內建於作業系統，不增加 App bundle 大小。[Apple：Meet the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2025/286/)

這項保證的範圍需要明確標示：

- 適用於 `SystemLanguageModel` 的模型推論；
- 不延伸到 OctopusBeak 自行呼叫的新聞、市場或搜尋 API；
- 不等同於輸出正確性保證；
- 不代表輸入／輸出不會出現在 App 自己的 log、crash report 或 Instruments trace；Apple 特別提醒 Foundation Models Instruments trace 可能含敏感資訊，必須妥善處理。[Apple：Analyzing runtime performance](https://developer.apple.com/documentation/foundationmodels/analyzing-the-runtime-performance-of-your-foundation-models-app)

Apple framework 提供模型安全訓練與輸入／輸出 guardrails，但 Apple 明示內建層仍可能漏掉情境性傷害，App 必須自行增加符合使用情境的安全層。使用者或外部新聞內容不可放入優先級更高的 `Instructions`，以免形成 prompt injection；應放在明確包裝的普通 prompt／tool result 中。[Apple：Improving the safety of generative model output](https://developer.apple.com/documentation/foundationmodels/improving-the-safety-of-generative-model-output)

## 6. 授權、開源與發佈限制

Apple 裝置端模型是作業系統提供的 Apple Foundation Model，公開整合介面是 Apple 的 Foundation Models framework；Apple 沒有提供可由 App 下載、重散布或自行管理的開放權重。因此它不能被描述為「開源 LLM」，也不能和 Gemma、Llama、Qwen 等下載項目共用「下載／刪除模型」操作。Apple 的 framework utilities 或第三方 `LanguageModel` provider 可以開源，不代表 Apple 系統模型權重開源。[Apple：Foundation Models framework](https://developer.apple.com/documentation/foundationmodels/)；[Apple：What’s new in the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2026/241/)

一般 `SystemLanguageModel` 官方文件未要求額外 entitlement；但仍受 Xcode／Apple SDK 授權條款、App 發佈規則及 Foundation Models 可接受使用規範約束。特別是可接受使用規範禁止：

- 提供不準確或危險輸出；
- 在金融等高風險領域，無人監督地作出對個人權益有重大影響的決定；
- 規避 framework guardrails；
- 反向工程或重現 Apple 模型訓練資料。

來源：[Apple：Acceptable use requirements](https://developer.apple.com/apple-intelligence/acceptable-use-requirements-for-the-foundation-models-framework/)；[Apple：Xcode and Apple SDKs Agreement](https://www.apple.com/legal/sla/docs/xcode.pdf)

因此 OctopusBeak 使用 Apple 模型時應：

- 定位為個人化決策支援，不是代客決策；
- 保留使用者監督與最後判斷；
- 禁止自動交易與自動調整資產；
- 關鍵數字由確定性程式產生；
- 即時事實附來源與時間；
- 明示信心、資料缺口與模型限制；
- 以評測與政策 gate 阻擋不安全輸出。

### 第一版不納入的 Apple 能力

1. **Private Cloud Compute（PCC）**：它不是「原始財務資料永不離開裝置」的本機推論；且目前需要 Apple 管理的 entitlement、App Store Small Business Program 資格、少於 200 萬次首次下載，並有每日使用限制。即使 Apple 提供隱私保護，也應另立雲端選配決策，不納入本票的裝置端方案。[Apple：Accessing Private Cloud Compute](https://developer.apple.com/private-cloud-compute/)；[Apple：Adding server-side intelligence with PCC](https://developer.apple.com/documentation/foundationmodels/adding-server-side-intelligence-with-private-cloud-compute)
2. **自訂 adapter**：部署需要 Foundation Models Framework Adapter Entitlement；adapter 綁定特定系統模型版本，OS 模型變更時需重訓與重發。這會顯著擴大測試與發佈成本，第一版不採用。[Apple：Foundation Models adapter training](https://developer.apple.com/apple-intelligence/foundation-models-adapter/)
3. **macOS 27 beta 專屬能力**：新模型、通用 `LanguageModel` protocol、Dynamic Profiles、PCC、`fm` CLI 與 Python SDK 等仍含 beta／版本變動面。第一版的必要路徑不應依賴尚未成為穩定最低系統的能力；可在後續版本評估。[Apple：Foundation Models updates](https://developer.apple.com/documentation/Updates/FoundationModels)

## 7. Electron 整合建議

Foundation Models 的正式 App API 是原生 Swift framework。對 Electron 桌面 App，第一版應建立一個簽署並隨 App 發佈的薄型 Swift helper，由 Electron main process 透過具邊界的 IPC 呼叫；不要讓 renderer 直接接觸模型、資產資料或工具權限。

建議邊界：

1. Electron 只傳入最小化、版本化的 request schema；
2. Swift helper 負責 availability／locale 檢查、session、guided generation、tool allowlist 與 Apple error 映射；
3. 財務計算與資產資料存取仍由既有確定性服務控制，helper 只能呼叫唯讀能力；
4. 回傳內容包含模型 provider、OS／prompt 版本、來源引用、信心與拒絕原因；
5. Apple 模型不可用或未通過任務評測時，由上層 router 選擇其他已驗證的本機模型。

這個 helper 也隔離了 Apple 原生 API 與跨平台 Electron 程式碼。macOS 27 的 `LanguageModel` protocol 未來可作為 Swift 層的統一模型介面，但不應為了使用 Apple 模型而把整個產品的模型抽象綁死在 beta API。[Apple：LanguageModel protocol](https://developer.apple.com/documentation/foundationmodels/languagemodel)

## 8. 驗收與產品 gate

在模型目錄把 Apple 選項升級為「推薦」或「預設」之前，必須有可重現證據證明：

- 目標 macOS／模型版本的繁中金融評測達標；
- 4K context 內的摘要與工具路由達標；
- 工具全為 allowlist，且預設無副作用；
- 所有關鍵數字均可回溯至確定性計算；
- 新聞結論可回溯至當次取得的來源；
- prompt injection、資料缺口、來源衝突與 guardrail refusal 有安全降級；
- OS 模型更新後自動重新跑評測，未達標即撤下「推薦」標籤。

在完成這些 gate 前，最穩健的目錄角色是：

**「系統內建／條件式可用／適合短篇摘要與解釋／不適合進階財務推理」**。
