import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_SERVICE_CHANNELS,
  automationForwardHandlers,
  financialForwardHandlers,
  RENDERER_FINANCIAL_OPERATIONS,
  type AutomationServiceForwards,
} from "./ipc-channels.ts";
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

test("each automation service channel calls its bridge method's namesake with the renderer's arguments", async () => {
  const calls: Array<[string, readonly unknown[]]> = [];
  const service = new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => {
      calls.push([method, args]);
      return { answered: method };
    },
  }) as AutomationServiceForwards;
  const handlers = automationForwardHandlers(service);

  assert.deepEqual(Object.keys(handlers).sort(), Object.keys(AUTOMATION_SERVICE_CHANNELS).sort());
  assert.equal(Object.hasOwn(handlers, "automation:selectCertificateFile"), false);
  for (const [channel, method] of Object.entries(AUTOMATION_SERVICE_CHANNELS)) {
    const handler = handlers[channel as keyof typeof handlers] as (event: unknown, ...args: unknown[]) => unknown;
    assert.deepEqual(await handler({ sender: "renderer" }, "task-1", "run-1"), { answered: method });
    assert.deepEqual(calls.at(-1), [method, ["task-1", "run-1"]]);
  }
});
