import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { UPDATE_FEED_FILE, updateFeed, writeUpdateFeed } from "./update-feed.mjs";

const PUBLISHED = new Date("2026-10-31T04:00:00Z");

test("the feed names only this release and its versioned ZIP", () => {
  assert.deepEqual(updateFeed("0.11.0", PUBLISHED), {
    currentRelease: "0.11.0",
    releases: [
      {
        version: "0.11.0",
        updateTo: {
          version: "0.11.0",
          name: "OctopusBeak 0.11.0",
          pub_date: "2026-10-31T04:00:00.000Z",
          url: "https://github.com/WangWilly/OctopusBeak/releases/download/v0.11.0/OctopusBeak-darwin-arm64-0.11.0.zip",
        },
      },
    ],
  });
  assert.throws(() => updateFeed("0.11.0-beta.1", PUBLISHED), /Not a release version/);
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

test("the feed is written only when the ZIP it names was built", () => {
  const directory = mkdtempSync(join(tmpdir(), "update-feed-"));
  try {
    assert.throws(
      () => writeUpdateFeed({ makeDirectory: directory, version: "0.11.0", publishedAt: PUBLISHED }),
      /Expected exactly one OctopusBeak-darwin-arm64-0\.11\.0\.zip/,
    );
    const zipDirectory = join(directory, "zip", "darwin", "arm64");
    mkdirSync(zipDirectory, { recursive: true });
    writeFileSync(join(zipDirectory, "OctopusBeak-darwin-arm64-0.10.0.zip"), "");
    assert.throws(
      () => writeUpdateFeed({ makeDirectory: directory, version: "0.11.0", publishedAt: PUBLISHED }),
      /found 0/,
      "a ZIP of another version does not count",
    );
    writeFileSync(join(zipDirectory, "OctopusBeak-darwin-arm64-0.11.0.zip"), "");
    const path = writeUpdateFeed({ makeDirectory: directory, version: "0.11.0", publishedAt: PUBLISHED });
    assert.equal(path, join(directory, UPDATE_FEED_FILE));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), updateFeed("0.11.0", PUBLISHED));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
