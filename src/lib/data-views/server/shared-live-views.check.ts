import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import { createSharedLiveViews } from "./shared-live-views.ts";

type Total = { month: string; amount: number };

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for live view");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const db = await PGlite.create({ extensions: { live } });
try {
  await db.exec("CREATE TABLE monthly_totals (month text PRIMARY KEY, amount integer NOT NULL)");
  await db.query("INSERT INTO monthly_totals (month, amount) VALUES ($1, $2)", ["2026-09", 10]);

  const views = createSharedLiveViews(db, {
    "spending.summary": (params: { month: string }) => ({
      sql: "SELECT month, amount FROM monthly_totals WHERE month = $1",
      args: [params.month],
    }),
  });
  const first: Total[][] = [];
  const second: Total[][] = [];
  const stopFirst = await views.subscribe("spending.summary", { month: "2026-09" }, (rows: Total[]) => first.push(rows));
  const stopSecond = await views.subscribe("spending.summary", { month: "2026-09" }, (rows: Total[]) => second.push(rows));

  await waitFor(() => first.at(-1)?.[0]?.amount === 10 && second.at(-1)?.[0]?.amount === 10);
  await db.query("UPDATE monthly_totals SET amount = $1 WHERE month = $2", [20, "2026-09"]);
  await waitFor(() => first.at(-1)?.[0]?.amount === 20 && second.at(-1)?.[0]?.amount === 20);

  await stopFirst();
  await db.query("UPDATE monthly_totals SET amount = $1 WHERE month = $2", [30, "2026-09"]);
  await waitFor(() => second.at(-1)?.[0]?.amount === 30);
  assert.equal(first.at(-1)?.[0]?.amount, 20);

  await stopSecond();
  await db.query("UPDATE monthly_totals SET amount = $1 WHERE month = $2", [40, "2026-09"]);
  assert.equal(second.at(-1)?.[0]?.amount, 30);
} finally {
  await db.close();
}
