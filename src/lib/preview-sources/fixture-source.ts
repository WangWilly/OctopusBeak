import type {
  PreviewCreditCollection,
  PreviewProductWrite,
  PreviewTimeDepositCollection,
} from "../../ledger/pglite/preview-financial-data.ts";
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

const day = (at: Date, offset: number) => new Date(at.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

function fixtureTimeDeposits(collectedAt: string, withMatured: boolean, now: Date): PreviewTimeDepositCollection {
  const observedAt = { at: collectedAt, source: "collection-time" } as const;
  return {
    collectedAt,
    completeness: "complete",
    deposits: [
      {
        sourceAccountKey: "fixture-term-12m", displayLabel: "Fixture 12-month deposit", currency: "TWD",
        balances: [{ kind: "current", amount: "200000.00", currency: "TWD", observedAt }],
        principal: "200000.00", interestRate: "1.725", maturityDate: day(now, 180),
      },
      ...(withMatured ? [{
        sourceAccountKey: "fixture-term-matured", displayLabel: "Fixture matured deposit", currency: "TWD",
        balances: [{ kind: "current" as const, amount: "50000.00", currency: "TWD", observedAt }],
        principal: "50000.00", interestRate: "1.6", maturityDate: day(now, -1),
      }] : []),
    ],
  };
}

/**
 * The second credit write posts the first write's authorization (so the two
 * pair), adds a fresh authorization that stays pending, and a statement. The
 * second card account never reports a used credit.
 */
function fixtureCredit(collectedAt: string, posted: boolean, now: Date): PreviewCreditCollection {
  const observedAt = { at: collectedAt, source: "reported" } as const;
  const authorization = {
    sourceRowKey: "auth-coffee", amount: "1280", currency: "TWD", direction: "outflow" as const,
    posting: { status: "pending" as const }, consumedAt: { precision: "minute" as const, value: `${day(now, -1)}T12:41` },
    sourceCardKey: "card-main", statementKey: null, bankReference: null, description: "Fixture coffee roasters",
  };
  return {
    collectedAt,
    accounts: [
      {
        sourceAccountKey: "fixture-card", displayLabel: "Fixture rewards card", currency: "TWD", creditLimit: "120000",
        cards: [
          { sourceCardKey: "card-main", cardMask: "****-4321", displayLabel: "Main" },
          { sourceCardKey: "card-family", cardMask: "****-8765", displayLabel: "Family" },
        ],
        balances: [{
          amount: posted ? "18840" : "17560", currency: "TWD", observedAt,
          basis: { kind: "credit-limit-minus-available", creditLimit: "120000", availableCredit: posted ? "101160" : "102440" },
        }],
        purchases: [
          {
            sourceRowKey: "posted-grocer", amount: "2380", currency: "TWD", direction: "outflow",
            posting: { status: "posted", billing: "unbilled", postingDate: day(now, -4) },
            consumedAt: { precision: "day", value: day(now, -5) }, sourceCardKey: "card-family",
            statementKey: null, bankReference: null, description: "Fixture grocer",
          },
          ...(posted
            ? [
              {
                ...authorization, sourceRowKey: "posted-coffee",
                posting: { status: "posted" as const, billing: "unbilled" as const, postingDate: day(now, 0) },
                consumedAt: { precision: "day" as const, value: day(now, -1) },
              },
              {
                ...authorization, sourceRowKey: "auth-train", amount: "1490",
                consumedAt: { precision: "minute" as const, value: `${day(now, 0)}T08:05` }, description: "Fixture rail ticket",
              },
            ]
            : [authorization]),
        ],
        statements: posted ? [{
          statementKey: "fixture-statement", cycleStart: day(now, -40), cycleEnd: day(now, -10), closingDate: day(now, -10),
          dueDate: day(now, 5), amount: "15180", currency: "TWD", minimumPayment: "1518", billingPeriod: day(now, -10).slice(0, 7),
          paidAmount: "0", paid: false, noPaymentNeeded: false,
        }] : [],
      },
      {
        sourceAccountKey: "fixture-card-unknown", displayLabel: "Fixture travel card", currency: "TWD", creditLimit: null,
        cards: [{ sourceCardKey: "card-travel", cardMask: "****-2468", displayLabel: null }],
        balances: [], purchases: [], statements: [],
      },
    ],
  };
}

/**
 * The writes of the multi-product fixture over two collections a day apart,
 * oldest first: the second time-deposit list lacks one deposit and so closes
 * it, and the second credit write posts the first write's authorization.
 */
export function previewProductsFixtureWrites(now: Date): readonly PreviewProductWrite[] {
  const first = new Date(now.getTime() - 86_400_000).toISOString();
  const second = now.toISOString();
  return [
    { product: "time_deposit", collection: fixtureTimeDeposits(first, true, now) },
    { product: "credit_card", collection: fixtureCredit(first, false, now) },
    { product: "time_deposit", collection: fixtureTimeDeposits(second, false, now) },
    { product: "credit_card", collection: fixtureCredit(second, true, now) },
  ];
}

export const PREVIEW_PRODUCTS_FIXTURE_SOURCE: PreviewSource = {
  ...PREVIEW_FIXTURE_SOURCE,
  id: "synthetic-products",
  institution: "bank-017",
  products: ["deposit", "credit_card", "time_deposit"],
  displayName: text("Preview fixture bank (products)", "預覽測試銀行（多產品）"),
  searchAliases: ["preview fixture products"],
  credentialFields: [{ ...PREVIEW_FIXTURE_SOURCE.credentialFields[0]!, key: "PREVIEW_SYNTHETIC_PRODUCTS_USER_ID" }],
  async run(context) {
    await context.event("collection", "collection-started");
    const collectedAt = context.now();
    return context.preview.collect({
      deposit: async () => ({ absent: "not_held" }),
      credit_card: async () => fixtureCredit(collectedAt, true, new Date(collectedAt)),
      time_deposit: async () => fixtureTimeDeposits(collectedAt, false, new Date(collectedAt)),
    });
  },
};
