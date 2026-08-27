import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./yuanta-statements.js") {
      return nextResolve("./yuanta-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildYuantaCanonicalCreditCardCaptures,
  deriveYuantaCanonicalHumanAttestation,
  deriveYuantaProjectedInstrumentIdentity,
  hasUntraversedPager,
  isCreditCardProductAbsentText,
  toYuantaCanonicalCreditCardSourceRow,
  submitCreditCardMonthOptions,
  yuantaCanonicalHumanAttestationFromEnvironment,
  yuantaCreditCardCaptureBuilderOptions,
  yuantaCreditCardTerminalPagesFromHtml,
} = await import("./yuanta-credit-card-statements.ts");

const noPagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a onclick="queryMonth('0')">115/06</a>
`;
const pagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a class="pager" href="javascript:goPage(2)">下一頁</a>
`;

assert.equal(hasUntraversedPager(noPagerResponse), false);
assert.equal(hasUntraversedPager(pagerResponse), true);
assert.equal(isCreditCardProductAbsentText("目前未持有信用卡"), true);
assert.equal(isCreditCardProductAbsentText("查無資料"), false);

const submitted: number[] = [];
const handled: number[] = [];
await submitCreditCardMonthOptions(
  [
    { index: 0, label: "115/06" },
    { index: 1, label: "115/05" },
  ],
  async (month) => {
    submitted.push(month.index);
    return noPagerResponse;
  },
  (month) => {
    handled.push(month.index);
  },
);
assert.deepEqual(submitted, [0, 1]);
assert.deepEqual(handled, [0, 1]);
await assert.rejects(
  submitCreditCardMonthOptions(
    [{ index: 0, label: "115/06" }],
    async () => pagerResponse,
    () => assert.fail("truncated response must not be handled"),
  ),
  /untraversed pagination/,
);

const identity = deriveYuantaCanonicalHumanAttestation(
  {
    yuanta_user_id: " user-001 ",
    yuanta_account: " main-account ",
    yuanta_password: "password-must-not-affect-identity",
  },
  "synthetic-managed-secret",
);
assert.ok(identity);
assert.deepEqual(
  identity,
  deriveYuantaCanonicalHumanAttestation(
    {
      yuanta_user_id: "USER-001",
      yuanta_account: "MAIN-ACCOUNT",
      yuanta_password: "rotated-password",
    },
    "synthetic-managed-secret",
  ),
);
assert.notDeepEqual(
  identity,
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "other-user", yuanta_account: "main-account" },
    "synthetic-managed-secret",
  ),
);
assert.notDeepEqual(
  identity,
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "user-001", yuanta_account: "main-account" },
    "different-managed-secret",
  ),
);
assert.equal(
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "user-001", yuanta_account: "" },
    "synthetic-managed-secret",
  ),
  undefined,
);
assert.doesNotMatch(
  JSON.stringify(identity),
  /user-001|main-account|synthetic-managed-secret/iu,
);
const identitySecretKey = "LIBRETTO_CLOUD_FUBON_CARD_IDENTITY_FINGERPRINT_KEY";
const previousIdentitySecret = process.env[identitySecretKey];
process.env[identitySecretKey] = "synthetic-managed-secret";
try {
  assert.deepEqual(
    yuantaCanonicalHumanAttestationFromEnvironment({
      yuanta_user_id: "USER-001",
      yuanta_account: "MAIN-ACCOUNT",
    }),
    identity,
  );
} finally {
  if (previousIdentitySecret === undefined) delete process.env[identitySecretKey];
  else process.env[identitySecretKey] = previousIdentitySecret;
}

const periods = [
  "115/01",
  "115/02",
  "115/03",
  "115/04",
  "115/05",
  "115/06",
];
const monthOptions = periods.map((label, index) => ({ index, label }));
const billedRows = periods.map((period, index) => ({
  creditCardNo: "4111-11**-****-1234",
  creditCardName: "SYNTHETIC PRIMARY CARD",
  consumeDate: `2026-0${index + 1}-02`,
  postedDate: `2026-0${index + 1}-03`,
  description: `BILLED ${period}`,
  countryCurrency: "台灣/TWD",
  foreignExchangeDate: "",
  foreignAmount: "",
  twdAmount: "100.00",
  paymentStatus: "已繳",
  period,
}));
const unbilledRows = [
  {
    ...billedRows[0],
    consumeDate: "2026-07-02",
    postedDate: "2026-07-03",
    description: "UNBILLED PURCHASE",
    twdAmount: "-25.00",
    paymentStatus: "",
    period: null,
  },
];
const fullCaptureMetadata = {
  snapshotMode: "full" as const,
  captureId: "yuanta-workflow-capture",
  capturedAt: "2026-08-27T00:00:00.000Z",
  captureKinds: ["billed", "unbilled"] as ["billed", "unbilled"],
  completenessEvidence: {
    bank: "yuanta",
    monthIndexes: [0, 1, 2, 3, 4, 5],
    unbilled: true,
    pagination: "none",
  },
};
const captureInput = {
  capture: fullCaptureMetadata,
  identity,
  instrumentFingerprintSecret: "synthetic-managed-secret",
  allMonthOptions: monthOptions,
  selectedMonthOptions: monthOptions,
  includeUnbilled: true,
  terminalPages: [true, true, true, true, true, true, true],
  billedRows,
  unbilledRows,
};
const builderOptions = yuantaCreditCardCaptureBuilderOptions(captureInput);
assert.ok(builderOptions);
assert.deepEqual(builderOptions.billedPeriods, periods);
assert.equal(builderOptions.billedRows[0]?.creditCardNo, "****1234");
assert.match(
  builderOptions.billedRows[0]?.instrumentKey ?? "",
  /^yuanta_instrument_[A-Za-z0-9_-]{43}$/u,
);
assert.equal(builderOptions.unbilledRows[0]?.period, null);
assert.deepEqual(
  yuantaCreditCardTerminalPagesFromHtml([noPagerResponse], pagerResponse),
  [true, false],
);
const canonicalCaptures = buildYuantaCanonicalCreditCardCaptures(captureInput);
assert.equal(canonicalCaptures.length, 1);
const canonicalCapture = canonicalCaptures[0]!;
assert.equal(canonicalCapture.transactions.length, 7);
assert.equal(canonicalCapture.statements.length, 0);
assert.equal(canonicalCapture.scope.completeness.settledSummaryEvidencePresent, false);
assert.equal(
  canonicalCapture.transactions.filter((transaction) => transaction.billingStatus === "billed").length,
  6,
);
assert.equal(
  canonicalCapture.transactions.filter((transaction) => transaction.billingStatus === "unbilled").length,
  1,
);
assert.equal(
  canonicalCapture.transactions.filter(
    (transaction) => transaction.billingStatus === "billed" && transaction.statementKey,
  ).length,
  0,
);
assert.equal(canonicalCapture.transactions.at(-1)?.direction, "inflow");
assert.equal(canonicalCapture.instruments[0]?.cardMask, "****1234");
assert.doesNotMatch(
  JSON.stringify(canonicalCapture),
  /411111|4111-11|synthetic-managed-secret/iu,
);

const primaryProjection = deriveYuantaProjectedInstrumentIdentity(
  "4111-11**-****-1234",
  identity,
  "synthetic-managed-secret",
);
const repeatedProjection = deriveYuantaProjectedInstrumentIdentity(
  "4111-11XX-XXXX-1234",
  identity,
  "synthetic-managed-secret",
);
const sameLastFourDifferentPrefix = deriveYuantaProjectedInstrumentIdentity(
  "5222-22**-****-1234",
  identity,
  "synthetic-managed-secret",
);
assert.ok(primaryProjection);
assert.deepEqual(primaryProjection, repeatedProjection);
assert.notEqual(
  primaryProjection.instrumentKey,
  sameLastFourDifferentPrefix?.instrumentKey,
);
assert.equal(primaryProjection.cardMask, "****1234");
assert.doesNotMatch(JSON.stringify(primaryProjection), /411111|4111-11/u);
const twoInstrumentRows = billedRows.map((row, index) =>
  index === 1
    ? {
        ...row,
        creditCardNo: "5222-22**-****-1234",
        creditCardName: "SYNTHETIC SECOND CARD",
      }
    : row,
);
const twoInstrumentCapture = buildYuantaCanonicalCreditCardCaptures({
  ...captureInput,
  billedRows: twoInstrumentRows,
})[0]!;
const repeatedTwoInstrumentCapture = buildYuantaCanonicalCreditCardCaptures({
  ...captureInput,
  capture: { ...fullCaptureMetadata, captureId: "yuanta-workflow-repeat" },
  billedRows: twoInstrumentRows,
})[0]!;
assert.equal(twoInstrumentCapture.instruments.length, 2);
assert.deepEqual(
  twoInstrumentCapture.instruments.map((instrument) => instrument.cardMask),
  ["****1234", "****1234"],
);
assert.equal(
  new Set(twoInstrumentCapture.instruments.map((instrument) => instrument.instrumentKey)).size,
  2,
);
assert.deepEqual(
  twoInstrumentCapture.transactions.map((transaction) => transaction.sourceKey).sort(),
  repeatedTwoInstrumentCapture.transactions
    .map((transaction) => transaction.sourceKey)
    .sort(),
);
assert.doesNotMatch(
  JSON.stringify(twoInstrumentCapture),
  /411111|4111-11|522222|5222-22|synthetic-managed-secret/iu,
);
for (const malformed of [
  "****1234",
  "1234",
  "4111111111111234",
  "4111-11**-***-1234",
  "4111-11**-****-12A4",
])
  assert.equal(
    deriveYuantaProjectedInstrumentIdentity(
      malformed,
      identity,
      "synthetic-managed-secret",
    ),
    undefined,
  );
assert.equal(
  deriveYuantaProjectedInstrumentIdentity(
    "4111-11**-****-1234",
    identity,
    "",
  ),
  undefined,
);

const explicitSummaries = periods.map((period, index) => {
  const month = String(index + 1).padStart(2, "0");
  return {
    period,
    cycleStart: `2026-${month}-01`,
    cycleEnd: `2026-${month}-20`,
    issueDate: `2026-${month}-21`,
    dueDate: `2026-${month}-25`,
    balance: "100.00",
  };
});
const explicitCanonicalCapture = buildYuantaCanonicalCreditCardCaptures({
  ...captureInput,
  statementSummaries: explicitSummaries,
})[0]!;
assert.equal(explicitCanonicalCapture.statements.length, 6);
assert.equal(
  explicitCanonicalCapture.scope.completeness.settledSummaryEvidencePresent,
  true,
);
assert.equal(
  explicitCanonicalCapture.transactions.filter(
    (transaction) => transaction.billingStatus === "billed" && transaction.statementKey,
  ).length,
  6,
);
assert.ok(
  explicitCanonicalCapture.statements.every((statement) =>
    statement.transactionSourceKeys.every((sourceRecordKey) =>
      explicitCanonicalCapture.transactions.some(
        (transaction) =>
          transaction.sourceRecordKey === sourceRecordKey &&
          transaction.statementKey === statement.statementKey,
      ),
    ),
  ),
);
assert.equal(
  yuantaCreditCardCaptureBuilderOptions({
    ...captureInput,
    selectedMonthOptions: monthOptions.slice(0, 5),
  }),
  undefined,
);
assert.deepEqual(
  buildYuantaCanonicalCreditCardCaptures({
    ...captureInput,
    terminalPages: [true, true, true, true, true, true, false],
  }),
  [],
);
assert.equal(
  toYuantaCanonicalCreditCardSourceRow({
    ...billedRows[0],
    creditCardNo: "4111-11**-****-1234",
  }, identity, "synthetic-managed-secret")?.creditCardNo,
  "****1234",
);
assert.equal(
  toYuantaCanonicalCreditCardSourceRow(
    { ...billedRows[0], creditCardNo: "****1234" },
    identity,
    "synthetic-managed-secret",
  ),
  undefined,
);
assert.equal(
  yuantaCreditCardCaptureBuilderOptions({
    ...captureInput,
    instrumentFingerprintSecret: "",
  }),
  undefined,
);
