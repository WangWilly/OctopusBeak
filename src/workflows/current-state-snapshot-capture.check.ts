import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import {
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
} from "../ledger/pglite/current-deposit-admission.ts";
import { PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND } from "../ledger/pglite/workflow-commands.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import {
  captureCurrentStateSnapshots,
  indexCurrentBalanceCaptures,
  matchCurrentBalanceCaptures,
  readCurrentStateSnapshot,
  stageCurrentStateSnapshot,
  type CurrentBalanceCaptureMatching,
  type CurrentBalanceUnmatchedPolicy,
  type CurrentStateSnapshotDeclaration,
  type SnapshotEvidence,
} from "./current-state-snapshot-capture.ts";

type Capture = Readonly<{
  id: string;
  connection: string;
  epoch: string;
  account: string;
  currency: string;
  accountNumber?: string;
}>;
type Row = Readonly<{ account: string; currency: string }>;

function capture(id: string, fields: Partial<Capture> = {}): Capture {
  return { id, connection: "c1", epoch: "e1", account: "A", currency: "TWD", ...fields };
}

const sameScope = (kept: Capture, candidate: Capture) =>
  kept.connection === candidate.connection && kept.epoch === candidate.epoch;

function matching(
  overrides: Partial<CurrentBalanceCaptureMatching<Row, Capture>> = {},
): CurrentBalanceCaptureMatching<Row, Capture> {
  return {
    captureKey: (entry) => entry.account,
    rowKey: (row) => row.account,
    duplicates: "first-wins",
    sameIdentity: sameScope,
    ambiguousMessage: "ambiguous",
    unmatched: { kind: "throw", message: "unmatched" },
    ...overrides,
  };
}

function ids(result: ReturnType<typeof matchCurrentBalanceCaptures<Row, Capture>>) {
  return result.matched.map(({ row, capture }) => [row.account, row.currency, capture.id]);
}

test("each key kind matches rows to the capture with that key, in row order", () => {
  const captures = [
    capture("a", { account: "A", accountNumber: "001" }),
    capture("b", { account: "B", currency: "USD" }),
    capture("c", { account: "C", accountNumber: "003" }),
  ];
  const keys: readonly [string, CurrentBalanceCaptureMatching<Row, Capture>, readonly Row[], readonly string[][]][] = [
    ["account", matching(), [{ account: "C", currency: "TWD" }, { account: "A", currency: "TWD" }], [["C", "TWD", "c"], ["A", "TWD", "a"]]],
    [
      "account and currency",
      matching({
        captureKey: (entry) => `${entry.account}\u0000${entry.currency}`,
        rowKey: (row) => `${row.account}\u0000${row.currency}`,
      }),
      [{ account: "B", currency: "USD" }],
      [["B", "USD", "b"]],
    ],
    [
      "optional account number, unindexed when absent",
      matching({ captureKey: (entry) => entry.accountNumber }),
      [{ account: "003", currency: "TWD" }, { account: "001", currency: "TWD" }],
      [["003", "TWD", "c"], ["001", "TWD", "a"]],
    ],
  ];
  for (const [name, declaration, rows, expected] of keys)
    assert.deepEqual(ids(matchCurrentBalanceCaptures(rows, captures, declaration)), expected, name);
  assert.throws(
    () => matchCurrentBalanceCaptures(
      [{ account: "B", currency: "USD" }],
      captures,
      matching({ captureKey: (entry) => entry.accountNumber }),
    ),
    /^Error: unmatched$/u,
    "a capture without the key field is never matched",
  );
});

test("each unmatched policy decides what happens to a row with no admitted capture", () => {
  const captures = [capture("a", { account: "A", currency: "TWD" })];
  const rows: readonly Row[] = [
    { account: "A", currency: "TWD" },
    { account: "B", currency: "TWD" },
    { account: "C", currency: "TWD" },
  ];
  const policies: readonly [CurrentBalanceUnmatchedPolicy<Row, Capture>, readonly Row[] | RegExp][] = [
    [{ kind: "skip" }, []],
    [{ kind: "exclude" }, [rows[1]!, rows[2]!]],
    [{ kind: "throw", message: "no admitted identity" }, /^Error: no admitted identity$/u],
  ];
  for (const [policy, expected] of policies) {
    const run = () => matchCurrentBalanceCaptures(rows, captures, matching({ unmatched: policy }));
    if (expected instanceof RegExp) {
      assert.throws(run, expected, policy.kind);
      continue;
    }
    const result = run();
    assert.deepEqual(ids(result), [["A", "TWD", "a"]], policy.kind);
    assert.deepEqual(result.excluded, expected, policy.kind);
  }
});

test("a skip policy can throw when the row's account was admitted under another key", () => {
  const declaration = matching({
    captureKey: (entry) => `${entry.account}\u0000${entry.currency}`,
    rowKey: (row) => `${row.account}\u0000${row.currency}`,
    unmatched: {
      kind: "skip",
      throwWhenAccountAdmitted: {
        rowAccount: (row) => row.account,
        captureAccount: (entry) => entry.account,
        message: "currency mismatch",
      },
    },
  });
  const captures = [capture("a", { account: "A", currency: "TWD" })];
  assert.deepEqual(
    ids(matchCurrentBalanceCaptures([{ account: "B", currency: "USD" }], captures, declaration)),
    [],
    "an account the run never admitted is skipped",
  );
  assert.throws(
    () => matchCurrentBalanceCaptures([{ account: "A", currency: "USD" }], captures, declaration),
    /^Error: currency mismatch$/u,
  );
});

test("duplicates keep the first or the last capture under one key", () => {
  const captures = [capture("first"), capture("last")];
  const row: Row = { account: "A", currency: "TWD" };
  assert.deepEqual(ids(matchCurrentBalanceCaptures([row], captures, matching())), [["A", "TWD", "first"]]);
  assert.deepEqual(
    ids(matchCurrentBalanceCaptures([row], captures, matching({ duplicates: "last-wins" }))),
    [["A", "TWD", "last"]],
  );
});

test("captures sharing a key with differing identity are ambiguous before any row matches", () => {
  for (const duplicates of ["first-wins", "last-wins"] as const)
    assert.throws(
      () => matchCurrentBalanceCaptures([], [capture("a"), capture("b", { epoch: "e2" })], matching({ duplicates })),
      /^Error: ambiguous$/u,
      duplicates,
    );
  assert.throws(
    () => matchCurrentBalanceCaptures(
      [],
      [capture("a"), capture("b", { account: "B" }), capture("c", { epoch: "e2" })],
      matching({ duplicates: "last-wins" }),
    ),
    /^Error: ambiguous$/u,
    "last-wins compares with the capture it kept",
  );
});

test("two connections in one run", () => {
  const captures = [
    capture("one", { connection: "c1", account: "A" }),
    capture("two", { connection: "c2", account: "B" }),
  ];
  const rows: readonly Row[] = [{ account: "B", currency: "TWD" }];
  assert.throws(
    () => indexCurrentBalanceCaptures(
      captures,
      matching({ oneScope: { scope: (entry) => `${entry.connection}\u0000${entry.epoch}`, message: "one scope" } }),
    ),
    /^Error: one scope$/u,
    "a bank that declares one scope fails closed even when no key is shared",
  );
  assert.throws(
    () => indexCurrentBalanceCaptures(
      [capture("one"), capture("two", { epoch: "e2", account: "B" })],
      matching({ oneScope: { scope: (entry) => `${entry.connection}\u0000${entry.epoch}`, message: "one scope" } }),
    ),
    /^Error: one scope$/u,
    "two identity epochs are also more than one scope",
  );
  assert.deepEqual(
    ids(matchCurrentBalanceCaptures(rows, captures, matching())),
    [["B", "TWD", "two"]],
    "a bank whose key is its own identity matches each capture by that key",
  );
  assert.throws(
    () => matchCurrentBalanceCaptures(
      [],
      [capture("one", { connection: "c1" }), capture("two", { connection: "c2" })],
      matching(),
    ),
    /^Error: ambiguous$/u,
    "one key across two connections is ambiguous",
  );
  const scoped = matching({
    captureKey: (entry) => `${entry.connection}\u0000${entry.account}`,
    rowKey: (row) => `c2\u0000${row.account}`,
  });
  assert.deepEqual(
    ids(matchCurrentBalanceCaptures(
      [{ account: "A", currency: "TWD" }],
      [capture("one", { connection: "c1" }), capture("two", { connection: "c2" })],
      scoped,
    )),
    [["A", "TWD", "two"]],
    "a key that names the connection keeps two connections apart",
  );
});

test("indexing checks ambiguity before any row is matched", () => {
  assert.throws(
    () => indexCurrentBalanceCaptures([capture("a"), capture("b", { epoch: "e2" })], matching()),
    /^Error: ambiguous$/u,
  );
  const index = indexCurrentBalanceCaptures([capture("a")], matching());
  assert.throws(() => index.match([{ account: "B", currency: "TWD" }]), /^Error: unmatched$/u);
  assert.deepEqual(ids(index.match([{ account: "A", currency: "TWD" }])), [["A", "TWD", "a"]]);
});

type SnapshotRow = Readonly<{ account: string; currencies: readonly string[]; amount: string }>;
type Stream = "domestic-deposit" | "foreign-currency-deposit";
type Acquired = Readonly<{ evidence: SnapshotEvidence }>;

const HTTP_DATE = "Fri, 25 Sep 2026 11:59:00 GMT";
const CONTRACT_VERSION = "yuanta/current-deposit-balance-v1";

/** A capture on a real Yuanta route, so admission and the command request run unchanged. */
function balanceCapture(stream: Stream, row: SnapshotRow, financial: Capture): CurrentDepositBalanceCaptureInput {
  const time = {
    effectiveAt: "2026-09-25T11:59:00.000Z",
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: CONTRACT_VERSION,
    sourceField: "HTTP Date",
    sourceValue: HTTP_DATE,
    contractVersion: CONTRACT_VERSION,
  };
  const balance = { coefficient: row.amount, scale: 0 };
  const records = row.currencies.map((currency) => {
    const record = currentDepositSourceRecord({
      sourceRecordKey: canonicalDigest("snapshot-check-record", row.account, currency),
      providerKey: canonicalDigest("snapshot-check-provider", row.account, currency),
      contentHash: "sha256:placeholder",
      sourceField: "帳面餘額",
      balanceKind: "ledger",
      currency,
      value: balance,
      time,
    });
    return { ...record, contentHash: currentDepositSourceRecordContentHash(record.compact) };
  });
  return {
    captureId: `snapshot-check-${financial.id}-${row.account}`,
    authorityRoute: stream === "domestic-deposit"
      ? "yuanta/domestic-deposit/current-balance-v1"
      : "yuanta/foreign-currency/current-balance-v1",
    contractVersion: CONTRACT_VERSION,
    subjectDigest: canonicalDigest("snapshot-check-subject", financial.id),
    identity: {
      integrationNamespace: "yuanta",
      sourceConnectionKey: financial.connection,
      identityEpochKey: financial.epoch,
      stream,
      sourceAccountKey: row.account,
    },
    observedAt: "2026-09-25T20:00:00+08:00",
    scope: { startDate: "2026-09-25", endDate: "2026-09-25" },
    providerResponse: {
      endpoint: "https://ebank.yuantabank.com.tw/nib/tx/finance_overview_for_summary",
      status: 200,
      cacheControl: "no-store",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: {} }],
    records,
    observations: row.currencies.map((currency, index) => ({
      observationKey: canonicalDigest("snapshot-check-observation", row.account),
      balanceKind: "ledger" as const,
      balance,
      currency,
      time,
      sourceRecordKey: records[index]!.sourceRecordKey,
      sourceField: "帳面餘額",
    })),
  };
}

function snapshotRows(decoded: unknown): readonly SnapshotRow[] {
  return decoded as readonly SnapshotRow[];
}

function declaration(
  stream: Stream = "domestic-deposit",
  unmatched: CurrentBalanceUnmatchedPolicy<SnapshotRow, Capture> = { kind: "throw", message: "unmatched" },
): CurrentStateSnapshotDeclaration<Acquired, SnapshotRow, Capture> {
  return {
    product: "current-balance",
    parse: (decoded) => decoded.kind === "json"
      ? snapshotRows(decoded.value)
      : decoded.rows.map(([account = "", currency = "", amount = ""]) => ({ account, currencies: [currency], amount })),
    matching: {
      captureKey: (entry) => entry.account,
      rowKey: (row) => row.account,
      duplicates: "first-wins",
      sameIdentity: sameScope,
      ambiguousMessage: "ambiguous",
      unmatched,
    },
    build: (row, financial) => balanceCapture(stream, row, financial),
  };
}

function json(value: unknown): Acquired {
  return { evidence: { kind: "json", bytes: new TextEncoder().encode(JSON.stringify(value)) } };
}

async function snapshot(
  declared: CurrentStateSnapshotDeclaration<Acquired, SnapshotRow, Capture>,
  captures: readonly Capture[],
  acquired: Acquired,
) {
  const events: string[] = [];
  let reads = 0;
  const run = captureCurrentStateSnapshots(declared, {
    captures,
    acquire: async () => {
      reads += 1;
      return acquired;
    },
    product: {
      event: async (stage, outcome, code, counts) => {
        events.push([stage, outcome, code, counts ? `${counts.completed}/${counts.total}` : ""].join(" ").trim());
      },
    },
    text: strictSourceText,
    signal: new AbortController().signal,
  });
  return { run, events, reads: () => reads };
}

const decodeFailure = [
  "collection started current-balance-collection-started",
  "decoding started current-balance-decoding-started",
  "decoding failed current-balance-decoding-failed",
  "collection failed current-balance-collection-failed",
];

test("with no admitted financial capture nothing is read, reported, or staged", async () => {
  const result = await snapshot(declaration(), [], json([{ account: "A", currencies: ["TWD"], amount: "1" }]));
  assert.deepEqual(await result.run, { items: [], matched: [], excluded: [] });
  assert.equal(result.reads(), 0);
  assert.deepEqual(result.events, []);
});

test("a JSON snapshot stages one keyed balance per matched row and reports each stage", async () => {
  const result = await snapshot(
    declaration("domestic-deposit", { kind: "exclude" }),
    [capture("a", { account: "A" }), capture("b", { account: "B" })],
    json([
      { account: "B", currencies: ["TWD"], amount: "750" },
      { account: "Z", currencies: ["TWD"], amount: "1" },
      { account: "A", currencies: ["TWD"], amount: "5000" },
    ]),
  );
  const { items, matched, excluded } = await result.run;
  assert.deepEqual(items.map((item) => [item.product, item.itemKey, item.command.kind]), [
    ["current-balance", "current-balance:domestic-deposit:B", PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND],
    ["current-balance", "current-balance:domestic-deposit:A", PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND],
  ]);
  assert.deepEqual(matched.map(({ row, capture }) => [row.account, capture.id]), [["B", "b"], ["A", "a"]]);
  assert.deepEqual(excluded.map((row) => row.account), ["Z"]);
  assert.equal(result.reads(), 1);
  assert.deepEqual(result.events, [
    "collection started current-balance-collection-started",
    "decoding started current-balance-decoding-started",
    "decoding completed current-balance-decoding-completed",
    "collection completed current-balance-collection-completed 3/3",
    "validation started current-balance-validation-started 0/3",
    "validation completed current-balance-validation-completed 2/3",
  ]);
});

test("strict decoding rejects malformed bytes, escaped replacement characters, and broken cells", async () => {
  const captures = [capture("a")];
  const rejected: readonly [string, Acquired, RegExp | typeof SourceTextIntegrityError][] = [
    ["invalid UTF-8", { evidence: { kind: "json", bytes: Uint8Array.of(0x5b, 0xff, 0x5d) } }, SourceTextIntegrityError],
    ["escaped U+FFFD", { evidence: { kind: "json", bytes: new TextEncoder().encode('[{"account":"A\\uFFFD"}]') } }, SourceTextIntegrityError],
    ["not JSON", { evidence: { kind: "json", bytes: new TextEncoder().encode("[") } }, /not valid JSON/u],
    ["cell with U+FFFD", { evidence: { kind: "cells", rows: [["A", "TWD", "1\uFFFD"]] } }, SourceTextIntegrityError],
  ];
  for (const [name, acquired, expected] of rejected) {
    let parsed = false;
    const declared = declaration();
    const result = await snapshot({
      ...declared,
      parse: (decoded, raw) => {
        parsed = true;
        return declared.parse(decoded, raw);
      },
    }, captures, acquired);
    await assert.rejects(result.run, expected, name);
    assert.equal(parsed, false, `${name} never reaches the row parser`);
    assert.deepEqual(result.events, decodeFailure, name);
  }
  const cells = await snapshot(declaration(), captures, { evidence: { kind: "cells", rows: [["A", "TWD", "12"]] } });
  assert.deepEqual((await cells.run).items.map((item) => item.itemKey), ["current-balance:domestic-deposit:A"]);
});

test("JSON evidence hands the parser the decoded body text with its numeric lexemes", async () => {
  const body = '[{"account":"A","currencies":["TWD"],"amount":1000.00,"note":"\\u53f0\\u5e63 臺"}]';
  let seen: string | undefined;
  const declared = declaration();
  const result = await snapshot({
    ...declared,
    parse: (decoded, raw) => {
      if (decoded.kind === "json") seen = decoded.text;
      return declared.parse(decoded, raw).map((row) => ({ ...row, amount: "100000" }));
    },
  }, [capture("a")], { evidence: { kind: "json", bytes: new TextEncoder().encode(body) } });
  await result.run;
  assert.equal(seen, body);
});

test("an acquisition or parse failure reports decoding and collection failure", async () => {
  const failing = await snapshot({ ...declaration(), parse: () => { throw new Error("bad row"); } }, [capture("a")], json([]));
  await assert.rejects(failing.run, /^Error: bad row$/u);
  assert.deepEqual(failing.events, decodeFailure);
});

test("a foreign-currency key names each distinct currency in sorted order", async () => {
  const result = await snapshot(
    declaration("foreign-currency-deposit"),
    [capture("a", { account: "A" }), capture("b", { account: "B" })],
    json([
      { account: "A", currencies: ["USD", "JPY"], amount: "10" },
      { account: "B", currencies: ["USD"], amount: "20" },
    ]),
  );
  assert.deepEqual((await result.run).items.map((item) => item.itemKey), [
    "current-balance:foreign-currency-deposit:A:JPY+USD",
    "current-balance:foreign-currency-deposit:B:USD",
  ]);
});

test("two balances under one item key are rejected", async () => {
  const result = await snapshot(
    declaration("foreign-currency-deposit"),
    [capture("a", { account: "A" })],
    json([
      { account: "A", currencies: ["USD"], amount: "10" },
      { account: "A", currencies: ["USD"], amount: "11" },
    ]),
  );
  await assert.rejects(result.run, /current-balance:foreign-currency-deposit:A:USD more than once/u);
  assert.deepEqual(result.events.slice(-2), [
    "validation started current-balance-validation-started 0/2",
    "validation failed current-balance-validation-rejected 0/2",
  ]);
});

test("an unmatched row fails validation under a throw policy", async () => {
  const result = await snapshot(declaration(), [capture("a")], json([{ account: "Z", currencies: ["TWD"], amount: "1" }]));
  await assert.rejects(result.run, /^Error: unmatched$/u);
  assert.equal(result.events.at(-1), "validation failed current-balance-validation-rejected 0/1");
});

test("the read and stage halves report their own events and stage what the read returned", async () => {
  const events: string[] = [];
  const product = {
    event: async (stage: string, outcome: string, code: string, counts?: Readonly<{ completed?: number; total?: number }>) => {
      events.push([stage, outcome, code, counts ? `${counts.completed}/${counts.total}` : ""].join(" ").trim());
    },
  };
  const signal = new AbortController().signal;
  const declared = declaration("domestic-deposit", { kind: "exclude" });
  const rows = await readCurrentStateSnapshot(declared, {
    acquire: async () => json([
      { account: "A", currencies: ["TWD"], amount: "5" },
      { account: "B", currencies: ["TWD"], amount: "6" },
    ]),
    product,
    text: strictSourceText,
    signal,
  });
  assert.deepEqual(rows.map((row) => row.account), ["A", "B"]);
  assert.deepEqual(events.splice(0), [
    "collection started current-balance-collection-started",
    "decoding started current-balance-decoding-started",
    "decoding completed current-balance-decoding-completed",
    "collection completed current-balance-collection-completed 2/2",
  ]);

  const staged = await stageCurrentStateSnapshot(declared, rows.slice(1), {
    captures: [capture("b", { account: "B" })],
    product,
    signal,
  });
  assert.deepEqual(staged.items.map((item) => item.itemKey), ["current-balance:domestic-deposit:B"]);
  assert.deepEqual(staged.excluded, []);
  assert.deepEqual(events, [
    "validation started current-balance-validation-started 0/1",
    "validation completed current-balance-validation-completed 1/1",
  ]);
});

test("the stage half throws on ambiguous captures before validation starts", async () => {
  const events: string[] = [];
  await assert.rejects(
    stageCurrentStateSnapshot(declaration(), [{ account: "A", currencies: ["TWD"], amount: "1" }], {
      captures: [capture("a"), capture("b", { connection: "c2" })],
      product: { event: async (_stage, _outcome, code) => { events.push(code); } },
      signal: new AbortController().signal,
    }),
    /^Error: ambiguous$/u,
  );
  assert.deepEqual(events, []);
});
