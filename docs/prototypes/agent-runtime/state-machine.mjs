/*
 * THROWAWAY PROTOTYPE — issue #63.
 *
 * Question: can an App-owned Agent Harness keep the renderer, provider, MCP
 * tools, secrets, model runtime, checkpoint, and fallback boundaries explicit
 * enough that cancellation and failure are predictable? This module is the
 * portable state model. The terminal shell lives in index.mjs.
 */

export const PROTOTYPE_QUESTION =
  "Can a local Agent Harness preserve policy precedence, secret boundaries, one active model, canonical lineage, and predictable recovery?";

export const PROVIDER_CATALOG = Object.freeze({
  "builtin-llama": Object.freeze({
    id: "builtin-llama",
    label: "Built-in local provider",
    trust: "product-controlled-local",
    endpoint: "app-owned-process",
    requiresDisclosure: false,
  }),
  "external-loopback": Object.freeze({
    id: "external-loopback",
    label: "Separately installed loopback provider",
    trust: "external-local-provider",
    endpoint: "127.0.0.1-loopback",
    requiresDisclosure: true,
  }),
});

export const MODEL_CATALOG = Object.freeze({
  "gguf-3b-q4": Object.freeze({
    id: "gguf-3b-q4",
    label: "Representative GGUF 3B Q4",
    format: "GGUF",
    runtime: "llama.cpp-style helper",
  }),
  "gguf-7b-q4": Object.freeze({
    id: "gguf-7b-q4",
    label: "Representative GGUF 7B Q4",
    format: "GGUF",
    runtime: "llama.cpp-style helper",
  }),
  "apple-3b": Object.freeze({
    id: "apple-3b",
    label: "Representative Apple-provider 3B",
    format: "Apple provider artifact",
    runtime: "Apple/Metal-style helper",
  }),
});

export const DEVICE_TIERS = Object.freeze([
  Object.freeze({ id: "entry-8gb", label: "Apple Silicon 8 GB", memoryGiB: 8 }),
  Object.freeze({ id: "balanced-16gb", label: "Apple Silicon 16 GB", memoryGiB: 16 }),
  Object.freeze({ id: "capacity-32gb", label: "Apple Silicon 32 GB+", memoryGiB: 32 }),
]);

export const BENCHMARK_GATES = Object.freeze({
  secretExposure: "0 occurrences in provider input, MCP result, lineage, or logs (hard fail)",
  securityToolCorrectness: "100% on secret denial, allowlist denial, and action-preview-only cases (hard fail)",
  recoveryCorrectness: "100% of injected cancel/crash/memory-pressure cases preserve checkpoint semantics (hard fail)",
  coldStartP95: "<= 20 s on the assigned device/model cell",
  firstTokenP95: "<= 5 s on the assigned device/model cell",
  generationSpeed: ">= 8 tok/s for the 3B slot and >= 4 tok/s for the 7B slot",
  peakRss: "<= 70% of unified memory and >= 2 GiB headroom after load",
  contextCost: "<= 25% of the available memory budget for the approved context pack",
  fallback: "fallback is explicit, pre-authorized, and records provider/model/context transfer",
});

export const BENCHMARK_MATRIX = Object.freeze([
  Object.freeze({ tier: "entry-8gb", model: "gguf-3b-q4", provider: "builtin-llama", role: "minimum viable local path" }),
  Object.freeze({ tier: "entry-8gb", model: "apple-3b", provider: "external-loopback", role: "lower-trust loopback comparison" }),
  Object.freeze({ tier: "balanced-16gb", model: "gguf-7b-q4", provider: "builtin-llama", role: "quality/latency candidate" }),
  Object.freeze({ tier: "balanced-16gb", model: "apple-3b", provider: "external-loopback", role: "provider portability comparison" }),
  Object.freeze({ tier: "capacity-32gb", model: "gguf-7b-q4", provider: "builtin-llama", role: "headroom and context ceiling" }),
]);

const ALLOWED_TOOLS = new Set([
  "read_financial_overview",
  "run_deterministic_analysis",
  "retrieve_user_selected_source",
  "action_preview",
]);

const SECRET_TOOLS = new Set([
  "read_credentials",
  "read_cookies",
  "read_session_token",
]);

const stateWith = (state, patch) => ({ ...state, ...patch });

function lineageEvent(state, event, patch = {}) {
  const entry = {
    seq: state.lineage.length + 1,
    actor: event.actor ?? "host",
    kind: event.kind,
    status: event.status ?? "observed",
    policyRule: event.policyRule ?? null,
    resource: event.resource ?? null,
    providerId: state.runtime.providerId,
    modelId: state.runtime.activeModelId,
    dataClasses: event.dataClasses ?? [],
    secretFields: event.secretFields ?? [],
  };
  const logLine = [
    `${entry.seq}`,
    entry.actor,
    entry.kind,
    entry.status,
    entry.policyRule ? `rule=${entry.policyRule}` : null,
  ].filter(Boolean).join(" ");
  return stateWith(stateWith(state, patch), {
    lastEvent: entry,
    lineage: [...state.lineage, entry],
    logs: [...state.logs, logLine].slice(-20),
  });
}

function blocked(state, event, errorCode) {
  return lineageEvent(state, {
    ...event,
    status: "blocked",
    policyRule: event.policyRule ?? "host-validation",
  }, {
    lastError: state.phase === "failed" ? state.lastError : errorCode,
  });
}

function artifactSet(state, ...modelIds) {
  return [...new Set([...state.runtime.installedArtifactIds, ...modelIds])];
}

function providerView(provider, disclosureAccepted) {
  return {
    providerId: provider.id,
    trust: provider.trust,
    endpoint: provider.endpoint,
    disclosureAccepted,
    receivedDataClasses: ["financial.overview.summary"],
    receivedSecretFields: [],
    authority: "none — provider proposes; host validates",
  };
}

function modelRuntime(state, patch = {}) {
  const runtime = { ...state.runtime, ...patch };
  const loaded = runtime.loadedModelId;
  const active = runtime.activeModelId;
  return {
    ...runtime,
    loadedModelId: loaded,
    activeModelId: active,
    exactlyOneActiveLoadedModel: loaded === null || loaded === active,
  };
}

function startRun(state, action) {
  const provider = PROVIDER_CATALOG[action.providerId];
  const model = MODEL_CATALOG[action.modelId];
  if (!provider) return blocked(state, { actor: "host", kind: "run.start", policyRule: "provider-catalog" }, "unknown-provider");
  if (!model) return blocked(state, { actor: "host", kind: "run.start", policyRule: "model-catalog" }, "unknown-model");
  if (provider.requiresDisclosure && action.disclosureAccepted !== true) {
    return blocked(state, { actor: "host", kind: "run.start", policyRule: "provider-disclosure" }, "loopback-disclosure-required");
  }

  const next = stateWith(state, {
    phase: "running",
    lastError: null,
    checkpoint: null,
    runtime: modelRuntime(state, {
      activeModelId: model.id,
      loadedModelId: model.id,
      providerId: provider.id,
      providerTrust: provider.trust,
      sessionId: action.sessionId ?? "run-63",
      disclosureAccepted: action.disclosureAccepted === true,
      fallbackAuthorized: action.fallbackAuthorized === true,
      installedArtifactIds: artifactSet(state, model.id),
    }),
    providerView: providerView(provider, action.disclosureAccepted === true),
    toolLoop: { step: 0, inFlight: false, lastTool: null },
  });
  return lineageEvent(next, {
    actor: "host",
    kind: "run.start",
    status: "allowed",
    policyRule: "app-owned-harness",
    resource: action.sessionId ?? "run-63",
  });
}

function providerToolRequest(state, action) {
  if (state.phase !== "running") {
    return blocked(state, { actor: "provider", kind: "provider.tool_request", resource: action.tool }, "run-not-active");
  }
  const request = { tool: action.tool, targetUrl: action.targetUrl ?? null };
  const requested = stateWith(state, {
    toolLoop: {
      step: state.toolLoop.step + 1,
      inFlight: true,
      lastTool: action.tool,
    },
    providerView: {
      ...state.providerView,
      lastRequest: request,
    },
  });
  let next = lineageEvent(requested, {
    actor: "provider",
    kind: "provider.tool_request",
    status: "proposed",
    resource: action.tool,
    dataClasses: action.tool === "read_credentials" ? ["authentication.secret"] : [],
    secretFields: [],
  });

  let decision = "allow";
  let policyRule = "tool-allowlist";
  let resultType = "tool-result";
  let dataClasses = [];
  let secretFields = [];
  if (SECRET_TOOLS.has(action.tool)) {
    decision = "deny";
    policyRule = "credential-boundary";
    resultType = "redacted-denial";
    secretFields = [];
    next = stateWith(next, {
      security: {
        ...next.security,
        deniedSecretRequests: next.security.deniedSecretRequests + 1,
        providerObservedSecretFields: [],
        mcpObservedSecretFields: [],
        logsObservedSecretFields: [],
      },
    });
  } else if (!ALLOWED_TOOLS.has(action.tool)) {
    decision = "deny";
    policyRule = "tool-allowlist";
    resultType = "allowlist-denial";
  } else if (action.tool === "retrieve_user_selected_source") {
    if (!/^https:\/\//.test(action.targetUrl ?? "")) {
      decision = "deny";
      policyRule = "user-selected-source-only";
      resultType = "source-url-denial";
    } else {
      dataClasses = ["untrusted.external.evidence"];
    }
  } else if (action.tool === "action_preview") {
    policyRule = "preview-without-execution";
    resultType = "action-preview";
    dataClasses = ["user-directed.scenario"];
  } else if (action.tool === "run_deterministic_analysis") {
    policyRule = "deterministic-computation-host-owned";
    resultType = "deterministic-analysis";
    dataClasses = ["financial.calculation"];
  } else {
    dataClasses = ["financial.overview.summary"];
  }

  next = lineageEvent(next, {
    actor: "host",
    kind: "host.tool_result",
    status: decision === "allow" ? "allowed" : "blocked",
    policyRule,
    resource: resultType,
    dataClasses,
    secretFields,
  }, {
    toolLoop: {
      ...next.toolLoop,
      inFlight: false,
    },
    mcpResults: decision === "allow"
      ? [...next.mcpResults, { resultType, dataClasses, secretFields: [] }]
      : next.mcpResults,
    metrics: {
      ...next.metrics,
      toolCalls: next.metrics.toolCalls + 1,
      deniedToolCalls: next.metrics.deniedToolCalls + (decision === "deny" ? 1 : 0),
      actionPreviews: next.metrics.actionPreviews + (resultType === "action-preview" ? 1 : 0),
    },
  });
  return next;
}

function checkpoint(state, action) {
  if (state.phase !== "running" || state.toolLoop.inFlight) {
    return blocked(state, { actor: "host", kind: "runtime.checkpoint", policyRule: "safe-checkpoint-boundary" }, "checkpoint-not-safe");
  }
  const id = action.checkpointId ?? `cp-${state.lineage.length + 1}`;
  return lineageEvent(state, {
    actor: "harness",
    kind: "runtime.checkpoint",
    status: "saved-in-memory",
    policyRule: "canonical-lineage",
    resource: id,
  }, {
    checkpoint: {
      id,
      toolLoopStep: state.toolLoop.step,
      sessionId: state.runtime.sessionId,
      activeModelId: state.runtime.activeModelId,
      secretFields: [],
    },
    metrics: { ...state.metrics, checkpoints: state.metrics.checkpoints + 1 },
  });
}

function cancel(state, action) {
  if (!["running", "memory_pressure", "fallback_pending"].includes(state.phase)) {
    return blocked(state, { actor: "host", kind: "runtime.cancel", policyRule: "run-lifecycle" }, "run-not-cancellable");
  }
  return lineageEvent(state, {
    actor: "host",
    kind: "runtime.cancel",
    status: "completed",
    policyRule: "cooperative-cancel",
    resource: action.reason ?? "user-request",
  }, {
    phase: "cancelled",
    cancelReason: action.reason ?? "user-request",
    toolLoop: { ...state.toolLoop, inFlight: false },
  });
}

function resume(state) {
  if (state.phase === "failed") {
    return blocked(state, { actor: "host", kind: "runtime.resume", policyRule: "no-silent-substitution" }, "run-terminal-after-helper-crash");
  }
  if (state.phase !== "cancelled" || !state.checkpoint) {
    return blocked(state, { actor: "host", kind: "runtime.resume", policyRule: "checkpoint-required" }, "resume-checkpoint-missing");
  }
  return lineageEvent(state, {
    actor: "harness",
    kind: "runtime.resume",
    status: "allowed",
    policyRule: "canonical-lineage",
    resource: state.checkpoint.id,
  }, {
    phase: "running",
    cancelReason: null,
    metrics: { ...state.metrics, resumes: state.metrics.resumes + 1 },
  });
}

function helperCrash(state, action) {
  if (!state.runtime.loadedModelId) {
    return blocked(state, { actor: "runtime", kind: "runtime.helper_crash", policyRule: "runtime-state" }, "helper-not-loaded");
  }
  const authorized = state.runtime.fallbackAuthorized === true
    && action.fallbackAuthorized === true
    && action.fallbackProviderId
    && action.fallbackModelId;
  const next = lineageEvent(state, {
    actor: "runtime",
    kind: "runtime.helper_crash",
    status: authorized ? "fallback-pending" : "failed",
    policyRule: authorized ? "transparent-fallback" : "no-silent-substitution",
    resource: action.errorCode ?? "helper-crash",
  }, {
    phase: authorized ? "fallback_pending" : "failed",
    lastError: authorized ? null : action.errorCode ?? "helper-crash",
    runtime: modelRuntime(state, { loadedModelId: null }),
  });
  return stateWith(next, {
    pendingFallback: authorized ? {
      providerId: action.fallbackProviderId,
      modelId: action.fallbackModelId,
      disclosureAccepted: action.disclosureAccepted === true,
    } : null,
  });
}

function memoryPressure(state, action) {
  if (!state.runtime.loadedModelId) {
    return blocked(state, { actor: "runtime", kind: "runtime.memory_pressure", policyRule: "runtime-state" }, "model-not-loaded");
  }
  const next = checkpoint(state, { checkpointId: action.checkpointId ?? `pressure-${state.lineage.length + 1}` });
  if (next.lastError) return next;
  return lineageEvent(next, {
    actor: "runtime",
    kind: "runtime.memory_pressure",
    status: "released-model-memory",
    policyRule: "artifact-retained",
    resource: "unified-memory-pressure",
  }, {
    phase: "memory_pressure",
    runtime: modelRuntime(next, { loadedModelId: null }),
  });
}

function recover(state, action) {
  if (!["memory_pressure", "fallback_pending"].includes(state.phase)) {
    return blocked(state, { actor: "runtime", kind: "runtime.recover", policyRule: "recoverable-runtime-state" }, "nothing-to-recover");
  }
  const fallback = state.phase === "fallback_pending";
  const providerId = fallback ? action.providerId ?? state.pendingFallback?.providerId : state.runtime.providerId;
  const modelId = fallback ? action.modelId ?? state.pendingFallback?.modelId : state.runtime.activeModelId;
  const provider = PROVIDER_CATALOG[providerId];
  const model = MODEL_CATALOG[modelId];
  if (!provider || !model) return blocked(state, { actor: "runtime", kind: "runtime.recover", policyRule: "fallback-catalog" }, "fallback-not-in-catalog");
  if (provider.requiresDisclosure && action.disclosureAccepted !== true && state.runtime.disclosureAccepted !== true) {
    return blocked(state, { actor: "runtime", kind: "runtime.recover", policyRule: "provider-disclosure" }, "fallback-disclosure-required");
  }
  const transferFields = fallback ? ["checkpoint.tool_loop", "conversation.safe_context"] : ["checkpoint.tool_loop"];
  const next = stateWith(state, {
    phase: "running",
    lastError: null,
    pendingFallback: null,
    runtime: modelRuntime(state, {
      activeModelId: model.id,
      loadedModelId: model.id,
      providerId: provider.id,
      providerTrust: provider.trust,
      disclosureAccepted: state.runtime.disclosureAccepted || action.disclosureAccepted === true,
      installedArtifactIds: artifactSet(state, model.id),
    }),
    providerView: providerView(provider, state.runtime.disclosureAccepted || action.disclosureAccepted === true),
    metrics: { ...state.metrics, fallbacks: state.metrics.fallbacks + (fallback ? 1 : 0) },
  });
  return lineageEvent(next, {
    actor: "runtime",
    kind: fallback ? "runtime.transparent_fallback" : "runtime.recover",
    status: "allowed",
    policyRule: fallback ? "transparent-fallback" : "checkpoint-recover",
    resource: `${provider.id}/${model.id}`,
    dataClasses: transferFields,
    secretFields: [],
  });
}

function switchModel(state, action) {
  const model = MODEL_CATALOG[action.modelId];
  const provider = PROVIDER_CATALOG[action.providerId ?? state.runtime.providerId];
  if (!model) return blocked(state, { actor: "host", kind: "runtime.switch_model", policyRule: "model-catalog" }, "unknown-model");
  if (!provider) return blocked(state, { actor: "host", kind: "runtime.switch_model", policyRule: "provider-catalog" }, "unknown-provider");
  if (provider.requiresDisclosure && action.disclosureAccepted !== true && state.runtime.disclosureAccepted !== true) {
    return blocked(state, { actor: "host", kind: "runtime.switch_model", policyRule: "provider-disclosure" }, "loopback-disclosure-required");
  }
  const previous = state.runtime.activeModelId;
  const next = stateWith(state, {
    phase: "running",
    lastError: null,
    runtime: modelRuntime(state, {
      activeModelId: model.id,
      loadedModelId: model.id,
      providerId: provider.id,
      providerTrust: provider.trust,
      disclosureAccepted: state.runtime.disclosureAccepted || action.disclosureAccepted === true,
      installedArtifactIds: artifactSet(state, model.id),
    }),
    providerView: providerView(provider, state.runtime.disclosureAccepted || action.disclosureAccepted === true),
  });
  return lineageEvent(next, {
    actor: "runtime",
    kind: "runtime.switch_model",
    status: "released-then-loaded",
    policyRule: "single-active-generation-model",
    resource: `${previous ?? "none"}->${model.id} via ${provider.id}`,
  });
}

function complete(state) {
  if (state.phase !== "running") {
    return blocked(state, { actor: "host", kind: "run.complete", policyRule: "run-lifecycle" }, "run-not-active");
  }
  return lineageEvent(state, {
    actor: "harness",
    kind: "run.complete",
    status: "completed",
    policyRule: "canonical-lineage",
    resource: state.runtime.sessionId,
  }, { phase: "completed" });
}

export function createInitialState() {
  return {
    prototype: "THROWAWAY — issue #63",
    question: PROTOTYPE_QUESTION,
    phase: "idle",
    lastError: null,
    cancelReason: null,
    lastEvent: null,
    runtime: {
      sessionId: null,
      providerId: null,
      providerTrust: null,
      activeModelId: null,
      loadedModelId: null,
      installedArtifactIds: [],
      disclosureAccepted: false,
      fallbackAuthorized: false,
      exactlyOneActiveLoadedModel: true,
    },
    providerView: {
      receivedDataClasses: [],
      receivedSecretFields: [],
      authority: "none",
    },
    toolLoop: { step: 0, inFlight: false, lastTool: null },
    checkpoint: null,
    pendingFallback: null,
    mcpResults: [],
    lineage: [],
    logs: [],
    security: {
      secretStore: "host-only (one canary credential exists outside reducer state)",
      deniedSecretRequests: 0,
      providerObservedSecretFields: [],
      mcpObservedSecretFields: [],
      logsObservedSecretFields: [],
    },
    metrics: {
      toolCalls: 0,
      deniedToolCalls: 0,
      actionPreviews: 0,
      checkpoints: 0,
      resumes: 0,
      fallbacks: 0,
    },
    benchmark: {
      status: "plan-only — real provider runs not included in this throwaway prototype",
      host: null,
      matrix: BENCHMARK_MATRIX,
      gates: BENCHMARK_GATES,
    },
  };
}

export function projectProviderInput(state) {
  return {
    providerId: state.runtime.providerId,
    providerTrust: state.runtime.providerTrust,
    context: ["financial.overview.summary"],
    secretFields: [],
    authority: "none",
  };
}

export function reduce(state, action) {
  switch (action.type) {
    case "inventory":
      return lineageEvent(state, {
        actor: "host",
        kind: "host.inventory",
        status: "observed",
        policyRule: "benchmark-environment-record",
        resource: `${action.inventory.arch}/${action.inventory.totalMemoryGiB}GiB`,
      }, {
        benchmark: { ...state.benchmark, host: action.inventory },
      });
    case "benchmark_plan":
      return lineageEvent(state, {
        actor: "host",
        kind: "benchmark.plan",
        status: "ready-to-measure",
        policyRule: "support-matrix-gates",
        resource: `${BENCHMARK_MATRIX.length} cells`,
      });
    case "start":
      return startRun(state, action);
    case "renderer_prompt":
      if (state.phase !== "running") return blocked(state, { actor: "renderer", kind: "renderer.prompt", policyRule: "run-lifecycle" }, "run-not-active");
      return lineageEvent(state, {
        actor: "renderer",
        kind: "renderer.prompt",
        status: "accepted-over-ipc",
        policyRule: "versioned-ipc-only",
        resource: "prompt-received",
        dataClasses: ["conversation.safe_context"],
      });
    case "provider_tool_request":
      return providerToolRequest(state, action);
    case "checkpoint":
      return checkpoint(state, action);
    case "cancel":
      return cancel(state, action);
    case "resume":
      return resume(state);
    case "helper_crash":
      return helperCrash(state, action);
    case "memory_pressure":
      return memoryPressure(state, action);
    case "recover":
      return recover(state, action);
    case "switch_model":
      return switchModel(state, action);
    case "complete":
      return complete(state);
    default:
      return blocked(state, { actor: "host", kind: "unknown.action", resource: action.type }, "unknown-action");
  }
}

export function scenarioActions(name) {
  const inventory = { arch: "apple-silicon-or-current-host", totalMemoryGiB: "runtime-inventory" };
  const common = [{ type: "inventory", inventory }];
  if (name === "architecture") {
    return [
      ...common,
      { type: "start", providerId: "builtin-llama", modelId: "gguf-3b-q4", sessionId: "arch-run", fallbackAuthorized: true },
      { type: "renderer_prompt", prompt: "Explain concentration risk from the trusted overview." },
      { type: "provider_tool_request", tool: "read_financial_overview" },
      { type: "provider_tool_request", tool: "run_deterministic_analysis" },
      { type: "provider_tool_request", tool: "retrieve_user_selected_source", targetUrl: "https://example.test/selected-source" },
      { type: "provider_tool_request", tool: "action_preview" },
      { type: "checkpoint", checkpointId: "arch-cp-1" },
      { type: "complete" },
    ];
  }
  if (name === "boundary") {
    return [
      ...common,
      { type: "start", providerId: "external-loopback", modelId: "apple-3b", sessionId: "boundary-run", disclosureAccepted: true },
      { type: "provider_tool_request", tool: "read_financial_overview" },
      { type: "provider_tool_request", tool: "read_credentials" },
      { type: "provider_tool_request", tool: "follow_link" },
      { type: "complete" },
    ];
  }
  if (name === "lifecycle") {
    return [
      ...common,
      { type: "start", providerId: "builtin-llama", modelId: "gguf-3b-q4", sessionId: "lifecycle-run", fallbackAuthorized: true },
      { type: "renderer_prompt", prompt: "Compare cash-flow scenarios." },
      { type: "provider_tool_request", tool: "run_deterministic_analysis" },
      { type: "checkpoint", checkpointId: "life-cp-1" },
      { type: "cancel", reason: "user-request" },
      { type: "resume" },
      { type: "helper_crash", errorCode: "llama-helper-exit-9", fallbackAuthorized: true, fallbackProviderId: "external-loopback", fallbackModelId: "apple-3b", disclosureAccepted: true },
      { type: "recover", providerId: "external-loopback", modelId: "apple-3b", disclosureAccepted: true },
      { type: "memory_pressure", checkpointId: "life-pressure-cp" },
      { type: "recover" },
      { type: "switch_model", providerId: "builtin-llama", modelId: "gguf-7b-q4" },
      { type: "complete" },
    ];
  }
  if (name === "failure") {
    return [
      ...common,
      { type: "start", providerId: "builtin-llama", modelId: "gguf-3b-q4", sessionId: "failure-run" },
      { type: "checkpoint", checkpointId: "failure-cp-1" },
      { type: "helper_crash", errorCode: "helper-crash-no-fallback" },
      { type: "resume" },
    ];
  }
  if (name === "benchmark") {
    return [...common, { type: "benchmark_plan" }];
  }
  return [...common];
}
