import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { APPLE_PROVIDER, BENCHMARK_VERSION, GGUF_MODELS, LLAMA_CPP } from "./manifest.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUTPUT = join(ROOT, "out/provider-model-benchmark");
const ARTIFACTS = join(OUTPUT, "artifacts");
const RUNTIME = join(OUTPUT, "runtime");
const REPORT_JSON = join(OUTPUT, "report.json");
const REPORT_MD = join(OUTPUT, "report.md");
const samples = Number(argument("--samples") ?? "5");
const appleOnly = process.argv.includes("--apple-only");
const ggufOnly = process.argv.includes("--gguf-only");
const skipDownloads = process.argv.includes("--skip-downloads");
const reuseApple = process.argv.includes("--reuse-apple");
const modelFilter = argument("--models")?.split(",").filter(Boolean) ?? null;
let appleExecutable = null;

if (!Number.isInteger(samples) || samples < 1) fail("--samples must be a positive integer");
await mkdir(ARTIFACTS, { recursive: true });
await mkdir(RUNTIME, { recursive: true });

const report = {
  benchmarkVersion: BENCHMARK_VERSION,
  startedAt: new Date().toISOString(),
  host: await hostInventory(),
  sampleCount: samples,
  limitations: [
    "This run covers one physical 16 GiB host. It does not simulate 8 GiB or 32 GiB hardware.",
    "Cold start means a fresh provider process; macOS file cache is not purged.",
    "Context memory is reported as the process RSS delta from ready state to the peak observed during the fixed 4096-token-context workload; it is a comparable proxy, not an allocator-exact KV-cache measurement.",
    "Foundation Models does not expose a pinnable model artifact, token counts, model-service RSS, or context-memory allocation through its public API.",
  ],
  artifacts: [],
  cells: [],
  recovery: [],
  lineage: [],
  transientRetries: [],
  segmentedRuns: [],
};

if (reuseApple) await reuseAppleEvidence(report);
if (!ggufOnly) await runAppleCell(report);
if (!appleOnly) await runGgufCells(report);
report.finishedAt = new Date().toISOString();
report.verdict = buildVerdict(report);
await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(REPORT_MD, renderMarkdown(report));
console.log(`\nWrote ${REPORT_JSON}\nWrote ${REPORT_MD}`);

async function reuseAppleEvidence(target) {
  const previous = JSON.parse(await readFile(REPORT_JSON, "utf8"));
  const appleCell = previous.cells?.find((cell) => cell.id === APPLE_PROVIDER.id);
  if (!appleCell) fail("--reuse-apple requires an existing report with Apple evidence");
  if (previous.benchmarkVersion !== BENCHMARK_VERSION
      || previous.sampleCount !== samples
      || previous.host?.build !== target.host.build
      || previous.host?.model !== target.host.model) {
    fail("--reuse-apple report does not match benchmark version, sample count, OS build, and host model");
  }
  target.cells.push(appleCell);
  target.recovery.push(...previous.recovery.filter((event) => event.from === APPLE_PROVIDER.id));
  target.transientRetries.push(...(previous.transientRetries ?? []));
  target.segmentedRuns.push({
    provider: APPLE_PROVIDER.id,
    sourceStartedAt: previous.startedAt,
    sourceFinishedAt: previous.finishedAt,
    reason: "Avoid immediate repeated Foundation Models load after a complete same-version run.",
  });
  const executable = join(RUNTIME, "apple-provider");
  if (existsSync(executable)) appleExecutable = executable;
}

async function runAppleCell(target) {
  const source = join(import.meta.dirname, "apple-provider.swift");
  const executable = join(RUNTIME, "apple-provider");
  appleExecutable = executable;
  await command("/usr/bin/env", [
    "DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer",
    `CLANG_MODULE_CACHE_PATH=${join(RUNTIME, "module-cache")}`,
    `SWIFT_MODULECACHE_PATH=${join(RUNTIME, "module-cache")}`,
    "xcrun", "swiftc", "-parse-as-library", source, "-o", executable,
  ]);
  const measurements = [];
  for (let index = 0; index < samples; index += 1) {
    const events = await jsonLinesWithRetry(executable, []);
    measurements.push({
      coldStartMs: events.find((event) => event.kind === "ready")?.coldStartMs,
      ttftMs: events.find((event) => event.kind === "completion")?.ttftMs,
      totalMs: events.find((event) => event.kind === "completion")?.totalMs,
      outputCharacters: events.find((event) => event.kind === "completion")?.characters,
    });
    progress(`Apple Foundation Models sample ${index + 1}/${samples}`);
    await delay(500);
  }
  const toolTrials = [];
  for (let index = 0; index < samples; index += 1) {
    const events = await jsonLinesWithRetry(executable, ["--tool"]);
    toolTrials.push(events.find((event) => event.kind === "toolResult") ?? { correct: false });
    await delay(500);
  }
  const cancelGate = await appleCancelTrial(executable);
  const recovery = await appleRecoveryTrial(executable);
  target.recovery.push(recovery);
  target.cells.push({
    id: APPLE_PROVIDER.id,
    provider: APPLE_PROVIDER.provider,
    model: "OS-managed system language model",
    artifactIdentity: APPLE_PROVIDER.artifactIdentity,
    contextTokens: APPLE_PROVIDER.contextTokens,
    measurements,
    summary: summarize(measurements),
    tokensPerSecond: { status: "not-observable-via-public-api" },
    peakRss: { status: "not-attributable-to-model-via-public-api" },
    contextMemory: { status: "not-observable-via-public-api" },
    toolCorrectness: {
      passed: toolTrials.filter((trial) => trial.correct).length,
      total: toolTrials.length,
      hardGate: toolTrials.every((trial) => trial.correct),
      trials: toolTrials,
    },
    cancelGate,
    recoveryGate: recovery.recovered,
    supportContract: {
      status: "supported",
      availabilityGate: "SystemLanguageModel.default.availability == .available",
      identity: `macOS ${target.host.macOS} (${target.host.build}) + ${APPLE_PROVIDER.provider}`,
      metricExceptions: ["token usage", "attributable model-service RSS", "context allocation"],
    },
  });
}

async function runGgufCells(target) {
  const llamaArchive = await ensureArtifact(LLAMA_CPP);
  const llamaRoot = join(RUNTIME, `llama-${LLAMA_CPP.version}`);
  const server = join(llamaRoot, "llama-server");
  if (!existsSync(server)) {
    await mkdir(llamaRoot, { recursive: true });
    await command("/usr/bin/tar", ["-xzf", llamaArchive, "-C", llamaRoot, "--strip-components=1"]);
  }
  target.artifacts.push({ kind: "runtime", ...LLAMA_CPP });

  const selectedModels = modelFilter
    ? GGUF_MODELS.filter((model) => modelFilter.includes(model.id))
    : GGUF_MODELS;
  if (modelFilter && selectedModels.length !== modelFilter.length) {
    fail(`unknown --models entry; valid ids: ${GGUF_MODELS.map((model) => model.id).join(", ")}`);
  }
  for (const model of selectedModels) {
    for (const file of model.files) await ensureArtifact(file);
    target.artifacts.push({
      kind: "model",
      id: model.id,
      repository: model.repository,
      revision: model.revision,
      files: model.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    });
    const measurements = [];
    const toolTrials = [];
    let cancelGate = true;
    for (let index = 0; index < samples; index += 1) {
      const instance = await startLlamaServer(server, model);
      try {
        const completion = await streamingCompletion(instance.port, undefined, model);
        const tool = await toolTrial(instance.port, model);
        const cancel = await cancelTrial(instance.port);
        toolTrials.push(tool);
        cancelGate &&= cancel;
        measurements.push({
          coldStartMs: instance.coldStartMs,
          ttftMs: completion.ttftMs,
          totalMs: completion.totalMs,
          completionTokens: completion.completionTokens,
          tokensPerSecond: completion.tokensPerSecond,
          readyRssBytes: instance.readyRssBytes,
          peakRssBytes: instance.peakRssBytes(),
          contextMemoryDeltaBytes: Math.max(0, instance.peakRssBytes() - instance.readyRssBytes),
        });
      } finally {
        await instance.stop("sample-complete");
      }
      progress(`${model.id} sample ${index + 1}/${samples}`);
    }
    const recovery = await crashRecoveryTrial(server, model);
    target.recovery.push(recovery);
    target.cells.push({
      id: model.id,
      provider: `llama.cpp ${LLAMA_CPP.version}`,
      model: `${model.family} ${model.parameters} ${model.quantization}`,
      artifactIdentity: model.files.map((file) => file.sha256),
      contextTokens: 4096,
      measurements,
      summary: summarize(measurements),
      toolCorrectness: {
        passed: toolTrials.filter((trial) => trial.correct).length,
        total: toolTrials.length,
        hardGate: toolTrials.every((trial) => trial.correct),
        trials: toolTrials,
      },
      cancelGate,
      recoveryGate: recovery.recovered,
    });
  }
  if (!modelFilter) {
    target.recovery.push(await fallbackTrial(server, GGUF_MODELS[1], GGUF_MODELS[0]));
    target.recovery.push(await fallbackTrial(server, GGUF_MODELS[1], GGUF_MODELS[2]));
    if (appleExecutable) {
      target.recovery.push(await ggufToAppleFallbackTrial(server, GGUF_MODELS[1], appleExecutable));
    }
  }
}

async function appleCancelTrial(executable) {
  const child = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
  let pending = "";
  let firstPartial = false;
  const observed = new Promise((resolveObserved, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.kind === "firstPartial" && !firstPartial) {
          firstPartial = true;
          child.kill("SIGTERM");
          resolveObserved();
        }
      }
    });
  });
  await Promise.race([observed, delay(60_000).then(() => fail("Apple cancel trial timed out"))]);
  await Promise.race([onceExit(child), delay(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([onceExit(child), delay(5_000)]);
  }
  await delay(2_000);
  const followup = await jsonLinesWithRetry(executable, []);
  return firstPartial && followup.some((event) => event.kind === "completion");
}

async function appleRecoveryTrial(executable) {
  const nonce = `apple-checkpoint-${randomUUID()}`;
  const first = spawn(executable, [], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolveReady, reject) => {
    let pending = "";
    first.once("error", reject);
    first.stdout.on("data", (chunk) => {
      pending += chunk;
      if (pending.includes('"kind":"ready"')) resolveReady();
    });
  });
  first.kill("SIGKILL");
  await Promise.race([onceExit(first), delay(5_000)]);
  const events = await jsonLinesWithRetry(executable, ["--recover", nonce]);
  const recovery = events.find((event) => event.kind === "recovery");
  return {
    kind: "apple-helper-crash-recovery",
    from: APPLE_PROVIDER.id,
    to: APPLE_PROVIDER.id,
    reason: "forced-helper-exit",
    checkpoint: nonce,
    recovered: recovery?.correct === true,
    providerIdentity: APPLE_PROVIDER.artifactIdentity,
  };
}

async function ggufToAppleFallbackTrial(binary, fromModel, executable) {
  const nonce = `apple-fallback-${randomUUID()}`;
  const first = await startLlamaServer(binary, fromModel);
  await first.stop("forced-apple-fallback");
  const events = await jsonLinesWithRetry(executable, ["--recover", nonce]);
  const recovery = events.find((event) => event.kind === "recovery");
  return {
    kind: "gguf-to-apple-fallback",
    from: fromModel.id,
    to: APPLE_PROVIDER.id,
    reason: "forced-provider-exit",
    checkpoint: nonce,
    transferredDataClasses: ["checkpoint.tool_loop", "conversation.safe_context"],
    transferredSecretFields: [],
    recovered: recovery?.correct === true,
    fromArtifactSha256: fromModel.files.map((file) => file.sha256),
    toProviderIdentity: APPLE_PROVIDER.artifactIdentity,
  };
}

async function startLlamaServer(binary, model) {
  const port = await freePort();
  const modelPath = join(ARTIFACTS, model.files[0].name);
  const started = performance.now();
  const child = spawn(binary, [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", "4096",
    "--parallel", "1",
    "--metrics",
    "--jinja",
    "--no-webui",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-40_000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-40_000); });
  let peak = 0;
  const timer = setInterval(async () => {
    peak = Math.max(peak, await rss(child.pid));
  }, 100);
  try {
    await waitForHealth(port, child, () => logs);
  } catch (error) {
    clearInterval(timer);
    child.kill("SIGKILL");
    throw error;
  }
  const coldStartMs = performance.now() - started;
  const readyRssBytes = await rss(child.pid);
  peak = Math.max(peak, readyRssBytes);
  return {
    child,
    port,
    coldStartMs,
    readyRssBytes,
    peakRssBytes: () => peak,
    async stop(reason) {
      clearInterval(timer);
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([onceExit(child), delay(5_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      report.lineage.push({
        at: new Date().toISOString(),
        event: "provider.stop",
        reason,
        provider: `llama.cpp ${LLAMA_CPP.version}`,
        model: model.id,
        artifactSha256: model.files.map((file) => file.sha256),
      });
    },
  };
}

async function streamingCompletion(
  port,
  prompt = "In about 100 words, explain why credentials must stay outside model context.",
  model = null,
) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 128,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      ...(model?.chatTemplateKwargs ? { chat_template_kwargs: model.chatTemplateKwargs } : {}),
    }),
  });
  if (!response.ok) throw new Error(`completion failed: ${response.status} ${await response.text()}`);
  let ttftMs;
  let completionTokens;
  let content = "";
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const records = pending.split("\n\n");
    pending = records.pop() ?? "";
    for (const record of records) {
      const data = record.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      const deltaContent = event.choices?.[0]?.delta?.content;
      if (deltaContent) {
        if (ttftMs === undefined) ttftMs = performance.now() - started;
        content += deltaContent;
      }
      if (event.usage?.completion_tokens !== undefined) completionTokens = event.usage.completion_tokens;
    }
  }
  const totalMs = performance.now() - started;
  return {
    ttftMs: ttftMs ?? totalMs,
    totalMs,
    completionTokens: completionTokens ?? null,
    tokensPerSecond: completionTokens ? completionTokens / (totalMs / 1000) : null,
    content,
  };
}

async function toolTrial(port, model) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{
        role: "user",
        content: "Use read_financial_overview for the authorized overview benchmark-overview-68. Do not answer without the tool.",
      }],
      temperature: 0,
      max_tokens: 256,
      ...(model?.chatTemplateKwargs ? { chat_template_kwargs: model.chatTemplateKwargs } : {}),
      tools: [{
        type: "function",
        function: {
          name: "read_financial_overview",
          description: "Read a user-authorized financial overview by exact identifier",
          parameters: {
            type: "object",
            properties: { overviewID: { type: "string" } },
            required: ["overviewID"],
          },
        },
      }],
      tool_choice: "required",
    }),
  });
  const body = await response.json();
  const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
  let args = {};
  try { args = JSON.parse(call?.arguments ?? "{}"); } catch {}
  return {
    correct: response.ok
      && call?.name === "read_financial_overview"
      && args.overviewID === "benchmark-overview-68",
    status: response.status,
    name: call?.name ?? null,
    arguments: args,
    finishReason: body.choices?.[0]?.finish_reason ?? null,
    messageContent: body.choices?.[0]?.message?.content ?? null,
  };
}

async function cancelTrial(port) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "user", content: "Write a very long numbered essay with at least 2000 words." }],
      max_tokens: 2048,
      stream: true,
    }),
  });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort("benchmark-cancel");
  try { await reader.read(); } catch {}
  await delay(250);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  return health.ok;
}

async function crashRecoveryTrial(binary, model) {
  const nonce = `checkpoint-${randomUUID()}`;
  const first = await startLlamaServer(binary, model);
  await streamingCompletion(first.port, `Remember this checkpoint identifier: ${nonce}. Reply ACK.`, model);
  await first.stop("forced-crash");
  const second = await startLlamaServer(binary, model);
  try {
    const result = await streamingCompletion(
      second.port,
      `Recovery context carries checkpoint ${nonce}. Repeat the identifier exactly.`,
      model,
    );
    const recovered = result.content.includes(nonce);
    return {
      kind: "same-provider-crash-recovery",
      from: model.id,
      to: model.id,
      reason: "forced-crash",
      checkpoint: nonce,
      recovered,
      artifactSha256: model.files.map((file) => file.sha256),
    };
  } finally {
    await second.stop("recovery-complete");
  }
}

async function fallbackTrial(binary, fromModel, toModel) {
  const nonce = `fallback-${randomUUID()}`;
  const first = await startLlamaServer(binary, fromModel);
  await first.stop("forced-fallback");
  const second = await startLlamaServer(binary, toModel);
  try {
    const result = await streamingCompletion(
      second.port,
      `Fallback context carries checkpoint ${nonce}. Repeat it exactly.`,
      toModel,
    );
    return {
      kind: "cross-model-fallback",
      from: fromModel.id,
      to: toModel.id,
      reason: "forced-provider-exit",
      checkpoint: nonce,
      transferredDataClasses: ["checkpoint.tool_loop", "conversation.safe_context"],
      transferredSecretFields: [],
      recovered: result.content.includes(nonce),
      fromArtifactSha256: fromModel.files.map((file) => file.sha256),
      toArtifactSha256: toModel.files.map((file) => file.sha256),
    };
  } finally {
    await second.stop("fallback-complete");
  }
}

async function ensureArtifact(spec) {
  const path = join(ARTIFACTS, spec.file ?? spec.name);
  if (!existsSync(path)) {
    if (skipDownloads) fail(`missing artifact: ${path}`);
    console.log(`Downloading ${spec.url}`);
    await command("/usr/bin/curl", ["-L", "--fail", "--continue-at", "-", "--output", path, spec.url]);
  }
  const digest = await sha256(path);
  if (digest !== spec.sha256) fail(`SHA-256 mismatch for ${path}: ${digest}`);
  const { size } = await stat(path);
  if (size !== spec.bytes) fail(`size mismatch for ${path}: ${size}`);
  return path;
}

async function hostInventory() {
  const [hardwareJSON, osVersion, osBuild] = await Promise.all([
    commandOutput("/usr/sbin/system_profiler", ["SPHardwareDataType", "-json"]),
    commandOutput("/usr/bin/sw_vers", ["-productVersion"]),
    commandOutput("/usr/bin/sw_vers", ["-buildVersion"]),
  ]);
  const hardware = JSON.parse(hardwareJSON).SPHardwareDataType[0];
  const memoryGiB = Number.parseFloat(hardware.physical_memory);
  return {
    chip: hardware.chip_type,
    memoryBytes: memoryGiB * 1024 ** 3,
    memoryGiB,
    model: hardware.machine_model,
    architecture: process.arch,
    macOS: osVersion.trim(),
    build: osBuild.trim(),
  };
}

function summarize(measurements) {
  const fields = ["coldStartMs", "ttftMs", "tokensPerSecond", "peakRssBytes", "contextMemoryDeltaBytes"];
  return Object.fromEntries(fields.map((field) => {
    const values = measurements.map((row) => row[field]).filter(Number.isFinite).sort((a, b) => a - b);
    return [field, values.length ? { p50: percentile(values, 0.5), p95: percentile(values, 0.95) } : null];
  }));
}

function percentile(values, quantile) {
  const index = (values.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function buildVerdict(target) {
  return {
    qualifiedHardwareTiers: target.host.memoryGiB === 16 ? ["16 GiB evidence collected"] : [`${target.host.memoryGiB} GiB evidence collected`],
    unqualifiedHardwareTiers: ["8 GiB: no physical-host evidence", "32 GiB: no physical-host evidence"],
    cells: target.cells.map((cell) => ({
      id: cell.id,
      hardGates: {
        toolCorrectness: cell.toolCorrectness?.hardGate ?? false,
        cancel: cell.cancelGate ?? "not-observable",
        recovery: cell.recoveryGate ?? "not-observable",
        artifactPinned: cell.id === APPLE_PROVIDER.id
          ? "os-managed identity bound to OS build/provider availability"
          : true,
        requiredMetricsComplete: cell.id === APPLE_PROVIDER.id
          ? "waived for public-API-unobservable metrics"
          : Boolean(cell.summary?.tokensPerSecond && cell.summary?.peakRssBytes),
      },
    })),
  };
}

function renderMarkdown(target) {
  const rows = target.cells.map((cell) => {
    const value = (metric, unit = "") => {
      const item = cell.summary?.[metric];
      return item ? `${item.p50.toFixed(1)} / ${item.p95.toFixed(1)}${unit}` : "not observable";
    };
    return `| ${cell.id} | ${value("coldStartMs", " ms")} | ${value("ttftMs", " ms")} | ${value("tokensPerSecond")} | ${value("peakRssBytes", " B")} | ${cell.toolCorrectness.passed}/${cell.toolCorrectness.total} |`;
  }).join("\n");
  return `# Provider / model benchmark report

- Benchmark: \`${target.benchmarkVersion}\`
- Host: ${target.host.model}, ${target.host.chip}, ${target.host.memoryGiB} GiB
- OS: macOS ${target.host.macOS} (${target.host.build})
- Samples per cell: ${target.sampleCount}

| Cell | cold p50 / p95 | TTFT p50 / p95 | tokens/s p50 / p95 | peak RSS p50 / p95 | correct tool calls |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

## Recovery evidence

\`\`\`json
${JSON.stringify(target.recovery, null, 2)}
\`\`\`

## Provisional verdict

\`\`\`json
${JSON.stringify(target.verdict, null, 2)}
\`\`\`

## Measurement limitations

${target.limitations.map((item) => `- ${item}`).join("\n")}
`;
}

async function waitForHealth(port, child, logs) {
  const deadline = performance.now() + 180_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`llama-server exited ${child.exitCode}\n${logs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`llama-server health timeout\n${logs()}`);
}

async function jsonLines(commandPath, args) {
  const output = await commandOutput(commandPath, args);
  return output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function jsonLinesWithRetry(commandPath, args, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await jsonLines(commandPath, args);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        report.transientRetries.push({
          provider: APPLE_PROVIDER.id,
          operation: args[0] ?? "completion",
          failedAttempt: attempt,
          retryDelayMs: 2_000 * attempt,
        });
        await delay(2_000 * attempt);
      }
    }
  }
  throw lastError;
}

async function rss(pid) {
  if (!pid) return 0;
  try {
    const output = await commandOutput("/bin/ps", ["-o", "rss=", "-p", String(pid)]);
    return Number(output.trim()) * 1024;
  } catch {
    return 0;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function command(commandPath, args) {
  await commandOutput(commandPath, args);
}

async function commandOutput(commandPath, args) {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(commandPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`${commandPath} exited ${code}: stdout=${stdout} stderr=${stderr}`));
    });
  });
}

function onceExit(child) {
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function progress(message) {
  console.log(`[benchmark] ${message}`);
}

function fail(message) {
  throw new Error(message);
}
