import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_SERVICE_CHANNELS,
  automationForwardHandlers,
  financialForwardHandlers,
  RENDERER_FINANCIAL_OPERATIONS,
  SETTINGS_SERVICE_CHANNELS,
  settingsForwardHandlers,
  type AutomationServiceForwards,
  type SettingsServiceForwards,
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

function recordingService<Service>() {
  const calls: Array<[string, readonly unknown[]]> = [];
  const service = new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => {
      calls.push([method, args]);
      return { answered: method };
    },
  }) as Service;
  return { service, calls };
}

async function assertForwards(
  handlers: object,
  table: Readonly<Record<string, string>>,
  calls: Array<[string, readonly unknown[]]>,
) {
  assert.deepEqual(Object.keys(handlers).sort(), Object.keys(table).sort());
  for (const [channel, method] of Object.entries(table)) {
    const handler = (handlers as Record<string, (event: unknown, ...args: unknown[]) => unknown>)[channel]!;
    assert.deepEqual(await handler({ sender: "renderer" }, "task-1", "run-1"), { answered: method });
    assert.deepEqual(calls.at(-1), [method, ["task-1", "run-1"]]);
  }
}

test("each automation service channel calls its bridge method's namesake with the renderer's arguments", async () => {
  const { service, calls } = recordingService<AutomationServiceForwards>();
  const handlers = automationForwardHandlers(service);

  assert.equal(Object.hasOwn(handlers, "automation:selectCertificateFile"), false);
  await assertForwards(handlers, AUTOMATION_SERVICE_CHANNELS, calls);
});

test("each settings service channel calls its bridge method's namesake with the renderer's arguments", async () => {
  const { service, calls } = recordingService<SettingsServiceForwards>();
  const handlers = settingsForwardHandlers(service);

  assert.equal(Object.hasOwn(handlers, "settings:clearSignInData"), false, "sign-in erasure stays with automation");
  await assertForwards(handlers, SETTINGS_SERVICE_CHANNELS, calls);
});
