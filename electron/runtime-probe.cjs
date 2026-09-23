const assert = require("node:assert/strict");
assert.match(process.versions.node, /^\d+\.\d+\.\d+$/);
assert.equal(typeof WebAssembly, "object");

console.log(JSON.stringify({
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
  node: process.versions.node,
  webAssembly: true,
}));
