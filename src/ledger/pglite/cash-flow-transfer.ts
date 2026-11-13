import { randomUUID } from "node:crypto";
import type { CashFlowTransferLinkOrigin } from "../canonical/cash-flow-transfer.ts";
import {
  cashFlowTransferContext,
  cashFlowTransferRefusal,
  dayGap,
  transferLinkId,
  type CashFlowTransferPair,
  type CashFlowTransferReach,
  type CashFlowTransferSide,
} from "../canonical/cash-flow-transfer-rules.ts";
import { insertPGliteCanonicalCommit } from "./canonical-commit.ts";
import { readPGliteCashFlowTransfers, readStoredCashFlowTransferLinks } from "./cash-flow.ts";
import { applyOperationalMigrations } from "./operational-migrations.ts";
import { bytes, pgliteQuery } from "./spending-sql.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * Cash-flow transfer link decisions (ADR 0137), stored like Spending
 * deduplication decisions: an append-only history and the current links it
 * leaves. Both reference canonical transactions and neither changes one, so a
 * Canonical Reset empties them with the facts they point at.
 */
export const PGLITE_CASH_FLOW_TRANSFER_SQL = String.raw`
CREATE TABLE cash_flow_transfer_decision_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  decision_key TEXT NOT NULL UNIQUE,
  outflow_transaction_id BYTEA NOT NULL REFERENCES financial_transactions(transaction_id),
  inflow_transaction_id BYTEA NOT NULL REFERENCES financial_transactions(transaction_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('confirmed', 'denied', 'revoked')),
  link_origin TEXT CHECK(link_origin IN ('evidence', 'confirmed', 'manual')),
  user_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK((evidence_json)::jsonb IS NOT NULL),
  evidence_knowledge_sequence BIGINT NOT NULL CHECK(evidence_knowledge_sequence >= 0),
  commit_id BYTEA NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK(outflow_transaction_id <> inflow_transaction_id),
  CHECK((event_kind = 'confirmed' AND link_origin IN ('confirmed', 'manual'))
        OR (event_kind = 'revoked' AND link_origin IS NOT NULL)
        OR (event_kind = 'denied' AND link_origin IS NULL))
);
CREATE INDEX cash_flow_transfer_decisions_pair
  ON cash_flow_transfer_decision_events(outflow_transaction_id, inflow_transaction_id);
CREATE TABLE current_cash_flow_transfer_links (
  outflow_transaction_id BYTEA PRIMARY KEY REFERENCES financial_transactions(transaction_id),
  inflow_transaction_id BYTEA NOT NULL UNIQUE REFERENCES financial_transactions(transaction_id),
  confirmed_event_id BYTEA NOT NULL UNIQUE REFERENCES cash_flow_transfer_decision_events(event_id),
  CHECK(outflow_transaction_id <> inflow_transaction_id)
);
CREATE OR REPLACE FUNCTION cash_flow_transfer_decisions_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND canonical_purge_delete_allowed() <> 0 THEN RETURN OLD; END IF;
  RAISE EXCEPTION '%', 'Cash-flow transfer decisions are append-only';
END
$$;
CREATE TRIGGER cash_flow_transfer_decisions_append_only
  BEFORE UPDATE OR DELETE ON cash_flow_transfer_decision_events
  FOR EACH ROW EXECUTE FUNCTION cash_flow_transfer_decisions_append_only();
`;

export const CASH_FLOW_TRANSFER_TABLES = ["cash_flow_transfer_decision_events", "current_cash_flow_transfer_links"] as const;

const CASH_FLOW_TRANSFER_MIGRATIONS = [{ id: "cash-flow-transfer-links-v1", sql: PGLITE_CASH_FLOW_TRANSFER_SQL }] as const;

export function applyPgliteCashFlowTransferSchema(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Cash-flow transfer links", CASH_FLOW_TRANSFER_MIGRATIONS, CASH_FLOW_TRANSFER_TABLES);
}

export type CashFlowTransferDecision = "confirm" | "deny" | "revoke" | "pair";

const REACH: Readonly<Record<Exclude<CashFlowTransferDecision, "revoke">, CashFlowTransferReach>> = {
  confirm: "candidate",
  deny: "candidate",
  pair: "manual",
};

const LOCAL_USER_ID = "local-user";
const newId = () => Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));

type DecisionEvent = Readonly<{ kind: "confirmed" | "denied" | "revoked"; origin: CashFlowTransferLinkOrigin["kind"] | null }>;
type EventSide = Pick<CashFlowTransferSide, "accountId" | "date" | "amount" | "kind">;

/**
 * Record one decision on a pair at `knowledgeAt`, after checking the pair
 * against the links and candidates the Cash flow page computes there. A side
 * outside Cash flow, such as a Preview, covered or pending transaction, is
 * refused because the page never reads it. Revoking needs only a current
 * link: a suspended stored link can be revoked whatever became of its sides.
 */
export async function decidePGliteCashFlowTransfer(
  transaction: PGliteTransaction,
  decision: CashFlowTransferDecision,
  pair: CashFlowTransferPair,
  knowledgeAt: number,
): Promise<void> {
  const linkId = transferLinkId(pair);
  const storedTouching = await readStoredCashFlowTransferLinks(transaction, [pair.outflowTransactionId, pair.inflowTransactionId]);
  const storedLink = storedTouching.find((link) => transferLinkId(link) === linkId);
  const { sides, pairing, history } = await readPGliteCashFlowTransfers(transaction, knowledgeAt, pair);
  const outflow = sides.get(pair.outflowTransactionId);
  const inflow = sides.get(pair.inflowTransactionId);
  const commitId = async () => (await insertPGliteCanonicalCommit(transaction, {
    kind: "relation_resolution",
    authorityRoute: "user/local",
    time: { kind: "wall-clock" },
  })).id;
  if (decision === "revoke") {
    const origin = storedLink?.origin.kind ?? pairing.links.find((link) => link.linkId === linkId)?.origin.kind;
    if (origin === undefined) throw new Error("Only a current Cash-flow transfer link can be revoked.");
    await recordDecision(transaction, await commitId(), "revoke", pair, { kind: "revoked", origin }, knowledgeAt, outflow, inflow);
    return;
  }
  if (!outflow || !inflow) throw new Error("A Cash-flow transfer link joins two transactions that Cash flow counts.");
  if (pairing.links.some((link) => link.linkId === linkId)) throw new Error("This Cash-flow transfer link is already current.");
  const refusal = cashFlowTransferRefusal(outflow, inflow, REACH[decision], cashFlowTransferContext(pairing.links, history));
  if (refusal !== null) throw new Error(`Cash-flow transfer ${decision} refused: ${refusal}.`);
  const commit = await commitId();
  if (decision === "deny") {
    await recordDecision(transaction, commit, decision, pair, { kind: "denied", origin: null }, knowledgeAt, outflow, inflow);
    return;
  }
  // A side counted in a valid link was refused above, so every stored link
  // touching this pair is suspended. The new decision replaces it.
  for (const superseded of storedTouching)
    await recordDecision(transaction, commit, "supersede", superseded, { kind: "revoked", origin: superseded.origin.kind }, knowledgeAt,
      sides.get(superseded.outflowTransactionId), sides.get(superseded.inflowTransactionId));
  const eventId = await recordDecision(transaction, commit, decision, pair,
    { kind: "confirmed", origin: decision === "pair" ? "manual" : "confirmed" }, knowledgeAt, outflow, inflow);
  await pgliteQuery(transaction,
    "INSERT INTO current_cash_flow_transfer_links(outflow_transaction_id, inflow_transaction_id, confirmed_event_id) VALUES (?, ?, ?)",
    [bytes(pair.outflowTransactionId, "Outflow transaction"), bytes(pair.inflowTransactionId, "Inflow transaction"), eventId]);
}

/** Append one decision event; a revocation also ends the pair's stored link, if it has one. */
async function recordDecision(
  transaction: PGliteTransaction,
  commitId: Uint8Array,
  decision: CashFlowTransferDecision | "supersede",
  pair: CashFlowTransferPair,
  event: DecisionEvent,
  knowledgeAt: number,
  outflow: EventSide | undefined,
  inflow: EventSide | undefined,
): Promise<Uint8Array> {
  const eventId = newId();
  const side = (entry: EventSide | undefined) => entry ? { accountId: entry.accountId, date: entry.date, amount: entry.amount, kind: entry.kind } : null;
  await pgliteQuery(transaction,
    `INSERT INTO cash_flow_transfer_decision_events(
       event_id, decision_key, outflow_transaction_id, inflow_transaction_id, event_kind, link_origin,
       user_id, evidence_json, evidence_knowledge_sequence, commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId, `cash-flow/user/${decision}/${transferLinkId(pair)}/${knowledgeAt}`,
      bytes(pair.outflowTransactionId, "Outflow transaction"), bytes(pair.inflowTransactionId, "Inflow transaction"),
      event.kind, event.origin, LOCAL_USER_ID,
      JSON.stringify({
        decision, outflow: side(outflow), inflow: side(inflow),
        dayGap: outflow && inflow ? dayGap(outflow.date, inflow.date) : null,
      }),
      knowledgeAt, commitId,
    ]);
  if (event.kind === "revoked" && event.origin !== "evidence")
    await pgliteQuery(transaction,
      "DELETE FROM current_cash_flow_transfer_links WHERE outflow_transaction_id = ? AND inflow_transaction_id = ?",
      [bytes(pair.outflowTransactionId, "Outflow transaction"), bytes(pair.inflowTransactionId, "Inflow transaction")]);
  return eventId;
}
