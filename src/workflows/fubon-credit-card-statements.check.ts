import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./fubon-auth.js") {
      return nextResolve("./fubon-auth.ts", context);
    }
    if (specifier === "./run-selected-statements.js") {
      return nextResolve("./run-selected-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildFubonCanonicalCreditCardCaptures,
  fubonCreditCardStatementsInputSchema,
  isFubonStatementSummaryRow,
  parseFubonSettledStatementSummary,
} =
  await import("./fubon-credit-card-statements.ts");

const source = await readFile(
  new URL("./fubon-credit-card-statements.ts", import.meta.url),
  "utf8",
);
const loginEntry = source.slice(
  source.indexOf("async function openCreditCardLoginForm"),
  source.indexOf("async function openStatementDetailsPage"),
);
assert.match(loginEntry, /openFubonLoginForm\(page\)/);
assert.match(source, /findStatementDetailsScope/);
assert.match(source, /StatementComponentAbsentError/);
assert.match(source, /hasFubonCreditCardNoRecord\(scope\)/);
assert.doesNotMatch(
  loginEntry,
  /#menu_CCC|menu_CCC02|task_CCCQU002|landingFrame\.goto|txnFrame\.goto/,
);

const summaryRows = [
  ["115/06/21", "網路繳款"],
  ["115/06/21", "行動銀行繳款"],
  ["", "前期應繳總額"],
];
const transactionRow = ["115/06/21", "咖啡店"];

for (const row of summaryRows) {
  assert.equal(isFubonStatementSummaryRow(row), true);
}
assert.equal(isFubonStatementSummaryRow(transactionRow), false);
assert.deepEqual(
  [...summaryRows, transactionRow].filter(
    (row) => !isFubonStatementSummaryRow(row),
  ),
  [transactionRow],
);

const parsedSummary = parseFubonSettledStatementSummary(
  [
    "卡號",
    "帳單年月",
    "帳單週期",
    "結帳日",
    "繳款截止日",
    "本期應繳總額",
    "最低應繳金額",
  ],
  [
    "123456******1234",
    "115/07",
    "115/06/02～115/07/01",
    "115/07/01",
    "115/07/20",
    "1,234.00元",
    "100.00元",
  ],
);
assert.deepEqual(parsedSummary, {
  cardKey: "1234",
  period: "115/07",
  cycleStart: "2026-06-02",
  cycleEnd: "2026-07-01",
  issueDate: "2026-07-01",
  dueDate: "2026-07-20",
  balance: "1234.00",
  minimumPayment: "100.00",
});

const summaries = ["1234", "5678"].flatMap((cardKey) =>
  Array.from({ length: 6 }, (_, index) => ({
    cardKey,
    period: `period-${index + 1}`,
    cycleStart: `2026-0${index + 1}-01`,
    cycleEnd: `2026-0${index + 1}-28`,
    issueDate: `2026-0${index + 1}-28`,
    dueDate: `2026-0${index + 2}-15`,
    balance: `${index + 1}.00`,
    minimumPayment: "1.00",
  })),
);
const canonicalInput = fubonCreditCardStatementsInputSchema.parse({
  canonicalHumanAttestation: {
    sourceConnectionKey: "fubon-login-connection-v1",
    identityEpochKey: "fubon-credit-epoch-v1",
    accounts: [
      { cardKey: "1234", humanAttestedAccountKey: "portfolio-primary-a" },
      { cardKey: "5678", humanAttestedAccountKey: "portfolio-primary-b" },
    ],
  },
});
const canonicalCaptures = buildFubonCanonicalCreditCardCaptures({
  captureId: "capture-synthetic",
  observedAt: "2026-08-25T00:00:00.000Z",
  statementRows: [
    {
      statement_period: "period-1",
      card_number: "1234",
      consume_date: "115/01/03",
      posting_date: "115/01/04",
      description: "SYNTHETIC A",
      twd_amount: "10.00",
    },
    {
      statement_period: "period-1",
      card_number: "5678",
      consume_date: "115/01/05",
      posting_date: "115/01/06",
      description: "SYNTHETIC B",
      twd_amount: "20.00",
    },
  ],
  unbilledRows: [
    {
      statement_period: "unbilled",
      card_number: "123456******1234",
      consume_date: "115/07/03",
      posting_date: "115/07/04",
      description: "SYNTHETIC C",
      twd_amount: "-5.00",
    },
  ],
  summaries,
  gridStates: Array.from({ length: 7 }, () => ({
    currentPage: "1",
    currentPageSize: String(2_147_483_647),
  })),
  input: canonicalInput,
});
assert.equal(canonicalCaptures.length, 2);
assert.notEqual(
  canonicalCaptures[0]?.identity.accountNaturalKey,
  canonicalCaptures[1]?.identity.accountNaturalKey,
);
assert.deepEqual(canonicalCaptures.map((capture) => capture.statements.length), [6, 6]);
assert.deepEqual(canonicalCaptures.map((capture) => capture.transactions.length), [2, 1]);
assert.equal(canonicalCaptures[0]?.transactions[1]?.billingStatus, "unbilled");
assert.equal(canonicalCaptures[0]?.transactions[1]?.direction, "outflow");
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      captureId: "capture-unmapped",
      observedAt: "2026-08-25T00:00:00.000Z",
      statementRows: [
        {
          statement_period: "period-1",
          card_number: "9999",
          consume_date: "115/01/03",
          posting_date: "115/01/04",
          description: "SYNTHETIC UNMAPPED",
          twd_amount: "10.00",
        },
      ],
      unbilledRows: [],
      summaries,
      gridStates: Array.from({ length: 7 }, () => ({
        currentPage: "1",
        currentPageSize: String(2_147_483_647),
      })),
      input: canonicalInput,
    }),
  /mapping|observed card/i,
);
const { commitFubonCreditCardCaptureBatch, queryFubonCreditCardCurrent } =
  await import("../ledger/canonical/fubon-credit-card.ts");
const { createCanonicalSourceStore } =
  await import("../ledger/canonical/canonical-source-store.ts");
const canonicalStore = createCanonicalSourceStore(":memory:");
try {
  const committed = await commitFubonCreditCardCaptureBatch(
    canonicalStore,
    canonicalCaptures,
  );
  assert.equal(committed.length, 2);
  const current = queryFubonCreditCardCurrent(canonicalStore);
  assert.equal(current.accounts.length, 2);
  assert.equal(current.captures.length, 2);
  assert.deepEqual(
    current.accounts.map((account) => account.statements.length),
    [6, 6],
  );
} finally {
  canonicalStore.close();
}
assert.match(source, /commitFubonCreditCardCaptureBatch/);
assert.match(source, /canonicalFinancialLedgerDir/);
