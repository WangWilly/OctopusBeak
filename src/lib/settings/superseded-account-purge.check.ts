import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationTaskHistoryRow } from "../automation/types.ts";
import type { SupersededAccountIdentity } from "../automation/server/typed-workflow-outcome.ts";
import {
  fubonDepositPurgeRequest,
  isListedSupersededAccountIdentity,
  latestFubonSupersededAccountIdentities,
  rowIsVisible,
  rowStateAfterPreview,
  supersededAccountPurgeOutcomeDto,
  supersededAccountPurgePreviewDto,
} from "./superseded-account-purge.ts";

const key = (letter: string) => `sha256:${letter.repeat(43)}` as const;
const identity: SupersededAccountIdentity = {
  supersededSourceAccountKey: key("S"),
  successorSourceAccountKey: key("T"),
};

function run(
  taskId: string,
  startedAt: string,
  supersededAccountIdentities?: readonly SupersededAccountIdentity[],
  summarised = true,
): AutomationTaskHistoryRow {
  return {
    taskRunId: `${taskId}-${startedAt}`,
    taskId,
    kind: "crawler",
    status: summarised ? "completed" : "running",
    startedAt,
    finishedAt: summarised ? startedAt : null,
    exitCode: summarised ? 0 : null,
    signal: null,
    appWorkflowOutcome: summarised
      ? {
        errorCode: null,
        summary: {
          status: "financial-admitted",
          counts: {},
          ...(supersededAccountIdentities ? { supersededAccountIdentities } : {}),
        },
      }
      : null,
  };
}

test("the Settings row reads candidates from the latest summarised Fubon run only", () => {
  assert.deepEqual(latestFubonSupersededAccountIdentities([]), []);
  assert.deepEqual(latestFubonSupersededAccountIdentities([
    run("fubon-all-statements", "2026-10-16T02:00:00.000Z", undefined, false),
    run("cathay-all-statements", "2026-10-16T01:30:00.000Z", [{ ...identity, successorSourceAccountKey: key("C") }]),
    run("fubon-all-statements", "2026-10-16T01:00:00.000Z", [identity]),
    run("fubon-all-statements", "2026-10-15T01:00:00.000Z", [{ ...identity, successorSourceAccountKey: key("O") }]),
  ]), [identity], "a running Fubon task defers to its previous summarised run; other tasks never count");
  assert.deepEqual(latestFubonSupersededAccountIdentities([
    run("fubon-all-statements", "2026-10-15T01:00:00.000Z", [identity]),
    run("fubon-all-statements", "2026-10-16T01:00:00.000Z"),
  ]), [], "a newer Fubon run without candidates hides the row");
});

test("the purge IPC accepts only a pair the latest run listed", () => {
  assert.equal(isListedSupersededAccountIdentity([identity], { ...identity }), true);
  assert.equal(isListedSupersededAccountIdentity([identity], { ...identity, successorSourceAccountKey: key("X") }), false);
  assert.equal(isListedSupersededAccountIdentity([identity], { supersededSourceAccountKey: identity.supersededSourceAccountKey }), false);
  assert.equal(isListedSupersededAccountIdentity([], identity), false);
  assert.equal(isListedSupersededAccountIdentity([identity], null), false);
  assert.deepEqual(fubonDepositPurgeRequest(identity), {
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    ...identity,
  });
});

test("ledger purge results reach the renderer as counts or a refusal reason only", () => {
  assert.deepEqual(supersededAccountPurgePreviewDto({
    supersededAccountId: "account-a",
    successorAccountId: "account-b",
    transactionCount: 4,
    captureCount: 2,
    balanceObservationCount: 1,
    deletedRowCount: 20,
    deletedTableCounts: { financial_accounts: 1 },
  }), { status: "ready", transactionCount: 4, captureCount: 2, balanceObservationCount: 1 });
  assert.deepEqual(
    supersededAccountPurgePreviewDto({ refused: "external-reference", table: "t", constraint: "c" }),
    { status: "refused", reason: "external-reference" },
  );
  assert.deepEqual(supersededAccountPurgeOutcomeDto({
    purgeId: "purge",
    supersededAccountId: "account-a",
    successorAccountId: "account-b",
    deletedRowCount: 20,
    deletedTableCounts: { financial_accounts: 1 },
    closureFingerprint: "fingerprint",
    linkedCommitCount: 2,
  }), { status: "purged", deletedRowCount: 20 });
});

test("row state hides a missing superseded account and keeps the deleted chip after this session's purge", () => {
  const ready = { status: "ready", transactionCount: 4, captureCount: 2, balanceObservationCount: 1 } as const;
  assert.deepEqual(rowStateAfterPreview(ready, false), { kind: "ready", preview: ready, confirming: false });
  const missing = { status: "refused", reason: "superseded-account-missing" } as const;
  assert.deepEqual(rowStateAfterPreview(missing, false), { kind: "missing" });
  assert.equal(rowIsVisible(rowStateAfterPreview(missing, false)), false);
  assert.deepEqual(rowStateAfterPreview(missing, true), { kind: "purged" });
  assert.equal(rowIsVisible(rowStateAfterPreview(missing, true)), true);
  assert.deepEqual(
    rowStateAfterPreview({ status: "refused", reason: "successor-account-missing" }, false),
    { kind: "refused", reason: "successor-account-missing" },
  );
  assert.equal(rowIsVisible({ kind: "loading" }), false);
});

test("the confirmation copy names the permanent deletion, its transactions, the surviving history, and irreversibility in both locales", async () => {
  const { translations } = await import("../i18n/i18n.ts");
  assert.equal(
    translations.en.settings.supersededAccountConfirm(7),
    "The duplicate account identity created by the old contract will be permanently deleted together with its 7 transactions. The surviving account already carries the re-collected history. This action cannot be undone.",
  );
  assert.equal(
    translations["zh-TW"].settings.supersededAccountConfirm(7),
    "舊規則建立的重複帳戶身分將連同它的 7 筆交易永久刪除。保留的帳戶已帶有重新收集的歷史紀錄。此動作無法復原。",
  );
  assert.equal(translations["zh-TW"].settings.supersededAccount, "Fubon 帳戶身分重複");
  assert.equal(translations.en.settings.supersededAccountCounts(7, 2, 1), "7 transactions · 2 captures · 1 balance observations");
});
