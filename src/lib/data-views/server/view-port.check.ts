import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import { createSharedLiveViews } from "./shared-live-views.ts";
import { createViewPortServer, createViewPortClient } from "./view-port.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for view port");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const db = await PGlite.create({ extensions: { live } });
const channel = new MessageChannel();
try {
  await db.exec("CREATE TABLE monthly_totals (month text PRIMARY KEY, amount integer NOT NULL)");
  await db.query("INSERT INTO monthly_totals (month, amount) VALUES ($1, $2)", ["2026-09", 10]);
  const views = createSharedLiveViews(db, {
    "spending.summary": (params: { month: string }) => ({
      sql: "SELECT month, amount FROM monthly_totals WHERE month = $1",
      args: [params.month],
    }),
  });
  const server = createViewPortServer(channel.port1, views);
  const client = createViewPortClient(channel.port2);
  const received: number[] = [];
  const stop = await client.subscribe<{ amount: number }>(
    "spending.summary", { month: "2026-09" },
    (rows) => received.push(rows[0]?.amount ?? -1),
  );
  await waitFor(() => received.at(-1) === 10);
  await db.query("UPDATE monthly_totals SET amount = $1 WHERE month = $2", [20, "2026-09"]);
  await waitFor(() => received.at(-1) === 20);
  await stop();
  await db.query("UPDATE monthly_totals SET amount = $1 WHERE month = $2", [30, "2026-09"]);
  assert.equal(received.at(-1), 20);
  await client.close();
  await server.close();
} finally {
  channel.port1.close();
  channel.port2.close();
  await db.close();
}
