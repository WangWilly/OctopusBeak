import {
  maicoinCashFlowIncome,
  maicoinIncomeGroup,
  type CryptoOutflow,
  type MaicoinIncome,
  type MaicoinInflow,
} from "../canonical/maicoin-cash-flow-income.ts";
import { CASH_FLOW_TRANSFER_WINDOW_DAYS } from "../canonical/cash-flow-transfer-rules.ts";
import { byChunk, idString, pgliteQuery, rows, type PGliteSpendingReader } from "./spending-sql.ts";

type CoinRow = { transaction_id: unknown; coin: unknown; quantity_coefficient: unknown; quantity_scale: unknown; effective_on: unknown };

type MaicoinRow = CoinRow & { row_type: unknown; value_coefficient: unknown; value_scale: unknown };

const coinMove = (row: CoinRow) => ({
  transactionId: idString(row.transaction_id, "Investment transaction"),
  coin: String(row.coin),
  quantity: { coefficient: String(row.quantity_coefficient), scale: Number(row.quantity_scale) },
  date: String(row.effective_on),
});

const maicoinInflow = (row: MaicoinRow): MaicoinInflow => ({
  ...coinMove(row),
  statement: {
    rowType: typeof row.row_type === "string" ? row.row_type : null,
    valueTwd: row.value_coefficient === null || row.value_coefficient === undefined
      ? null
      : { coefficient: String(row.value_coefficient), scale: Number(row.value_scale), currency: "TWD" },
  },
});

const COIN_COLUMNS = `investment.transaction_id, upper(security.producer_security_id) AS coin,
       investment.quantity_coefficient, investment.quantity_scale, investment.effective_on`;

const MAICOIN_COLUMNS = `${COIN_COLUMNS}, investment.row_type, valuation.value_coefficient, valuation.value_scale`;

const VALUATION_SQL = `LEFT JOIN investment_transaction_twd_valuations valuation ON valuation.transaction_id = investment.transaction_id`;

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
 * (ADR 0146), from the row type and TWD valuation its commit admitted (ADR
 * 0158). It reads the other sources' outflows only around a crypto deposit.
 */
export async function readMaicoinCashFlowIncome(reader: PGliteSpendingReader, transactionIds: readonly string[]): Promise<ReadonlyMap<string, MaicoinIncome>> {
  const inflows = (await byChunk<MaicoinRow>(reader, transactionIds, (placeholders) =>
    `SELECT ${MAICOIN_COLUMNS}
       FROM investment_transactions investment
       JOIN investment_securities security ON security.security_id = investment.security_id
       ${CURRENT_ROW_SQL}
       ${VALUATION_SQL}
      WHERE security.source_id = 'maicoin'
        AND investment.action = 'corporate_action_in'
        AND investment.row_type IN ('deposit','reward')
        AND ${COUNTED_REVISION_SQL}
        AND investment.transaction_id IN (${placeholders})`)).map(maicoinInflow);
  if (inflows.length === 0) return new Map();
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
  const seen = new Set(inflows.map((inflow) => inflow.transactionId));
  const peers = rows(await pgliteQuery<MaicoinRow>(
    reader,
    `SELECT ${MAICOIN_COLUMNS}
       FROM investment_transactions investment
       JOIN investment_securities security ON security.security_id = investment.security_id
       ${CURRENT_ROW_SQL}
       ${VALUATION_SQL}
      WHERE security.source_id = 'maicoin'
        AND investment.action = 'corporate_action_in'
        AND investment.row_type = 'deposit'
        AND upper(security.producer_security_id) = ANY(?::text[])
        AND investment.effective_on BETWEEN ? AND ?
        AND ${COUNTED_REVISION_SQL}`,
    [coins, peersFrom, peersThrough],
  )).map(maicoinInflow).filter((peer) => !seen.has(peer.transactionId));
  return maicoinCashFlowIncome([...inflows, ...peers], outflows);
}
