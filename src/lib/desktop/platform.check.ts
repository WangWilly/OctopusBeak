import assert from "node:assert/strict";
import { isMacPlatform } from "./platform.ts";

assert.equal(isMacPlatform({ platform: "Win32", userAgentData: { platform: "macOS" } }), true);
assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
assert.equal(isMacPlatform({ platform: "MacIntel", userAgentData: { platform: "Windows" } }), false);
assert.equal(isMacPlatform({ platform: "MacIntel", userAgentData: { platform: "" } }), true);
