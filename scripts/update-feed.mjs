import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed App reads releases/latest/download/<this> (src/lib/settings/app-updates.ts). */
export const UPDATE_FEED_FILE = "update-feed-darwin-arm64.json";
const RELEASES = "https://github.com/WangWilly/OctopusBeak/releases/download";

export function updateZipName(version) {
  return `OctopusBeak-darwin-arm64-${version}.zip`;
}

/**
 * The App's own feed (ADR 0083), parsed by parseAppUpdateFeed. Squirrel.Mac never reads it: the App
 * downloads and checks the ZIP itself, then hands it to Squirrel.Mac only to install.
 */
export function updateFeed({ version, publishedAt, size, sha256 }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Not a release version: ${version}`);
  return {
    schema: 1,
    version,
    name: `OctopusBeak ${version}`,
    pubDate: publishedAt.toISOString(),
    url: `${RELEASES}/v${version}/${updateZipName(version)}`,
    size,
    sha256,
  };
}

/** Hashes in chunks: the ZIP is about 430 MB. */
function zipDigest(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  const fd = openSync(file, "r");
  let size = 0;
  try {
    for (let read; (read = readSync(fd, buffer)) > 0; size += read) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest("hex") };
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Writes the feed into the make directory, refusing when the ZIP it names was not built. */
export function writeUpdateFeed({ makeDirectory, version, publishedAt }) {
  const zips = filesUnder(makeDirectory).filter((path) => basename(path) === updateZipName(version));
  if (zips.length !== 1) {
    throw new Error(`Expected exactly one ${updateZipName(version)} in ${makeDirectory}, found ${zips.length}.`);
  }
  const feed = updateFeed({ version, publishedAt, ...zipDigest(zips[0]) });
  const path = join(makeDirectory, UPDATE_FEED_FILE);
  writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`);
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const makeDirectory = resolve(process.argv[2] ?? "out/make");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(writeUpdateFeed({ makeDirectory, version, publishedAt: new Date() }));
}
