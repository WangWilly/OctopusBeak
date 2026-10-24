import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";

export const EINVOICE_SOURCE: VerifiedSource = {
  id: "einvoice",
  label: "E-Invoice",
  enabledKey: "LIBRETTO_CLOUD_EINVOICE_ENABLED",
  displayName: localized("E-Invoice", "電子發票（E-Invoice）"),
  searchAliases: ["E-Invoice", "電子發票", "發票"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER",
      "Mobile phone number (registered with the E-Invoice Platform)",
      "手機號碼（需於電子發票服務平台註冊）",
    ),
    field(
      "LIBRETTO_CLOUD_EINVOICE_PASSWORD",
      "E-Invoice Platform password",
      "電子發票服務平台密碼",
      "password",
    ),
  ],
  sessionTakeoverNotice: localized(
    "OctopusBeak signs in the way the E-Invoice phone App does, so every sync, including daily scheduled collection, signs the phone App out. Signing in on the phone again needs no code.",
    "OctopusBeak 以電子發票手機 App 的方式登入，每次同步（包括每日排程收集）都會讓手機 App 登出；之後在手機重新登入即可，不需要驗證碼。",
  ),
  setupGuide: {
    summary: localized(
      "Use the mobile phone number and password registered with the Ministry of Finance E-Invoice Platform.",
      "請使用已在財政部電子發票服務平台註冊的手機號碼與平台密碼。",
    ),
    requirements: [
      localized(
        "A mobile phone barcode account registered on the E-Invoice Platform",
        "已在電子發票服務平台註冊的手機條碼帳戶",
      ),
      localized("Your platform password", "電子發票服務平台密碼"),
    ],
    steps: [
      localized(
        "Register or sign in to the E-Invoice Platform and confirm your mobile phone barcode account.",
        "先在電子發票服務平台註冊或登入，確認手機條碼帳戶。",
      ),
      localized(
        "Return here and enter the registered phone number and platform password.",
        "回到這裡輸入已註冊的手機號碼與平台密碼。",
      ),
    ],
    links: [
      link(
        "service",
        "Open E-Invoice Platform (Chinese)",
        "前往電子發票服務平台",
        "https://www.einvoice.nat.gov.tw/accounts/login",
        ["www.einvoice.nat.gov.tw"],
      ),
      link(
        "guide",
        "View mobile barcode registration guide (Chinese)",
        "查看申請／取得說明",
        "https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/html/ESQ/Download/802_moblicebarcode.pdf",
        ["www.einvoice.nat.gov.tw"],
      ),
    ],
  },
  integrationNamespace: "einvoice",
  overview: false,
  task: {
    id: "einvoice-personal-invoices",
    label: "E-Invoice personal invoices",
    kind: "crawler",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    runtime: browser(),
    verification: { ownsSubmissionOutcome: true },
    input: { credentials: true },
    async load() {
      return (await import("../../../../workflows/einvoice-personal-invoices.ts")).runEinvoiceProviderWorkflow;
    },
  }),
};
