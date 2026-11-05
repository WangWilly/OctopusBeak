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
  assembleCurrentDepositCapture,
  captureCurrentStateSnapshots,
  indexCurrentBalanceCaptures,
  readCurrentStateSnapshot,
  stageCurrentStateSnapshot,
  type CurrentBalanceCaptureMatch,
  type CurrentBalanceCaptureMatching,
  type CurrentBalanceUnmatchedPolicy,
  type CurrentStateSnapshotDeclaration,
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type SnapshotAcquisition,
  verifyProviderResponse,
} from "./current-state-snapshot-capture.ts";
import { validationReporter, type ProductCollectionStageEvent } from "../lib/automation/product-collection.ts";

/** A product handle's reporting half, with the run's own validate. */
const reporting = (event: ProductCollectionStageEvent) =>
  ({ event, validate: validationReporter(event, new AbortController().signal) });

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

function ids(result: CurrentBalanceCaptureMatch<Row, Capture>) {
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
    assert.deepEqual(ids(indexCurrentBalanceCaptures(captures, declaration).match(rows)), expected, name);
  assert.throws(
    () => indexCurrentBalanceCaptures(
      captures,
      matching({ captureKey: (entry) => entry.accountNumber }),
    ).match([{ account: "B", currency: "USD" }]),
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
    const run = () => indexCurrentBalanceCaptures(captures, matching({ unmatched: policy })).match(rows);
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
    ids(indexCurrentBalanceCaptures(captures, declaration).match([{ account: "B", currency: "USD" }])),
    [],
    "an account the run never admitted is skipped",
  );
  assert.throws(
    () => indexCurrentBalanceCaptures(captures, declaration).match([{ account: "A", currency: "USD" }]),
    /^Error: currency mismatch$/u,
  );
});

test("duplicates keep the first or the last capture under one key", () => {
  const captures = [capture("first"), capture("last")];
  const row: Row = { account: "A", currency: "TWD" };
  assert.deepEqual(ids(indexCurrentBalanceCaptures(captures, matching()).match([row])), [["A", "TWD", "first"]]);
  assert.deepEqual(
    ids(indexCurrentBalanceCaptures(captures, matching({ duplicates: "last-wins" })).match([row])),
    [["A", "TWD", "last"]],
  );
});

test("captures sharing a key with differing identity are ambiguous before any row matches", () => {
  for (const duplicates of ["first-wins", "last-wins"] as const)
    assert.throws(
      () => indexCurrentBalanceCaptures([capture("a"), capture("b", { epoch: "e2" })], matching({ duplicates })).match([]),
      /^Error: ambiguous$/u,
      duplicates,
    );
  assert.throws(
    () => indexCurrentBalanceCaptures(
      [capture("a"), capture("b", { account: "B" }), capture("c", { epoch: "e2" })],
      matching({ duplicates: "last-wins" }),
    ).match([]),
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
    ids(indexCurrentBalanceCaptures(captures, matching()).match(rows)),
    [["B", "TWD", "two"]],
    "a bank whose key is its own identity matches each capture by that key",
  );
  assert.throws(
    () => indexCurrentBalanceCaptures(
      [capture("one", { connection: "c1" }), capture("two", { connection: "c2" })],
      matching(),
    ).match([]),
    /^Error: ambiguous$/u,
    "one key across two connections is ambiguous",
  );
  const scoped = matching({
    captureKey: (entry) => `${entry.connection}\u0000${entry.account}`,
    rowKey: (row) => `c2\u0000${row.account}`,
  });
  assert.deepEqual(
    ids(indexCurrentBalanceCaptures(
      [capture("one", { connection: "c1" }), capture("two", { connection: "c2" })],
      scoped,
    ).match([{ account: "A", currency: "TWD" }])),
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
type Acquired = SnapshotAcquisition;

const HTTP_DATE = "Fri, 25 Sep 2026 11:59:00 GMT";
const RUN_CLOCK = "2026-09-25T12:00:01.234Z";

const RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "Check bank current deposit",
  host: "bank.example",
  endpoints: [
    { path: "/balances", method: "POST", contentType: /^application\/json\b/iu, search: /^(?:\?t=\d+)?$/u },
    { path: "/fallback", method: "GET" },
  ],
  cacheControl: ["no-store", "no-cache"],
  providerDate: "required",
};

const PROVIDER_RESPONSE: ProviderResponse = {
  url: "https://bank.example/balances",
  status: 200,
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8", "cache-control": "private, no-cache, no-store", date: HTTP_DATE },
};
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
    response: RESPONSE,
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
  return { evidence: { kind: "json", bytes: new TextEncoder().encode(JSON.stringify(value)) }, response: PROVIDER_RESPONSE };
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
    now: () => RUN_CLOCK,
    product: reporting(async (stage, outcome, code, counts) => {
      events.push([stage, outcome, code, counts ? `${counts.completed}/${counts.total}` : ""].join(" ").trim());
    }),
    text: strictSourceText,
    signal: new AbortController().signal,
  });
  return { run, events, reads: () => reads };
}

const readStarted = [
  "collection started current-balance-collection-started",
  "decoding started current-balance-decoding-started",
];
/** A check of the reply that rejects it reports validation (ADR 0106). */
const checkFailure = [...readStarted, "validation failed source-validation-rejected"];
/** Bytes that are not intact name their own failure, so nothing more is reported. */
const integrityFailure = readStarted;

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
    ["invalid UTF-8", { evidence: { kind: "json", bytes: Uint8Array.of(0x5b, 0xff, 0x5d) }, response: PROVIDER_RESPONSE }, SourceTextIntegrityError],
    ["escaped U+FFFD", { evidence: { kind: "json", bytes: new TextEncoder().encode('[{"account":"A\\uFFFD"}]') }, response: PROVIDER_RESPONSE }, SourceTextIntegrityError],
    ["not JSON", { evidence: { kind: "json", bytes: new TextEncoder().encode("[") }, response: PROVIDER_RESPONSE }, /not valid JSON/u],
    ["cell with U+FFFD", { evidence: { kind: "cells", rows: [["A", "TWD", "1\uFFFD"]] }, response: PROVIDER_RESPONSE }, SourceTextIntegrityError],
  ];
  for (const [name, acquired, expected] of rejected) {
    let parsed = false;
    const declared = declaration();
    const result = await snapshot({
      ...declared,
      parse: (decoded, response, raw) => {
        parsed = true;
        return declared.parse(decoded, response, raw);
      },
    }, captures, acquired);
    await assert.rejects(result.run, expected, name);
    assert.equal(parsed, false, `${name} never reaches the row parser`);
    assert.deepEqual(result.events, expected === SourceTextIntegrityError ? integrityFailure : checkFailure, name);
  }
  const cells = await snapshot(declaration(), captures, { evidence: { kind: "cells", rows: [["A", "TWD", "12"]] }, response: PROVIDER_RESPONSE });
  assert.deepEqual((await cells.run).items.map((item) => item.itemKey), ["current-balance:domestic-deposit:A"]);
});

test("JSON evidence hands the parser the decoded body text with its numeric lexemes", async () => {
  const body = '[{"account":"A","currencies":["TWD"],"amount":1000.00,"note":"\\u53f0\\u5e63 臺"}]';
  let seen: string | undefined;
  const declared = declaration();
  const result = await snapshot({
    ...declared,
    parse: (decoded, response, raw) => {
      if (decoded.kind === "json") seen = decoded.text;
      return declared.parse(decoded, response, raw).map((row) => ({ ...row, amount: "100000" }));
    },
  }, [capture("a")], { evidence: { kind: "json", bytes: new TextEncoder().encode(body) }, response: PROVIDER_RESPONSE });
  await result.run;
  assert.equal(seen, body);
});

test("a parse failure reports validation, and a failed read reports collection", async () => {
  const failing = await snapshot({ ...declaration(), parse: () => { throw new Error("bad row"); } }, [capture("a")], json([]));
  await assert.rejects(failing.run, /^Error: bad row$/u);
  assert.deepEqual(failing.events, checkFailure);

  const events: string[] = [];
  const timedOut = readCurrentStateSnapshot(declaration(), {
    acquire: async () => { throw Object.assign(new Error("Timeout 60000ms exceeded"), { name: "TimeoutError" }); },
    now: () => RUN_CLOCK,
    product: reporting(async (stage, outcome, code) => { events.push(`${stage} ${outcome} ${code}`); }),
    text: strictSourceText,
    signal: new AbortController().signal,
  });
  await assert.rejects(timedOut, /Timeout/u);
  assert.deepEqual(events, [...readStarted, "collection failed current-balance-collection-failed"],
    "a timed-out read is a collection failure, never decoding or validation");
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
    "validation failed source-validation-rejected",
  ]);
});

test("an unmatched row fails validation under a throw policy", async () => {
  const result = await snapshot(declaration(), [capture("a")], json([{ account: "Z", currencies: ["TWD"], amount: "1" }]));
  await assert.rejects(result.run, /^Error: unmatched$/u);
  assert.equal(result.events.at(-1), "validation failed source-validation-rejected");
});

test("a validate throw rejects validation after matching and stages nothing", async () => {
  const seen: unknown[] = [];
  const result = await snapshot(
    {
      ...declaration("domestic-deposit", { kind: "exclude" }),
      validate: ({ rows, matched, excluded }) => {
        seen.push([rows.length, matched.map(({ capture }) => capture.id), excluded.map((row) => row.account)]);
        throw new Error("incomplete");
      },
    },
    [capture("a", { account: "A" })],
    json([
      { account: "A", currencies: ["TWD"], amount: "1" },
      { account: "Z", currencies: ["TWD"], amount: "2" },
    ]),
  );
  await assert.rejects(result.run, /^Error: incomplete$/u);
  assert.deepEqual(seen, [[2, ["a"], ["Z"]]]);
  assert.deepEqual(result.events.slice(-2), [
    "validation started current-balance-validation-started 0/2",
    "validation failed source-validation-rejected",
  ]);
  assert.ok(!result.events.some((event) => event.includes("validation-completed")));
});

test("the read and stage halves report their own events and stage what the read returned", async () => {
  const events: string[] = [];
  const product = reporting(async (stage, outcome, code, counts) => {
    events.push([stage, outcome, code, counts ? `${counts.completed}/${counts.total}` : ""].join(" ").trim());
  });
  const signal = new AbortController().signal;
  const declared = declaration("domestic-deposit", { kind: "exclude" });
  const rows = await readCurrentStateSnapshot(declared, {
    acquire: async () => json([
      { account: "A", currencies: ["TWD"], amount: "5" },
      { account: "B", currencies: ["TWD"], amount: "6" },
    ]),
    now: () => RUN_CLOCK,
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
      product: reporting(async (_stage, _outcome, code) => { events.push(code); }),
      signal: new AbortController().signal,
    }),
    /^Error: ambiguous$/u,
  );
  assert.deepEqual(events, []);
});

test("a declared response verifies to its transport facts and the run clock's Taipei second", () => {
  const verified = verifyProviderResponse(RESPONSE, { ...PROVIDER_RESPONSE, url: "https://bank.example/balances?t=1" }, "2026-09-25T20:00:01+08:00");
  assert.equal(verified.endpoint.path, "/balances");
  assert.equal(verified.contentType, "application/json; charset=utf-8");
  assert.equal(verified.cacheControl, "private, no-cache, no-store");
  assert.deepEqual(verified.providerDate, { raw: HTTP_DATE, effectiveAt: "2026-09-25T11:59:00.000Z" });
  assert.equal(verified.observedAt, "2026-09-25T20:00:01+08:00");
  const fallback = verifyProviderResponse(RESPONSE, { ...PROVIDER_RESPONSE, url: "https://bank.example/fallback", method: "get", headers: { ...PROVIDER_RESPONSE.headers, "content-type": "text/html" } }, "x");
  assert.equal(fallback.endpoint.path, "/fallback");
  const anyMethod: ProviderResponseDeclaration = { ...RESPONSE, endpoints: [{ path: "/balances" }] };
  assert.equal(verifyProviderResponse(anyMethod, { ...PROVIDER_RESPONSE, method: "PUT" }, "x").endpoint.path, "/balances");
});

test("every undeclared transport fact rejects the response with the source's label", () => {
  const rejected: readonly [string, ProviderResponse, RegExp][] = [
    ["unparseable URL", { ...PROVIDER_RESPONSE, url: "not a url" }, /^Error: Check bank current deposit response URL is invalid\.$/u],
    ["plain http", { ...PROVIDER_RESPONSE, url: "http://bank.example/balances" }, /endpoint is unexpected/u],
    ["other host", { ...PROVIDER_RESPONSE, url: "https://evil.example/balances" }, /endpoint is unexpected/u],
    ["explicit port", { ...PROVIDER_RESPONSE, url: "https://bank.example:8443/balances" }, /endpoint is unexpected/u],
    ["credentials", { ...PROVIDER_RESPONSE, url: "https://u:p@bank.example/balances" }, /endpoint is unexpected/u],
    ["fragment", { ...PROVIDER_RESPONSE, url: "https://bank.example/balances#x" }, /endpoint is unexpected/u],
    ["other path", { ...PROVIDER_RESPONSE, url: "https://bank.example/other" }, /endpoint is unexpected/u],
    ["undeclared query", { ...PROVIDER_RESPONSE, url: "https://bank.example/balances?session=1" }, /endpoint is unexpected/u],
    ["query on a query-free endpoint", { ...PROVIDER_RESPONSE, url: "https://bank.example/fallback?t=1", method: "GET" }, /endpoint is unexpected/u],
    ["method", { ...PROVIDER_RESPONSE, method: "GET" }, /response method is not POST/u],
    ["status", { ...PROVIDER_RESPONSE, status: 302 }, /response status is 302, expected 200/u],
    ["content type", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "Content-Type": "text/html" } }, /content type is unexpected/u],
    ["one cache directive", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "cache-control": "no-store" } }, /must carry Cache-Control: no-store, no-cache/u],
    ["cache directive as a value", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "cache-control": "no-store, x=no-cache" } }, /must carry Cache-Control/u],
    ["missing Date", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "" } }, /response is missing HTTP Date/u],
    ["Date without GMT", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "Fri, 25 Sep 2026 11:59:00" } }, /HTTP Date is invalid/u],
    ["impossible Date", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "Thu, 31 Sep 2026 11:59:00 GMT" } }, /HTTP Date is invalid/u],
    ["wrong weekday", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "Mon, 25 Sep 2026 11:59:00 GMT" } }, /HTTP Date is invalid/u],
  ];
  for (const [name, response, expected] of rejected)
    assert.throws(() => verifyProviderResponse(RESPONSE, response, "x"), expected, name);
});

test("an optional provider date may be absent but must be valid when present", () => {
  const optional: ProviderResponseDeclaration<"optional"> = { ...RESPONSE, providerDate: "optional" };
  const { date: _date, ...headers } = PROVIDER_RESPONSE.headers;
  assert.equal(verifyProviderResponse(optional, { ...PROVIDER_RESPONSE, headers }, "x").providerDate, null);
  assert.throws(
    () => verifyProviderResponse(optional, { ...PROVIDER_RESPONSE, headers: { ...headers, date: "yesterday" } }, "x"),
    /HTTP Date is invalid/u,
  );
});

test("the read stamps observedAt from the run clock and rejects an undeclared response before parsing", async () => {
  let observedAt: string | undefined;
  const declared = declaration();
  const stamped = await snapshot({
    ...declared,
    parse: (decoded, response, raw) => {
      observedAt = response.observedAt;
      return declared.parse(decoded, response, raw);
    },
  }, [capture("a")], json([{ account: "A", currencies: ["TWD"], amount: "1" }]));
  await stamped.run;
  assert.equal(observedAt, "2026-09-25T20:00:01+08:00");

  let parsed = false;
  const undeclared = await snapshot({
    ...declared,
    parse: () => {
      parsed = true;
      return [];
    },
  }, [capture("a")], { ...json([]), response: { ...PROVIDER_RESPONSE, status: 500 } });
  await assert.rejects(undeclared.run, /status is 500/u);
  assert.equal(parsed, false);
  assert.deepEqual(undeclared.events, checkFailure);
});

test("a deposit capture is assembled from its envelope and one record and observation per balance", () => {
  const time = {
    effectiveAt: "2026-09-25T12:00:00.000Z",
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: "synthetic-v1",
    sourceField: "HTTP Date",
    sourceValue: "Fri, 25 Sep 2026 12:00:00 GMT",
    contractVersion: "synthetic-v1",
  };
  const entry = (balanceKind: "ledger" | "available", timeInRecord: boolean) => ({
    sourceRecordKey: `record-${balanceKind}`,
    providerKey: `provider-${balanceKind}`,
    observationKey: "observation",
    balanceKind,
    sourceField: `${balanceKind}-field`,
    currency: "TWD",
    value: { coefficient: balanceKind === "ledger" ? "1000" : "900", scale: 0 },
    time,
    timeInRecord,
    compact: { account: "synthetic" },
  });
  const capture = assembleCurrentDepositCapture({
    captureId: "capture",
    authorityRoute: "synthetic/domestic-deposit/current-balance-v1",
    contractVersion: "synthetic-v1",
    subjectDigest: "subject",
    identity: {
      integrationNamespace: "synthetic",
      sourceConnectionKey: "connection",
      identityEpochKey: "epoch",
      stream: "domestic-deposit",
      sourceAccountKey: "account",
    },
    observedAt: "2026-09-25T20:00:01+08:00",
    scope: { startDate: "2026-09-25", endDate: "2026-09-25" },
    providerResponse: { endpoint: "https://bank.example/balances", status: 200 },
    page: { metadata: { source: "synthetic-summary" }, proofKind: "synthetic-snapshot" },
  }, [entry("ledger", false), entry("available", true)]);

  assert.equal("page" in capture, false);
  assert.deepEqual(capture.pages, [{
    pageOrdinal: 0,
    responseCode: "200",
    rowCount: 2,
    terminal: true,
    metadata: { source: "synthetic-summary" },
    proofKind: "synthetic-snapshot",
  }]);
  assert.deepEqual(capture.records.map((record) => record.sourceRecordKey), ["record-ledger", "record-available"]);
  for (const record of capture.records)
    assert.equal(record.contentHash, currentDepositSourceRecordContentHash(record.compact));
  assert.equal("effectiveAt" in capture.records[0]!.compact, false, "only a record that repeats the time carries it");
  assert.equal(capture.records[1]!.compact.effectiveTimeSourceValue, time.sourceValue);
  assert.deepEqual(capture.observations, capture.records.map((record, index) => ({
    observationKey: "observation",
    balanceKind: index === 0 ? "ledger" : "available",
    balance: { coefficient: index === 0 ? "1000" : "900", scale: 0 },
    currency: "TWD",
    time,
    sourceRecordKey: record.sourceRecordKey,
    sourceField: index === 0 ? "ledger-field" : "available-field",
  })));
});
