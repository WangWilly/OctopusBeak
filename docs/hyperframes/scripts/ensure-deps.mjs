import { existsSync } from "node:fs";

if (!existsSync("node_modules/.bin/hyperframes")) {
  console.error("Missing HyperFrames dependencies.");
  console.error("Run from repo root: npm run video:hyperframes:install");
  console.error("Or from docs/hyperframes: npm install");
  process.exit(1);
}
