import assert from "node:assert/strict";
import test from "node:test";
import {
  BANK_TRANSACTION_KIND_ENRICHMENT_EVIDENCE_KINDS,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION,
  BANK_TRANSACTION_KIND_ENRICHMENT_ROUTE_SCOPES,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  TRANSACTION_TAXONOMY_PACKAGE_V1,
  assertValidTaxonomyPackage,
  producerAllowsOutput,
} from "./transaction-taxonomy.ts";
import {
  BANK_TRANSACTION_KIND_SUPPORTED_SCOPES,
  classifyBankTransactionKind,
  matchUniqueCreditCardStatementForBankOutflow,
} from "./bank-transaction-kind-enrichment.ts";

test("bank/deposit Kind rules classify the accepted evidence precedence", () => {
  const cases = [
    ["outflow", "自轉至本人帳戶", "transfer.internal"],
    ["outflow", "跨行匯款至其他帳戶", "transfer.external"],
    ["outflow", "繳信用卡費", "payment.credit_card"],
    ["outflow", "房貸還款", "payment.loan"],
    ["outflow", "ATM 提款", "cash.withdrawal"],
    ["inflow", "現金存入", "cash.deposit"],
    ["outflow", "複委託扣款", "transfer.investment_contribution"],
    ["inflow", "複委託入帳", "transfer.investment_withdrawal"],
    ["outflow", "買股票", "investment.trade.buy"],
    ["inflow", "基金贖回", "investment.trade.sell"],
    ["outflow", "銀行手續費", "fee.bank"],
    ["inflow", "存款利息", "interest.earned"],
    ["outflow", "信用卡利息", "interest.charged"],
    ["inflow", "薪資入帳", "income.employment.salary"],
    ["inflow", "貸款撥款", "loan.disbursement"],
    ["outflow", "所得稅繳款", "tax.payment"],
    ["inflow", "退款入帳", "refund"],
    ["outflow", "交易撤銷", "reversal"],
    ["outflow", "全家便利商店", "purchase"],
    ["inflow", "未知來源入帳", "receipt"],
    // A generic 買入 label is deliberately insufficient to prove an investment.
    ["outflow", "買入", "purchase"],
  ] as const;
  for (const [direction, description, expected] of cases) {
    assert.equal(
      classifyBankTransactionKind({ direction, description }).value,
      expected,
      `${direction}:${description}`,
    );
  }
});

test("opaque numeric bank notes do not prove a credit-card payment", () => {
  assert.equal(
    classifyBankTransactionKind({
      direction: "outflow",
      description: "行動轉出 · 06600000102281740 7097230279900200",
      integrationNamespace: "yuanta",
      stream: "domestic-deposit",
    }).value,
    "purchase",
    "a statement relation, rather than the note shape or exact value, supplies the evidence",
  );
});

test("Yuanta scheduled fund subscriptions require the complete source pattern", () => {
  const classify = (description: string, integrationNamespace = "yuanta") =>
    classifyBankTransactionKind({
      direction: "outflow",
      description,
      integrationNamespace,
      stream: "domestic-deposit",
    }).value;

  assert.equal(
    classify(
      "轉帳支取 · 7013196970300100 YT95 FS01150344 約定申購 08015 174 FISB",
    ),
    "investment.trade.buy",
  );
  assert.equal(
    classify(
      "轉帳支取 · 1234567890123456 YT07 FS87654321 約定申購 54321 174 FISB",
    ),
    "investment.trade.buy",
    "account, YT, fund, and institution identifiers are structural rather than hardcoded values",
  );
  assert.equal(
    classify("轉帳支取 · 7013196970300100 約定申購"),
    "purchase",
    "the phrase alone is insufficient",
  );
  assert.equal(
    classify(
      "轉帳支取 · 7013196970300100 YT95 FS01150344 約定申購 08015 270 FISB",
    ),
    "purchase",
    "a redemption event code cannot prove a subscription",
  );
  assert.equal(
    classify(
      "轉帳支取 · 7013196970300100 YT95 FS01150344 約定申購 08015 174 FISB",
      "another-bank",
    ),
    "purchase",
    "the provider-specific grammar has no authority outside Yuanta",
  );
});

test("credit-card payment relation requires one exact statement in its payment window", () => {
  const transaction = {
    direction: "outflow" as const,
    amountCoefficient: "3765",
    amountScale: 0,
    currency: "TWD",
    effectiveOn: "2026-08-22",
  };
  const statement = {
    statementId: "statement-august",
    statementRevisionId: "statement-august-r1",
    issueDate: "2026-08-06",
    dueDate: "2026-08-24",
    currency: "TWD",
    balanceCoefficient: "376500",
    balanceScale: 2,
  };
  assert.deepEqual(
    matchUniqueCreditCardStatementForBankOutflow(transaction, [statement]),
    {
      statementId: statement.statementId,
      statementRevisionId: statement.statementRevisionId,
    },
  );
  assert.equal(
    matchUniqueCreditCardStatementForBankOutflow(transaction, [
      statement,
      { ...statement, statementId: "another", statementRevisionId: "another-r1" },
    ]),
    null,
    "equal competing statements make the relation ambiguous",
  );
  assert.equal(
    matchUniqueCreditCardStatementForBankOutflow(
      { ...transaction, effectiveOn: "2026-08-25" },
      [statement],
    ),
    null,
    "a payment outside the issue/due window is not inferred",
  );
  assert.equal(
    matchUniqueCreditCardStatementForBankOutflow(
      { ...transaction, amountCoefficient: "3764" },
      [statement],
    ),
    null,
    "the amount must be exact",
  );
});

test("every advertised bank/deposit scope has a versioned Kind route", () => {
  assertValidTaxonomyPackage();
  const routes = new Map(
    TRANSACTION_TAXONOMY_PACKAGE_V1.automaticRoutes
      .filter((route) => route.field === "kind" && route.scopeKey)
      .map((route) => [route.scopeKey!, route]),
  );
  for (const scope of BANK_TRANSACTION_KIND_SUPPORTED_SCOPES) {
    const route = routes.get(scope);
    assert.ok(route, `missing Kind route for ${scope}`);
    if (!route) continue;
    if (scope === "cathay/domestic-deposit") {
      assert.equal(route.producerId, CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID);
      assert.equal(route.producerVersion, CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION);
    } else {
      assert.equal(route.producerId, BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID);
      assert.equal(route.producerVersion, BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION);
      assert.ok(
        (BANK_TRANSACTION_KIND_ENRICHMENT_ROUTE_SCOPES as readonly string[]).includes(scope),
      );
    }
    assert.equal(route.originPolicy, scope === "cathay/domestic-deposit" ? "source_or_derived" : "derived");
  }
});

test("all derived bank Kind outputs are admitted by the published taxonomy", () => {
  const outputs = [
    "purchase",
    "transfer.internal",
    "transfer.external",
    "transfer.investment_contribution",
    "transfer.investment_withdrawal",
    "payment.credit_card",
    "payment.loan",
    "cash.deposit",
    "cash.withdrawal",
    "fee.bank",
    "fee.card",
    "fee.loan",
    "fee.investment",
    "interest.earned",
    "interest.charged",
    "tax.payment",
    "tax.refund",
    "loan.disbursement",
    "investment.trade.buy",
    "investment.trade.sell",
    "refund",
    "reversal",
    "receipt",
  ] as const;
  for (const output of outputs) {
    for (const evidenceKind of BANK_TRANSACTION_KIND_ENRICHMENT_EVIDENCE_KINDS) {
      assert.equal(
        producerAllowsOutput(
          BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID,
          BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION,
          "derived",
          "kind",
          output,
          evidenceKind,
        ),
        true,
        `${output}:${evidenceKind}`,
      );
    }
  }
});
