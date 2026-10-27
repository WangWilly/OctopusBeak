import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { chromium } from "playwright";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { yuantaCollectionContext, yuantaStagingHandle } from "./yuanta-collection.fixtures.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import { YUANTA_EBANK_ORIGIN, yuantaEbankSite } from "./yuanta-ebank-site.ts";
import { StatementComponentAbsentError } from "../lib/automation/product-collection.ts";

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

const workflowSource = await readFile(
  new URL("./yuanta-credit-card-statements.ts", import.meta.url),
  "utf8",
);
const workflowImports = workflowSource.slice(
  0,
  workflowSource.indexOf("\n\ntype MonthOption = YuantaCreditCardMonthOption;"),
);
assert.match(
  workflowImports,
  /from "\.\.\/ledger\/canonical\/yuanta-credit-card-admission\.ts"/,
);
assert.doesNotMatch(
  workflowImports,
  /from ["']libretto["']|LibrettoWorkflowContext|node:fs\/promises|node:path|pglite-child-rpc/u,
  "the App-owned provider must not depend on a legacy runner, file writer, or child RPC",
);
assert.doesNotMatch(
  workflowSource,
  /executePGliteWorkflowRun|writeStatementFile|creditCardDownloadsDir|downloads[\\/]yuanta-credit-card-statements/u,
  "the typed provider must not commit directly or produce statement files",
);
assert.doesNotMatch(
  workflowSource,
  /export\s+default\s|workflow\(|LibrettoWorkflowContext/u,
  "the provider must expose only its typed App runner",
);
assert.match(workflowSource, /error instanceof SourceTextIntegrityError/u);
assert.match(workflowSource, /context\.text\.assertIntact/u);
assert.match(workflowSource, /PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND/);
assert.match(workflowSource, /PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND/);
const {
  buildYuantaCanonicalCreditCardCaptures,
  deriveYuantaCanonicalHumanAttestation,
  deriveYuantaProjectedInstrumentIdentity,
  findYuantaCreditCardSummaryLink,
  isCreditCardProductAbsentText,
  loadYuantaCreditCardSummaryPage,
  toYuantaCanonicalCreditCardSourceRow,
  submitCreditCardMonthOptions,
  yuantaCanonicalHumanAttestationFromEnvironment,
  yuantaCreditCardCaptureBuilderOptions,
  yuantaCreditCardTerminalPagesFromHtml,
  runYuantaCreditCardStatements,
  stageYuantaCreditCard,
  yuantaCreditCardStatementsInputSchema,
} = await import("./yuanta-credit-card-statements.ts");
const {
  parseCreditCardBillsHtml,
  resolveYuantaSettledStatementCycles,
} = await import("./yuanta-credit-card-parser.ts");

const cancelledSink: PGliteWorkflowRunItem[] = [];
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(
  runYuantaCreditCardStatements(
    {} as never,
    {} as never,
    yuantaCollectionContext({ signal: cancelled.signal }),
    yuantaStagingHandle(cancelledSink),
  ),
  /abort/i,
);
assert.deepEqual(cancelledSink, []);

type SummaryLinkNode = {
  scopeName: "fmenu" | "fmain";
  text: string;
  hasOnclickDecoy?: boolean;
  visible: boolean;
  clicked: boolean;
};

class SummaryLinkLocatorFixture {
  private readonly nodes: readonly SummaryLinkNode[];
  private readonly page: SummaryPageFixture;

  constructor(
    nodes: readonly SummaryLinkNode[],
    page: SummaryPageFixture,
  ) {
    this.nodes = nodes;
    this.page = page;
  }

  filter(options: { hasText: string | RegExp }): SummaryLinkLocatorFixture {
    const pattern = options.hasText;
    return new SummaryLinkLocatorFixture(
      this.nodes.filter((node) =>
        typeof pattern === "string"
          ? node.text.includes(pattern)
          : pattern.test(node.text),
      ),
      this.page,
    );
  }

  nth(index: number): SummaryLinkLocatorFixture {
    return new SummaryLinkLocatorFixture(
      this.nodes[index] ? [this.nodes[index]!] : [],
      this.page,
    );
  }

  async count(): Promise<number> {
    return this.nodes.length;
  }

  async isVisible(): Promise<boolean> {
    return this.nodes[0]?.visible ?? false;
  }

  async click(): Promise<void> {
    const node = this.nodes[0];
    if (node) node.clicked = true;
  }
}

class SummaryFrameFixture {
  readonly name: "fmenu" | "fmain";
  private readonly page: SummaryPageFixture;
  private readonly nodes: readonly SummaryLinkNode[];

  constructor(
    name: "fmenu" | "fmain",
    page: SummaryPageFixture,
    nodes: readonly SummaryLinkNode[],
  ) {
    this.name = name;
    this.page = page;
    this.nodes = nodes;
  }

  locator(_selector: string): SummaryLinkLocatorFixture {
    return new SummaryLinkLocatorFixture(this.nodes, this.page);
  }

  getByRole(
    role: string,
    options: { name: string; exact?: boolean },
  ): SummaryLinkLocatorFixture {
    if (role !== "link") return new SummaryLinkLocatorFixture([], this.page);
    return new SummaryLinkLocatorFixture(
      this.nodes.filter((node) =>
        options.exact
          ? node.text === options.name
          : node.text.includes(options.name),
      ),
      this.page,
    );
  }
}

class SummaryPageFixture {
  readonly hiddenMenuLink: SummaryLinkNode = {
    scopeName: "fmenu",
    text: "信用卡總覽",
    hasOnclickDecoy: true,
    visible: false,
    clicked: false,
  };
  readonly visibleMainLink: SummaryLinkNode = {
    scopeName: "fmain",
    text: "信用卡總覽",
    visible: true,
    clicked: false,
  };
  readonly menuFrame = new SummaryFrameFixture(
    "fmenu",
    this,
    [this.hiddenMenuLink],
  );
  readonly contentFrame = new SummaryFrameFixture(
    "fmain",
    this,
    [this.visibleMainLink],
  );

  frame({ name }: { name: string }): SummaryFrameFixture | null {
    return name === "fmain" ? this.contentFrame : null;
  }

  mainFrame(): null {
    return null;
  }

  frames(): SummaryFrameFixture[] {
    return [this.menuFrame, this.contentFrame];
  }

  locator(_selector: string): SummaryLinkLocatorFixture {
    return new SummaryLinkLocatorFixture([], this);
  }

  getByRole(
    _role: string,
    _options: { name: string; exact?: boolean },
  ): SummaryLinkLocatorFixture {
    return new SummaryLinkLocatorFixture([], this);
  }
}

/** A Yuanta eBank site over a fake page, for the page steps that only probe locators. */
function fakeYuantaSite(page: unknown) {
  return yuantaEbankSite(page as never, {
    signal: new AbortController().signal,
    text: strictSourceText,
  });
}

const summaryLinkFixture = new SummaryPageFixture();
const visibleSummaryLink = await findYuantaCreditCardSummaryLink(
  fakeYuantaSite(summaryLinkFixture),
  250,
);
assert.ok(visibleSummaryLink);
await visibleSummaryLink.click();
assert.equal(summaryLinkFixture.hiddenMenuLink.clicked, false);
assert.equal(summaryLinkFixture.visibleMainLink.clicked, true);
assert.equal(summaryLinkFixture.visibleMainLink.hasOnclickDecoy, undefined);

const responseBodyCurrentCreditHtml = `
  <table class="rwdTable">
    <tr><th>信用額度</th><th>已使用額度</th><th>信用額度餘額</th><th>預借現金額度</th></tr>
    <tr><td>160,000</td><td>3,741</td><td>156,259</td><td>16,000</td></tr>
  </table>
`;
let summaryClickArguments: unknown[] | undefined;
let renderedDomRead = false;
const responseBodyFixture = {
  mainFrame() {
    return null;
  },
  frames() {
    return [
      { url: () => "https://ebank.yuantabank.com.tw/nib/tx/creditcardbillsquery" },
      { url: () => "https://ebank.yuantabank.com.tw/nib/pages/vnib/feature-overview" },
    ];
  },
  async waitForResponse(
    predicate: (response: typeof responseBodyResponseFixture) => boolean,
  ) {
    assert.equal(predicate(responseBodyResponseFixture), true);
    return responseBodyResponseFixture;
  },
  async waitForLoadState() {},
  locator() {
    renderedDomRead = true;
    throw new Error("rendered frame never exposed the response table");
  },
};
const responseBodyResponseFixture = {
  url: () => "https://ebank.yuantabank.com.tw/nib/tx/creditcardsummary",
  request: () => ({ method: () => "POST" }),
  status: () => 200,
  headers: () => ({
    date: "Thu, 10 Sep 2026 02:03:04 GMT",
    "cache-control": "no-store",
  }),
  async body() {
    return Buffer.from(responseBodyCurrentCreditHtml, "utf8");
  },
};
const responseBodyLinkFixture = {
  async click(...args: unknown[]) {
    summaryClickArguments = args;
  },
};
const responseBodyLoaded = await loadYuantaCreditCardSummaryPage(
  fakeYuantaSite(responseBodyFixture),
  responseBodyLinkFixture as never,
);
assert.deepEqual(summaryClickArguments, []);
assert.equal(renderedDomRead, false);
assert.equal(responseBodyLoaded.currentUsedCredit?.usedCredit, "3741");


const noPagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a onclick="queryMonth('0')">115/06</a>
`;
const pagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a class="pager" href="javascript:goPage(2)">下一頁</a>
`;

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

const historyPeriods = [
  "115/01",
  "115/02",
  "115/03",
  "115/04",
  "115/05",
  "115/06",
];
const historyIssuerSummaries = historyPeriods.map((period, index) => {
  const closeMonth = String(index + 1).padStart(2, "0");
  const dueMonth = String(index + 2).padStart(2, "0");
  return {
    period,
    closeDate: `2026-${closeMonth}-20`,
    issueDate: `2026-${closeMonth}-21`,
    dueDate: `2026-${dueMonth}-05`,
    balance: "1000",
    minimumPayment: "100",
  };
});

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
assert.equal(
  identity?.sourceConnectionKey,
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "user-001", yuanta_account: "main-account" },
    "different-managed-secret",
  )?.sourceConnectionKey,
  "managed-secret rotation must not change Source Connection identity",
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
const workflowSummaries = periods.map((period, index) => {
  const month = String(index + 1).padStart(2, "0");
  return {
    period,
    cycleStart: `2026-${month}-01`,
    cycleEnd: `2026-${month}-20`,
    issueDate: `2026-${month}-21`,
    dueDate: `2026-${month}-25`,
    balance: "100.00",
    minimumPayment: "10.00",
  };
});
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
  includeSummary: true,
  terminalPages: [true, true, true, true, true, true, true],
  billedRows,
  unbilledRows,
  statementSummaries: workflowSummaries,
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
const historyCaptureInput = {
  ...captureInput,
  statementSummaries: resolveYuantaSettledStatementCycles(historyIssuerSummaries),
};
const historyBuilderOptions = yuantaCreditCardCaptureBuilderOptions(historyCaptureInput);
assert.ok(historyBuilderOptions);
assert.equal(historyBuilderOptions.statementSummaries?.length, 5);
assert.equal(
  buildYuantaCanonicalCreditCardCaptures(historyCaptureInput)[0]?.statements.length,
  5,
);
assert.equal(
  yuantaCreditCardCaptureBuilderOptions({
    ...captureInput,
    includeSummary: false,
    statementSummaries: undefined,
  }),
  undefined,
);
assert.deepEqual(
  yuantaCreditCardTerminalPagesFromHtml([noPagerResponse], pagerResponse),
  [true, false],
);
const canonicalCaptures = buildYuantaCanonicalCreditCardCaptures(captureInput);
assert.equal(canonicalCaptures.length, 1);
const canonicalCapture = canonicalCaptures[0]!;
assert.equal(canonicalCapture.transactions.length, 7);
assert.throws(
  () => buildYuantaCanonicalCreditCardCaptures({
    ...captureInput,
    capture: { ...fullCaptureMetadata, captureId: "yuanta-identical-billed-unbilled-overlap" },
    unbilledRows: [{ ...billedRows[0]!, period: null }],
  }),
  /ambiguous identical economic transaction/u,
  "identical rows from billed and unbilled queries remain blocked without a provider boundary ID",
);
assert.equal(canonicalCapture.statements.length, 6);
assert.equal(canonicalCapture.scope.completeness.settledSummaryEvidencePresent, true);
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
  6,
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
    minimumPayment: "10.00",
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

const rewardsCardBlockHtml = `
  <div class="cardBx Mb_m">
    <div class="cardHead"><h4>SYNTHETIC PRIMARY CARD 主卡</h4></div>
    <ul class="cardInfoD">
      <li><h5>卡號</h5><p>4111-11**-****-1234</p></li>
    </ul>
    <table class="rwdTable">
      <tr><th>消費日期</th><th>入帳日期</th><th>消費明細</th><th>國家/幣別</th><th>外幣折算日</th><th>外幣金額</th><th>新臺幣金額</th></tr>
      <tr><td>2026-06-02</td><td>2026-06-03</td><td>BILLED 115/06</td><td>台灣/TWD</td><td></td><td></td><td>100.00</td></tr>
      <tr><td>2026-06-10</td><td>2026-06-10</td><td>鑽金紅利回饋</td><td>台灣/TWD</td><td></td><td></td><td>-12.00</td></tr>
    </table>
  </div>
`;
const rewardsPeriodRows = parseCreditCardBillsHtml(
  rewardsCardBlockHtml,
  "115/06",
  false,
).rows;
assert.deepEqual(
  rewardsPeriodRows.map((row) => [row.description, row.creditCardNo]),
  [
    ["BILLED 115/06", "4111-11**-****-1234"],
    ["鑽金紅利回饋", "4111-11**-****-1234"],
  ],
  "a 鑽金紅利回饋 row belongs to the card block it appears under",
);
const rewardsCaptures = buildYuantaCanonicalCreditCardCaptures({
  ...captureInput,
  capture: { ...fullCaptureMetadata, captureId: "yuanta-rewards-row-capture" },
  billedRows: [...billedRows.slice(0, 5), ...rewardsPeriodRows],
});
assert.equal(
  rewardsCaptures.length,
  1,
  "a 鑽金紅利回饋 row must not block the credit-card capture",
);
const rewardsTransaction = rewardsCaptures[0]!.transactions.find(
  (transaction) => transaction.description === "鑽金紅利回饋",
);
assert.ok(rewardsTransaction);
assert.equal(rewardsTransaction.billingStatus, "billed");
assert.equal(
  rewardsTransaction.instrumentKey,
  rewardsCaptures[0]!.transactions.find(
    (transaction) => transaction.description === "BILLED 115/06",
  )?.instrumentKey,
);
assert.equal(rewardsCaptures[0]!.transactions.length, 8);

// The build half from read snapshots (ADR 0065): only a read that covered the
// whole Query Inventory (ADR 0062) stages, and the counts follow the read.
const stageInput = {
  ...yuantaCreditCardStatementsInputSchema.parse({}),
  canonicalHumanAttestation: identity,
  instrumentFingerprintSecret: "synthetic-managed-secret",
};
const fullSnapshot = {
  allMonthOptions: monthOptions,
  selectedMonthOptions: monthOptions,
  billedRows,
  billedHistoryPages: historyIssuerSummaries.map((summary, index) => ({
    sourceKey: "yuanta-credit-card.queryHistoryDetail.settled-summary-v2" as const,
    monthIndex: index,
    pageOrdinal: index,
    summary,
  })),
  terminalPages: [true, true, true, true, true, true, true],
  unbilledRows,
};
const currentUsedCreditEvidence = {
  limit: "100000",
  usedCredit: "12345",
  available: "87655",
  sourceField: "已使用額度" as const,
  endpoint: "https://ebank.yuantabank.com.tw/nib/tx/creditcardsummary",
  httpDate: "Thu, 10 Sep 2026 02:03:04 GMT",
  cacheControl: "no-store",
};
function stageSnapshot(
  snapshot: Parameters<typeof stageYuantaCreditCard>[0],
  input: Parameters<typeof stageYuantaCreditCard>[1] = stageInput,
) {
  const staged: PGliteWorkflowRunItem[] = [];
  const summary = stageYuantaCreditCard(
    snapshot,
    input,
    yuantaCollectionContext(),
    yuantaStagingHandle(staged),
  );
  return { summary, products: staged.map((item) => item.product), staged };
}
{
  const { summary, products } = stageSnapshot({
    ...fullSnapshot,
    currentUsedCredit: currentUsedCreditEvidence,
  });
  assert.deepEqual(products, ["credit-card", "current-balance"]);
  assert.deepEqual(summary, { sourceCaptureCount: 8, rowCount: 7 });
}
assert.deepEqual(stageSnapshot(fullSnapshot).products, ["credit-card"]);
for (const [scope, snapshot, input, counts] of [
  [
    "monthIndexes requested",
    fullSnapshot,
    { ...stageInput, monthIndexes: [0, 1, 2, 3, 4, 5] },
    { sourceCaptureCount: 8, rowCount: 7 },
  ],
  [
    "unbilled excluded",
    { ...fullSnapshot, terminalPages: fullSnapshot.terminalPages.slice(1), unbilledRows: [] },
    { ...stageInput, includeUnbilled: false },
    { sourceCaptureCount: 7, rowCount: 6 },
  ],
  [
    "a short grid",
    { ...fullSnapshot, terminalPages: fullSnapshot.terminalPages.slice(1) },
    stageInput,
    { sourceCaptureCount: 8, rowCount: 7 },
  ],
  [
    "a card key that is not four digits",
    {
      ...fullSnapshot,
      unbilledRows: [{ ...unbilledRows[0]!, creditCardNo: "4111-11**-****-12" }],
    },
    stageInput,
    { sourceCaptureCount: 8, rowCount: 7 },
  ],
] as const) {
  const { summary, staged } = stageSnapshot(
    { ...snapshot, currentUsedCredit: currentUsedCreditEvidence },
    input as Parameters<typeof stageYuantaCreditCard>[1],
  );
  assert.deepEqual(staged, [], `${scope} stages nothing`);
  assert.deepEqual(summary, counts, `${scope} still reports what was read`);
}

// The runner against a synthetic signed-in frameset (ADR 0066): the site opens
// the bills route in fmain, every month and the unbilled grid are posted from
// its form, and the current-credit summary is read from its POST response.
test("Yuanta credit card reads the bills, unbilled and summary pages through the creditcardbillsquery route", async () => {
  const SHELL_CID = "synthetic-card-cid";
  const periods = ["115/06", "115/05", "115/04", "115/03", "115/02", "115/01"];
  const summaryLink = `<a href="#" onclick="document.sform.submit(); return false;">信用卡總覽</a>
    <form name="sform" method="post" action="/nib/tx/creditcardsummary"><input type="hidden" name="cid" value="${SHELL_CID}"></form>`;
  const monthForm = (withField = true) => `<form id="mform" name="mform" method="post" action="/nib/tx/creditcardbillsquery">
    <input type="hidden" name="menutype" value="creditcardbillsquery"><input type="hidden" name="iconid" value="menu_creditcardbillsquery">
    ${withField ? '<input type="hidden" name="cdHistoryQuery" value="">' : ""}
  </form>`;
  const monthLinks = periods.map((period, index) => `<a href="#" onclick="queryMonth('${index}')">${period}</a>`).join("");
  const cardBlock = (description: string, day: string) => `<div class="cardBx Mb_m">
    <div class="cardHead"><h4>SYNTHETIC PRIMARY CARD 主卡</h4></div>
    <ul class="cardInfoD"><li><h5>卡號</h5><p>4111-11**-****-1234</p></li></ul>
    <table class="rwdTable">
      <tr><th>消費日期</th><th>入帳日期</th><th>消費明細</th><th>國家/幣別</th><th>外幣折算日</th><th>外幣金額</th><th>新臺幣金額</th></tr>
      <tr><td>${day}</td><td>${day}</td><td>${description}</td><td>台灣/TWD</td><td></td><td></td><td>100.00</td></tr>
    </table>
  </div>`;
  const billsPage = (withField = true, withMonths = true) => `${summaryLink}<div id="months">${withMonths ? monthLinks : ""}</div>
    <table class="rwdTable"><tr><td>歷史帳單明細</td></tr></table>${monthForm(withField)}`;
  const historyPage = (index: number) => {
    const period = periods[index]!;
    const month = period.slice(4);
    const due = String(Number(month) + 1).padStart(2, "0");
    return `${billsPage()}${cardBlock(`BILLED ${period}`, `2026-${month}-02`)}
      <table class="settled-summary">
        <tr><th>帳單月份</th><th>結帳日</th><th>出帳日</th><th>繳款截止日</th><th>本期應繳總額</th><th>本期最低應繳額</th></tr>
        <tr><td>${period}</td><td>${period}/20</td><td>${period}/21</td><td>115/${due}/05</td><td>1,000</td><td>100</td></tr>
      </table>`;
  };
  const currentCreditPage = `<table class="rwdTable">
    <tr><th>信用額度</th><th>已使用額度</th><th>信用額度餘額</th><th>預借現金額度</th></tr>
    <tr><td>160,000</td><td>3,741</td><td>156,259</td><td>16,000</td></tr>
  </table>`;
  const input = {
    ...yuantaCreditCardStatementsInputSchema.parse({}),
    canonicalHumanAttestation: deriveYuantaCanonicalHumanAttestation(
      { yuanta_user_id: "user-001", yuanta_account: "main-account" },
      "synthetic-managed-secret",
    )!,
    instrumentFingerprintSecret: "synthetic-managed-secret",
  };

  const browser = await chromium.launch({ headless: true });
  async function readThroughShell(
    options: Readonly<{
      signal?: AbortSignal;
      billsWithoutForm?: boolean;
      holdMonth?: () => void;
      summaryBody?: Buffer;
      productAbsent?: boolean;
      absentElsewhere?: boolean;
      withoutMonthLinks?: boolean;
      posted?: string[];
      onBillsServed?: () => void;
    }> = {},
  ) {
    const page = await browser.newPage();
    const served: string[] = [];
    const posted: string[] = options.posted ?? [];
    const staged: PGliteWorkflowRunItem[] = [];
    const html = (body: string) => ({ contentType: "text/html; charset=utf-8", body });
    try {
      await page.route(`${YUANTA_EBANK_ORIGIN}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        served.push(`${request.method()} ${url.pathname}${url.search}`);
        const fields = new URLSearchParams(request.postData() ?? "");
        if (url.pathname === "/nib/shell.jsp") {
          return await route.fulfill(html(`<iframe name="fmenu" src="/nib/menu.jsp"></iframe><iframe name="fmain" src="/nib/tx/home?type=page&cid=${SHELL_CID}"></iframe>`));
        }
        if (url.pathname === "/nib/tx/creditcardbillsquery" && request.method() === "GET") {
          if (url.searchParams.get("cid") !== SHELL_CID) return await route.fulfill(html("<p>連線逾時</p>"));
          options.onBillsServed?.();
          if (options.absentElsewhere) return await route.fulfill(html(`<script>location.replace("/nib/tx/notice")</script>`));
          return await route.fulfill(html(options.productAbsent ? "<p>您目前未持有信用卡</p>" : billsPage(!options.billsWithoutForm, !options.withoutMonthLinks)));
        }
        if (url.pathname === "/nib/tx/notice") return await route.fulfill(html("<p>您目前未持有信用卡</p>"));
        if (url.pathname === "/nib/tx/creditcardbillsquery" && url.searchParams.get("method") === "queryHistoryDetail") {
          posted.push(`month ${fields.get("cdHistoryQuery")}`);
          if (options.holdMonth) {
            options.holdMonth();
            return;
          }
          return await route.fulfill(html(historyPage(Number(fields.get("cdHistoryQuery")))));
        }
        if (url.pathname === "/nib/tx/creditcardunbilled") {
          posted.push(`unbilled ${fields.get("menutype")} ${fields.get("iconid")}`);
          return await route.fulfill(html(`${summaryLink}${cardBlock("UNBILLED", "2026-07-02")}`));
        }
        if (url.pathname === "/nib/tx/creditcardsummary" && request.method() === "POST") {
          posted.push("summary");
          return await route.fulfill({
            contentType: "text/html; charset=utf-8",
            headers: { date: "Thu, 10 Sep 2026 02:03:04 GMT", "cache-control": "no-store" },
            body: options.summaryBody ?? Buffer.from(currentCreditPage, "utf8"),
          });
        }
        return await route.fulfill(html(`<p>${url.pathname}</p>`));
      });
      await page.goto(`${YUANTA_EBANK_ORIGIN}/nib/shell.jsp?cid=${SHELL_CID}`, { waitUntil: "load" });
      const summary = await runYuantaCreditCardStatements(
        page,
        input,
        yuantaCollectionContext({ signal: options.signal, now: "2026-07-10T00:00:00.000Z" }),
        yuantaStagingHandle(staged),
      );
      return { summary, served, posted, staged };
    } finally {
      await page.close();
    }
  }

  /** Cancel a run and measure how long it takes to reject after the signal fires. */
  async function cancelledWithin(
    run: (controller: AbortController, cancelAt: (delayMs: number) => void) => Promise<unknown>,
  ): Promise<number> {
    const controller = new AbortController();
    const reason = new Error("credit card read cancelled");
    let cancelledAt = 0;
    const cancelAt = (delayMs: number) => {
      setTimeout(() => {
        cancelledAt = Date.now();
        controller.abort(reason);
      }, delayMs);
    };
    await assert.rejects(run(controller, cancelAt), (error) => error === reason);
    assert.ok(cancelledAt > 0, "the run was still waiting when it was cancelled");
    return Date.now() - cancelledAt;
  }

  try {
    const read = await readThroughShell();
    assert.ok(
      read.served.includes(`GET /nib/tx/creditcardbillsquery?type=page&cid=${SHELL_CID}`),
      "the bills page opens through the creditcardbillsquery route with the session's cid",
    );
    assert.deepEqual(
      read.posted,
      [
        ...periods.map((_period, index) => `month ${index}`),
        "unbilled creditcardunbilled menu_creditcardunbilled",
        "summary",
      ],
      "every month is posted in order from the bills form, then the unbilled grid, then the summary",
    );
    assert.deepEqual(read.summary, { sourceCaptureCount: 8, rowCount: 7 });
    assert.deepEqual(
      read.staged.map((item) => item.product),
      ["credit-card", "current-balance"],
      "a full capture stages the statements and the current used credit read from the summary response",
    );

    await assert.rejects(
      readThroughShell({ productAbsent: true }),
      (error) => error instanceof StatementComponentAbsentError && error.disposition === "not_held",
      "a login without a card fails as not held while the route renders",
    );
    const absentElsewhereStartedAt = Date.now();
    await assert.rejects(
      readThroughShell({ absentElsewhere: true }),
      (error) => error instanceof StatementComponentAbsentError && error.disposition === "not_held",
      "a login without a card that the bank redirects to a notice elsewhere also fails as not held",
    );
    assert.ok(Date.now() - absentElsewhereStartedAt < 15_000, "the redirected notice is recognised without waiting out the route");

    // The bills page is ready once fmain shows creditcardbillsquery, as the
    // old read of the served page was: a page without month links is not
    // waited on for 60 s, it fails at once in the month-link parser.
    const noMonthsStartedAt = Date.now();
    const noMonthsPosted: string[] = [];
    await assert.rejects(
      readThroughShell({ withoutMonthLinks: true, posted: noMonthsPosted }),
      /Could not find YuanTa credit card statement month links\./u,
    );
    assert.deepEqual(noMonthsPosted, [], "no month or unbilled query is posted");
    assert.ok(
      Date.now() - noMonthsStartedAt < 15_000,
      "a bills page without month links fails in the parser, not after the 60 s route wait",
    );

    await assert.rejects(
      readThroughShell({ summaryBody: Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]) }),
      SourceTextIntegrityError,
      "an undecodable summary response fails the product instead of reading as an empty body",
    );

    const afterFormWait = await cancelledWithin((controller, cancelAt) =>
      readThroughShell({
        signal: controller.signal,
        billsWithoutForm: true,
        // The route renders and settles well within 3 s; the run then waits up to 120 s for the month form.
        onBillsServed: () => cancelAt(3_000),
      }));
    assert.ok(afterFormWait < 2_000, `a run cancelled in the bills form wait rejects promptly (${afterFormWait} ms)`);

    const afterMonthWait = await cancelledWithin((controller, cancelAt) =>
      readThroughShell({ signal: controller.signal, holdMonth: () => cancelAt(0) }));
    assert.ok(afterMonthWait < 2_000, `a run cancelled in the month response wait rejects promptly (${afterMonthWait} ms)`);
  } finally {
    await browser.close();
  }
});
