import { join, normalize } from "node:path";
import type { AutomationTask } from "./tasks.ts";

export type ResolvedAutomationCommand = {
  display: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function isDesktopRuntime(env: NodeJS.ProcessEnv) {
  return env.OCTOPUSBEAK_DESKTOP === "1";
}

function appRoot(env: NodeJS.ProcessEnv) {
  return env.OCTOPUSBEAK_APP_ROOT ?? process.cwd();
}

function electronNodePath(env: NodeJS.ProcessEnv) {
  return env.OCTOPUSBEAK_NODE_PATH ?? process.execPath;
}

function withElectronRunAsNode(env: NodeJS.ProcessEnv) {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function appFile(root: string, relativePath: string) {
  return join(root, ...normalize(relativePath).split(/[\\/]+/));
}

function absolutizeScriptArgs(args: readonly string[], root: string) {
  return args.map((arg) => (
    /\.(?:ts|js|mjs|cjs)$/.test(arg) && !arg.startsWith("/")
      ? appFile(root, arg)
      : arg
  ));
}

export function resolveLibrettoCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAutomationCommand {
  if (!isDesktopRuntime(env)) {
    return {
      display: `npx libretto ${args.join(" ")}`,
      command: "npx",
      args: ["libretto", ...args],
      env,
    };
  }

  const root = appRoot(env);
  return {
    display: `libretto ${args.join(" ")}`,
    command: electronNodePath(env),
    args: [
      join(root, "node_modules", "libretto", "dist", "cli", "index.js"),
      ...absolutizeScriptArgs(args, root),
    ],
    env: withElectronRunAsNode(env),
  };
}

export function resolveNodeScriptCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAutomationCommand {
  if (!isDesktopRuntime(env)) {
    return {
      display: `node ${args.join(" ")}`,
      command: "node",
      args: [...args],
      env,
    };
  }

  const root = appRoot(env);
  return {
    display: `node ${args.join(" ")}`,
    command: electronNodePath(env),
    args: absolutizeScriptArgs(args, root),
    env: withElectronRunAsNode(env),
  };
}

export function resolveTaskCommand(
  task: AutomationTask,
  options: { resumeSession?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAutomationCommand {
  if (options.resumeSession) {
    return resolveLibrettoCommand(["resume", "--session", options.resumeSession], env);
  }

  if (!isDesktopRuntime(env)) {
    return {
      display: task.script,
      command: "npm",
      args: ["run", task.script],
      env,
    };
  }

  const [runtime, ...args] = task.command;
  if (runtime === "libretto") {
    return {
      ...resolveLibrettoCommand(args, env),
      display: task.script,
    };
  }
  if (runtime === "node") {
    return {
      ...resolveNodeScriptCommand(args, env),
      display: task.script,
    };
  }
  throw new Error(`Unsupported automation command runtime: ${runtime}`);
}

export function resolvePatchCommand(
  options: { resumeSession?: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (options.resumeSession) return null;
  return resolveNodeScriptCommand(["scripts/patch-libretto-run-cdp.mjs"], env);
}
