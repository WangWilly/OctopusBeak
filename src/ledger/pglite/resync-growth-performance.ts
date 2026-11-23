/**
 * How much the canonical store grows when a source is synced again with
 * nothing new (ADR 0152). It commits the same records repeatedly, each time
 * under a new capture id and a window that starts and ends a day later, as a
 * collection window does, so the oldest rows age out. It fails when any table
 * gains rows in proportion to the records re-sighted rather than a fixed
 * number per capture.
 *
 *   npm run check:pglite-resync-growth
 *
 * PGLITE_RESYNC_RECORDS (default 200) and PGLITE_RESYNC_SYNCS (default 10)
 * size the run; PGLITE_RESYNC_MODE is one of the modes below or `all`.
 * `deposit` and `card-route` go through the generic commit; `card-route` uses
 * a credit-card route and bucket coverage, one bucket per day so a day leaves
 * the inventory with the window. `card-command` drives the credit-card
 * command on the same records, with an instrument, statements and each
 * purchase's card details and lifecycle, so it also measures the command's
 * own rows. `einvoice` drives the e-invoice command on invoices in the same
 * moving window.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { assignOccurrenceSlots } from "../canonical/occurrence-groups.ts";
import { encodeCreditCardQueryBucket } from "../canonical/credit-card-query-inventory.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import {
  commitPGliteCanonicalCreditCardCapture,
  type PGliteCanonicalCreditCardCaptureRequest,
  type PGliteCanonicalCreditCardStatement,
} from "./credit-card.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
  PGLITE_EINVOICE_CONTRACT_VERSION,
  PGLITE_EINVOICE_CURRENCY_AUTHORITY,
  PGLITE_EINVOICE_ROUTE,
} from "./einvoice.ts";
import type { CanonicalEInvoiceCaptureInput } from "../canonical/einvoice-contract.ts";
import { installFinancialStore } from "./store-layout.ts";
import type { PGliteStore } from "./transaction.ts";

const ALL_MODES = ["deposit", "card-route", "card-command", "einvoice"] as const;
type Mode = (typeof ALL_MODES)[number];

function positiveInteger(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

const RECORDS = positiveInteger("PGLITE_RESYNC_RECORDS", 200, 20);
const SYNCS = positiveInteger("PGLITE_RESYNC_SYNCS", 10, 2);
const MODES: readonly Mode[] = (() => {
  const mode = process.env.PGLITE_RESYNC_MODE ?? "all";
  if (mode === "all") return ALL_MODES;
  const chosen = ALL_MODES.find((candidate) => candidate === mode);
  if (chosen === undefined) throw new Error(`PGLITE_RESYNC_MODE must be ${ALL_MODES.join(", ")} or all.`);
  return [chosen];
})();

/**
 * Rows a table may gain per unchanged re-sync. A capture itself, its scope,
 * pages, coverage and a reuse manifest are a few rows each; anything more
 * grows with the records the sync saw again.
 */
const ROWS_PER_RESYNC_BUDGET = 8;

/**
 * Bytes an unchanged re-sync may add per record seen again: a reused record
 * costs about 16 bytes in its capture's manifest, and a capture's own rows
 * are spread over its records. Storing each record again cost about 3,900.
 */
const BYTES_PER_RECORD_BUDGET = 256;

const token = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);

/**
 * One bucket per day. The credit-card command reads its buckets, so it gets
 * a statement bucket for the day, which promises Billed Monotonicity (ADR 0062).
 */
const bucketKey = (mode: Mode, date: string): string =>
  mode === "card-command" ? encodeCreditCardQueryBucket({ kind: "statement", period: date }) : date;

/** One complete bounded capture of the `RECORDS` synthetic rows inside the window, which moves a day per sync. */
function capture(mode: Mode, sync: number): PGliteCanonicalFinancialCommitRequest {
  const captureId = `${mode}-capture-${sync}`;
  const startDate = day(sync - 1);
  const endDate = day(180 + sync);
  const card = mode !== "deposit";
  const scopeKey = token("scope");
  const routeKey = card ? "fubon/credit-card/human-attested-v2" : "fubon/domestic-deposit/human-attested-v1";
  const contractVersion = card ? routeKey : "human-attested-v1";
  // Every tenth row repeats the one before it, so some occurrence groups have two members.
  const rows = Array.from({ length: RECORDS }, (_, index) => ({
    index,
    date: day((index % 10 === 9 ? index - 1 : index) % 180),
    fingerprint: token(`row-${index % 10 === 9 ? index - 1 : index}`),
  })).filter((row) => row.date >= startDate).map((row) => ({ ...row, bucketKey: card ? bucketKey(mode, row.date) : undefined }));
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => row.fingerprint,
    partitionDate: (row) => row.date,
  });
  const records = slots.map(({ row, occurrenceKey, collisionKey, group }) => ({
    occurrenceKey,
    collisionKey,
    sequenceLexeme: `${row.date}/${row.fingerprint}/${group.ordinal}`,
    providerKey: "human-attested:no-provider-key",
    contentHash: token(JSON.stringify([row.date, row.fingerprint])),
    compact: {
      amount: { coefficient: String(1000 + row.index), scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postedOn: row.date,
      description: `SYNTHETIC MERCHANT ${row.index}`,
      balance: { coefficient: String(500_000 - row.index), scale: 0 },
    },
    occurrenceGroup: group,
    ...(row.bucketKey === undefined ? {} : { occurrenceGroupBucketKey: row.bucketKey }),
  }));
  const bucketKeys = card ? [...new Set(rows.map((row) => row.bucketKey!))] : undefined;
  return {
    capture: {
      captureId,
      integrationNamespace: "fubon",
      sourceConnectionKey: token("connection"),
      identityEpoch: token("epoch"),
      stream: card ? "credit-card" : "domestic-deposit",
      recordKind: card ? "fubon-credit-card-transaction" : "fubon-domestic-deposit",
      routeKey,
      contractVersion,
      subjectDigest: token("subject"),
      observedAt: "2026-09-30T00:00:00.000Z",
      accountNumber: {
        value: "123456",
        kind: card ? "credit-portfolio-account" : "depository-account",
        evidenceVersion: "synthetic-v1",
        sourceField: "accountNumber",
      },
      scope: {
        startDate,
        endDate,
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: "full-bounded-range",
        ruleVersion: routeKey,
        sourceAccountKey: "checking-account",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { pageCount: 1 } }],
      records,
      occurrenceGroupCoverage: [{
        scopeKey,
        startDate,
        endDate,
        contractVersion,
        ...(bucketKeys ? { bucketKeys } : {}),
      }],
    },
    account: {
      sourceAccountKey: "checking-account",
      accountNo: "123456",
      accountType: card ? "credit" : "depository",
      currency: "TWD",
    },
    transactions: slots.map(({ row, occurrenceKey, group }) => ({
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: `${row.date}-${row.fingerprint}-${group.ordinal}`,
      amount: { coefficient: String(1000 + row.index), scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: routeKey,
      description: `SYNTHETIC MERCHANT ${row.index}`,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: routeKey,
      effectiveOn: row.date,
      transactionDateTimeLocal: `${row.date}T00:00:00+08:00`,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: routeKey,
      utcInstantUtcUs: Date.parse(`${row.date}T00:00:00.000+08:00`) * 1000,
    })),
    withdrawalPolicy: "never-infer",
  };
}

/** Days a statement spans; a statement is listed while the window holds all of its days. */
const STATEMENT_DAYS = 10;

/**
 * The same capture through the credit-card command: one instrument, every
 * purchase billed on the statement of its ten-day block, and that statement's
 * summary. A statement whose first day the window has passed is no longer
 * listed, as its members leave the window with it.
 */
function cardCommandCapture(sync: number): PGliteCanonicalCreditCardCaptureRequest {
  const generic = capture("card-command", sync);
  const instrumentOccurrence = token("instrument");
  const firstDay = Date.UTC(2026, 0, 1);
  const statementKeyOf = (date: string) =>
    `statement-${Math.floor((Date.parse(`${date}T00:00:00Z`) - firstDay) / 86_400_000 / STATEMENT_DAYS)}`;
  const factDates = new Map(generic.transactions.map((fact) => [fact.sourceOccurrenceKey, fact.effectiveOn]));
  const members = new Map<string, string[]>();
  for (const fact of generic.transactions) {
    const key = statementKeyOf(fact.effectiveOn);
    members.set(key, [...(members.get(key) ?? []), fact.sourceOccurrenceKey]);
  }
  const statements: PGliteCanonicalCreditCardStatement[] = [...members]
    .filter(([key]) => {
      const block = Number(key.slice("statement-".length));
      return day(block * STATEMENT_DAYS) >= generic.capture.scope.startDate;
    })
    .map(([statementKey, occurrences]) => ({
      statementKey,
      revisionKey: `${statementKey}-revision-1`,
      cycleStart: factDates.get(occurrences[0]!)!,
      cycleEnd: factDates.get(occurrences.at(-1)!)!,
      issueDate: factDates.get(occurrences.at(-1)!)!,
      dueDate: factDates.get(occurrences.at(-1)!)!,
      currency: "TWD",
      balance: { coefficient: String(occurrences.length * 1000), scale: 0 },
      minimumPayment: { coefficient: "100", scale: 0 },
      transactionSourceOccurrenceKeys: occurrences,
      evidenceSourceOccurrenceKey: token(statementKey),
    }));
  const records = [
        ...generic.capture.records,
        {
          occurrenceKey: instrumentOccurrence,
          providerKey: token("instrument-provider"),
          contentHash: token("instrument-content"),
          compact: { kind: "instrument", instrumentKey: "primary" },
        },
        ...statements.map((statement) => ({
          occurrenceKey: statement.evidenceSourceOccurrenceKey,
          providerKey: token(`${statement.statementKey}-provider`),
          contentHash: token(`${statement.statementKey}-content`),
          compact: { kind: "statement", statementKey: statement.statementKey },
        })),
  ];
  return {
    capture: {
      ...generic.capture,
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { pageCount: 1 } }],
      records,
    },
    account: generic.account,
    identity: { accountNaturalKey: token("card-account"), identityMethod: "opaque-provider-account" },
    instruments: [{ instrumentKey: "primary", cardMask: "****4281", role: "primary", lifecycle: "active", evidenceSourceOccurrenceKey: instrumentOccurrence }],
    transactions: generic.transactions.map((fact) => ({
      ...fact,
      instrumentKey: "primary",
      billingStatus: "billed" as const,
      consumeDate: fact.effectiveOn,
      postingDate: fact.effectiveOn,
      effectiveDateBasis: "consume-date" as const,
      statementKey: statementKeyOf(fact.effectiveOn),
    })),
    statements,
  };
}

/** The synthetic rows inside a sync's window: one a day over 180 days, oldest first. */
function windowRows(sync: number): readonly Readonly<{ index: number; date: string }>[] {
  const startDate = day(sync - 1);
  return Array.from({ length: RECORDS }, (_, index) => ({ index, date: day(index % 180) }))
    .filter((row) => row.date >= startDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
}

const window = (sync: number) => ({ startDate: day(sync - 1), endDate: day(180 + sync) });

/** The invoices inside the window, one issued revision each. */
function einvoiceCapture(sync: number): CanonicalEInvoiceCaptureInput {
  const money = (coefficient: string) => ({ coefficient, scale: 0, currency: "TWD" as const, currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY });
  const invoices = windowRows(sync).map(({ index, date }) => ({
    stableInvoiceKey: `AB${String(10_000_000 + index)}:${date}`,
    sourceRevisionKey: `invoice-${index}-revision-1`,
    revisionNumber: 1,
    revisionKind: "issued" as const,
    sourceIdentifiers: { invoiceNumber: `AB${String(10_000_000 + index)}`, randomNumber: "2468" },
    seller: { taxId: "12345678", name: `SYNTHETIC SELLER ${index % 10}` },
    total: money(String(100 + index)),
    occurrence: { value: date, precision: "date" as const, timeZone: "Asia/Taipei", origin: "source-reported" as const },
    items: [{
      sequence: 1,
      completeness: "complete" as const,
      name: `SYNTHETIC ITEM ${index}`,
      quantity: { coefficient: "1", scale: 0 },
      unitPrice: money(String(100 + index)),
      amount: money(String(100 + index)),
    }],
    authority: { routeKey: PGLITE_EINVOICE_ROUTE, contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION },
    provenance: { kind: "provider-record" as const, reference: `provider/invoice/${index}`, sourceField: "invoiceList" },
    revocationReason: null,
  }));
  return {
    captureId: `einvoice-capture-${sync}`,
    sourceConnectionKey: token("einvoice-connection"),
    identityEpoch: token("einvoice-epoch"),
    subjectDigest: token("einvoice-subject"),
    observedAt: "2026-09-30T00:00:00Z",
    scope: {
      ...window(sync),
      kind: "bounded-range",
      completeness: "complete-range",
      invoiceCompleteness: "complete",
      itemCompleteness: "complete",
      absenceAuthority: "comparable-complete-range",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: invoices.length, terminal: true, metadata: { pageCount: 1 } }],
    invoices,
  };
}

async function commit(store: PGliteStore, mode: Mode, sync: number): Promise<void> {
  switch (mode) {
    case "card-command": await commitPGliteCanonicalCreditCardCapture(store, cardCommandCapture(sync)); return;
    case "einvoice": await commitPGliteCanonicalEInvoiceCapture(store, einvoiceCapture(sync)); return;
    case "deposit":
    case "card-route": await commitPGliteCanonicalFinancialCapture(store, capture(mode, sync));
  }
}

async function rowCounts(store: PGliteStore): Promise<Map<string, number>> {
  const tables = await store.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  const counts = new Map<string, number>();
  for (const { name } of tables.rows) {
    const { rows: [row] } = await store.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${name}"`);
    counts.set(name, row!.count);
  }
  return counts;
}

async function databaseBytes(store: PGliteStore): Promise<number> {
  const { rows: [row] } = await store.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  return Number(row!.bytes);
}

type Growth = Readonly<{ table: string; perResync: number }>;

async function deadTuples(store: PGliteStore): Promise<number> {
  const { rows: [row] } = await store.query<{ dead: string }>(
    "SELECT COALESCE(SUM(n_dead_tup), 0)::text AS dead FROM pg_stat_user_tables",
  );
  return Number(row!.dead);
}

async function measure(mode: Mode) {
  const store = await installFinancialStore(await PGlite.create());
  try {
    await commit(store, mode, 1);
    const afterFirst = await rowCounts(store);
    const bytesAfterFirst = await databaseBytes(store);
    const deadAfterFirst = await deadTuples(store);
    const started = performance.now();
    for (let sync = 2; sync <= SYNCS; sync += 1) {
      await commit(store, mode, sync);
    }
    const resyncMs = (performance.now() - started) / (SYNCS - 1);
    const afterLast = await rowCounts(store);
    const bytesPerResync = (await databaseBytes(store) - bytesAfterFirst) / (SYNCS - 1);
    const deadTuplesPerResync = (await deadTuples(store) - deadAfterFirst) / (SYNCS - 1);
    const growth: Growth[] = [...afterLast]
      .map(([table, count]) => ({ table, perResync: (count - (afterFirst.get(table) ?? 0)) / (SYNCS - 1) }))
      .filter(({ perResync }) => perResync > 0)
      .sort((a, b) => b.perResync - a.perResync);
    return { mode, growth, bytesPerResync, deadTuplesPerResync, resyncMs };
  } finally {
    await store.close();
  }
}

let failed = false;
for (const mode of MODES) {
  const { growth, bytesPerResync, deadTuplesPerResync, resyncMs } = await measure(mode);
  const overBudget = growth.filter(({ perResync }) => perResync > ROWS_PER_RESYNC_BUDGET);
  const bytesPerRecord = bytesPerResync / RECORDS;
  console.log(JSON.stringify({
    mode,
    records: RECORDS,
    syncs: SYNCS,
    bytesPerResync: Math.round(bytesPerResync),
    bytesPerRecordPerResync: Math.round(bytesPerRecord),
    deadTuplesPerResync: Math.round(deadTuplesPerResync),
    commitMsPerResync: Math.round(resyncMs),
    rowsPerResync: Object.fromEntries(growth.map(({ table, perResync }) => [table, perResync])),
    overBudget: overBudget.map(({ table }) => table),
  }, null, 2));
  if (overBudget.length > 0 || bytesPerRecord > BYTES_PER_RECORD_BUDGET) failed = true;
}
if (failed) {
  console.error(
    `An unchanged re-sync grew a table by more than ${ROWS_PER_RESYNC_BUDGET} rows, `
      + `or the store by more than ${BYTES_PER_RECORD_BUDGET} bytes per record (ADR 0152).`,
  );
  process.exitCode = 1;
}
