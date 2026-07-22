import assert from "node:assert/strict";
import { overviewSankeyPrototype } from "./overview-sankey-data.ts";

const graph = overviewSankeyPrototype();

assert.ok(graph.nodes.some((node) => node.id === "root:asset" && node.tone === "asset"));
assert.ok(graph.nodes.some((node) => node.id === "root:liability" && node.tone === "liability"));
assert.ok(graph.links.some((link) => (
  link.source === "account:fund:yuanta" && link.target === "position:yuanta:fund-a"
)));
assert.ok(graph.links.every((link) => link.value > 0));
