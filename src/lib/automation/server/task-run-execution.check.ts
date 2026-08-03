import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { automationProcessEnv } from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";

const fubonPassword = "LIBRETTO_CLOUD_FUBON_" + "PASSWORD";
const esunPassword = "LIBRETTO_CLOUD_ESUN_" + "PASSWORD";

test("automation child receives only credentials declared by its task", () => {
  const fubonTask = taskById("fubon-all-statements");
  assert.ok(fubonTask);
  const env = automationProcessEnv(fubonTask, {
    baseEnv: {
      PATH: process.env.PATH,
      [fubonPassword]: "legacy-fubon-canary",
      [esunPassword]: "legacy-esun-canary",
      OPENAI_API_KEY: "unrelated-api-canary",
      SSH_AUTH_SOCK: "/tmp/unrelated-auth-socket",
      GITHUB_PAT: "unrelated-github-canary",
      PGPASSWORD: "unrelated-postgres-canary",
      DATABASE_URL: "postgres://user:unrelated-database-canary@localhost/db",
    },
    settings: {},
    credentials: {
      [fubonPassword]: "saved-fubon-canary",
      [esunPassword]: "saved-esun-canary",
    },
  });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.stdout.write(JSON.stringify({
        fubon: process.env.${fubonPassword},
        esun: process.env.${esunPassword},
        apiKey: process.env.OPENAI_API_KEY,
        authSocket: process.env.SSH_AUTH_SOCK,
        githubPat: process.env.GITHUB_PAT,
        postgresPassword: process.env.PGPASSWORD,
        databaseUrl: process.env.DATABASE_URL,
      }))`,
    ],
    { env, encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    fubon: "saved-fubon-canary",
  });
});

test("credential-free automation tasks receive no stored or inherited credentials", () => {
  const exchangeRateTask = taskById("exchange-rates");
  assert.ok(exchangeRateTask);
  const env = automationProcessEnv(exchangeRateTask, {
    baseEnv: {
      PATH: process.env.PATH,
      [fubonPassword]: "legacy-fubon-canary",
    },
    settings: {},
    credentials: {
      [fubonPassword]: "saved-fubon-canary",
    },
  });

  assert.equal(env[fubonPassword], undefined);
});
