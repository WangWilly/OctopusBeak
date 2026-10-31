import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { APP_UPDATE_DOWNLOAD_PREFIX, parseAppUpdateFeed } from "../src/lib/settings/app-updates.ts";
import { UPDATE_FEED_FILE, updateFeed, writeUpdateFeed } from "./update-feed.mjs";

const PUBLISHED = new Date("2026-10-31T04:00:00Z");
const SHA = "b".repeat(64);

test("the feed names this release's versioned ZIP with its size and checksum", () => {
  assert.deepEqual(updateFeed({ version: "0.11.0", publishedAt: PUBLISHED, size: 450_000_000, sha256: SHA }), {
    schema: 1,
    version: "0.11.0",
    name: "OctopusBeak 0.11.0",
    pubDate: "2026-10-31T04:00:00.000Z",
    url: "https://github.com/WangWilly/OctopusBeak/releases/download/v0.11.0/OctopusBeak-darwin-arm64-0.11.0.zip",
    size: 450_000_000,
    sha256: SHA,
  });
  assert.throws(
    () => updateFeed({ version: "0.11.0-beta.1", publishedAt: PUBLISHED, size: 1, sha256: SHA }),
    /Not a release version/,
  );
});

test("the feed is the file the App reads", () => {
  const source = readFileSync(new URL("../src/lib/settings/app-updates.ts", import.meta.url), "utf8");
  assert.ok(source.includes(`/releases/latest/download/${UPDATE_FEED_FILE}"`));
});

test("every release writes the feed, lists it in SHA256SUMS, and uploads it", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release-electron.yml", import.meta.url), "utf8");
  assert.match(workflow, /node scripts\/update-feed\.mjs out\/make[\s\S]*?-name 'update-feed-darwin-arm64\.json'[\s\S]*?> SHA256SUMS\.txt/);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG" .*out\/make\/update-feed-darwin-arm64\.json SHA256SUMS\.txt/);
});

test("the feed is written from the built ZIP, and the App accepts what it writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "update-feed-"));
  try {
    assert.throws(
      () => writeUpdateFeed({ makeDirectory: directory, version: "0.11.0", publishedAt: PUBLISHED }),
      /Expected exactly one OctopusBeak-darwin-arm64-0\.11\.0\.zip/,
    );
    const zipDirectory = join(directory, "zip", "darwin", "arm64");
    mkdirSync(zipDirectory, { recursive: true });
    writeFileSync(join(zipDirectory, "OctopusBeak-darwin-arm64-0.10.0.zip"), "old");
    assert.throws(
      () => writeUpdateFeed({ makeDirectory: directory, version: "0.11.0", publishedAt: PUBLISHED }),
      /found 0/,
      "a ZIP of another version does not count",
    );
    const zip = Buffer.from("PK\u0003\u0004 the new release");
    writeFileSync(join(zipDirectory, "OctopusBeak-darwin-arm64-0.11.0.zip"), zip);
    const path = writeUpdateFeed({ makeDirectory: directory, version: "0.11.0", publishedAt: PUBLISHED });
    assert.equal(path, join(directory, UPDATE_FEED_FILE));
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.size, zip.length);
    assert.equal(written.sha256, createHash("sha256").update(zip).digest("hex"));
    assert.deepEqual(parseAppUpdateFeed(written, APP_UPDATE_DOWNLOAD_PREFIX), {
      version: "0.11.0",
      name: "OctopusBeak 0.11.0",
      pubDate: "2026-10-31T04:00:00.000Z",
      url: written.url,
      size: zip.length,
      sha256: written.sha256,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
