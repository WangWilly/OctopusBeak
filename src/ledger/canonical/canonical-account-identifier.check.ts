import assert from "node:assert/strict";
import test from "node:test";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
} from "./canonical-financial-deposit-writer.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";

const token = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const capture = (accountNumber?: {
  value: string;
  kind:
    | "depository-account"
    | "loan-account"
    | "brokerage-account"
    | "credit-portfolio-account"
    | "platform-account";
}) =>
  admitCanonicalFinancialDepositCapture({
    captureId: token("capture"),
    authorityRoute: "synthetic/domestic-deposit/v8",
    contractVersion: "synthetic-v8",
    identity: {
      integrationNamespace: "synthetic",
      sourceConnectionKey: token("connection"),
      identityEpochKey: token("epoch"),
      stream: "domestic-deposit",
      recordKind: "synthetic-domestic-deposit",
      subjectDigest: token("subject"),
      accountNo: token("source-account-key"),
      accountNumber: accountNumber
        ? {
            ...accountNumber,
            evidenceVersion: "test/account-number/v1",
            sourceField: "account.number",
          }
        : null,
      accountType: "depository",
      currency: "TWD",
    },
    observedAt: "2026-09-08T00:00:00.000Z",
    scope: {
      startDate: "2026-09-01",
      endDate: "2026-09-08",
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "test",
      completenessRuleVersion: "test/account-identifier/v1",
      absenceAuthority: null,
      contractFingerprint: token("contract"),
      preflightFingerprint: token("preflight"),
      pageCount: 1,
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "test",
      postingBasis: "test",
      postingRuleVersion: "test/account-identifier/v1",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "test/account-identifier/v1",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "test/account-identifier/v1",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "source_reported",
      requireBalance: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 0,
        responseDigest: token("page"),
        proofKind: "test",
        contractFingerprint: token("contract"),
        preflightFingerprint: token("preflight"),
        metadataJson: "{}",
      },
    ],
    records: [],
  });

test("financial account keeps source key separate from provider account number", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    await commitCanonicalFinancialDepositCapture(
      store,
      capture({ value: "012345678901", kind: "depository-account" }),
    );
    const row = store.db
      .prepare(
        "SELECT source_account_key, account_no FROM financial_accounts WHERE stream = 'domestic-deposit'",
      )
      .get() as { source_account_key?: string; account_no?: string | null };
    assert.equal(row.source_account_key, token("source-account-key"));
    assert.equal(row.account_no, "012345678901");
    const projection = createCanonicalProjectionRuntime(store.db).read({
      kind: "current",
      families: ["financial-accounts"],
      scope: { sourceConnectionKey: token("connection") },
    }).families["financial-accounts"];
    assert.equal(projection[0]?.sourceAccountKey, token("source-account-key"));
    assert.equal(projection[0]?.accountNo, "012345678901");
  } finally {
    store.close();
  }
});

test("opaque source keys remain key-only when no provider identifier is admitted", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    await commitCanonicalFinancialDepositCapture(store, capture());
    const row = store.db
      .prepare(
        "SELECT source_account_key, account_no FROM financial_accounts WHERE stream = 'domestic-deposit'",
      )
      .get() as { source_account_key?: string; account_no?: string | null };
    assert.equal(row.source_account_key, token("source-account-key"));
    assert.equal(row.account_no, null);
  } finally {
    store.close();
  }
});

test("depository account numbers reject opaque or wrong-kind evidence", () => {
  assert.throws(
    () =>
      capture({
        value: "sha256:opaque",
        kind: "depository-account",
      }),
    /account number/i,
  );
  assert.throws(
    () =>
      capture({
        value: "012345678901",
        kind: "platform-account",
      }),
    /account number/i,
  );
});

test("account identifier observations are immutable outside a contract purge", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    await commitCanonicalFinancialDepositCapture(
      store,
      capture({ value: "012345678901", kind: "depository-account" }),
    );
    const before = Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM financial_account_identifier_observations",
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    assert.equal(before, 1);
    assert.throws(
      () =>
        store.db
          .prepare(
            "UPDATE financial_account_identifier_observations SET identifier_value = ?",
          )
          .run("999999999999"),
      /immutable/i,
    );
    assert.throws(
      () =>
        store.db
          .prepare("DELETE FROM financial_account_identifier_observations")
          .run(),
      /cannot be deleted|immutable/i,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM financial_account_identifier_observations",
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      before,
    );
  } finally {
    store.close();
  }
});
