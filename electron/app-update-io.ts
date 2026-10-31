import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  isNewerVersion,
  parseAppUpdateFeed,
  type AppRelease,
  type AppUpdateDownloadOutcome,
} from "../src/lib/settings/app-updates.ts";

const FEED_TIMEOUT_MS = 15_000;
/** A download that receives nothing for this long is treated as failed. */
const STALL_TIMEOUT_MS = 60_000;
const VERIFIED_ZIP = /^OctopusBeak-(\d+\.\d+\.\d+)\.zip$/u;

export function verifiedZipPath(directory: string, version: string) {
  return path.join(directory, `OctopusBeak-${version}.zip`);
}

/** Node's fetch, not the session's: no cookies, and nothing else the App holds goes with it. */
export async function fetchAppRelease(input: { feedUrl: string; downloadPrefix: string; fetch?: typeof fetch }) {
  const response = await (input.fetch ?? fetch)(input.feedUrl, {
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`feed answered ${response.status}`);
  return parseAppUpdateFeed(await response.json(), input.downloadPrefix);
}

async function sha256Of(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function matches(file: string, release: AppRelease) {
  try {
    return (await stat(file)).size === release.size && await sha256Of(file) === release.sha256;
  } catch {
    return false;
  }
}

/**
 * Streams the ZIP to <directory>/OctopusBeak-<version>.zip.partial and renames it only once its size and
 * sha256 match the feed, so a file without .partial is always a verified ZIP.
 */
export async function downloadAppRelease(input: {
  directory: string;
  release: AppRelease;
  onProgress(received: number): void;
  fetch?: typeof fetch;
}): Promise<AppUpdateDownloadOutcome> {
  const { directory, release } = input;
  const target = verifiedZipPath(directory, release.version);
  await mkdir(directory, { recursive: true });
  if (await matches(target, release)) {
    input.onProgress(release.size);
    return "verified";
  }
  await rm(target, { force: true });

  const partial = `${target}.partial`;
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  const hash = createHash("sha256");
  let received = 0;
  let reportedPercent = -1;
  try {
    const response = await (input.fetch ?? fetch)(release.url, {
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`download answered ${response.status}`);
    const file = createWriteStream(partial);
    try {
      for await (const chunk of Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
        received += (chunk as Buffer).byteLength;
        if (received > release.size) break;
        hash.update(chunk);
        if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
        const percent = Math.floor((received / release.size) * 100);
        if (percent !== reportedPercent) {
          reportedPercent = percent;
          input.onProgress(received);
        }
      }
    } finally {
      file.end();
      await finished(file);
    }
  } catch {
    await rm(partial, { force: true });
    return "download-failed";
  } finally {
    clearTimeout(stall);
    controller.abort();
  }
  if (received !== release.size || hash.digest("hex") !== release.sha256) {
    await rm(partial, { force: true });
    return "verify-failed";
  }
  await rename(partial, target);
  return "verified";
}

/** Keeps only verified ZIPs of versions newer than the running one, so old downloads and partials never pile up. */
export async function pruneAppUpdates(directory: string, currentVersion: string) {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(entries.map(async (name) => {
    const version = VERIFIED_ZIP.exec(name)?.[1];
    if (version && isNewerVersion(version, currentVersion)) return;
    await rm(path.join(directory, name), { recursive: true, force: true });
  }));
}

/**
 * Serves a verified ZIP to Squirrel.Mac on 127.0.0.1, behind a random path, in the format its default
 * server type reads: the feed answers 200 with {"url"} because an update exists. Squirrel.Mac then copies
 * the ZIP, checks its code signature against the running App, and stages it for ShipIt.
 */
export async function startSquirrelHandoff(zipPath: string) {
  const token = randomBytes(24).toString("hex");
  const size = (await stat(zipPath)).size;
  let origin = "";
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
    } else if (pathname === `/${token}/feed.json`) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ url: `${origin}/${token}/update.zip` }));
    } else if (pathname === `/${token}/update.zip`) {
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": size });
      if (request.method === "HEAD") response.end();
      else createReadStream(zipPath).on("error", () => response.destroy()).pipe(response);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("hand-off server has no port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    feedUrl: `${origin}/${token}/feed.json`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** What Squirrel.Mac does with the hand-off, short of the signature check; the development fixture's install. */
export async function rehearseSquirrelHandoff(feedUrl: string, release: AppRelease) {
  const feed = await (await fetch(feedUrl)).json() as { url: string };
  const zip = Buffer.from(await (await fetch(feed.url)).arrayBuffer());
  return zip.length === release.size && createHash("sha256").update(zip).digest("hex") === release.sha256;
}
