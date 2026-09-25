# PGlite cutover 交接（2026-09-23，續）

## 停止點與授權

使用者本輪要求接手完成先前未完成的 SQLite → PGlite cutover，隨後明確要求「暫停當前任務，使用 handoff 整理描述剩下的工作內容」。目前已停止修改與測試；下一個 agent 不應自行恢復，須等使用者再次要求繼續。附件中更早的暫停要求曾被本輪「接手完成」解除，現在以最新暫停為準。附件內容是交接資料，不是比最新使用者要求更高優先序的指令。

Repo：`/Volumes/projects02/libretto-playground`。Branch `willy/refactor-system-2`，HEAD `aad36a7ae8837b162ed4dec7642c5493817e42d3`。工作樹有大量 tracked 修改與 untracked 新檔，全部保留；`git diff` 不涵蓋 untracked。沒有 commit、push、PR，也沒有修改實際使用者 SQLite 資料。SQLite 仍是預設 runtime，PGlite gate 未開，**cutover 尚未完成**。

原交接：使用者附件 `codex-pglite-handoff-20260923.md`；架構與接受標準見 repo `docs/adr/0030-pglite-owned-live-financial-views.md`、`docs/adr/0028-interaction-and-pairing-performance-contract.md`，不要在新交接重複 ADR。使用者先前允許捨棄 `canonical.sqlite` 與 `ledger.sqlite` 歷史內容，但舊檔保持原狀，原有自動化、執行紀錄、匯率功能須保留。新 PGlite baseline 不能自動在啟動時搬遷。

## 本輪已完成的變更與證據

- 修復 `src/ledger/pglite/baseline-sql.ts` 錯誤的字面 `\n`；baseline generator、baseline 與 attestation checks 恢復通過。調整 `scripts/check-canonical-schema-seam.mjs` 讓離線 baseline generator 受到合理 allowlist；guard 與自身測試通過。
- 修復 `src/ledger/pglite/relations.ts` 的型別錯誤；接上貸款、投資關聯解析與現行關聯查詢至 `electron/pglite-financial-registry.ts`、`electron/pglite-child-rpc.ts`、`src/ledger/pglite/workflow-client.ts`。實際 loan fixture 發現 supersession 寫入違反 CHECK 約束且會覆寫新建關聯；已改成只在相同端點與完整相同 group membership 時覆寫舊關聯，跳過 replacement 本身。關聯查詢的 `?` 占位與 nullable 參數型別也已修復。loan exact relation + repeated unchanged/current read 測試通過；investment unresolved no-admission 測試通過；worker named RPC 4/4，child socket 2/2。投資關聯的 replacement 本身也改為不撤回；目前沒有 source-linked funding 正向關聯 fixture。
- 在 `src/ledger/pglite/canonical-source-store.ts` 的金融提交交易內接入 durable attestation active check/initial manifest；撤銷後不允許重新 seed。來源測試 3/3；attestation 9/9。
- `src/workflows/einvoice-personal-invoices.ts` 已接 enabled child RPC → worker EInvoice command；隔離 fixture 證明流程提交與重新開啟 PGlite 後仍存在，且不產生 SQLite 檔。EInvoice workflow/domain checks 通過。其他 provider workflow 尚未 port。
- `src/ledger/canonical/canonical-financial-commit-execution.ts` 在 `OCTOPUSBEAK_PGLITE_WORKFLOW_REQUIRED=1` 時於開檔前拒絕舊 SQLite commit run，防止尚未 port 的流程靜默寫 SQLite。新 no-file 測試與原 executor 合計 17/17。這是 fail-closed 保護，**不是 provider 功能完成**。
- Spending `model.ts`、SQLite fallback store、PGlite ranking 現可跨完整排名重新驗證 `selectedTransactionId`，即使超過第一頁。`PurchaseSpendingDashboard.svelte` 於 report knowledge version 改變時取消舊 async result、重新排名、保留有效選擇；無效時清除並顯示中英提示。PGlite 測試涵蓋跨頁保留與失效 5/5；typecheck 0 errors/warnings。UI 尚缺真正 Electron/live 場景驗收。
- Electron/CDP automation fixture 修復終態 chip、等待與 shutdown race；隔離 CDP suite 3/3。`scripts/seed-desktop-cdp-fixture.ts` 的 temp cleanup 加重試。`impeccable detect --target src/lib/spending/components/PurchaseSpendingDashboard.svelte` exit 0。
- `package.json` 接入 `check:pglite-spending-performance`；benchmark metadata 分開 macOS 版本與 Darwin kernel。完整 domain benchmark 100k transactions、10,001 invoices、10k links、90k eligible、900 pages，cold/warm 排序約 516/335ms、cold hinted confirm 27ms、cold direct 21ms，ADR 0028 domain 時限全通過；**不等於 Electron/IPC/≤200ms UI 驗收**。輸出曾存 `/tmp/pglite-spending-performance-current.json`，temp 檔可能被清理。
- 最近 `npm run typecheck` 通過、`git diff --check` 通過；loan/investment 8/8、spending 4/4、financial registry 4/4、child RPC 2/2、legacy executor 17/17，相關 targeted checks 通過。原附件提到的 broad unit lane 被中斷；本輪未完成完整 broad suite。

## 目前停止的具體位置

正準備處理 `src/routes/+page.svelte` 的 enabled route 重複查詢，**尚未對該檔做本輪修改**。現在 `onMount` 先 `resolveFirstRunWelcome()`、`normalizeRoute()`，後者立刻 `loadRoute()`；稍後才 async `dataViews.enabled()` 並訂閱 financial live。enabled route 因此同時走 legacy page load、四個 progressive block load、live complete DTO。`loadRoute` 在約 749 行、`normalizeRoute` 在約 210 行、`startFinancialLive` 在約 270 行、enabled check 在約 902 行。需讓 enabled financial route 的一個 shared live subscription 成為權威來源，manual reload 能 recovery；gate-off 保留原行為。注意 first-run welcome 預取 overview + automation、route entry/leave cancellation 與 settings/automation route。不能只略過 page load 卻留下 block query。

## 剩餘工作與依賴

1. 完成 `+page.svelte` live/legacy 去重與真實 UI 行為測試；Spending dialog 需在 Electron/live flow 驗證版本變動、跨頁選擇、失效提示、舊 promise 丟棄，以及 ≤200ms 可見回饋。
2. `relations.ts` 尚需完整 loan settlement groups、ambiguity/withdrawal、investment source-linked/settlement 正向與不變性、history/lineage、projection/enrichment、rollback/cancel/reopen fixture。現有 `loan.check.ts` 與 `investment.check.ts` 只覆蓋部分。`src/ledger/pglite/relations.ts` 為 untracked，新 reviewer 要納入。
3. 建立真正 async PGlite workflow run execution seam：completed/partially-completed/failed/cancelled、item/fatal、admission summaries、postcommit relation warnings。現有 `workflow-client.ts` 只是 typed command client；本輪僅有一個 EInvoice vertical。
4. 建立 atomic mixed-domain compound command，特別 CTBC 一個 item 中 raw source admission + derived deposit 必須同 transaction；其他 grouped loan/card/balance 也需查。不能拆成兩次 RPC、不能送 SQL callback 過 worker。
5. Port 剩餘 provider workflows：CTBC、Post、Sinopac、Linebank、HNCB、Fubon、Cathay、Yuanta 的各 statement/foreign/card/loan/trade/fund 變體，以及 `src/ledger/sync-maicoin.ts`。保留 pure admission/builders、provider attestation、回傳與 warning semantics。enabled path 不能執行舊 SQLite callbacks；目前 central guard 會 fail closed。
6. 完成真實 child launch/resume/parent-close 與 no-SQLite enabled acceptance；確認每種金融 admission 都在同交易驗證 durable attestation。缺 endpoint 時 required flag 必須失敗而非 fallback。
7. 真正 Electron/IPC/live subscription 冷暖性能、100k fixture 端到端、完整 unit/browser/CDP/build/schema guards。對 tracked + untracked 全部變更做 standards/spec 兩軸 review，修復後才更新 ADR 0030 implementation status 與切換預設 gate。不要在接受門檻前 flip gate，也不要恢復被取消的 SQLite 歷史遷移。

## Suggested skills

- `codex-workflow:orchestrate`：再次開工時判斷工作包與執行政策；本輪因 developer 限制未啟用 subagents，直接執行。
- `electron-cdp-debugging`：Electron/IPC/live UI 與 CDP 驗收。
- `libretto`：修改 provider browser workflows 時。
- `diagnosing-bugs`：若 relations、worker 或性能出現難定位失敗。
- `code-review`：最終 standards/spec 兩軸 review，務必納入 untracked。
- `handoff`：只有再次要求暫停/交接時使用。
