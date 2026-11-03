/**
 * Current-state snapshot capture: turn the evidence a bank acquired for its
 * current deposit balances into staged balance captures. The bank owns
 * acquisition, its row parser, its matching policy, and its capture builder
 * (ADR 0054). This module owns the order between them: strict decoding,
 * parsing, matching rows to the Source Captures this run admitted, admission,
 * the staging item key, and the standard current-balance progress events.
 */
import {
  admitCurrentDepositBalanceCapture,
  type CurrentDepositBalanceCaptureInput,
} from "../ledger/pglite/current-deposit-admission.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import { PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND } from "../ledger/pglite/workflow-commands.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";

/** The raw evidence a bank's acquisition hands over, before any decoding. */
export type SnapshotEvidence =
  /** A response body, decoded as UTF-8 JSON. */
  | Readonly<{ kind: "json"; bytes: Uint8Array }>
  /** DOM table text, one array of cell texts per row. */
  | Readonly<{ kind: "cells"; rows: readonly (readonly string[])[] }>;

/** The evidence after strict decoding, narrowed to the kind the bank acquires. */
export type DecodedSnapshotEvidence<Evidence extends SnapshotEvidence = SnapshotEvidence> =
  Evidence extends Readonly<{ kind: "json" }>
    ? Readonly<{ kind: "json"; value: unknown }>
    : Readonly<{ kind: "cells"; rows: readonly (readonly string[])[] }>;

/** What a bank declares once per current-balance product. */
export type CurrentStateSnapshotDeclaration<
  Acquired extends Readonly<{ evidence: SnapshotEvidence }>,
  Row,
  Capture,
> = Readonly<{
  /** The product label each staged balance item carries. */
  product: string;
  /**
   * Parse decoded evidence, with whatever else the acquisition returned, such
   * as response metadata, into rows. Validates host, path, Date, and headers.
   */
  parse: (decoded: DecodedSnapshotEvidence<Acquired["evidence"]>, acquired: Acquired) => readonly Row[];
  matching: CurrentBalanceCaptureMatching<Row, Capture>;
  build: (row: Row, capture: Capture) => CurrentDepositBalanceCaptureInput;
}>;

export type CurrentStateSnapshotCapture<Row, Capture> = Readonly<{
  /** Balance stage requests, in matched row order, for the caller to stage. */
  items: readonly ProductStageRequest[];
} & CurrentBalanceCaptureMatch<Row, Capture>>;

/**
 * Acquire, decode, parse, match, and admit one current-state snapshot. With
 * no admitted financial captures it reads nothing, reports nothing, and
 * returns nothing. A decoding or parsing failure throws, which cancels the
 * Source Capture like a statement decoding failure.
 */
export async function captureCurrentStateSnapshots<
  Acquired extends Readonly<{ evidence: SnapshotEvidence }>,
  Row,
  Capture,
>(
  declaration: CurrentStateSnapshotDeclaration<Acquired, Row, Capture>,
  input: Readonly<{
    /** The financial captures this run admitted. */
    captures: readonly Capture[];
    acquire: () => Promise<Acquired>;
    product: Pick<ProductCollectionHandle, "event">;
    text: SourceTextPort;
    signal: AbortSignal;
  }>,
): Promise<CurrentStateSnapshotCapture<Row, Capture>> {
  if (input.captures.length === 0) return { items: [], matched: [], excluded: [] };
  const { product, signal } = input;
  signal.throwIfAborted();
  await product.event("collection", "started", "current-balance-collection-started");
  await product.event("decoding", "started", "current-balance-decoding-started");
  let rows: readonly Row[];
  try {
    const acquired = await input.acquire();
    signal.throwIfAborted();
    // Decoding keeps the evidence kind, which the conditional type cannot see.
    const decoded = decodeEvidence(acquired.evidence, input.text) as DecodedSnapshotEvidence<Acquired["evidence"]>;
    rows = declaration.parse(decoded, acquired);
  } catch (error) {
    await product.event("decoding", "failed", "current-balance-decoding-failed");
    await product.event("collection", "failed", "current-balance-collection-failed");
    throw error;
  }
  await product.event("decoding", "completed", "current-balance-decoding-completed");
  await product.event("collection", "completed", "current-balance-collection-completed", {
    completed: rows.length,
    total: rows.length,
  });
  const index = indexCurrentBalanceCaptures(input.captures, declaration.matching);
  await product.event("validation", "started", "current-balance-validation-started", {
    completed: 0,
    total: rows.length,
  });
  let match: CurrentBalanceCaptureMatch<Row, Capture>;
  const items: ProductStageRequest[] = [];
  try {
    match = index.match(rows);
    const itemKeys = new Set<string>();
    for (const { row, capture } of match.matched) {
      signal.throwIfAborted();
      const balance = admitCurrentDepositBalanceCapture(declaration.build(row, capture));
      const itemKey = currentBalanceItemKey(balance);
      if (itemKeys.has(itemKey))
        throw new Error(`Current-state snapshot stages ${itemKey} more than once.`);
      itemKeys.add(itemKey);
      items.push({
        product: declaration.product,
        itemKey,
        command: {
          kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
          request: currentDepositBalanceCommandRequest(balance),
        },
      });
    }
  } catch (error) {
    await product.event("validation", "failed", "current-balance-validation-rejected", {
      completed: 0,
      total: rows.length,
    });
    throw error;
  }
  await product.event("validation", "completed", "current-balance-validation-completed", {
    completed: items.length,
    total: rows.length,
  });
  return { items, matched: match.matched, excluded: match.excluded };
}

function decodeEvidence(evidence: SnapshotEvidence, text: SourceTextPort): DecodedSnapshotEvidence {
  if (evidence.kind === "cells") {
    for (const row of evidence.rows) for (const cell of row) text.assertIntact(cell);
    return evidence;
  }
  let value: unknown;
  const decoded = text.decode(evidence.bytes, "utf-8");
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new Error("Current-state snapshot response is not valid JSON.");
  }
  // JSON may encode U+FFFD as an escape, so check the parsed fields too.
  text.assertIntact(JSON.stringify(value));
  return { kind: "json", value };
}

/**
 * A staging and receipt label, not a canonical identity. A foreign-currency
 * account carries one capture per currency, so its key names the currencies.
 */
function currentBalanceItemKey(capture: CurrentDepositBalanceCaptureInput): string {
  const { stream, sourceAccountKey } = capture.identity;
  const key = `current-balance:${stream}:${sourceAccountKey}`;
  if (stream !== "foreign-currency-deposit") return key;
  const currencies = [...new Set(capture.observations.map((observation) => observation.currency))].sort();
  return `${key}:${currencies.join("+")}`;
}

// ---------------------------------------------------------------------------
// Matching rows to admitted captures. Each bank declares only its key and its
// policy for a row with no admitted capture.

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
  /**
   * A bank whose key omits the source connection and identity epoch declares
   * that every admitted capture shares one scope; captures that span more
   * than one throw `message` before anything is indexed.
   */
  oneScope?: Readonly<{ scope: (capture: Capture) => string; message: string }>;
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

/** Index the admitted captures, throwing when their scope or a key is ambiguous. */
export function indexCurrentBalanceCaptures<Row, Capture>(
  captures: readonly Capture[],
  matching: CurrentBalanceCaptureMatching<Row, Capture>,
): CurrentBalanceCaptureIndex<Row, Capture> {
  const oneScope = matching.oneScope;
  if (oneScope && new Set(captures.map(oneScope.scope)).size > 1)
    throw new Error(oneScope.message);
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
