import assert from "node:assert/strict";
import test from "node:test";
import {
  indexCurrentBalanceCaptures,
  matchCurrentBalanceCaptures,
  type CurrentBalanceCaptureMatching,
  type CurrentBalanceUnmatchedPolicy,
} from "./current-balance-capture-match.ts";

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
