#!/usr/bin/env node

/*
 * THROWAWAY PROTOTYPE — terminal shell for issue #63.
 * The state machine is deliberately importable without this TUI.
 */

import os from "node:os";
import readline from "node:readline";
import {
  createInitialState,
  projectProviderInput,
  reduce,
  scenarioActions,
} from "./state-machine.mjs";

const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const scenarioNames = ["architecture", "boundary", "lifecycle", "failure", "benchmark"];

function hostInventory() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpuCount: os.cpus().length,
    totalMemoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

function render(state, { clear = false, audit = null } = {}) {
  if (clear) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`${bold("THROWAWAY PROTOTYPE — Agent Harness / Model Runtime")}\n`);
  process.stdout.write(`${dim(state.question)}\n\n`);
  process.stdout.write(`${bold("Current state")}\n`);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  if (audit) {
    process.stdout.write(`${bold("Boundary audit")}\n`);
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  }
  process.stdout.write(`\n${bold("Shortcuts")}  ${dim("[1] architecture  [2] boundary  [3] lifecycle  [4] failure  [5] benchmark  [r] reset  [q] quit")}\n`);
  process.stdout.write(`${dim("Each scenario is in-memory. Run with --scenario <name> for non-interactive evidence.")}\n`);
}

function reduceScenario(name, { clear = false } = {}) {
  let state = createInitialState();
  const secretCanary = "prototype-secret-canary-not-for-export";
  const providerInputs = [];
  const mcpOutputs = [];
  const frames = [];
  for (const action of scenarioActions(name)) {
    if (action.type === "inventory") action.inventory = { ...action.inventory, ...hostInventory() };
    if (action.type === "start") {
      state = reduce(state, action);
      providerInputs.push(JSON.stringify(projectProviderInput(state)));
    } else {
      state = reduce(state, action);
    }
    if (action.type === "provider_tool_request") {
      mcpOutputs.push(JSON.stringify(state.mcpResults.at(-1) ?? { resultType: "denied" }));
    }
    const audit = {
      canaryInProviderInput: providerInputs.some((value) => value.includes(secretCanary)),
      canaryInMcpResults: mcpOutputs.some((value) => value.includes(secretCanary)),
      canaryInLineageOrLogs: JSON.stringify({ lineage: state.lineage, logs: state.logs }).includes(secretCanary),
      providerSecretFields: state.security.providerObservedSecretFields,
      mcpSecretFields: state.security.mcpObservedSecretFields,
      logSecretFields: state.security.logsObservedSecretFields,
    };
    frames.push({ action: action.type, state, audit });
    render(state, { clear, audit });
  }
  return { state, frames, secretCanary };
}

function runScenario(name, options = {}) {
  return reduceScenario(name, options);
}

function printUsage() {
  process.stdout.write("Usage: npm run prototype:agent-runtime -- [--scenario architecture|boundary|lifecycle|failure|benchmark]\n");
}

const scenarioArgIndex = process.argv.indexOf("--scenario");
const requestedScenario = scenarioArgIndex >= 0 ? process.argv[scenarioArgIndex + 1] : null;
if (requestedScenario) {
  if (!scenarioNames.includes(requestedScenario)) {
    printUsage();
    process.exitCode = 1;
  } else {
    runScenario(requestedScenario, { clear: false });
  }
} else if (process.argv.includes("--help")) {
  printUsage();
} else {
  let current = createInitialState();
  render(current, { clear: false });
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  input.on("line", (line) => {
    const key = line.trim().toLowerCase();
    if (key === "q") {
      input.close();
      return;
    }
    if (key === "r") {
      current = createInitialState();
      render(current, { clear: true });
      return;
    }
    const index = Number(key) - 1;
    if (Number.isInteger(index) && scenarioNames[index]) {
      const result = runScenario(scenarioNames[index], { clear: true });
      current = result.state;
    } else {
      render(current, { clear: true });
    }
  });
  input.on("close", () => process.exit(0));
}

