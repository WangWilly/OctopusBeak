import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";
import { ATTACHED_PREVIEW_PRODUCTS } from "../../../preview-sources/attached-products.ts";

export const ESUN_SOURCE: VerifiedSource = {
  id: "esun",
  label: "ESun",
  enabledKey: "LIBRETTO_CLOUD_ESUN_ENABLED",
  displayName: localized("E.SUN Bank", "玉山銀行（E.SUN Bank）"),
  searchAliases: ["ESun", "E.SUN", "玉山"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_ESUN_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_ESUN_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_ESUN_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  sessionTakeover: {
    notice: localized(
      "When E.SUN shows its sign-in confirmation instead of the signed-in page, every sync, including daily scheduled collection, confirms it, which signs you out of E.SUN online banking elsewhere.",
      "當玉山銀行顯示「確定登入」確認而不是登入後頁面時，每次同步（包括每日排程收集）都會按下確認，讓你在其他地方的玉山網路銀行登出。",
    ),
    prompt: { phase: "while-settling", text: { pattern: /確定登入/u }, control: { role: "button", name: /確定登入/u } },
  },
  setupGuide: {
    summary: localized(
      "Use the sign-in details registered for E.SUN online banking.",
      "請使用玉山網路銀行已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active E.SUN online banking account",
        "已啟用的玉山網路銀行服務",
      ),
      localized(
        "Your online banking user code and password",
        "網路銀行使用者代碼與密碼",
      ),
    ],
    steps: [
      localized(
        "Open E.SUN online banking and verify your sign-in details.",
        "先前往玉山網路銀行確認登入資料。",
      ),
      localized(
        "Return here and enter those details.",
        "回到這裡輸入相同資料。",
      ),
    ],
    links: [
      link(
        "service",
        "Open online banking (Chinese)",
        "前往網路銀行",
        "https://ebank.esunbank.com.tw/index.jsp",
        ["ebank.esunbank.com.tw"],
      ),
      link(
        "guide",
        "View application guide (Chinese)",
        "查看申請／取得說明",
        "https://www.esunbank.com/zh-tw/about/faq/content?q=online_account%2F021",
        ["www.esunbank.com"],
      ),
    ],
  },
  integrationNamespace: "esun",
  coverage: [{ institution: "esun", product: "credit_card" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_ESUN_STATEMENT_TYPES",
    products: [
      { id: "credit_card", stream: "credit-card" },
    ],
  },
  task: {
    id: "esun-credit-card-statements",
    label: "ESun credit card statements",
    kind: "crawler",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.esun,
    runtime: browser("https://ebank.esunbank.com.tw/index.jsp", "esun-login"),
    input: { credentials: true, managedIdentitySecret: true, statementTypes: true },
    async load() {
      return (await import("../../../../workflows/esun-credit-card-statements.ts")).runEsunCreditCardProviderWorkflow;
    },
  }),
};
