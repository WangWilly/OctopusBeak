import assert from "node:assert/strict";
import test from "node:test";
import * as fubon from "./fubon-domestic-deposit-admission.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "./fubon-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

const accountDigits = "12345678901234";
const scope = "synthetic-fubon-user\0synthetic-fubon-account";
const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", scope);

function admitWithAccountValue(value: string) {
  const raw = structuredClone(fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  const account = {
    value,
    label: `${accountDigits} (SYNTHETIC-BRANCH)`,
    branchName: "SYNTHETIC-BRANCH",
  };
  raw.account = account;
  raw.pages = raw.pages.map((page) => ({ ...page, selectedAccount: account }));
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

test("a non-TWD-coded composite option stays out of financial admission even when route evidence says TWD", () => {
  const result = admitWithAccountValue(`123-00${accountDigits}-USD-02`);
  assert.equal(result.capture, null, "USD-coded option must not admit as TWD");
  assert.ok(
    result.diagnostics.includes("currency-unproven"),
    result.diagnostics.join(","),
  );
  assert.ok(
    result.diagnostics.every(fubon.isFubonSourceOnlyFinancialDiagnostic),
    `diagnostics must route to source-only: ${result.diagnostics.join(",")}`,
  );
});

test("a TWD-coded composite option in the same position still admits", () => {
  const result = admitWithAccountValue(`123-00${accountDigits}-TWD-01`);
  assert.ok(result.capture, result.diagnostics.join(","));
  assert.equal(result.diagnostics.includes("currency-unproven"), false);
});
