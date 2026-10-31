import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppRelease } from "../src/lib/settings/app-updates.ts";
import {
  downloadAppRelease,
  fetchAppRelease,
  pruneAppUpdates,
  rehearseSquirrelHandoff,
  startSquirrelHandoff,
  verifiedZipPath,
} from "./app-update-io.ts";

const ZIP = Buffer.alloc(300_000, 7);
const SHA = createHash("sha256").update(ZIP).digest("hex");

async function serve(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, server };
}

const close = (server: Server) => new Promise((resolve) => server.close(resolve));

function release(origin: string, overrides: Partial<AppRelease> = {}): AppRelease {
  return {
    version: "0.11.0",
    name: "OctopusBeak 0.11.0",
    pubDate: "2026-10-31T04:00:00.000Z",
    url: `${origin}/assets/update.zip`,
    size: ZIP.length,
    sha256: SHA,
    ...overrides,
  };
}

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "app-update-io-"));
}

test("the feed follows GitHub's redirect, sends no cookie, and is parsed before use", async () => {
  const seen: (string | undefined)[] = [];
  const { origin, server } = await serve((request, response) => {
    seen.push(request.headers.cookie);
    if (request.url === "/latest/feed.json") {
      response.writeHead(302, { Location: "/assets/feed.json" }).end();
    } else if (request.url === "/assets/feed.json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ schema: 1, ...release("http://127.0.0.1:1") }));
    } else {
      response.writeHead(200).end("{\"schema\":2}");
    }
  });
  try {
    const parsed = await fetchAppRelease({ feedUrl: `${origin}/latest/feed.json`, downloadPrefix: "http://127.0.0.1:1/" });
    assert.equal(parsed.version, "0.11.0");
    assert.deepEqual(seen, [undefined, undefined]);
    await assert.rejects(fetchAppRelease({ feedUrl: `${origin}/other.json`, downloadPrefix: "http://127.0.0.1:1/" }));
    await assert.rejects(
      fetchAppRelease({ feedUrl: `${origin}/latest/feed.json`, downloadPrefix: "https://github.com/" }),
      "a feed pointing outside the release assets is refused",
    );
  } finally {
    await close(server);
  }
});

test("a download streams to .partial, reports whole percents, and keeps only a verified ZIP", async () => {
  const { origin, server } = await serve((_request, response) => {
    response.writeHead(200, { "Content-Length": ZIP.length });
    response.write(ZIP.subarray(0, 100_000));
    setTimeout(() => response.end(ZIP.subarray(100_000)), 20);
  });
  const directory = temporaryDirectory();
  try {
    const progress: number[] = [];
    const outcome = await downloadAppRelease({ directory, release: release(origin), onProgress: (received) => progress.push(received) });
    assert.equal(outcome, "verified");
    assert.deepEqual(readdirSync(directory), ["OctopusBeak-0.11.0.zip"]);
    assert.deepEqual(readFileSync(verifiedZipPath(directory, "0.11.0")), ZIP);
    assert.ok(progress.length >= 2 && progress.length <= 101, `progress is throttled (${progress.length} reports)`);
    assert.equal(progress.at(-1), ZIP.length);
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b));

    const again: number[] = [];
    await close(server);
    assert.equal(
      await downloadAppRelease({ directory, release: release(origin), onProgress: (received) => again.push(received) }),
      "verified",
      "a verified ZIP already on disk is not downloaded again",
    );
    assert.deepEqual(again, [ZIP.length]);
  } finally {
    server.closeAllConnections();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a checksum or size mismatch deletes the file and never leaves a ZIP behind", async () => {
  const { origin, server } = await serve((_request, response) => response.end(ZIP));
  const directory = temporaryDirectory();
  try {
    const noop = () => {};
    assert.equal(
      await downloadAppRelease({ directory, release: release(origin, { sha256: "0".repeat(64) }), onProgress: noop }),
      "verify-failed",
    );
    assert.equal(
      await downloadAppRelease({ directory, release: release(origin, { size: ZIP.length - 1 }), onProgress: noop }),
      "verify-failed",
      "more bytes than the feed promised",
    );
    assert.equal(
      await downloadAppRelease({ directory, release: release(origin, { size: ZIP.length + 1 }), onProgress: noop }),
      "verify-failed",
      "fewer bytes than the feed promised",
    );
    assert.deepEqual(readdirSync(directory), []);
    writeFileSync(verifiedZipPath(directory, "0.11.0"), "tampered");
    assert.equal(await downloadAppRelease({ directory, release: release(origin), onProgress: noop }), "verified");
    assert.deepEqual(readFileSync(verifiedZipPath(directory, "0.11.0")), ZIP, "a ZIP on disk that no longer matches is replaced");
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a refused or broken download is a download failure", async () => {
  const { origin, server } = await serve((request, response) => {
    if (request.url === "/missing.zip") response.writeHead(404).end();
    else {
      response.writeHead(200, { "Content-Length": ZIP.length });
      response.write(ZIP.subarray(0, 1000), () => response.destroy());
    }
  });
  const directory = temporaryDirectory();
  try {
    const noop = () => {};
    assert.equal(
      await downloadAppRelease({ directory, release: release(origin, { url: `${origin}/missing.zip` }), onProgress: noop }),
      "download-failed",
    );
    assert.equal(await downloadAppRelease({ directory, release: release(origin), onProgress: noop }), "download-failed");
    assert.deepEqual(readdirSync(directory), [], "the partial file is removed");
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup keeps only verified ZIPs newer than the running version", async () => {
  const directory = temporaryDirectory();
  try {
    for (const name of [
      "OctopusBeak-0.11.0.zip",
      "OctopusBeak-0.12.0.zip",
      "OctopusBeak-0.10.0.zip",
      "OctopusBeak-0.9.0.zip",
      "OctopusBeak-0.12.0.zip.partial",
      "notes.txt",
    ]) writeFileSync(path.join(directory, name), "");
    mkdirSync(path.join(directory, "OctopusBeak-0.13.0.zip.unpacked"));
    await pruneAppUpdates(directory, "0.10.0");
    assert.deepEqual(readdirSync(directory).sort(), ["OctopusBeak-0.11.0.zip", "OctopusBeak-0.12.0.zip"]);
    await pruneAppUpdates(path.join(directory, "missing"), "0.10.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hand-off serves Squirrel.Mac's feed and the ZIP on 127.0.0.1 behind a random path, and nothing else", async () => {
  const directory = temporaryDirectory();
  const zipPath = verifiedZipPath(directory, "0.11.0");
  writeFileSync(zipPath, ZIP);
  const handoff = await startSquirrelHandoff(zipPath);
  try {
    const feedUrl = new URL(handoff.feedUrl);
    assert.equal(feedUrl.hostname, "127.0.0.1");
    const [, token] = feedUrl.pathname.split("/");
    assert.match(token!, /^[0-9a-f]{48}$/);

    const feed = await fetch(handoff.feedUrl);
    assert.equal(feed.status, 200, "200 with a url is Squirrel.Mac's 'an update exists'");
    const body = await feed.json() as { url: string };
    assert.deepEqual(Object.keys(body), ["url"]);
    assert.equal(body.url, `${feedUrl.origin}/${token}/update.zip`);
    const zip = await fetch(body.url);
    assert.equal(zip.headers.get("content-length"), String(ZIP.length));
    assert.deepEqual(Buffer.from(await zip.arrayBuffer()), ZIP);

    for (const other of ["/", "/update.zip", `/${token}`, `/${"0".repeat(48)}/update.zip`, `/${token}/../${token}/x`]) {
      assert.equal((await fetch(`${feedUrl.origin}${other}`)).status, 404, other);
    }
    assert.equal((await fetch(body.url, { method: "POST" })).status, 405);
    assert.equal(await rehearseSquirrelHandoff(handoff.feedUrl, release("http://127.0.0.1:1")), true);
    assert.equal(await rehearseSquirrelHandoff(handoff.feedUrl, release("http://127.0.0.1:1", { sha256: "0".repeat(64) })), false);
  } finally {
    handoff.close();
    rmSync(directory, { recursive: true, force: true });
  }
  await assert.rejects(fetch(handoff.feedUrl), "the server is gone once closed");
});
