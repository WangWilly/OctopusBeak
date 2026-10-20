import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArguments } from "./arguments.ts";

const CLI = fileURLToPath(new URL("../captcha-calibration.ts", import.meta.url));

async function runCli(args) {
  const home = await mkdtemp(join(tmpdir(), "captcha-cli-home-"));
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ...result, corpusCreated: existsSync(join(home, "OctopusBeakCalibration")) };
}

for (const args of [
  ["collect", "mega"],
  ["collect", "taishin", "--count", "201", "--allow-live-source"],
  ["collect", "rakuten", "--delay-ms", "1999", "--allow-live-source"],
]) {
  test(`${args.join(" ")} exits 2 before creating a browser or corpus directory`, async () => {
    const result = await runCli(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /npm run calibrate:captcha -- collect <bank> --allow-live-source/u);
    assert.equal(result.corpusCreated, false);
  });
}

test("evaluate on an empty corpus says so and creates nothing", async () => {
  const result = await runCli(["evaluate", "rakuten"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No captures in .*OctopusBeakCalibration\/rakuten/u);
  assert.equal(result.corpusCreated, false);
});

test("collect needs --allow-live-source and keeps the count and delay within the politeness limits", () => {
  assert.equal(parseArguments(["collect", "mega"]).kind, "usage-error");
  assert.deepEqual(parseArguments(["collect", "mega", "--allow-live-source"]), {
    kind: "collect", bank: "mega", count: 60, delayMs: 3000, headless: false,
  });
  assert.deepEqual(parseArguments(["collect", "rakuten", "--allow-live-source", "--count", "200", "--delay-ms", "2000", "--headless", "--corpus", "/tmp/x"]), {
    kind: "collect", bank: "rakuten", corpus: "/tmp/x", count: 200, delayMs: 2000, headless: true,
  });
  for (const args of [["--count", "201"], ["--count", "0"], ["--count", "1.5"], ["--delay-ms", "1999"], ["--delay-ms", "fast"], ["--count"]]) {
    assert.equal(parseArguments(["collect", "mega", "--allow-live-source", ...args]).kind, "usage-error", args.join(" "));
  }
});

test("other subcommands parse their own options only", () => {
  assert.deepEqual(parseArguments(["evaluate", "rakuten", "--json"]), { kind: "evaluate", bank: "rakuten", json: true });
  assert.deepEqual(parseArguments(["label", "taishin", "--corpus", "/tmp/c"]), { kind: "label", bank: "taishin", corpus: "/tmp/c" });
  assert.deepEqual(parseArguments(["prelabel", "mega"]), { kind: "prelabel", bank: "mega" });
  assert.equal(parseArguments(["label", "mega", "--allow-live-source"]).kind, "usage-error");
  assert.equal(parseArguments(["collect", "esun", "--allow-live-source"]).kind, "usage-error");
  assert.equal(parseArguments(["solve", "mega"]).kind, "usage-error");
  assert.equal(parseArguments([]).kind, "help");
});
