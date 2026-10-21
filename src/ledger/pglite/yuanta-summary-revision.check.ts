import assert from "node:assert/strict";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { PGliteStore } from "./transaction.ts";
import { deriveSourceConnectionIdentityKey } from "../canonical/source-connection-identity.ts";
import {
  YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  admitYuantaDomesticDepositCaptureEvidence,
  admitYuantaDomesticDepositFinancialCapture,
} from "../canonical/yuanta-domestic-deposit-admission.ts";
import { YUANTA_HUMAN_ATTESTED_V2_MANIFEST } from "../canonical/yuanta-human-attestation-contract.ts";

const sourceConnectionScope = "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001";
const sourceConnectionKey = deriveSourceConnectionIdentityKey("yuanta", sourceConnectionScope);
const accountValue = "0012345678901234";
const dividendNote = "7013196970300100 安聯智城收FS01218041 基金配息 08015 271 FISB";

function dividendRow(summary: string, note = dividendNote): string[] {
  return ["臺幣活期存款", accountValue, "20261020", "20261020", "10:49:49", summary, "", "7894", "11169", "", note];
}
const salaryRow = ["臺幣活期存款", accountValue, "20261019", "20261019", "09:10:00", "薪資", "", "3275", "3275", "", ""];

function yuantaCapture(observedOn: string, rows: readonly string[][]) {
  const startDate = new Date(`${observedOn}T00:00:00.000Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  const evidence = admitYuantaDomesticDepositCaptureEvidence({
    evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "yuanta",
    observedAt: `${observedOn}T16:00:00+08:00`,
    account: { value: accountValue, label: `臺幣活期存款 ${accountValue}` },
    queryRange: { dateRange: "one_week", startDate: startDate.toISOString().slice(0, 10), endDate: observedOn },
    downloads: [{
      filename: "synthetic-yuanta.csv",
      byteLength: 0,
      contentDigest: `sha256:${"b".repeat(64)}`,
      columnNames: [...YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES],
      rows: rows.map((values, rowOrdinal) => ({ rowOrdinal, values: [...values] })),
      terminal: true,
    }],
    provenance: {
      source: "yuanta-ebank-domestic-deposit-csv",
      encoding: "big5",
      responseBodyRetained: false,
      semantics: "unresolved",
      querySelector: "#acctno",
      submitSelector: "#submitbutton",
      downloadSelector: "a.order_2.m_color_check",
      telemetryVersion: YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
    },
  });
  assert.equal(evidence.status, "admissible", evidence.diagnostics.join(","));
  const financial = admitYuantaDomesticDepositFinancialCapture({
    capture: evidence.capture!,
    captureId: `yuanta-summary-revision-${observedOn}-${rows.map((row) => row[5]).join("-")}`,
    humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
    sourceConnectionScope,
    sourceConnectionKey,
  });
  assert.equal(financial.status, "admitted", financial.diagnostics.join(","));
  return financial.capture!;
}

async function dividendDescriptions(store: PGliteStore): Promise<string[]> {
  const rows = await store.query<{ description: string }>(
    `SELECT revision.description
       FROM transaction_revisions revision
      WHERE revision.amount_coefficient = '7894'
      ORDER BY revision.revision_number`,
  );
  return rows.rows.map((row) => row.description.split(" · ")[0]!);
}

async function transactionCount(store: PGliteStore): Promise<number> {
  return (await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]!.count;
}

test("a Yuanta summary rewritten after commit revises the committed transaction", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await commitPGliteCanonicalDepositCapture(store, yuantaCapture("2026-10-20", [salaryRow, dividendRow("基金配息")]));
    await commitPGliteCanonicalDepositCapture(store, yuantaCapture("2026-10-21", [salaryRow, dividendRow("轉帳存入")]));
    assert.equal(await transactionCount(store), 2, "the rewritten summary keeps one transaction");
    assert.deepEqual(await dividendDescriptions(store), ["基金配息", "轉帳存入"]);

    await commitPGliteCanonicalDepositCapture(store, yuantaCapture("2026-10-22", [salaryRow, dividendRow("轉帳存入")]));
    assert.deepEqual(await dividendDescriptions(store), ["基金配息", "轉帳存入"], "an unchanged recapture adds no revision");

    await commitPGliteCanonicalDepositCapture(store, yuantaCapture("2026-10-23", [salaryRow, dividendRow("基金配息")]));
    assert.equal(await transactionCount(store), 2);
    assert.deepEqual(await dividendDescriptions(store), ["基金配息", "轉帳存入", "基金配息"], "the summary may change back");
  } finally {
    await store.close();
  }
});

test("a Yuanta note rewritten after commit still conflicts", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await commitPGliteCanonicalDepositCapture(store, yuantaCapture("2026-10-20", [salaryRow, dividendRow("基金配息")]));
    await assert.rejects(
      commitPGliteCanonicalDepositCapture(store, yuantaCapture("2026-10-21", [salaryRow, dividendRow("基金配息", "其他備註")])),
      /occurrence/u,
    );
    assert.deepEqual(await dividendDescriptions(store), ["基金配息"]);
  } finally {
    await store.close();
  }
});
