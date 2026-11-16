import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { insertPGliteCanonicalCommit } from "./canonical-commit.ts";
import { installFinancialStore } from "./store-layout.ts";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import type { PGliteTransaction } from "./transaction.ts";

type Row = Record<string, unknown>;

const CLEANUP = "kind-duplicate-cleanup-v1";
const SPACE_RETURNED = "kind-duplicate-cleanup-space-v1";
const HISTORY_TABLES = ["assertions", "enrichment_run_outputs", "assertion_transitions", "assertion_provenance", "enrichment_taxonomy_assertion_values"];

const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
const hexBytes = (hex: string) => Buffer.from(hex, "hex");
const hexOf = (id: string) => id.replaceAll("-", "");
const newId = "decode(replace(gen_random_uuid()::text, '-', ''), 'hex')";

/** The Kind `selectCurrentEnrichment` picks for each transaction at cutoff $1, with the output provenance Cash flow reads as its evidence. */
const SELECTED_KINDS = `
  WITH eligible AS (
    SELECT assertion.transaction_id, assertion.assertion_id, assertion.value_text, assertion.origin, assertion.producer_id,
           route.producer_version, output.route_id, route.taxonomy_id, route.taxonomy_version,
           typed.taxonomy_dimension, COALESCE(typed.taxonomy_code, assertion.value_text) AS taxonomy_code,
           ROW_NUMBER() OVER (
             PARTITION BY assertion.transaction_id
             ORDER BY CASE WHEN assertion.origin = 'source' THEN 0 ELSE 1 END, created.commit_sequence DESC, encode(assertion.assertion_id, 'hex') DESC
           ) AS rank
      FROM assertions assertion
      JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
      JOIN enrichment_run_outputs output ON output.assertion_id = assertion.assertion_id AND output.output_state = 'supported'
      JOIN enrichment_runs run ON run.run_id = output.run_id
      JOIN automatic_enrichment_authority_routes route ON route.route_id = output.route_id
      LEFT JOIN enrichment_taxonomy_assertion_values typed ON typed.assertion_id = assertion.assertion_id
     WHERE assertion.target_kind = 'transaction' AND assertion.field_name = 'kind'
       AND created.commit_sequence <= $1
       AND route.valid_from_commit_sequence <= $1
       AND (route.valid_to_commit_sequence IS NULL OR $1 < route.valid_to_commit_sequence)
       AND COALESCE((
         SELECT transition.event_kind
           FROM assertion_transitions transition
           JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
          WHERE transition.assertion_id = assertion.assertion_id AND event_commit.commit_sequence <= $1
          ORDER BY event_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC LIMIT 1
       ), 'observed') NOT IN ('withdrawn', 'superseded')
  ),
  selected AS (
    SELECT eligible.*,
           (SELECT string_agg(output.provenance_json, '|' ORDER BY output.provenance_json)
              FROM assertion_provenance provenance
              JOIN enrichment_run_outputs output
                ON output.run_id = provenance.enrichment_run_id AND output.transaction_id = eligible.transaction_id
               AND output.field_name = 'kind' AND output.assertion_id = eligible.assertion_id
             WHERE provenance.assertion_id = eligible.assertion_id AND provenance.enrichment_run_id IS NOT NULL) AS evidence
      FROM eligible WHERE rank = 1
  )`;

const SELECTED_COLUMNS = "value_text, origin, producer_id, producer_version, route_id, taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code";

async function knowledgePoint(reader: Pick<PGliteTransaction, "query">): Promise<number> {
  return Number((await reader.query<{ n: number | string }>("SELECT max(commit_sequence) AS n FROM canonical_commits")).rows[0]!.n);
}

/** Each transaction's selected Kind at a cutoff, keyed by transaction; `assertion` is the assertion selected. */
async function selectedAt(reader: Pick<PGliteTransaction, "query">, cutoff: number): Promise<Map<string, Row & { assertion: string }>> {
  const rows = (await reader.query<Row & { transaction: string; assertion: string }>(
    `${SELECTED_KINDS}
     SELECT encode(transaction_id, 'hex') AS transaction, encode(assertion_id, 'hex') AS assertion, ${SELECTED_COLUMNS}, evidence FROM selected`,
    [cutoff],
  )).rows;
  return new Map(rows.map((row) => [row.transaction, row]));
}

/** What every cutoff selects, without the assertion ids the cleanup is free to change. */
async function kindHistory(fixture: SpendingCategoryFixture): Promise<Row[][]> {
  const history: Row[][] = [];
  for (let cutoff = 1; cutoff <= await knowledgePoint(fixture.store); cutoff += 1)
    history.push([...(await selectedAt(fixture.store, cutoff)).values()]
      .map(({ assertion: _assertion, ...row }) => row)
      .sort((left, right) => String(left.transaction).localeCompare(String(right.transaction))));
  return history;
}

/** Leaves the current Kind rows as a refresh at the knowledge point leaves them. */
async function selectCurrentKinds(fixture: SpendingCategoryFixture): Promise<void> {
  await fixture.store.transaction(async (transaction) => {
    await transaction.query("DELETE FROM current_transaction_enrichment WHERE field_name = 'kind'");
    await transaction.query(
      `${SELECTED_KINDS}
       INSERT INTO current_transaction_enrichment(transaction_id, field_name, assertion_id, ${SELECTED_COLUMNS}, projection_commit_id)
       SELECT transaction_id, 'kind', assertion_id, ${SELECTED_COLUMNS},
              (SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1)
         FROM selected`,
      [await knowledgePoint(transaction)],
    );
  });
}

async function currentKindAssertions(fixture: SpendingCategoryFixture): Promise<Map<string, string>> {
  const rows = (await fixture.store.query<{ transaction: string; assertion: string }>(
    "SELECT encode(transaction_id, 'hex') AS transaction, encode(assertion_id, 'hex') AS assertion FROM current_transaction_enrichment WHERE field_name = 'kind'",
  )).rows;
  return new Map(rows.map((row) => [row.transaction, row.assertion]));
}

async function assertCurrentIsSelected(fixture: SpendingCategoryFixture, message: string): Promise<void> {
  const selected = await selectedAt(fixture.store, await knowledgePoint(fixture.store));
  assert.deepEqual(
    [...await currentKindAssertions(fixture)].sort(),
    [...selected].map(([transaction, row]) => [transaction, row.assertion]).sort(),
    message,
  );
}

type KindWrite = Readonly<{
  /** A new value; omitted repeats the latest assertion's. */
  value?: string;
  evidenceKind?: string;
  /** Supersede the selected Kind, as a refresh that read it does. The refresh bug read none. */
  supersede?: boolean;
}>;

async function latestKind(transaction: PGliteTransaction, transactionId: string) {
  return (await transaction.query<{ assertion_id: Uint8Array; run_id: Uint8Array }>(
    `SELECT assertion.assertion_id, output.run_id
       FROM assertions assertion
       JOIN enrichment_run_outputs output ON output.assertion_id = assertion.assertion_id
       JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
      WHERE assertion.transaction_id = $1 AND assertion.field_name = 'kind'
      ORDER BY created.commit_sequence DESC, encode(assertion.assertion_id, 'hex') DESC, encode(output.output_id, 'hex') LIMIT 1`,
    [idBytes(transactionId)],
  )).rows[0]!;
}

async function selectedKind(transaction: PGliteTransaction, transactionId: string): Promise<Buffer | null> {
  const selected = (await selectedAt(transaction, await knowledgePoint(transaction))).get(hexOf(transactionId));
  return selected ? hexBytes(selected.assertion) : null;
}

/** A new commit holding a copy of `fromRun`, for one more output on the same transaction. */
async function nextRun(transaction: PGliteTransaction, fromRun: Uint8Array) {
  const commit = await insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
  const run = (await transaction.query<{ id: Uint8Array }>(`SELECT ${newId} AS id`)).rows[0]!.id;
  await transaction.query(
    `INSERT INTO enrichment_runs(run_id, source_connection_id, identity_epoch_id, stream, producer_id, producer_version, origin, rule_lineage, observed_at, commit_id, status, complete_scope)
     SELECT $2, source_connection_id, identity_epoch_id, stream, producer_id, producer_version, origin, rule_lineage, observed_at, $3, status, complete_scope
       FROM enrichment_runs WHERE run_id = $1`,
    [fromRun, run, commit.id],
  );
  return { run, at: commit.id };
}

async function retire(transaction: PGliteTransaction, assertion: Uint8Array, transactionId: string, run: Uint8Array, at: Uint8Array, eventKind: "observed" | "superseded" | "withdrawn") {
  await transaction.query(
    `INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
     VALUES (${newId}, $1, $2, 'kind', NULL, NULL, NULL, $3, NULL, NULL, $4, $5)`,
    [assertion, idBytes(transactionId), run, at, eventKind],
  );
}

/** Writes a Kind as `writeDerivedOutputs` does, copied from the transaction's latest; returns the new assertion's hex id. */
async function writeKind(fixture: SpendingCategoryFixture, transactionId: string, write: KindWrite = {}): Promise<string> {
  return fixture.store.transaction(async (transaction) => {
    const superseded = write.supersede ? await selectedKind(transaction, transactionId) : null;
    const from = await latestKind(transaction, transactionId);
    const { run, at } = await nextRun(transaction, from.run_id);
    const to = (await transaction.query<{ id: Uint8Array }>(`SELECT ${newId} AS id`)).rows[0]!.id;
    const value = write.value ?? null;
    await transaction.query(
      `INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
       SELECT $2, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, COALESCE($4, value_text), $3
         FROM assertions WHERE assertion_id = $1`,
      [from.assertion_id, to, at, value],
    );
    await transaction.query(
      `INSERT INTO enrichment_run_outputs(output_id, run_id, transaction_id, field_name, output_state, origin, value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text, provenance_json, assertion_id, commit_id)
       SELECT ${newId}, $3, transaction_id, field_name, output_state, origin, COALESCE($6, value_text), confidence_basis_points, route_id, source_record_id, source_field, source_value_text,
              CASE WHEN $7::text IS NULL THEN provenance_json ELSE jsonb_set(provenance_json::jsonb, '{evidenceKind}', to_jsonb($7::text))::text END, $4, $5
         FROM enrichment_run_outputs WHERE assertion_id = $1 AND run_id = $2`,
      [from.assertion_id, from.run_id, run, to, at, value, write.evidenceKind ?? null],
    );
    await transaction.query(
      "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES ($1, NULL, NULL, $2, NULL, $3)",
      [to, run, at],
    );
    await retire(transaction, to, transactionId, run, at, "observed");
    await transaction.query(
      `INSERT INTO enrichment_taxonomy_assertion_values(assertion_id, field_name, taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code, route_id, run_id, source_record_id, provenance_json)
       SELECT $2, field_name, taxonomy_id, taxonomy_version, taxonomy_dimension, COALESCE($4, taxonomy_code), route_id, $3, source_record_id, provenance_json
         FROM enrichment_taxonomy_assertion_values WHERE assertion_id = $1`,
      [from.assertion_id, to, run, value],
    );
    if (superseded) await retire(transaction, superseded, transactionId, run, at, "superseded");
    await transaction.query(
      `UPDATE current_transaction_enrichment
          SET assertion_id = $2, value_text = COALESCE($3, value_text), taxonomy_code = COALESCE($3, taxonomy_code)
        WHERE transaction_id = $1 AND field_name = 'kind'`,
      [idBytes(transactionId), to, value],
    );
    return Buffer.from(to).toString("hex");
  });
}

/** An unsupported Kind output; `withdraw` withdraws the selected Kind, as a refresh that read it does. */
async function writeUnsupported(fixture: SpendingCategoryFixture, transactionId: string, withdraw: boolean): Promise<void> {
  await fixture.store.transaction(async (transaction) => {
    const withdrawn = withdraw ? await selectedKind(transaction, transactionId) : null;
    const from = await latestKind(transaction, transactionId);
    const { run, at } = await nextRun(transaction, from.run_id);
    await transaction.query(
      `INSERT INTO enrichment_run_outputs(output_id, run_id, transaction_id, field_name, output_state, origin, value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text, provenance_json, assertion_id, commit_id)
       SELECT ${newId}, $3, transaction_id, field_name, 'unsupported', NULL, NULL, NULL, route_id, source_record_id, source_field, source_value_text, provenance_json, NULL, $4
         FROM enrichment_run_outputs WHERE assertion_id = $1 AND run_id = $2`,
      [from.assertion_id, from.run_id, run, at],
    );
    if (withdrawn) await retire(transaction, withdrawn, transactionId, run, at, "withdrawn");
  });
}

/** A second output, in a later run, for the transaction's latest Kind assertion. */
async function addSecondOutput(fixture: SpendingCategoryFixture, transactionId: string): Promise<string> {
  return fixture.store.transaction(async (transaction) => {
    const from = await latestKind(transaction, transactionId);
    const { run, at } = await nextRun(transaction, from.run_id);
    await transaction.query(
      `INSERT INTO enrichment_run_outputs(output_id, run_id, transaction_id, field_name, output_state, origin, value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text, provenance_json, assertion_id, commit_id)
       SELECT ${newId}, $3, transaction_id, field_name, output_state, origin, value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text, provenance_json, assertion_id, $4
         FROM enrichment_run_outputs WHERE assertion_id = $1 AND run_id = $2`,
      [from.assertion_id, from.run_id, run, at],
    );
    return Buffer.from(from.assertion_id).toString("hex");
  });
}

async function kindFixture() {
  const fixture = await createSpendingCategoryFixture();
  const deposit = { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" } as const;
  const fee = await fixture.addTransaction({ amount: "15", direction: "outflow", date: "2026-09-10", description: "手續費", account: "salary-account", accountStream: deposit });
  const card = await fixture.addTransaction({ amount: "320", date: "2026-09-11" });
  await installFinancialStore(fixture.database);
  return { fixture, fee, card };
}

async function recordedKeys(fixture: SpendingCategoryFixture): Promise<string[]> {
  return (await fixture.store.query<{ migration_key: string }>(
    "SELECT migration_key FROM pglite_operational_migrations WHERE migration_key = ANY($1::text[])",
    [[CLEANUP, SPACE_RETURNED]],
  )).rows.map((row) => row.migration_key).sort();
}

/** Opens the store as one the cleanup has never run on. */
async function openUncleaned(fixture: SpendingCategoryFixture): Promise<void> {
  await fixture.store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = ANY($1::text[])", [[CLEANUP, SPACE_RETURNED]]);
  await installFinancialStore(fixture.database);
}

async function kindAssertions(fixture: SpendingCategoryFixture, transactionId?: string): Promise<string[]> {
  return (await fixture.store.query<{ assertion: string }>(
    `SELECT encode(assertion_id, 'hex') AS assertion FROM assertions
      WHERE field_name = 'kind' AND ($1::bytea IS NULL OR transaction_id = $1) ORDER BY 1`,
    [transactionId === undefined ? null : idBytes(transactionId)],
  )).rows.map((row) => row.assertion);
}

async function historyRowCounts(fixture: SpendingCategoryFixture): Promise<Row> {
  return (await fixture.store.query<Row>(
    `SELECT ${HISTORY_TABLES.map((table) => `(SELECT count(*) FROM ${table}) AS ${table}`).join(", ")}`,
  )).rows[0]!;
}

/** Rows a foreign key into a history table would reject, which the cleanup's delete does not check row by row. */
async function danglingReferences(fixture: SpendingCategoryFixture): Promise<string[]> {
  const keys = (await fixture.store.query<{ referencing: string; referenced: string; columns: string[]; referenced_columns: string[] }>(
    `SELECT key.conrelid::regclass::text AS referencing, key.confrelid::regclass::text AS referenced,
            (SELECT array_agg(quote_ident(attribute.attname) ORDER BY position.ordinal)
               FROM unnest(key.conkey) WITH ORDINALITY position(number, ordinal)
               JOIN pg_attribute attribute ON attribute.attrelid = key.conrelid AND attribute.attnum = position.number) AS columns,
            (SELECT array_agg(quote_ident(attribute.attname) ORDER BY position.ordinal)
               FROM unnest(key.confkey) WITH ORDINALITY position(number, ordinal)
               JOIN pg_attribute attribute ON attribute.attrelid = key.confrelid AND attribute.attnum = position.number) AS referenced_columns
       FROM pg_constraint key
      WHERE key.contype = 'f' AND key.confrelid = ANY($1::regclass[])`,
    [HISTORY_TABLES],
  )).rows;
  assert.ok(keys.length > 0, "the store has foreign keys into the history tables");
  const dangling: string[] = [];
  for (const key of keys) {
    const count = Number((await fixture.store.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM ${key.referencing} referencing
        WHERE ${key.columns.map((column) => `referencing.${column} IS NOT NULL`).join(" AND ")}
          AND NOT EXISTS (
            SELECT 1 FROM ${key.referenced} referenced
             WHERE ${key.columns.map((column, index) => `referencing.${column} = referenced.${key.referenced_columns[index]}`).join(" AND ")})`,
    )).rows[0]!.n);
    if (count > 0) dangling.push(`${key.referencing}(${key.columns.join(", ")}) -> ${key.referenced}: ${count}`);
  }
  return dangling;
}

/** Enrichment transitions whose run holds no output for their transaction in their commit, which the transition insert trigger rejects. */
async function unsupportedTransitions(fixture: SpendingCategoryFixture, eventKind?: "withdrawn"): Promise<number> {
  return Number((await fixture.store.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM assertion_transitions transition
      WHERE transition.enrichment_run_id IS NOT NULL
        AND ($1::text IS NULL OR transition.event_kind = $1)
        AND NOT EXISTS (
          SELECT 1 FROM enrichment_run_outputs output
           WHERE output.run_id = transition.enrichment_run_id AND output.commit_id = transition.commit_id
             AND output.transaction_id IS NOT DISTINCT FROM transition.transaction_id AND output.field_name = transition.field_name)`,
    [eventKind ?? null],
  )).rows[0]!.n);
}

const silenceWarnings = (context: TestContext) => context.mock.method(console, "warn", () => undefined);

test("a Kind written again unchanged is removed once, and every Kind, its evidence and the knowledge point stay (ADR 0144)", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const deposit = { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" } as const;
    const fee = await fixture.addTransaction({ amount: "15", direction: "outflow", date: "2026-09-10", description: "手續費", account: "salary-account", accountStream: deposit });
    const card = await fixture.addTransaction({ amount: "320", date: "2026-09-11" });
    await installFinancialStore(fixture.database);
    for (let index = 0; index < 4; index += 1) for (const id of [fee, card]) await writeKind(fixture, id);

    const kindRows = async () => Number((await fixture.store.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM assertions WHERE field_name = 'kind' AND transaction_id = ANY($1::bytea[])", [[idBytes(fee), idBytes(card)]])).rows[0]!.n);
    const current = async () => (await fixture.store.query(
      `SELECT current.transaction_id, current.value_text, current.taxonomy_code, current.route_id, current.producer_version, current.projection_commit_id,
              (SELECT output.provenance_json::jsonb->>'evidenceKind'
                 FROM assertion_provenance provenance
                 JOIN enrichment_run_outputs output ON output.run_id = provenance.enrichment_run_id AND output.assertion_id = current.assertion_id
                WHERE provenance.assertion_id = current.assertion_id AND provenance.enrichment_run_id IS NOT NULL) AS evidence_kind
         FROM current_transaction_enrichment current ORDER BY current.transaction_id, current.field_name`,
    )).rows;
    assert.equal(await kindRows(), 10);
    const before = await current();
    const knowledge = await fixture.knowledgeAt();

    await openUncleaned(fixture);
    assert.equal(await kindRows(), 2, "one Kind assertion per transaction");
    assert.deepEqual(await current(), before);
    assert.equal(await fixture.knowledgeAt(), knowledge, "the cleanup writes no commit");

    for (const id of [fee, card]) await writeKind(fixture, id);
    await installFinancialStore(fixture.database);
    assert.equal(await kindRows(), 4, "a second open removes nothing");
  } finally {
    await fixture.close();
  }
});

for (const seed of [12345, 2026, 77, 4096])
  test(`a history of repeats, changes and withdrawals selects the same Kind and evidence at every commit after the cleanup (seed ${seed})`, async (context) => {
    const warnings = silenceWarnings(context);
    const { fixture, fee, card } = await kindFixture();
    try {
      let state = seed;
      const random = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const codes = (await fixture.store.query<{ code: string }>("SELECT code FROM taxonomy_codes WHERE dimension = 'kind' ORDER BY code LIMIT 3")).rows.map((row) => row.code);
      const steps: string[] = [];
      for (let step = 0; step < 28; step += 1) {
        const id = random() < 0.5 ? fee : card;
        const pick = random();
        if (pick < 0.5) await writeKind(fixture, id);
        else if (pick < 0.65) await writeKind(fixture, id, { value: codes[Math.floor(random() * codes.length)]!, supersede: true });
        else if (pick < 0.75) await writeKind(fixture, id, { evidenceKind: random() < 0.5 ? "bank-rule" : "direction", supersede: random() < 0.5 });
        else await writeUnsupported(fixture, id, pick < 0.87);
        steps.push(pick < 0.5 ? "repeat" : pick < 0.65 ? "change" : pick < 0.75 ? "evidence" : pick < 0.87 ? "withdraw" : "unsupported");
      }
      const trail = steps.join(",");
      await selectCurrentKinds(fixture);
      const history = await kindHistory(fixture);
      const knowledge = await knowledgePoint(fixture.store);
      const counts = await historyRowCounts(fixture);
      const unsupported = await unsupportedTransitions(fixture);
      assert.equal(await unsupportedTransitions(fixture, "withdrawn"), 0, "every withdrawal starts with its unsupported output");

      await openUncleaned(fixture);
      assert.equal(warnings.mock.callCount(), 0, `the cleanup ran: ${trail}`);
      const cleaned = await historyRowCounts(fixture);
      assert.ok(Number(cleaned.assertions) < Number(counts.assertions), `repeated assertions were removed: ${trail}`);
      assert.ok(Number(cleaned.enrichment_run_outputs) < Number(counts.enrichment_run_outputs), `their outputs were removed: ${trail}`);
      assert.deepEqual(await kindHistory(fixture), history, `every cutoff selects the same Kind and evidence: ${trail}`);
      assert.equal(await knowledgePoint(fixture.store), knowledge, "the cleanup writes no commit");
      await assertCurrentIsSelected(fixture, `each current row names the assertion the selection picks: ${trail}`);
      assert.deepEqual(await danglingReferences(fixture), [], `no row names a removed assertion: ${trail}`);
      assert.equal(await unsupportedTransitions(fixture), unsupported, `every transition keeps the output its run recorded: ${trail}`);
      assert.equal(await unsupportedTransitions(fixture, "withdrawn"), 0, `every withdrawal keeps its unsupported output: ${trail}`);
      assert.deepEqual(await recordedKeys(fixture), [CLEANUP, SPACE_RETURNED].sort());

      await openUncleaned(fixture);
      assert.deepEqual(await historyRowCounts(fixture), cleaned, `a second cleanup removes nothing: ${trail}`);
    } finally {
      await fixture.close();
    }
  });

test("a current Kind assertion with two outputs is kept, and does not stop the repeats after it being removed", async (context) => {
  const warnings = silenceWarnings(context);
  const { fixture, card } = await kindFixture();
  try {
    const twice = await addSecondOutput(fixture, card);
    const second = await writeKind(fixture, card);
    await writeKind(fixture, card);
    await selectCurrentKinds(fixture);
    const history = await kindHistory(fixture);

    await openUncleaned(fixture);
    assert.equal(warnings.mock.callCount(), 0, "the cleanup ran");
    assert.deepEqual(await kindAssertions(fixture, card), [twice, second].sort(), "the two-output assertion and the first after it stay");
    assert.deepEqual(await kindHistory(fixture), history);
    await assertCurrentIsSelected(fixture, "the current row names the assertion the selection picks");
  } finally {
    await fixture.close();
  }
});

test("a superseded-era Kind assertion with two outputs is kept, so past commits still select it", async (context) => {
  const warnings = silenceWarnings(context);
  const { fixture, card } = await kindFixture();
  try {
    const twice = await addSecondOutput(fixture, card);
    const second = await writeKind(fixture, card);
    const repeat = await writeKind(fixture, card);
    const last = await writeKind(fixture, card);
    const other = (await fixture.store.query<{ code: string }>(
      "SELECT code FROM taxonomy_codes WHERE dimension = 'kind' AND code <> (SELECT value_text FROM assertions WHERE assertion_id = $1) ORDER BY code LIMIT 1",
      [hexBytes(last)],
    )).rows[0]!.code;
    const changed = await writeKind(fixture, card, { value: other, supersede: true });
    await selectCurrentKinds(fixture);
    const history = await kindHistory(fixture);

    await openUncleaned(fixture);
    assert.equal(warnings.mock.callCount(), 0, "the cleanup ran");
    assert.deepEqual(await kindAssertions(fixture, card), [twice, second, last, changed].sort(), "only the plain repeat is removed");
    assert.ok(!(await kindAssertions(fixture, card)).includes(repeat));
    assert.deepEqual(await kindHistory(fixture), history, "every cutoff selects the same Kind");
  } finally {
    await fixture.close();
  }
});

test("a repeat a category names as its evidence stays, and the current row names it as the selection does", async (context) => {
  const warnings = silenceWarnings(context);
  const { fixture, fee } = await kindFixture();
  try {
    const first = (await kindAssertions(fixture, fee))[0]!;
    await writeKind(fixture, fee);
    const named = await writeKind(fixture, fee);
    await writeKind(fixture, fee);
    await writeKind(fixture, fee);
    const renamed = await fixture.store.query(
      `UPDATE enrichment_run_outputs SET provenance_json = jsonb_set(provenance_json::jsonb, '{evidenceAssertionId}', to_jsonb($2::text))::text
        WHERE transaction_id = $1 AND field_name = 'category' AND provenance_json::jsonb ? 'evidenceAssertionId'`,
      [idBytes(fee), named],
    );
    assert.equal(renamed.affectedRows, 1, "the fee's category names a Kind assertion as its evidence");
    const history = await kindHistory(fixture);

    await openUncleaned(fixture);
    assert.equal(warnings.mock.callCount(), 0, "the cleanup ran");
    assert.deepEqual(await kindAssertions(fixture, fee), [first, named].sort(), "the first and the named assertion stay");
    assert.equal((await currentKindAssertions(fixture)).get(hexOf(fee)), named, "the current row moves to the run's last kept assertion");
    await assertCurrentIsSelected(fixture, "the current row names the assertion the selection picks");
    assert.deepEqual(await kindHistory(fixture), history);
  } finally {
    await fixture.close();
  }
});

test("a category whose evidence assertion id is not an id does not stop the cleanup", async (context) => {
  const warnings = silenceWarnings(context);
  const { fixture, fee } = await kindFixture();
  try {
    const malformed = await fixture.store.query(
      `UPDATE enrichment_run_outputs SET provenance_json = jsonb_set(provenance_json::jsonb, '{evidenceAssertionId}', '"not-hex"')::text
        WHERE transaction_id = $1 AND field_name = 'category'`,
      [idBytes(fee)],
    );
    assert.equal(malformed.affectedRows, 1);
    await writeKind(fixture, fee);
    await writeKind(fixture, fee);

    await openUncleaned(fixture);
    assert.equal(warnings.mock.callCount(), 0, "the cleanup ran");
    assert.equal((await kindAssertions(fixture, fee)).length, 1, "the repeats are removed");
  } finally {
    await fixture.close();
  }
});

test("a Kind written again with another taxonomy code is not a repeat", async (context) => {
  const warnings = silenceWarnings(context);
  const { fixture, card } = await kindFixture();
  try {
    const first = (await kindAssertions(fixture, card))[0]!;
    const recoded = await writeKind(fixture, card);
    const other = (await fixture.store.query<{ code: string }>(
      "SELECT code FROM taxonomy_codes WHERE dimension = 'kind' AND code <> (SELECT taxonomy_code FROM enrichment_taxonomy_assertion_values WHERE assertion_id = $1) ORDER BY code LIMIT 1",
      [hexBytes(recoded)],
    )).rows[0]!.code;
    await fixture.store.query("UPDATE enrichment_taxonomy_assertion_values SET taxonomy_code = $2 WHERE assertion_id = $1", [hexBytes(recoded), other]);
    await writeKind(fixture, card);
    await selectCurrentKinds(fixture);
    const history = await kindHistory(fixture);

    await openUncleaned(fixture);
    assert.equal(warnings.mock.callCount(), 0, "the cleanup ran");
    assert.deepEqual(await kindAssertions(fixture, card), [first, recoded].sort(), "the recoded assertion stays and its own repeat goes");
    assert.deepEqual(await kindHistory(fixture), history, "every cutoff selects the same taxonomy code");
  } finally {
    await fixture.close();
  }
});

test("a cleanup that cannot finish removes nothing, lets the store open, and is not tried again", async (context) => {
  const warnings = silenceWarnings(context);
  const { fixture, fee } = await kindFixture();
  try {
    await writeKind(fixture, fee);
    const repeat = await writeKind(fixture, fee);
    // The fee's current category row names a Kind repeat: the cleanup must refuse to delete under it.
    const category = (await fixture.store.query<{ assertion_id: Uint8Array }>(
      "SELECT assertion_id FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'category'",
      [idBytes(fee)],
    )).rows;
    assert.equal(category.length, 1, "the fee has a current category");
    const nameFromCategory = (assertion: Uint8Array) => fixture.store.query(
      "UPDATE current_transaction_enrichment SET assertion_id = $2 WHERE transaction_id = $1 AND field_name = 'category'",
      [idBytes(fee), assertion],
    );
    await nameFromCategory(hexBytes(repeat));
    const counts = await historyRowCounts(fixture);
    const current = await currentKindAssertions(fixture);

    await openUncleaned(fixture);
    assert.equal(warnings.mock.callCount(), 1, "the failure is logged");
    assert.match(String(warnings.mock.calls[0]!.arguments[1]), /would remove an assertion current_transaction_enrichment names/);
    assert.deepEqual(await historyRowCounts(fixture), counts, "nothing is removed");
    assert.deepEqual(await currentKindAssertions(fixture), current, "the current rows are not moved");
    assert.deepEqual(await recordedKeys(fixture), [CLEANUP, SPACE_RETURNED].sort(), "both keys are recorded");
    assert.deepEqual((await fixture.store.query("SHOW session_replication_role")).rows, [{ session_replication_role: "origin" }]);

    await nameFromCategory(category[0]!.assertion_id);
    await installFinancialStore(fixture.database);
    assert.deepEqual(await historyRowCounts(fixture), counts, "a later open does not try again");
    assert.equal(warnings.mock.callCount(), 1);
  } finally {
    await fixture.close();
  }
});

test("a table rewrite that fails leaves the repeats removed, lets the store open, and runs again on the next open", async (context) => {
  const warnings = silenceWarnings(context);
  const { fixture, card } = await kindFixture();
  try {
    await writeKind(fixture, card);
    await writeKind(fixture, card);
    const statements: string[] = [];
    const database = fixture.database;
    const query = database.query.bind(database) as (...parameters: unknown[]) => Promise<unknown>;
    let diskFull = true;
    context.mock.method(database, "query", (...parameters: unknown[]) => {
      const statement = String(parameters[0]);
      if (statement.startsWith("VACUUM")) {
        statements.push(statement);
        if (diskFull) return Promise.reject(new Error("could not extend file: No space left on device"));
      }
      return query(...parameters);
    });

    await openUncleaned(fixture);
    assert.equal(warnings.mock.callCount(), 1, "the failure is logged");
    assert.equal((await kindAssertions(fixture, card)).length, 1, "the repeats are already removed");
    assert.deepEqual(await recordedKeys(fixture), [CLEANUP], "the space is not recorded as returned");

    diskFull = false;
    statements.length = 0;
    await installFinancialStore(fixture.database);
    assert.deepEqual(statements.sort(), HISTORY_TABLES.map((table) => `VACUUM (FULL, ANALYZE) ${table}`).sort(), "the next open rewrites every history table");
    assert.deepEqual(await recordedKeys(fixture), [CLEANUP, SPACE_RETURNED].sort());
    assert.equal((await kindAssertions(fixture, card)).length, 1);

    statements.length = 0;
    await installFinancialStore(fixture.database);
    assert.deepEqual(statements, [], "a recorded rewrite does not run again");
  } finally {
    await fixture.close();
  }
});
