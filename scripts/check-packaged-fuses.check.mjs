import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { expectedFuses, fuseMismatches } from "./check-packaged-fuses.mjs";

const require = createRequire(import.meta.url);
const { FuseV1Options } = require("@electron/fuses");
const forgeConfig = require("../forge.config.cjs");
const ON = "1".charCodeAt(0);
const OFF = "0".charCodeAt(0);

test("the expected fuses come from forge.config.cjs without its version field", () => {
  const expected = expectedFuses(forgeConfig);
  assert.equal(expected[FuseV1Options.RunAsNode], false);
  assert.equal(Object.hasOwn(expected, "version"), false);
});

test("a wire matching the configured fuses has no mismatch", () => {
  const expected = { [FuseV1Options.RunAsNode]: false, [FuseV1Options.GrantFileProtocolExtraPrivileges]: true };
  const wire = { version: "1", [FuseV1Options.RunAsNode]: OFF, [FuseV1Options.GrantFileProtocolExtraPrivileges]: ON };
  assert.deepEqual(fuseMismatches(wire, expected), []);
});

test("a fuse left on, or missing from an older wire, is reported", () => {
  const expected = {
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  };
  const wire = { version: "1", [FuseV1Options.RunAsNode]: ON };
  assert.deepEqual(fuseMismatches(wire, expected), [
    { fuse: FuseV1Options.RunAsNode, expected: false, actual: ON },
    { fuse: FuseV1Options.EnableNodeCliInspectArguments, expected: false, actual: undefined },
  ]);
});

test("a config without the fuses plugin is refused", () => {
  assert.throws(() => expectedFuses({ plugins: [] }), /no fuses plugin/);
});
