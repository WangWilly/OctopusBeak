# 第一版經驗證模型目錄候選研究

- 研究日期：2026-08-01
- 對應決策票：[篩選第一版經驗證模型目錄候選](https://github.com/WangWilly/OctopusBeak/issues/52)
- 範圍：Apple Silicon Mac、本機推論、繁體中文／台灣金融語境、受控工具呼叫
- 證據限制：只採模型發布方的官方 model card、授權、repository、技術報告與開發文件

## 結論

第一版不應把「發布方」直接等同「單一模型」。建議目錄用同一套驗證套件，依裝置記憶體提供以下層級：

1. **優先進入驗證**
   - **Qwen 3.5 4B（Alibaba/Qwen）**：繁中與工具使用的首要候選，Apache 2.0，4B 可涵蓋主流 Apple Silicon。
   - **Gemma 4 E4B；12B 作高記憶體升級（Google）**：Apache 2.0、原生 function calling、140+ 語言；12B 官方定位可在 16GB VRAM／統一記憶體本機運行。
   - **Phi-4-mini-instruct 3.8B（Microsoft）**：MIT、官方列出 Chinese 與 function calling，適合低資源基準與備援。
   - **Granite 3.3 8B Instruct（IBM）**：Apache 2.0、Chinese、function calling、RAG 與 128K，適合作為企業／可治理性對照。
2. **必須出現、但不宜當繁中預設**
   - **Llama 3.2 3B Instruct（Meta）**：生態與低資源部署基準；Meta 官方支援語言不含中文，因此只能標成「實驗性繁中」，不得作台灣使用者預設。
3. **條件式納入**
   - **Mistral Small 3.2 24B Instruct**：Apache 2.0、中文、工具呼叫能力完整，但 24B 級只適合 32GB 以上 Mac。
   - **DeepSeek-R1-Distill-Qwen-7B**：MIT、強推理候選，但它是 Qwen2.5-Math 衍生的 reasoning specialist，官方卡未提供原生工具呼叫保證；只宜作「深度分析」選配。
   - **MiniCPM4 8B**：Apache 2.0、中文／英文、訓練含工具呼叫資料；但官方 Transformers 路徑要求 `trust_remote_code=True`，需先完成供應鏈與 MLX／GGUF 相容性審查。
4. **暫不納入**
   - **Llama 4 Scout／Maverick、DeepSeek-V3/R1 完整模型**：總權重規模不符合第一版消費級 Apple Silicon 的下載與常駐記憶體目標。
   - **InternLM3 8B**：Apache 2.0 且中英推理有吸引力，但同樣依賴 custom code，且相對於 Qwen／MiniCPM 沒有形成第一版必要的差異化。
   - **任意社群 fine-tune、merge、未由發布方提供的量化檔**：來源、量化品質、chat template 與授權鏈不可一概驗證。

這仍是**進入產品驗證的候選集**，不是已認證名單。沒有一家發布方提供足以證明「繁體中文＋台灣金融語境＋資產風險解釋」品質的官方評測；每個實際下載 artifact 都必須通過本文後段的本地驗證閘門，才能標示為「經驗證」。

## 決策矩陣

符號：`強`＝發布方明確支援且符合產品用途；`中`＝有能力但仍需產品專項驗證；`弱`＝發布方沒有支援承諾或用途不合。

| 候選 | 授權 | 建議最低統一記憶體* | 繁中／台灣金融 | 推理 | 工具呼叫 | 安全與供應 | 決策 |
|---|---|---:|---|---|---|---|---|
| Qwen 3.5 4B | Apache 2.0 | 8–16GB | 強／待測 | 強 | 強 | 官方持續迭代；需凍結版本 | 優先 |
| Gemma 4 E4B | Apache 2.0 | 12–16GB | 中／待測 | 中 | 強 | 官方 model card 與安全說明完整 | 優先 |
| Gemma 4 12B | Apache 2.0 | 16–24GB | 中／待測 | 強 | 強 | 官方稱 16GB 可本機跑；仍需留 app headroom | 高階 |
| Phi-4-mini 3.8B | MIT | 8–16GB | 中／待測 | 強 | 強 | 授權簡單；官方提醒語言表現差異 | 優先 |
| Granite 3.3 8B | Apache 2.0 | 16GB | 中／待測 | 強 | 強 | 企業用途、RAG 與工具能力明列 | 優先 |
| Llama 3.2 3B | Llama Community License | 8GB | 弱／待測 | 中 | 中 | 自訂授權與 AUP；中文非官方支援 | 相容基準 |
| Mistral Small 3.2 24B | Apache 2.0 | 32GB | 中／待測 | 強 | 強 | 供應成熟，但硬體門檻高 | 條件式 |
| DeepSeek-R1-Distill-Qwen-7B | MIT（並說明 Qwen 衍生來源） | 16GB | 中／待測 | 強 | 弱 | reasoning 輸出與資料治理需另測 | 專項選配 |
| MiniCPM4 8B | Apache 2.0 | 16GB | 強／待測 | 強 | 中 | `trust_remote_code` 增加供應鏈面 | 暫候 |

\* 記憶體欄是產品規劃估算，不是發布方保證：以約 4-bit 權重加上 runtime、KV cache、長上下文與 Electron 共存空間推估。目錄安裝前仍須讀取實際 artifact 大小並做可用記憶體預檢，不能只按參數量判斷。

## 各家判讀

### Google：以 Gemma 4 取代 Gemma 3 作首選

Google 的 Gemma 4 官方 model card 將授權列為 Apache 2.0，提供 E2B、E4B、12B、26B-A4B 與 31B，具 128K／256K context、140+ 預訓練語言、可設定 thinking，以及原生 function calling。E4B 的總參數實際為 8B（4.5B effective），因此不能把「E4B」錯算成只有 4B 權重；這會直接影響下載大小與記憶體分級。[Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4)

Google 另明確表示 12B 可在具有 16GB VRAM 或統一記憶體的 laptop 本機運行，但對同時執行 Electron、資料庫與長 context 的本產品，16GB 應標成「可嘗試」，24GB 才是較保守推薦。[Gemma 4 12B developer guide](https://developers.googleblog.com/gemma-4-12b-the-developer-guide/)

因此：

- E4B 作主流候選，12B 作高品質升級。
- 不優先選 Gemma 3；它雖支援 140+ 語言與 128K，但使用 Gemma 自訂條款且已被 Apache 2.0、原生工具能力更完整的 Gemma 4 超越。[Gemma 3 4B model card](https://huggingface.co/google/gemma-3-4b-it)
- 26B-A4B 雖每 token 約 4B active，仍要保存約 25.2B 總權重，不能按 4B 記憶體級距上架。

### Meta：保留 Llama 3.2 3B 作生態基準，不作繁中推薦

Llama 3.2 text-only 有 1B、3B、128K context，並以 agentic retrieval、summarization、裝置端情境為用途；但官方只列 English、German、French、Italian、Portuguese、Hindi、Spanish、Thai 八種支援語言，中文不在其中。官方也將其他語言列為需要開發者自行安全驗證的範圍。[Llama 3.2 model card](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/MODEL_CARD.md)

其授權不是 OSI 開源授權：Llama Community License 包含散布署名、Acceptable Use Policy、不得用輸出改進非 Llama 模型，以及超過 7 億 MAU 的額外商業條件。[Llama 3 license](https://github.com/meta-llama/llama-models/blob/main/models/llama3/LICENSE)

因此第一版可滿足「Meta 選項」與 runtime 相容性測試，但 UI 必須顯示：

- 繁中未獲發布方正式支援；
- 自訂授權與使用政策；
- 不推薦用於關鍵財務風險結論。

Llama 4 Scout／Maverick 的 active parameters 看似較小，但官方 family table 顯示是大型 MoE 系列；它們不符合消費級 Mac 的總權重常駐目標。[Meta Llama models repository](https://github.com/meta-llama/llama-models)

### Qwen：4B 作繁中與工具使用預設，版本必須凍結

Qwen 3 已明列支援 119 種語言與方言，包含 Traditional Chinese 與 Cantonese；4B／8B 等 dense model 為 Apache 2.0，官方也推薦 Ollama、MLX、llama.cpp 等本機工具。[Qwen 3 release](https://qwenlm.github.io/blog/qwen3/)

截至研究日，Qwen 3.5 4B 官方 model card 為 Apache 2.0、4B post-trained multimodal model，將全球語言覆蓋擴至 201 種語言／方言，並提供 agent benchmark。這使它比舊 Qwen 3 4B 更適合作為第一個驗證 artifact，但因架構較新，仍須先確認產品選定 runtime 的穩定支援。[Qwen 3.5 4B model card](https://huggingface.co/Qwen/Qwen3.5-4B)

Qwen 的官方 Agent repository 提供 function calling、平行呼叫、MCP 與 RAG 範式，但也說明工具呼叫會受模板、reasoning mode 與 inference server parser 影響；產品不能把「模型可輸出工具格式」等同「可安全執行任意工具」。[Qwen-Agent](https://github.com/QwenLM/Qwen-Agent) [Qwen 3 function-calling guide](https://github.com/QwenLM/Qwen3/blob/main/docs/source/framework/function_call.md)

建議只凍結一個 4B 與一個 9B 級 artifact，4B 為主流預設；不要同時上架 Qwen 3、3-2507、3.5 的大量近似版本，避免選擇負擔。

### Microsoft：Phi-4-mini 是低資源、寬鬆授權的強對照

Phi-4-mini-instruct 是 3.8B、128K、MIT model。Microsoft 官方列出 Chinese 在 24 個支援語言內，也明列 instruction following、function calling、安全後訓練，以及適用於 compute-constrained 與 latency-bound 情境。[Phi-4-mini-instruct model card](https://huggingface.co/microsoft/Phi-4-mini-instruct)

限制是官方同時提醒各語言表現不同，且未針對所有下游高風險用途評估。因此它適合：

- 8–16GB 裝置的低資源預設競爭者；
- 與 Qwen 4B 比較繁中、工具參數正確率與財務數學解釋；
- 不因 MIT 授權簡單就降低財務專項驗證要求。

### IBM：Granite 3.3 8B 值得進入第一輪

Granite 3.3 8B Instruct 是 Apache 2.0、8B、128K model。IBM 官方列出 Chinese，能力明列 reasoning、RAG、function calling、抽取、分類與長文件 QA；這與「確定性財務工具＋外部證據＋LLM 解釋」的架構吻合。[Granite 3.3 8B Instruct model card](https://huggingface.co/ibm-granite/granite-3.3-8b-instruct)

它不應取代繁中首選，而應作可治理、企業型用途的對照：若其台灣金融評測達標，Apache 2.0 與清楚的能力卡讓它比自訂授權模型更容易長期供應。

### Mistral：能力合格，硬體門檻使其成為高階選配

Mistral Small 3 系列官方 model card 列出 Apache 2.0、Chinese、native function calling、JSON output 與 32K context，並稱量化後可放入 32GB RAM MacBook。[Mistral Small 3 24B model card](https://huggingface.co/mistralai/Mistral-Small-24B-Instruct-2501)

3.2 更新強調 function／tool calling 改善，但仍是 24B 級，因此第一版只應在 32GB 以上裝置顯示，不能當全體 Mac 預設。[Mistral Small 3.2 24B model card](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506)

### DeepSeek：只納入 7B distill 作 reasoning specialist

DeepSeek-V3 是 671B total／37B active 的 MoE；即使 active count 看似可接受，總權重使其不適合第一版消費級 Mac。官方 repository 另說 model 授權帶有使用限制，並非單純等同 code repository 的 MIT。[DeepSeek-V3 repository](https://github.com/deepseek-ai/DeepSeek-V3) [DeepSeek-V3 model license](https://github.com/deepseek-ai/DeepSeek-V3/blob/main/LICENSE-MODEL)

DeepSeek-R1-Distill-Qwen-7B 則由 Qwen2.5-Math-7B 衍生，model card 表示權重採 MIT 且允許商業與衍生使用。它可進 16GB 級裝置測試，但應定位為需要較長等待時間的深度推理選配，而非工具路由模型；發布方 model card 沒有承諾原生 function calling。[DeepSeek-R1-Distill-Qwen-7B model card](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B)

### MiniCPM 與 InternLM：保留觀察

MiniCPM4 8B 官方 card 標示 Apache 2.0、中英模型，訓練資料包含 tool-calling tasks；但官方 Transformers 用法要求 `trust_remote_code=True`。下載模型時執行 repository code 與「純資料 artifact」的供應鏈邊界不同，因此須先完成 code hash、sandbox 與無 remote code runtime 的驗證，才可上架。[MiniCPM4 8B model card](https://huggingface.co/openbmb/MiniCPM4-8B)

InternLM3 8B Instruct 同為 Apache 2.0、中英、推理導向，也依賴 custom code。其差異化不足以在第一版增加另一套 runtime／template 維護成本，先留候補即可。[InternLM3 8B Instruct model card](https://huggingface.co/internlm/internlm3-8b-instruct)

## Apple 內建能力必須獨立呈現

Apple Foundation Models 不是可下載模型目錄的一筆：

- `SystemLanguageModel` 由作業系統提供，使用者必須啟用 Apple Intelligence，裝置、地區、模型下載狀態都可能讓它 unavailable；app 必須在執行時檢查並提供 fallback。[Foundation Models overview](https://developer.apple.com/documentation/FoundationModels) [Availability example](https://developer.apple.com/documentation/foundationmodels/adding-intelligent-app-features-with-generative-models)
- Apple 官方支援 guided structured output 與 developer-defined tools，符合受控財務工具架構；但工具程式仍由 app 執行。[Foundation Models overview](https://developer.apple.com/documentation/FoundationModels)
- 系統更新會替換模型。Apple 的更新說明要求開發者在新 OS model 上重測 prompts，代表產品無法像下載 artifact 一樣 pin 住 Apple model 版本。[Foundation Models updates](https://developer.apple.com/documentation/Updates/FoundationModels)
- 對 Electron app 而言，它是需要原生 Swift bridge 的系統 provider，不是 GGUF／MLX runtime 的另一個檔案。

目錄 UI 應把它放在「系統模型」區，顯示 `可用／Apple Intelligence 未啟用／裝置不支援／模型尚未就緒`，不提供下載、版本選擇或移除按鈕。

## 「經驗證」的上架閘門

官方證據只能決定候選，不能完成產品認證。每一個**精確 artifact（publisher、model id、revision hash、quantization、runtime、chat template）**至少要通過：

1. **合法與供應鏈**
   - 保存 license、AUP／prohibited-use policy、NOTICE 與來源 URL 快照。
   - 只接受發布方原始權重或由產品方可重現產生的量化；校驗 SHA-256。
   - 禁止未審核 remote code；不得把 community quantization 的人氣當成可信度。
2. **裝置資源**
   - 8／16／24／32／64GB Apple Silicon 實機測量安裝大小、冷啟動、首 token、tokens/s、峰值記憶體與熱壓力。
   - 與 Electron、SQLite／資料庫、匯入工作同時執行；OOM 或明顯 swap 的組合不得顯示為相容。
   - 分別測 4K、16K、目標最大 context；不能用 model card 最大 context 推導實際可用長度。
3. **繁中與台灣金融語境**
   - 正體輸出、台灣用詞、幣別與日期、ETF／股票／債券／外匯／加密資產、集中度與現金流解釋。
   - 不把中國法規、稅制、交易所或簡體金融詞彙誤套到台灣。
   - 對資料缺口能說明未知，不自行補出持倉、價格或政策。
4. **確定性工具與證據**
   - 工具選擇 precision／recall、JSON schema 合法率、參數正確率、平行與多步呼叫、失敗復原。
   - 僅能呼叫 allowlist，所有參數由 host 驗證；模型永遠不能直接改寫帳本。
   - 每個新聞風險回答須維持「來源事實 → 曝險映射 → 情境推論 → 建議」，並在來源衝突／過期時降信心。
5. **安全**
   - Prompt injection（新聞、PDF、CSV 內嵌）、資料外洩、越權工具、投資保證語句、確定性買賣建議、危機情境煽動。
   - 對不同模型使用相同 host-side guardrails；不能仰賴發布方 safety tuning 作唯一防線。
6. **品質與回歸**
   - 財務算術只能重述確定性工具結果；對數字引用必須可追溯。
   - 固定 revision 建立 golden set；runtime、quantization、prompt 或 OS system model 變更都重新跑。
   - 目錄顯示評測日期、artifact revision、適用記憶體級距與已知限制；超過時效即撤回「經驗證」標章。

## 建議的第一版可見選項

若上述閘門通過，UI 初始只需呈現少數清楚角色：

- **推薦（主流）**：Qwen 3.5 4B
- **低資源**：Phi-4-mini 3.8B
- **Google**：Gemma 4 E4B
- **Meta 相容模式**：Llama 3.2 3B（繁中實驗性警告）
- **進階 16–24GB**：Gemma 4 12B 或 Granite 3.3 8B，以本地專項評測勝者為先
- **高階 32GB+**：Mistral Small 3.2 24B
- **深度推理選配**：DeepSeek-R1-Distill-Qwen-7B
- **Apple 系統模型**：獨立狀態卡，available 時可選

這個設計滿足 Google、Meta、Qwen 與 Apple 的既定範圍，同時納入 Microsoft、IBM、Mistral、DeepSeek 的有意義差異，而不把長串品牌清單轉嫁成使用者的選擇成本。
