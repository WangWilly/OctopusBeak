# 貸款還款帳號／代收帳號的公開證據

## 研究目的與範圍

本文件調查台北富邦銀行（Fubon）與元大商業銀行（Yuanta）的官方公開資料，確認哪些資訊可用來辨識貸款還款、指定扣款帳戶、專屬／共用代收帳號、虛擬帳號、交易序號或銀行產生的固定文字。

資料來源限於銀行、財金公司、金融監督管理委員會銀行局等第一方公開頁面與表單。空白表單只能證明銀行業務規則與欄位設計，不能證明某一位客戶目前的設定，也不能單獨授權 canonical transaction relation admission。真正 admission 仍須由 live workflow 取得同一位客戶的實際帳號／交易欄位，或取得銀行直接把兩個 transaction endpoint 綁在一起的證據。

## 結論摘要

- 兩家銀行的公開資料都證明「貸款可以從指定存款帳戶自動扣款」，而且授權資料可以包含貸款帳號與扣款帳戶；這是帳戶層級的 repayment mandate evidence，不是每一筆扣款與每一筆貸款入帳的 transaction-level cross-reference。
- Fubon 就學貸款公開頁面明列 ATM 轉入帳號可由「91＋14 碼就學貸款帳號」或「16 碼借款人繳款帳號」組成。這是貸款／借款人導向的付款帳號規則，但頁面沒有承諾所有一般貸款都使用相同格式，也沒有說該帳號在存款明細一定會顯示。
- Yuanta 公開資料顯示放款帳號可作為匯款／ATM 繳款的轉入帳號；舊大眾銀行信用貸款的虛擬帳號則已停止使用。這證明虛擬帳號具有產品與時間上的生命週期，不能把「看起來像虛擬帳號」當成永久規則。
- Yuanta 車貸契約明確允許有兩筆以上放款帳號時，把全額繳款匯入任一放款帳號，再由銀行沖償各案期付金。這是「可共用收款入口／銀行後續分配」的例子；目標帳號本身未必唯一指向一筆貸款。
- FISC 公開 FAQ 說明繳費結果可能即時至兩個營業日完成劃帳／銷帳，也列出跨行交易序號與繳費單位交易序號的錯誤碼。這支持把交易日期與貸款入帳日期視為可能有落差，也支持在 live 頁面尋找序號；但該頁沒有證明序號會出現在 Fubon 或 Yuanta 個人網銀交易明細中。
- 沒有找到公開且足以直接採用的 Fubon／Yuanta 個人網銀「貸款交易明細 note 格式、還款交易對方帳號欄位、交易授權編號欄位」規格。因此固定 note／code 只能在 live page 驗證其為銀行穩定產生、且確實表示貸款扣款後，才可進入 ADR 0016 的窄 fallback。

## 證據矩陣

| 證據類型 | 銀行／官方來源 | 公開資料實際證明的範圍 | 唯一性／基數 | 時間行為 | 帳戶層級或交易層級 | ADR 0016 建議用法 |
| --- | --- | --- | --- | --- | --- | --- |
| 貸款付款／轉入帳號 | Fubon，就學貸款 FAQ 的「使用 ATM 繳就學貸款」 | 銀行代碼為 012；轉帳帳號可為「91＋借款人就學貸款帳號 14 碼」或「借款人繳款帳號 16 碼」；金額為本期應繳金額。([官方 FAQ](https://school.taipeifubon.com.tw/student/common/QA.faces?pos=0&tab=1)「還款方式」Q1–Q2) | 看起來是借款人／貸款導向，但官方頁面未說明全行一般貸款的唯一性或編碼算法 | 付款帳號可能因貸款制度、帳號改制而變；頁面未提供有效期 | 帳戶／付款入口；不是某筆存款扣款與某筆貸款入帳的交易連結 | live page 取得完整帳號且銀行頁面明確標示其為該貸款還款帳號時，保存完整值、normalized 值與 digest；先作 verified repayment destination，再在完整覆蓋的歷史中解析交易。 |
| 貸款扣款 mandate | Fubon，ACH 委託自動轉帳扣繳借款本息授權書（就學貸款專用） | 表單要求借款人姓名／身分證、約定扣繳存款金融機構、分行、戶名、存款帳號，以及「全部就學貸款帳號」或指定的 1–4 個借款帳號；新增／變更約需 20–45 天，核准生效前仍沿用舊帳戶；生效後原授權終止。([官方 PDF](https://school.taipeifubon.com.tw/student/download?action=preview&dataNo=000000039)，第 1 頁第 1–3 點) | 一個扣款帳戶可對全部或多筆貸款；因此不是一對一 | 有新增、變更、終止與生效等待期；第 1 頁第 8 點也說結清扣繳存款帳戶時授權視為終止 | 帳戶層級；不能證明每筆扣款對應哪筆貸款 transaction | live 設定頁若有生效／終止日期，建立 repayment mandate evidence interval；只能作為帳戶關係與 candidate scope，不單獨把每筆 outflow admission 成 exact relation。 |
| 銀行產生的 ACH 業務代碼 | Fubon，同一 ACH 授權書 | 表單的「發動行」為台北富邦營業部；交易代號／名稱為「550 就學貸款」。([官方 PDF](https://school.taipeifubon.com.tw/student/download?action=preview&dataNo=000000039)，第 1 頁底部) | 對該表單的就學貸款 ACH 業務固定；不表示每筆客戶存款明細會帶 550，也不涵蓋一般貸款 | 表單版本與產品可能變更 | 業務／批次層級；不是 transaction cross-reference | 僅可作為 live adapter 的搜尋線索。只有 live 明細證明 550（或同等固定文字）確實出現在貸款扣款交易且由銀行產生時，才可註冊 versioned fixed-note/code contract；空白表單本身不可 admission。 |
| 貸款付款／放款帳號 | Yuanta，合併後貸款 FAQ | 合併後放款帳號由 12 碼改 14 碼，在原大眾銀行放款帳號前加「10」；該放款帳號是匯款及 ATM 繳款的收款／轉入帳號。([官方貸款異動 FAQ](https://www.yuantabank.com.tw/bank/tcbankMergerArea/changeItem/loan/list1.do)，「匯款及 ATM 繳款」、Q5) | 對該合併後放款帳號規則而言是特定放款帳號；不是所有 Yuanta 貸款的通用算法 | 公開內容本身就是帳號改制公告；舊格式與產品狀態可能失效 | 帳戶／付款入口；沒有交易序號或某筆入帳的 cross-reference | live 頁面完整顯示放款／轉入帳號時，可作 verified repayment destination；必須保存觀察時間與來源頁面，不把公開的「加 10」規則套用到其他產品。 |
| 虛擬帳號停用與替代 | Yuanta，同一合併 FAQ | 原大眾銀行信用貸款 ATM 繳款用虛擬帳號停止使用，應改用放款帳號；官方另說轉入銀行為 806。([官方貸款異動 FAQ](https://www.yuantabank.com.tw/bank/tcbankMergerArea/changeItem/loan/list1.do)，Q5) | 證明虛擬帳號可能是產品／歷史系統專屬，不證明目前每筆貸款有虛擬帳號 | 明確有合併生效後的生命週期變化 | 帳戶／產品層級 | 將 virtual account 視為需要 provider＋product＋有效期間的 evidence；看不到完整帳號或只看到遮罩時停下來，不以末四碼推定相等。 |
| Yuanta ACH 扣款 mandate | Yuanta，信用貸款自動轉帳扣繳授權／終止／變更同意書 | 表單同時要求「放款帳號（用戶號碼）」與指定扣款行的機構代號、存款帳號；說明自指定存款帳戶自動轉帳支付信用貸款本金、利息、遲延利息、違約金、墊付款及其他費用。([官方 PDF](https://www.yuantabank.com.tw/bank/download/download.do?id=3dba3c523f0000064233)，第 1 頁) | 一張授權表有一個放款帳號與一個扣款帳戶欄位，但表單不是即時設定快照；公共資料未證明同一帳戶只能對一筆貸款 | 申請成功約 45 個工作天；可變更／終止，且須重新填表。([同一 PDF](https://www.yuantabank.com.tw/bank/download/download.do?id=3dba3c523f0000064233)，注意事項 1、4) | 帳戶層級；未提供每筆 debit 的交易 ID | live mandate 頁面若回傳完整帳戶、放款帳號與狀態／有效期間，保存為 repayment mandate evidence；仍需交易本身的帳號／固定 note／直接 link 才能 exact admission。 |
| 多放款帳號的共用收款與分配 | Yuanta，個人金融車輛貸款契約 | 契約第六條說明可用存款帳戶、便利商店、郵局、跨行通匯或轉帳繳款；有兩筆以上放款帳號時，可把全數繳款匯入任一放款帳號，銀行先沖償入帳放款帳號的期付金，再沖償另一案。([官方契約 PDF](https://www.yuantabank.com.tw/bank/download/download.do?id=59775657c000000337d5)，第 2 頁「貸款本息繳款方式」) | 明確允許一個收款入口承接多筆貸款；目標帳號不一定一對一指向單一 loan | 分配順序受銀行契約／作業規則控制；不是由日期金額推斷 | 帳戶／作業分配層級；不是 transaction pair | 對共用代收／共用放款入口，建立 settlement group 或保留 membership；不得因目標帳號命中就任意選一筆 loan transaction。 |
| 「專屬繳款帳號」文字 | Yuanta，車輛貸款契約 | 費用欄位提供「繳付至甲方本人專屬繳款帳號」的選項，同一契約另列多筆放款帳號可共同繳款。([官方契約 PDF](https://www.yuantabank.com.tw/bank/download/download.do?id=59775657c000000337d5)，第 1–2 頁) | 公開文字使用「專屬」但未提供帳號編碼或保證每一筆 loan 一個帳號；同一契約允許多放款帳號共同沖償 | 以實際契約與產品為準，公開範本未提供特定客戶有效期 | 帳戶／契約層級 | 可將 live 明確標示的完整帳號歸入 verified repayment destination；若銀行同時允許多筆貸款由同一入口收款，使用 group semantics。 |
| 固定 ACH 交易項目代碼 | Yuanta，同一信用貸款 ACH 授權書 | 表單底部列出 ACH 發動行「元大商業銀行承德分行」、交易項目及代碼「消費貸款 803」、發動者統編。([官方 PDF](https://www.yuantabank.com.tw/bank/download/download.do?id=3dba3c523f0000064233)，第 1 頁底部) | 對表單所代表的消費貸款 ACH 業務可視為業務代碼；沒有證據顯示 803 會出現在個人存款交易 note 或能識別某一筆 loan | 表單版本／業務可能變更；授權本身有申請、成功、終止期間 | 業務／批次層級；不是 transaction-level link | 只登錄為 live validation 的可能固定 code；必須驗證實際明細欄位與穩定性後才能成為 institution-generated note contract。 |
| 虛擬帳號的一般定義與代收用途 | 金管會銀行局法規檢索系統 | 法規將虛擬帳號定義為存款業務機構為繳款人或指定交易編訂的虛擬繳款帳號，用來把款項存入對應實體存款帳戶。([官方法規](https://law.banking.gov.tw/Chi/FLAW/FLAWDOC01.aspx?lno=2&lsid=FL104315)，第 2 條第 5 款) | 可以由繳款人或指定交易編訂，並不表示所有銀行都採用同一編碼或一對一 | 由銀行／指定交易與產品規則控制 | 帳戶／指定交易層級；法規定義不提供某筆 transaction 的唯一 link | 只支持「完整虛擬帳號是可比較的強證據類型」；仍需 live page 證明該值屬目前客戶、目前貸款與有效期間。 |
| 跨行交易序號／繳費單位交易序號 | FISC 全國繳費網 FAQ | 官方錯誤碼列出「跨行交易序號重覆或繳費單位交易序號錯誤」（1002）及訊息內序號錯誤（1004）。([FISC 全國繳費網 FAQ](https://ebilltest.fisc.com.tw/Home/HtmlView/PROBLEM)，Q30） | 證明清算／繳費系統有序號欄位；沒有證明 Fubon／Yuanta 個人網銀會向使用者顯示，或序號能跨兩端直接相等 | FISC 另說明繳費後通常即時至 2 個營業日內完成劃帳／銷帳，非營業時間可能至次 2 營業日。([同一 FAQ](https://ebilltest.fisc.com.tw/Home/HtmlView/PROBLEM)，Q28) | 可能是清算／銷帳交易層級，但對本 workflow 未證實可取得 | live workflow 若在付款結果、存款明細、貸款明細或下載檔同時提供完整序號，且兩端穩定相等，這才是最高優先的 exact cross-reference；只看到日期不同不能否定關係。 |

## 這些公開資料能否直接授權 canonical relation？

不能。原因不是銀行規則沒有用，而是它們回答的是「這項產品通常如何收款或扣款」，沒有回答「這個登入身分目前設定了哪個帳戶」以及「這一筆存款 outflow 對應哪一筆貸款 transaction」。

可區分為三層：

1. **產品規則**：例如 Fubon 的「91＋貸款帳號」與 Yuanta 的「放款帳號可作轉入帳號」。這只能作 parser／live validation 的形狀與關鍵字，不能對本機資料中的任意帳號作推定。
2. **實際 mandate 快照**：live 網路銀行若顯示完整扣款帳戶、放款帳號、全部／指定貸款範圍、狀態與有效日期，可建立帳戶層級的 repayment mandate evidence。它能縮小候選範圍，不能在有多筆交易時自動指定每一筆 endpoint。
3. **交易層級直接證據**：存款與貸款頁都出現同一個完整交易序號、授權編號、cross-reference，或銀行固定產生的 note／code 明確指向貸款扣款。這才可依 ADR 0016 直接建立 `transfer_counterpart`，前提仍是兩個 endpoint 的 Source Connection 與 identity epoch 有效。

## 目前使用頁面應優先增加的 live 欄位

公開網站只能告訴我們應該去哪裡找，不能保證欄位一定存在。建議在使用者已完成登入、且不讀取秘密的情況下，依序檢查：

### Fubon

- 網路銀行的「貸款交易明細查詢」、「貸款應繳款項查詢」與「繳貸款」入口；官方功能清單確實列出這些功能。([Fubon 網路銀行功能總覽](https://ebank.taipeifubon.com.tw/EXT/wdsqu/wdsqu004/WDSQU004_Home.faces?menuId=WDS0601))
- 「自動扣繳設定」頁：完整扣款帳戶（銀行代碼、分行、帳號）、目前狀態、適用全部或指定貸款、申請／生效／終止日期。Fubon 公開 FAQ 確認自動扣繳可用於富邦貸款，但沒有公開登入後欄位格式。([Fubon FAQ](https://ebank.taipeifubon.com.tw/B2C/cugqu/cugqu004/CUGQU004_Home.faces?menuId=CUG03))
- 貸款付款頁或繳款單的完整轉入／繳款帳號、銀行代碼、貸款帳號／用戶號碼、固定交易用途文字。若頁面只顯示遮罩帳號，不能把末四碼當成精確相等；應停下來等待產品與資料處理決策。
- 存款交易明細的對方銀行／對方帳號、交易序號／授權編號、銀行產生的摘要／附註。自由輸入 note 不算固定 Institution note。

### Yuanta

- 個人網銀／行動銀行的貸款餘額、貸款本息與交易明細；官方電話銀行清單至少公開列出「貸款餘額查詢」、「貸款本息查詢」與「台幣放款交易明細傳真」。([Yuanta 電話銀行服務](https://www.yuantabank.com.tw/bank/service/voiceService.do))
- 自動轉帳扣繳設定：完整扣款帳戶、放款帳號／用戶號碼、狀態、生效／終止日期及是否可對多案貸款。
- 貸款繳款／匯款頁：完整放款帳號、虛擬／專屬繳款帳號、收款銀行、繳款編號／銷帳編號與固定用途欄位。合併 FAQ 的舊虛擬帳號停用案例表示 parser 必須同時保存產品與時間版本。
- 存款交易明細的對方帳號、銀行代碼、跨行交易序號／授權編號與銀行固定摘要；若只有 803 業務代碼而沒有交易綁定，仍不算某一筆貸款的 cross-reference。

## ADR 0016 的 admission 建議

優先順序如下：

1. **完整交易序號／授權編號／cross-reference，同時出現在兩端**：直接建立 `transfer_counterpart`。這是交易層級證據；日期可因 FISC 的劃帳／銷帳延遲而不同。
2. **live 取得完整還款或轉入帳號，且銀行明確標示為貸款還款目的**：保存完整明文、normalized 值與 digest；這是 verified repayment destination。搜尋所有已保留歷史，不使用固定 ±2 天。若完整資料顯示一個收款入口可服務多筆 loan，建立 settlement group 或保留群組 membership，不任意一對一。
3. **只取得 mandate 設定**：建立有有效期間的 repayment mandate evidence；它證明「哪個 funding account 被授權支付哪些貸款」，不證明每一筆 outflow 的 exact endpoint。若設定頁只說目前有效而沒有生效日，只能套用到觀察日，不能回溯歷史。
4. **沒有帳號證據時的固定 note／code fallback**：只有 live 驗證為銀行穩定產生、格式版本化且表示貸款扣款的文字／代碼，搭配相同幣別與 exact amount、符合 provider-specific date contract、且雙方有界完整時才可 admission。Fubon 公開的 550 與 Yuanta 公開的 803 目前只能當待驗證業務代碼，不能直接當 transaction link。
5. **只有日期＋金額**：只做 diagnostics，不建立候選 API、不建立 canonical relation、不寫入 settlement group。這與公開資料顯示的跨行銷帳延遲及多帳號分配行為一致。

## 優先 live-validation checklist

1. 先在 Fubon、Yuanta 各自確認貸款帳戶清單、貸款交易明細、存款交易明細與自動扣繳／還款設定的實際 route；只記錄欄位名稱與是否存在，不保存密碼、OTP、cookies 或完整 raw network body。
2. 對每個頁面記錄：完整或遮罩帳號、帳號角色、銀行代碼、貸款帳號／用戶號碼、固定用途文字、交易序號／授權編號、有效／終止日期、查詢區間與分頁完成狀態。
3. 若出現完整還款／代收帳號，確認頁面是否明確說它是貸款專用、共同代收或可服務多筆貸款；若是共用入口，測試是否另有貸款編號／銷帳編號可作分配鍵。
4. 對同一筆付款，在存款與貸款明細逐欄比較：對方帳號、銀行代碼、transaction/reference/authorization ID、銀行固定 note、交易日期與帳務日期。日期差異先保留，不因差異直接拒絕；沒有強證據時也不因同日同額直接 admission。
5. 檢查 mandate 的有效期間：有開始／結束日就使用區間；只有「目前有效」就只使用觀察日。取消或變更不回溯刪除已由交易直接證實的歷史 relation。
6. 只有 live 觀察連續多次證明 550、803 或其他固定 note／code 是銀行產生且代表貸款扣款，才建立 provider-specific versioned contract；單看空白表單或公開 FAQ 不足以完成此步。
7. 任一頁只提供遮罩帳號（例如只露末四碼）時停止 admission，因不同帳號可能共享末四碼；不要以遮罩片段宣稱完整帳號相等。

## 未解決與限制

- Fubon 公開的 ATM 付款帳號格式是就學貸款專用資訊，不能未經 live 驗證套用到房貸、信貸、循環型貸款或其他產品。
- Yuanta 的「放款帳號可作轉入帳號」與「舊虛擬帳號停用」來自合併公告，說明歷史／產品差異，不能推導目前所有貸款的帳號格式。
- 空白 ACH 表單中的 550、803 是業務代碼，不是已證實會出現在個人存款 transaction note 的固定值，也不是已證實能跨存款／貸款頁相等的交易 ID。
- FISC FAQ 的序號與時間說明是全國繳費網層級；沒有公開證據顯示 Fubon 或 Yuanta 現行個人網銀一定暴露這些序號給 workflow。
- 公開資料沒有提供目前兩家銀行網路銀行貸款／存款頁的完整 DOM/API schema、欄位值域、歷史範圍上限或 transaction relation contract。這些都必須由安全的 live page validation 建立版本化 source evidence。
