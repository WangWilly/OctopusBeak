import assert from "node:assert/strict";
import test from "node:test";
import * as fubon from "./fubon-domestic-deposit-admission.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "./fubon-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

const accountDigits = "12345678901234";
const scope = "synthetic-fubon-user\0synthetic-fubon-account";
const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", scope);

const twdTab = fubon.FUBON_DEPOSIT_TWD_RESULT_TAB_LABEL;
const fxTab = "外幣活期存款";
const tabs = [twdTab, fxTab] as const;
const activeTwd: fubon.FubonDepositResultCurrencyEvidence = { kind: "active-tab", label: twdTab, labels: tabs };
const activeFx: fubon.FubonDepositResultCurrencyEvidence = { kind: "active-tab", label: fxTab, labels: tabs };
const noTabs: fubon.FubonDepositResultCurrencyEvidence = { kind: "no-currency-tabs" };
const ambiguous = (
  reason: "no-active-tab" | "multiple-active-tabs" | "currency-column-present",
): fubon.FubonDepositResultCurrencyEvidence => ({ kind: "ambiguous", reason, labels: tabs });

function admitWithAccountValue(
  value: string,
  currencyEvidence: fubon.FubonDepositResultCurrencyEvidence = noTabs,
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
  raw.pages = raw.pages.map((page) => ({
    ...page,
    selectedAccount: account,
    currencyEvidence,
  }));
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

test("route currency follows the active result tab before the selector option's code", () => {
  const label = `${accountDigits} (SYNTHETIC-BRANCH)`;
  const usd = `123-00${accountDigits}-USD-02`;
  const usdMismatch = `123-99${accountDigits}-USD-02`;
  const jpy = `123-00${accountDigits}-JPY-02`;
  const twd = `123-00${accountDigits}-TWD-01`;
  const cases: ReadonlyArray<
    readonly [string, string, ReadonlyArray<fubon.FubonDepositResultCurrencyEvidence>, "TWD" | "unknown"]
  > = [
    ["USD-coded, active 臺幣 on every page", usd, [activeTwd, activeTwd], "TWD"],
    ["USD-coded, one page without tabs", usd, [activeTwd, noTabs], "unknown"],
    ["USD-coded, explicit no-currency-tabs", usd, [noTabs], "unknown"],
    ["USD-coded whose segment does not match its label, active 臺幣", usdMismatch, [activeTwd], "unknown"],
    ["JPY-coded, active 臺幣", jpy, [activeTwd], "unknown"],
    ["USD-coded, active 外幣", usd, [activeFx], "unknown"],
    ["TWD-coded, active 外幣", twd, [activeFx], "unknown"],
    ["codeless, active 外幣", accountDigits, [activeFx], "unknown"],
    ["TWD-coded, no tabs", twd, [noTabs], "TWD"],
    ["TWD-coded, active 臺幣", twd, [activeTwd], "TWD"],
    ["codeless, no tabs", accountDigits, [noTabs], "TWD"],
    ["TWD-coded, tabs without an active marker", twd, [ambiguous("no-active-tab")], "unknown"],
    ["TWD-coded, both tabs marked active", twd, [ambiguous("multiple-active-tabs")], "unknown"],
    ["USD-coded, 幣別 column in the statement table", usd, [ambiguous("currency-column-present")], "unknown"],
    ["TWD-coded, 幣別 on a later page", twd, [noTabs, ambiguous("currency-column-present")], "unknown"],
  ];
  for (const [name, value, evidence, expected] of cases) {
    const pages = evidence.map((currencyEvidence) => ({ currencyEvidence }));
    assert.equal(fubon.fubonDepositRouteCurrency({ value, label }, pages), expected, name);
  }
});

test("a USD-coded composite option whose pages all show the 臺幣活期存款 tab active admits with V3 evidence", () => {
  const result = admitWithAccountValue(`123-00${accountDigits}-USD-02`, activeTwd);
  assert.ok(result.capture, result.diagnostics.join(","));
  assert.equal(result.diagnostics.includes("currency-unproven"), false);
  assert.equal(
    result.capture.identity.accountNumber?.evidenceVersion,
    fubon.FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION_V3,
  );
});

for (const [name, value, evidence] of [
  ["a USD-coded option whose pages show no currency tabs", `123-00${accountDigits}-USD-02`, noTabs],
  ["a USD-coded option whose pages show the 外幣活期存款 tab active", `123-00${accountDigits}-USD-02`, activeFx],
  ["a JPY-coded option with the 臺幣活期存款 tab active", `123-00${accountDigits}-JPY-02`, activeTwd],
  ["a USD-coded option whose segment does not match its label", `123-99${accountDigits}-USD-02`, activeTwd],
  ["a TWD-coded option whose pages show the 外幣活期存款 tab active", `123-00${accountDigits}-TWD-01`, activeFx],
] as const) {
  test(`${name} stays out of financial admission even when route evidence says TWD`, () => {
    const result = admitWithAccountValue(value, evidence);
    assert.equal(result.capture, null, `${name} must not admit as TWD`);
    assert.ok(result.diagnostics.includes("currency-unproven"), result.diagnostics.join(","));
    assert.ok(
      result.diagnostics.every(fubon.isFubonSourceOnlyFinancialDiagnostic),
      `diagnostics must route to source-only: ${result.diagnostics.join(",")}`,
    );
  });
}

test("a page without currency evidence is rejected structurally", () => {
  const raw = structuredClone(fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  const { currencyEvidence: _omitted, ...pageWithoutEvidence } = raw.pages[1]!;
  raw.pages = [raw.pages[0]!, pageWithoutEvidence as typeof raw.pages[number]];
  const result = fubon.admitFubonDomesticDepositCaptureEvidence(raw);
  assert.equal(result.status, "rejected");
  assert.equal(result.capture, null);
  assert.ok(
    result.diagnostics.includes("page-currency-evidence-invalid"),
    result.diagnostics.join(","),
  );
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
