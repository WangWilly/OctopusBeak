import assert from "node:assert/strict";
import test from "node:test";
import * as fubon from "./fubon-domestic-deposit-admission.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "./fubon-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

const accountDigits = "12345678901234";
const scope = "synthetic-fubon-user\0synthetic-fubon-account";
const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", scope);

const decimal = (coefficient: string, scale: number): fubon.FubonExactDecimal => ({ coefficient, scale });
const reconcilingRecord: fubon.FubonDepositBalanceReconciliation = {
  sourceField: "statement 即時餘額 vs current-balance instantBalance",
  latestRow: { localDate: "2026-01-02", localTime: "09:10:11", runningBalance: decimal("100", 0) },
  snapshotTwdBalance: decimal("10000", 2),
  snapshotOtherBalances: [{ currency: "USD", balance: decimal("1234", 2) }],
  snapshotObservedAt: "2026-01-31T12:00:00.000Z",
};

function admitWithAccountValue(
  value: string,
  balanceReconciliation?: fubon.FubonDepositBalanceReconciliation,
) {
  const raw = structuredClone(fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  const option = { value, label: `${accountDigits} (SYNTHETIC-BRANCH)` };
  const accountNumber = fubon.deriveFubonCompositeAccountNumberEvidence(option);
  const account = {
    ...option,
    branchName: "SYNTHETIC-BRANCH",
    ...(accountNumber ? { accountNumber } : {}),
  };
  raw.account = account;
  raw.pages = raw.pages.map((page) => ({ ...page, selectedAccount: account }));
  if (balanceReconciliation)
    raw.providerRouteEvidence = { ...raw.providerRouteEvidence!, balanceReconciliation };
  const structural = fubon.admitFubonDomesticDepositCaptureEvidence(raw);
  assert.ok(structural.capture, structural.diagnostics.join(","));
  assert.equal(structural.capture.providerRouteEvidence?.currency, "TWD");
  const identity = fubon.deriveFubonDomesticDepositAccountIdentity(
    structural.capture.account,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    sourceConnectionKey,
  );
  const rule = fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  return fubon.admitFubonDomesticDepositFinancialCapture({
    capture: structural.capture,
    captureId: `fubon-composite-${value}`,
    sourceConnectionScope: scope,
    sourceConnectionKey,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    semantics: {
      evidenceVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      account: {
        ...identity,
        ...(accountNumber ? { accountNumber } : {}),
        accountType: "depository",
        currency: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
      },
      authority: {
        route: rule,
        scope: "personal-owned-accounts",
        membershipEffectiveDate: null,
      },
      posting: {
        status: "posted",
        origin: fubon.FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
        basis: fubon.FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
        ruleVersion: rule,
      },
      direction: { outflowCellIndex: 3, inflowCellIndex: 4, ruleVersion: rule },
      effectiveTime: {
        basis: fubon.FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
        timeZone: fubon.FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
        ruleVersion: rule,
      },
      cancellation: { rule: "explicit-none-only", ruleVersion: rule },
      completeness: {
        basis: fubon.FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
        ruleVersion: rule,
        absenceAuthority: fubon.FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
      },
      occurrence: {
        ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
        providerGuaranteed: false,
      },
    },
  });
}

test("parses the composite selector option into its account segment and currency code", () => {
  assert.deepEqual(
    fubon.parseFubonCompositeAccountOption(` 123-00${accountDigits}-USD-02 `),
    { accountSegment: `00${accountDigits}`, currencyCode: "USD" },
  );
  assert.equal(fubon.parseFubonCompositeAccountOption(accountDigits), null);
  assert.equal(
    fubon.parseFubonCompositeAccountOption(`123-00${accountDigits}-usd-02`),
    null,
  );
});

test("exact decimals compare by value after aligning scales", () => {
  assert.equal(fubon.fubonExactDecimalEquals(decimal("100", 0), decimal("10000", 2)), true);
  assert.equal(fubon.fubonExactDecimalEquals(decimal("10000", 2), decimal("100", 0)), true);
  assert.equal(fubon.fubonExactDecimalEquals(decimal("100", 0), decimal("10001", 2)), false);
  assert.equal(fubon.fubonExactDecimalEquals(decimal("-100", 0), decimal("100", 0)), false);
});

const row = (date: string, time: string, balance: string) => ({
  cells: [date, time, "SYNTHETIC", "", "1", balance, ""] as const,
});

test("the latest statement row is the greatest date then time, the later one in capture order on a tie", () => {
  assert.deepEqual(
    fubon.fubonDepositLatestStatementRow([
      { rows: [row("2026/01/03", "08:00:00", "30"), row("2026/01/02", "23:59:59", "20")] },
      { rows: [row("2026/01/03", "07:59:59", "10")] },
    ]),
    { localDate: "2026-01-03", localTime: "08:00:00", runningBalance: decimal("30", 0) },
    "a later page with an earlier row does not win on capture order alone",
  );
  assert.deepEqual(
    fubon.fubonDepositLatestStatementRow([
      { rows: [row("2026/01/03", "08:00:00", "30")] },
      { rows: [row("2026/01/03", "08:00:00", "1,234.50")] },
    ]),
    { localDate: "2026-01-03", localTime: "08:00:00", runningBalance: decimal("123450", 2) },
    "a tie goes to the row later in capture order",
  );
  assert.equal(fubon.fubonDepositLatestStatementRow([]), null);
  assert.equal(fubon.fubonDepositLatestStatementRow([{ rows: [] }]), null);
  assert.equal(
    fubon.fubonDepositLatestStatementRow([{ rows: [row("2026/01/03", "08:00:00", "n/a")] }]),
    null,
    "an unparseable running balance on the latest row yields no latest row",
  );
});

test("route currency is TWD for a plain or TWD-coded option and for a USD-coded one only with a reconciling balance record", () => {
  const label = `${accountDigits} (SYNTHETIC-BRANCH)`;
  const usd = `123-00${accountDigits}-USD-02`;
  const pages = [{ rows: [row("2026/01/02", "09:10:11", "100")] }];
  const laterPages = [...pages, { rows: [row("2026/01/02", "09:10:12", "100")] }];
  const sameTimeOtherBalance = [{ rows: [row("2026/01/02", "09:10:11", "99")] }];
  const matchesUsd = {
    ...reconcilingRecord,
    snapshotOtherBalances: [{ currency: "USD", balance: decimal("100", 0) }],
  };
  const mismatched = { ...reconcilingRecord, snapshotTwdBalance: decimal("10001", 2) };
  const cases: ReadonlyArray<
    readonly [string, string, typeof pages, fubon.FubonDepositBalanceReconciliation | undefined, "TWD" | "unknown"]
  > = [
    ["plain option, no record", accountDigits, pages, undefined, "TWD"],
    ["TWD-coded option, no record", `123-00${accountDigits}-TWD-01`, pages, undefined, "TWD"],
    ["USD-coded with a reconciling record", usd, pages, reconcilingRecord, "TWD"],
    ["USD-coded with a reconciling record and no rows in this capture", usd, [{ rows: [] }], reconcilingRecord, "TWD"],
    ["USD-coded without a record", usd, pages, undefined, "unknown"],
    ["USD-coded whose snapshot TWD balance equals its USD balance", usd, pages, matchesUsd, "unknown"],
    ["USD-coded whose snapshot TWD balance differs from the running balance", usd, pages, mismatched, "unknown"],
    ["USD-coded whose capture has a row later than the record's latest row", usd, laterPages, reconcilingRecord, "unknown"],
    ["USD-coded whose same-time latest row carries another balance", usd, sameTimeOtherBalance, reconcilingRecord, "unknown"],
    ["USD-coded whose segment does not match its label", `123-99${accountDigits}-USD-02`, pages, reconcilingRecord, "unknown"],
    ["JPY-coded with a reconciling record", `123-00${accountDigits}-JPY-02`, pages, reconcilingRecord, "unknown"],
  ];
  for (const [name, value, capturePages, balanceReconciliation, expected] of cases)
    assert.equal(
      fubon.fubonDepositRouteCurrency({
        account: { value, label },
        pages: capturePages,
        providerRouteEvidence: { balanceReconciliation },
      }),
      expected,
      name,
    );
});

test("a USD-coded composite option with a reconciling balance record admits with V3 evidence", () => {
  const result = admitWithAccountValue(`123-00${accountDigits}-USD-02`, reconcilingRecord);
  assert.ok(result.capture, result.diagnostics.join(","));
  assert.equal(result.diagnostics.includes("currency-unproven"), false);
  assert.equal(
    result.capture.identity.accountNumber?.evidenceVersion,
    fubon.FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION_V3,
  );
});

for (const [name, value, record] of [
  ["a USD-coded option without a balance record", `123-00${accountDigits}-USD-02`, undefined],
  [
    "a USD-coded option whose snapshot TWD balance equals another currency's balance",
    `123-00${accountDigits}-USD-02`,
    { ...reconcilingRecord, snapshotOtherBalances: [{ currency: "USD", balance: decimal("100", 0) }] },
  ],
  ["a JPY-coded option with a reconciling record", `123-00${accountDigits}-JPY-02`, reconcilingRecord],
  ["a USD-coded option whose segment does not match its label", `123-99${accountDigits}-USD-02`, reconcilingRecord],
] as const) {
  test(`${name} stays out of financial admission even when route evidence says TWD`, () => {
    const result = admitWithAccountValue(value, record);
    assert.equal(result.capture, null, `${name} must not admit as TWD`);
    assert.ok(result.diagnostics.includes("currency-unproven"), result.diagnostics.join(","));
    assert.ok(
      result.diagnostics.every(fubon.isFubonSourceOnlyFinancialDiagnostic),
      `diagnostics must route to source-only: ${result.diagnostics.join(",")}`,
    );
  });
}

test("a malformed balance reconciliation record is rejected structurally and never downgraded to source-only", () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["a coefficient with a decimal point", { ...reconcilingRecord, snapshotTwdBalance: { coefficient: "1.00", scale: 2 } }],
    ["a negative scale", { ...reconcilingRecord, latestRow: { ...reconcilingRecord.latestRow, runningBalance: { coefficient: "100", scale: -1 } } }],
    ["an empty local date", { ...reconcilingRecord, latestRow: { ...reconcilingRecord.latestRow, localDate: "" } }],
    ["an empty other currency", { ...reconcilingRecord, snapshotOtherBalances: [{ currency: "", balance: decimal("1", 0) }] }],
    ["an empty observation time", { ...reconcilingRecord, snapshotObservedAt: "" }],
    ["another source field", { ...reconcilingRecord, sourceField: "statement" }],
  ];
  for (const [name, record] of malformed) {
    const raw = structuredClone(fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
    raw.providerRouteEvidence = {
      ...raw.providerRouteEvidence!,
      balanceReconciliation: record as fubon.FubonDepositBalanceReconciliation,
    };
    const result = fubon.admitFubonDomesticDepositCaptureEvidence(raw);
    assert.equal(result.status, "rejected", name);
    assert.deepEqual(result.diagnostics, ["balance-reconciliation-invalid"], name);
    assert.equal(fubon.admitFubonDomesticDepositSourceOnlyEvidence(raw).status, "rejected", name);
  }
  const wellFormed = structuredClone(fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  wellFormed.providerRouteEvidence = { ...wellFormed.providerRouteEvidence!, balanceReconciliation: reconcilingRecord };
  assert.equal(fubon.admitFubonDomesticDepositCaptureEvidence(wellFormed).status, "admissible");
});

test("composite account-number evidence is versioned by currency code and rejected under the wrong one", () => {
  const label = `${accountDigits} (SYNTHETIC-BRANCH)`;
  const structuralDiagnostics = (value: string, evidenceVersion: string) => {
    const raw = structuredClone(fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
    const account = {
      value,
      label,
      branchName: "SYNTHETIC-BRANCH",
      accountNumber: {
        value: accountDigits,
        kind: "depository-account",
        evidenceVersion,
        sourceField: "form1:comboAccount option.value + option.text",
      },
    } as typeof raw.account;
    raw.account = account;
    raw.pages = raw.pages.map((page) => ({ ...page, selectedAccount: account }));
    return fubon.admitFubonDomesticDepositCaptureEvidence(raw).diagnostics;
  };
  const usd = `123-00${accountDigits}-USD-02`;
  const twd = `123-00${accountDigits}-TWD-01`;
  const v2 = fubon.FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION_V2;
  const v3 = fubon.FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION_V3;
  assert.equal(v3, "fubon/domestic-deposit/account-number-v3");
  assert.equal(structuralDiagnostics(usd, v3).includes("account-number-evidence-invalid"), false);
  assert.equal(structuralDiagnostics(twd, v2).includes("account-number-evidence-invalid"), false);
  assert.ok(
    structuralDiagnostics(twd, v3).includes("account-number-evidence-invalid"),
    "V3 evidence requires a USD-coded option",
  );
  assert.ok(
    structuralDiagnostics(usd, v2).includes("account-number-evidence-invalid"),
    "V2 evidence requires a TWD-coded option",
  );
});

test("a TWD-coded composite option in the same position still admits", () => {
  const result = admitWithAccountValue(`123-00${accountDigits}-TWD-01`);
  assert.ok(result.capture, result.diagnostics.join(","));
  assert.equal(result.diagnostics.includes("currency-unproven"), false);
});

test("identity stability is the contract: account identity keys stay fixed", () => {
  const account = fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2.account;
  assert.deepEqual(
    fubon.deriveFubonDomesticDepositAccountIdentity(account, FUBON_HUMAN_ATTESTED_V1_MANIFEST, sourceConnectionKey),
    {
      accountNo: "sha256:mJc2Tu_o2TCQrsUX-xGcfoDmXoJ3RzqReOyMq1Vq7Hw",
      sourceConnectionKey: "sha256:YieOHSsXZyl2dFJDEh3Ov0sge-9eir99c8HTkn7s-ss",
      identityEpochKey: "sha256:Wc-uChIep3jqYX8oPQZ3ts7EcxBf188cPcp8xgJs690",
      subjectDigest: "sha256:mJc2Tu_o2TCQrsUX-xGcfoDmXoJ3RzqReOyMq1Vq7Hw",
    },
  );
  assert.equal(
    fubon.deriveFubonDomesticDepositAccountIdentity(account, FUBON_HUMAN_ATTESTED_V1_MANIFEST).sourceConnectionKey,
    "sha256:cQA_FBtlHu9vqfGA2llk6A6OoBdE3DI3_RbKev_ZBdM",
    "the legacy compatibility source key is unchanged",
  );
});

const identityOf = (value: string) =>
  fubon.deriveFubonDomesticDepositAccountIdentity(
    { value, label: `${accountDigits} (SYNTHETIC-BRANCH)`, branchName: "SYNTHETIC-BRANCH" },
    FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    sourceConnectionKey,
  );
const twdValue = `123-00${accountDigits}-TWD-01`;
const usdValue = `123-00${accountDigits}-USD-01`;

test("identity pins stay fixed for a TWD-coded composite, a USD-coded composite, and a V1 bare digit value", () => {
  const twd = identityOf(twdValue);
  assert.equal(twd.accountNo, "sha256:xeksKSdLQ_I-uRZo-r77FpAga5wpxUdbgB69hM3I-RQ");
  assert.equal(twd.subjectDigest, twd.accountNo);
  const bare = identityOf(accountDigits);
  assert.equal(bare.accountNo, "sha256:7WXovsuVT0sHUd7xJOy13Fds_1y5RVvqULtyguhwkPI");
  assert.equal(bare.subjectDigest, bare.accountNo);
  const usd = identityOf(usdValue);
  assert.equal(usd.accountNo, "sha256:yHiR0UZ3Ae2rQB-4QcRxebK9ENey7MNaBXBUk_ivbtE", "a USD-coded composite hashes its raw option value");
  assert.equal(usd.subjectDigest, usd.accountNo);
});

