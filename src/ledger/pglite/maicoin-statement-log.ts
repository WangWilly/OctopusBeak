import { maicoinStatementRecordKey } from "../canonical/maicoin-crypto-adapters.ts";
import {
  maicoinCashFlowIncome,
  maicoinIncomeGroup,
  type CryptoOutflow,
  type MaicoinIncome,
  type MaicoinInflow,
  type MaicoinLoggedStatement,
} from "../canonical/maicoin-cash-flow-income.ts";
import { CASH_FLOW_TRANSFER_WINDOW_DAYS } from "../canonical/cash-flow-transfer-rules.ts";
import { byChunk, idString, pgliteQuery, rows, type PGliteSpendingReader, type Row } from "./spending-sql.ts";

/**
 * The MAX statement log, `maicoin_statement_rows`, read by the investment row
 * each statement became. Every sync appends a full copy of the statement, so
 * a row is read once, from its latest capture.
 */

export type MaicoinStatementLogEntry = MaicoinLoggedStatement & Readonly<{ recordKey: string }>;

/**
 * The latest logged copy of each statement of `rowTypes`, keyed by the source
 * record key of its `transaction` leg. `occurredOn` bounds the read to the
 * statements of those Taipei dates, plus rows with no logged time: a reward
 * history logs a row a day, and every sync copies it again.
 */
export async function readMaicoinStatementLog(
  reader: PGliteSpendingReader,
  rowTypes: readonly string[],
  occurredOn: readonly [string, string] | null = null,
): Promise<MaicoinStatementLogEntry[]> {
  // The statement log is an operational table; a store that never synced MAX may not have it.
  const logged = rows(await pgliteQuery<{ present: unknown }>(reader, "SELECT to_regclass('maicoin_statement_rows') IS NOT NULL AS present"));
  if (logged[0]?.present !== true) return [];
  const found = rows(await pgliteQuery<Row>(
    reader,
    `SELECT DISTINCT ON (endpoint, wallet_type, row_type, external_id)
            endpoint, wallet_type, row_type, external_id, currency, value_twd
       FROM maicoin_statement_rows
      WHERE row_type = ANY(?::text[])
        ${occurredOn === null ? "" : "AND (occurred_at IS NULL OR (occurred_at >= ? AND occurred_at < ?))"}
      ORDER BY endpoint, wallet_type, row_type, external_id, captured_at DESC, statement_id DESC`,
    // `occurred_at` is a UTC instant, so a Taipei date's row may carry the day before.
    occurredOn === null ? [rowTypes] : [rowTypes, shiftDate(occurredOn[0], -1), shiftDate(occurredOn[1], 1)],
  ));
  return found.map((row) => ({
    recordKey: maicoinStatementRecordKey({
      endpoint: String(row.endpoint),
      walletType: row.wallet_type === null ? null : String(row.wallet_type),
      rowType: String(row.row_type),
      externalId: String(row.external_id),
      leg: "transaction",
    }),
    rowType: String(row.row_type),
    currency: typeof row.currency === "string" ? row.currency : null,
    valueTwd: row.value_twd === null || row.value_twd === undefined ? null : Number(row.value_twd),
  }));
}

type CoinRow = { transaction_id: unknown; provider_key?: unknown; coin: unknown; quantity_coefficient: unknown; quantity_scale: unknown; effective_on: unknown };

const coinMove = (row: CoinRow) => ({
  transactionId: idString(row.transaction_id, "Investment transaction"),
  coin: String(row.coin),
  quantity: { coefficient: String(row.quantity_coefficient), scale: Number(row.quantity_scale) },
  date: String(row.effective_on),
});

const COIN_COLUMNS = `investment.transaction_id, upper(security.producer_security_id) AS coin,
       investment.quantity_coefficient, investment.quantity_scale, investment.effective_on`;

const CURRENT_ROW_SQL = `JOIN current_transactions current_row ON current_row.transaction_id = investment.transaction_id
  JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id`;

const COUNTED_REVISION_SQL = `revision.posting_status = 'posted'
   AND revision.economic_status = 'normal'
   AND revision.administrative_state = 'active'`;

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function window(dates: readonly string[], days = CASH_FLOW_TRANSFER_WINDOW_DAYS): [string, string] {
  const sorted = [...dates].sort();
  return [shiftDate(sorted[0]!, -days), shiftDate(sorted.at(-1)!, days)];
}

/**
 * The income each MAX inflow among `transactionIds` counts as in Cash flow
 * (ADR 0146). It reads the statement log only when a MAX `corporate_action_in`
 * is among them, and the other sources' outflows only around a crypto deposit.
 */
export async function readMaicoinCashFlowIncome(reader: PGliteSpendingReader, transactionIds: readonly string[]): Promise<ReadonlyMap<string, MaicoinIncome>> {
  const candidates = await byChunk<CoinRow>(reader, transactionIds, (placeholders) =>
    `SELECT ${COIN_COLUMNS}, source_record.provider_key
       FROM investment_transactions investment
       JOIN source_records source_record ON source_record.source_record_id = investment.source_record_id
       JOIN investment_securities security ON security.security_id = investment.security_id
      WHERE security.source_id = 'maicoin'
        AND investment.action = 'corporate_action_in'
        AND investment.transaction_id IN (${placeholders})`);
  if (candidates.length === 0) return new Map();
  // A deposit's peers lie within two transfer windows of it: one to an outflow, one back.
  const [from, through] = window(candidates.map((row) => String(row.effective_on)), 2 * CASH_FLOW_TRANSFER_WINDOW_DAYS);
  const log = await readMaicoinStatementLog(reader, ["deposit", "reward"], [from, through]);
  const statementOf = new Map(log.map((entry) => [entry.recordKey, entry]));
  const inflows = candidates.flatMap((row): MaicoinInflow[] => {
    const statement = statementOf.get(String(row.provider_key));
    return statement ? [{ ...coinMove(row), statement }] : [];
  });
  const cryptoDeposits = inflows.filter((inflow) => maicoinIncomeGroup(inflow.statement, inflow.coin) === "income");
  if (cryptoDeposits.length === 0) return maicoinCashFlowIncome(inflows, []);

  const [outflowsFrom, outflowsThrough] = window(cryptoDeposits.map((deposit) => deposit.date));
  const coins = [...new Set(cryptoDeposits.map((deposit) => deposit.coin))];
  const outflows: CryptoOutflow[] = rows(await pgliteQuery<CoinRow>(
    reader,
    `SELECT ${COIN_COLUMNS}
       FROM investment_transactions investment
       JOIN investment_securities security ON security.security_id = investment.security_id
       ${CURRENT_ROW_SQL}
      WHERE security.source_id <> 'maicoin'
        AND investment.action = 'corporate_action_out'
        AND upper(security.producer_security_id) = ANY(?::text[])
        AND investment.effective_on BETWEEN ? AND ?
        AND ${COUNTED_REVISION_SQL}`,
    [coins, outflowsFrom, outflowsThrough],
  )).map(coinMove);
  if (outflows.length === 0) return maicoinCashFlowIncome(inflows, []);

  // An outflow is the person's own transfer only if no other MAX deposit fits it, in this read or not.
  const [peersFrom, peersThrough] = window(outflows.map((outflow) => outflow.date));
  const depositKeys = log.filter((entry) => entry.rowType === "deposit").map((entry) => entry.recordKey);
  const seen = new Set(inflows.map((inflow) => inflow.transactionId));
  const peers = rows(await pgliteQuery<CoinRow>(
    reader,
    `SELECT ${COIN_COLUMNS}, source_record.provider_key
       FROM investment_transactions investment
       JOIN source_records source_record ON source_record.source_record_id = investment.source_record_id
       JOIN investment_securities security ON security.security_id = investment.security_id
       ${CURRENT_ROW_SQL}
      WHERE security.source_id = 'maicoin'
        AND investment.action = 'corporate_action_in'
        AND upper(security.producer_security_id) = ANY(?::text[])
        AND investment.effective_on BETWEEN ? AND ?
        AND source_record.provider_key = ANY(?::text[])
        AND ${COUNTED_REVISION_SQL}`,
    [coins, peersFrom, peersThrough, depositKeys],
  )).flatMap((row): MaicoinInflow[] => {
    const statement = statementOf.get(String(row.provider_key));
    return statement && !seen.has(idString(row.transaction_id, "Investment transaction")) ? [{ ...coinMove(row), statement }] : [];
  });
  return maicoinCashFlowIncome([...inflows, ...peers], outflows);
}
