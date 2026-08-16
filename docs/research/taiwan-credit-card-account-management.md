# 台灣銀行信用卡帳戶管理與 Financial Account identity

## 研究問題

台灣銀行如何區分信用卡契約／授信帳戶、帳單與付款單位、正卡與附卡、卡片及卡號？這些事實能否支持以卡號末碼推導 canonical `Financial Account`？本筆研究只作 model reference，不代表 OctopusBeak 要串接任何一家銀行。

## 結論先行

官方資料支持下列邊界：

1. **卡片不是帳戶。** 發卡機構可以在同一正卡帳戶下管理多種卡別（含正卡、附卡），並讓它們共用信用額度；卡片是可被補發、換發、到期續發的支付憑證。
2. **正卡帳戶／歸戶是授信與帳務聚合單位。** 正卡人對本人與附卡產生的應付帳款負責；附卡權利、額度與正卡契約狀態通常受正卡影響。銀行也會把回饋、代扣繳或帳單付款歸到正卡人的信用卡帳戶。
3. **帳單週期不是帳戶 identity。** `入帳日`、`結帳日`、`繳款截止日`與帳單是帳務生命週期；同一帳戶可有多張卡及不同卡號的交易，不能用帳單日期或卡號末碼代替帳戶 identity。
4. **換卡通常延續契約／帳戶關係，但卡號可能改變。** 玉山明示換卡後卡號可能異動，並將代扣繳轉至同一歸戶內的其他正卡；富邦條款則明示可換新卡號或沿用原卡號而契約繼續有效。這直接反駁「卡號不變才是同一帳戶」的假設。
5. **公開銀行文件未必提供可供第三方穩定重建的 account-level key。** 文件提供的是正卡帳戶、歸戶、信用卡帳戶、銷帳編號等業務概念；若來源 Capture 只有卡號、末四碼、卡別或持卡人 label，不能自行推導同一 Financial Account。這是對現有證據的保守推論，不是銀行資料庫 schema 的斷言。

因此，信用卡 integration 的 contract 應要求來源明確提供或可驗證地映射到**帳戶層級 stable source key**，並將 `Card Instrument`（卡片／卡號生命週期）作為帳戶下的子識別。若只有 card key 而沒有帳戶歸屬證據，該 Capture 不符合目前 Model；不可把同一家銀行的所有卡合併，也不可把每張卡都當成一個 Financial Account。

## 主管機關基準

金融監督管理委員會的《信用卡定型化契約範本》將「持卡人」定義為包含正卡與附卡持卡人，並把「信用額度」定義為發卡機構依信用資料核給持卡人累計使用信用卡所生帳款的最高限額；同一範本另把入帳日、結帳日、繳款截止日與帳單分開定義。這表示法規模型至少分出持卡人／契約、信用額度、交易入帳及帳單週期，不能把卡片表面的卡號當成全部語義。[金管會《信用卡定型化契約範本》](https://law.fsc.gov.tw/LawContent.aspx?id=FL049932&kw=.%E8%A9%90&media=print)

範本第三條規定，正卡持卡人得為第三人申請附卡；正卡人對本人與附卡使用所生應付帳款負責，正卡人可通知停止附卡使用，且正卡契約停止或終止時附卡通常隨之停止或終止。這是「附卡從屬於正卡契約／帳戶關係」的法規基準，不等於附卡與正卡共用同一個持卡人 identity。[金管會《信用卡定型化契約範本》](https://law.fsc.gov.tw/LawContent.aspx?id=FL049932&kw=.%E8%A9%90&media=print)

《信用卡業務機構管理辦法》則把正卡申請人的還款能力、身分及債務列為核卡管理事項，另規範附卡申請人的資格。它支持「授信核給以正卡申請人／正卡關係為核心」的解讀，但沒有提供一個可由外部資料通用推導的 account identifier。[金管會《信用卡業務機構管理辦法》](https://law.fsc.gov.tw/LawContent.aspx?id=FL006433&kw=%E5%BA%97%E5%85%A7&media=print)

## 玉山銀行

### 正卡、附卡與共享額度

玉山信用卡申請說明寫明：信用額度依個人財務狀況核定；若名下持有附卡或其他種類卡別，仍共用一個信用額度。[玉山信用卡申請說明 PDF](https://www.esunbank.com.tw/bank/_/media/42072dd851d64531bd168ae73bc65680.pdf)

玉山申請書另提供「指定附卡可使用額度」欄位，並寫明同一正卡人名下同一附卡人的所有附卡共用其指定額度。這證明附卡額度可以是正卡授信額度下的二級限制，而不是一個獨立授信帳戶。[玉山信用卡申請書 PDF](https://www.esunbank.com.tw/bank/_/media/1424598A03AB46D0B573BAC5F27D9ABB.pdf)

玉山的 e 指附卡說明更直接寫明附卡「附屬於正卡名下」，正卡人未持有卡片時不能單獨申辦附卡。[玉山銀行 e 指附卡](https://event.esunbank.com.tw/credit/1090603ecard/index.html)

### 帳戶、帳單與交易時間

玉山信用卡約定條款把消費交易列在帳單／帳務生命週期中，並以「入帳日」說明銀行代持卡人付款或負擔墊款義務、登錄於持卡人帳上的日期；條款同時區分結帳日與繳款截止日。這些是 transaction／statement timing，不是卡片 identity。[玉山信用卡約定條款 PDF](https://www.esunbank.com.tw/bank/_/media/E7400DE731184286A4D5D898C1B57ECF.pdf)

### 換卡與卡號生命週期

玉山公務人員國民旅遊卡公告說明，換發新卡後卡號會異動；水電瓦斯等代扣繳會自動轉由同一「歸戶」內任一張正卡流通卡繼續扣繳，其他代扣繳則可能需由持卡人自行變更卡號。公告也說換卡時會同步換發名下附卡，正卡開卡後舊卡及附卡停用。[玉山公務人員國民旅遊卡公告](https://event.esunbank.com.tw/credit/travel-card-activity/index.html)

這是很強的實例：同一歸戶內存在多張正卡／附卡，卡號可以變動，部分服務仍以歸戶延續。故 canonical collection 不應用卡號作為不可變 Financial Account key；卡號應記為 Card Instrument 的歷史／目前識別，並保留銀行提供的 replacement relation（若來源有提供）。

## 台北富邦銀行

### 正、附卡與額度／付款範圍

富邦用卡須知寫明正、附卡暨所有卡別共用同一信用額度，正卡人可指定每一附卡人每期消費上限；新申請與現有附卡對正卡人新增應付帳款的責任也在文件中分開說明。[富邦信用卡用卡須知 PDF](https://www.fubon.com/banking/document/personal/credit_card/TW/card_rights_02.pdf)

富邦申請書的自動轉帳授權範圍是「本人於本行所持有之所有信用卡正卡及其附卡」的應付帳款，表示銀行付款設定可以涵蓋同一客戶名下多張正卡與附卡；這不能反推所有正卡必然是同一個信用卡帳戶，但足以證明「一張卡＝一個付款單位」是不可靠的。[富邦信用卡綜合版申請書 PDF](https://www.fubon.com/banking/document/form/TW/bankcard.pdf)

富邦約定條款將「信用卡銷帳編號」定義為發卡機構為供持卡人繳納應付帳款所編訂的帳號，同時把入帳日、結帳日、繳款截止日及帳單分開定義。這個銷帳編號是付款／對帳識別，不應在沒有來源 contract 的情況下直接當成 Financial Account identity。[富邦信用卡約定條款 PDF](https://www.fubon.com/banking/document/form/TW/creditcard_provision.pdf)

### 附卡的契約從屬性

富邦條款規定正卡人可申請附卡；正卡人對附卡應付帳款負責，正卡人的額度調整、拒絕授權、暫停或強制停卡等效力及於附卡，正卡人也可停止或終止附卡使用。這與金管會範本的關係一致：附卡是正卡契約下的 Card Instrument／持卡人，而非可由卡號獨立推導的 Financial Account。[富邦信用卡約定條款 PDF](https://www.fubon.com/banking/document/form/TW/creditcard_provision.pdf)

### 補發、換發、續發

富邦條款明確允許因遺失、被竊或損壞而「更換新卡號或使用原卡號」換發，且在有效期屆滿續發時原約定條款繼續有效，不需另行換約。這直接說明卡號是可變的 instrument identifier，而契約／帳務關係可以延續。[富邦信用卡約定條款 PDF](https://www.fubon.com/banking/document/form/TW/creditcard_provision.pdf)

## 元大銀行

### 「同一正卡帳戶」與共享額度

元大信用卡用卡須知使用「同一正卡帳戶」一詞：同一正卡帳戶下所持有的各類信用卡別（含正、附卡）共用同一信用額度。這是目前三家銀行中最直接把帳戶層級與卡別層級分開寫出的官方文字。[元大銀行信用卡用卡須知](https://www.yuantabank.com.tw/bank/creditCard/creditCardInstruction/list.do)

元大文件也說，若同時申請多張信用卡或附卡，銀行最後核准的信用額度由各卡共用；這可支持 canonical model 建立「account／credit-limit group → card instruments」的關係，但不能據此宣稱同一持卡人所有正卡都一定屬於同一正卡帳戶。[元大銀行信用卡約定／合併說明](https://www.yuantabank.com.tw/bank/tcbankMergerArea/changeItem/list2.do)

### 換卡後續與代扣繳

元大公用事業／路邊停車代繳約定書寫明，指定代繳信用卡因遺失、毀損或到期續卡而換發時，銀行得以新編號或號碼繼續扣繳。這表示某些代扣繳關係由銀行在換卡後延續，不能把原始卡號視為永遠不變的付款 identity。[元大銀行代繳約定書 PDF](https://www.yuantabank.com.tw/bank/download/download.do?id=275bec82fd00000264be)

元大 FAQ 說明到期前約一個月主動寄發新卡；這是 Card Instrument lifecycle 的正常事件，不代表建立了新的信用卡契約或新的 Financial Account。[元大信用卡 FAQ](https://www.yuantabank.com.tw/bank/creditCard/creditCard/faq/list.do?id=275b6a9a5c0000078b93)

## 跨銀行比較

| 業務概念 | 玉山 | 富邦 | 元大 | Model implication |
| --- | --- | --- | --- | --- |
| 正卡／附卡 | 附卡附屬於正卡名下；共享額度 | 正、附卡及所有卡別共享額度，附卡受正卡狀態影響 | 同一正卡帳戶下各卡別共享額度 | 需要 account-to-card relation；不能將每卡獨立成 Financial Account |
| 多種卡別 | 名下附卡或其他卡別可共用額度 | 自動扣款授權可涵蓋所有正、附卡 | 同一正卡帳戶可有各類卡別 | 「卡別／卡面」不是帳戶 identity |
| 帳務單位 | 入帳日、結帳日、繳款截止日分開 | 另有信用卡銷帳編號 | 以正卡帳戶與額度說明 | statement/payment key 與 account key 分開 |
| 換卡 | 卡號異動，部分代扣繳按歸戶延續 | 可原卡號或新卡號換發，契約繼續 | 代扣繳可按銀行新編號／號碼延續 | Card Instrument 是可替換的；需 replacement lineage |

## 對 OctopusBeak Model 的限制與建議

### 建議的最小關係

在不假設銀行內部 schema 的前提下，canonical domain 至少應能表達：

```text
Financial Account (source-scoped, stable account key)
├─ Card Instrument 1 (card key / card number / validity / status)
├─ Card Instrument 2 (additional or replacement card)
└─ Account-level billing/credit facts
   ├─ credit limit / available limit observation
   ├─ statement cycle and due date
   └─ transactions attributed to an account and optionally a card instrument
```

其中 `Card Instrument` 可因補發、掛失、到期或產品換卡而新增；同一 Financial Account 的歷史交易不能因卡號變更而被視為新帳戶。若來源只呈現卡號，最多建立 Card Instrument candidate；只有來源 contract 能證明卡號與帳戶層級 key 的歸屬時，才可建立 canonical Financial Account relation。

### New collection admission

Canonical reset 後的新信用卡 Capture 應採以下 admission；舊資料不參與判斷，也不建立相容例外：

- 有銀行提供的 account-level key，或來源明確提供「同一正卡帳戶／歸戶」且能在 Capture 內穩定定位：可建立 Financial Account，並把卡號／卡末碼放在 Card Instrument。
- 只有卡號、末四碼、卡別名稱、持卡人名稱或同一家銀行 label：不能推導 account identity；該次 Capture 失敗並發出 integration error，不建立 provisional 或 legacy identity 例外。
- 同一銀行出現多個 card keys：不能直接合併成一個帳戶，也不能直接各自建立帳戶；必須等待來源 contract 提供 account-level relation。
- 同一 card key 跨 Capture 出現：只能說明來源 key 可能穩定，仍須由 integration contract 確認它代表 Card Instrument 還是 Financial Account；不能靠字串相等自行提升語義。
- 新卡與舊卡同時出現：若來源提供 replacement／renewal relation，兩者屬同一 Financial Account 下不同 Card Instruments；若沒有 relation，兩者不能自動合併。

### 不應採用的推導

以下規則均沒有被本研究的官方資料支持：

- `bank + product + cardKey` 永遠等於 Financial Account。
- 同一家銀行同一個持卡人名下的所有正卡必然是同一帳戶。
- 相同卡號末四碼代表同一帳戶。
- 同一帳單日期或同一結帳日代表同一帳戶。
- 卡號改變必然代表新 Financial Account。

這些字串可作 display label、去重輔助或待驗證 source key，但不能在 strict admission 中充當未經 contract 證明的帳戶 identity。

## 證據邊界

本研究找到的是銀行對外約款、申請書、用卡說明、公告與主管機關規範。它們足以確認正卡帳戶／歸戶／卡片／帳單之間的業務關係與換卡語義，但沒有公開三家銀行一致的 API schema 或可跨銀行使用的 account identifier 欄位。因此「需由 integration contract 提供 stable account key」是對 domain identity 的設計推論；不是聲稱所有銀行都不提供該欄位。實作時應先檢查實際下載報表或頁面是否有帳戶號碼、繳款編號、歸戶識別或其他銀行明示的 account-level key，並將其語義寫入該 integration contract。
