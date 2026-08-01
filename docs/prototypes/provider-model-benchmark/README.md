# THROWAWAY PROTOTYPE — provider / model benchmark

This prototype answers issue #68: which real provider/model cells can be placed
inside the first-release support boundary on measured Apple Silicon hardware?

It intentionally does not share production abstractions with the app. It compiles
a small Foundation Models probe, runs pinned `llama-server` and GGUF artifacts,
forces tool requests/cancellation/crashes/fallback, and writes the complete state
to `out/provider-model-benchmark/report.{json,md}`.

Run:

```sh
npm run prototype:provider-model-benchmark
```

Useful constrained runs:

```sh
npm run prototype:provider-model-benchmark -- --apple-only --samples 5
npm run prototype:provider-model-benchmark -- --gguf-only --samples 5
npm run prototype:provider-model-benchmark -- --gguf-only --models qwen3-4b-q4_k_m --samples 5
npm run prototype:provider-model-benchmark -- --gguf-only --reuse-apple --samples 5
npm run prototype:provider-model-benchmark -- --skip-downloads
```

The default run downloads roughly 6.6 GB into the git-ignored `out/` directory.
Every runtime/model file is size- and SHA-256-verified against `manifest.mjs`.
The report contains no hardware serial number or platform UUID.

This machine supplies only one real memory tier. Missing 8 GiB and 32 GiB runs are
reported as unqualified rather than simulated. Apple Foundation Models is also
reported honestly as an OS-managed model: its public API does not expose an
artifact hash, token usage, attributable model-service RSS, or context allocation.

The accepted support decision and measured five-sample summary are in
[`VERDICT.md`](./VERDICT.md).
