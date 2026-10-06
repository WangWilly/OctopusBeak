![OctopusBeak 橫幅](docs/assets/octopusbeak-readme-banner.webp)

# OctopusBeak

[English](README.en.md)

把散落在銀行、證券帳戶和電子發票裡的資料收回自己的 Mac。OctopusBeak 會開啟金融服務網站、下載對帳單、整理成本機帳本，讓你在同一處查看資產、負債與支出。

## 下載與安裝

目前只提供 **macOS Apple Silicon（arm64）** 版本。Windows、Linux 與 Intel Mac 尚未支援。

[下載最新版 OctopusBeak](https://github.com/WangWilly/OctopusBeak/releases/latest)

1. 從最新版本頁面下載 DMG。
2. 開啟 DMG，將 OctopusBeak 拖進「應用程式」。
3. 從「應用程式」啟動 OctopusBeak。

建議使用 DMG 安裝。也提供 ZIP，並附上 `SHA256SUMS.txt` 供你核對檔案。

## 你可以用它做什麼

### 把資產與負債放在同一張總覽

總覽會整理匯入的銀行存款、外幣、基金、證券、加密資產與貸款。快照歷史保留每天的變化，也能看出資產配置和負債曝險。

![OctopusBeak 繁體中文總覽](docs/assets/readme-overview-zh.png)

### 查看資產變化與帳戶明細

資產頁依銀行、基金、券商、加密資產與外幣分組。你可以查看餘額趨勢，再往下查交易或持倉。

![OctopusBeak 繁體中文資產頁](docs/assets/readme-assets-zh.png)

### 整理電子發票與帳戶支出

消費頁把電子發票和帳戶支出放在一起，依月份與類別統計。發票品項可以逐筆查看，也能自行修正分類。

![OctopusBeak 繁體中文消費頁](docs/assets/readme-spending-zh.png)

### 從桌面程式收集資料

自動化頁面集中管理資料來源、登入資料、執行紀錄與人工協助。每個來源可以個別啟用，並選擇要收集的對帳單類型。

![OctopusBeak 繁體中文登入資料設定](docs/assets/readme-automation-settings-zh.png)

## 第一次使用

1. 開啟 OctopusBeak，在歡迎畫面選擇語言與是否開始設定。
2. 選擇一個資料來源，填入登入資料和要收集的對帳單類型。
3. 執行資料收集。網站要求的 CAPTCHA 由 App 在本機自動辨識；國泰世華的 Email OTP 透過你授權的 Gmail 自動取得。
4. App 驗證來源完整性後，直接將可接受的資料寫入本機資料庫。
5. 回到總覽查看結果。

程式會記住初始設定的進度。中途關閉也沒關係，下次開啟可以接著做；日後也能從設定重新開始。

## 支援的資料來源

| 資料來源 | 可收集資料 |
| --- | --- |
| 台北富邦銀行（Fubon） | 台幣存款、信用卡、貸款 |
| 玉山銀行（ESun） | 信用卡 |
| 元大銀行（Yuanta） | 台幣存款、外幣、貸款、信用卡、基金 |
| 元大證券（Yuanta Trade） | 持倉與交易紀錄 |
| 國泰世華銀行（Cathay） | 台幣存款、外幣 |
| 華南銀行（HNCB） | 台幣存款 |
| 中國信託銀行（CTBC） | 台幣存款 |
| 中華郵政（Post Office） | 台幣存款 |
| 永豐銀行（SinoPac） | 台幣存款、外幣 canonical 交易（human-attested identity contract） |
| LINE Bank | 台幣存款、外幣 |
| 電子發票（E-Invoice） | 發票與消費品項 |
| MAX / MaiCoin | 加密資產餘額與交易紀錄 |

SinoPac 外幣資料會保留為可追溯的帳務來源記錄，符合 human-attested identity contract 的列會升格為 canonical Financial Transaction。外幣 canonical 交易目前在 SinoPac、元大、國泰世華與 LINE Bank 的 advertised readiness 中提供。

## 資料留在你的裝置

帳務資料、自動化設定與執行摘要都存放在本機資料庫。App 在記憶體中處理來源內容，不另外保存來源下載檔、產生的 CSV／JSON 或原始日誌；結構化執行事件保留 30 天。登入資料也只存在你的 Mac，並由 Electron `safeStorage` 加密；如果系統無法安全加密，OctopusBeak 會停止啟動，不會把密碼寫成明文。

CAPTCHA、OTP、工作階段 Cookie 與其他驗證資訊不會交給模型處理。CAPTCHA 由裝置上的辨識程式在本機解答；無法自動完成的驗證會讓該次收集失敗並顯示原因。

## 開發者資訊

<details>
<summary>從原始碼執行</summary>

專案文件的權威來源與維護方式請見[文件索引](docs/README.md)。

```bash
npm install
npm run typecheck
npm run desktop:dev
```

桌面介面僅支援 Electron，並從 `#/overview` 載入靜態渲染器。

建立未簽署的本機應用程式：

```bash
npm run desktop:package
open out/OctopusBeak-darwin-arm64/OctopusBeak.app
```

簽署與公證流程請參閱[桌面版發行文件](docs/desktop-release.md)。

</details>

<details>
<summary>CLI 與本機帳本</summary>

正式工作流程由桌面 App 啟動。開發 typed workflow 時，使用專案 CLI 與測試 fixture：

```bash
npm run workflow:dev -- help
npm run workflow:dev -- list
npm run workflow:dev -- fixture
```

新增與測試 workflow 的步驟請參閱[開發指引](docs/agents/workflow-development.md)。正式的銀行、發票與同步工作請從桌面 App 的自動化介面執行。

金融資料由桌面程式的 PGlite worker 儲存在 `data/pglite/`。

</details>

<details>
<summary>專案路徑與檢查指令</summary>

| 路徑 | 用途 |
| --- | --- |
| `src/workflows/` | 銀行與來源工作流程定義；正式工作由桌面 App 的 typed runtime 執行 |
| `src/ledger/` | 來源解析、PGlite 儲存與財務查詢 |
| `src/lib/overview/`、`src/lib/assets/`、`src/lib/liabilities/` | 財務總覽介面 |
| `src/lib/spending/` | 電子發票與消費介面 |
| `src/lib/automation/` | 自動化介面與伺服器端輔助程式 |
| `electron/` | Electron 主程序與執行環境輔助程式 |
| `data/pglite/` | 本機 PGlite 資料 |
| `~/Library/Application Support/OctopusBeak/` | 安裝版的執行資料 |

提交變更前請執行：

```bash
npm run typecheck
npm run build
npm run privacy-check
npm run secrets-check
```

</details>
