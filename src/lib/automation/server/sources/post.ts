import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";

export const POST_SOURCE: VerifiedSource = {
  id: "post",
  label: "Post Office",
  enabledKey: "LIBRETTO_CLOUD_POST_ENABLED",
  displayName: localized("Chunghwa Post", "中華郵政（Chunghwa Post）"),
  searchAliases: ["Post Office", "iPost", "郵局", "中華郵政"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_POST_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_POST_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_POST_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  setupGuide: {
    summary: localized(
      "Use the ID number, user code, and password registered for Chunghwa Post internet banking.",
      "請使用中華郵政網路郵局已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active internet banking account",
        "已啟用的網路郵局服務",
      ),
      localized(
        "Your user code and web password",
        "網路郵局使用者代碼與網路密碼",
      ),
    ],
    steps: [
      localized(
        "Open internet banking and confirm that you can sign in.",
        "先前往網路郵局確認可以登入。",
      ),
      localized(
        "Return here and enter the same sign-in details.",
        "回到這裡輸入相同的登入資料。",
      ),
    ],
    links: [
      link(
        "service",
        "Open internet banking (Chinese)",
        "前往網路銀行",
        "https://ipost.post.gov.tw/pst/index.html",
        ["ipost.post.gov.tw"],
      ),
      link(
        "guide",
        "View application guide (Chinese)",
        "查看申請／取得說明",
        "https://ipost.post.gov.tw/pst/applyForiPost.html",
        ["ipost.post.gov.tw"],
      ),
    ],
  },
  integrationNamespace: "post",
  coverage: [{ institution: "post", product: "deposit" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_POST_STATEMENT_TYPES",
    products: [
      { id: "deposit", stream: "domestic-deposit" },
    ],
  },
  task: {
    id: "post-statements",
    label: "Post Office statements",
    kind: "crawler",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    runtime: browser("https://ipost.post.gov.tw/pst/home.html"),
    verification: { ownsSubmissionOutcome: true },
    input: { credentials: true },
    async load() {
      return (await import("../../../../workflows/post-statements.ts")).runPostProviderWorkflow;
    },
  }),
};
