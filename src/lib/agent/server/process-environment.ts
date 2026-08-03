const AGENT_PROCESS_INHERITED_ENV_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
] as const;

function allowlistedAgentProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AGENT_PROCESS_INHERITED_ENV_KEYS) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return env;
}

/**
 * App-owned model helpers inherit only non-secret process plumbing.
 * Model selection and artifact paths must be supplied through explicit launch arguments.
 */
export function agentHelperProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return allowlistedAgentProcessEnv(baseEnv);
}

/**
 * Provider adapters have the same zero-Authentication-secret environment contract.
 */
export function agentProviderProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return allowlistedAgentProcessEnv(baseEnv);
}
