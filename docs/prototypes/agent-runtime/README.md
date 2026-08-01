# Throwaway prototype: local Agent Harness / model Runtime

This is a throwaway logic prototype for [GitHub issue #63](https://github.com/WangWilly/OctopusBeak/issues/63). It is not a product implementation and has no persistence, real model inference, network access, or production IPC wiring.

## Question

Can an App-owned Agent Harness keep the renderer, provider, MCP tools, authentication-secret boundary, active model, canonical lineage, checkpoint, cancellation, helper crash, memory pressure, and transparent fallback states explicit enough that the first-release architecture is predictable?

The question is intentionally narrower than building the assistant. The reducer tests control-plane shape and policy precedence. The benchmark view defines the evidence matrix; it does not claim that a real GGUF or Apple provider has been measured.

## Run

Interactive TUI:

```sh
npm run prototype:agent-runtime
```

Repeatable scenario output:

```sh
npm run prototype:agent-runtime -- --scenario architecture
npm run prototype:agent-runtime -- --scenario boundary
npm run prototype:agent-runtime -- --scenario lifecycle
npm run prototype:agent-runtime -- --scenario failure
npm run prototype:agent-runtime -- --scenario benchmark
```

Each action prints the complete in-memory state. The canary credential is created only in the TUI's host-side audit and is never passed into the reducer, provider projection, MCP result, lineage, or log strings.

## Scenarios

- `architecture`: renderer prompt → provider proposal → host-validated overview, deterministic analysis, selected-source retrieval, action preview, checkpoint, and completion.
- `boundary`: explicitly disclosed loopback provider, financial summary projection, credential denial, and non-user-selected link denial.
- `lifecycle`: checkpoint, cancel/resume, helper crash, pre-authorized transparent fallback, memory-pressure release/recover, and model switch.
- `failure`: helper crash without fallback authorization; the run fails and a later resume is blocked because the model lifecycle is terminal.
- `benchmark`: current host inventory plus the proposed support-matrix cells and provisional gates.

## Proposed measurement matrix

The matrix uses representative slots rather than pinning a product model family before the target Mac run:

| Device tier | Model/provider cells | Purpose |
| --- | --- | --- |
| Apple Silicon 8 GB | GGUF 3B Q4 with built-in provider; Apple-provider 3B through loopback | minimum local path and lower-trust provider comparison |
| Apple Silicon 16 GB | GGUF 7B Q4 with built-in provider; Apple-provider 3B through loopback | quality/latency and provider portability |
| Apple Silicon 32 GB+ | GGUF 7B Q4 with built-in provider | context and memory headroom |

Record cold start, first token, sustained tokens/s, peak RSS, context cost, tool correctness, secret exposure, cancellation, checkpoint recovery, helper crash, memory pressure, and fallback lineage for each cell. Security and recovery gates are hard failures; a fast model cannot compensate for a boundary violation.

Provisional gates are shown by the `benchmark` scenario: zero secret occurrences, 100% security-tool and recovery correctness, cold-start p95 ≤ 20 s, first-token p95 ≤ 5 s, at least 8 tok/s for the 3B slot and 4 tok/s for the 7B slot, peak RSS ≤ 70% of unified memory with at least 2 GiB headroom, and context cost ≤ 25% of the available memory budget.

## Validation conclusion

The prototype supports the following control-plane decision:

1. Keep the Agent Harness in Electron main (or a main-owned helper), with the renderer limited to a versioned, typed IPC request surface. Provider adapters must be proposal-only; tool execution, policy precedence, deterministic financial computation, evidence retrieval, action preview, and canonical lineage stay host-owned.
2. Treat authentication secrets as a separate host-only capability. The provider projection, MCP result, fallback context transfer, lineage, and logs carry explicit `secretFields: []`; a credential request is denied before any tool runs.
3. Model one logical active generation model and one loaded model at a time. Switching or memory pressure releases runtime memory while retaining installed artifacts; fallback is a visible lifecycle transition that records actual provider/model and transferred safe context.
4. Use checkpointed lifecycle states for cancel, helper crash, memory pressure, resume, and fallback. A crash without pre-authorized fallback is terminal; resume cannot silently revive a terminal run.
5. This is a design validation, not a performance qualification. The current prototype cannot prove real Electron App Sandbox helper behavior or model latency/tool correctness. The first-release support matrix remains blocked on running the benchmark cells on target Apple Silicon hardware with pinned artifacts and real providers.

The prototype branch is the primary source for the state model and run transcript. Only these decisions should be carried into the implementation issue; the TUI and reducer remain throwaway.
