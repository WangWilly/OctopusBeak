/**
 * Match a bank's current deposit balance rows to the Source Captures this run
 * admitted. Each bank declares only its key and its policy for a row with no
 * admitted capture; the per-bank builders still turn each pair into a capture.
 */

/** What happens to a row whose key has no admitted capture. */
export type CurrentBalanceUnmatchedPolicy<Row, Capture> =
  /** Leave the row out silently. */
  | Readonly<{
      kind: "skip";
      /**
       * Throw instead when an admitted capture shares the row's account under
       * another key, such as SinoPac's same account in another currency.
       */
      throwWhenAccountAdmitted?: Readonly<{
        rowAccount: (row: Row) => string;
        captureAccount: (capture: Capture) => string;
        message: string;
      }>;
    }>
  /** Leave the row out and return it in `excluded` for the bank to report. */
  | Readonly<{ kind: "exclude" }>
  /** Fail the whole match. */
  | Readonly<{ kind: "throw"; message: string }>;

export type CurrentBalanceCaptureMatching<Row, Capture> = Readonly<{
  /** The capture's key from its own identity, or undefined to leave it unindexed. */
  captureKey: (capture: Capture) => string | undefined;
  rowKey: (row: Row) => string;
  /** Which capture a key keeps when several captures share it. */
  duplicates: "first-wins" | "last-wins";
  /**
   * Whether a capture sharing a key with the one already kept carries the
   * same identity. A difference throws `ambiguousMessage`.
   */
  sameIdentity: (kept: Capture, candidate: Capture) => boolean;
  ambiguousMessage: string;
  unmatched: CurrentBalanceUnmatchedPolicy<Row, Capture>;
}>;

export type CurrentBalanceCaptureMatch<Row, Capture> = Readonly<{
  /** Matched rows, in row order. */
  matched: readonly Readonly<{ row: Row; capture: Capture }>[];
  /** Rows an `exclude` policy left out, in row order. */
  excluded: readonly Row[];
}>;

export type CurrentBalanceCaptureIndex<Row, Capture> = Readonly<{
  /** Match rows of the declared row shape or any wider one, keeping their type. */
  match: <Matched extends Row>(rows: readonly Matched[]) => CurrentBalanceCaptureMatch<Matched, Capture>;
}>;

/** Index the admitted captures, throwing when a key is ambiguous. */
export function indexCurrentBalanceCaptures<Row, Capture>(
  captures: readonly Capture[],
  matching: CurrentBalanceCaptureMatching<Row, Capture>,
): CurrentBalanceCaptureIndex<Row, Capture> {
  const index = new Map<string, Capture>();
  for (const candidate of captures) {
    const key = matching.captureKey(candidate);
    if (key === undefined) continue;
    const kept = index.get(key);
    if (kept !== undefined && !matching.sameIdentity(kept, candidate))
      throw new Error(matching.ambiguousMessage);
    if (kept === undefined || matching.duplicates === "last-wins")
      index.set(key, candidate);
  }
  return { match: (rows) => matchIndexedRows(rows, index, matching) };
}

/** Index the admitted captures and match every row, checking ambiguity first. */
export function matchCurrentBalanceCaptures<Row, Capture>(
  rows: readonly Row[],
  captures: readonly Capture[],
  matching: CurrentBalanceCaptureMatching<Row, Capture>,
): CurrentBalanceCaptureMatch<Row, Capture> {
  return indexCurrentBalanceCaptures(captures, matching).match(rows);
}

function matchIndexedRows<Row, Matched extends Row, Capture>(
  rows: readonly Matched[],
  index: ReadonlyMap<string, Capture>,
  matching: CurrentBalanceCaptureMatching<Row, Capture>,
): CurrentBalanceCaptureMatch<Matched, Capture> {
  const matched: { row: Matched; capture: Capture }[] = [];
  const excluded: Matched[] = [];
  const policy = matching.unmatched;
  for (const row of rows) {
    const capture = index.get(matching.rowKey(row));
    if (capture !== undefined) {
      matched.push({ row, capture });
      continue;
    }
    if (policy.kind === "throw") throw new Error(policy.message);
    if (policy.kind === "exclude") {
      excluded.push(row);
      continue;
    }
    const accountCheck = policy.throwWhenAccountAdmitted;
    if (accountCheck) {
      const account = accountCheck.rowAccount(row);
      if ([...index.values()].some((kept) => accountCheck.captureAccount(kept) === account))
        throw new Error(accountCheck.message);
    }
  }
  return { matched, excluded };
}
