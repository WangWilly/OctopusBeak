import assert from "node:assert/strict";
import test from "node:test";
import type { PGliteFinancialPort } from "../../pglite-rpc/pglite-financial-contracts.ts";
import type { SpendingCandidatePageRequest } from "../model.ts";
import { createSpendingDesktopService } from "./spending-desktop-service.ts";

const REQUEST = { knowledgeAt: 7 } as unknown as SpendingCandidatePageRequest;

function harness() {
  const requests: Array<{ operation: string; args: readonly unknown[]; signal?: AbortSignal; finish(value: unknown): void }> = [];
  const financial = {
    request(operation: string, args: readonly unknown[], options?: { signal?: AbortSignal }) {
      return new Promise((resolve) => {
        requests.push({ operation, args, signal: options?.signal, finish: resolve });
      });
    },
  } as unknown as PGliteFinancialPort;
  return { service: createSpendingDesktopService({ financial }), requests };
}

test("a candidate page reads the page with the request and its own abort signal", async () => {
  const { service, requests } = harness();
  const page = service.loadCandidatePage(REQUEST, "page-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.operation, "financial.spending.candidatePage");
  assert.deepEqual(requests[0]!.args, [REQUEST]);
  assert.equal(requests[0]!.signal?.aborted, false);
  requests[0]!.finish({ ok: true });
  assert.deepEqual(await page, { ok: true });
});

test("a candidate page id that is missing, too long or already active is refused before any read", async () => {
  const { service, requests } = harness();
  for (const requestId of ["", "x".repeat(161), 7, undefined]) {
    await assert.rejects(service.loadCandidatePage(REQUEST, requestId), TypeError);
  }
  assert.equal(requests.length, 0);

  void service.loadCandidatePage(REQUEST, "x".repeat(160));
  await assert.rejects(service.loadCandidatePage(REQUEST, "x".repeat(160)), /already active/u);
  assert.equal(requests.length, 1);
});

test("cancelling aborts only an active candidate page", async () => {
  const { service, requests } = harness();
  assert.equal(service.cancelCandidatePage("unknown"), false);
  assert.equal(service.cancelCandidatePage(42), false);

  const page = service.loadCandidatePage(REQUEST, "page-1");
  assert.equal(service.cancelCandidatePage("page-1"), true);
  assert.equal(requests[0]!.signal?.aborted, true);
  requests[0]!.finish({ ok: false });
  await page;
});

test("a finished candidate page frees its id", async () => {
  const { service, requests } = harness();
  const first = service.loadCandidatePage(REQUEST, "page-1");
  requests[0]!.finish({ ok: true });
  await first;
  assert.equal(service.cancelCandidatePage("page-1"), false);

  const second = service.loadCandidatePage(REQUEST, "page-1");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.signal === requests[0]!.signal, false);
  requests[1]!.finish({ ok: true });
  await second;
});

test("a pairing prewarm asks only for the version's pairing index and reports it ready", async () => {
  const { service, requests } = harness();
  const prewarm = service.prewarmPairingCandidates({ dataVersion: 7 });
  assert.deepEqual(requests.map(({ operation, args }) => [operation, ...args]), [["financial.spending.prewarmPairing", 7]]);
  requests[0]!.finish(7);
  assert.deepEqual(await prewarm, { status: "ready", dataVersion: 7, reused: false });
});

test("a pairing prewarm reports a stale version when the ledger has moved on", async () => {
  const { service, requests } = harness();
  const prewarm = service.prewarmPairingCandidates({ dataVersion: 6 });
  assert.equal(requests[0]!.operation, "financial.spending.prewarmPairing");
  assert.deepEqual(requests[0]!.args, [6]);
  requests[0]!.finish(7);
  assert.deepEqual(await prewarm, { status: "stale", dataVersion: 7, requestedVersion: 6 });
});
