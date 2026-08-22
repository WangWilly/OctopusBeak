import type {
  AutomationCredentialGroup,
  AutomationCredentialRedaction,
  AutomationExternalPrerequisite,
  AutomationTaskKind,
  AutomationTaskSummary,
} from "../types.ts";
import { BANK_STATEMENT_CAPABILITIES } from "../statement-selection.ts";

export type { AutomationCredentialGroup, AutomationTaskKind, AutomationTaskSummary } from "../types.ts";

export const YUANTA_SERVISIGN_PREREQUISITE: AutomationExternalPrerequisite = {
  id: "yuanta-servisign",
  provider: "Yuanta",
  component: "YuanTa security component",
  downloadUrl: "https://global.yuanta.com.tw/NexusPVM/webimage/servisign/YuanTaCGCryptServiSignSetup.pkg",
  allowedHosts: ["global.yuanta.com.tw"],
  instructions: {
    en: "Download and install the official YuanTa security component. After installation, return here and press Run again.",
    "zh-TW": "下載並安裝元大官方安全元件。安裝完成後回到這裡，按「重新執行」再試一次。",
  },
};

export type AutomationTask = AutomationTaskSummary & {
  command: readonly string[];
  maxAttempts: number;
};

export const CSV_IMPORT_DEPENDENCY_IDS = [
  "fubon-all-statements",
  "esun-credit-card-statements",
  "yuanta-all-statements",
  "yuanta-trade-statements",
  "cathay-all-statements",
  "hncb-statements",
  "ctbc-statements",
  "post-statements",
  "sinopac-statements",
  "linebank-statements",
  "einvoice-personal-invoices",
] as const;

const localized = (en: string, zh: string) => ({ en, "zh-TW": zh });

const field = (
  key: string,
  en: string,
  zh: string,
  input: "text" | "password" | "certificate-file" = "text",
  redaction: AutomationCredentialRedaction = "none",
) => ({ key, label: localized(en, zh), input, redaction });

const link = (
  id: string,
  en: string,
  zh: string,
  url: string,
  allowedHosts: readonly string[],
  englishUrl?: string,
) => ({ id, label: localized(en, zh), url, englishUrl, allowedHosts });

function credentialGroup(
  input: Omit<AutomationCredentialGroup, "credentialKeys">,
): AutomationCredentialGroup {
  return {
    ...input,
    credentialKeys: input.credentialFields.map((credentialField) => credentialField.key),
  };
}

export const AUTOMATION_CREDENTIAL_GROUPS: readonly AutomationCredentialGroup[] = [
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.fubon,
    displayName: localized("Taipei Fubon Bank", "台北富邦銀行（Taipei Fubon Bank）"),
    searchAliases: ["Fubon", "富邦", "台北富邦"],
    credentialFields: [
      field("LIBRETTO_CLOUD_FUBON_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_FUBON_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_FUBON_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the same ID number, user code, and password you use for Taipei Fubon online banking.", "請準備登入台北富邦網路銀行時使用的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active Taipei Fubon online banking account", "已啟用的台北富邦網路銀行服務"), localized("Your online banking user code and password", "網路銀行使用者代碼與密碼")],
      steps: [localized("Open Taipei Fubon online banking and confirm that you can sign in.", "先開啟台北富邦網路銀行，確認可以正常登入。"), localized("Return here and enter the same sign-in details.", "回到這裡輸入相同的登入資料。")],
      links: [link("service", "Open online banking (Chinese)", "前往網路銀行", "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces", ["ebank.taipeifubon.com.tw"]), link("guide", "View online banking information (Chinese)", "查看申請／取得說明", "https://www.fubon.com/banking/personal/digitalService/index.htm", ["www.fubon.com"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.esun,
    displayName: localized("E.SUN Bank", "玉山銀行（E.SUN Bank）"),
    searchAliases: ["ESun", "E.SUN", "玉山"],
    credentialFields: [
      field("LIBRETTO_CLOUD_ESUN_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_ESUN_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_ESUN_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the sign-in details registered for E.SUN online banking.", "請使用玉山網路銀行已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active E.SUN online banking account", "已啟用的玉山網路銀行服務"), localized("Your online banking user code and password", "網路銀行使用者代碼與密碼")],
      steps: [localized("Open E.SUN online banking and verify your sign-in details.", "先前往玉山網路銀行確認登入資料。"), localized("Return here and enter those details.", "回到這裡輸入相同資料。")],
      links: [link("service", "Open online banking (Chinese)", "前往網路銀行", "https://ebank.esunbank.com.tw/index.jsp", ["ebank.esunbank.com.tw"]), link("guide", "View application guide (Chinese)", "查看申請／取得說明", "https://www.esunbank.com/zh-tw/about/faq/content?q=online_account%2F021", ["www.esunbank.com"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.yuanta,
    displayName: localized("Yuanta Bank", "元大銀行（Yuanta Bank）"),
    searchAliases: ["Yuanta", "元大銀行"],
    credentialFields: [
      field("LIBRETTO_CLOUD_YUANTA_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_YUANTA_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_YUANTA_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the ID number, user code, and password registered for Yuanta Bank online banking.", "請使用元大銀行網路銀行已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active Yuanta Bank online banking account", "已啟用的元大銀行網路銀行服務"), localized("Your online banking user code and password", "網路銀行使用者代碼與密碼")],
      steps: [localized("Open Yuanta Bank online banking and confirm that you can sign in.", "先前往元大銀行網路銀行確認可以登入。"), localized("Return here and enter the same sign-in details.", "回到這裡輸入相同的登入資料。")],
      links: [link("service", "Open online banking (Chinese)", "前往網路銀行", "https://ebank.yuantabank.com.tw/nib/ibanc.jsp", ["ebank.yuantabank.com.tw"]), link("guide", "View digital banking information (Chinese)", "查看申請／取得說明", "https://www.yuantabank.com.tw/bankwebIMG/event/Bank_Act2025/MobileBankingAPP/index.html", ["www.yuantabank.com.tw"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES["yuanta-trade"],
    displayName: localized("Yuanta Securities", "元大證券（Yuanta Securities）"),
    searchAliases: ["Yuanta Trade", "Yuanta Securities", "元大證券"],
    credentialFields: [
      field("LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD", "Yuanta Securities password", "元大證券登入密碼", "password"),
      field("LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH", "Certificate file", "憑證檔案", "certificate-file"),
      field("LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD", "Certificate password", "憑證密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Yuanta Securities requires your sign-in details and an exported certificate file for statement access.", "元大證券需要登入資料，以及已匯出的憑證檔案才能取得帳務資料。"),
      requirements: [localized("Your Taiwan ID number and Yuanta Securities password", "台灣身分證字號與元大證券登入密碼"), localized("A .pfx or .p12 certificate file and its password", ".pfx 或 .p12 憑證檔案及憑證密碼")],
      steps: [localized("Confirm that you can sign in to Yuanta Securities.", "先確認可以登入元大證券。"), localized("Apply for or renew the certificate, then export a backup certificate file.", "申請或更新憑證後，匯出一份憑證備份檔。"), localized("Return here, choose the certificate file, and enter its password.", "回到這裡選擇憑證檔案並輸入憑證密碼。")],
      links: [link("service", "Open securities service (Chinese)", "前往證券服務", "https://global.yuanta.com.tw/NexusWebTrade/Login/OTPLogin?urlid=6020", ["global.yuanta.com.tw"]), link("certificate-guide", "View certificate application and component installation guide (Chinese)", "查看憑證申請與元件安裝說明", "https://www.yuanta.com.tw/eYuanta/Securities/Node/Index?C1=2018031206314695&ID=2018031206314695&Level=1&MainId=00414", ["www.yuanta.com.tw"]), link("installer", "Download Yuanta certificate component", "下載元大憑證元件", "https://global.yuanta.com.tw/NexusPVM/webimage/servisign/YuanTaCGCryptServiSignSetup.pkg", ["global.yuanta.com.tw"])],
      extra: {
        title: localized("Yuanta certificate component", "元大憑證元件"),
        steps: [localized("Download and install the official component before using the certificate service.", "請先下載並安裝元大官方憑證元件。"), localized("After installation, return to Yuanta Securities to apply for, renew, or export the certificate.", "安裝完成後回到元大證券，申請、更新或匯出憑證。"), localized("Keep the exported file in a stable location; this app stores its original path and does not copy it.", "請把匯出的憑證檔放在固定位置；本應用程式只記錄原始路徑，不會複製檔案。")],
      },
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.cathay,
    displayName: localized("Cathay United Bank", "國泰世華銀行（Cathay United Bank）"),
    searchAliases: ["Cathay", "國泰", "國泰世華"],
    credentialFields: [
      field("LIBRETTO_CLOUD_CATHAY_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_CATHAY_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_CATHAY_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the sign-in details registered for Cathay United Bank online banking.", "請使用國泰世華網路銀行已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active Cathay United Bank online banking account", "已啟用的國泰世華網路銀行服務"), localized("Your online banking user code and password", "網路銀行使用者代碼與密碼")],
      steps: [localized("Open Cathay United Bank online banking and confirm that you can sign in.", "先前往國泰世華網路銀行確認可以登入。"), localized("Return here and enter the same sign-in details.", "回到這裡輸入相同的登入資料。")],
      links: [link("service", "Open online banking (Chinese)", "前往網路銀行", "https://www.cathaybk.com.tw/MyBank/", ["www.cathaybk.com.tw"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.hncb,
    displayName: localized("Hua Nan Bank", "華南銀行（Hua Nan Bank）"),
    searchAliases: ["HNCB", "Hua Nan", "華南"],
    credentialFields: [
      field("LIBRETTO_CLOUD_HNCB_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_HNCB_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_HNCB_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the ID number, user code, and password registered for Hua Nan Bank online banking.", "請使用華南銀行網路銀行已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active Hua Nan Bank online banking account", "已啟用的華南銀行網路銀行服務"), localized("Your online banking user code and password", "網路銀行使用者代碼與密碼")],
      steps: [localized("Open Hua Nan Bank online banking and verify your sign-in details.", "先前往華南銀行網路銀行確認登入資料。"), localized("Return here and enter those details.", "回到這裡輸入相同資料。")],
      links: [link("service", "Open online banking (Chinese)", "前往網路銀行", "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private", ["netbank.hncb.com.tw"]), link("guide", "View online banking help (Chinese)", "查看申請／取得說明", "https://www.hncb.com.tw/ibankqa/index.shtml", ["www.hncb.com.tw"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.ctbc,
    displayName: localized("CTBC Bank", "中國信託銀行（CTBC Bank）"),
    searchAliases: ["CTBC", "中國信託", "中信"],
    credentialFields: [
      field("LIBRETTO_CLOUD_CTBC_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_CTBC_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_CTBC_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the ID number, user code, and password registered for CTBC Bank online banking.", "請使用中國信託網路銀行已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active CTBC Bank online banking account", "已啟用的中國信託網路銀行服務"), localized("Your online banking user code and password", "網路銀行使用者代碼與密碼")],
      steps: [localized("Open CTBC Bank online banking and confirm that you can sign in.", "先前往中國信託網路銀行確認可以登入。"), localized("Return here and enter the same sign-in details.", "回到這裡輸入相同的登入資料。")],
      links: [link("service", "Open online banking (Chinese)", "前往網路銀行", "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010", ["www.ctbcbank.com"]), link("guide", "View online banking information (Chinese)", "查看申請／取得說明", "https://www.ctbcbank.com/web/content/twrbo/zh_tw/onlinecounter_index/digital_service/digital_service_ib.html", ["www.ctbcbank.com"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.post,
    displayName: localized("Chunghwa Post", "中華郵政（Chunghwa Post）"),
    searchAliases: ["Post Office", "iPost", "郵局", "中華郵政"],
    credentialFields: [
      field("LIBRETTO_CLOUD_POST_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_POST_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_POST_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the ID number, user code, and password registered for Chunghwa Post internet banking.", "請使用中華郵政網路郵局已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active internet banking account", "已啟用的網路郵局服務"), localized("Your user code and web password", "網路郵局使用者代碼與網路密碼")],
      steps: [localized("Open internet banking and confirm that you can sign in.", "先前往網路郵局確認可以登入。"), localized("Return here and enter the same sign-in details.", "回到這裡輸入相同的登入資料。")],
      links: [link("service", "Open internet banking (Chinese)", "前往網路銀行", "https://ipost.post.gov.tw/pst/index.html", ["ipost.post.gov.tw"]), link("guide", "View application guide (Chinese)", "查看申請／取得說明", "https://ipost.post.gov.tw/pst/applyForiPost.html", ["ipost.post.gov.tw"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.sinopac,
    displayName: localized("Bank SinoPac", "永豐銀行（Bank SinoPac）"),
    searchAliases: ["SinoPac", "MMA", "永豐"],
    credentialFields: [
      field("LIBRETTO_CLOUD_SINOPAC_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_SINOPAC_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_SINOPAC_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the ID number, user code, and password registered for Bank SinoPac MMA online banking.", "請使用永豐銀行 MMA 網路銀行已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active MMA online banking account", "已啟用的 MMA 網路銀行服務"), localized("Your user code and online password", "網路銀行使用者代碼與網路密碼")],
      steps: [localized("Open MMA online banking and confirm that you can sign in.", "先前往 MMA 網路銀行確認可以登入。"), localized("Return here and enter the same sign-in details.", "回到這裡輸入相同的登入資料。")],
      links: [link("service", "Open online banking (Chinese)", "前往網路銀行", "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx", ["mma.sinopac.com"]), link("guide", "View sign-in details guide (Chinese)", "查看申請／取得說明", "https://bank.sinopac.com/searchmb/FAQ/content.aspx?catID=MMAb2c&no=340&sid=MMA&subCatID=%E7%B6%B2%E9%8A%80%E5%AF%86%E7%A2%BC", ["bank.sinopac.com"])],
    },
  }),
  credentialGroup({
    ...BANK_STATEMENT_CAPABILITIES.linebank,
    displayName: localized("LINE Bank", "LINE Bank"),
    searchAliases: ["LINE Bank", "連線銀行"],
    credentialFields: [
      field("LIBRETTO_CLOUD_LINEBANK_USER_ID", "Taiwan ID number", "台灣身分證字號", "text", "partial"),
      field("LIBRETTO_CLOUD_LINEBANK_ACCOUNT", "Online banking code", "網路銀行代碼", "password", "full"),
      field("LIBRETTO_CLOUD_LINEBANK_PASSWORD", "Online banking password", "網路銀行密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the sign-in details registered for the LINE Bank web service.", "請使用 LINE Bank 網頁服務已註冊的身分證字號、使用者代碼與密碼。"),
      requirements: [localized("An active LINE Bank account", "已啟用的 LINE Bank 帳戶"), localized("Your web sign-in details", "LINE Bank 網頁登入資料")],
      steps: [localized("Open the LINE Bank web service and confirm that you can sign in.", "先前往 LINE Bank 網頁服務確認可以登入。"), localized("Return here and enter the same details.", "回到這裡輸入相同資料。")],
      links: [link("service", "Open LINE Bank (Chinese)", "前往 LINE Bank", "https://accessibility.linebank.com.tw/login", ["accessibility.linebank.com.tw"]), link("guide", "View LINE Bank help (Chinese)", "查看申請／取得說明", "https://www.linebank.com.tw/faq/02", ["www.linebank.com.tw"])],
    },
  }),
  credentialGroup({
    id: "einvoice",
    label: "E-Invoice",
    displayName: localized("E-Invoice", "電子發票（E-Invoice）"),
    searchAliases: ["E-Invoice", "電子發票", "發票"],
    enabledKey: "LIBRETTO_CLOUD_EINVOICE_ENABLED",
    credentialFields: [
      field("LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER", "Mobile phone number (registered with the E-Invoice Platform)", "手機號碼（需於電子發票服務平台註冊）"),
      field("LIBRETTO_CLOUD_EINVOICE_PASSWORD", "E-Invoice Platform password", "電子發票服務平台密碼", "password"),
    ],
    setupGuide: {
      summary: localized("Use the mobile phone number and password registered with the Ministry of Finance E-Invoice Platform.", "請使用已在財政部電子發票服務平台註冊的手機號碼與平台密碼。"),
      requirements: [localized("A mobile phone barcode account registered on the E-Invoice Platform", "已在電子發票服務平台註冊的手機條碼帳戶"), localized("Your platform password", "電子發票服務平台密碼")],
      steps: [localized("Register or sign in to the E-Invoice Platform and confirm your mobile phone barcode account.", "先在電子發票服務平台註冊或登入，確認手機條碼帳戶。"), localized("Return here and enter the registered phone number and platform password.", "回到這裡輸入已註冊的手機號碼與平台密碼。")],
      links: [link("service", "Open E-Invoice Platform (Chinese)", "前往電子發票服務平台", "https://www.einvoice.nat.gov.tw/accounts/login", ["www.einvoice.nat.gov.tw"]), link("guide", "View mobile barcode registration guide (Chinese)", "查看申請／取得說明", "https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/html/ESQ/Download/802_moblicebarcode.pdf", ["www.einvoice.nat.gov.tw"])],
    },
  }),
  credentialGroup({
    id: "maicoin",
    label: "MaiCoin",
    displayName: localized("MaiCoin", "MaiCoin"),
    searchAliases: ["MaiCoin", "MAX", "MAX Exchange"],
    enabledKey: "MAX_ENABLED",
    credentialFields: [
      field("MAX_ACCESS_KEY", "MAX API access key", "MAX API 存取金鑰", "password"),
      field("MAX_SECRET_KEY", "MAX API secret key", "MAX API 私密金鑰", "password"),
      field("MAX_SUB_ACCOUNT", "MAX sub-account", "MAX 子帳戶"),
    ],
    setupGuide: {
      summary: localized("Create a MAX API token to synchronize your MAX wallet and transaction records.", "請建立 MAX API 金鑰，以同步 MAX 錢包與交易紀錄。"),
      requirements: [localized("A verified MAX account", "已完成驗證的 MAX 帳戶"), localized("An API access key and secret key", "API 存取金鑰與私密金鑰"), localized("The sub-account name, if you use one", "如有使用子帳戶，請準備子帳戶名稱")],
      steps: [localized("Sign in to MAX and open Profile settings.", "登入 MAX 後開啟個人資料設定。"), localized("Open API Token Settings and create a token.", "進入 API Token 設定並建立金鑰。"), localized("Enable only the read permissions needed for synchronization; withdrawal permission is not required.", "只啟用同步所需的讀取權限；不需要開啟提領權限。"), localized("Copy the access and secret keys here. Enter a sub-account only when the token belongs to one.", "將存取金鑰與私密金鑰填入這裡；只有金鑰屬於子帳戶時才填寫子帳戶。")],
      links: [link("service", "Open MAX", "前往 MAX", "https://max.maicoin.com/signin", ["max.maicoin.com"], "https://max.maicoin.com/signin?lang=en"), link("api-guide", "View API key setup guide", "查看 API 金鑰設定說明", "https://campaign.maicoin.com/api", ["campaign.maicoin.com"], "https://campaign.maicoin.com/en/api"), link("api-docs", "Open MAX API documentation", "前往 MAX API 文件", "https://campaign.maicoin.com/api-document", ["campaign.maicoin.com"], "https://campaign.maicoin.com/en/api-document")],
      extra: {
        title: localized("MAX API", "MAX API"),
        steps: [localized("The secret key may only be shown once. Copy it before leaving the MAX setup screen.", "私密金鑰可能只顯示一次，離開 MAX 設定畫面前請先複製。"), localized("If you rotate or revoke the token later, return here and replace both keys.", "日後若輪替或撤銷金鑰，請回到這裡同時更新兩把金鑰。")],
      },
    },
  }),
];

export const AUTOMATION_TASKS: readonly AutomationTask[] = [
  {
    id: "fubon-all-statements",
    label: "Fubon all statements",
    script: "run:fubon-all-statements",
    command: ["libretto", "run", "src/workflows/fubon-all-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "fubon",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[0].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "esun-credit-card-statements",
    label: "ESun credit card statements",
    script: "run:esun-credit-card-statements",
    command: ["libretto", "run", "src/workflows/esun-credit-card-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "esun",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[1].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "yuanta-all-statements",
    label: "Yuanta all statements",
    script: "run:yuanta-all-statements",
    command: [
      "libretto",
      "run",
      "src/workflows/yuanta-all-statements.ts",
      "--headless",
      "--params",
      '{"statements":{"telemetry":true}}',
    ],
    kind: "crawler",
    credentialGroupId: "yuanta",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[2].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "yuanta-trade-statements",
    label: "Yuanta trade statements",
    script: "run:yuanta-trade-statements",
    command: ["libretto", "run", "src/workflows/yuanta-trade-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "yuanta-trade",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[3].credentialKeys,
    dependencies: [],
    externalPrerequisites: [YUANTA_SERVISIGN_PREREQUISITE],
    maxAttempts: 1,
  },
  {
    id: "cathay-all-statements",
    label: "Cathay all statements",
    script: "run:cathay-all-statements",
    command: [
      "libretto",
      "run",
      "src/workflows/cathay-all-statements.ts",
      "--headed",
      "--params",
      '{"telemetry":true}',
    ],
    kind: "crawler",
    credentialGroupId: "cathay",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[4].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "hncb-statements",
    label: "HNCB statements",
    script: "run:hncb-statements",
    command: ["libretto", "run", "src/workflows/hncb-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "hncb",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[5].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "ctbc-statements",
    label: "CTBC statements",
    script: "run:ctbc-statements",
    command: ["libretto", "run", "src/workflows/ctbc-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "ctbc",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[6].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "post-statements",
    label: "Post Office statements",
    script: "run:post-statements",
    command: ["libretto", "run", "src/workflows/post-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "post",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[7].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "sinopac-statements",
    label: "SinoPac statements",
    script: "run:sinopac-statements",
    command: ["libretto", "run", "src/workflows/sinopac-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "sinopac",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[8].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "linebank-statements",
    label: "LINE Bank statements",
    script: "run:linebank-statements",
    command: ["libretto", "run", "src/workflows/linebank-statements.ts", "--headless"],
    kind: "crawler",
    credentialGroupId: "linebank",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[9].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "einvoice-personal-invoices",
    label: "E-Invoice personal invoices",
    script: "run:einvoice-personal-invoices",
    command: [
      "libretto",
      "run",
      "src/workflows/einvoice-personal-invoices.ts",
      "--headless",
    ],
    kind: "crawler",
    credentialGroupId: "einvoice",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[10].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "exchange-rates",
    label: "Exchange rates",
    script: "run:exchange-rates",
    command: [
      "node",
      "--no-warnings",
      "--experimental-strip-types",
      "src/ledger/sync-exchange-rates.ts",
    ],
    kind: "sync",
    credentialKeys: [],
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "sync-maicoin",
    label: "MaiCoin sync",
    script: "run:sync-maicoin",
    command: [
      "node",
      "--env-file-if-exists=.env",
      "--no-warnings",
      "--experimental-strip-types",
      "src/ledger/sync-maicoin.ts",
    ],
    kind: "sync",
    credentialGroupId: "maicoin",
    credentialKeys: AUTOMATION_CREDENTIAL_GROUPS[11].credentialKeys,
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "import-downloads-csv",
    label: "Import downloads CSV",
    script: "run:import-downloads-csv",
    command: ["node", "--no-warnings", "--experimental-strip-types", "src/ledger/import-downloads-csv.ts"],
    kind: "import",
    credentialKeys: [],
    dependencies: CSV_IMPORT_DEPENDENCY_IDS,
    maxAttempts: 1,
  },
];

export const AUTOMATION_CREDENTIAL_KEYS = Array.from(
  new Set(AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) => group.credentialKeys)),
);

export const AUTOMATION_ENABLED_KEYS = AUTOMATION_CREDENTIAL_GROUPS.map((group) => group.enabledKey);

const AUTOMATION_STATEMENT_SELECTION_KEYS = AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) =>
  group.statementSelectionKey ? [group.statementSelectionKey] : [],
);

export const AUTOMATION_NON_SECRET_KEYS = [
  "SYSTEM_TIMEZONE",
  "EXCHANGE_RATE_UPDATE_TIME",
  "AUTOMATION_BUSINESS_TIMEZONE",
  "MAX_SUB_ACCOUNT",
  ...AUTOMATION_ENABLED_KEYS,
  ...AUTOMATION_STATEMENT_SELECTION_KEYS,
] as const;

const nonSecretCredentialKeys = new Set<string>(["MAX_SUB_ACCOUNT"]);

export const AUTOMATION_SECRET_KEYS = AUTOMATION_CREDENTIAL_KEYS.filter(
  (key) => !nonSecretCredentialKeys.has(key),
);

export function automationCredentialKeyIsSecret(key: string) {
  return !nonSecretCredentialKeys.has(key);
}

export function taskById(taskId: string) {
  return AUTOMATION_TASKS.find((task) => task.id === taskId) ?? null;
}

function taskIsEnabled(task: AutomationTask, enabledGroups: Record<string, boolean>) {
  return !task.credentialGroupId || enabledGroups[task.credentialGroupId] !== false;
}

export function enabledAutomationTasks(enabledGroups: Record<string, boolean>) {
  return AUTOMATION_TASKS.filter((task) => task.kind === "import" || taskIsEnabled(task, enabledGroups));
}

export function enabledCsvImportDependencyIds(enabledGroups: Record<string, boolean>) {
  return CSV_IMPORT_DEPENDENCY_IDS.filter((taskId) => {
    const task = taskById(taskId);
    return task ? taskIsEnabled(task, enabledGroups) : false;
  });
}
