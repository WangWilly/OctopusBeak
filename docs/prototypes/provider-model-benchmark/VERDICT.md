# Issue #68 verdict — first-release provider / model support

Decision date: 2026-08-02

Benchmark contract: `issue-68/v1`

Host: Mac14,9, Apple M2 Pro, 16 GiB

OS: macOS 26.2 (25C56)

Runtime: llama.cpp `b10218`

## Decision

The first release supports the following provider/model cells on the measured
16 GiB Apple Silicon tier:

| Status | Provider / model | Product role |
| --- | --- | --- |
| Supported | Apple `SystemLanguageModel.default` | OS-managed system provider |
| Supported, default | Granite 4.0 Micro 3B Q4_K_M | Built-in low-memory default |
| Supported, optional | Qwen3 4B Q4_K_M | Balanced local model |
| Supported, optional | Qwen2.5 7B Instruct Q4_K_M | Higher-quality local tier |
| Technically compatible, not yet supported | Llama 3.2 3B Instruct Q4_K_M | Await license and artifact-provenance decision |
| Unsupported | Phi-4 Mini Instruct 3.8B Q4_K_M | Authorized tool-call hard gate failed |
| Unsupported | SmolLM3 3B Q4_K_M | Authorized tool-call and recovery hard gates failed |

The supported fallback order is:

1. Qwen2.5 7B to Granite 3B.
2. Granite 3B to Apple Foundation Models when the system model is available.

The benchmark directly verified Qwen2.5 7B to Granite 3B and Qwen2.5 7B to
Apple checkpoint transfer with no secret fields. Qwen2.5 7B to SmolLM3 failed
and is not an allowed fallback.

## Five-sample evidence

All GGUF cells used a 4096-token context, one generation slot, Metal through
the pinned arm64 llama.cpp release, temperature zero, and the same
`read_financial_overview(overviewID)` authorized tool schema.

| Cell | Cold p50 / p95 | TTFT p50 / p95 | tokens/s p50 / p95 | Peak RSS p50 / p95 | Tool | Cancel | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Apple system model | 4.0 / 9.5 ms | 449.9 / 1067.1 ms | Public API does not expose | Public API does not expose | 5/5 | Pass | Pass |
| SmolLM3 3B Q4 | 714.9 / 839.4 ms | 2304.0 / 2309.2 ms | 55.6 / 56.2 | 2.20 / 2.21 GiB | 0/5 | Pass | Fail |
| Qwen2.5 7B Q4 | 1122.9 / 10133.2 ms | 233.1 / 251.6 ms | 29.8 / 29.8 | 4.68 / 4.69 GiB | 5/5 | Pass | Pass |
| Granite 3B Q4 | 511.3 / 511.8 ms | 121.2 / 128.4 ms | 55.5 / 56.0 | 2.39 / 2.39 GiB | 5/5 | Pass | Pass |
| Qwen3 4B Q4 | 713.4 / 715.0 ms | 94.6 / 98.0 ms | 49.8 / 49.9 | 3.04 / 3.04 GiB | 5/5 | Pass | Pass |
| Llama 3.2 3B Q4 | 716.4 / 717.4 ms | 108.3 / 114.8 ms | 63.3 / 63.5 | 2.48 / 2.48 GiB | 5/5 | Pass | Pass |
| Phi-4 Mini 3.8B Q4 | 816.5 / 819.5 ms | 75.5 / 82.3 ms | 52.0 / 52.3 | 2.95 / 2.95 GiB | 0/5 | Pass | Pass |

Context memory in the machine-readable report is the process RSS delta from
ready state to the peak observed during the fixed workload. It is a comparable
proxy, not an allocator-exact KV-cache measurement.

## Apple system-provider exception

Apple Foundation Models is formally supported under a provider-specific
contract:

- `SystemLanguageModel.default.availability` must be `.available`.
- Provider identity is the macOS build plus the Foundation Models provider,
  because the public API does not expose a pinnable model artifact.
- Token usage, attributable model-service RSS, and context allocation are
  explicitly unavailable metrics rather than fabricated values.
- Tool calls, helper cancellation, forced helper exit, checkpoint recovery,
  and GGUF-to-Apple fallback must still pass.
- Repeated immediate stress runs can produce transient
  `unsupportedLanguageOrLocale`; production recovery must use bounded retry,
  backoff, and fallback rather than an unbounded loop.

## Artifact and template identity

`manifest.mjs` pins every runtime and model file to an immutable repository
revision, byte size, and SHA-256. Qwen3 additionally pins
`enable_thinking: false` as part of its chat-template configuration; otherwise
the fixed output budget can be consumed by hidden reasoning before tool
arguments are emitted.

Granite and Qwen artifacts are published by their model authors. The measured
Llama and Phi GGUF files are public third-party quantizations. Llama also uses
the Llama 3.2 Community License, so its technical pass does not by itself
authorize first-release distribution.

## Hardware boundary

Only the physical 16 GiB tier is qualified. The benchmark does not simulate
8 GiB or 32 GiB results. Those tiers remain outside the support claim until
their own physical-host runs satisfy the same benchmark contract.

## Reproduction

```sh
npm run prototype:provider-model-benchmark -- --apple-only --samples 5
npm run prototype:provider-model-benchmark -- --gguf-only --reuse-apple --samples 5
```

The second command validates that reused Apple evidence has the same benchmark
version, sample count, OS build, and host model. Generated reports and model
artifacts remain under git-ignored `out/provider-model-benchmark/`.
