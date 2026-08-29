import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ctbcResponseDiagnosticDirectoryFromEnvironment,
  writeCtbcResponseDiagnostic,
} from "./ctbc-response-diagnostic.ts";

const diagnostic = {
  capturedAt: "2026-08-29T21:09:00+08:00",
  resource: "/twrbc-deposit/qu002/011",
  account: {
    accountId: "PRIVATE-ACCOUNT-ID",
    label: "PRIVATE-ACCOUNT-LABEL",
  },
  rangeOrdinal: 5,
  visibleMonthLabel: "2026/03",
  expectedRange: {
    firstDateYYYYMMDD: "20260301",
    lastDateYYYYMMDD: "20260331",
  },
  queryPeriods: ["2026/03/01~2026/03/31"],
  request: {
    method: "POST",
    url: "https://example.invalid/IB/api/resource",
    postData: '{"resource":"/twrbc-deposit/qu002/011","private":"REQUEST"}',
  },
  response: {
    code: "0000",
    rsData: {
      detailList: [],
      nextKey: null,
      privateField: "RESPONSE",
    },
  },
} as const;

assert.equal(ctbcResponseDiagnosticDirectoryFromEnvironment({}), null);
assert.equal(await writeCtbcResponseDiagnostic(null, diagnostic), null);

const root = await mkdtemp(join(tmpdir(), "ctbc-response-diagnostic-"));
const directory = join(root, "private");
try {
  const filePath = await writeCtbcResponseDiagnostic(directory, diagnostic);
  assert.ok(filePath);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(saved.schemaVersion, "ctbc-response-diagnostic-v1");
  assert.equal(saved.request.postData, diagnostic.request.postData);
  assert.deepEqual(saved.response, diagnostic.response);
  assert.deepEqual(saved.expectedRange, diagnostic.expectedRange);
} finally {
  await rm(root, { recursive: true, force: true });
}
