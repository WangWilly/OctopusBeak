const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

assert.equal(typeof DatabaseSync, "function");
assert.match(process.versions.node, /^\d+\.\d+\.\d+$/);

console.log(JSON.stringify({
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
  node: process.versions.node,
  sqlite: true,
}));
