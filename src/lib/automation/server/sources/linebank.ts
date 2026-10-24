import { browser, field, link, localized, type VerifiedSource } from "./verified-source.ts";

export const LINEBANK_SOURCE: VerifiedSource = {
  id: "linebank",
  label: "LINE Bank",
  enabledKey: "LIBRETTO_CLOUD_LINEBANK_ENABLED",
  displayName: localized("LINE Bank", "LINE Bank"),
  searchAliases: ["LINE Bank", "連線銀行"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_LINEBANK_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_LINEBANK_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_LINEBANK_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  setupGuide: {
    summary: localized(
      "Use the sign-in details registered for the LINE Bank web service.",
      "請使用 LINE Bank 網頁服務已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized("An active LINE Bank account", "已啟用的 LINE Bank 帳戶"),
      localized("Your web sign-in details", "LINE Bank 網頁登入資料"),
    ],
    steps: [
      localized(
        "Open the LINE Bank web service and confirm that you can sign in.",
        "先前往 LINE Bank 網頁服務確認可以登入。",
      ),
      localized(
        "Return here and enter the same details.",
        "回到這裡輸入相同資料。",
      ),
    ],
    links: [
      link(
        "service",
        "Open LINE Bank (Chinese)",
        "前往 LINE Bank",
        "https://accessibility.linebank.com.tw/login",
        ["accessibility.linebank.com.tw"],
      ),
      link(
        "guide",
        "View LINE Bank help (Chinese)",
        "查看申請／取得說明",
        "https://www.linebank.com.tw/faq/02",
        ["www.linebank.com.tw"],
      ),
    ],
  },
  integrationNamespace: "linebank",
  coverage: [{ institution: "linebank", product: "deposit" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES",
    products: [
      { id: "deposit", stream: "domestic-deposit" },
    ],
  },
  task: {
    id: "linebank-statements",
    label: "LINE Bank statements",
    kind: "crawler",
  },
  workflow: {
    requiresFinancialCommit: true,
    runtime: browser("https://accessibility.linebank.com.tw/login"),
    input: { credentials: true, extra: () => ({ accountFilters: [], currencyFilters: [] }) },
    async load() {
      return (await import("../../../../workflows/linebank-statements.ts")).runLineBankProviderWorkflow;
    },
  },
};
