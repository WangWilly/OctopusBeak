import type { PreviewSource } from "./registry.ts";

export const PREVIEW_SOURCE_FIXTURE_ENV = "OCTOPUSBEAK_PREVIEW_SOURCE_FIXTURE";

export function previewSourceFixtureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[PREVIEW_SOURCE_FIXTURE_ENV] === "1";
}

const text = (en: string, zhTW: string) => ({ en, "zh-TW": zhTW });

export const PREVIEW_FIXTURE_SOURCE: PreviewSource = {
  id: "synthetic",
  institution: "bank-009",
  products: ["deposit"],
  displayName: text("Preview fixture bank", "預覽測試銀行"),
  searchAliases: ["preview fixture"],
  credentialFields: [{
    key: "PREVIEW_SYNTHETIC_USER_ID",
    label: text("User ID", "使用者代號"),
    input: "text",
    redaction: "none",
  }],
  setupGuide: {
    summary: text("A synthetic source used only in checks.", "僅用於測試的模擬來源。"),
    requirements: [],
    steps: [],
    links: [],
  },
  startUrl: "https://preview-fixture.invalid/",
  async run(context) {
    await context.event("collection", "collection-started");
    const collectedAt = context.now();
    return context.preview.collect({ deposit: async () => ({
      collectedAt,
      accounts: [{
        sourceAccountKey: "fixture-account",
        displayLabel: "Fixture savings",
        currency: "TWD",
        type: "depository",
        balances: [{ kind: "current", amount: "1000.00", currency: "TWD", observedAt: { at: collectedAt, source: "collection-time" } }],
        transactions: [],
      }],
    }) });
  },
};
