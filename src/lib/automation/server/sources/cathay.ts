import { browser, field, link, localized, type VerifiedSource } from "./verified-source.ts";
import { ATTACHED_PREVIEW_PRODUCTS } from "../../../preview-sources/attached-products.ts";

export const CATHAY_SOURCE: VerifiedSource = {
  id: "cathay",
  label: "Cathay",
  enabledKey: "LIBRETTO_CLOUD_CATHAY_ENABLED",
  displayName: localized(
    "Cathay United Bank",
    "國泰世華銀行（Cathay United Bank）",
  ),
  searchAliases: ["Cathay", "國泰", "國泰世華"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_CATHAY_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_CATHAY_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_CATHAY_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  setupGuide: {
    summary: localized(
      "Use the sign-in details registered for Cathay United Bank online banking.",
      "請使用國泰世華網路銀行已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active Cathay United Bank online banking account",
        "已啟用的國泰世華網路銀行服務",
      ),
      localized(
        "Your online banking user code and password",
        "網路銀行使用者代碼與密碼",
      ),
    ],
    steps: [
      localized(
        "Open Cathay United Bank online banking and confirm that you can sign in.",
        "先前往國泰世華網路銀行確認可以登入。",
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
        "https://www.cathaybk.com.tw/MyBank/",
        ["www.cathaybk.com.tw"],
      ),
    ],
  },
  integrationNamespace: "cathay",
  coverage: [{ institution: "cathay", product: "deposit" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES",
    products: [
      { id: "domestic", stream: "domestic-deposit" },
      { id: "foreign_currency", stream: "foreign-currency-deposit" },
    ],
  },
  task: {
    id: "cathay-all-statements",
    label: "Cathay all statements",
    kind: "crawler",
  },
  workflow: {
    requiresFinancialCommit: true,
    attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.cathay,
    runtime: browser("https://www.cathaybk.com.tw/MyBank/", "cathay-login"),
    input: { credentials: true, statementTypes: true },
    async load() {
      return (await import("../../../../workflows/cathay-all-statements.ts")).runCathayAllProviderWorkflow;
    },
  },
};
