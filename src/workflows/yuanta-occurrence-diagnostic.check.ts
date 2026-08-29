import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeYuantaOccurrenceDiagnosticCandidate,
  yuantaOccurrenceDiagnosticDirectoryFromEnvironment,
} from "./yuanta-occurrence-diagnostic.ts";

const capture = {
  evidenceVersion: "capture-evidence-v2",
  source: "yuanta",
  observedAt: "2026-08-29T12:00:00+08:00",
  account: { value: "123456789", label: "臺幣活期存款 123456789" },
  queryRange: {
    dateRange: "one_month",
    startDate: "2026/08/01",
    endDate: "2026/08/29",
  },
  downloads: [
    {
      filename: "statement.csv",
      byteLength: 256,
      contentDigest: "sha256:synthetic",
      columnNames: [
        "帳戶名稱",
        "帳號",
        "帳務日期",
        "交易日期",
        "交易時間",
        "交易說明",
        "支出金額",
        "存入金額",
        "帳面餘額",
        "票據號碼",
        "備註",
      ],
      terminal: true,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "臺幣活期存款 123456789",
            "123456789",
            "20260801",
            "20260801",
            "09:10:11",
            "實際說明",
            "",
            "100",
            "900",
            "",
            "實際備註",
          ],
        },
      ],
    },
  ],
  provenance: {
    source: "yuanta-ebank-domestic-deposit-csv",
    encoding: "big5",
    responseBodyRetained: false,
    semantics: "unresolved",
    querySelector: "#acctno",
    submitSelector: "#submitbutton",
    downloadSelector: "a.order_2.m_color_check",
    telemetryVersion: "domestic-deposit-telemetry-v1",
  },
} as const;

assert.equal(yuantaOccurrenceDiagnosticDirectoryFromEnvironment({}), null);
assert.equal(
  await writeYuantaOccurrenceDiagnosticCandidate(null, {
    captureId: "disabled",
    capture,
  }),
  null,
);

const root = await mkdtemp(join(tmpdir(), "yuanta-occurrence-diagnostic-"));
const directory = join(root, "private");
try {
  const filePath = await writeYuantaOccurrenceDiagnosticCandidate(directory, {
    captureId: "candidate-1",
    capture,
  });
  assert.ok(filePath);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(saved.schemaVersion, "yuanta-occurrence-candidate-v1");
  assert.deepEqual(saved.downloads[0].rows[0].values, capture.downloads[0].rows[0].values);
  assert.equal(saved.account.value, capture.account.value);
} finally {
  await rm(root, { recursive: true, force: true });
}
