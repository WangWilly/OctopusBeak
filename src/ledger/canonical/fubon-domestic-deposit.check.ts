import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2,
  FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
  FUBON_DOMESTIC_DEPOSIT_CONTRACT,
  FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
  FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
  FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_PATH,
  FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_CONTRACT,
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositSourceOnlyEvidence,
  admitFubonDomesticDepositFinancialCapture as admitFubonDomesticDepositFinancialCaptureCore,
  commitCanonicalFubonDomesticDepositCapture as commitCanonicalFubonDomesticDepositCaptureCore,
  commitFubonDomesticDepositSourceEvidence as commitFubonDomesticDepositSourceEvidenceCore,
  createFubonDomesticDepositSourceEvidence as createFubonDomesticDepositSourceEvidenceCore,
  deriveFubonDomesticDepositAccountIdentity,
  classifyFubonDomesticDepositRow,
  isFubonHumanAttestedV1Manifest,
  isFubonHumanAttestationDurablyActive,
  recordFubonHumanAttestationEvent,
  revokeFubonHumanAttestedV1,
  preflightFubonDomesticDeposit,
  type FubonDomesticDepositCaptureEvidence,
  type FubonDomesticDepositFinancialSemantics,
} from "./fubon-domestic-deposit.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";
import {
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  canonicalLoanSourceIdentity,
  commitCanonicalLoanCapture,
} from "./loan-financial.ts";
import { resolveLoanRepaymentRelations } from "./loan-repayment-relations.ts";
import {
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
} from "./canonical-source-store.ts";
import { admitCanonicalFinancialDepositCapture } from "./canonical-financial-deposit-writer.ts";
import { buildFubonDomesticDepositReadinessFromLedger } from "./advertised-domestic-deposit-readiness.ts";

const stableFubonConnectionScope = "FUBON-USER-001\u0000FUBON-LOGIN-001";
const stableFubonConnectionKey = deriveSourceConnectionIdentityKey(
  "fubon",
  stableFubonConnectionScope,
);

function admitFubonDomesticDepositFinancialCapture(
  input: Parameters<typeof admitFubonDomesticDepositFinancialCaptureCore>[0],
) {
  return admitFubonDomesticDepositFinancialCaptureCore({
    sourceConnectionScope: stableFubonConnectionScope,
    sourceConnectionKey: stableFubonConnectionKey,
    ...input,
  });
}

function commitCanonicalFubonDomesticDepositCapture(
  store: Parameters<typeof commitCanonicalFubonDomesticDepositCaptureCore>[0],
  input: Parameters<typeof commitCanonicalFubonDomesticDepositCaptureCore>[1],
) {
  return commitCanonicalFubonDomesticDepositCaptureCore(store, {
    sourceConnectionScope: stableFubonConnectionScope,
    sourceConnectionKey: stableFubonConnectionKey,
    ...input,
  });
}

function createFubonDomesticDepositSourceEvidence(
  capture: Parameters<typeof createFubonDomesticDepositSourceEvidenceCore>[0],
  captureId: string,
) {
  return createFubonDomesticDepositSourceEvidenceCore(capture, captureId, {
    sourceConnectionScope: stableFubonConnectionScope,
    sourceConnectionKey: stableFubonConnectionKey,
  });
}

function commitFubonDomesticDepositSourceEvidence(
  store: Parameters<typeof commitFubonDomesticDepositSourceEvidenceCore>[0],
  capture: Parameters<typeof commitFubonDomesticDepositSourceEvidenceCore>[1],
  captureId: string,
) {
  return commitFubonDomesticDepositSourceEvidenceCore(
    store,
    capture,
    captureId,
    {
      sourceConnectionScope: stableFubonConnectionScope,
      sourceConnectionKey: stableFubonConnectionKey,
    },
  );
}

assert.equal(
  FUBON_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "fubon/domestic-deposit/preflight-v1",
);
assert.equal(
  FUBON_HUMAN_ATTESTED_V1_MANIFEST.authority,
  "personal-owned-accounts",
);
assert.equal(FUBON_HUMAN_ATTESTED_V1_MANIFEST.providerGuaranteed, false);
assert.equal(
  Object.isFrozen(FUBON_HUMAN_ATTESTED_V1_MANIFEST.provenance),
  true,
);
assert.equal(Object.isFrozen(FUBON_HUMAN_ATTESTED_V1_MANIFEST.semantics), true);
assert.equal(
  isFubonHumanAttestedV1Manifest(
    structuredClone(FUBON_HUMAN_ATTESTED_V1_MANIFEST),
  ),
  false,
);
assert.equal(
  FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_PATH,
  "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces",
);
assert.equal(
  FUBON_HUMAN_ATTESTED_V1_MANIFEST.provenance.sourceCaptureFingerprint,
  "sha256:1758d3b97375cf82f7d6619482d57b5e16bb4f236d44834043b606bd28af26b8",
);
assert.equal(
  preflightFubonDomesticDeposit(FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1)
    .status,
  "blocked",
);

function captureFor(
  accountValue: string,
  accountLabel: string,
  patch: Partial<FubonDomesticDepositCaptureEvidence> = {},
): FubonDomesticDepositCaptureEvidence {
  const fixture = structuredClone(FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  const account = {
    value: accountValue,
    label: accountLabel,
    branchName: "012",
  };
  const pages = fixture.pages.map((page) => ({
    ...page,
    selectedAccount: { ...account },
    rows: page.rows.map((row) => ({
      ...row,
      cells: [...row.cells] as typeof row.cells,
    })),
  }));
  const finalAccount = patch.account ?? account;
  const finalPages = (patch.pages ?? pages).map((page) => ({
    ...page,
    selectedAccount: { ...finalAccount },
  }));
  return { ...fixture, ...patch, account: finalAccount, pages: finalPages };
}

function admittedCapture(
  accountValue = "ACCOUNT-TWD-001",
  accountLabel = "****0001 (012)",
  patch: Partial<FubonDomesticDepositCaptureEvidence> = {},
) {
  const result = admitFubonDomesticDepositCaptureEvidence(
    captureFor(accountValue, accountLabel, patch),
  );
  assert.equal(result.status, "admissible");
  assert.ok(result.capture);
  return result.capture;
}

function semanticsFor(
  capture: FubonDomesticDepositCaptureEvidence,
  patch: Record<string, unknown> = {},
): FubonDomesticDepositFinancialSemantics {
  const identity = deriveFubonDomesticDepositAccountIdentity(
    capture.account,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    stableFubonConnectionKey,
  );
  return {
    evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    account: {
      ...identity,
      accountType: "depository",
      currency: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
    },
    authority: {
      route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      scope: "personal-owned-accounts",
      membershipEffectiveDate: null,
    },
    posting: {
      status: "posted",
      origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
      basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    direction: {
      outflowCellIndex: 3,
      inflowCellIndex: 4,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    effectiveTime: {
      basis: FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
      timeZone: FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    cancellation: {
      rule: "explicit-none-only",
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    completeness: {
      basis: FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      absenceAuthority: FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
    },
    occurrence: {
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
      providerGuaranteed: false,
    },
    ...patch,
  } as FubonDomesticDepositFinancialSemantics;
}

const firstCapture = admittedCapture();
const firstSemantics = semanticsFor(firstCapture);
const missingFubonLoginIdentity =
  admitFubonDomesticDepositFinancialCaptureCore({
    capture: firstCapture,
    captureId: "fubon-manifest-only-must-not-admit",
    semantics: firstSemantics,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  });
assert.equal(missingFubonLoginIdentity.status, "blocked");
assert.equal(missingFubonLoginIdentity.capture, null);
assert.ok(
  missingFubonLoginIdentity.diagnostics.includes(
    "source-connection-scope-invalid",
  ),
);
assert.ok(
  missingFubonLoginIdentity.diagnostics.includes(
    "source-connection-key-invalid",
  ),
);
const firstAdmission = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-human-attested-first",
  semantics: firstSemantics,
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(firstAdmission.status, "admitted");
assert.ok(firstAdmission.capture);
assert.equal(firstAdmission.capture.records.length, 1);
assert.equal(firstAdmission.capture.records[0]?.direction, "inflow");
assert.equal(
  firstAdmission.capture.identity.accountNo.startsWith("sha256:"),
  true,
);
assert.equal(
  JSON.stringify(firstAdmission.capture).includes("****0001"),
  false,
);

// The provider can render a different non-empty note for the same transaction
// when that transaction is observed through two overlapping query windows.
// Notes remain evidence for repayment-relation rules, but they are not stable
// enough to participate in the transaction occurrence identity.
const noteDriftCaptureRaw = captureFor("ACCOUNT-TWD-001", "****0001 (012)", {
  pages: firstCapture.pages.map((page) => ({
    ...page,
    rows: page.rows.map((row) => ({
      ...row,
      cells: [
        row.cells[0],
        row.cells[1],
        row.cells[2],
        row.cells[3],
        row.cells[4],
        row.cells[5],
        "SYNTHETIC WINDOW-DEPENDENT NOTE",
      ] as typeof row.cells,
    })),
  })),
});
const noteDriftCaptureAdmission =
  admitFubonDomesticDepositCaptureEvidence(noteDriftCaptureRaw);
assert.equal(noteDriftCaptureAdmission.status, "admissible");
assert.ok(noteDriftCaptureAdmission.capture);
const noteDriftFinancialAdmission = admitFubonDomesticDepositFinancialCapture({
  capture: noteDriftCaptureAdmission.capture,
  captureId: "fubon-human-attested-note-drift",
  semantics: semanticsFor(noteDriftCaptureAdmission.capture),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(noteDriftFinancialAdmission.status, "admitted");
assert.ok(noteDriftFinancialAdmission.capture);
assert.equal(
  noteDriftFinancialAdmission.capture.records[0]?.collisionKey,
  firstAdmission.capture.records[0]?.collisionKey,
);
assert.equal(
  noteDriftFinancialAdmission.capture.records[0]?.contentHash,
  firstAdmission.capture.records[0]?.contentHash,
);
assert.equal(
  noteDriftFinancialAdmission.capture.records[0]?.occurrenceKey,
  firstAdmission.capture.records[0]?.occurrenceKey,
);

// A workflow-supplied stable login identity is the connection fence shared by
// deposit and loan products. It replaces the attestation-manifest key in the
// persisted financial identity, while account and attestation epoch checks
// remain strict.
const stableFubonSemantics = semanticsFor(firstCapture, {
  account: {
    ...firstSemantics.account,
    sourceConnectionKey: stableFubonConnectionKey,
  },
});
const stableFubonAdmission = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-stable-source-connection",
  semantics: stableFubonSemantics,
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  sourceConnectionScope: stableFubonConnectionScope,
  sourceConnectionKey: stableFubonConnectionKey,
});
assert.equal(stableFubonAdmission.status, "admitted");
assert.equal(
  stableFubonAdmission.capture?.identity.sourceConnectionKey,
  stableFubonConnectionKey,
);
assert.equal(
  canonicalLoanSourceIdentity("fubon", stableFubonConnectionScope, "LOAN-001")
    .sourceConnectionKey,
  stableFubonConnectionKey,
);
assert.notEqual(
  stableFubonConnectionKey,
  deriveSourceConnectionIdentityKey("fubon", "FUBON-USER-002\u0000FUBON-LOGIN-001"),
);
assert.notEqual(
  stableFubonConnectionKey,
  deriveSourceConnectionIdentityKey("yuanta", stableFubonConnectionScope),
);
const mismatchedFubonEpoch = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-stable-source-connection-wrong-epoch",
  semantics: semanticsFor(firstCapture, {
    account: {
      ...stableFubonSemantics.account,
      identityEpochKey: "sha256:fubon-wrong-epoch",
    },
  }),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  sourceConnectionScope: stableFubonConnectionScope,
  sourceConnectionKey: stableFubonConnectionKey,
});
assert.equal(mismatchedFubonEpoch.status, "blocked");
assert.ok(mismatchedFubonEpoch.diagnostics.includes("account-identity-mismatch"));
const mismatchedFubonConnection = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-stable-source-connection-mismatch",
  semantics: stableFubonSemantics,
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  sourceConnectionScope: stableFubonConnectionScope,
  sourceConnectionKey: deriveSourceConnectionIdentityKey(
    "fubon",
    "FUBON-USER-002\u0000FUBON-LOGIN-001",
  ),
});
assert.equal(mismatchedFubonConnection.status, "blocked");
assert.ok(
  mismatchedFubonConnection.diagnostics.includes(
    "source-connection-key-mismatch",
  ),
);

// The live Fubon table repeats the transaction date in the transaction-time
// cell (`YYYY/MM/DD HH:MM:SS`) instead of returning a bare time. Keep the
// synthetic bare-time fixture for backwards compatibility, but lock down the
// provider shape that previously failed financial admission.
const providerDateTimeCapture = admittedCapture(
  "ACCOUNT-TWD-DATETIME",
  "****0010 (012)",
  {
    pages: firstCapture.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) => ({
        ...row,
        cells: [
          row.cells[0],
          `${row.cells[0]} ${row.cells[1]}`,
          row.cells[2],
          row.cells[3],
          row.cells[4],
          row.cells[5],
          row.cells[6],
        ] as typeof row.cells,
      })),
    })),
  },
);
const providerDateTimeAdmission = admitFubonDomesticDepositFinancialCapture({
  capture: providerDateTimeCapture,
  captureId: "fubon-human-attested-provider-datetime",
  semantics: semanticsFor(providerDateTimeCapture),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(providerDateTimeAdmission.status, "admitted");
assert.ok(providerDateTimeAdmission.capture);
assert.equal(providerDateTimeAdmission.capture.records.length, 1);
const crossDateProviderDateTimeCapture = admittedCapture(
  "ACCOUNT-TWD-DATETIME-CROSS-DATE",
  "****0011 (012)",
  {
    pages: providerDateTimeCapture.pages.map((page, pageIndex) => ({
      ...page,
      rows: page.rows.map((row, rowIndex) => ({
        ...row,
        cells:
          pageIndex === 0 && rowIndex === 0
            ? ([
                row.cells[0],
                "2026/01/03 09:10:11",
                row.cells[2],
                row.cells[3],
                row.cells[4],
                row.cells[5],
                row.cells[6],
              ] as typeof row.cells)
            : ([...row.cells] as typeof row.cells),
      })),
    })),
  },
);
const crossDateProviderDateTimeAdmission =
  admitFubonDomesticDepositFinancialCapture({
    capture: crossDateProviderDateTimeCapture,
    captureId: "fubon-human-attested-provider-datetime-cross-date",
    semantics: semanticsFor(crossDateProviderDateTimeCapture),
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  });
assert.equal(crossDateProviderDateTimeAdmission.status, "admitted");
assert.ok(crossDateProviderDateTimeAdmission.capture);
assert.equal(
  crossDateProviderDateTimeAdmission.capture.records[0]?.effectiveOn,
  "2026-01-03",
);
const wrongAuthoritySemantics = structuredClone(firstAdmission.capture);
wrongAuthoritySemantics.authorityRoute = "cathay/domestic-deposit/v1";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(wrongAuthoritySemantics),
  /semantics do not match/i,
);

const missingRouteEvidence = admitFubonDomesticDepositFinancialCapture({
  capture: admittedCapture("ACCOUNT-TWD-NO-ROUTE", "****0099 (012)", {
    providerRouteEvidence: undefined,
  }),
  captureId: "fubon-human-attested-no-route-evidence",
  semantics: semanticsFor(firstCapture),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(missingRouteEvidence.status, "blocked");
assert.ok(missingRouteEvidence.diagnostics.includes("currency-unproven"));

assert.deepEqual(
  classifyFubonDomesticDepositRow(firstCapture.pages[0]!.rows[0]!.cells),
  {
    status: "posted",
    evidence: "explicit-clean-v1",
  },
);
const pendingRow = admittedCapture("ACCOUNT-TWD-PENDING", "****0098 (012)", {
  pages: firstCapture.pages.map((page) => ({
    ...page,
    rows: page.rows.map((row) => ({
      ...row,
      cells: [
        row.cells[0],
        row.cells[1],
        "待處理",
        row.cells[3],
        row.cells[4],
        row.cells[5],
        row.cells[6],
      ] as typeof row.cells,
    })),
  })),
});
const pendingRowAdmission = admitFubonDomesticDepositFinancialCapture({
  capture: pendingRow,
  captureId: "fubon-human-attested-pending-row-marker",
  semantics: semanticsFor(pendingRow),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(pendingRowAdmission.status, "blocked");
assert.ok(pendingRowAdmission.diagnostics.includes("row-status-unresolved"));
assert.deepEqual(
  classifyFubonDomesticDepositRow([
    "2026/01/02",
    "09:10:11",
    "",
    "",
    "100",
    "100",
    "",
  ]),
  { status: "source-only", evidence: "ambiguous-status-v1" },
);

const fullTerminalPage = captureFor("ACCOUNT-TWD-FULL-PAGE", "****0097 (012)", {
  pages: firstCapture.pages.map((page, index) =>
    index === 1
      ? {
          ...page,
          providerPageSize: 1,
          rows: [
            ...page.rows,
            {
              rowOrdinal: 1,
              cells: [
                "2026/01/03",
                "10:10:11",
                "SYNTHETIC SECOND",
                "",
                "200",
                "300",
                "",
              ] as (typeof page.rows)[number]["cells"],
            },
          ],
          zeroObservation: "non-empty-page" as const,
        }
      : page,
  ),
});
const fullTerminalAdmission =
  admitFubonDomesticDepositCaptureEvidence(fullTerminalPage);
assert.equal(fullTerminalAdmission.status, "rejected");
assert.ok(
  fullTerminalAdmission.diagnostics.includes("terminal-page-incomplete"),
);
const malformedIncomplete = captureFor(
  "ACCOUNT-TWD-INCOMPLETE-MALFORMED",
  "****0095 (012)",
  {
    pages: firstCapture.pages.map((page, index) =>
      index === 1
        ? {
            ...page,
            providerPageSize: 1,
            rows: [
              {
                rowOrdinal: 0,
                cells: [
                  "2026/01/03",
                  "10:10:11",
                  "SYNTHETIC SECOND",
                  "not-an-amount",
                  "",
                  "300",
                  "",
                ] as (typeof page.rows)[number]["cells"],
              },
            ],
            zeroObservation: "non-empty-page" as const,
          }
        : page,
    ),
  },
);
const malformedIncompleteAdmission =
  admitFubonDomesticDepositSourceOnlyEvidence(malformedIncomplete);
assert.equal(malformedIncompleteAdmission.status, "rejected");
assert.ok(malformedIncompleteAdmission.diagnostics.includes("amount-invalid"));

// Multiple personal-owned accounts remain separate subjects even when their
// observed row tuple is byte-for-byte identical.
const secondCapture = admittedCapture("ACCOUNT-TWD-002", "****0002 (012)");
const secondAdmission = admitFubonDomesticDepositFinancialCapture({
  capture: secondCapture,
  captureId: "fubon-human-attested-second",
  semantics: semanticsFor(secondCapture),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(secondAdmission.status, "admitted");
assert.notEqual(
  firstAdmission.capture.identity.subjectDigest,
  secondAdmission.capture?.identity.subjectDigest,
);
assert.notEqual(
  firstAdmission.capture.records[0]?.occurrenceKey,
  secondAdmission.capture?.records[0]?.occurrenceKey,
);
const exactRepeatCapture = captureFor("ACCOUNT-TWD-REPEAT", "****0003 (012)", {
  pages: firstCapture.pages.map((page, index) =>
    index === 1
      ? {
          ...page,
          rows: [
            {
              ...firstCapture.pages[0]!.rows[0]!,
              rowOrdinal: 0,
            },
          ],
          zeroObservation: "non-empty-page" as const,
        }
      : page,
  ),
});
const exactRepeatStructural =
  admitFubonDomesticDepositCaptureEvidence(exactRepeatCapture);
assert.equal(exactRepeatStructural.status, "admissible");
assert.ok(exactRepeatStructural.capture);
const exactRepeatAdmission = admitFubonDomesticDepositFinancialCapture({
  capture: exactRepeatStructural.capture,
  captureId: "fubon-human-attested-exact-repeat",
  semantics: semanticsFor(exactRepeatStructural.capture),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
// Without a provider occurrence identifier, two equal composite fences in
// one capture are not safe to collapse: they may be distinct transactions.
assert.equal(exactRepeatAdmission.status, "blocked");
assert.equal(exactRepeatAdmission.capture, null);
assert.ok(exactRepeatAdmission.diagnostics.includes("occurrence-ambiguous"));
const sameFenceChangedContentCapture = captureFor(
  "ACCOUNT-TWD-REPEAT-CHANGED",
  "****0004 (012)",
  {
    pages: firstCapture.pages.map((page, index) =>
      index === 1
        ? {
            ...page,
            rows: [
              {
                ...firstCapture.pages[0]!.rows[0]!,
                rowOrdinal: 0,
                cells: [
                  firstCapture.pages[0]!.rows[0]!.cells[0],
                  firstCapture.pages[0]!.rows[0]!.cells[1],
                  "DIFFERENT CONTENT",
                  firstCapture.pages[0]!.rows[0]!.cells[3],
                  firstCapture.pages[0]!.rows[0]!.cells[4],
                  firstCapture.pages[0]!.rows[0]!.cells[5],
                  firstCapture.pages[0]!.rows[0]!.cells[6],
                ] as (typeof firstCapture.pages)[number]["rows"][number]["cells"],
              },
            ],
            zeroObservation: "non-empty-page" as const,
          }
        : page,
    ),
  },
);
const sameFenceChangedContentStructural =
  admitFubonDomesticDepositCaptureEvidence(sameFenceChangedContentCapture);
assert.equal(sameFenceChangedContentStructural.status, "admissible");
assert.ok(sameFenceChangedContentStructural.capture);
const sameFenceChangedContentAdmission =
  admitFubonDomesticDepositFinancialCapture({
    capture: sameFenceChangedContentStructural.capture,
    captureId: "fubon-human-attested-same-fence-changed-content",
    semantics: semanticsFor(sameFenceChangedContentStructural.capture),
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  });
assert.equal(sameFenceChangedContentAdmission.status, "blocked");
assert.ok(
  sameFenceChangedContentAdmission.diagnostics.includes(
    "composite-occurrence-collision",
  ),
);
const revokedEpochIdentity = deriveFubonDomesticDepositAccountIdentity(
  firstCapture.account,
  {
    ...FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    status: "revoked",
    revokedAt: "2026-08-22T00:00:00.000Z",
    revocationReason: "epoch test",
  },
);
assert.notEqual(
  firstAdmission.capture.identity.identityEpochKey,
  revokedEpochIdentity.identityEpochKey,
);

const missingAttestation = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-human-attested-missing",
  semantics: firstSemantics,
});
assert.equal(missingAttestation.status, "blocked");
assert.ok(missingAttestation.diagnostics.includes("human-attestation-missing"));

const providerGuaranteed = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-human-attested-provider-guarantee",
  semantics: semanticsFor(firstCapture, {
    occurrence: {
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
      providerGuaranteed: true,
    },
  }),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(providerGuaranteed.status, "blocked");
assert.ok(
  providerGuaranteed.diagnostics.includes(
    "provider-occurrence-guarantee-forbidden",
  ),
);

const shared = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-human-attested-shared",
  semantics: semanticsFor(firstCapture, {
    authority: {
      route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      scope: "shared-member",
      membershipEffectiveDate: "2026-01-01",
    },
  }),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(shared.status, "blocked");
assert.ok(shared.diagnostics.includes("authority-shared-account"));

const fx = admittedCapture("ACCOUNT-USD-001", "USD ****0001 (012)");
const fxResult = admitFubonDomesticDepositFinancialCapture({
  capture: fx,
  captureId: "fubon-human-attested-fx",
  semantics: semanticsFor(fx),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(fxResult.status, "blocked");
assert.ok(fxResult.diagnostics.includes("unsupported-currency"));

const sharedLabel = admittedCapture(
  "ACCOUNT-TWD-SHARED",
  "****0096 (012) 共同",
);
const sharedLabelResult = admitFubonDomesticDepositFinancialCapture({
  capture: sharedLabel,
  captureId: "fubon-human-attested-shared-label",
  semantics: semanticsFor(sharedLabel),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(sharedLabelResult.status, "blocked");
assert.ok(sharedLabelResult.diagnostics.includes("authority-shared-account"));

const pending = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-human-attested-pending",
  semantics: semanticsFor(firstCapture, {
    posting: {
      status: "pending",
      origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
      basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
  }),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(pending.status, "blocked");
assert.ok(pending.diagnostics.includes("posting-status-invalid"));

const cancellation = admitFubonDomesticDepositFinancialCapture({
  capture: firstCapture,
  captureId: "fubon-human-attested-cancellation",
  semantics: semanticsFor(firstCapture, {
    cancellation: {
      rule: "allow-reversal",
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
  }),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(cancellation.status, "blocked");
assert.ok(cancellation.diagnostics.includes("cancellation-rule-invalid"));

const empty = admittedCapture("ACCOUNT-TWD-EMPTY", "****0003 (012)", {
  pages: FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2.pages.map((page) => ({
    ...page,
    rows: [],
    zeroObservation: "empty-page" as const,
  })),
  zeroObservation: "empty-range",
  zeroResultAuthority: "unproven",
});
const emptyBlocked = admitFubonDomesticDepositFinancialCapture({
  capture: empty,
  captureId: "fubon-human-attested-empty-unproven",
  semantics: semanticsFor(empty),
  humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(emptyBlocked.status, "blocked");
assert.ok(emptyBlocked.diagnostics.includes("zero-result-authority-unproven"));

const emptyProvider = admittedCapture("ACCOUNT-TWD-EMPTY-2", "****0004 (012)", {
  pages: FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2.pages.map((page) => ({
    ...page,
    rows: [],
    zeroObservation: "empty-page" as const,
  })),
  zeroObservation: "empty-range",
  zeroResultAuthority: "provider-explicit-no-data",
});
assert.equal(
  admitFubonDomesticDepositFinancialCapture({
    capture: emptyProvider,
    captureId: "fubon-human-attested-empty-provider",
    semantics: semanticsFor(emptyProvider),
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  }).status,
  "admitted",
);

const sourceOnlyEvidence = createFubonDomesticDepositSourceEvidence(
  firstCapture,
  "fubon-source-privacy-check",
);
assert.equal(
  JSON.stringify(sourceOnlyEvidence).includes("ACCOUNT-TWD-001"),
  false,
);
assert.equal(
  JSON.stringify(sourceOnlyEvidence).includes("SYNTHETIC DEPOSIT"),
  false,
);

for (const sourceIdentity of [
  {},
  {
    sourceConnectionScope: stableFubonConnectionScope,
    sourceConnectionKey: deriveSourceConnectionIdentityKey(
      "fubon",
      `${stableFubonConnectionScope}-OTHER`,
    ),
  },
]) {
  assert.throws(
    () =>
      createFubonDomesticDepositSourceEvidenceCore(
        firstCapture,
        "fubon-source-identity-rejected",
        sourceIdentity,
      ),
    /stable caller-supplied|same login/u,
  );
  const rejectedStore = createCanonicalSourceStore(":memory:");
  try {
    await assert.rejects(
      () =>
        commitFubonDomesticDepositSourceEvidenceCore(
          rejectedStore,
          firstCapture,
          "fubon-source-identity-rejected",
          sourceIdentity,
        ),
      /stable caller-supplied|same login/u,
    );
    assert.equal(
      rejectedStore.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
        ?.count,
      0,
    );
  } finally {
    rejectedStore.close();
  }
}

const fubonSourceThenFinancialStore = createCanonicalSourceStore(":memory:");
try {
  await commitFubonDomesticDepositSourceEvidence(
    fubonSourceThenFinancialStore,
    firstCapture,
    "fubon-stable-source-first",
  );
  await commitCanonicalFubonDomesticDepositCapture(
    {
      db: fubonSourceThenFinancialStore.db,
      databasePath: fubonSourceThenFinancialStore.databasePath,
      commitClock: () => fubonSourceThenFinancialStore.commitClock(),
    },
    {
      capture: firstCapture,
      captureId: "fubon-stable-financial-recollection",
      semantics: firstSemantics,
      humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    },
  );
  assert.equal(
    fubonSourceThenFinancialStore.db
      .prepare(
        "SELECT COUNT(*) AS count FROM source_connections WHERE integration_namespace = 'fubon'",
      )
      .get()?.count,
    1,
  );
  const fubonPartitions = fubonSourceThenFinancialStore.db
      .prepare(
        `SELECT COUNT(*) AS captures,
                COUNT(DISTINCT source_connection_id) AS partitions,
                COUNT(DISTINCT capture_key) AS capture_keys
           FROM source_captures`,
      )
      .get() as { captures: number; partitions: number; capture_keys: number };
  assert.equal(fubonPartitions.captures, 2);
  assert.equal(fubonPartitions.partitions, 1);
  assert.equal(fubonPartitions.capture_keys, 2);
  const fubonLineage = fubonSourceThenFinancialStore.db
    .prepare(
      `SELECT COUNT(*) AS rows,
              COUNT(DISTINCT hex(source_record_id) || ':' || hex(capture_id)) AS unique_rows
         FROM source_record_provenance`,
    )
    .get() as { rows: number; unique_rows: number };
  assert.equal(fubonLineage.rows, fubonLineage.unique_rows);
} finally {
  fubonSourceThenFinancialStore.close();
}

const ledgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "fubon-human-attested-v1-"),
);
try {
  const store = createCanonicalSourceStore(join(ledgerDir, "canonical.sqlite"));
  try {
    const writer = {
      db: store.db,
      databasePath: store.databasePath,
      commitClock: () => store.commitClock(),
    };
    assert.throws(
      () =>
        recordFubonHumanAttestationEvent(store.db, {
          attestationId: FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
          evidenceVersion: FUBON_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
          eventKind: "attested",
          manifestStatus: "active",
          eventAt: "2026-08-21T00:00:00.000Z",
          reason: "forged",
          manifestFingerprint: "sha256:forged",
          sequence: 1,
        }),
      /immutable|chain/i,
    );
    const committed = await commitCanonicalFubonDomesticDepositCapture(writer, {
      capture: firstCapture,
      captureId: "fubon-human-attested-commit-1",
      semantics: firstSemantics,
      humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    });
    assert.equal(committed.status, "canonical-live");
    assert.equal(committed.transactionCount, 1);
    const repeated = await commitCanonicalFubonDomesticDepositCapture(writer, {
      capture: firstCapture,
      captureId: "fubon-human-attested-commit-2",
      semantics: firstSemantics,
      humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    });
    // The same single-row capture observed again later is a cross-capture
    // repeat: retain both source provenance entries while keeping one current
    // financial transaction projection.
    assert.equal(repeated.transactionCount, 1);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_captures WHERE record_kind = ?",
        )
        .get("fubon-domestic-deposit")?.count,
      2,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      1,
    );
    assert.equal(isFubonHumanAttestationDurablyActive(store.db), true);
    const durableReadiness = buildFubonDomesticDepositReadinessFromLedger(
      store.db,
    );
    assert.equal(durableReadiness.capability, "canonical-human-attested");
    assert.equal(durableReadiness.liveValidation, "complete");
    assert.equal(durableReadiness.providerGuaranteed, false);
    assert.deepEqual(durableReadiness.semanticBlockers, []);

    // The Fubon human-attested policy never infers withdrawal when a later
    // complete capture omits an older row. A distinct observed row appends;
    // it does not delete the first transaction from current state.
    const later = admittedCapture("ACCOUNT-TWD-001", "****0001 (012)", {
      pages: firstCapture.pages.map((page) => ({
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          cells: [
            "2026/01/03",
            "10:10:11",
            row.cells[2],
            row.cells[3],
            "200",
            "300",
            row.cells[6],
          ] as typeof row.cells,
        })),
      })),
    });
    await commitCanonicalFubonDomesticDepositCapture(writer, {
      capture: later,
      captureId: "fubon-human-attested-commit-later",
      semantics: semanticsFor(later),
      humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    });
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      2,
    );

    const changed = admittedCapture("ACCOUNT-TWD-001", "****0001 (012)", {
      pages: firstCapture.pages.map((page) => ({
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          cells: [
            row.cells[0],
            row.cells[1],
            "CHANGED",
            row.cells[3],
            row.cells[4],
            row.cells[5],
            row.cells[6],
          ] as typeof row.cells,
        })),
      })),
    });
    await assert.rejects(
      () =>
        commitCanonicalFubonDomesticDepositCapture(writer, {
          capture: changed,
          captureId: "fubon-human-attested-collision",
          semantics: semanticsFor(changed),
          humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
        }),
      /collision|overwrite/i,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      2,
    );

    await commitFubonDomesticDepositSourceEvidence(
      store,
      firstCapture,
      "fubon-source-reopen-current",
    );
    const current = queryCanonicalSourceCurrent(store);
    assert.equal(current.status, "durable-source-evidence");
    assert.ok(current.records.length >= 1);
    assert.ok(queryCanonicalSourceHistorical(store, { knowledgeAt: 1 }));
    assert.ok(
      queryCanonicalSourceLineage(store, {
        ...current.records[0]!.identity,
        occurrenceKey: current.records[0]!.occurrenceKey,
      }),
    );

    // The adapter and the loan writer must expose one connection fence for
    // the same stable login, even though their attested account epochs are
    // product-specific. Exercise the resolver against both persisted sides.
    const stableRelationStore = createCanonicalSourceStore(":memory:");
    try {
      const stableRelationCapture = admittedCapture(
        "ACCOUNT-TWD-RELATION",
        "****0042 (012)",
        {
          pages: firstCapture.pages.map((page) => ({
            ...page,
            rows: page.rows.map((row) => ({
              ...row,
              cells: [
                row.cells[0],
                row.cells[1],
                row.cells[2],
                "100",
                "",
                row.cells[5],
                row.cells[6],
              ] as typeof row.cells,
            })),
          })),
        },
      );
      const stableRelationBaseSemantics = semanticsFor(stableRelationCapture);
      const stableRelationSemantics = semanticsFor(stableRelationCapture, {
        account: {
          ...stableRelationBaseSemantics.account,
          sourceConnectionKey: stableFubonConnectionKey,
        },
      });
      const stableRelationAdmission =
        admitFubonDomesticDepositFinancialCapture({
          capture: stableRelationCapture,
          captureId: "fubon-stable-source-connection-deposit",
          semantics: stableRelationSemantics,
          humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
          sourceConnectionScope: stableFubonConnectionScope,
          sourceConnectionKey: stableFubonConnectionKey,
        });
      assert.equal(stableRelationAdmission.status, "admitted");
      const stableInput = {
        capture: stableRelationCapture,
        captureId: "fubon-stable-source-connection-commit",
        semantics: stableRelationSemantics,
        humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
        sourceConnectionScope: stableFubonConnectionScope,
        sourceConnectionKey: stableFubonConnectionKey,
      };
      const stableCommit = await commitCanonicalFubonDomesticDepositCapture(
        stableRelationStore,
        stableInput,
      );
      assert.equal(stableCommit.status, "canonical-live");
      assert.equal(
        (
          stableRelationStore.db
            .prepare(
              "SELECT source_connection_key FROM source_connections WHERE integration_namespace = ?",
            )
            .get("fubon") as { source_connection_key?: string }
        ).source_connection_key,
        stableFubonConnectionKey,
      );

      const stableLoanInput = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
      stableLoanInput.captureId = "fubon-stable-source-connection-loan";
      stableLoanInput.identity.sourceConnectionKey = stableFubonConnectionKey;
      stableLoanInput.relations = [];
      stableLoanInput.counterpartTransactions = [];
      stableLoanInput.relationCoverage = "not-asserted";
      const stableLoan = admitCanonicalLoanCapture(stableLoanInput);
      assert.equal(stableLoan.identity.sourceConnectionKey, stableFubonConnectionKey);
      await commitCanonicalLoanCapture(stableRelationStore, stableLoan);
      const stableLoanPayment = stableLoan.records.find(
        (record) => record.eventKind === "payment",
      );
      assert.ok(stableLoanPayment);
      const stableRelation = await resolveLoanRepaymentRelations(
        stableRelationStore,
        {
          sourceConnectionKey: stableFubonConnectionKey,
          integrationNamespace: "fubon",
          explicitLinks: [
            {
              fromCaptureId: stableInput.captureId,
              fromSourceRecordKey:
                stableRelationAdmission.capture!.records[0]!.occurrenceKey,
              toCaptureId: stableLoan.captureId,
              toSourceRecordKey: stableLoanPayment.sourceRecordKey,
              relationId: "fubon-stable-source-connection-relation",
              contractVersion: "fubon/loan-repayment-link/v1",
              evidenceSourceRecordKey:
                stableRelationAdmission.capture!.records[0]!.occurrenceKey,
            },
          ],
        },
      );
      assert.equal(stableRelation.exactRelationIds.length, 1);
    } finally {
      stableRelationStore.close();
    }

    revokeFubonHumanAttestedV1(
      "2026-08-22T00:00:00.000Z",
      "test revoke",
      store.db,
    );
    assert.notEqual(
      deriveFubonDomesticDepositAccountIdentity(firstCapture.account)
        .identityEpochKey,
      firstSemantics.account.identityEpochKey,
    );
    await assert.rejects(
      () =>
        commitCanonicalFubonDomesticDepositCapture(writer, {
          capture: firstCapture,
          captureId: "fubon-human-attested-after-revoke",
          semantics: firstSemantics,
          humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
        }),
      /revoked/i,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
        .get()?.count,
      2,
    );
  } finally {
    store.close();
  }
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
