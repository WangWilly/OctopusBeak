/**
 * Current-state snapshot capture: turn the evidence a bank acquired for its
 * current deposit balances or credit-card used credit into staged balance
 * captures (ADR 0108). The bank owns
 * acquisition, its row parser, its matching policy, and the facts its capture
 * builder hands over (ADR 0054, ADR 0107). This module owns the order between
 * them: accepting the provider response (ADR 0110), parsing, matching rows to the Source Captures this
 * run admitted, assembling and admitting each capture, the staging item key,
 * and the standard current-balance progress events.
 */
import type { CanonicalSourcePage } from "../ledger/canonical/canonical-source-evidence.ts";
import {
  admitCreditCardCurrentBalanceCapture,
  creditCardCurrentBalanceSourceRecord,
  type CreditCardCurrentBalanceCaptureInput,
  type CreditCardCurrentBalanceEstimate,
  type CreditCardCurrentBalanceIdentity,
  type CreditCardCurrentBalanceObservationInput,
  type CreditCardCurrentBalanceSourceRecordInput,
  type CreditCardCurrentBalanceTimeEvidence,
  type CreditCardExactAmount,
} from "../ledger/canonical/credit-card-current-balance-admission.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositAccountScope,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceKind,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
  type CurrentDepositTimeEvidence,
} from "../ledger/pglite/current-deposit-admission.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import { creditCardBalanceCommandRequest } from "../ledger/pglite/credit-card-adapters.ts";
import type { PGliteCanonicalCreditCardIdentity } from "../ledger/pglite/credit-card.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import {
  type DecodedProviderEvidence,
  type ProviderAcquisition,
  type ProviderDateRule,
  type ProviderResponseDeclaration,
  type VerifiedProviderResponse,
} from "./provider-response.ts";
import { providerResponseReader, type ProviderResponseReader } from "./provider-response-reader.ts";

/** How a bank stages the rows it read: matching, building, and labeling. */
export type CurrentStateSnapshotStaging<Row, Capture, Input = CurrentDepositBalanceCaptureInput> = Readonly<{
  /** The product label each staged balance item carries. */
  product: string;
  /** How a built capture is admitted, keyed, and committed. */
  kind: CurrentBalanceStagingKind<Capture, Input>;
  matching: CurrentBalanceCaptureMatching<Row, Capture>;
  build: (row: Row, capture: Capture) => Input;
  /**
   * Check the matched snapshot as a whole, such as that it covers every
   * admitted account. A throw rejects validation and stages nothing.
   */
  validate?: (result: Readonly<{ rows: readonly Row[] }> & CurrentBalanceCaptureMatch<Row, Capture>) => void;
}>;

/** What a bank declares once per current-balance product. */
export type CurrentStateSnapshotDeclaration<
  Acquired extends ProviderAcquisition,
  Row,
  Capture,
  DateRule extends ProviderDateRule = "required",
  Input = CurrentDepositBalanceCaptureInput,
> = CurrentStateSnapshotStaging<Row, Capture, Input> & Readonly<{
  response: ProviderResponseDeclaration<DateRule>;
  /**
   * Parse decoded evidence into rows, reading transport facts only from the
   * verified response and anything else from the acquisition.
   */
  parse: (
    decoded: DecodedProviderEvidence<Acquired["evidence"]>,
    response: VerifiedProviderResponse<DateRule>,
    acquired: Acquired,
  ) => readonly Row[];
}>;

export type CurrentStateSnapshotCapture<Row, Capture> = Readonly<{
  /** Balance stage requests, in matched row order, for the caller to stage. */
  items: readonly ProductStageRequest[];
} & CurrentBalanceCaptureMatch<Row, Capture>>;

/** What the snapshot module needs from the product that owns the snapshot (ADR 0116). */
export type SnapshotProduct = Pick<ProductCollectionHandle, "event" | "validate" | "reader" | "signal">;

/**
 * The product a snapshot reads for: its handle, or, until every bank passes
 * its handle, the run ports a caller threads in beside the product.
 */
type SnapshotRun =
  | Readonly<{ product: SnapshotProduct; now?: never; text?: never; signal?: never }>
  | Readonly<{
    /** The run clock, an RFC3339 instant. */
    now: () => string;
    text: SourceTextPort;
    signal: AbortSignal;
    product: Pick<ProductCollectionHandle, "event" | "validate">;
  }>;

function snapshotPorts(run: SnapshotRun): Readonly<{
  product: Pick<ProductCollectionHandle, "event" | "validate">;
  signal: AbortSignal;
  reader: () => ProviderResponseReader;
}> {
  if (run.now !== undefined) {
    return {
      product: run.product,
      signal: run.signal,
      reader: () => providerResponseReader({ now: run.now, text: run.text, validate: run.product.validate }),
    };
  }
  return { product: run.product, signal: run.product.signal, reader: () => run.product.reader };
}

/**
 * Acquire, decode, parse, match, and admit one current-state snapshot. With
 * no admitted financial captures it reads nothing, reports nothing, and
 * returns nothing. A decoding or parsing failure throws, which cancels the
 * Source Capture like a statement decoding failure.
 */
export async function captureCurrentStateSnapshots<
  Acquired extends ProviderAcquisition,
  Row,
  Capture,
  DateRule extends ProviderDateRule,
  Input,
>(
  declaration: CurrentStateSnapshotDeclaration<Acquired, Row, Capture, DateRule, Input>,
  input: Readonly<{
    /** The financial captures this run admitted. */
    captures: readonly Capture[];
    acquire: () => Promise<Acquired>;
  }> & SnapshotRun,
): Promise<CurrentStateSnapshotCapture<Row, Capture>> {
  if (input.captures.length === 0) return { items: [], matched: [], excluded: [] };
  const rows = await readCurrentStateSnapshot(declaration, input);
  return stageCurrentStateSnapshot(declaration, rows, input);
}

/**
 * The read half: acquire, strictly decode, and parse one snapshot, reporting
 * collection and decoding. For a bank whose captures depend on the rows, such
 * as Fubon admitting a USD-coded account only after reconciling it.
 */
export async function readCurrentStateSnapshot<
  Acquired extends ProviderAcquisition,
  Row,
  DateRule extends ProviderDateRule,
>(
  declaration: Pick<CurrentStateSnapshotDeclaration<Acquired, Row, never, DateRule>, "response" | "parse">,
  input: Readonly<{ acquire: () => Promise<Acquired> }> & SnapshotRun,
): Promise<readonly Row[]> {
  const { product, signal } = snapshotPorts(input);
  signal.throwIfAborted();
  await product.event("collection", "started", "current-balance-collection-started");
  await product.event("decoding", "started", "current-balance-decoding-started");
  let acquired: Acquired;
  try {
    acquired = await input.acquire();
  } catch (error) {
    // A failed read is a collection failure (ADR 0106). A transport the reader
    // refused while acquiring was already reported as a validation failure.
    if (!(error instanceof ProviderResponseCheckError))
      await product.event("collection", "failed", "current-balance-collection-failed");
    throw error;
  }
  signal.throwIfAborted();
  const { response, evidence } = await snapshotPorts(input).reader().accept(declaration.response, acquired);
  const rows = await product.validate(() => parseRows(() => declaration.parse(evidence, response, acquired)));
  await product.event("decoding", "completed", "current-balance-decoding-completed");
  await product.event("collection", "completed", "current-balance-collection-completed", {
    completed: rows.length,
    total: rows.length,
  });
  return rows;
}

/**
 * The stage half: match read rows to the admitted captures, then build,
 * admit, and key each balance, and run the declaration's whole-snapshot
 * check, reporting validation. Ambiguous captures throw before validation
 * starts.
 */
export async function stageCurrentStateSnapshot<Row, Capture, Input>(
  declaration: CurrentStateSnapshotStaging<Row, Capture, Input>,
  rows: readonly Row[],
  input: Readonly<{
    /** The financial captures this run admitted. */
    captures: readonly Capture[];
  }> & (Readonly<{ product: SnapshotProduct; signal?: never }> | Readonly<{ product: Pick<ProductCollectionHandle, "event" | "validate">; signal: AbortSignal }>),
): Promise<CurrentStateSnapshotCapture<Row, Capture>> {
  const { product } = input;
  const signal = input.signal !== undefined ? input.signal : input.product.signal;
  const index = indexCurrentBalanceCaptures(input.captures, declaration.matching);
  await product.event("validation", "started", "current-balance-validation-started", {
    completed: 0,
    total: rows.length,
  });
  const items: ProductStageRequest[] = [];
  const match = await product.validate(() => {
    const match = index.match(rows);
    const itemKeys = new Set<string>();
    for (const { row, capture } of match.matched) {
      signal.throwIfAborted();
      const { itemKey, command } = declaration.kind.stage(declaration.build(row, capture), capture);
      if (itemKeys.has(itemKey))
        throw new Error(`Current-state snapshot stages ${itemKey} more than once.`);
      itemKeys.add(itemKey);
      items.push({ product: declaration.product, itemKey, command });
    }
    declaration.validate?.({ rows, ...match });
    return match;
  });
  await product.event("validation", "completed", "current-balance-validation-completed", {
    completed: items.length,
    total: rows.length,
  });
  return { items, matched: match.matched, excluded: match.excluded };
}

/**
 * The parser errors that name no failure of their own: a plain `Error`, or a
 * built-in one such as the `TypeError` of reading a field the source dropped.
 */
const UNNAMED_PARSER_ERRORS: ReadonlySet<unknown> = new Set([
  Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError,
]);

/**
 * Run the source's row parser. An unnamed error it throws names the row-parse
 * check and keeps its message; an error with its own type keeps its meaning.
 */
function parseRows<Row>(parse: () => readonly Row[]): readonly Row[] {
  try {
    return parse();
  } catch (error) {
    if (error instanceof Error && UNNAMED_PARSER_ERRORS.has(error.constructor))
      throw new ProviderResponseCheckError("row-parse", error.message, { cause: error });
    throw error;
  }
}

/** How one kind of built capture is admitted, keyed, and committed. */
export type CurrentBalanceStagingKind<Capture, Input> = Readonly<{
  /** Admit a built capture and name its stage request. A throw rejects validation. */
  stage: (input: Input, capture: Capture) => Readonly<{ itemKey: string; command: ProductStageRequest["command"] }>;
}>;

/**
 * Current deposit balances. The item key is a staging and receipt label, not
 * a canonical identity. A foreign-currency account carries one capture per
 * currency, so its key names the currencies.
 */
export const CURRENT_DEPOSIT_BALANCE_STAGING: CurrentBalanceStagingKind<unknown, CurrentDepositBalanceCaptureInput> = {
  stage: (input) => {
    const balance = admitCurrentDepositBalanceCapture(input);
    const { stream, sourceAccountKey } = balance.identity;
    const key = `current-balance:${stream}:${sourceAccountKey}`;
    const currencies = [...new Set(balance.observations.map((observation) => observation.currency))].sort();
    return {
      itemKey: stream === "foreign-currency-deposit" ? `${key}:${currencies.join("+")}` : key,
      command: {
        kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
        request: currentDepositBalanceCommandRequest(balance),
      },
    };
  },
};

/** The admitted credit-card capture a current used-credit balance belongs to. */
export type CurrentCreditCardStagingCapture = Readonly<{ cardIdentity: PGliteCanonicalCreditCardIdentity }>;

/** Current credit-card used credit, keyed by its capture id. */
export const CURRENT_CREDIT_CARD_BALANCE_STAGING: CurrentBalanceStagingKind<
  CurrentCreditCardStagingCapture,
  CreditCardCurrentBalanceCaptureInput
> = {
  stage: (input, capture) => {
    const balance = admitCreditCardCurrentBalanceCapture(input);
    return {
      itemKey: balance.captureId,
      command: {
        kind: PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
        request: creditCardBalanceCommandRequest(balance, capture.cardIdentity),
      },
    };
  },
};

/**
 * Matching for an issuer that reports one used-credit balance for all of a
 * holder's cards: the one row belongs to the one admitted capture.
 */
export function issuerAggregateMatching<Row, Capture>(label: string): CurrentBalanceCaptureMatching<Row, Capture> {
  return {
    captureKey: () => "issuer-aggregate",
    rowKey: () => "issuer-aggregate",
    duplicates: "first-wins",
    sameIdentity: () => false,
    ambiguousMessage: `${label} has more than one admitted capture for its issuer aggregate.`,
    unmatched: { kind: "throw", message: `${label} has no admitted capture for its issuer aggregate.` },
  };
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

/**
 * What one kind of Current-state provider snapshot builds from each balance
 * entry: its source record and the observation that cites that record.
 */
export type CurrentStateCaptureKind<Entry, SourceRecord, Observation> = Readonly<{
  record: (entry: Entry) => SourceRecord;
  observation: (entry: Entry) => Observation;
}>;

/**
 * The facts of one single-page capture that the bank decides, including its
 * page evidence. The module makes that page the one terminal page, counts its
 * rows, and adds every record and observation.
 */
export type CurrentStateCaptureEnvelope<Identity, ProviderResponseEvidence> = Readonly<{
  captureId: string;
  authorityRoute: string;
  contractVersion: string;
  subjectDigest: string;
  identity: Identity;
  observedAt: string;
  scope: Readonly<{
    startDate: string;
    endDate: string;
    contractFingerprint?: string;
    preflightFingerprint?: string;
  }>;
  providerResponse: ProviderResponseEvidence;
  page: Omit<CanonicalSourcePage, "pageOrdinal" | "responseCode" | "rowCount" | "terminal">;
}>;

/** Assemble a Current-state provider snapshot capture from its envelope and balance entries. */
export function assembleCurrentStateCapture<Entry, SourceRecord, Observation, Identity, ProviderResponseEvidence>(
  kind: CurrentStateCaptureKind<Entry, SourceRecord, Observation>,
  envelope: CurrentStateCaptureEnvelope<Identity, ProviderResponseEvidence>,
  entries: readonly Entry[],
): Omit<CurrentStateCaptureEnvelope<Identity, ProviderResponseEvidence>, "page"> & Readonly<{
  pages: readonly CanonicalSourcePage[];
  records: readonly SourceRecord[];
  observations: readonly Observation[];
}> {
  const { page, ...capture } = envelope;
  return {
    ...capture,
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: entries.length, terminal: true, ...page }],
    records: entries.map(kind.record),
    observations: entries.map(kind.observation),
  };
}

/** One current deposit balance a provider reported, with the keys the bank derives for it. */
export type CurrentDepositBalanceEntry = Readonly<{
  sourceRecordKey: string;
  providerKey: string;
  observationKey: string;
  balanceKind: CurrentDepositBalanceKind;
  sourceField: string;
  currency: string;
  value: CurrentDepositExactAmount;
  time: CurrentDepositTimeEvidence;
  /**
   * Whether the record's compact form also gets the effective time and its
   * source field and value from `time`. A bank may already carry time fields
   * in `compact`; this flag adds none. Flipping it changes the record's content
   * hash, so it follows what the bank's records already held.
   */
  timeInRecord: boolean;
  compact: Record<string, unknown>;
}>;

const CURRENT_DEPOSIT_BALANCE: CurrentStateCaptureKind<
  CurrentDepositBalanceEntry,
  CurrentDepositSourceRecordInput,
  CurrentDepositBalanceObservationInput
> = {
  record: (entry) => {
    const record = currentDepositSourceRecord({
      sourceRecordKey: entry.sourceRecordKey,
      providerKey: entry.providerKey,
      contentHash: "",
      sourceField: entry.sourceField,
      balanceKind: entry.balanceKind,
      currency: entry.currency,
      value: entry.value,
      ...(entry.timeInRecord ? { time: entry.time } : {}),
      compact: entry.compact,
    });
    return { ...record, contentHash: currentDepositSourceRecordContentHash(record.compact) };
  },
  observation: (entry) => ({
    observationKey: entry.observationKey,
    balanceKind: entry.balanceKind,
    balance: entry.value,
    currency: entry.currency,
    time: entry.time,
    sourceRecordKey: entry.sourceRecordKey,
    sourceField: entry.sourceField,
  }),
};

/** Assemble a current deposit balance capture from its envelope and balance entries. */
export function assembleCurrentDepositCapture(
  envelope: CurrentStateCaptureEnvelope<CurrentDepositAccountScope, CurrentDepositBalanceCaptureInput["providerResponse"]>,
  entries: readonly CurrentDepositBalanceEntry[],
): CurrentDepositBalanceCaptureInput {
  return assembleCurrentStateCapture(CURRENT_DEPOSIT_BALANCE, envelope, entries);
}

/** One issuer credit snapshot balance a provider reported, with the keys the bank derives for it. */
export type CurrentCreditCardBalanceEntry = Readonly<{
  sourceRecordKey: string;
  providerKey: string;
  observationKey: string;
  sourceField: string;
  currency: string;
  value: CreditCardExactAmount;
  time: CreditCardCurrentBalanceTimeEvidence;
  estimate: CreditCardCurrentBalanceEstimate;
  compact: Record<string, unknown>;
}>;

const CURRENT_CREDIT_CARD_BALANCE: CurrentStateCaptureKind<
  CurrentCreditCardBalanceEntry,
  CreditCardCurrentBalanceSourceRecordInput,
  CreditCardCurrentBalanceObservationInput
> = {
  record: (entry) => creditCardCurrentBalanceSourceRecord({
    sourceRecordKey: entry.sourceRecordKey,
    providerKey: entry.providerKey,
    sourceField: entry.sourceField,
    balanceKind: "credit_used",
    currency: entry.currency,
    value: entry.value,
    time: entry.time,
    estimate: entry.estimate,
    compact: entry.compact,
  }),
  observation: (entry) => ({
    observationKey: entry.observationKey,
    balanceKind: "credit_used",
    balance: entry.value,
    currency: entry.currency,
    time: entry.time,
    sourceRecordKey: entry.sourceRecordKey,
    sourceField: entry.sourceField,
    estimate: entry.estimate,
  }),
};

/** Assemble a current credit-card used-credit capture from its envelope and balance entries. */
export function assembleCurrentCreditCardCapture(
  envelope: CurrentStateCaptureEnvelope<
    CreditCardCurrentBalanceIdentity,
    CreditCardCurrentBalanceCaptureInput["providerResponse"]
  >,
  entries: readonly CurrentCreditCardBalanceEntry[],
): CreditCardCurrentBalanceCaptureInput {
  return assembleCurrentStateCapture(CURRENT_CREDIT_CARD_BALANCE, envelope, entries);
}
