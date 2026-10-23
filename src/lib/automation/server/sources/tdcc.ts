import { field, link, localized, NONBROWSER, type VerifiedSource } from "./verified-source.ts";

export const TDCC_SOURCE: VerifiedSource = {
  id: "tdcc",
  label: "TDCC",
  enabledKey: "LIBRETTO_CLOUD_TDCC_ENABLED",
  displayName: localized("TDCC e-Passbook", "集保e手掌握（TDCC e-Passbook）"),
  searchAliases: ["TDCC", "e-Passbook", "集保", "e手掌握", "集保e手掌握", "e存摺", "集保e存摺"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_TDCC_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_TDCC_PASSWORD",
      "e-Passbook password",
      "集保e手掌握密碼",
      "password",
    ),
  ],
  sessionTakeoverNotice: localized(
    "TDCC trusts one device at a time, so every sync, including daily scheduled collection, signs the TDCC e-Passbook phone App out. If you sign in to the phone App again, register this device again before the next sync.",
    "集保一次只信任一台裝置，每次同步（包括每日排程收集）都會讓集保e手掌握手機 App 登出。如果之後又登入手機 App，下次同步前請在這裡重新註冊裝置。",
  ),
  setupGuide: {
    summary: localized(
      "Use the ID number and password you use in the TDCC e-Passbook phone App.",
      "請使用登入集保e手掌握 App 的身分證字號與密碼。",
    ),
    requirements: [
      localized("An active TDCC e-Passbook account", "已開通的集保e手掌握帳戶"),
      localized(
        "Access to the email and mobile number registered with TDCC, for the one-time codes of device registration",
        "能收到集保登記的電子郵件與手機簡訊，以完成裝置註冊的一次性驗證碼",
      ),
    ],
    steps: [
      localized(
        "Enter your ID number and e-Passbook password here.",
        "在這裡輸入身分證字號與集保e手掌握密碼。",
      ),
      localized(
        "Register this device and enter the codes TDCC sends by email and SMS.",
        "註冊這台裝置，並輸入集保以電子郵件與簡訊寄送的驗證碼。",
      ),
      localized(
        "If you sign in to the phone App again, register this device again before the next sync.",
        "如果之後又登入手機 App，下次同步前請在這裡重新註冊裝置。",
      ),
    ],
    links: [
      link(
        "service",
        "Open the TDCC e-Passbook site (Chinese)",
        "前往集保e手掌握網站",
        "https://epassbook.tdcc.com.tw/zh/a1.aspx",
        ["epassbook.tdcc.com.tw"],
      ),
    ],
  },
  integrationNamespace: "tdcc",
  statementSelection: {
    key: "LIBRETTO_CLOUD_TDCC_STATEMENT_TYPES",
    products: [
      { id: "securities", stream: "investment" },
      { id: "fund", stream: "investment-fund" },
      { id: "settlement", stream: "domestic-deposit" },
    ],
  },
  task: {
    id: "sync-tdcc",
    label: "TDCC e-Passbook sync",
    kind: "sync",
  },
  workflow: {
    requiresFinancialCommit: true,
    requiresTdcc: true,
    runtime: NONBROWSER,
    input: { statementTypes: true },
    async load() {
      return (await import("../../tdcc-workflow.ts")).createTdccWorkflow().run;
    },
  },
};
