import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

/**
 * A stand-in for GitHub Releases that a development build reads through OCTOPUSBEAK_UPDATE_FEED_FIXTURE
 * (ADR 0083). See docs/runbooks/desktop-development.md.
 */
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4555" },
    mode: { type: "string", default: "update" },
    "size-mb": { type: "string", default: "60" },
    "rate-mb": { type: "string", default: "2" },
  },
});
const MODES = ["update", "current", "bad-sha", "broken-download", "feed-error"];
if (!MODES.includes(values.mode)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);

const current = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const [major, minor] = current.split(".").map(Number);
const version = values.mode === "current" ? current : `${major}.${minor + 1}.0`;
const zipName = `OctopusBeak-darwin-arm64-${version}.zip`;
const zip = randomBytes(Number(values["size-mb"]) * 1024 * 1024);
const origin = `http://127.0.0.1:${values.port}`;
const feed = {
  schema: 1,
  version,
  name: `OctopusBeak ${version}`,
  pubDate: new Date().toISOString(),
  url: `${origin}/releases/download/v${version}/${zipName}`,
  size: zip.length,
  sha256: values.mode === "bad-sha" ? "0".repeat(64) : createHash("sha256").update(zip).digest("hex"),
};
const chunk = 64 * 1024;
const delayMs = Math.max(1, (chunk / (Number(values["rate-mb"]) * 1024 * 1024)) * 1000);

createServer((request, response) => {
  console.log(request.method, request.url);
  if (request.url === "/latest/feed.json") {
    // GitHub answers releases/latest/download with a redirect to its asset host.
    response.writeHead(302, { Location: "/assets/feed.json" }).end();
  } else if (request.url === "/assets/feed.json") {
    if (values.mode === "feed-error") return response.writeHead(503).end();
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(feed));
  } else if (request.url === new URL(feed.url).pathname) {
    response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zip.length });
    let offset = 0;
    const timer = setInterval(() => {
      if (values.mode === "broken-download" && offset >= zip.length / 2) {
        clearInterval(timer);
        return response.destroy();
      }
      if (offset >= zip.length) {
        clearInterval(timer);
        return response.end();
      }
      response.write(zip.subarray(offset, offset + chunk));
      offset += chunk;
    }, delayMs);
    response.on("close", () => clearInterval(timer));
  } else {
    response.writeHead(404).end();
  }
}).listen(Number(values.port), "127.0.0.1", () => {
  console.log(`Serving ${values.mode}: v${version}, ${values["size-mb"]} MB at ${values["rate-mb"]} MB/s (running App is v${current}).`);
  console.log(`Start the App with:\n  OCTOPUSBEAK_UPDATE_FEED_FIXTURE=${origin}/latest/feed.json npm run desktop:dev`);
});
