# Apple Silicon 開放權重 LLM 本機執行方案比較

研究日期：2026-08-01  
對應問題：[比較 Apple Silicon 的開放權重 LLM 本機執行方案](https://github.com/WangWilly/OctopusBeak/issues/56)

## 結論

第一版應以 **`llama.cpp` 的 `llama-server` 作為產品內建、由應用程式管理生命週期的主要執行引擎**，模型目錄以經驗證的 GGUF 成品為交付單位。它同時具備 Apple Silicon 的 Metal 最佳化、廣泛量化格式、Google Gemma／Meta Llama／Qwen 等模型的共同承載格式、OpenAI 相容串流 API、JSON Schema 約束輸出與工具呼叫，而且是 MIT 授權。這組合使 Electron 主程式能維持一個穩定的「本機模型供應者」介面，又不必把 C++ ABI 直接耦合進 Node/Electron。

同時保留兩個邊界清楚的擴充點：

1. **MLX／MLX-LM 作為 Apple Silicon 專用的第二引擎與效能基準**。它直接利用統一記憶體，適合驗證特定模型在 Apple 硬體上的吞吐與記憶體優勢；但官方明確表示 `mlx_lm.server` 不建議用於 production，若將 Python 伺服器直接納入產品，打包、供應鏈與隔離成本均高於單一 C++ helper。
2. **Ollama 作為選配的外部 provider**。若使用者已安裝 Ollama，可連接它的本機 REST API；第一版不應把 Ollama 桌面程式或其全域 daemon 當作產品內建依賴，因為模型儲存、背景服務與自動更新生命週期不由本產品控制。

MLC LLM 與 ExecuTorch／Core ML 暫不進第一版主路徑。前者適合未來跨平台／行動裝置共用引擎，但模型需編譯成目標專用成品，會放大模型目錄的建置矩陣；後者適合少量、固定、經 AOT 匯出的模型及 ANE／Core ML 最佳化，不適合第一版「使用者自由下載多家模型」的快速更新節奏。Apple Foundation Models 則是另一個 OS 管理的 provider，不是可下載或釘選權重的開放權重 runtime，必須與模型目錄分開呈現。

## 比較

| 方案 | Apple Silicon 加速 | 模型與量化格式 | Electron 串接 | 工具／結構化輸出 | 打包、更新與授權 | 判定 |
|---|---|---|---|---|---|---|
| **llama.cpp / llama-server** | 官方將 Apple Silicon 列為 first-class，使用 ARM NEON、Accelerate 與 Metal；支援 CPU/GPU 混合推論 | GGUF；官方列出 1.5–8 bit 多種量化，其他格式可轉 GGUF | 可隨 app 附帶 arm64 helper，以 loopback HTTP 呼叫 OpenAI 相容 API；亦可日後改成直接 C API | 官方 server 支援 schema-constrained JSON、OpenAI-style function calling、串流、embedding、reranking、載入／卸載與 idle sleep | runtime 為 MIT；可釘選 release/commit、自行簽章與隨 app 更新 | **第一版主引擎** |
| **MLX / MLX-LM** | MLX 為 Apple Silicon 設計，CPU/GPU 共用統一記憶體，資料不需在裝置間複製 | Hugging Face/Safetensors 生態，可轉換及量化；MLX-LM 支援大量相容模型與 prompt/KV cache | 最快路徑是 Python subprocess/HTTP；MLX 另有 C、C++、Swift API，但要自行打造產品級 LLM service | 有 OpenAI-like server，但官方稱只做基本安全檢查且不建議 production；產品級 tool contract 需自行補足 | MLX 與 MLX-LM 均 MIT；Python runtime、wheel 與依賴會增加簽章、更新、SBOM 負擔 | **第二引擎／基準，主路徑後再評估** |
| **Ollama** | macOS 本機 runtime，底層專案包含 llama.cpp 等本機引擎 | 提供自己的 model manifest/library，API 可 pull、resume、show、copy、delete，亦可由 GGUF 建模 | REST API 最容易接；但預設是獨立服務、固定本機埠及使用者層級模型目錄 | 官方 API 支援聊天、結構化輸出、工具呼叫及模型管理 | 開源 repo 為 MIT；macOS/Windows 會自動更新，模型預設存於 `~/.ollama/models`，生命週期與 app 分離 | **只做既有安裝的外部 provider** |
| **MLC LLM** | 官方矩陣支援 macOS Apple GPU/Metal | 需由 compiler 產生 MLC 模型／目標成品；適合固定測試過的部署矩陣 | MLCEngine 提供 REST、Python、JavaScript、iOS/Android 共用 OpenAI-compatible API | 可在統一 engine API 上實作結構化對話；仍須逐模型驗證聊天模板與工具行為 | Apache-2.0；編譯器與目標專用 artifacts 增加 catalog CI、下載與回滾矩陣 | **跨平台需求成熟後重評** |
| **ExecuTorch + Core ML/MPS** | Apple 端有 Core ML（GPU/NPU）及 MPS（GPU）backend | PyTorch 模型先匯出成 `.pte`；不同 backend/target 通常要不同 artifact，Core ML operator/OS 相容性需驗證 | C++ 與 Swift bindings 適合原生 helper，但對 Electron 仍需自行建 IPC/service 與 tokenizer/sampler 層 | 是推論 runtime，不是現成多模型對話 server；工具協定、模板、下載管理都由產品負責 | 適合少量固定模型的 AOT 發布；不是第一版廣泛模型目錄的最低成本方案 | **固定模型／ANE 專案另案評估** |
| **Apple Foundation Models** | Apple Intelligence 的 OS 內建 on-device model | 權重、下載與版本由 OS 管理，不是 GGUF/MLX 模型目錄；使用者不能選定權重版本 | 原生 Foundation Models framework；Electron 需 Swift helper/bridge | 原生支援 guided generation 與 tool calling | availability 受裝置、Apple Intelligence 開關與模型下載狀態影響；OS 更新會改變模型行為 | **獨立的「Apple 內建」provider，不是開放權重 runtime** |

來源：[`llama.cpp` README](https://github.com/ggml-org/llama.cpp)、[`llama-server` 官方文件](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[`llama.cpp` MIT License](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE)、[MLX 官方 README](https://github.com/ml-explore/mlx)、[MLX unified memory 文件](https://ml-explore.github.io/mlx/build/html/usage/unified_memory.html)、[MLX-LM README](https://github.com/ml-explore/mlx-lm)、[MLX-LM server 文件](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md)、[Ollama README 與 REST API](https://github.com/ollama/ollama)、[Ollama API 文件](https://github.com/ollama/ollama/blob/main/docs/api.md)、[Ollama FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx)、[MLC LLM 官方 repo](https://github.com/mlc-ai/mlc-llm)、[ExecuTorch LLM 部署文件](https://docs.pytorch.org/executorch/stable/llm/getting-started.html)、[ExecuTorch Apple backends](https://docs.pytorch.org/executorch/stable/ios-backends.html)、[Apple Foundation Models](https://developer.apple.com/documentation/FoundationModels)。

## 主引擎的產品契約

### 1. 程序與權限隔離

Electron main process 負責啟停一個簽章過的 `llama-server` helper；renderer 不得直接啟動程序、讀模型路徑或存取 helper。helper 應：

- 只綁定 `127.0.0.1` 的隨機可用埠，使用每次啟動產生的 bearer token；埠與 token 只存在 main process。
- 不開啟 `llama-server` 的內建檔案／shell tools。官方文件也警告不要在不可信環境啟用內建 tools。財務工具由應用程式自己的 allowlist dispatcher 執行，模型只能產生待驗證的 tool call。
- 禁止 helper 自行接受遠端模型 URL或任意 Hugging Face repo。下載器是另一個受控元件，只能依已簽署 catalog manifest 下載到 app container。
- 對每次 tool call 做 schema 驗證、權限檢查、逾時、輸出大小限制與稽核；模型絕不直接取得帳本寫入能力。
- 將模型檔視為不可信大型二進位輸入：驗證 hash、大小、GGUF metadata、允許的 architecture/quantization/chat template，再交給 runtime；runtime crash 只重啟 helper，不拖垮 Electron main process。

若採 Mac App Store 發布，Apple 規定 App Sandbox 必須啟用；內嵌 command-line tool 必須繼承容器 app 的 sandbox。Apple 也建議把可能有弱點的操作放到不同 helper/XPC 元件，讓各元件只取得必要能力。因此模型與 cache 放在 app container，下載網路權限和財務資料讀取權限不可不必要地集中在 inference helper。[Apple App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)、[Apple sandbox 違規診斷與 helper 設計](https://developer.apple.com/documentation/security/discovering-and-diagnosing-app-sandbox-violations)、[Apple sandbox 檔案存取](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)。

### 2. 記憶體與模型生命週期

Apple Silicon 的 CPU 與 GPU 共用系統記憶體，因此模型權重、KV cache、Electron/Chromium 與其他 app 競爭同一資源；不能把「GPU 記憶體」當成另一個獨立容量。[Apple Metal 對 unified memory 的說明](https://developer.apple.com/documentation/metal/choosing-a-resource-storage-mode-for-intel-and-amd-gpus)。

第一版應採：

- catalog 對每個「模型版本 × GGUF quant × context preset」保存檔案大小、測得的 peak resident memory、推薦 RAM 等級與測試裝置。
- 啟動前做 preflight，預留 Electron/OS headroom；不足時縮短 context、建議較小 quant/model，不能讓系統進入 memory pressure 後才失敗。
- 預設一次只載入一個生成模型；切換模型先卸載舊模型。可利用 `llama-server` 的 load/unload 與 idle sleep，但由 app 作最終狀態機，不依賴 server 的隱式 autoload。
- context 上限是產品設定，不直接採模型宣稱最大值；長 context 會擴大 KV cache。記錄每次請求的 prompt/cache/generated token 使用量，供 UI 解釋資源成本。
- 在支援清單中的每台 RAM 等級實測冷啟動、首 token、tokens/s、peak RSS、取消請求、切換及 sleep/wake；不可只以模型權重檔大小推算。

`llama-server` 官方已有路由模式的載入／卸載、idle sleep（釋放模型與 KV cache）以及 token/timing metrics，可作實作基礎。[官方 server 文件](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)。

### 3. 模型、聊天模板與工具呼叫

GGUF 是 runtime 容器，不代表模型行為已相容。catalog 的最小可安裝單位必須固定：

- upstream model id/revision、原始模型授權與 acceptable-use URL；
- GGUF 下載 URL、SHA-256、檔案大小、quantization、converter 與版本；
- tokenizer/chat template 版本、是否啟用 reasoning、context preset；
- 通過的能力測試：繁中、結構化輸出、單一/平行 tool call、錯誤參數、取消與重試；
- runtime 最低／最高相容版本及 benchmark 結果。

`llama-server` 的 function calling 依 Jinja chat template 解析；官方雖提供 generic fallback，仍指出可能需要模型特定 template。故「runtime 支援工具」不等於「任何模型可靠地使用工具」，每個 catalog artifact 都要做 contract test。[`llama.cpp` function calling 文件](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)。

MLX-LM 允許部分 tokenizer 開啟 `trust_remote_code`，這會執行模型 repo 提供的程式；可信目錄不得開放此能力。只收錄不需 remote code 的 artifact，或把經審查的 tokenizer 程式編入、釘選在產品供應鏈中。[MLX-LM Supported Models](https://github.com/ml-explore/mlx-lm#supported-models)。

### 4. 更新與回滾

runtime 與 model catalog 必須分開更新：

- **runtime**：隨 app 發行的 signed/notarized arm64 helper，釘選 upstream commit；升級要跑整個 catalog regression suite。保留上一個可運作版本供回滾。
- **catalog manifest**：由產品簽章，app 內建 public key 驗證；manifest 只指向 immutable、hash-pinned artifacts。更新 catalog 不等於自動下載模型。
- **model artifact**：先下載到暫存檔，驗證 signature/hash/metadata 後 atomic rename；支援續傳、取消、磁碟空間 preflight、明確移除與版本共存。
- **相容性**：若 runtime 更新使既有模型失敗，app 應回退 helper，而不是重抓未經同意的模型。

Ollama 官方說明 macOS/Windows 會自動下載更新，且模型預設位於使用者層級的 `~/.ollama/models`；這正是它適合「外部 provider」而非產品內建核心的原因。產品可以顯示偵測到的 Ollama 版本與模型，但不得假設其版本、儲存與回滾受本產品控制。[Ollama FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx)。

## 授權決策

runtime 授權與模型權重授權是兩層獨立義務。`llama.cpp`、MLX/MLX-LM、Ollama repo 為 MIT；MLC LLM 為 Apache-2.0。這不會把其承載的模型變成 MIT/Apache。

模型目錄必須逐 artifact 顯示並保存授權接受紀錄：

- Google Gemma 是 open weights，但受 Gemma Terms 約束；若產品分發模型或 derivative，條款要求提供 agreement、use restrictions 與指定 Notice。不能只標成「Google 開源模型」。[Gemma Terms](https://ai.google.dev/gemma/terms)。
- Meta Llama 使用自訂 Community License；例如 Llama 4 對 redistribution、`Built with Llama`、Notice、acceptable-use 及超大型商業使用另有條件。[Meta Llama 4 License](https://github.com/meta-llama/llama-models/blob/main/models/llama4/LICENSE)。
- Qwen3 官方發表的六個 dense open-weight 模型為 Apache-2.0，但 catalog 仍要以每個具體 model revision 的 LICENSE 為準，不能由家族名推定。[Qwen3 官方公告](https://qwenlm.github.io/blog/qwen3/)、[官方 Qwen3 artifact LICENSE 範例](https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507-FP8/blob/main/LICENSE)。

因此第一版較穩妥的下載流程是：產品發布簽章 catalog 與來源/hash，使用者在 app 內閱讀並接受該 artifact 的授權後，才由裝置直接下載；產品預設不把權重塞進 app bundle。GGUF metadata 可攜帶 license name/link，但只能作顯示輔助，法務資料仍以 catalog 中釘選的 upstream LICENSE 為準。[GGUF metadata 規格](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md)。

## Apple 內建模型的邊界

Apple Foundation Models framework 存取的是 Apple Intelligence 的系統 on-device model，原生支援 structured output 與 tool calling；可用性取決於裝置資格、使用者是否啟用 Apple Intelligence，以及模型是否已下載完成。Apple 也明確提醒應先檢查 availability 並提供 fallback。[Foundation Models 概覽](https://developer.apple.com/documentation/FoundationModels)、[availability 與適用能力](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models)。

這個 provider 具有兩個與開放權重目錄根本不同的契約：

1. 應用程式不能選擇、hash-pin、回滾或重新散布權重；OS 更新可能改變模型行為，必須按 OS/model 版本重跑 prompt 與工具測試。Apple 的更新文件也明確要求在系統模型更新後重新測試 prompt。[Foundation Models updates](https://developer.apple.com/documentation/Updates/FoundationModels)。
2. Apple 官方列出其系統模型不適合基本數學與邏輯推理等情境；財務數字仍必須來自確定性工具，模型只做語言解釋。無論 Apple provider 或 GGUF provider，都不得自行計算帳務事實。

UI 因此應把它標成「Apple 內建（由系統管理）」並提供 availability 狀態，而不是放進可下載模型清單；provider router 可在它不可用或能力測試不符時回退至本機 GGUF 模型。

## 進入實作前仍須用原型驗證

本研究已足以決定架構方向，但下列數值不能靠文件推定，應在實作規劃中安排一個小型 benchmark/security prototype：

1. 在最低支援的 8/16/24/32 GB Apple Silicon 機型，對每個首批候選模型量測記憶體、首 token、生成速度與 context 成本。
2. 驗證簽章後的 Electron app 能在 App Sandbox 下啟動內嵌 arm64 `llama-server`、只讀取 container 內模型並正常使用 Metal。
3. 對 Gemma、Llama、Qwen 各一個候選 artifact 跑相同的繁中、JSON Schema 與財務 tool-call contract tests。
4. 驗證下載中斷、hash 錯誤、惡意/損壞 GGUF、磁碟不足、helper crash、memory pressure、切換模型及 runtime 回滾。

通過這些門檻後再決定第一批具體模型與 RAM 分級；不要先承諾任一模型在特定記憶體容量上的品質或速度。
