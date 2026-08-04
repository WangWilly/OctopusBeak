import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
  AppleSystemModelProtocolError,
  createAppleSystemModelProvider,
  createAppleSystemModelProtocolClient,
  createUnsupportedAppleSystemModelProvider,
  spawnEmbeddedAppleSystemModelHelper,
  type EmbeddedHelperProcess,
} from "./apple-system-model-provider.ts";
import { createNoToolAgentGateway } from "./harness.ts";

test("a silent live helper fails a started run at its bounded first-response deadline", async () => {
  let listener: ((line: string) => void) | null = null;
  let terminated = false;
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() { return () => {}; },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId: string };
      if (request.type === "activate") queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() { terminated = true; },
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "first-response-deadline",
    runFirstResponseTimeoutMs: 10,
    runIdleTimeoutMs: 10,
  });

  await client.activate();
  const failure = await Promise.race([
    new Promise<Error>((resolve) => {
      client.start({ runId: "silent-run", prompt: "Wait.", onStream() {}, onComplete() {}, onFailure: resolve });
    }),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("run deadline did not fire")),
      100,
    )),
  ]);
  assert.match(failure.message, /first response timed out/);
  assert.equal(terminated, true);
});

test("per-run deadlines reject nonpositive and nonfinite values", () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createAppleSystemModelProtocolClient({
      launchProcess: () => { throw new Error("must not launch"); },
      requestIdFactory: () => "invalid-run-deadline",
      runFirstResponseTimeoutMs: timeoutMs,
    }), /run first-response timeout must be positive/);
  }
});

test("embedded Apple helper negotiates a versioned handshake before activation", async () => {
  const sent: string[] = [];
  let listener: ((line: string) => void) | null = null;
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {
        listener = null;
      };
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      sent.push(line);
      const request = JSON.parse(line) as { requestId: string };
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-1",
  });

  assert.deepEqual(await client.activate(), {
    availability: "available",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
  });
  assert.deepEqual(sent.map((line) => JSON.parse(line)), [{
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "activate",
    requestId: "activation-1",
  }]);
});

test("concurrent first activations share the handshake and correlate reversed responses", async () => {
  let listener: ((line: string) => void) | null = null;
  const requests: Array<{ requestId: string }> = [];
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId: string };
      if (request.type !== "activate") return;
      requests.push(request);
      if (requests.length !== 2) return;
      for (const request of requests.toReversed()) {
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: request.requestId,
          availability: request.requestId === "activation-1" ? "unavailable" : "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        })));
      }
    },
    terminate() {},
  };
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => `activation-${++requestSequence}`,
  });

  const activations = await Promise.race([
    Promise.all([client.activate(), client.activate()]),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("timed out waiting for concurrent first activations")),
      100,
    )),
  ]);

  assert.deepEqual(activations.map(({ availability }) => availability), [
    "unavailable",
    "available",
  ]);
  assert.doesNotThrow(() => client.start({
    runId: "latest-concurrent-activation-run",
    prompt: "Use the latest activation.",
    onStream() {},
    onComplete() {},
    onFailure() {},
  }));
  client.cancel("latest-concurrent-activation-run");
});

test("an invalid activation response rejects only its correlated waiter", async () => {
  let listener: ((line: string) => void) | null = null;
  const requestIds: string[] = [];
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId: string };
      if (request.type !== "activate") return;
      requestIds.push(request.requestId);
      if (requestIds.length !== 2) return;
      queueMicrotask(() => {
        listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: requestIds[1],
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        }));
        listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: requestIds[0],
          availability: "invalid",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        }));
      });
    },
    terminate() {},
  };
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => `isolated-activation-${++requestSequence}`,
  });

  const results = await Promise.race([
    Promise.allSettled([client.activate(), client.activate()]),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("timed out waiting for isolated activation responses")),
      100,
    )),
  ]);

  assert.equal(results[0].status, "rejected");
  assert.match((results[0] as PromiseRejectedResult).reason.message, /response was invalid/);
  assert.equal(results[1].status, "fulfilled");
  assert.equal(
    (results[1] as PromiseFulfilledResult<{ availability: string }>).value.availability,
    "available",
  );
});

for (const [field, invalidValue] of [
  ["providerIdentity", ""],
  ["osBuild", " \t "],
] as const) {
  test(`an activation response rejects a blank ${field} before granting authority`, async () => {
    let listener: ((line: string) => void) | null = null;
    const process: EmbeddedHelperProcess = {
      onLine(nextListener) {
        listener = nextListener;
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "handshake",
          helperVersion: "1",
        })));
        return () => {};
      },
      onExit() {
        return () => {};
      },
      writeLine(line) {
        const request = JSON.parse(line) as { requestId: string };
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: request.requestId,
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
          [field]: invalidValue,
        })));
      },
      terminate() {},
    };
    const client = createAppleSystemModelProtocolClient({
      launchProcess: () => process,
      requestIdFactory: () => `blank-${field}`,
    });

    await assert.rejects(client.activate(), /activation response was invalid/);
    assert.throws(() => client.start({
      runId: `blank-${field}-run`,
      prompt: "Must not start.",
      onStream() {},
      onComplete() {},
      onFailure() {},
    }), /not activated/);
  });
}

for (const [label, malformedFields] of [
  ["non-string activation reason", { reason: 42 }],
  ["extraneous activation payload", { extraPayload: "unexpected" }],
] as const) {
  test(`the protocol rejects a ${label}`, async () => {
    let listener: ((line: string) => void) | null = null;
    let terminated = false;
    const process: EmbeddedHelperProcess = {
      onLine(nextListener) {
        listener = nextListener;
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "handshake",
          helperVersion: "1",
        })));
        return () => {};
      },
      onExit() {
        return () => {};
      },
      writeLine(line) {
        const request = JSON.parse(line) as { requestId: string };
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: request.requestId,
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
          ...malformedFields,
        })));
      },
      terminate() {
        terminated = true;
      },
    };
    const client = createAppleSystemModelProtocolClient({
      launchProcess: () => process,
      requestIdFactory: () => `malformed-${label}`,
    });

    await assert.rejects(client.activate(), /activation response was invalid/);
    assert.equal(terminated, true);
  });
}

for (const [label, malformedFrame] of [
  ["stream reason", {
    type: "stream",
    content: "partial",
    reason: "must not appear",
  }],
  ["complete content", {
    type: "complete",
    content: "must not appear",
  }],
  ["complete reason", {
    type: "complete",
    reason: "must not appear",
  }],
] as const) {
  test(`the protocol rejects an extraneous ${label} field`, async () => {
    let listener: ((line: string) => void) | null = null;
    let terminated = false;
    const process: EmbeddedHelperProcess = {
      onLine(nextListener) {
        listener = nextListener;
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "handshake",
          helperVersion: "1",
        })));
        return () => {};
      },
      onExit() {
        return () => {};
      },
      writeLine(line) {
        const request = JSON.parse(line) as { type: string; requestId?: string; runId?: string };
        if (request.type === "activate") {
          queueMicrotask(() => listener?.(JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            type: "activation",
            requestId: request.requestId,
            availability: "available",
            providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
            osBuild: "25C56",
          })));
          return;
        }
        if (request.type === "start") {
          queueMicrotask(() => listener?.(JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            runId: request.runId,
            ...malformedFrame,
          })));
        }
      },
      terminate() {
        terminated = true;
      },
    };
    const client = createAppleSystemModelProtocolClient({
      launchProcess: () => process,
      requestIdFactory: () => `malformed-run-${label}`,
    });
    await client.activate();
    const failure = new Promise<Error>((resolve) => {
      client.start({
        runId: `malformed-run-${label}`,
        prompt: "Must fail closed.",
        onStream() {},
        onComplete() {
          assert.fail("malformed completion must not complete the run");
        },
        onFailure: resolve,
      });
    });

    assert.match((await failure).message, /run response was invalid/);
    assert.equal(terminated, true);
  });
}

test("the protocol rejects an extraneous handshake field", async () => {
  let terminated = false;
  const process: EmbeddedHelperProcess = {
    onLine(listener) {
      queueMicrotask(() => listener(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
        extraPayload: "unexpected",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {},
    terminate() {
      terminated = true;
    },
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "malformed-handshake",
  });

  await assert.rejects(client.activate(), /protocol handshake failed/);
  assert.equal(terminated, true);
});

test("a live silent helper times out the shared handshake and a later activation retries cleanly", async () => {
  let launchCount = 0;
  let firstTerminated = false;
  let recoveredListener: ((line: string) => void) | null = null;
  const silentProcess: EmbeddedHelperProcess = {
    onLine() {
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {
      throw new Error("activation must not be written before handshake");
    },
    terminate() {
      firstTerminated = true;
    },
  };
  const recoveredProcess: EmbeddedHelperProcess = {
    onLine(listener) {
      recoveredListener = listener;
      queueMicrotask(() => recoveredListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { requestId: string };
      queueMicrotask(() => recoveredListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => ++launchCount === 1 ? silentProcess : recoveredProcess,
    requestIdFactory: () => `handshake-timeout-${++requestSequence}`,
    handshakeTimeoutMs: 10,
    activationTimeoutMs: 10,
  });

  const firstResults = await Promise.race([
    Promise.allSettled([client.activate(), client.activate()]),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("test timed out waiting for handshake deadline")),
      100,
    )),
  ]);
  assert.deepEqual(firstResults.map(({ status }) => status), ["rejected", "rejected"]);
  for (const result of firstResults) {
    assert.match((result as PromiseRejectedResult).reason.message, /handshake timed out/);
  }
  assert.equal(firstTerminated, true);
  assert.equal(launchCount, 1);
  assert.equal((await client.activate({ userStartedNewRun: true })).availability, "available");
  assert.equal(launchCount, 2);
});

test("a post-handshake silent activation times out all waiters and retries on a new helper", async () => {
  let launchCount = 0;
  let firstTerminated = false;
  let firstListener: ((line: string) => void) | null = null;
  let recoveredListener: ((line: string) => void) | null = null;
  const silentActivationProcess: EmbeddedHelperProcess = {
    onLine(listener) {
      firstListener = listener;
      queueMicrotask(() => firstListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {},
    terminate() {
      firstTerminated = true;
    },
  };
  const recoveredProcess: EmbeddedHelperProcess = {
    onLine(listener) {
      recoveredListener = listener;
      queueMicrotask(() => recoveredListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { requestId: string };
      queueMicrotask(() => recoveredListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => ++launchCount === 1 ? silentActivationProcess : recoveredProcess,
    requestIdFactory: () => `activation-timeout-${++requestSequence}`,
    handshakeTimeoutMs: 10,
    activationTimeoutMs: 10,
  });

  const firstResults = await Promise.race([
    Promise.allSettled([client.activate(), client.activate()]),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("test timed out waiting for activation deadline")),
      100,
    )),
  ]);
  assert.deepEqual(firstResults.map(({ status }) => status), ["rejected", "rejected"]);
  for (const result of firstResults) {
    assert.match((result as PromiseRejectedResult).reason.message, /activation timed out/);
  }
  assert.equal(firstTerminated, true);
  assert.equal(launchCount, 1);
  assert.equal((await client.activate({ userStartedNewRun: true })).availability, "available");
  assert.equal(launchCount, 2);
});

test("an unknown activation request ID fails remaining waiters and terminates the transport", async () => {
  let listener: ((line: string) => void) | null = null;
  let terminated = false;
  const requestIds: string[] = [];
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId: string };
      if (request.type !== "activate") return;
      requestIds.push(request.requestId);
      if (requestIds.length !== 2) return;
      queueMicrotask(() => {
        listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: requestIds[1],
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        }));
        listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: "unknown-activation-request",
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        }));
      });
    },
    terminate() {
      terminated = true;
    },
  };
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => `known-activation-${++requestSequence}`,
  });

  const results = await Promise.race([
    Promise.allSettled([client.activate(), client.activate()]),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("timed out waiting for unmatched activation failure")),
      100,
    )),
  ]);

  assert.equal(results[0].status, "rejected");
  assert.match(
    (results[0] as PromiseRejectedResult).reason.message,
    /activation response was not correlated/,
  );
  assert.equal(results[1].status, "rejected");
  assert.match(
    (results[1] as PromiseRejectedResult).reason.message,
    /activation response was not correlated/,
  );
  assert.equal(terminated, true);
});

test("an activation response without a request ID fails closed instead of hanging", async () => {
  let listener: ((line: string) => void) | null = null;
  let terminated = false;
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string };
      if (request.type !== "activate") return;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {
      terminated = true;
    },
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-missing-response-id",
  });

  await assert.rejects(
    Promise.race([
      client.activate(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for missing activation request ID")),
        100,
      )),
    ]),
    /activation response was invalid/,
  );
  assert.equal(terminated, true);
});

test("an unmatched activation with an extraneous run ID fails exact-shape validation", async () => {
  let listener: ((line: string) => void) | null = null;
  let terminated = false;
  const requestIds: string[] = [];
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId: string };
      if (request.type !== "activate") return;
      requestIds.push(request.requestId);
      if (requestIds.length !== 2) return;
      queueMicrotask(() => {
        listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: requestIds[1],
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        }));
        listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: "unmatched-activation-with-run-id",
          runId: "extraneous-run-id",
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        }));
      });
    },
    terminate() {
      terminated = true;
    },
  };
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => `extraneous-run-activation-${++requestSequence}`,
  });

  const results = await Promise.race([
    Promise.allSettled([client.activate(), client.activate()]),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("timed out waiting for extraneous run ID failure")),
      100,
    )),
  ]);

  assert.equal(results[0].status, "rejected");
  assert.match(
    (results[0] as PromiseRejectedResult).reason.message,
    /activation response was invalid/,
  );
  assert.equal(results[1].status, "rejected");
  assert.match(
    (results[1] as PromiseRejectedResult).reason.message,
    /activation response was invalid/,
  );
  assert.equal(terminated, true);
});

test("a pre-handshake run frame fails the handshake instead of hanging", async () => {
  let terminated = false;
  const process: EmbeddedHelperProcess = {
    onLine(listener) {
      queueMicrotask(() => listener(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "stream",
        runId: "unexpected-pre-handshake-run",
        content: "must not be discarded",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {},
    terminate() {
      terminated = true;
    },
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-after-invalid-first-frame",
  });

  await assert.rejects(
    Promise.race([
      client.activate(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for invalid first frame")),
        100,
      )),
    ]),
    /protocol handshake failed/,
  );
  assert.equal(terminated, true);
});

test("a second frame in the synchronous handshake burst fails the transport", async () => {
  let terminated = false;
  const process: EmbeddedHelperProcess = {
    onLine(listener) {
      listener(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      }));
      listener(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "stream",
        runId: "same-burst-pre-handshake-run",
        content: "must fail the transport",
      }));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {},
    terminate() {
      terminated = true;
    },
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-after-same-burst-frame",
  });

  await assert.rejects(
    Promise.race([
      client.activate(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for same-burst protocol failure")),
        100,
      )),
    ]),
    /additional message before handshake completed/,
  );
  assert.equal(terminated, true);
});

test("handshake settlement rejects a same-burst failure and replacement handshakes cleanly", async () => {
  const listeners: Array<(line: string) => void> = [];
  let launchCount = 0;
  let replacementHandshaken = false;
  const processes: EmbeddedHelperProcess[] = [0, 1].map((index) => ({
    onLine(listener) {
      listeners[index] = listener;
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      if (index === 0) return;
      assert.equal(replacementHandshaken, true);
      const request = JSON.parse(line) as { requestId: string };
      queueMicrotask(() => listeners[1](JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  }));
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => processes[launchCount++],
    requestIdFactory: () => `epoch-handshake-${++requestSequence}`,
  });

  const failedActivation = client.activate();
  listeners[0](JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "handshake",
    helperVersion: "1",
  }));
  listeners[0](JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "stream",
    runId: "same-burst-after-resolved-handshake",
    content: "must invalidate the resolved handshake",
  }));

  await assert.rejects(
    Promise.race([
      failedActivation,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for failed handshake settlement")),
        100,
      )),
    ]),
    /additional message before handshake completed/,
  );
  assert.equal(launchCount, 1);

  const recoveredActivation = client.activate({ userStartedNewRun: true });
  replacementHandshaken = true;
  listeners[1](JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "handshake",
    helperVersion: "1",
  }));
  assert.equal((await recoveredActivation).availability, "available");
  assert.equal(launchCount, 2);
});

test("a helper exit after its handshake cannot replace transport until the user starts a new run", async () => {
  let launchCount = 0;
  let firstListener: ((line: string) => void) | null = null;
  let firstExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  let replacementListener: ((line: string) => void) | null = null;
  const exitedAfterHandshake: EmbeddedHelperProcess = {
    onLine(listener) {
      firstListener = listener;
      return () => {};
    },
    onExit(listener) {
      firstExit = listener;
      return () => {};
    },
    writeLine() {
      assert.fail("an ordinary activation must not write to a replacement helper");
    },
    terminate() {},
  };
  const replacement: EmbeddedHelperProcess = {
    onLine(listener) {
      replacementListener = listener;
      queueMicrotask(() => replacementListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() { return () => {}; },
    writeLine(line) {
      const request = JSON.parse(line) as { requestId: string };
      queueMicrotask(() => replacementListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => ++launchCount === 1 ? exitedAfterHandshake : replacement,
    requestIdFactory: () => `post-handshake-exit-${launchCount}`,
  });

  const ordinaryActivation = client.activate();
  firstListener?.(JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "handshake",
    helperVersion: "1",
  }));
  firstExit?.(1, null);
  await assert.rejects(ordinaryActivation, /replacement requires starting a new run|helper exited/);
  assert.equal(launchCount, 1);
  assert.deepEqual(await client.activate({ userStartedNewRun: true }), {
    availability: "available",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
  });
  assert.equal(launchCount, 2);
});

test("activation settlement rejects when a same-burst frame kills its transport", async () => {
  let listener: ((line: string) => void) | null = null;
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { requestId: string };
      listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      }));
      listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "unexpected-after-activation",
      }));
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "same-burst-activation-settlement",
  });

  await assert.rejects(
    client.activate(),
    /activation response was not correlated/,
  );
  assert.throws(
    () => client.start({
      runId: "dead-transport-run",
      prompt: "must not run",
      onStream() {},
      onComplete() {},
      onFailure() {},
    }),
    /not activated/,
  );
});

test("late stdout from a failed helper cannot poison a replacement handshake", async () => {
  const listeners: Array<(line: string) => void> = [];
  let launchCount = 0;
  const firstProcess: EmbeddedHelperProcess = {
    onLine(listener) {
      listeners.push(listener);
      queueMicrotask(() => listener(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {
      queueMicrotask(() => listeners[0](JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  const secondProcess: EmbeddedHelperProcess = {
    onLine(listener) {
      listeners.push(listener);
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { requestId: string };
      queueMicrotask(() => listeners[1](JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  let requestSequence = 0;
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => (++launchCount === 1 ? firstProcess : secondProcess),
    requestIdFactory: () => `replacement-activation-${++requestSequence}`,
  });

  await assert.rejects(
    client.activate(),
    /activation response was invalid/,
  );

  const replacementActivation = client.activate({ userStartedNewRun: true });
  listeners[0](JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "stream",
    runId: "late-old-helper-run",
    content: "must be ignored",
  }));
  queueMicrotask(() => listeners[1](JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "handshake",
    helperVersion: "1",
  })));

  assert.deepEqual(await replacementActivation, {
    availability: "available",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
  });
  assert.equal(launchCount, 2);
});

test("embedded Apple helper fails closed when the process exits before handshake", async () => {
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  const process: EmbeddedHelperProcess = {
    onLine() {
      return () => {};
    },
    onExit(nextListener) {
      exitListener = nextListener;
      queueMicrotask(() => exitListener?.(78, null));
      return () => {
        exitListener = null;
      };
    },
    writeLine() {},
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-never-sent",
  });

  await assert.rejects(
    Promise.race([
      client.activate(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for helper exit handling")),
        50,
      )),
    ]),
    /Apple system model helper exited before handshake \(code=78 signal=none\)\./,
  );
});

test("embedded Apple helper reports a neutral exit after handshake", async () => {
  let lineListener: ((line: string) => void) | null = null;
  const exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      lineListener = nextListener;
      queueMicrotask(() => lineListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit(nextListener) {
      exitListeners.push(nextListener);
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId: string };
      if (request.type === "activate") queueMicrotask(() => lineListener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-before-exit",
  });

  await client.activate();
  const failure = new Promise<Error>((resolve) => {
    client.start({
      runId: "exit-after-handshake",
      prompt: "Hello",
      onStream() {},
      onComplete() {},
      onFailure: resolve,
    });
  });
  exitListeners[0]?.(1, null);

  const error = await failure;
  assert.equal(
    error.message,
    "Apple system model helper exited (code=1 signal=none).",
  );
  assert.doesNotMatch(error.message, /before handshake/);
});

test("a throwing run failure callback cannot interrupt transport teardown or a later replacement", async () => {
  const listeners: Array<(line: string) => void> = [];
  let launchCount = 0;
  let firstProcessTerminated = false;
  const receivedFailures: Error[] = [];
  const lateOutput: string[] = [];
  const firstProcess: EmbeddedHelperProcess = {
    onLine(listener) {
      listeners.push(listener);
      queueMicrotask(() => listener(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId?: string };
      if (request.type === "activate") queueMicrotask(() => listeners[0](JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {
      firstProcessTerminated = true;
    },
  };
  const replacementProcess: EmbeddedHelperProcess = {
    onLine(listener) {
      listeners.push(listener);
      queueMicrotask(() => listener(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId?: string };
      if (request.type === "activate") queueMicrotask(() => listeners[1](JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => (++launchCount === 1 ? firstProcess : replacementProcess),
    requestIdFactory: () => `failure-callback-${launchCount}`,
  });

  await client.activate();
  client.start({
    runId: "throwing-failure-run",
    prompt: "Fail safely.",
    onStream: (content) => lateOutput.push(content),
    onComplete() {
      assert.fail("failed run must not complete");
    },
    onFailure() {
      throw new Error("downstream failure callback threw");
    },
  });
  client.start({
    runId: "notified-failure-run",
    prompt: "Receive the transport failure.",
    onStream: (content) => lateOutput.push(content),
    onComplete() {
      assert.fail("failed run must not complete");
    },
    onFailure: (error) => receivedFailures.push(error),
  });

  listeners[0](JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "complete",
    runId: "notified-failure-run",
    content: "invalid extra field",
  }));

  assert.equal(firstProcessTerminated, true);
  assert.equal(receivedFailures.length, 1);
  assert.match(receivedFailures[0].message, /run response was invalid/);

  listeners[0](JSON.stringify({
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "stream",
    runId: "notified-failure-run",
    content: "late output",
  }));
  assert.deepEqual(lateOutput, []);

  assert.deepEqual(await client.activate({ userStartedNewRun: true }), {
    availability: "available",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "25C56",
  });
  assert.doesNotThrow(() => client.start({
    runId: "replacement-run",
    prompt: "Start cleanly.",
    onStream() {},
    onComplete() {},
    onFailure() {},
  }));
});

test("production embedded helper spawn failure rejects activation without crashing the host", async () => {
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => spawnEmbeddedAppleSystemModelHelper({
      executablePath: "/definitely-missing/apple-system-model-helper",
    }),
    requestIdFactory: () => "activation-missing-helper",
  });

  await assert.rejects(
    Promise.race([
      client.activate(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for helper spawn failure")),
        500,
      )),
    ]),
    /Apple system model helper exited/,
  );
});

test("production embedded helper stdin failure rejects activation while the child remains alive", async () => {
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => spawnEmbeddedAppleSystemModelHelper({
      executablePath: process.execPath,
      arguments: [
        "--input-type=module",
        "-e",
        `import { closeSync } from "node:fs"; closeSync(0); process.stdout.write(${JSON.stringify(`${JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "handshake",
          helperVersion: "1",
        })}\n`)}); setTimeout(() => {}, 1000);`,
      ],
    }),
    requestIdFactory: () => "activation-closed-stdin",
  });

  await assert.rejects(
    Promise.race([
      client.activate(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for helper stdin failure")),
        200,
      )),
    ]),
    /Apple system model helper exited/,
  );
});

test("embedded Apple helper reports a typed incompatibility for a protocol mismatch", async () => {
  const process: EmbeddedHelperProcess = {
    onLine(listener) {
      queueMicrotask(() => listener(JSON.stringify({
        protocolVersion: "apple-system-model/v0",
        type: "handshake",
        helperVersion: "0",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {},
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-mismatch",
  });

  await assert.rejects(
    () => client.activate(),
    (error: unknown) => {
      assert.ok(error instanceof AppleSystemModelProtocolError);
      assert.equal(error.code, "incompatible-protocol");
      return true;
    },
  );
});

test("embedded Apple helper rejects an unknown activation availability", async () => {
  let listener: ((line: string) => void) | null = null;
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { requestId: string };
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "activation",
        requestId: request.requestId,
        availability: "unknown",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
      })));
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-unknown-availability",
  });

  await assert.rejects(
    () => client.activate(),
    /Apple system model helper activation response was invalid\./,
  );
});

test("Apple system provider blocks activation when the helper protocol is incompatible", async () => {
  const process: EmbeddedHelperProcess = {
    onLine(listener) {
      queueMicrotask(() => listener(JSON.stringify({
        protocolVersion: "apple-system-model/v0",
        type: "handshake",
        helperVersion: "0",
      })));
      return () => {};
    },
    onExit() {
      return () => {};
    },
    writeLine() {},
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-provider-mismatch",
  });
  const provider = createAppleSystemModelProvider({
    client,
    hostOsBuild: () => "26A100",
  });

  assert.deepEqual(await provider.activate(), {
    availability: "incompatible",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "26A100",
    reason: "helper-protocol-incompatible",
  });
});

test("unsupported Apple system provider reports unavailable without a helper client", async () => {
  const provider = createUnsupportedAppleSystemModelProvider("linux");

  assert.deepEqual(await provider.activate(), {
    availability: "unavailable",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "unavailable",
    reason: "unsupported-platform:linux",
  });
  assert.throws(
    () => provider.start({
      runId: "unsupported-run",
      input: { prompt: "Hello" },
      toolGateway: createNoToolAgentGateway(),
      onStream() {},
      onComplete() {},
      onFailure() {},
    }),
    /Apple system model is unavailable on linux/,
  );
  assert.doesNotThrow(() => provider.cancel("unsupported-run"));
});

test("production embedded helper spawn environment contains zero Authentication secrets", async () => {
  const canaryValues = [
    "helper-password-canary",
    "provider-token-canary",
    "/tmp/helper-auth-socket-canary",
  ];
  const credentialCanaryKey = ["LIBRETTO", "CLOUD", "FUBON", "PASSWORD"].join("_");
  const helperProcess = spawnEmbeddedAppleSystemModelHelper({
    executablePath: process.execPath,
    arguments: [
      "--input-type=module",
      "-e",
      "process.stdout.write(JSON.stringify(process.env) + '\\n')",
    ],
    baseEnv: {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      [credentialCanaryKey]: canaryValues[0],
      APPLE_PROVIDER_TOKEN: canaryValues[1],
      SSH_AUTH_SOCK: canaryValues[2],
    },
  });
  const observed = await new Promise<Record<string, string>>((resolve) => {
    helperProcess.onLine((line) => resolve(JSON.parse(line)));
  });
  helperProcess.terminate();

  assert.equal(observed.PATH, process.env.PATH);
  assert.equal(observed.LANG, "en_US.UTF-8");
  assert.deepEqual(
    canaryValues.filter((canary) => JSON.stringify(observed).includes(canary)),
    [],
  );
});

test("embedded Apple helper streams and completes a prompted run through the protocol", async () => {
  let listener: ((line: string) => void) | null = null;
  let completeRun: (() => void) | null = null;
  const streamed: string[] = [];
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {
        listener = null;
      };
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as { type: string; requestId?: string; runId?: string };
      if (request.type === "activate") {
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: request.requestId,
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        })));
      }
      if (request.type === "start") {
        queueMicrotask(() => {
          listener?.(JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            type: "stream",
            runId: request.runId,
            content: "First",
          }));
          listener?.(JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            type: "stream",
            runId: request.runId,
            content: "First response",
          }));
          listener?.(JSON.stringify({
            protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
            type: "complete",
            runId: request.runId,
          }));
        });
      }
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-stream",
  });
  await client.activate();

  const completed = new Promise<void>((resolve) => {
    completeRun = resolve;
  });
  client.start({
    runId: "run-stream-1",
    prompt: "Explain local model privacy.",
    onStream: (content) => streamed.push(content),
    onComplete: () => completeRun?.(),
    onFailure: (error) => assert.fail(error.message),
  });
  await completed;

  assert.deepEqual(streamed, ["First", "First response"]);
});

test("embedded Apple helper sends user cancellation and ignores late generation", async () => {
  let listener: ((line: string) => void) | null = null;
  const sent: Array<Record<string, unknown>> = [];
  const streamed: string[] = [];
  const process: EmbeddedHelperProcess = {
    onLine(nextListener) {
      listener = nextListener;
      queueMicrotask(() => listener?.(JSON.stringify({
        protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
        type: "handshake",
        helperVersion: "1",
      })));
      return () => {
        listener = null;
      };
    },
    onExit() {
      return () => {};
    },
    writeLine(line) {
      const request = JSON.parse(line) as Record<string, unknown>;
      sent.push(request);
      if (request.type === "activate") {
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "activation",
          requestId: request.requestId,
          availability: "available",
          providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
          osBuild: "25C56",
        })));
      }
      if (request.type === "cancel") {
        queueMicrotask(() => listener?.(JSON.stringify({
          protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
          type: "stream",
          runId: request.runId,
          content: "must be ignored",
        })));
      }
    },
    terminate() {},
  };
  const client = createAppleSystemModelProtocolClient({
    launchProcess: () => process,
    requestIdFactory: () => "activation-cancel",
  });
  await client.activate();
  client.start({
    runId: "run-cancel-1",
    prompt: "Generate until cancelled.",
    onStream: (content) => streamed.push(content),
    onComplete: () => assert.fail("cancelled run must not complete"),
    onFailure: (error) => assert.fail(error.message),
  });

  client.cancel("run-cancel-1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent.at(-1), {
    protocolVersion: APPLE_SYSTEM_MODEL_HELPER_PROTOCOL_VERSION,
    type: "cancel",
    runId: "run-cancel-1",
  });
  assert.deepEqual(streamed, []);
});
