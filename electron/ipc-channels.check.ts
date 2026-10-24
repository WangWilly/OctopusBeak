import assert from "node:assert/strict";
import test from "node:test";
import { financialForwardHandlers, RENDERER_FINANCIAL_OPERATIONS } from "./ipc-channels.ts";
import { PGLITE_FINANCIAL_CONTRACTS, type PGliteFinancialPort } from "./pglite-financial-rpc-client.ts";

test("the renderer can reach no canonical write", () => {
  for (const operation of RENDERER_FINANCIAL_OPERATIONS) {
    assert.equal(
      (PGLITE_FINANCIAL_CONTRACTS[operation] as { canonicalCommit?: true }).canonicalCommit,
      undefined,
      `${operation} must not be callable from the renderer`,
    );
  }
});

test("each forwarded channel requests its own operation with the renderer's arguments", async () => {
  const calls: Array<[string, readonly unknown[]]> = [];
  const port = {
    async request(operation: string, args: readonly unknown[]) {
      calls.push([operation, args]);
      return { answered: operation };
    },
  } as unknown as PGliteFinancialPort;
  const handlers = financialForwardHandlers(port);

  assert.deepEqual(Object.keys(handlers).sort(), [...RENDERER_FINANCIAL_OPERATIONS].sort());
  for (const operation of RENDERER_FINANCIAL_OPERATIONS) {
    const handler = handlers[operation] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    assert.deepEqual(await handler({}, { knowledgeAt: 7 }), { answered: operation });
    assert.deepEqual(calls.at(-1), [operation, [{ knowledgeAt: 7 }]]);
  }
});
