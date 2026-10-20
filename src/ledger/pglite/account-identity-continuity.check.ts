import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalDepositCapture, type PGliteCanonicalDepositCommitRequest } from "./deposit.ts";
import {
  resolvePGliteAccountIdentityContinuity,
  type AccountIdentityContinuityRequest,
} from "./account-identity-continuity.ts";
import { PGliteStore } from "./transaction.ts";

const token = (value: string): string => `sha256:${createHash("sha256").update(value).digest("base64url")}`;
const evidencedNumber = "12345678901234";
const otherNumber = "9".repeat(14);

function depositFor(captureId: string, sourceAccountKey: string, identifierValue: string): PGliteCanonicalDepositCommitRequest {
  const occurrenceKey = token(`${captureId}:occurrence`);
  return {
    capture: {
      captureId,
      authorityRoute: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      identity: {
        integrationNamespace: "cathay",
        sourceConnectionKey: token("connection"),
        identityEpochKey: token("epoch"),
        stream: "domestic-deposit",
        recordKind: "synthetic-deposit",
        subjectDigest: sourceAccountKey,
        accountNo: sourceAccountKey,
        sourceAccountKey,
        accountNumber: {
          value: identifierValue,
          kind: "depository-account",
          evidenceVersion: "synthetic-account-v1",
          sourceField: "accountNumber",
        },
        accountType: "depository",
        currency: "TWD",
      },
      observedAt: "2026-09-22T00:00:00.000Z",
      scope: {
        startDate: "2026-09-22",
        endDate: "2026-09-22",
        scopeKind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: "synthetic-complete-range",
        completenessRuleVersion: "cathay/domestic-deposit/v1",
        absenceAuthority: "comparable-complete-range",
        contractFingerprint: token("contract"),
        preflightFingerprint: token("preflight"),
        pageCount: 1,
        withdrawalPolicy: "never-infer",
      },
      semantics: {
        postingStatus: "posted",
        postingOrigin: "provider_booked_history",
        postingBasis: "query-status-success-with-accounting-date",
        postingRuleVersion: "cathay/domestic-deposit/v1",
        economicStatus: "normal",
        administrativeState: "active",
        semanticRuleVersion: "cathay/domestic-deposit/v1",
        effectiveTimeBasis: "accounting",
        effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
        timeZone: "Asia/Taipei",
        timePrecision: "second",
        timeOrigin: "source_reported",
        requireBalance: false,
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        responseDigest: token(`${captureId}:page`),
        proofKind: "synthetic",
        contractFingerprint: token("contract"),
        preflightFingerprint: token("preflight"),
        metadataJson: JSON.stringify({ provider: "synthetic" }),
      }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}:collision`),
        providerKey: token(`${captureId}:provider`),
        contentHash: token(`${captureId}:content`),
        sequenceLexeme: "1",
        compactJson: JSON.stringify({ amount: { coefficient: "100", scale: 0 } }),
        amount: { coefficient: "100", scale: 0 },
        balanceAfter: null,
        currency: "TWD",
        direction: "inflow",
        sourceTime: {
          localDate: "2026-09-22",
          localTime: "12:00:00",
          timeZone: "Asia/Taipei",
          epochMilliseconds: Date.parse("2026-09-22T12:00:00+08:00"),
          precision: "second",
          timeOrigin: "source_reported",
        },
        effectiveOn: "2026-09-22",
        transactionDateTimeLocal: "2026-09-22T12:00:00",
        description: "synthetic deposit",
      }],
    },
  };
}

const request: AccountIdentityContinuityRequest = {
  integrationNamespace: "cathay",
  sourceConnectionKey: token("connection"),
  identityEpochKey: token("epoch"),
  stream: "domestic-deposit",
  identifier: { kind: "depository-account", value: evidencedNumber },
};

async function withStore(run: (store: PGliteStore) => Promise<void>): Promise<void> {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

test("an identifier no admitted account carries is unseen", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalDepositCapture(store, depositFor("continuity-other", token("other-account"), otherNumber), { clock: () => 1 });
    assert.deepEqual(await resolvePGliteAccountIdentityContinuity(store, request), { status: "unseen" });
  });
});

test("one admitted account carrying the identifier continues under its source account key", async () => {
  await withStore(async (store) => {
    const admittedKey = token("admitted-account");
    await commitPGliteCanonicalDepositCapture(store, depositFor("continuity-first", admittedKey, evidencedNumber), { clock: () => 1 });
    await commitPGliteCanonicalDepositCapture(store, depositFor("continuity-second", admittedKey, evidencedNumber), { clock: () => 2 });
    assert.deepEqual(
      await resolvePGliteAccountIdentityContinuity(store, request),
      { status: "continued", sourceAccountKey: admittedKey },
      "two observations of the same account are one match",
    );
  });
});

test("two admitted accounts carrying the identifier are ambiguous and name no key", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalDepositCapture(store, depositFor("continuity-a", token("account-a"), evidencedNumber), { clock: () => 1 });
    await commitPGliteCanonicalDepositCapture(store, depositFor("continuity-b", token("account-b"), evidencedNumber), { clock: () => 2 });
    assert.deepEqual(await resolvePGliteAccountIdentityContinuity(store, request), { status: "ambiguous", accountCount: 2 });
  });
});

test("evidence in another namespace, connection, epoch, or stream, or of another kind, is not matched", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalDepositCapture(store, depositFor("continuity-scoped", token("scoped-account"), evidencedNumber), { clock: () => 1 });
    assert.equal((await resolvePGliteAccountIdentityContinuity(store, request)).status, "continued");
    const outOfScope: Record<string, AccountIdentityContinuityRequest> = {
      namespace: { ...request, integrationNamespace: "fubon" },
      connection: { ...request, sourceConnectionKey: token("another-connection") },
      epoch: { ...request, identityEpochKey: token("another-epoch") },
      stream: { ...request, stream: "foreign-currency-deposit" },
      kind: { ...request, identifier: { kind: "loan-account", value: evidencedNumber } },
    };
    for (const [name, scoped] of Object.entries(outOfScope))
      assert.deepEqual(await resolvePGliteAccountIdentityContinuity(store, scoped), { status: "unseen" }, `another ${name} must not match`);
  });
});
