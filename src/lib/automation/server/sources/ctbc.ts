import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";

export const CTBC_SOURCE: VerifiedSource = {
  id: "ctbc",
  label: "CTBC",
  enabledKey: "LIBRETTO_CLOUD_CTBC_ENABLED",
  displayName: localized("CTBC Bank", "中國信託銀行（CTBC Bank）"),
  searchAliases: ["CTBC", "中國信託", "中信"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_CTBC_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_CTBC_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_CTBC_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  sessionTakeover: {
    notice: localized(
      "Every sync, including daily scheduled collection, confirms CTBC's prompt that other locations will be signed out automatically, which signs you out of CTBC online banking elsewhere.",
      "每次同步（包括每日排程收集）都會在中國信託提示「其他位置將會自動登出」時按下「確認登入」，讓你在其他地方的中國信託網路銀行登出。",
    ),
    prompt: { phase: "while-settling", text: { pattern: /其他位置將會自動登出/u }, control: { text: "確認登入" } },
  },
  setupGuide: {
    summary: localized(
      "Use the ID number, user code, and password registered for CTBC Bank online banking.",
      "請使用中國信託網路銀行已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active CTBC Bank online banking account",
        "已啟用的中國信託網路銀行服務",
      ),
      localized(
        "Your online banking user code and password",
        "網路銀行使用者代碼與密碼",
      ),
    ],
    steps: [
      localized(
        "Open CTBC Bank online banking and confirm that you can sign in.",
        "先前往中國信託網路銀行確認可以登入。",
      ),
      localized(
        "Return here and enter the same sign-in details.",
        "回到這裡輸入相同的登入資料。",
      ),
    ],
    links: [
      link(
        "service",
        "Open online banking (Chinese)",
        "前往網路銀行",
        "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010",
        ["www.ctbcbank.com"],
      ),
      link(
        "guide",
        "View online banking information (Chinese)",
        "查看申請／取得說明",
        "https://www.ctbcbank.com/web/content/twrbo/zh_tw/onlinecounter_index/digital_service/digital_service_ib.html",
        ["www.ctbcbank.com"],
      ),
    ],
  },
  integrationNamespace: "ctbc",
  coverage: [{ institution: "ctbc", product: "deposit" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_CTBC_STATEMENT_TYPES",
    products: [
      { id: "deposit", stream: "domestic-deposit" },
    ],
  },
  task: {
    id: "ctbc-statements",
    label: "CTBC statements",
    kind: "crawler",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    runtime: browser("https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010", "ctbc-login"),
    input: { credentials: true, statementTypes: true },
    async load() {
      return (await import("../../../../workflows/ctbc-statements.ts")).runCtbcProviderWorkflow;
    },
  }),
};
