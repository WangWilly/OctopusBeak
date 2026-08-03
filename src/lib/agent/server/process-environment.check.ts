import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  agentHelperProcessEnv,
  agentProviderProcessEnv,
} from "./process-environment.ts";

const inheritedPath = process.env.PATH ?? "";
const fubonPasswordKey = "LIBRETTO_CLOUD_FUBON_" + "PASSWORD";
const maxSecretKey = "MAX_SECRET_" + "KEY";
const secretEnvironment = {
  PATH: inheritedPath,
  LANG: "en_US.UTF-8",
  [fubonPasswordKey]: "agent-helper-canary",
  [maxSecretKey]: "agent-provider-canary",
  OPENAI_API_KEY: "agent-api-canary",
  SSH_AUTH_SOCK: "/tmp/agent-auth-canary",
};
const canaries = [
  "agent-helper-canary",
  "agent-provider-canary",
  "agent-api-canary",
  "/tmp/agent-auth-canary",
];

function observedChildEnvironment(env: NodeJS.ProcessEnv) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "process.stdout.write(JSON.stringify(process.env))"],
    { env, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as Record<string, string>;
}

for (const [boundary, buildEnvironment] of [
  ["helper", agentHelperProcessEnv],
  ["provider", agentProviderProcessEnv],
] as const) {
  test(`agent ${boundary} child process receives zero Authentication secrets`, () => {
    const observed = observedChildEnvironment(buildEnvironment(secretEnvironment));

    assert.equal(observed.PATH, inheritedPath);
    assert.equal(observed.LANG, "en_US.UTF-8");
    assert.deepEqual(
      canaries.filter((canary) => JSON.stringify(observed).includes(canary)),
      [],
    );
  });
}
